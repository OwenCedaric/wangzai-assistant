import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from './createApp.js';
import { initializeDatabase } from '../db/database.js';
import { createAccountRemovalOperationRepository } from '../db/repositories/accountRemovalOperationRepository.js';
import { ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION } from '../domain/accountRemoval/accountRemovalContract.js';
import { getAccountRemovalClientBarrierIds, isAccountRemovalServerVerifiedClientResource } from '../domain/accountRemoval/accountRemovalClientResources.js';
import { createPurchaseBrowserLocalApiClient } from '../../../desktop/src/purchaseBrowser/purchaseBrowserLocalApiClient.js';
import { createCefPurchaseBrowserController } from '../../../desktop/src/purchaseBrowser/cefPurchaseBrowserController.js';
import { createPurchaseBrowserProfileStore } from '../../../desktop/src/purchaseBrowser/purchaseBrowserProfileStore.js';
import { createPurchaseBrowserPolicy } from '../../../desktop/src/purchaseBrowser/purchaseBrowserPolicy.js';

const OWNER_TABLES = { purchase_account: 'purchase_accounts', integration_profile: 'integration_profiles' };

function legacyPendingMarker(root, operationId, profile) {
  const directory = path.join(root, 'purchase-browser', 'pending-account-removals');
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${createHash('sha256').update(operationId).digest('hex').slice(0, 40)}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    version: 2, operationId, ownerRef: profile.profile.ownerRef,
    storagePath: profile.profileDirectory,
    resourceIds: [
      'browser:purchase-cache-storage', 'browser:purchase-cookies', 'browser:purchase-downloads',
      'browser:purchase-extension-storage', 'browser:purchase-http-cache', 'browser:purchase-indexed-db',
      'browser:purchase-local-storage', 'browser:purchase-persistent-partition',
      'browser:purchase-plugin-installation-state', 'browser:purchase-profile-identity',
      'browser:purchase-proxy-auth', 'browser:purchase-service-workers',
    ],
  }));
  return filePath;
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-removal-desktop-http-'));
  const databasePath = path.join(root, 'operation.sqlite');
  const originalSecret = process.env.LOCAL_API_SECRET;
  const originalFetch = globalThis.fetch;
  process.env.LOCAL_API_SECRET = randomBytes(32).toString('base64url');
  const authToken = randomBytes(32).toString('base64url');
  const purchaseBrowserToken = randomBytes(32).toString('base64url');
  const requests = [];
  const nativeClosed = [];
  const nativeSessions = new Set();
  const addons = new Set();
  let allowedOrigin = '';
  let externalAttempts = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.origin !== allowedOrigin) {
      externalAttempts += 1;
      throw new Error('FIXTURE_EXTERNAL_NETWORK_FORBIDDEN');
    }
    const headers = new Headers(options?.headers);
    requests.push({ path: url.pathname, method: options?.method || 'GET', authenticated: headers.get('x-wangzai-local-api-token') === authToken, browserCapability: headers.get('x-wangzai-purchase-browser-token') === purchaseBrowserToken });
    return originalFetch(input, options);
  };
  const rejectExternal = async () => { externalAttempts += 1; throw new Error('FIXTURE_EXTERNAL_SERVICE_FORBIDDEN'); };
  const { db } = initializeDatabase({ database: { path: databasePath, enableWal: true, busyTimeoutMs: 50 } });
  const operationRepository = createAccountRemovalOperationRepository(db);
  let server;
  try { server = createApp({
    db,
    config: { database: { path: databasePath }, runtime: { profileId: 'fixture-desktop-profile', appId: 'fixture-desktop-app' }, security: { authToken, purchaseBrowserToken }, sync: { continuousEnabled: false }, ozon: {} },
    ozonClient: { request: rejectExternal, requestReadOnly: rejectExternal, requestWrite: rejectExternal },
    crossBorderClient: { request: rejectExternal, requestWrite: rejectExternal },
    recoveryFetchImpl: rejectExternal,
    externalIntegrationFetchImpl: rejectExternal,
    getDatabaseStatus: () => ({ ok: true }), listAppliedMigrations: () => [], startedAt: Date.now(),
  }); } catch (error) {
    db.close();
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = originalSecret;
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  allowedOrigin = `http://127.0.0.1:${server.address().port}`;
  const client = createPurchaseBrowserLocalApiClient({ baseUrl: allowedOrigin, authToken, purchaseBrowserToken, tenantId: 'fixture-desktop-app', userId: 'fixture-desktop-profile' });
  const profileStore = createPurchaseBrowserProfileStore({
    filePath: path.join(root, 'purchase-browser', 'profiles.enc.json'),
    // A reversible fixture protector replaces Electron safeStorage only. The
    // actual profile/HMAC/persistence/removal code remains unmocked.
    protector: { protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString('utf8') },
    baseUserAgent: 'Mozilla/5.0 Fixture Chrome/150.0.0.0 Safari/537.36',
  });
  const controller = createCefPurchaseBrowserController({
    dataRoot: root, profileStore, localApiClient: client, policy: createPurchaseBrowserPolicy(),
    cefRuntime: {
      open: async () => { throw new Error('FIXTURE_MUST_NOT_LAUNCH_BROWSER'); },
      async close(ownerRef) { nativeClosed.push(ownerRef); return { ok: true, existed: nativeSessions.delete(ownerRef) }; },
      get: ownerRef => nativeSessions.has(ownerRef) ? { fixture: true } : null,
      dispose: () => nativeSessions.clear(),
    },
    addonManager: { purgeOwner: ownerRef => addons.delete(ownerRef), readState: ownerRef => ({ activeSha: addons.has(ownerRef) ? 'fixture-addon' : '' }) },
  });
  controller.attachHost({ isDestroyed: () => false, webContents: { send() {} } });
  async function request(route, { method = 'GET', body } = {}) {
    const response = await fetch(`${allowedOrigin}${route}`, {
      method, headers: { 'content-type': 'application/json', 'x-wangzai-local-api-token': authToken },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    return { status: response.status, payload };
  }
  async function save(ownerType, ownerId, { rebind = false } = {}) {
    const route = ownerType === 'purchase_account' ? '/api/purchase/accounts' : '/api/integrations/profiles';
    const body = ownerType === 'purchase_account'
      ? { id: ownerId, name: `Fixture ${ownerId}`, platformName: '1688', platformUrl: 'https://www.1688.com/', loginAccount: 'fixture-user', loginPassword: randomBytes(24).toString('base64url') }
      : { id: ownerId, integrationType: 'ozon-follow-seller-session', platformName: `Fixture ${ownerId}`, apiType: 'tool-service', authMode: 'local', configStatus: 'saved' };
    const saved = await request(route, { method: 'POST', body: { ...body, ...(rebind ? { accountRemovalRebind: true } : {}) } });
    assert.equal(saved.status, 200, saved.payload?.error?.code || saved.payload?.code);
    const { binding } = await client.getOwnerBinding(ownerId, ownerType);
    assert.equal(binding.accountId, ownerId);
    const profile = profileStore.getOrCreate(binding);
    const profileDirectory = path.join(root, 'purchase-browser', 'cef-profiles', profile.ownerRef);
    const downloadDirectory = path.join(root, 'purchase-browser', 'downloads', profile.ownerRef);
    for (const directory of [profileDirectory, downloadDirectory]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'fixture.txt'), 'synthetic fixture data only');
    }
    nativeSessions.add(profile.ownerRef);
    addons.add(profile.ownerRef);
    return { owner: { ownerType, ownerId }, binding, profile, profileDirectory, downloadDirectory };
  }
  async function begin(owner, idempotencyKey) {
    const previewResult = await request('/api/account-removal/preview', { method: 'POST', body: { owner } });
    assert.equal(previewResult.status, 200, previewResult.payload?.error?.code);
    const { preview, backupReview } = previewResult.payload;
    const barrierIds = getAccountRemovalClientBarrierIds(owner.ownerType).sort();
    const envelope = {
      preview,
      confirm: {
        version: preview.version, contractVersion: preview.version, owner: { ...preview.owner },
        requestedOwnerType: preview.requestedOwnerType, requestedOwnerId: preview.requestedOwnerId,
        requestedResourceIdsSemantics: preview.requestedResourceIdsSemantics, requestedResourceIds: [...preview.requestedResourceIds],
        catalogVersion: preview.catalogVersion, catalogFingerprint: preview.catalogFingerprint,
        resourceObservations: preview.resourceObservations.map(entry => ({ ...entry })),
        snapshotFingerprint: preview.snapshotFingerprint, previewFingerprint: preview.previewFingerprint, idempotencyKey,
      },
      // The fixture has no renderer write queues. This proves only the HTTP
      // challenge contract, not a production renderer/global quiescence run.
      barrierProof: { version: ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION, owner, previewFingerprint: preview.previewFingerprint, fencedResourceIds: [...barrierIds], drainedResourceIds: [...barrierIds] },
      confirmationCode: 'DELETE_ACCOUNT_PERMANENTLY',
      ...(backupReview?.required ? { backupAuthorization: { outcome: 'explicitly-skipped', previewFingerprint: preview.previewFingerprint, dataFingerprint: backupReview.dataFingerprint, skipConfirmationCode: 'SKIP_BACKUP_AND_DELETE_PERMANENTLY' } } : {}),
    };
    const confirmed = await request('/api/account-removal/confirm', { method: 'POST', body: envelope });
    assert.equal(confirmed.status, 202, confirmed.payload?.error?.code);
    assert.equal(confirmed.payload.phase, 'external-delete-pending');
    assert.equal(confirmed.payload.requiresClientCleanup, true);
    return confirmed.payload;
  }
  function fixtureNonBrowserReceipts(operation) {
    const injected = [];
    for (const resourceId of operation.clientCleanup.resourceIds) {
      if (resourceId.startsWith('browser:')) continue;
      if (isAccountRemovalServerVerifiedClientResource(operation.ownerType, resourceId)) {
        operationRepository.recordTrustedClientResourceReceipt(operation.operationId, resourceId);
        injected.push(resourceId);
      }
    }
    return { fixtureOnly: true, remoteCleanupVerified: false, injectedTrustedResourceIds: injected };
  }
  return {
    db, root, client, controller, profileStore, operationRepository, requests, nativeClosed, request, save, begin, fixtureNonBrowserReceipts,
    rowCount: owner => Number(db.prepare(`SELECT COUNT(*) count FROM ${OWNER_TABLES[owner.ownerType]} WHERE id=?`).get(owner.ownerId).count),
    async close() {
      controller.dispose();
      await new Promise(resolve => server.close(resolve));
      db.close();
      globalThis.fetch = originalFetch;
      if (originalSecret === undefined) delete process.env.LOCAL_API_SECRET;
      else process.env.LOCAL_API_SECRET = originalSecret;
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(externalAttempts, 0, 'no platform or real external service may be called');
    },
  };
}

