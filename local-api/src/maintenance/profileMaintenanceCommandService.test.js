import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import {
  PROFILE_DOMAIN_REBUILD_PROOF_VERSION,
  PROFILE_MAINTENANCE_COMMANDS,
  PROFILE_MAINTENANCE_CONFIRMATIONS,
  createProfileMaintenanceCommandService,
} from './profileMaintenanceCommandService.js';
import { createProfileMaintenanceTrustedRebuildSourceAdapters } from './profileMaintenanceTrustedRebuildSourceAdapters.js';

function seedProtectedSetting(db, namespace = 'unit.protected') {
  db.prepare(`
    INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(namespace, '{"keep":true}', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
}

function seedOrdinaryCaches(db) {
  db.prepare(`
    INSERT INTO ozon_response_cache
      (id, domain, shop_id, endpoint_key, cache_key, status, is_stale, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'response-unit',
    'products',
    null,
    'product.info.list',
    'product-list-unit',
    'confirmed',
    0,
    '2026-07-16T00:00:00.000Z',
    '{"result":"temporary"}',
  );
  db.prepare(`
    INSERT INTO ozon_cache_keys
      (cache_key, domain, shop_id, endpoint_key, scope_key, policy, allow_stale, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'catalog-unit',
    'catalog',
    null,
    'description-category-tree',
    'profile-unit',
    'entity_snapshot',
    1,
    '2026-07-16T00:00:00.000Z',
    '2026-07-16T00:00:00.000Z',
  );
}

function seedExchangeRate(db, requestedDate = '2026-07-15', rate = 0.091) {
  db.prepare(`
    INSERT INTO exchange_rate_cache
      (requested_date, mode, rate_date, nearest_fallback, lookback_days_used,
       rub_to_cny_rate, source, fetched_at, expires_at, immutable, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    requestedDate,
    'exact',
    requestedDate,
    0,
    0,
    rate,
    'cbr',
    `${requestedDate}T01:00:00.000Z`,
    `${requestedDate}T23:59:59.000Z`,
    1,
    `${requestedDate}T01:00:00.000Z`,
  );
}

function seedCanonicalProductImage(db, {
  shopId = 'shop-profile-maintenance-image',
  identityId = 'identity-profile-maintenance-image',
  productId = 'product-image-1',
  offerId = 'offer-image-1',
  imageUrl = 'https://example.invalid/canonical-image.jpg',
  observedAt = '2026-07-16T01:00:00.000Z',
  identityRowHash = '1'.repeat(64),
  imageRowHash = '2'.repeat(64),
} = {}) {
  db.prepare('INSERT OR IGNORE INTO shops (id, name, status) VALUES (?, ?, ?)')
    .run(shopId, 'Profile maintenance image shop', 'active');
  db.prepare(`
    INSERT INTO product_identities (
      product_identity_id, shop_id, product_id, offer_id, source,
      mapper_version, observed_at, row_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'ozon', 'identity-v1', ?, ?, ?, ?)
  `).run(
    identityId,
    shopId,
    productId,
    offerId,
    observedAt,
    identityRowHash,
    observedAt,
    observedAt,
  );
  db.prepare(`
    INSERT INTO product_image_facts (
      product_identity_id, shop_id, image_index, image_url, is_primary,
      mapper_version, observed_at, row_hash, updated_at
    ) VALUES (?, ?, 0, ?, 1, 'image-v1', ?, ?, ?)
  `).run(identityId, shopId, imageUrl, observedAt, imageRowHash, observedAt);
  return { identityId, imageUrl, observedAt, offerId, productId, shopId };
}

function seedCachedProductImageHealth(db, {
  shopId,
  imageUrl,
  status = 'healthy',
} = {}) {
  db.prepare(`
    INSERT INTO product_image_health (
      id, shop_id, product_key, product_id, offer_id, image_url, status,
      http_status, source, checked_at, raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 200, 'old-http-check', ?, '{}', ?, ?)
  `).run(
    `old-health:${shopId}`,
    shopId,
    'old-product-key',
    'old-product-id',
    'old-offer-id',
    imageUrl,
    status,
    '2026-07-15T01:00:00.000Z',
    '2026-07-15T01:00:00.000Z',
    '2026-07-15T01:00:00.000Z',
  );
}

function exchangeRateReplacementRows() {
  return [{
    requested_date: '2026-07-16',
    mode: 'exact',
    rate_date: '2026-07-16',
    nearest_fallback: 0,
    lookback_days_used: 0,
    rub_to_cny_rate: 0.092,
    source: 'cbr',
    fetched_at: '2026-07-16T01:00:00.000Z',
    expires_at: '2026-07-16T23:59:59.000Z',
    immutable: 1,
    updated_at: '2026-07-16T01:00:00.000Z',
  }];
}

function createExchangeRateTrustedAdapter({ proofId = 'unit-proof-20260716' } = {}) {
  return Object.freeze({
    adapterId: 'unit.exchange-rate.persisted-sync',
    source: 'external',
    readVerifiedCandidate() {
      return {
        rows: exchangeRateReplacementRows(),
        evidence: {
          contractVersion: PROFILE_DOMAIN_REBUILD_PROOF_VERSION,
          domain: 'exchange-rate-cache',
          source: 'external',
          proofId,
          observedAt: '2026-07-16T01:01:00.000Z',
          verificationKind: 'persisted-successful-sync-proof',
        },
      };
    },
  });
}

function releasePreview(service) {
  return service.preview({ command: PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE });
}

function releaseConfirm(service, preview) {
  return service.confirm({
    command: PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE,
    confirmation: PROFILE_MAINTENANCE_CONFIRMATIONS[PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE],
    humanConfirmationToken: preview.humanConfirmationToken,
  });
}

test('release-space executes only unified-registry ordinary SQLite resources and preserves protected state', () => {
  const db = createMigratedTestDb();
  try {
    seedProtectedSetting(db);
    seedOrdinaryCaches(db);
    const service = createProfileMaintenanceCommandService({ db });
    const contracts = service.listContracts();
    assert.deepEqual(
      contracts.commands['release-space'].targetResourceIds,
      ['registry:response-cache', 'registry:catalog-cache-keys'],
    );
    assert.equal(
      contracts.commands['release-space'].deferredNonSqliteResourceIds
        .includes('memory:local-api-hot-cache-l1'),
      true,
    );

    const preview = releasePreview(service);
    assert.equal(preview.requiresHumanConfirmation, true);
    assert.equal(preview.targetRows, 2);
    assert.deepEqual(
      preview.targetResources.map((entry) => entry.resourceId),
      ['registry:response-cache', 'registry:catalog-cache-keys'],
    );
    assert.deepEqual(
      preview.registryBoundary.executableResourceIds,
      ['registry:response-cache', 'registry:catalog-cache-keys'],
    );
    assert.throws(
      () => service.confirm({
        command: PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE,
        humanConfirmationToken: preview.humanConfirmationToken,
      }),
      (error) => error.code === 'PROFILE_MAINTENANCE_CONFIRMATION_REQUIRED',
    );

    const result = releaseConfirm(service, preview);
    assert.equal(result.completed, true);
    assert.equal(result.releasedRows, 2);
    assert.equal(result.protectedDigestBefore, result.protectedDigestAfter);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM ozon_response_cache').get().total, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM ozon_cache_keys').get().total, 0);
    assert.equal(db.prepare('SELECT value_json FROM profile_settings WHERE namespace = ?').get('unit.protected').value_json, '{"keep":true}');
  } finally {
    db.close();
  }
});

