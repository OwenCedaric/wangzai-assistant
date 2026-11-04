import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { registerDesktopIpcHandlers } from './desktopIpc.js';
import { createApp } from '../../../local-api/src/app/createApp.js';
import { createMigratedTestDb } from '../../../local-api/test/testDb.js';
import { createAccountRemovalOperationRepository } from '../../../local-api/src/db/repositories/accountRemovalOperationRepository.js';
import { getAccountRemovalClientResourceIds } from '../../../local-api/src/domain/accountRemoval/accountRemovalClientResources.js';

process.env.LOCAL_API_SECRET = 'synthetic-production-auth-wiring-key';

test('registered desktop IPC refreshes a rejected token through real local HTTP and stores only verified remote absence', async () => {
  // createMigratedTestDb resolves migrations relative to cwd; use the exported
  // helper only while the desktop test owns this isolated synchronous setup.
  const originalCwd = process.cwd();
  const localApiRoot = new URL('../../../local-api/', import.meta.url);
  let db;
  try {
    process.chdir(fileURLToPath(localApiRoot));
    db = createMigratedTestDb();
  } finally { process.chdir(originalCwd); }
  const owner = { ownerType: 'model_api_account', ownerId: 'synthetic-auth-wiring-owner' };
  const repo = createAccountRemovalOperationRepository(db);
  const pending = repo.beginOrReuse({
    preview: { plannedResources: getAccountRemovalClientResourceIds(owner.ownerType).map((id) => ({ id })) },
    confirm: { owner, idempotencyKey: 'synthetic-auth-wiring-operation', requestDigest: 'synthetic-request-digest',
      previewFingerprint: 'a'.repeat(64), catalogFingerprint: 'b'.repeat(64), snapshotFingerprint: 'c'.repeat(64) },
    account: { id: owner.ownerId }, ownerIncarnation: 'synthetic-incarnation', barrierProof: {},
    backupAuthorization: { outcome: 'not-required' },
  }).operation;
  repo.markPhase(pending.operationId, 'external-delete-pending');
  const oldToken = 'synthetic-rejected-production-token';
  const newToken = 'synthetic-refreshed-production-token';
  const remoteAuthorizations = [];
  let currentToken = oldToken;
  let refreshes = 0;
  let server;
  let desktopRuntime;
  try {
    server = createApp({ db, config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }), listAppliedMigrations: () => [], startedAt: Date.now(),
      recoveryFetchImpl: async (url, options = {}) => {
        assert.equal(new URL(url).pathname, '/api/recovery/generations');
        assert.equal(options.method || 'GET', 'GET');
        remoteAuthorizations.push(options.headers.Authorization);
        return new Response(JSON.stringify(options.headers.Authorization === `Bearer ${oldToken}` ? { detail: 'expired' } : []), {
          status: options.headers.Authorization === `Bearer ${oldToken}` ? 401 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const handlers = new Map();
    const licenseRuntime = {
      rebindSessionObserver() {},
      async getRuntime() { return { mode: 'observe', thinClient: { enabled: false } }; },
      async getSession() { return { authorized: false }; },
      async request() { throw new Error('UNEXPECTED_SYNTHETIC_LICENSE_BUSINESS_REQUEST'); },
      async getRecoveryRemoteContext(options = {}) {
        if (options.forceRefresh) {
          assert.equal(options.rejectedAccessToken, oldToken);
          refreshes += 1;
          currentToken = newToken;
        }
        return { baseUrl: 'https://synthetic-remote.invalid', accessToken: currentToken };
      },
    };
    desktopRuntime = registerDesktopIpcHandlers({
      app: { isPackaged: false, getName: () => 'Synthetic desktop wiring', getVersion: () => '1.0.0', getPath: () => 'unused-synthetic-path' },
      ipcMain: { removeHandler: (name) => handlers.delete(name), handle: (name, handler) => handlers.set(name, handler) },
      existingLicenseRuntime: licenseRuntime, safeStorage: {}, desktopRoot: '', resourcesPath: '',
      paths: { localDataRoot: () => 'unused-synthetic-path', frontendDistDirectory: () => 'unused-synthetic-path' },
      runtimeInfo: { localApi: { baseUrl: `http://127.0.0.1:${server.address().port}`, authToken: '', profile: { profileId: 'default' } },
        purchaseBridge: { baseUrl: 'http://127.0.0.1:1', authToken: '', updateLicenseState: async () => {} } },
    });
    const input = { command: 'purge-account-owner', operationId: pending.operationId, requestId: 'synthetic-production-request' };
    const purged = await handlers.get('desktop:recovery-request')({}, input);
    assert.equal(purged.ok, true, JSON.stringify(purged));
    assert.equal(purged.data.verified, true);
    assert.equal(refreshes, 1);
    assert.deepEqual(remoteAuthorizations, [`Bearer ${oldToken}`, `Bearer ${newToken}`]);
    const stored = repo.getOperation(pending.operationId);
    assert.equal(stored.phase, 'external-delete-pending');
    assert.equal(stored.completedAt, null);
    assert.deepEqual(stored.payload.trustedClientResourceReceipts, {
      'backup:remote-recovery-owner-model-api-account': { verified: true },
    });
    const listed = await handlers.get('desktop:recovery-request')({}, { command: 'list-generations' });
    assert.deepEqual(listed.data.generations, []);
    assert.equal(remoteAuthorizations.at(-1), `Bearer ${newToken}`);
    assert.equal(JSON.stringify(purged).includes(oldToken), false);
    assert.equal(JSON.stringify(purged).includes(newToken), false);
  } finally {
    desktopRuntime?.recoveryAutoBackupScheduler?.stop();
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