for (const ownerType of ['purchase_account', 'integration_profile']) {
  test(`${ownerType}: real HTTP prepare/receipt and desktop profile purge satisfy the durable client nonce`, async () => {
    const f = await fixture();
    try {
      const target = await f.save(ownerType, `target-${ownerType}`);
      const other = await f.save(ownerType, `keep-${ownerType}`);
      const operation = await f.begin(target.owner, `desktop-http-${ownerType}`);
      assert.equal(f.rowCount(target.owner), 0);
      const initial = f.operationRepository.getOperation(operation.operationId);
      assert.equal(Object.keys(initial.payload.trustedClientResourceReceipts || {}).some(id => id.startsWith('browser:')), false);
      const nonBrowserEvidence = f.fixtureNonBrowserReceipts(operation);
      const purged = await f.controller.dispatch({ command: 'purge-operation', operationId: operation.operationId,
        ownerRef: other.profile.ownerRef, accountId: other.owner.ownerId, storagePath: other.profileDirectory,
        receiptBinding: { version: 'renderer-must-not-override', operationId: 'other', nonce: 'forged', ownerGenerationHash: '0'.repeat(64) } });
      assert.equal(purged.verified, true);
      assert.equal(purged.proof.ownerRef, target.profile.ownerRef);
      assert.equal(fs.existsSync(target.profileDirectory), false);
      assert.equal(fs.existsSync(target.downloadDirectory), false);
      assert.equal(f.profileStore.hasOwnerRef(other.profile.ownerRef), true);
      assert.equal(fs.existsSync(other.profileDirectory), true);
      assert.equal(f.nativeClosed.includes(other.profile.ownerRef), false);
      const receiptState = f.operationRepository.getOperation(operation.operationId);
      const expectedBrowser = operation.clientCleanup.resourceIds.filter(id => id.startsWith('browser:'));
      assert.ok(expectedBrowser.length > 0);
      assert.ok(expectedBrowser.every(id => receiptState.payload.trustedClientResourceReceipts[id]?.verified));
      const completed = await f.client.finalizeAccountRemoval(operation.operationId);
      assert.equal(completed.completed, true);
      assert.equal(completed.phase, 'completed');
      const durable = f.operationRepository.getOperation(operation.operationId);
      assert.equal(durable.clientCleanupNonce, null);
      assert.equal(durable.phase, 'completed');
      assert.equal(f.rowCount(other.owner), 1);
      for (const route of ['/api/internal/purchase-browser/account-removal/prepare', '/api/internal/purchase-browser/account-removal/receipt', '/api/account-removal/client-verify']) {
        const requests = f.requests.filter(row => row.path === route);
        assert.ok(requests.length > 0);
        assert.ok(requests.every(row => row.authenticated && row.browserCapability));
      }
      console.log(JSON.stringify({ ownerType, browserResourcesVerifiedOverRealHttp: expectedBrowser.length, completed: true, otherOwnerPreserved: true,
        nonBrowserEvidence: { fixtureOnly: nonBrowserEvidence.fixtureOnly, remoteCleanupVerified: false, syntheticTrustedReceiptCount: nonBrowserEvidence.injectedTrustedResourceIds.length } }));
    } finally { await f.close(); }
  });
}