test('release-space rejects a stale preview without reverting the newer protected write', () => {
  const db = createMigratedTestDb();
  try {
    seedOrdinaryCaches(db);
    const service = createProfileMaintenanceCommandService({ db });
    const preview = releasePreview(service);
    seedProtectedSetting(db, 'unit.after-preview');
    assert.throws(
      () => releaseConfirm(service, preview),
      (error) => error.code === 'PROFILE_MAINTENANCE_PREVIEW_STALE' && error.rollbackVerified === true,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM ozon_response_cache').get().total, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM ozon_cache_keys').get().total, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM profile_settings WHERE namespace = ?').get('unit.after-preview').total, 1);
  } finally {
    db.close();
  }
});

test('release-space rolls back target deletion when protected fingerprint drifts inside the lock', () => {
  const db = createMigratedTestDb();
  try {
    seedOrdinaryCaches(db);
    const service = createProfileMaintenanceCommandService({
      db,
      testHooks: {
        afterMutation({ db: lockedDb }) {
          seedProtectedSetting(lockedDb, 'unit.illegal-drift');
        },
      },
    });
    const preview = releasePreview(service);
    assert.throws(
      () => releaseConfirm(service, preview),
      (error) => error.code === 'PROFILE_MAINTENANCE_PROTECTED_DATA_CHANGED'
        && error.rollbackVerified === true,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM ozon_response_cache').get().total, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM ozon_cache_keys').get().total, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM profile_settings WHERE namespace = ?').get('unit.illegal-drift').total, 0);
  } finally {
    db.close();
  }
});

