import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createDataBackupService } from '../backup/dataBackupService.js';
import { createRecoveryKeysetStore } from '../backup/recoveryKeysetStore.js';
import { createAccountRemovalOwnerRef } from '../db/repositories/accountRemovalOperationRepository.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { decryptSecret } from '../security/secretCrypto.js';
import { createApp } from './createApp.js';

const NOW = '2026-07-17T10:00:00.000Z';
const PASSPHRASE = 'portable-route-passphrase';
const CLIENT_ID = 'route-stable-ozon-client';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function saveShop(db, id, apiKey) {
  createShopRepository(db, { now: () => new Date(NOW) }).saveShop({
    id,
    name: `Shop ${id}`,
    alias: `店铺 ${id}`,
    clientId: CLIENT_ID,
    apiKey,
    status: 'active',
  });
}

function buildPortablePackage() {
  const sourceDb = createMigratedTestDb();
  try {
    saveShop(sourceDb, 'route-old-shop', 'route-old-api-key');
    sourceDb.prepare(`
      INSERT INTO product_source_links (
        id, shop_id, product_key, slot_index, platform, url, title,
        created_at, updated_at
      ) VALUES ('route-link', 'route-old-shop', 'route-offer', 0, '1688',
        'https://route.invalid/source', '历史货源', ?, ?)
    `).run(NOW, NOW);
    const keysetStore = createRecoveryKeysetStore({ db: sourceDb });
    keysetStore.initialize({ passphrase: 'route-primary-recovery-passphrase' });
    const service = createDataBackupService({
      db: sourceDb,
      keysetStore,
      decryptShopSecret: decryptSecret,
      now: () => new Date(NOW),
      createBackupId: () => 'data_backup_route_import_fixture',
    });
    const preview = service.previewShop('route-old-shop').shops[0];
    return service.prepareExport({
      shopId: 'route-old-shop',
      passphrase: PASSPHRASE,
      expectedDataFingerprint: preview.dataFingerprint,
      commitCapability: Buffer.alloc(32, 9).toString('base64url'),
    });
  } finally {
    sourceDb.close();
  }
}

async function postJson(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/app/data-backup-import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test('data backup import HTTP route preflights, confirms, rejects invalid commands/json, and honors owner fence', async () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'data-backup-import-route-test-master-secret';
  const portable = buildPortablePackage();
  const db = createMigratedTestDb();
  let server;
  try {
    saveShop(db, 'route-current-shop', 'route-current-api-key');
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {}, runtime: { profileId: 'default' } },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const packageInput = {
      targetShopId: 'route-current-shop',
      passphrase: PASSPHRASE,
      contentB64u: portable.contentB64u,
      packageSha256: portable.packageSha256,
      packageBytes: portable.packageBytes,
      conflictMode: 'preserve',
    };

    const preflight = await postJson(baseUrl, { command: 'preflight', ...packageInput });
    assert.equal(preflight.response.status, 200);
    assert.equal(preflight.data.targetShop.shopId, 'route-current-shop');
    assert.match(preflight.data.previewFingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(preflight.data.totalRecords > 0, true);

    const confirm = await postJson(baseUrl, {
      command: 'confirm',
      ...packageInput,
      previewFingerprint: preflight.data.previewFingerprint,
    });
    assert.equal(confirm.response.status, 200);
    assert.equal(confirm.data.verified, true);
    assert.equal(confirm.data.restored, true);
    assert.equal(confirm.data.targetShop.shopId, 'route-current-shop');
    assert.equal(
      db.prepare(`
        SELECT url FROM product_source_links
        WHERE shop_id = 'route-current-shop' AND product_key = 'route-offer'
      `).get().url,
      'https://route.invalid/source',
    );
    assert.equal(decryptSecret(
      db.prepare(`SELECT api_key_encrypted FROM shops WHERE id = 'route-current-shop'`).get().api_key_encrypted,
    ), 'route-current-api-key');
    const historyResponse = await fetch(
      `${baseUrl}/api/app/data-backup-import-history?shopId=route-current-shop&limit=5`,
    );
    const history = await historyResponse.json();
    assert.equal(historyResponse.status, 200);
    assert.equal(history.imports.length, 1);
    assert.equal(history.imports[0].verified, true);
    assert.equal(history.imports[0].status, 'completed');

    const unknown = await postJson(baseUrl, { command: 'unknown' });
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.data.error.code, 'DATA_BACKUP_IMPORT_COMMAND_INVALID');

    const malformedResponse = await fetch(`${baseUrl}/api/app/data-backup-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(malformedResponse.status, 400);
    assert.equal((await malformedResponse.json()).ok, false);

    const ownerRef = createAccountRemovalOwnerRef({
      ownerType: 'ozon_shop',
      ownerId: 'route-current-shop',
    });
    db.prepare(`
      INSERT INTO account_removal_operations (
        operation_id, idempotency_key_hash, request_digest, owner_type, owner_ref,
        phase, status, preview_fingerprint, catalog_fingerprint, snapshot_fingerprint,
        client_resource_ids_json, deletion_summary_json, created_at, updated_at
      ) VALUES ('route-fence', ?, ?, 'ozon_shop', ?, 'planned', 'pending', ?, ?, ?, '[]', '{}', ?, ?)
    `).run(
      '1'.repeat(64),
      '2'.repeat(64),
      ownerRef,
      '3'.repeat(64),
      '4'.repeat(64),
      '5'.repeat(64),
      NOW,
      NOW,
    );
    const fenced = await postJson(baseUrl, { command: 'preflight', ...packageInput });
    assert.equal(fenced.response.status, 400);
    assert.equal(fenced.data.error.code, 'ACCOUNT_REMOVAL_OWNER_LOCKED');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});
