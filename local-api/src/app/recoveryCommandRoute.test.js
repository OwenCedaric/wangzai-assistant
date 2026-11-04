import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('real HTTP recovery route exposes authenticated retry safety and actionable 401/403/404/offline failures', async () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'synthetic-recovery-route-auth-key';
  const db = createMigratedTestDb();
  let server;
  let remoteStatus = 401;
  try {
    server = createApp({ db, config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }), listAppliedMigrations: () => [], startedAt: Date.now(),
      recoveryFetchImpl: async () => {
        if (remoteStatus === 0) throw new Error('synthetic disconnected recovery service');
        return jsonResponse({}, remoteStatus);
      },
    });
    const port = await listen(server);
    for (const [status, expectedCode, expectedHttp, safeAuthRetry] of [
      [401, 'RECOVERY_REMOTE_AUTH_REQUIRED', 401, true],
      [403, 'RECOVERY_REMOTE_ACCESS_DENIED', 403, false],
      [404, 'RECOVERY_REMOTE_ENDPOINT_UNAVAILABLE', 404, false],
      [0, 'RECOVERY_REMOTE_UNAVAILABLE', 503, false],
    ]) {
      remoteStatus = status;
      const response = await fetch(`http://127.0.0.1:${port}/api/app/recovery/command`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'list-generations',
          remote: { baseUrl: 'https://synthetic-recovery.invalid', accessToken: 'synthetic-private-token' } }) });
      const result = await response.json();
      assert.equal(response.status, expectedHttp);
      assert.equal(result.error.code, expectedCode);
      assert.equal(result.error.remoteStatus, status);
      assert.equal(result.error.safeAuthRetry, safeAuthRetry);
      assert.equal(JSON.stringify(result).includes('synthetic-private-token'), false);
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET; else process.env.LOCAL_API_SECRET = previousSecret;
  }
});

test('recovery command route accepts remote credentials only from the trusted caller and keeps upload orchestration in local-api', async () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'local-api-recovery-route-test-secret-123456';
  const db = createMigratedTestDb();
  let server;
  try {
    db.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const remoteCalls = [];
    const remoteGenerationId = 'r'.repeat(43);
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
      recoveryFetchImpl: async (url, options = {}) => {
        remoteCalls.push({ url, options });
        if (options.method === 'PUT') {
          const bytes = Buffer.from(options.body);
          return jsonResponse({ chunk_id: url.split('/').at(-1), cipher_bytes: bytes.length, reused: false });
        }
        if (options.method === 'POST') {
          const payload = JSON.parse(options.body);
          return jsonResponse({
            generation_id: remoteGenerationId,
            scope_key: payload.scope_key,
            manifest_chunk_id: payload.manifest_chunk_id,
            key_envelope: payload.key_envelope,
            logical_cipher_bytes: payload.logical_cipher_bytes,
            owner_refs: payload.owner_refs,
          }, 201);
        }
        return jsonResponse([]);
      },
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/app/recovery/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'backup-shop',
        shopId: 'shop-a',
        passphrase: 'portable recovery passphrase',
        remote: { baseUrl: 'https://recovery.example', accessToken: 'desktop-only-token' },
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.remoteGenerationId, remoteGenerationId);
    assert.equal(remoteCalls.some((call) => call.options.headers?.Authorization === 'Bearer desktop-only-token'), true);
    assert.equal(JSON.stringify(remoteCalls).includes('shop-a'), false);
    assert.equal(JSON.stringify(remoteCalls).includes('portable recovery passphrase'), false);
    const status = await fetch(`http://127.0.0.1:${port}/api/app/recovery/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'status' }),
    });
    assert.deepEqual(await status.json(), {
      ok: true,
      enrolled: true,
      portableEnvelope: true,
      localKeysetEncrypted: true,
      reconcile: { pending: 0, queued: 0, completed: 0, partial: 0, failed: 0, rows: [] },
    });
    const automatic = await fetch(`http://127.0.0.1:${port}/api/app/recovery/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'backup-all-shops',
        remote: { baseUrl: 'https://recovery.example', accessToken: 'desktop-only-token' },
      }),
    });
    const automaticResult = await automatic.json();
    assert.equal(automatic.status, 200);
    assert.equal(automaticResult.shops.length, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});

test('recovery command route preserves controlled data-backup error codes', async () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'local-api-data-backup-error-route-secret';
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/app/recovery/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'prepare-user-data-export',
        passphrase: 'independent-export-passphrase',
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: 'DATA_BACKUP_SHOP_ID_REQUIRED',
        message: 'DATA_BACKUP_SHOP_ID_REQUIRED',
      },
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});