test('rebuild-domain fails closed when no trusted local-api source adapter is registered', () => {
  const db = createMigratedTestDb();
  try {
    const service = createProfileMaintenanceCommandService({ db });
    const contract = service.listContracts().commands['rebuild-domain'];
    assert.equal(contract.targetDomains.includes('exchange-rate-cache'), false);
    assert.equal(contract.registeredButUnavailableDomains.includes('exchange-rate-cache'), true);
    assert.throws(
      () => service.preview({
        command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
        domain: 'exchange-rate-cache',
      }),
      (error) => error.code === 'PROFILE_MAINTENANCE_TRUSTED_SOURCE_UNAVAILABLE',
    );
  } finally {
    db.close();
  }
});

test('rebuild-domain proves staging before atomically replacing canonical rows', () => {
  const db = createMigratedTestDb();
  try {
    seedProtectedSetting(db);
    seedExchangeRate(db);
    const service = createProfileMaintenanceCommandService({
      db,
      trustedRebuildSourceAdapters: {
        'exchange-rate-cache': createExchangeRateTrustedAdapter(),
      },
    });
    const preview = service.preview({
      command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
      domain: 'exchange-rate-cache',
    });
    assert.equal(preview.trustedSource.callerSuppliedProofAccepted, false);
    const trusted = service.issueTrustedRebuildTicket({
      domain: 'exchange-rate-cache',
      humanConfirmationToken: preview.humanConfirmationToken,
    });
    const result = service.confirm({
      command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
      domain: 'exchange-rate-cache',
      confirmation: PROFILE_MAINTENANCE_CONFIRMATIONS[PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN],
      humanConfirmationToken: preview.humanConfirmationToken,
      trustedSourceTicket: trusted.trustedSourceTicket,
    });
    assert.equal(result.activation.stagedProofVerifiedBeforeActivation, true);
    assert.equal(result.activation.oldCanonicalPreservedUntilProofActivation, true);
    assert.equal(result.activation.activatedAtomically, true);
    assert.equal(result.activation.trustedSource.adapterId, 'unit.exchange-rate.persisted-sync');
    assert.equal(result.activation.trustedSource.callerSuppliedProofAccepted, false);
    assert.equal(result.protectedDigestBefore, result.protectedDigestAfter);
    const activated = db.prepare('SELECT requested_date, rub_to_cny_rate FROM exchange_rate_cache').get();
    assert.equal(activated.requested_date, '2026-07-16');
    assert.equal(activated.rub_to_cny_rate, 0.092);
  } finally {
    db.close();
  }
});

test('rebuild-domain restores the old canonical snapshot when post-activation protected readback drifts', () => {
  const db = createMigratedTestDb();
  try {
    seedExchangeRate(db);
    const service = createProfileMaintenanceCommandService({
      db,
      trustedRebuildSourceAdapters: {
        'exchange-rate-cache': createExchangeRateTrustedAdapter({
          proofId: 'unit-rollback-proof-20260716',
        }),
      },
      testHooks: {
        afterMutation({ db: lockedDb }) {
          seedProtectedSetting(lockedDb, 'unit.rebuild-illegal-drift');
        },
      },
    });
    const preview = service.preview({
      command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
      domain: 'exchange-rate-cache',
    });
    const trusted = service.issueTrustedRebuildTicket({
      domain: 'exchange-rate-cache',
      humanConfirmationToken: preview.humanConfirmationToken,
    });
    assert.throws(
      () => service.confirm({
        command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
        domain: 'exchange-rate-cache',
        confirmation: PROFILE_MAINTENANCE_CONFIRMATIONS[PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN],
        humanConfirmationToken: preview.humanConfirmationToken,
        trustedSourceTicket: trusted.trustedSourceTicket,
      }),
      (error) => error.code === 'PROFILE_MAINTENANCE_PROTECTED_DATA_CHANGED'
        && error.rollbackVerified === true,
    );
    const restored = db.prepare('SELECT requested_date, rub_to_cny_rate FROM exchange_rate_cache').get();
    assert.equal(restored.requested_date, '2026-07-15');
    assert.equal(restored.rub_to_cny_rate, 0.091);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS total FROM profile_settings WHERE namespace = ?')
        .get('unit.rebuild-illegal-drift').total,
      0,
    );
  } finally {
    db.close();
  }
});

