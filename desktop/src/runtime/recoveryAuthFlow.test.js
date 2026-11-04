import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createLicenseRuntime } from '../licensing/licenseRuntime.js';
import { createRecoveryIpcBridge } from './recoveryIpcBridge.js';
import { createRecoveryRemoteClient } from '../../../local-api/src/backup/recoveryRemoteClient.js';
import { createRecoveryBackupOrchestrator } from '../../../local-api/src/backup/recoveryBackupOrchestrator.js';

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const oldToken = 'synthetic-expired-user-token';
const newToken = 'synthetic-refreshed-user-token';
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0x6b),
  decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x6b).toString('utf8') };

async function fixture(t, { mode = 'refresh-success', loggedIn = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-recovery-auth-flow-'));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  const previousMode = process.env.WANGZAI_LICENSE_MODE;
  process.env.LICENSE_CENTER_URL = 'https://synthetic-recovery.invalid';
  process.env.WANGZAI_LICENSE_MODE = 'observe';
  const db = new DatabaseSync(':memory:');
  t.after(async () => {
    db.close();
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL; else process.env.LICENSE_CENTER_URL = previousUrl;
    if (previousMode === undefined) delete process.env.WANGZAI_LICENSE_MODE; else process.env.WANGZAI_LICENSE_MODE = previousMode;
    await rm(root, { recursive: true, force: true });
  });
  const calls = { refresh: 0, forwards: [], mutations: 0, remote: [] };
  const runtime = createLicenseRuntime({
    app: { isPackaged: false, getName: () => 'Synthetic recovery', getVersion: () => '1.0.0', getPath: () => root },
    safeStorage, desktopRoot: path.join(root, 'isolated-app'), resourcesPath: '',
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/auth/login') return json({ access_token: oldToken,
        ...(mode === 'missing-refresh' ? {} : { refresh_token: 'synthetic-refresh-token' }), user: { id: 123 } });
      if (pathname === '/api/auth/refresh') {
        calls.refresh += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (mode === 'refresh-offline') throw new Error('synthetic refresh service offline');
        if (mode === 'refresh-forbidden') return json({ detail: 'synthetic account disabled' }, 403);
        return json({ access_token: newToken, refresh_token: 'synthetic-rotated-refresh-token' });
      }
      throw new Error(`UNEXPECTED_SYNTHETIC_AUTH_REQUEST:${pathname}`);
    },
  });
  if (loggedIn) await runtime.request({ method: 'POST', path: '/api/auth/login', body: { email: 'synthetic@example.invalid', password: 'synthetic' } });
  const bridge = createRecoveryIpcBridge({ activateRecovery: async () => ({}),
    hasPendingAccountRemoval: async () => true,
    refreshRecoveryAuthorization: ({ rejectedAccessToken }) => runtime.getRecoveryRemoteContext({ forceRefresh: true, rejectedAccessToken }),
    requestRecovery: async (input, { authContext } = {}) => {
      calls.forwards.push(structuredClone(input));
      const remote = await runtime.getRecoveryRemoteContext();
      authContext.accessToken = remote.accessToken;
      const remoteClient = createRecoveryRemoteClient({ ...remote, fetchImpl: async (url, options = {}) => {
        const pathname = new URL(url).pathname;
        calls.remote.push({ path: pathname.replace(/\/owners\/[^/]+/u, '/owners/[opaque]'), method: options.method || 'GET' });
        if (mode === 'forbidden') return json({}, 403);
        if (mode === 'legacy-404') return json({}, 404);
        if (mode === 'offline') throw new Error('synthetic remote offline');
        if (mode === 'always-401') return json({}, 401);
        if (mode !== 'post-mutation-401' && remote.accessToken === oldToken) return json({}, 401);
        if (options.method === 'POST') {
          calls.mutations += 1;
          return json({ owner_ref: pathname.split('/')[4], tombstoned: true, deleted_generation_ids: [], remaining_generation_count: 0 });
        }
        if (mode === 'post-mutation-401' && calls.mutations) return json({}, 401);
        return json([]);
      } });
      try {
        if (input.command === 'list-generations') return { ok: true, status: 200, data: { generations: await remoteClient.listGenerations() } };
        const orchestrator = createRecoveryBackupOrchestrator({ db, decryptShopSecret: () => '', keysetStore: {
          initialize() { throw new Error('UNEXPECTED_ENROLLMENT'); },
          readState: () => mode === 'post-mutation-401'
            ? { keyset: { chunkEncryptionKey: Buffer.alloc(32, 1), dedupeKey: Buffer.alloc(32, 2) }, envelope: {}, recoveryAad: 'synthetic' } : null,
        } });
        return { ok: true, status: 200, data: await orchestrator.purgeAccountOwner({
          owner: { ownerType: 'model_api_account', ownerId: 'synthetic-owner' }, ownerIncarnation: 'synthetic-incarnation', remoteClient,
        }) };
      } catch (error) {
        // Mirrors the explicit trusted local-api error metadata contract; no
        // refresh token or rejected token is ever copied into this response.
        return { ok: false, status: error.code === 'RECOVERY_REMOTE_UNAVAILABLE' ? 503 : error.remoteStatus || 400,
          data: { ok: false, error: { code: error.code, message: error.message, remoteStatus: error.remoteStatus, safeAuthRetry: error.safeAuthRetry } } };
      }
    },
  });
  return { bridge, calls, runtime };
}

