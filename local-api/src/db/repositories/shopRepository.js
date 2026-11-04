import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../security/secretCrypto.js';
import { createSavedSecretHint } from '../../security/secretPresentation.js';
import { createStableHash } from '../../utils/stableHash.js';
import { normalizeProfileSettingValue } from './profileSettingsRepository.js'; import { createExternalOzonIdentityHash, createShopIdentityRepository, createShopIncarnation, normalizeProfileId, ShopIdentityError } from './shopIdentityRepository.js';

const VALID_STATUSES = new Set(['inactive', 'active', 'disabled', 'error']);
const LEGACY_OZON_SHOP_PREFERENCES_NAMESPACE = 'ozon-shop-preferences';
const LEGACY_OZON_SHOP_INPUT_FIELDS = new Set(['id', 'name', 'alias', 'status', 'clientId', 'apiKey']);
const LEGACY_OZON_SHOP_PREFERENCE_FORBIDDEN_FIELDS = new Set([
  'clientId',
  'client_id',
  'apiKey',
  'api_key',
  'hasClientId',
  'hasApiKey',
  'apiKeyHint',
]);
const DEFAULT_TENANT_ID = 'tenant_local_default';
const DEFAULT_USER_ID = 'user_local_default';

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeOptionalText(value) {
  const text = normalizeText(value);
  return text || null;
}

function normalizeStatus(value) {
  const status = normalizeText(value) || 'inactive';
  return VALID_STATUSES.has(status) ? status : 'inactive';
}

function createShopId() {
  return `shop_${randomUUID()}`;
}

function normalizeEncryptedSecret(value) {
  const secret = normalizeText(value);
  if (!secret) {
    return null;
  }
  return isEncryptedSecret(secret) ? secret : encryptSecret(secret);
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

function encodeLegacyShopCursor(shop = {}) {
  return Buffer.from(JSON.stringify({ id: normalizeText(shop.id) }), 'utf8').toString('base64url');
}

function decodeLegacyShopCursor(value) {
  const text = normalizeText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    const id = normalizeText(parsed?.id);
    return id || null;
  } catch {
    return null;
  }
}