test('rebuild-domain rejects replay of an already consumed trusted-source ticket', () => {
  const db = createMigratedTestDb();
  try {
    seedExchangeRate(db);
    const service = createProfileMaintenanceCommandService({
      db,
      trustedRebuildSourceAdapters: {
        'exchange-rate-cache': createExchangeRateTrustedAdapter({ proofId: 'unit-replay-proof-20260716' }),
      },
    });
    const preview = service.preview({
      command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
      domain: 'exchange-rate-cache',
    });
    const trusted = service.issueTrustedRebuildTicket({
      domain: 'exchange-rate-cache',
      humanConfirmationToken: preview.humanConfirmationToken,
    });
    const confirmation = {
      command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
      domain: 'exchange-rate-cache',
      confirmation: PROFILE_MAINTENANCE_CONFIRMATIONS[PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN],
      humanConfirmationToken: preview.humanConfirmationToken,
      trustedSourceTicket: trusted.trustedSourceTicket,
    };
    assert.equal(service.confirm(confirmation).completed, true);
    assert.throws(
      () => service.confirm(confirmation),
      (error) => error.code === 'PROFILE_MAINTENANCE_TRUSTED_SOURCE_TICKET_REPLAYED',
    );
  } finally {
    db.close();
  }
});

test('production product-image-health adapter rebuilds only from canonical product image facts', () => {
  const db = createMigratedTestDb();
  try {
    const source = seedCanonicalProductImage(db);
    seedCanonicalProductImage(db, {
      shopId: source.shopId,
      identityId: 'identity-profile-maintenance-image-2',
      productId: 'product-image-2',
      offerId: 'offer-image-2',
      imageUrl: source.imageUrl,
      identityRowHash: '4'.repeat(64),
      imageRowHash: '5'.repeat(64),
    });
    seedCachedProductImageHealth(db, source);
    const service = createProfileMaintenanceCommandService({
      db,
      trustedRebuildSourceAdapters: createProfileMaintenanceTrustedRebuildSourceAdapters({
        db,
        now: () => Date.parse('2026-07-16T01:05:00.000Z'),
      }),
    });
    const contract = service.listContracts().commands['rebuild-domain'];
    assert.deepEqual(contract.targetDomains, ['product-image-health']);
    assert.equal(
      contract.trustedSourceAdapters[0].adapterId,
      'local-api.product-image-health.canonical-product-facts-v1',
    );
    assert.equal(contract.registeredButUnavailableDomains.includes('exchange-rate-cache'), true);
    assert.equal(
      contract.unavailableDomains.find((entry) => entry.domain === 'exchange-rate-cache').reason.code,
      'PERSISTED_EXTERNAL_SYNC_PROOF_MISSING',
    );

    const preview = service.preview({
      command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
      domain: 'product-image-health',
    });
    const trusted = service.issueTrustedRebuildTicket({
      domain: 'product-image-health',
      humanConfirmationToken: preview.humanConfirmationToken,
    });
    const retried = service.issueTrustedRebuildTicket({
      domain: 'product-image-health',
      humanConfirmationToken: preview.humanConfirmationToken,
    });
    assert.equal(retried.trustedSourceTicket, trusted.trustedSourceTicket);
    assert.equal(trusted.rowCount, 1);
    assert.match(trusted.proofId, /^canonical-product-images:/u);

    const result = service.confirm({
      command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
      domain: 'product-image-health',
      confirmation: PROFILE_MAINTENANCE_CONFIRMATIONS[PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN],
      humanConfirmationToken: preview.humanConfirmationToken,
      trustedSourceTicket: trusted.trustedSourceTicket,
    });
    assert.equal(result.activation.activatedSnapshot.rows, 1);
    assert.equal(result.activation.stagedSnapshot.rowsSha256, result.activation.activatedSnapshot.rowsSha256);
    const rebuilt = db.prepare('SELECT * FROM product_image_health').get();
    assert.equal(rebuilt.shop_id, source.shopId);
    assert.equal(rebuilt.image_url, source.imageUrl);
    assert.equal(rebuilt.product_key, 'product:product-image-1');
    assert.equal(rebuilt.status, 'unknown');
    assert.equal(rebuilt.http_status, null);
    assert.equal(rebuilt.checked_at, null);
    assert.equal(rebuilt.source, 'canonical-product-image-facts');
    assert.equal(
      db.prepare('SELECT row_hash FROM product_image_facts WHERE product_identity_id = ?').get(source.identityId).row_hash,
      '2'.repeat(64),
    );
  } finally {
    db.close();
  }
});

