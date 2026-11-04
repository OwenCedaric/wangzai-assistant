import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import {
  PROFILE_DOMAIN_REBUILD_PROOF_VERSION,
  createProfileMaintenanceCommandService,
} from '../maintenance/profileMaintenanceCommandService.js';
import { createApp } from './createApp.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function requestJson(baseUrl, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

function seedRouteCanonicalProductImage(db) {
  const shopId = 'route-product-image-shop';
  const identityId = 'route-product-image-identity';
  const imageUrl = 'https://example.invalid/route-canonical-image.jpg';
  const observedAt = '2026-07-16T02:00:00.000Z';
  db.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)')
    .run(shopId, 'Route product image shop', 'active');
  db.prepare(`
    INSERT INTO product_identities (
      product_identity_id, shop_id, product_id, offer_id, source,
      mapper_version, observed_at, row_hash, created_at, updated_at
    ) VALUES (?, ?, 'route-product-id', 'route-offer-id', 'ozon',
      'route-identity-v1', ?, ?, ?, ?)
  `).run(identityId, shopId, observedAt, '4'.repeat(64), observedAt, observedAt);
  db.prepare(`
    INSERT INTO product_image_facts (
      product_identity_id, shop_id, image_index, image_url, is_primary,
      mapper_version, observed_at, row_hash, updated_at
    ) VALUES (?, ?, 0, ?, 1, 'route-image-v1', ?, ?, ?)
  `).run(identityId, shopId, imageUrl, observedAt, '5'.repeat(64), observedAt);
  db.prepare(`
    INSERT INTO product_image_health (
      id, shop_id, product_key, image_url, status, http_status, source,
      checked_at, raw_json, created_at, updated_at
    ) VALUES (?, ?, 'old-route-key', ?, 'broken', 404, 'old-route-check',
      ?, '{}', ?, ?)
  `).run(
    'old-route-image-health',
    shopId,
    imageUrl,
    '2026-07-15T02:00:00.000Z',
    '2026-07-15T02:00:00.000Z',
    '2026-07-15T02:00:00.000Z',
  );
  return { identityId, imageUrl, shopId };
}