test('real invalid operation rejection leaves every browser profile and account intact', async () => {
  const f = await fixture();
  try {
    const target = await f.save('purchase_account', 'invalid-operation-kept');
    await assert.rejects(f.controller.dispatch({ command: 'purge-operation', operationId: 'nonexistent-operation', ownerRef: target.profile.ownerRef, storagePath: target.profileDirectory }),
      { code: 'PURCHASE_BROWSER_REQUEST_INVALID', status: 409 });
    assert.equal(f.rowCount(target.owner), 1);
    assert.equal(f.profileStore.hasOwnerRef(target.profile.ownerRef), true);
    assert.equal(fs.existsSync(target.profileDirectory), true);
    assert.equal(f.requests.some(row => row.path.endsWith('/account-removal/receipt')), false);
  } finally { await f.close(); }
});

test('an old completed operation and receipt cannot delete a recreated same-ID browser profile', async () => {
  const f = await fixture();
  try {
    const old = await f.save('purchase_account', 'rebound-purchase');
    const operation = await f.begin(old.owner, 'desktop-http-before-rebind');
    f.fixtureNonBrowserReceipts(operation);
    const oldPurge = await f.controller.dispatch({ command: 'purge-operation', operationId: operation.operationId });
    assert.equal((await f.client.finalizeAccountRemoval(operation.operationId)).completed, true);
    const rebound = await f.save('purchase_account', old.owner.ownerId, { rebind: true });
    assert.notEqual(rebound.binding.accountIncarnation, old.binding.accountIncarnation);
    assert.notEqual(rebound.profile.ownerRef, old.profile.ownerRef);
    await assert.rejects(f.client.recordAccountRemovalReceipt(operation.operationId, oldPurge.proof), { code: 'PURCHASE_BROWSER_REQUEST_INVALID', status: 409 });
    const replay = await f.controller.dispatch({ command: 'purge-operation', operationId: operation.operationId, ownerRef: rebound.profile.ownerRef, storagePath: rebound.profileDirectory });
    assert.equal(replay.verified, true, 'only the already completed original operation is replayed');
    assert.equal(replay.proof.ownerRef, old.profile.ownerRef);
    assert.equal(f.rowCount(rebound.owner), 1);
    assert.equal(f.profileStore.hasOwnerRef(rebound.profile.ownerRef), true);
    assert.equal(fs.existsSync(rebound.profileDirectory), true);
  } finally { await f.close(); }
});