test('production rebuild ticket is bound to the preview source snapshot and preserves old cache on drift', () => {
  const db = createMigratedTestDb();
  try {
    const source = seedCanonicalProductImage(db);
    seedCachedProductImageHealth(db, source);
    const service = createProfileMaintenanceCommandService({
      db,
      trustedRebuildSourceAdapters: createProfileMaintenanceTrustedRebuildSourceAdapters({ db }),
    });
    const preview = service.preview({
      command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
      domain: 'product-image-health',
    });
    const trusted = service.issueTrustedRebuildTicket({
      domain: 'product-image-health',
      humanConfirmationToken: preview.humanConfirmationToken,
    });
    db.prepare(`
      UPDATE product_image_facts
      SET observed_at = ?, updated_at = ?, row_hash = ?
      WHERE product_identity_id = ?
    `).run(
      '2026-07-16T01:06:00.000Z',
      '2026-07-16T01:06:00.000Z',
      '3'.repeat(64),
      source.identityId,
    );
    assert.throws(
      () => service.confirm({
        command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
        domain: 'product-image-health',
        confirmation: PROFILE_MAINTENANCE_CONFIRMATIONS[PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN],
        humanConfirmationToken: preview.humanConfirmationToken,
        trustedSourceTicket: trusted.trustedSourceTicket,
      }),
      (error) => error.code === 'PROFILE_MAINTENANCE_PREVIEW_STALE'
        && error.rollbackVerified === true,
    );
    const preserved = db.prepare('SELECT status, source FROM product_image_health').get();
    assert.equal(preserved.status, 'healthy');
    assert.equal(preserved.source, 'old-http-check');
  } finally {
    db.close();
  }
});

test('production rebuild rolls back to the old image-health cache after injected activation failure', () => {
  const db = createMigratedTestDb();
  try {
    const source = seedCanonicalProductImage(db);
    seedCachedProductImageHealth(db, source);
    const service = createProfileMaintenanceCommandService({
      db,
      trustedRebuildSourceAdapters: createProfileMaintenanceTrustedRebuildSourceAdapters({ db }),
      testHooks: {
        afterMutation({ db: lockedDb }) {
          seedProtectedSetting(lockedDb, 'unit.product-image-health-illegal-drift');
        },
      },
    });
    const preview = service.preview({
      command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
      domain: 'product-image-health',
    });
    const trusted = service.issueTrustedRebuildTicket({
      domain: 'product-image-health',
      humanConfirmationToken: preview.humanConfirmationToken,
    });
    assert.throws(
      () => service.confirm({
        command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
        domain: 'product-image-health',
        confirmation: PROFILE_MAINTENANCE_CONFIRMATIONS[PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN],
        humanConfirmationToken: preview.humanConfirmationToken,
        trustedSourceTicket: trusted.trustedSourceTicket,
      }),
      (error) => error.code === 'PROFILE_MAINTENANCE_PROTECTED_DATA_CHANGED'
        && error.rollbackVerified === true,
    );
    const preserved = db.prepare('SELECT id, status, source FROM product_image_health').get();
    assert.equal(preserved.id, `old-health:${source.shopId}`);
    assert.equal(preserved.status, 'healthy');
    assert.equal(preserved.source, 'old-http-check');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS total FROM profile_settings WHERE namespace = ?')
        .get('unit.product-image-health-illegal-drift').total,
      0,
    );
  } finally {
    db.close();
  }
});
