import { randomUUID } from 'node:crypto';
import { createStableHash } from '../../utils/stableHash.js';

export const DEFAULT_PROFILE_ID = 'default';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeProfileId(value) {
  return normalizeText(value) || DEFAULT_PROFILE_ID;
}

export function normalizeOzonExternalIdentity(value) {
  return normalizeText(value).toLocaleLowerCase('en-US');
}

export function createExternalOzonIdentityHash(clientId) {
  const identity = normalizeOzonExternalIdentity(clientId);
  if (!identity) return null;
  return createStableHash({ platform: 'ozon', identityType: 'client_id', identity });
}

export function createShopIncarnation() {
  return `inc_${randomUUID()}`;
}

export class ShopIdentityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ShopIdentityError';
    this.code = code;
  }
}

function fail(code) {
  throw new ShopIdentityError(code);
}

function toIdentity(row) {
  if (!row) return null;
  return Object.freeze({
    profileId: row.profile_id,
    shopId: row.id,
    externalIdentityHash: row.external_identity_hash || null,
    shopIncarnation: row.shop_incarnation,
    credentialRevision: Number(row.credential_revision),
    status: row.status,
    boundAt: row.bound_at || null,
    disabledAt: row.disabled_at || null,
  });
}

/**
 * SQL migration 058 cannot calculate SHA-256 with stock SQLite. This guarded
 * repository backfill runs immediately after migrations. Ambiguous legacy
 * duplicates stay unassigned instead of being guessed; all future writes still
 * reject them because availability checks hash the stored client ids in memory.
 */
export function backfillShopExternalIdentityHashes(db) {
  const rows = db.prepare(`
    SELECT id, profile_id, client_id, external_identity_hash
    FROM shops
    WHERE client_id IS NOT NULL AND trim(client_id) <> ''
    ORDER BY profile_id ASC, created_at ASC, id ASC
  `).all();
  const groups = new Map();
  rows.forEach((row) => {
    const hash = createExternalOzonIdentityHash(row.client_id);
    if (!hash) return;
    const key = `${normalizeProfileId(row.profile_id)}\u0000${hash}`;
    const group = groups.get(key) || [];
    group.push({ ...row, hash });
    groups.set(key, group);
  });

  const update = db.prepare('UPDATE shops SET external_identity_hash = ? WHERE id = ?');
  let updatedCount = 0;
  const conflicts = [];
  const desired = [];
  groups.forEach((group) => {
    if (group.length === 1) {
      const row = group[0];
      desired.push({ ...row, desiredHash: row.hash });
      return;
    }
    const canonical = group.find((row) => row.external_identity_hash === row.hash) || null;
    group.forEach((row) => {
      desired.push({ ...row, desiredHash: canonical?.id === row.id ? row.hash : null });
    });
    conflicts.push(Object.freeze({
      profileId: normalizeProfileId(group[0].profile_id),
      externalIdentityHash: group[0].hash,
      shopIds: Object.freeze(group.map((row) => row.id)),
    }));
  });
  // Clear stale/corrupt values first so a value currently occupying another
  // row's correct hash cannot make the deterministic assignment order fail.
  desired.forEach((row) => {
    if (row.external_identity_hash && row.external_identity_hash !== row.desiredHash) {
      update.run(null, row.id);
      updatedCount += 1;
    }
  });
  desired.forEach((row) => {
    if (row.desiredHash && row.external_identity_hash !== row.desiredHash) {
      update.run(row.desiredHash, row.id);
      updatedCount += 1;
    }
  });
  return Object.freeze({ updatedCount, conflicts: Object.freeze(conflicts) });
}

export function createShopIdentityRepository(db, options = {}) {
  const profileId = normalizeProfileId(options.profileId);
  const backfill = options.skipBackfill
    ? Object.freeze({ updatedCount: 0, conflicts: Object.freeze([]) })
    : backfillShopExternalIdentityHashes(db);

  const selectIdentitySql = `
    SELECT id, profile_id, external_identity_hash, shop_incarnation,
           credential_revision, status, bound_at, disabled_at
    FROM shops
  `;

  function getRowById(shopId) {
    const id = normalizeText(shopId);
    return id ? db.prepare(`${selectIdentitySql} WHERE id = ?`).get(id) || null : null;
  }

  function getScopedRow(shopId, requestedProfileId = profileId) {
    const row = getRowById(shopId);
    if (!row) return null;
    if (row.profile_id !== normalizeProfileId(requestedProfileId)) fail('SHOP_SCOPE_FORBIDDEN');
    return row;
  }

  function assertExternalIdentityAvailable(input = {}) {
    const requestedProfileId = normalizeProfileId(input.profileId ?? profileId);
    const externalIdentityHash = input.externalIdentityHash
      || createExternalOzonIdentityHash(input.clientId);
    if (!externalIdentityHash) return null;
    const excludeShopId = normalizeText(input.excludeShopId);
    const rows = db.prepare(`
      SELECT id, client_id, external_identity_hash
      FROM shops
      WHERE profile_id = ? AND id <> ?
    `).all(requestedProfileId, excludeShopId);
    const duplicate = rows.find((row) => (
      row.external_identity_hash === externalIdentityHash
      || createExternalOzonIdentityHash(row.client_id) === externalIdentityHash
    ));
    if (duplicate) fail('SHOP_EXTERNAL_IDENTITY_ALREADY_BOUND');
    return externalIdentityHash;
  }

  function assertCurrentScopeToken(input = {}, assertionOptions = {}) {
    const requestedProfileId = normalizeProfileId(input.profileId ?? profileId);
    const shopId = normalizeText(input.shopId ?? input.id);
    const shopIncarnation = normalizeText(input.shopIncarnation ?? input.shop_incarnation);
    const credentialRevision = Number(input.credentialRevision ?? input.credential_revision);
    if (!shopId || !shopIncarnation || !Number.isSafeInteger(credentialRevision) || credentialRevision < 1) {
      fail('SHOP_SCOPE_TOKEN_INVALID');
    }
    const row = getRowById(shopId);
    if (!row) fail('SHOP_SCOPE_NOT_FOUND');
    if (row.profile_id !== requestedProfileId) fail('SHOP_SCOPE_FORBIDDEN');
    if (row.shop_incarnation !== shopIncarnation) fail('SHOP_INCARNATION_STALE');
    if (Number(row.credential_revision) !== credentialRevision) fail('SHOP_CREDENTIAL_REVISION_STALE');
    if (row.disabled_at || row.status === 'disabled') fail('SHOP_BINDING_DISABLED');
    if (assertionOptions.requireActive !== false && row.status !== 'active') fail('SHOP_BINDING_NOT_ACTIVE');
    return toIdentity(row);
  }

  return Object.freeze({
    profileId,
    backfill,

    getIdentity(shopId, requestedProfileId = profileId) {
      return toIdentity(getScopedRow(shopId, requestedProfileId));
    },

    createScopeToken(shopId, requestedProfileId = profileId) {
      const identity = toIdentity(getScopedRow(shopId, requestedProfileId));
      if (!identity) fail('SHOP_SCOPE_NOT_FOUND');
      return Object.freeze({
        profileId: identity.profileId,
        shopId: identity.shopId,
        shopIncarnation: identity.shopIncarnation,
        credentialRevision: identity.credentialRevision,
      });
    },

    assertExternalIdentityAvailable,
    assertCurrentScopeToken,

    refreshExternalIdentityBackfill() {
      return backfillShopExternalIdentityHashes(db);
    },
  });
}