test('a stale proof must not satisfy browser cleanup on a new operation for a recreated account', async () => {
  const f = await fixture();
  try {
    const old = await f.save('purchase_account', 'cross-operation-rebound');
    const oldOperation = await f.begin(old.owner, 'desktop-http-old-proof');
    f.fixtureNonBrowserReceipts(oldOperation);
    const oldPurge = await f.controller.dispatch({ command: 'purge-operation', operationId: oldOperation.operationId });
    assert.equal((await f.client.finalizeAccountRemoval(oldOperation.operationId)).completed, true);
    const rebound = await f.save('purchase_account', old.owner.ownerId, { rebind: true });
    const next = await f.begin(rebound.owner, 'desktop-http-new-proof');
    assert.notEqual(rebound.profile.ownerRef, oldPurge.proof.ownerRef);
    let rejected = null;
    try { await f.client.recordAccountRemovalReceipt(next.operationId, oldPurge.proof); }
    catch (error) { rejected = error; }
    const actual = f.operationRepository.getOperation(next.operationId);
    console.log(JSON.stringify({ case: 'stale-proof-to-new-operation', rejected: Boolean(rejected),
      originalAndNewOwnerRefsDiffer: true,
      newOperationBrowserReceiptCount: Object.keys(actual.payload.trustedClientResourceReceipts || {}).filter(id => id.startsWith('browser:')).length,
      newBrowserProfileStillExists: fs.existsSync(rebound.profileDirectory) }));
    assert.ok(rejected, 'old browser proof must be rejected for the new operation/incarnation');
    assert.equal(rejected.status, 409);
    for (const receiptBinding of [
      { ...oldPurge.proof.receiptBinding, operationId: next.operationId },
      { ...oldPurge.proof.receiptBinding, operationId: next.operationId, nonce: next.clientCleanup.nonce },
    ]) {
      await assert.rejects(f.client.recordAccountRemovalReceipt(next.operationId, { ...oldPurge.proof, receiptBinding }), { status: 409 });
    }
    assert.equal(Object.keys(actual.payload.trustedClientResourceReceipts || {}).some(id => id.startsWith('browser:')), false);
    assert.equal(fs.existsSync(rebound.profileDirectory), true);
  } finally { await f.close(); }
});

