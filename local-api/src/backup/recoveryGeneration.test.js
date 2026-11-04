import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryExporter } from './recoveryExporter.js';
import { createRecoveryGeneration, openRecoveryGeneration } from './recoveryGeneration.js';
import { createRecoveryKeyEnvelope } from './recoveryKeyEnvelope.js';
import { createRecoveryProfileCore, createRecoveryProfileCoreImporter } from './recoveryProfileCore.js';
import { createRecoveryImporter } from './recoveryImporter.js';
import { createMigratedTestDb } from '../../test/testDb.js';

const aad = 'wangzai-recovery:v1:account-opaque';
const keyset = {
  chunkEncryptionKey: Buffer.alloc(32, 61),
  dedupeKey: Buffer.alloc(32, 62),
};

function buildTransport(source) {
  const profileCandidate = createRecoveryProfileCore({
    db: source,
    decryptShopSecret: (value) => String(value).replace(/^source:/u, ''),
  }).buildCandidate({ encryptionKey: keyset.chunkEncryptionKey, dedupeKey: keyset.dedupeKey, aad });
  const shopCandidate = createRecoveryExporter({ db: source }).buildShopCandidate({
    shopId: 'shop-a', encryptionKey: keyset.chunkEncryptionKey, dedupeKey: keyset.dedupeKey, aad,
  });
  const envelope = createRecoveryKeyEnvelope({ keyset, passphrase: 'recovery-passphrase', aad });
  return createRecoveryGeneration({
    profileCandidate,
    shopCandidate,
    keyEnvelope: envelope,
    encryptionKey: keyset.chunkEncryptionKey,
    dedupeKey: keyset.dedupeKey,
    aad,
    generationId: 'gen-20260711-a',
    createdAt: '2026-07-11T12:00:00.000Z',
  });
}

test('recovery generation keeps business metadata in an encrypted inner manifest and restores importer candidates', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, client_id, api_key_encrypted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'client-a', 'source:api-key-a', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    source.prepare(`
      INSERT INTO ozon_products (shop_id, product_key, product_id, offer_id, name, visibility, raw_json, remote_hash, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('shop-a', 'product-1', 'product-1', 'offer-1', 'Product name', 'VISIBLE', '{"secret":"raw"}', 'hash-1', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const transport = buildTransport(source);
    const outward = JSON.stringify(transport);
    for (const hiddenValue of ['shop-a', 'Source Shop', 'api-key-a', 'products', 'plainCanonicalSha256', 'recordCount']) {
      assert.equal(outward.includes(hiddenValue), false, `outer transport leaked ${hiddenValue}`);
    }
    assert.equal(transport.logicalCipherBytes <= 30 * 1024 * 1024, true);
    const opened = openRecoveryGeneration({ transport, encryptionKey: keyset.chunkEncryptionKey, aad });
    assert.equal(opened.generationId, 'gen-20260711-a');
    assert.equal(opened.shopCandidate.shopId, 'shop-a');
    createRecoveryProfileCoreImporter({ db: staging, encryptShopSecret: (value) => `target:${value}` })
      .importCandidate({ candidate: opened.profileCandidate, encryptionKey: keyset.chunkEncryptionKey, aad });
    createRecoveryImporter({ db: staging }).importShopCandidate({
      candidate: opened.shopCandidate,
      encryptionKey: keyset.chunkEncryptionKey,
      aad,
      expectedShopId: 'shop-a',
    });
    assert.equal(staging.prepare('SELECT count(*) AS count FROM ozon_products WHERE shop_id = ?').get('shop-a').count, 1);
    assert.equal(staging.prepare('SELECT api_key_encrypted FROM shops WHERE id = ?').get('shop-a').api_key_encrypted, 'target:api-key-a');
  } finally {
    source.close();
    staging.close();
  }
});

test('recovery generation rejects an outer object set or cipher reference changed after manifest encryption', () => {
  const source = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const transport = buildTransport(source);
    const added = structuredClone(transport);
    added.objects.push(structuredClone(added.objects[0]));
    assert.throws(
      () => openRecoveryGeneration({ transport: added, encryptionKey: keyset.chunkEncryptionKey, aad }),
      /RECOVERY_TRANSPORT_OBJECT_ID_DUPLICATE/,
    );
    const changed = structuredClone(transport);
    changed.objects[0].cipherSha256 = '0'.repeat(64);
    assert.throws(
      () => openRecoveryGeneration({ transport: changed, encryptionKey: keyset.chunkEncryptionKey, aad }),
      /RECOVERY_CIPHER_HASH_MISMATCH|RECOVERY_GENERATION_OBJECT_REFERENCE_INVALID|RECOVERY_TRANSPORT_MANIFEST_OBJECT_MISSING/,
    );
  } finally {
    source.close();
  }
});
