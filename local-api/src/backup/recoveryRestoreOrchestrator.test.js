import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryExporter } from './recoveryExporter.js';
import { createRecoveryGeneration } from './recoveryGeneration.js';
import { createRecoveryKeyEnvelope, generateRecoveryKeyset } from './recoveryKeyEnvelope.js';
import { createRecoveryKeysetStore } from './recoveryKeysetStore.js';
import { createRecoveryProfileCore } from './recoveryProfileCore.js';
import { createRecoveryRestoreOrchestrator } from './recoveryRestoreOrchestrator.js';
import { createMigratedTestDb } from '../../test/testDb.js';

const secretCodec = {
  encrypt: (value) => `local:${Buffer.from(value).toString('base64url')}`,
  decrypt: (value) => String(value).startsWith('local:') ? Buffer.from(value.slice(6), 'base64url').toString('utf8') : null,
};

test('remote restoration only writes a fresh staging database and saves the portable keyset after all checks pass', async () => {
  const source = createMigratedTestDb();
  const keysetDb = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, client_id, api_key_encrypted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'client-a', 'source:api-key-a', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    source.prepare(`
      INSERT INTO purchase_order_overrides (shop_id, order_key, source_cost_cny, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'order-1', 12.5, '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const keyset = generateRecoveryKeyset((size) => Buffer.alloc(size, size + 80));
    const aad = 'wangzai-recovery:v1:profile:00000000-0000-4000-8000-000000000002';
    const envelope = createRecoveryKeyEnvelope({ keyset, passphrase: 'portable recovery passphrase', aad });
    const profileCandidate = createRecoveryProfileCore({
      db: source,
      decryptShopSecret: (value) => String(value).replace(/^source:/u, ''),
    }).buildCandidate({ encryptionKey: keyset.chunkEncryptionKey, dedupeKey: keyset.dedupeKey, aad });
    const shopCandidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey: keyset.chunkEncryptionKey, dedupeKey: keyset.dedupeKey, aad,
    });
    const transport = createRecoveryGeneration({
      profileCandidate,
      shopCandidate,
      keyEnvelope: envelope,
      encryptionKey: keyset.chunkEncryptionKey,
      dedupeKey: keyset.dedupeKey,
      aad,
      generationId: 'generation-remote-1',
      createdAt: '2026-07-11T12:00:00.000Z',
    });
    const keysetStore = createRecoveryKeysetStore({ db: keysetDb, ...secretCodec });
    const result = await createRecoveryRestoreOrchestrator({
      keysetStore,
      encryptShopSecret: (value) => `target:${value}`,
    }).stageRemoteGeneration({
      remoteClient: { downloadGeneration: async () => transport },
      generationId: 'remote-generation-identifier',
      passphrase: 'portable recovery passphrase',
      stagingDb: staging,
    });
    assert.equal(result.mode, 'staging-only');
    assert.equal(staging.prepare('SELECT count(*) AS count FROM purchase_order_overrides WHERE shop_id = ?').get('shop-a').count, 1);
    assert.equal(staging.prepare('SELECT api_key_encrypted FROM shops WHERE id = ?').get('shop-a').api_key_encrypted, 'target:api-key-a');
    assert.equal(keysetStore.readState().recoveryAad, aad);
  } finally {
    source.close();
    keysetDb.close();
    staging.close();
  }
});

test('remote restoration stages every selected shop generation into one database before a profile can switch', async () => {
  const source = createMigratedTestDb();
  const keysetDb = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    for (const shopId of ['shop-a', 'shop-b']) {
      source.prepare(`
        INSERT INTO shops (id, name, client_id, api_key_encrypted, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(shopId, `Source ${shopId}`, `client-${shopId}`, `source:key-${shopId}`, 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
      source.prepare(`
        INSERT INTO purchase_order_overrides (shop_id, order_key, source_cost_cny, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(shopId, `order-${shopId}`, 12.5, '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    }
    const keyset = generateRecoveryKeyset((size) => Buffer.alloc(size, size + 90));
    const aad = 'wangzai-recovery:v1:profile:00000000-0000-4000-8000-000000000009';
    const envelope = createRecoveryKeyEnvelope({ keyset, passphrase: 'portable recovery passphrase', aad });
    const profileCandidate = createRecoveryProfileCore({
      db: source,
      decryptShopSecret: (value) => String(value).replace(/^source:/u, ''),
    }).buildCandidate({ encryptionKey: keyset.chunkEncryptionKey, dedupeKey: keyset.dedupeKey, aad });
    const transports = new Map(['shop-a', 'shop-b'].map((shopId) => [
      `remote-${shopId}`,
      createRecoveryGeneration({
        profileCandidate,
        shopCandidate: createRecoveryExporter({ db: source }).buildShopCandidate({
          shopId, encryptionKey: keyset.chunkEncryptionKey, dedupeKey: keyset.dedupeKey, aad,
        }),
        keyEnvelope: envelope,
        encryptionKey: keyset.chunkEncryptionKey,
        dedupeKey: keyset.dedupeKey,
        aad,
        generationId: `generation-${shopId}`,
        createdAt: '2026-07-11T12:00:00.000Z',
      }),
    ]));
    const result = await createRecoveryRestoreOrchestrator({
      keysetStore: createRecoveryKeysetStore({ db: keysetDb, ...secretCodec }),
      encryptShopSecret: (value) => `target:${value}`,
    }).stageRemoteGenerations({
      remoteClient: { downloadGeneration: async ({ generationId }) => transports.get(generationId) },
      generationIds: ['remote-shop-a', 'remote-shop-b'],
      passphrase: 'portable recovery passphrase',
      stagingDb: staging,
    });
    assert.equal(result.shops.length, 2);
    assert.deepEqual(result.shops.map((shop) => shop.shopId), ['shop-a', 'shop-b']);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM purchase_order_overrides').get().count, 2);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM shops').get().count, 2);
  } finally {
    source.close();
    keysetDb.close();
    staging.close();
  }
});