function toPublicShop(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    alias: row.alias || '',
    status: row.status || 'inactive',
    clientId: row.client_id || '',
    hasClientId: Boolean(row.client_id),
    hasApiKey: Boolean(row.api_key_encrypted),
    apiKeyHint: createSavedSecretHint(row.api_key_encrypted),
    profileId: row.profile_id,
    shopIncarnation: row.shop_incarnation,
    credentialRevision: Number(row.credential_revision),
    boundAt: row.bound_at || null,
    disabledAt: row.disabled_at || null,
    ozonPushBindingId: row.ozon_push_binding_id || '',
    ozonPushBindingMode: row.ozon_push_binding_mode || '',
    ozonPushPublicBaseUrl: row.ozon_push_public_base_url || '',
    ozonPushStatus: row.ozon_push_status || '',
    ozonPushCreatedAt: row.ozon_push_created_at || null,
    ozonPushRotatedAt: row.ozon_push_rotated_at || null,
    ozonPushLastReceivedAt: row.ozon_push_last_received_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeShopInput(input = {}, existing = null) {
  const name = normalizeText(input.name ?? existing?.name);

  if (!name) {
    throw new Error('Shop name is required.');
  }

  const hasApiKeyField = Object.prototype.hasOwnProperty.call(input, 'apiKeyEncrypted') || Object.prototype.hasOwnProperty.call(input, 'apiKey');
  const apiKeyCandidate = input.apiKeyEncrypted ?? input.apiKey;

  return {
    id: normalizeText(input.id ?? existing?.id) || createShopId(),
    name,
    alias: normalizeOptionalText(input.alias ?? existing?.alias),
    client_id: normalizeOptionalText(input.clientId ?? input.client_id ?? existing?.client_id),
    api_key_encrypted: hasApiKeyField ? normalizeEncryptedSecret(apiKeyCandidate) : existing?.api_key_encrypted || null,
    status: normalizeStatus(input.status ?? existing?.status),
    ozon_push_binding_id: normalizeOptionalText(input.ozonPushBindingId ?? existing?.ozon_push_binding_id),
    ozon_push_binding_mode: normalizeOptionalText(input.ozonPushBindingMode ?? existing?.ozon_push_binding_mode),
    ozon_push_public_base_url: normalizeOptionalText(
      input.ozonPushPublicBaseUrl ?? existing?.ozon_push_public_base_url,
    ),
    ozon_push_status: normalizeOptionalText(input.ozonPushStatus ?? existing?.ozon_push_status),
    ozon_push_created_at: normalizeOptionalText(input.ozonPushCreatedAt ?? existing?.ozon_push_created_at),
    ozon_push_rotated_at: normalizeOptionalText(input.ozonPushRotatedAt ?? existing?.ozon_push_rotated_at),
    ozon_push_last_received_at: normalizeOptionalText(
      input.ozonPushLastReceivedAt ?? existing?.ozon_push_last_received_at,
    ),
  };
}

function assertLegacyShopInput(input = {}) {
  assertPlainObject(input, 'SHOP_LEGACY_IMPORT_RECORD_INVALID');
  Object.keys(input).forEach((field) => {
    if (!LEGACY_OZON_SHOP_INPUT_FIELDS.has(field)) {
      throw new Error('SHOP_LEGACY_IMPORT_FIELD_NOT_ALLOWED');
    }
  });
  const id = normalizeText(input.id);
  if (!id) throw new Error('SHOP_LEGACY_IMPORT_ID_REQUIRED');
  const status = normalizeText(input.status);
  if (status && !VALID_STATUSES.has(status)) {
    throw new Error('SHOP_LEGACY_IMPORT_STATUS_INVALID');
  }
  return id;
}

function prepareLegacyOzonShopPreferences(value, shopIds) {
  const preferences = normalizeProfileSettingValue(LEGACY_OZON_SHOP_PREFERENCES_NAMESPACE, value);
  if (Number(preferences.version) !== 1 || !Array.isArray(preferences.shops)) {
    throw new Error('SHOP_LEGACY_IMPORT_PREFERENCES_INVALID');
  }
  const preferenceIds = new Set();
  preferences.shops.forEach((shop) => {
    assertPlainObject(shop, 'SHOP_LEGACY_IMPORT_PREFERENCE_SHOP_INVALID');
    Object.keys(shop).forEach((field) => {
      if (LEGACY_OZON_SHOP_PREFERENCE_FORBIDDEN_FIELDS.has(field)) {
        throw new Error('SHOP_LEGACY_IMPORT_PREFERENCE_SECRET_FIELD');
      }
    });
    const id = normalizeText(shop.id);
    if (!id || preferenceIds.has(id) || !shopIds.has(id)) {
      throw new Error('SHOP_LEGACY_IMPORT_PREFERENCE_SCOPE_INVALID');
    }
    preferenceIds.add(id);
  });
  if (preferenceIds.size !== shopIds.size) {
    throw new Error('SHOP_LEGACY_IMPORT_PREFERENCE_SCOPE_INCOMPLETE');
  }
  const activeShopId = normalizeText(preferences.activeShopId);
  if (!activeShopId || !shopIds.has(activeShopId)) {
    throw new Error('SHOP_LEGACY_IMPORT_ACTIVE_SHOP_INVALID');
  }
  if (
    !preferences.defaultWarehouseIds ||
    typeof preferences.defaultWarehouseIds !== 'object' ||
    Array.isArray(preferences.defaultWarehouseIds)
  ) {
    throw new Error('SHOP_LEGACY_IMPORT_WAREHOUSE_MAP_INVALID');
  }
  Object.keys(preferences.defaultWarehouseIds).forEach((shopId) => {
    if (!shopIds.has(normalizeText(shopId))) {
      throw new Error('SHOP_LEGACY_IMPORT_WAREHOUSE_SCOPE_INVALID');
    }
  });
  return preferences;
}

function toLegacyShopDigestRow(shop = {}) {
  return {
    id: shop.id,
    name: shop.name,
    alias: shop.alias || '',
    status: shop.status || 'inactive',
    hasClientId: Boolean(shop.client_id),
    hasApiKey: Boolean(shop.api_key_encrypted),
  };
}

export function createShopRepository(db, options = {}) {
  const profileId = normalizeProfileId(options.profileId);
  const tenantId = normalizeText(options.tenantId) || DEFAULT_TENANT_ID;
  const userId = normalizeText(options.userId)
    || (profileId && profileId !== 'default' ? profileId : DEFAULT_USER_ID);
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const incarnationFactory = typeof options.createIncarnation === 'function'
    ? options.createIncarnation
    : createShopIncarnation;
  const identityRepository = options.identityRepository || createShopIdentityRepository(db, { profileId });
  const selectSql = `
    SELECT id, name, alias, client_id, api_key_encrypted, status,
           profile_id, tenant_id, user_id, external_identity_hash, shop_incarnation,
           credential_revision, bound_at, disabled_at,
           ozon_push_binding_id, ozon_push_binding_mode, ozon_push_public_base_url,
           ozon_push_status, ozon_push_created_at, ozon_push_rotated_at,
           ozon_push_last_received_at,
           created_at, updated_at
    FROM shops
  `;

  // Rows created before the owner-scope migration inherit the current
  // profile's canonical tenant/user on first repository open.  This keeps an
  // upgraded desktop profile usable while making subsequent request-scoped
  // reads fail closed across users.
  db.prepare(`
    UPDATE shops
    SET tenant_id = ?, user_id = ?
    WHERE profile_id = ?
      AND (trim(COALESCE(tenant_id, '')) IN ('', ?)
        OR trim(COALESCE(user_id, '')) IN ('', ?, ?))
  `).run(tenantId, userId, profileId, DEFAULT_TENANT_ID, DEFAULT_USER_ID, profileId);

  function timestampNow() {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  function getUnscopedShopById(shopId) {
    const id = normalizeText(shopId);
    return id ? db.prepare(`${selectSql} WHERE id = ?`).get(id) || null : null;
  }

  function assertOwnerScope(existing) {
    if (!existing) return;
    if (
      existing.profile_id !== profileId
      || normalizeText(existing.tenant_id) !== tenantId
      || normalizeText(existing.user_id) !== userId
    ) {
      throw new ShopIdentityError('SHOP_SCOPE_FORBIDDEN');
    }
  }

  function assertContextScope(scope = {}) {
    const requestedTenantId = normalizeText(scope.tenantId) || tenantId;
    const requestedUserId = normalizeText(scope.userId) || userId;
    if (requestedTenantId !== tenantId || requestedUserId !== userId) {
      throw new ShopIdentityError('SHOP_SCOPE_FORBIDDEN');
    }
    return { tenantId: requestedTenantId, userId: requestedUserId };
  }

  function decryptForComparison(value) {
    if (!value) return null;
    try {
      return decryptSecret(value);
    } catch {
      return `encrypted:${value}`;
    }
  }

  function prepareStoredShop(input, existing, timestamp, preparationOptions = {}) {
    const hasApiKeyField = Object.prototype.hasOwnProperty.call(input, 'apiKeyEncrypted')
      || Object.prototype.hasOwnProperty.call(input, 'apiKey');
    const shop = normalizeShopInput(input, existing);
    const clientIdChanged = shop.client_id !== (existing?.client_id || null);
    const apiKeyChanged = hasApiKeyField
      ? decryptForComparison(shop.api_key_encrypted) !== decryptForComparison(existing?.api_key_encrypted)
      : false;
    if (existing && hasApiKeyField && !apiKeyChanged) {
      shop.api_key_encrypted = existing.api_key_encrypted || null;
    }
    const credentialsUpdated = clientIdChanged || apiKeyChanged;
    const externalIdentityHash = createExternalOzonIdentityHash(shop.client_id);
    identityRepository.assertExternalIdentityAvailable({
      profileId,
      externalIdentityHash,
      excludeShopId: shop.id,
    });
    const wasReadyForContinuousSync = Boolean(
      existing
      && existing.status === 'active'
      && !existing.disabled_at
      && existing.client_id
      && existing.api_key_encrypted,
    );
    const readyForContinuousSync = Boolean(
      shop.status === 'active' && shop.client_id && shop.api_key_encrypted,
    );
    const rebound = Boolean(
      existing
      && (preparationOptions.forceRebind || existing.status === 'disabled' || existing.disabled_at)
      && readyForContinuousSync,
    );
    const incarnationChanged = !existing || rebound;
    const credentialRevision = existing
      ? Number(existing.credential_revision || 1) + (credentialsUpdated || rebound ? 1 : 0)
      : 1;
    return {
      ...shop,
      profile_id: profileId,
      tenant_id: tenantId,
      user_id: userId,
      external_identity_hash: externalIdentityHash,
      shop_incarnation: incarnationChanged ? incarnationFactory() : existing.shop_incarnation,
      credential_revision: credentialRevision,
      bound_at: rebound
        ? timestamp
        : existing?.bound_at || existing?.created_at || timestamp,
      disabled_at: shop.status === 'disabled'
        ? existing?.disabled_at || timestamp
        : null,
      credentialsUpdated,
      incarnationChanged,
      rebound,
      wasReadyForContinuousSync,
      readyForContinuousSync,
    };
  }

  function persistShop(shop, existing, timestamp) {
    db.prepare(`
      INSERT INTO shops (
        id, name, alias, client_id, api_key_encrypted, status,
        profile_id, tenant_id, user_id, external_identity_hash, shop_incarnation,
        credential_revision, bound_at, disabled_at,
        ozon_push_binding_id, ozon_push_binding_mode, ozon_push_public_base_url,
        ozon_push_status, ozon_push_created_at, ozon_push_rotated_at,
        ozon_push_last_received_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        alias = excluded.alias,
        client_id = excluded.client_id,
        api_key_encrypted = excluded.api_key_encrypted,
        status = excluded.status,
        profile_id = excluded.profile_id,
        tenant_id = excluded.tenant_id,
        user_id = excluded.user_id,
        external_identity_hash = excluded.external_identity_hash,
        shop_incarnation = excluded.shop_incarnation,
        credential_revision = excluded.credential_revision,
        bound_at = excluded.bound_at,
        disabled_at = excluded.disabled_at,
        ozon_push_binding_id = excluded.ozon_push_binding_id,
        ozon_push_binding_mode = excluded.ozon_push_binding_mode,
        ozon_push_public_base_url = excluded.ozon_push_public_base_url,
        ozon_push_status = excluded.ozon_push_status,
        ozon_push_created_at = excluded.ozon_push_created_at,
        ozon_push_rotated_at = excluded.ozon_push_rotated_at,
        ozon_push_last_received_at = excluded.ozon_push_last_received_at,
        updated_at = excluded.updated_at
    `).run(
      shop.id,
      shop.name,
      shop.alias,
      shop.client_id,
      shop.api_key_encrypted,
      shop.status,
      shop.profile_id,
      shop.tenant_id,
      shop.user_id,
      shop.external_identity_hash,
      shop.shop_incarnation,
      shop.credential_revision,
      shop.bound_at,
      shop.disabled_at,
      shop.ozon_push_binding_id,
      shop.ozon_push_binding_mode,
      shop.ozon_push_public_base_url,
      shop.ozon_push_status,
      shop.ozon_push_created_at,
      shop.ozon_push_rotated_at,
      shop.ozon_push_last_received_at,
      existing?.created_at || timestamp,
      timestamp,
    );
  }

  return {
    profileId,
    tenantId,
    userId,
    identityRepository,

    listShops(scope = {}) {
      const { tenantId: scopedTenantId, userId: scopedUserId } = assertContextScope(scope);
      return db
        .prepare(`${selectSql} WHERE profile_id = ? AND tenant_id = ? AND user_id = ? ORDER BY updated_at DESC, name ASC`)
        .all(profileId, scopedTenantId, scopedUserId)
        .map(toPublicShop);
    },

    listShopsForContext(scope = {}) {
      return this.listShops(scope);
    },

    /**
     * Cursor mode is deliberately separate from the normal UI list DTO. It is
     * used only while retiring a large legacy browser source, where a complete
     * page-by-page readback is required before that source may be cleared.
     */
    listShopsPage(query = {}) {
      const cursorText = normalizeText(query.cursor);
      const cursor = cursorText ? decodeLegacyShopCursor(cursorText) : null;
      if (cursorText && !cursor) throw new Error('SHOP_LEGACY_CURSOR_INVALID');
      const limit = Math.min(Math.max(Number(query.limit ?? query.pageSize) || 500, 1), 1000);
      const total = Number(db.prepare('SELECT COUNT(*) AS total FROM shops WHERE profile_id = ? AND tenant_id = ? AND user_id = ?')
        .get(profileId, tenantId, userId).total) || 0;
      const rows = db
        .prepare(
          `
            SELECT id, name, alias, client_id, api_key_encrypted, status,
                   profile_id, tenant_id, user_id, external_identity_hash, shop_incarnation,
                   credential_revision, bound_at, disabled_at,
                   created_at, updated_at
            FROM shops
            WHERE profile_id = ?
              AND tenant_id = ?
              AND user_id = ?
            ${cursor ? 'AND id > ?' : ''}
            ORDER BY id ASC
            LIMIT ?
          `,
        )
        .all(profileId, tenantId, userId, ...(cursor ? [cursor] : []), limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const tail = pageRows.at(-1);
      return {
        ok: true,
        rows: pageRows.map(toPublicShop),
        total,
        hasMore,
        nextCursor: hasMore && tail ? encodeLegacyShopCursor(tail) : '',
      };
    },

    getShopById(shopId) {
      const id = normalizeText(shopId);
      if (!id) {
        return null;
      }
      const row = db.prepare(`${selectSql} WHERE profile_id = ? AND id = ?`).get(profileId, id);
      return row || null;
    },

    getPublicShopById(shopId) {
      return toPublicShop(this.getShopById(shopId));
    },

    getShopCredentialsForInternalUse(shopId) {
      const row = this.getShopById(shopId);
      if (!row) {
        return null;
      }

      return {
        shopId: row.id,
        clientId: row.client_id || null,
        apiKey: decryptSecret(row.api_key_encrypted),
        hasClientId: Boolean(row.client_id),
        hasApiKey: Boolean(row.api_key_encrypted),
        profileId: row.profile_id,
        shopIncarnation: row.shop_incarnation,
        credentialRevision: Number(row.credential_revision),
      };
    },

    saveShop(input = {}) {
      const requestedId = normalizeText(input.id);
      const unscopedExisting = requestedId ? getUnscopedShopById(requestedId) : null;
      assertOwnerScope(unscopedExisting);
      const existing = unscopedExisting;
      const timestamp = timestampNow();
      const shop = prepareStoredShop(input, existing, timestamp);
      const created = !existing;
      persistShop(shop, existing, timestamp);

      return {
        created,
        credentialsUpdated: shop.credentialsUpdated,
        incarnationChanged: shop.incarnationChanged,
        rebound: shop.rebound,
        bindingActivated: shop.readyForContinuousSync && !shop.wasReadyForContinuousSync && !shop.rebound,
        syncBootstrapRequired: shop.readyForContinuousSync
          && (!shop.wasReadyForContinuousSync || shop.credentialsUpdated || shop.rebound),
        scopeToken: identityRepository.createScopeToken(shop.id, profileId),
        shop: this.getPublicShopById(shop.id),
      };
    },

    rebindShop(input = {}) {
      const requestedId = normalizeText(input.id);
      if (!requestedId) throw new ShopIdentityError('SHOP_ID_REQUIRED');
      const existing = getUnscopedShopById(requestedId);
      if (!existing) throw new ShopIdentityError('SHOP_SCOPE_NOT_FOUND');
      assertOwnerScope(existing);
      const timestamp = timestampNow();
      const shop = prepareStoredShop({ ...input, status: 'active' }, existing, timestamp, { forceRebind: true });
      if (!shop.readyForContinuousSync) throw new ShopIdentityError('SHOP_REBIND_CREDENTIALS_REQUIRED');
      persistShop(shop, existing, timestamp);
      return {
        created: false,
        credentialsUpdated: shop.credentialsUpdated,
        incarnationChanged: true,
        rebound: true,
        bindingActivated: false,
        syncBootstrapRequired: true,
        scopeToken: identityRepository.createScopeToken(shop.id, profileId),
        shop: this.getPublicShopById(shop.id),
      };
    },

    /**
     * One-time owner-scoped import for the old Ozon shop browser payload. The
     * encrypted shop accounts and their non-secret preference/warehouse map
     * are committed in one transaction. Unlike normal POST /api/shops writes,
     * this path has no sync bootstrap side effect.
     */
    importLegacyOzonShopSettings(input = {}) {
      assertPlainObject(input, 'SHOP_LEGACY_IMPORT_PAYLOAD_INVALID');
      const shops = input.shops;
      if (!Array.isArray(shops) || !shops.length) {
        throw new Error('SHOP_LEGACY_IMPORT_SHOPS_REQUIRED');
      }
      const timestamp = timestampNow();
      const ids = new Set();
      const externalIdentities = new Set();
      const prepared = shops.map((inputShop) => {
        const id = assertLegacyShopInput(inputShop);
        if (ids.has(id)) throw new Error('SHOP_LEGACY_IMPORT_ID_DUPLICATE');
        ids.add(id);
        const unscopedExisting = getUnscopedShopById(id);
        assertOwnerScope(unscopedExisting);
        const existing = unscopedExisting;
        const stored = prepareStoredShop(inputShop, existing, timestamp);
        if (Boolean(stored.client_id) !== Boolean(stored.api_key_encrypted)) {
          throw new Error('SHOP_LEGACY_IMPORT_CREDENTIAL_PAIR_REQUIRED');
        }
        if (stored.external_identity_hash && externalIdentities.has(stored.external_identity_hash)) {
          throw new ShopIdentityError('SHOP_EXTERNAL_IDENTITY_ALREADY_BOUND');
        }
        if (stored.external_identity_hash) externalIdentities.add(stored.external_identity_hash);
        return { stored, existing };
      });
      const preferences = prepareLegacyOzonShopPreferences(input.preferences, ids);
      const profileRow = db
        .prepare('SELECT namespace, value_json, created_at, updated_at FROM profile_settings WHERE namespace = ?')
        .get(LEGACY_OZON_SHOP_PREFERENCES_NAMESPACE);
      const upsertShop = db.prepare(`
        INSERT INTO shops (
          id, name, alias, client_id, api_key_encrypted, status,
          profile_id, tenant_id, user_id, external_identity_hash, shop_incarnation,
          credential_revision, bound_at, disabled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          alias = excluded.alias,
          client_id = excluded.client_id,
          api_key_encrypted = excluded.api_key_encrypted,
          status = excluded.status,
          profile_id = excluded.profile_id,
          tenant_id = excluded.tenant_id,
          user_id = excluded.user_id,
          external_identity_hash = excluded.external_identity_hash,
          shop_incarnation = excluded.shop_incarnation,
          credential_revision = excluded.credential_revision,
          bound_at = excluded.bound_at,
          disabled_at = excluded.disabled_at,
          updated_at = excluded.updated_at
      `);
      const upsertPreferences = db.prepare(`
        INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(namespace) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `);
      db.exec('BEGIN IMMEDIATE;');
      try {
        prepared.forEach(({ stored, existing }) => {
          upsertShop.run(
            stored.id,
            stored.name,
            stored.alias,
            stored.client_id,
            stored.api_key_encrypted,
        stored.status,
        stored.profile_id,
        stored.tenant_id,
        stored.user_id,
            stored.external_identity_hash,
            stored.shop_incarnation,
            stored.credential_revision,
            stored.bound_at,
            stored.disabled_at,
            existing?.created_at || timestamp,
            timestamp,
          );
        });
        upsertPreferences.run(
          LEGACY_OZON_SHOP_PREFERENCES_NAMESPACE,
          JSON.stringify(preferences),
          profileRow?.created_at || timestamp,
          timestamp,
        );
        db.exec('COMMIT;');
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
      return {
        ok: true,
        importedCount: prepared.length,
        scopeCount: ids.size,
        digest: createStableHash({
          shops: prepared.map(({ stored }) => toLegacyShopDigestRow(stored)),
          preferences,
        }),
      };
    },

    deleteShop(shopId) {
      const id = normalizeText(shopId);
      if (!id) throw new Error('Shop id is required.');
      throw new Error('ACCOUNT_REMOVAL_LEGACY_PRIMITIVE_DISABLED');
    },
  };
}