test('an expired purge token refreshes once and replays the identical operation before any remote mutation', async (t) => {
  const f = await fixture(t);
  const input = { command: 'purge-account-owner', operationId: 'synthetic-pending-operation', requestId: 'synthetic-same-request' };
  const result = await f.bridge(input);
  assert.equal(result.data.verified, true);
  assert.equal(f.calls.refresh, 1);
  assert.equal(f.calls.mutations, 0);
  assert.deepEqual(f.calls.forwards, [input, input]);
  assert.equal(JSON.stringify(result).includes(newToken), false);
  assert.equal(JSON.stringify(result).includes(oldToken), false);
});

test('concurrent read-only 401 responses share one refresh and do not hold the mutation barrier lane', async (t) => {
  const f = await fixture(t);
  const listings = [f.bridge({ command: 'list-generations' }), f.bridge({ command: 'list-generations' })];
  const barrier = await f.bridge({ command: 'begin-account-removal-barrier', previewFingerprint: 'a'.repeat(64) });
  assert.equal(barrier.data.fenced, true);
  assert.ok((await Promise.all(listings)).every((result) => result.ok));
  assert.equal(f.calls.refresh, 1);
});

test('a late 401 for an older token reuses the already-refreshed session without rotating again', async (t) => {
  const f = await fixture(t);
  await f.runtime.getRecoveryRemoteContext({ forceRefresh: true, rejectedAccessToken: oldToken });
  const contexts = await Promise.all([
    f.runtime.getRecoveryRemoteContext({ forceRefresh: true, rejectedAccessToken: oldToken }),
    f.runtime.getRecoveryRemoteContext({ forceRefresh: true, rejectedAccessToken: oldToken }),
  ]);
  assert.ok(contexts.every((context) => context.accessToken === newToken));
  assert.equal(f.calls.refresh, 1);
});

test('post-mutation readback 401 leaves the pending operation unverified without replaying its purge', async (t) => {
  const f = await fixture(t, { mode: 'post-mutation-401' });
  const result = await f.bridge({ command: 'purge-account-owner', operationId: 'synthetic-mutated-operation' });
  assert.equal(result.ok, false);
  assert.equal(result.data.error.safeAuthRetry, false);
  assert.equal(f.calls.mutations, 1);
  assert.equal(f.calls.forwards.length, 1);
  assert.equal(f.calls.refresh, 0);
});

test('a second 401 is returned after exactly one refresh, not retried indefinitely', async (t) => {
  const f = await fixture(t, { mode: 'always-401' });
  const result = await f.bridge({ command: 'purge-account-owner', operationId: 'synthetic-rejected-operation' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(f.calls.refresh, 1);
  assert.equal(f.calls.forwards.length, 2);
});

for (const [mode, code, status] of [
  ['forbidden', 'RECOVERY_REMOTE_ACCESS_DENIED', 403],
  ['legacy-404', 'RECOVERY_REMOTE_ENDPOINT_UNAVAILABLE', 404],
  ['offline', 'RECOVERY_REMOTE_UNAVAILABLE', 503],
]) {
  test(`${mode} does not refresh or manufacture an absence receipt`, async (t) => {
    const f = await fixture(t, { mode });
    const result = await f.bridge({ command: 'purge-account-owner', operationId: 'synthetic-blocked-operation' });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.data.error.code, code);
    assert.equal(f.calls.refresh, 0);
    assert.equal(f.calls.forwards.length, 1);
  });
}

test('missing login and unavailable refresh service remain distinct actionable failures', async (t) => {
  const missing = await fixture(t, { loggedIn: false });
  const missingResult = await missing.bridge({ command: 'purge-account-owner', operationId: 'synthetic-no-session' });
  assert.equal(missingResult.data.error.code, 'RECOVERY_REMOTE_LOGIN_REQUIRED');
  assert.equal(missing.calls.refresh, 0);
  assert.equal(missing.calls.remote.length, 0);
  const offline = await fixture(t, { mode: 'refresh-offline' });
  const offlineResult = await offline.bridge({ command: 'purge-account-owner', operationId: 'synthetic-no-auth-service' });
  assert.equal(offlineResult.data.error.code, 'RECOVERY_REMOTE_UNAVAILABLE');
  assert.equal(offline.calls.refresh, 1);
  assert.equal(offline.calls.forwards.length, 1);
});

for (const [mode, code, refreshCount] of [
  ['missing-refresh', 'RECOVERY_REMOTE_LOGIN_REQUIRED', 0],
  ['refresh-forbidden', 'RECOVERY_REMOTE_ACCESS_DENIED', 1],
]) {
  test(`${mode} cannot turn a rejected token into a verified owner purge`, async (t) => {
    const f = await fixture(t, { mode });
    const result = await f.bridge({ command: 'purge-account-owner', operationId: 'synthetic-auth-unrecoverable' });
    assert.equal(result.ok, false);
    assert.equal(result.data.error.code, code);
    assert.equal(f.calls.refresh, refreshCount);
    assert.equal(f.calls.forwards.length, 1);
  });
}