test('a legacy pending file is upgraded through real HTTP prepare and finishes with the current nonce', async () => {
  const f = await fixture();
  try {
    const target = await f.save('purchase_account', 'legacy-http-pending');
    const operation = await f.begin(target.owner, 'desktop-http-legacy-pending');
    f.fixtureNonBrowserReceipts(operation);
    const marker = legacyPendingMarker(f.root, operation.operationId, target);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(marker, 'utf8')), 'receiptBinding'), false);
    const recovered = await f.controller.recoverPendingPurges();
    assert.equal(recovered.recovered.length, 1);
    const proof = recovered.recovered[0].proof;
    assert.equal(proof.receiptBinding.version, 'purchase-browser-removal-receipt-v2');
    assert.equal(proof.receiptBinding.operationId, operation.operationId);
    assert.equal(proof.receiptBinding.nonce, operation.clientCleanup.nonce);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(target.profileDirectory), false);
    assert.equal(f.operationRepository.getOperation(operation.operationId).phase, 'completed');
    assert.ok(f.requests.filter(row => row.path === `/api/account-removal/operations/${operation.operationId}`).length >= 2);
  } finally { await f.close(); }
});

test('completed operation readback retires a stale marker without deleting the new incarnation it names', async () => {
  const f = await fixture();
  try {
    const old = await f.save('purchase_account', 'completed-marker-rebind');
    const operation = await f.begin(old.owner, 'desktop-http-completed-marker');
    f.fixtureNonBrowserReceipts(operation);
    await f.controller.dispatch({ command: 'purge-operation', operationId: operation.operationId });
    assert.equal((await f.client.finalizeAccountRemoval(operation.operationId)).completed, true);
    const rebound = await f.save('purchase_account', old.owner.ownerId, { rebind: true });
    const marker = legacyPendingMarker(f.root, operation.operationId, rebound);
    const prepareCount = f.requests.filter(row => row.path.endsWith('/account-removal/prepare')).length;
    const recovered = await f.controller.recoverPendingPurges();
    assert.equal(recovered.recovered[0].completed, true);
    assert.equal(recovered.recovered[0].skippedCleanup, true);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(rebound.profileDirectory), true);
    assert.equal(f.profileStore.hasOwnerRef(rebound.profile.ownerRef), true);
    assert.equal(f.rowCount(rebound.owner), 1);
    assert.equal(f.requests.filter(row => row.path.endsWith('/account-removal/prepare')).length, prepareCount);
  } finally { await f.close(); }
});

test('fresh real prepare rejects a pending file naming another owner before any physical cleanup', async () => {
  const f = await fixture();
  try {
    const target = await f.save('purchase_account', 'pending-scope-target');
    const other = await f.save('purchase_account', 'pending-scope-other');
    const operation = await f.begin(target.owner, 'desktop-http-pending-scope');
    const marker = legacyPendingMarker(f.root, operation.operationId, other);
    await assert.rejects(f.controller.recoverPendingPurges(), { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_SCOPE_CHANGED' });
    assert.equal(fs.existsSync(marker), true);
    assert.equal(fs.existsSync(target.profileDirectory), true);
    assert.equal(fs.existsSync(other.profileDirectory), true);
    assert.equal(f.nativeClosed.length, 0);
    assert.equal(f.requests.some(row => row.path.endsWith('/account-removal/receipt')), false);
    assert.equal(f.operationRepository.getOperation(operation.operationId).phase, 'external-delete-pending');
  } finally { await f.close(); }
});