test('createApp exposes separate preview/confirm release-space command and rejects permanent-delete', async () => {
  const db = createMigratedTestDb();
  db.prepare(`
    INSERT INTO ozon_response_cache
      (id, domain, endpoint_key, cache_key, status, is_stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'route-response',
    'products',
    'product.info.list',
    'route-cache-key',
    'confirmed',
    0,
    '2026-07-16T00:00:00.000Z',
  );
  db.prepare(`
    INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('route.protected', '{"keep":true}', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
  const server = createApp({
    db,
    config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: Date.now(),
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const contracts = await requestJson(baseUrl, '/api/app/profile-maintenance/contracts');
    assert.equal(contracts.response.status, 200);
    assert.deepEqual(
      contracts.payload.commands['release-space'].targetResourceIds,
      ['registry:response-cache', 'registry:catalog-cache-keys'],
    );

    const forbidden = await requestJson(baseUrl, '/api/app/profile-maintenance/preview', {
      method: 'POST',
      body: { command: 'permanent-delete' },
    });
    assert.equal(forbidden.response.status, 400);
    assert.equal(forbidden.payload.error.code, 'PROFILE_MAINTENANCE_COMMAND_BOUNDARY');

    const preview = await requestJson(baseUrl, '/api/app/profile-maintenance/preview', {
      method: 'POST',
      body: { command: 'release-space' },
    });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.payload.requiresHumanConfirmation, true);
    assert.equal(preview.payload.targetRows, 1);

    const confirm = await requestJson(baseUrl, '/api/app/profile-maintenance/confirm', {
      method: 'POST',
      body: {
        command: 'release-space',
        confirmation: 'RELEASE_RETIRED_PROFILE_SPACE_ONLY',
        humanConfirmationToken: preview.payload.humanConfirmationToken,
      },
    });
    assert.equal(confirm.response.status, 200);
    assert.equal(confirm.payload.completed, true);
    assert.equal(confirm.payload.lock.heldThroughReadback, true);
    assert.equal(confirm.payload.protectedDigestBefore, confirm.payload.protectedDigestAfter);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM ozon_response_cache').get().total, 0);
    assert.equal(db.prepare('SELECT value_json FROM profile_settings WHERE namespace = ?').get('route.protected').value_json, '{"keep":true}');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('HTTP caller cannot forge rebuild rows and a self-computed proof', async () => {
  const db = createMigratedTestDb();
  db.prepare(`
    INSERT INTO exchange_rate_cache
      (requested_date, mode, rate_date, nearest_fallback, lookback_days_used,
       rub_to_cny_rate, source, fetched_at, expires_at, immutable, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    '2026-07-15',
    'exact',
    '2026-07-15',
    0,
    0,
    0.091,
    'cbr',
    '2026-07-15T01:00:00.000Z',
    '2026-07-15T23:59:59.000Z',
    1,
    '2026-07-15T01:00:00.000Z',
  );
  const profileMaintenanceCommandService = createProfileMaintenanceCommandService({
    db,
    trustedRebuildSourceAdapters: {
      'exchange-rate-cache': {
        adapterId: 'route.exchange-rate.persisted-sync',
        source: 'external',
        readVerifiedCandidate() {
          throw new Error('HTTP route must not invoke internal ticket issuance');
        },
      },
    },
  });
  const server = createApp({
    db,
    config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: Date.now(),
    profileMaintenanceCommandService,
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const preview = await requestJson(baseUrl, '/api/app/profile-maintenance/preview', {
      method: 'POST',
      body: { command: 'rebuild-domain', domain: 'exchange-rate-cache' },
    });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.payload.trustedSource.callerSuppliedProofAccepted, false);

    const forged = await requestJson(baseUrl, '/api/app/profile-maintenance/confirm', {
      method: 'POST',
      body: {
        command: 'rebuild-domain',
        domain: 'exchange-rate-cache',
        confirmation: 'REBUILD_ONE_PROFILE_DOMAIN_FROM_SOURCE_ONLY',
        humanConfirmationToken: preview.payload.humanConfirmationToken,
        replacementRows: [{ requested_date: 'attacker-controlled' }],
        proof: {
          contractVersion: PROFILE_DOMAIN_REBUILD_PROOF_VERSION,
          domain: 'exchange-rate-cache',
          source: 'external',
          proofId: 'forged-http-proof',
          observedAt: '2026-07-16T01:00:00.000Z',
          rowCount: 1,
          rowsSha256: 'caller-computed-hash',
        },
      },
    });
    assert.equal(forged.response.status, 400);
    assert.equal(forged.payload.error.code, 'PROFILE_MAINTENANCE_CALLER_SUPPLIED_PROOF_FORBIDDEN');
    const preserved = db.prepare('SELECT requested_date, rub_to_cny_rate FROM exchange_rate_cache').get();
    assert.equal(preserved.requested_date, '2026-07-15');
    assert.equal(preserved.rub_to_cny_rate, 0.091);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('production route completes preview, internal prepare-ticket, confirm and readback', async () => {
  const db = createMigratedTestDb();
  const source = seedRouteCanonicalProductImage(db);
  const server = createApp({
    db,
    config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: Date.now(),
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const contracts = await requestJson(baseUrl, '/api/app/profile-maintenance/contracts');
    assert.deepEqual(
      contracts.payload.commands['rebuild-domain'].targetDomains,
      ['product-image-health'],
    );

    const preview = await requestJson(baseUrl, '/api/app/profile-maintenance/preview', {
      method: 'POST',
      body: { command: 'rebuild-domain', domain: 'product-image-health' },
    });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.payload.trustedSource.ticketIssuance, 'local-api-internal-only');

    const forgedTicket = await requestJson(baseUrl, '/api/app/profile-maintenance/prepare-ticket', {
      method: 'POST',
      body: {
        domain: 'product-image-health',
        humanConfirmationToken: preview.payload.humanConfirmationToken,
        replacementRows: [{ status: 'attacker-controlled' }],
      },
    });
    assert.equal(forgedTicket.response.status, 400);
    assert.equal(
      forgedTicket.payload.error.code,
      'PROFILE_MAINTENANCE_CALLER_SUPPLIED_PROOF_FORBIDDEN',
    );

    const prepared = await requestJson(baseUrl, '/api/app/profile-maintenance/prepare-ticket', {
      method: 'POST',
      body: {
        domain: 'product-image-health',
        humanConfirmationToken: preview.payload.humanConfirmationToken,
      },
    });
    assert.equal(prepared.response.status, 200);
    assert.equal(prepared.payload.ok, true);
    assert.equal(prepared.payload.rowCount, 1);
    assert.equal(
      prepared.payload.adapterId,
      'local-api.product-image-health.canonical-product-facts-v1',
    );
    assert.equal(typeof prepared.payload.trustedSourceTicket, 'string');
    assert.equal(Object.hasOwn(prepared.payload, 'rows'), false);

    const confirm = await requestJson(baseUrl, '/api/app/profile-maintenance/confirm', {
      method: 'POST',
      body: {
        command: 'rebuild-domain',
        domain: 'product-image-health',
        confirmation: 'REBUILD_ONE_PROFILE_DOMAIN_FROM_SOURCE_ONLY',
        humanConfirmationToken: preview.payload.humanConfirmationToken,
        trustedSourceTicket: prepared.payload.trustedSourceTicket,
      },
    });
    assert.equal(confirm.response.status, 200);
    assert.equal(confirm.payload.completed, true);
    assert.equal(
      confirm.payload.activation.stagedSnapshot.rowsSha256,
      confirm.payload.activation.activatedSnapshot.rowsSha256,
    );
    const rebuilt = db.prepare('SELECT * FROM product_image_health').get();
    assert.equal(rebuilt.shop_id, source.shopId);
    assert.equal(rebuilt.image_url, source.imageUrl);
    assert.equal(rebuilt.status, 'unknown');
    assert.equal(rebuilt.source, 'canonical-product-image-facts');
    assert.equal(
      db.prepare('SELECT row_hash FROM product_image_facts WHERE product_identity_id = ?')
        .get(source.identityId).row_hash,
      '5'.repeat(64),
    );

    const replay = await requestJson(baseUrl, '/api/app/profile-maintenance/confirm', {
      method: 'POST',
      body: {
        command: 'rebuild-domain',
        domain: 'product-image-health',
        confirmation: 'REBUILD_ONE_PROFILE_DOMAIN_FROM_SOURCE_ONLY',
        humanConfirmationToken: preview.payload.humanConfirmationToken,
        trustedSourceTicket: prepared.payload.trustedSourceTicket,
      },
    });
    assert.equal(replay.response.status, 409);
    assert.equal(
      replay.payload.error.code,
      'PROFILE_MAINTENANCE_TRUSTED_SOURCE_TICKET_REPLAYED',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
