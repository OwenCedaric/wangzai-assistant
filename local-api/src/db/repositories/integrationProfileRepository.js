import { randomUUID } from 'node:crypto';

const FORBIDDEN_SECRET_FIELDS = [
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'clientSecret',
  'client_secret',
  'companySecret',
  'company_secret',
  'loginPassword',
  'login_password',
  'performanceClientSecret',
];

export const OZON_BROWSER_SESSION_TYPE = 'ozon-browser-session';
export const OZON_FOLLOW_SELLER_SESSION_TYPE = 'ozon-follow-seller-session';
const OZON_LOGIN_PROFILE_TYPES = new Set([
  OZON_BROWSER_SESSION_TYPE,
  OZON_FOLLOW_SELLER_SESSION_TYPE,
]);

function isOzonLoginProfileType(value) {
  return OZON_LOGIN_PROFILE_TYPES.has(normalizeText(value));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function optionalText(value) {
  return normalizeText(value) || null;
}

function normalizeIdentity(value) {
  return normalizeText(value).toLowerCase();
}

function hasOwn(input, name) {
  return Object.prototype.hasOwnProperty.call(input, name);
}

function assertNoSecretFields(input = {}) {
  const forbidden = FORBIDDEN_SECRET_FIELDS.find((field) => normalizeText(input[field]));
  if (forbidden) throw new Error(`Integration profile secret field is forbidden: ${forbidden}.`);
}

function publicProfile(row = {}) {
  return {
    id: row.id,
    integrationType: row.integration_type,
    platformName: row.platform_name,
    shopId: row.shop_id || '',
    apiType: row.api_type || '',
    authMode: row.auth_mode || '',
    configStatus: row.config_status || '',
    tokenStatus: row.token_status || '',
    readScope: row.read_scope || '',
    writeScope: row.write_scope || '',
    note: row.note || '',
    browserCompanyId: row.browser_company_id || '',
    browserCompanyName: row.browser_company_name || '',
    apiIdentityId: row.api_identity_id || '',
    identityStatus: row.identity_status || '',
    identitySource: row.identity_source || '',
    identityVerifiedAt: row.identity_verified_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createIntegrationProfileRepository(db) {
  const selectSql = `
    SELECT id, integration_type, platform_name, shop_id, api_type, auth_mode, config_status,
      token_status, read_scope, write_scope, note, browser_company_id, browser_company_name,
      api_identity_id, identity_status, identity_source, identity_verified_at, created_at, updated_at
    FROM integration_profiles
  `;
  let getRowStatement = null;
  let upsertProfileStatement = null;

  function getRow(id) {
    const normalizedId = normalizeText(id);
    if (!normalizedId) return null;
    if (!getRowStatement) getRowStatement = db.prepare(`${selectSql} WHERE id = ?`);
    return getRowStatement.get(normalizedId) || null;
  }

  function getUpsertProfileStatement() {
    if (upsertProfileStatement) return upsertProfileStatement;
    upsertProfileStatement = db.prepare(`
      INSERT INTO integration_profiles (
        id, integration_type, platform_name, shop_id, api_type, auth_mode, config_status,
        token_status, read_scope, write_scope, note, browser_company_id, browser_company_name,
        api_identity_id, identity_status, identity_source, identity_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        integration_type = excluded.integration_type, platform_name = excluded.platform_name,
        shop_id = excluded.shop_id,
        api_type = excluded.api_type, auth_mode = excluded.auth_mode,
        config_status = excluded.config_status, token_status = excluded.token_status,
        read_scope = excluded.read_scope, write_scope = excluded.write_scope,
        note = excluded.note, browser_company_id = excluded.browser_company_id,
        browser_company_name = excluded.browser_company_name,
        api_identity_id = excluded.api_identity_id,
        identity_status = excluded.identity_status,
        identity_source = excluded.identity_source,
        identity_verified_at = excluded.identity_verified_at,
        updated_at = excluded.updated_at
    `);
    return upsertProfileStatement;
  }

  function toStoredProfile(input = {}, existing = null) {
    assertNoSecretFields(input);
    const requestedId = normalizeText(input.id ?? input.profileId);
    const integrationType = normalizeText(input.integrationType ?? input.integration_type ?? existing?.integration_type);
    const platformName = normalizeText(input.platformName ?? input.platform_name ?? existing?.platform_name);
    if (!integrationType) throw new Error('Integration profile type is required.');
    if (!platformName) throw new Error('Integration profile platform name is required.');
    const hasShopIdField = hasOwn(input, 'shopId') || hasOwn(input, 'shop_id');
    const shopId = integrationType === OZON_BROWSER_SESSION_TYPE
      ? (hasShopIdField
          ? optionalText(input.shopId ?? input.shop_id)
          : existing?.shop_id || null)
      : null;
    if (integrationType === OZON_BROWSER_SESSION_TYPE && !shopId) {
      throw new Error('OZON_BROWSER_SHOP_REQUIRED');
    }
    const identityStatus = integrationType === OZON_BROWSER_SESSION_TYPE
      ? optionalText(existing?.identity_status) || 'unverified'
      : null;
    const requestedConfigStatus = optionalText(input.configStatus ?? input.config_status ?? existing?.config_status);
    return {
      id: requestedId || `integration_${randomUUID()}`,
      integration_type: integrationType,
      platform_name: platformName,
      shop_id: shopId,
      api_type: optionalText(input.apiType ?? input.api_type ?? existing?.api_type),
      auth_mode: optionalText(input.authMode ?? input.auth_mode ?? existing?.auth_mode),
      config_status: integrationType === OZON_BROWSER_SESSION_TYPE
        && identityStatus !== 'verified'
        && requestedConfigStatus === '连接成功'
          ? '待核对'
          : requestedConfigStatus,
      token_status: optionalText(input.tokenStatus ?? input.token_status ?? existing?.token_status),
      read_scope: optionalText(input.readScope ?? input.read_scope ?? existing?.read_scope),
      write_scope: optionalText(input.writeScope ?? input.write_scope ?? existing?.write_scope),
      note: optionalText(input.note ?? input.remark ?? existing?.note),
      browser_company_id: optionalText(existing?.browser_company_id),
      browser_company_name: optionalText(existing?.browser_company_name),
      api_identity_id: optionalText(existing?.api_identity_id),
      identity_status: identityStatus,
      identity_source: optionalText(existing?.identity_source),
      identity_verified_at: optionalText(existing?.identity_verified_at),
    };
  }

  function persistProfile(profile, existing, timestamp) {
    getUpsertProfileStatement().run(
      profile.id,
      profile.integration_type,
      profile.platform_name,
      profile.shop_id,
      profile.api_type,
      profile.auth_mode,
      profile.config_status,
      profile.token_status,
      profile.read_scope,
      profile.write_scope,
      profile.note,
      profile.browser_company_id,
      profile.browser_company_name,
      profile.api_identity_id,
      profile.identity_status,
      profile.identity_source,
      profile.identity_verified_at,
      existing?.created_at || timestamp,
      timestamp,
    );
  }

  function listProfiles() {
    return db
      .prepare(`${selectSql} ORDER BY updated_at DESC, platform_name ASC, id ASC`)
      .all()
      .map(publicProfile);
  }

  function getProfile(profileId) {
    const row = getRow(profileId);
    return row ? publicProfile(row) : null;
  }

  function saveProfile(input = {}) {
    const requestedId = normalizeText(input.id ?? input.profileId);
    const existing = requestedId ? getRow(requestedId) : null;
    const profile = toStoredProfile(input, existing);
    if (profile.shop_id) {
      const shop = db.prepare("SELECT id FROM shops WHERE id = ? AND status = 'active' LIMIT 1").get(profile.shop_id);
      if (!shop) throw new Error('OZON_BROWSER_SHOP_NOT_FOUND');
      if (profile.integration_type === OZON_BROWSER_SESSION_TYPE) {
        const conflict = db.prepare(`
          SELECT id FROM integration_profiles
          WHERE integration_type = ? AND shop_id = ? AND id <> ?
          LIMIT 1
        `).get(OZON_BROWSER_SESSION_TYPE, profile.shop_id, profile.id);
        if (conflict) throw new Error('OZON_BROWSER_SHOP_ALREADY_BOUND');
      }
    }
    const existingUpdatedAt = Date.parse(existing?.updated_at || '');
    const timestamp = new Date(Math.max(
      Date.now(),
      Number.isFinite(existingUpdatedAt) ? existingUpdatedAt : 0,
    )).toISOString();
    persistProfile(profile, existing, timestamp);
    return { ok: true, created: !existing, profile: publicProfile(getRow(profile.id)) };
  }

  function saveBrowserLoginState(profileId, input = {}) {
    const id = normalizeText(profileId);
    if (!id) throw new Error('Integration profile id is required.');
    const existing = getRow(id);
    if (!existing || !isOzonLoginProfileType(existing.integration_type)) {
      throw new Error('PURCHASE_BROWSER_INTEGRATION_PROFILE_NOT_FOUND');
    }
    const verified = input.loggedIn === true && input.cookieSaved === true;
    const suppliedVerifiedAt = normalizeText(input.verifiedAt);
    const parsedVerifiedAt = Date.parse(suppliedVerifiedAt);
    const timestamp = Number.isFinite(parsedVerifiedAt)
      ? new Date(parsedVerifiedAt).toISOString()
      : nowIso();
    const existingUpdatedAt = Date.parse(existing.updated_at || '');
    if (Number.isFinite(existingUpdatedAt) && Date.parse(timestamp) < existingUpdatedAt) {
      const profile = publicProfile(existing);
      return {
        ok: true,
        stale: true,
        connected: profile.configStatus === '连接成功'
          && profile.tokenStatus === 'Cookie 已保存'
          && (existing.integration_type !== OZON_BROWSER_SESSION_TYPE || profile.identityStatus === 'verified'),
        profile,
      };
    }
    const shopScoped = existing.integration_type === OZON_BROWSER_SESSION_TYPE;
    const browserCompanyId = optionalText(input.companyId ?? input.company_id ?? input.browserCompanyId);
    const browserCompanyName = optionalText(input.companyName ?? input.company_name ?? input.browserCompanyName);
    const shop = shopScoped
      ? db.prepare("SELECT client_id FROM shops WHERE id = ? AND status = 'active' LIMIT 1").get(existing.shop_id)
      : null;
    const expectedClientId = optionalText(shop?.client_id);
    const browserMatchesApi = Boolean(
      verified
      && browserCompanyId
      && expectedClientId
      && normalizeIdentity(browserCompanyId) === normalizeIdentity(expectedClientId),
    );
    const alreadyVerified = browserMatchesApi
      && normalizeText(existing.identity_status) === 'verified'
      && normalizeIdentity(existing.browser_company_id) === normalizeIdentity(browserCompanyId)
      && normalizeIdentity(existing.api_identity_id) === normalizeIdentity(expectedClientId);
    const identityStatus = !shopScoped
      ? null
      : !verified
        ? optionalText(existing.identity_status) || 'unverified'
        : !browserCompanyId
          ? 'unverified'
          : !expectedClientId
            ? 'api-missing'
            : browserMatchesApi
              ? alreadyVerified ? 'verified' : 'browser-matched'
              : 'mismatch';
    const configStatus = !verified
      ? '需要重新登录'
      : !shopScoped
        ? '连接成功'
        : identityStatus === 'verified'
          ? '连接成功'
          : identityStatus === 'mismatch'
            ? '账号不匹配'
            : identityStatus === 'api-missing'
              ? '缺少 API Client ID'
              : identityStatus === 'browser-matched'
                ? '等待 API 核对'
                : '等待账号识别';
    db.prepare(`
      UPDATE integration_profiles
      SET config_status = ?, token_status = ?, auth_mode = ?,
          browser_company_id = CASE WHEN ? = 1 THEN ? ELSE browser_company_id END,
          browser_company_name = CASE WHEN ? = 1 THEN ? ELSE browser_company_name END,
          identity_status = CASE WHEN ? = 1 THEN ? ELSE identity_status END,
          identity_source = CASE WHEN ? = 1 THEN ? ELSE identity_source END,
          updated_at = ?
      WHERE id = ? AND integration_type IN (?, ?)
    `).run(
      configStatus,
      verified ? 'Cookie 已保存' : 'Cookie 已失效',
      '验证码登录',
      shopScoped ? 1 : 0,
      browserCompanyId,
      shopScoped ? 1 : 0,
      browserCompanyName,
      shopScoped ? 1 : 0,
      identityStatus,
      shopScoped ? 1 : 0,
      browserCompanyId ? 'seller-browser-company' : null,
      timestamp,
      id,
      OZON_BROWSER_SESSION_TYPE,
      OZON_FOLLOW_SELLER_SESSION_TYPE,
    );
    let refreshed = getRow(id);
    const preservedApiProof = Boolean(
      shopScoped
      && verified
      && browserMatchesApi
      && refreshed?.identity_verified_at
      && normalizeIdentity(refreshed.browser_company_id) === normalizeIdentity(browserCompanyId)
      && normalizeIdentity(refreshed.api_identity_id) === normalizeIdentity(expectedClientId),
    );
    if (preservedApiProof && refreshed.identity_status !== 'verified') {
      db.prepare(`
        UPDATE integration_profiles
        SET config_status = '连接成功', identity_status = 'verified', updated_at = ?
        WHERE id = ? AND integration_type = ? AND shop_id = ?
          AND token_status = 'Cookie 已保存' AND identity_verified_at IS NOT NULL
          AND LOWER(TRIM(COALESCE(browser_company_id, ''))) = LOWER(TRIM(?))
          AND LOWER(TRIM(COALESCE(api_identity_id, ''))) = LOWER(TRIM(?))
      `).run(timestamp, id, OZON_BROWSER_SESSION_TYPE, existing.shop_id, browserCompanyId, expectedClientId);
      refreshed = getRow(id);
    }
    const profile = publicProfile(refreshed);
    const expectedConfigStatus = preservedApiProof ? '连接成功' : configStatus;
    if (
      !profile
      || profile.configStatus !== expectedConfigStatus
      || profile.tokenStatus !== (verified ? 'Cookie 已保存' : 'Cookie 已失效')
    ) {
      throw new Error('PURCHASE_BROWSER_INTEGRATION_LOGIN_READBACK_FAILED');
    }
    const connected = verified && (!shopScoped || profile.identityStatus === 'verified');
    return {
      ok: true,
      connected,
      identityMatched: shopScoped && verified ? browserMatchesApi : null,
      identityStatus: profile.identityStatus || null,
      profile,
    };
  }

  function confirmBrowserApiIdentity(profileId, {
    shopId = '',
    acceptedIdentityIds = [],
    source = 'seller-api-readback',
  } = {}) {
    const id = normalizeText(profileId);
    const exactShopId = normalizeText(shopId);
    const existing = getRow(id);
    if (!existing || existing.integration_type !== OZON_BROWSER_SESSION_TYPE) {
      throw new Error('PURCHASE_BROWSER_INTEGRATION_PROFILE_NOT_FOUND');
    }
    if (!exactShopId || normalizeText(existing.shop_id) !== exactShopId) {
      throw new Error('OZON_BROWSER_SHOP_IDENTITY_SCOPE_MISMATCH');
    }
    const browserIdentity = normalizeIdentity(existing.browser_company_id);
    const accepted = [...new Set((Array.isArray(acceptedIdentityIds) ? acceptedIdentityIds : [])
      .map(normalizeIdentity)
      .filter(Boolean))];
    const matchedIdentity = accepted.find((candidate) => candidate === browserIdentity) || '';
    const apiIdentity = matchedIdentity || accepted[0] || '';
    const verified = Boolean(
      browserIdentity
      && matchedIdentity
      && existing.token_status === 'Cookie 已保存',
    );
    const existingUpdatedAt = Date.parse(existing.updated_at || '');
    const timestamp = new Date(Math.max(
      Date.now(),
      Number.isFinite(existingUpdatedAt) ? existingUpdatedAt : 0,
    )).toISOString();
    db.prepare(`
      UPDATE integration_profiles
      SET api_identity_id = ?, identity_status = ?, identity_source = ?,
          identity_verified_at = ?, config_status = ?, updated_at = ?
      WHERE id = ? AND integration_type = ? AND shop_id = ?
    `).run(
      optionalText(apiIdentity),
      verified ? 'verified' : 'mismatch',
      optionalText(source),
      verified ? timestamp : null,
      verified ? '连接成功' : '账号不匹配',
      timestamp,
      id,
      OZON_BROWSER_SESSION_TYPE,
      exactShopId,
    );
    const profile = publicProfile(getRow(id));
    return {
      ok: true,
      connected: verified,
      identityMatched: verified,
      profile,
    };
  }

  function deleteProfile(profileId) {
    const id = normalizeText(profileId);
    if (!id) throw new Error('Integration profile id is required.');
    throw new Error('ACCOUNT_REMOVAL_LEGACY_PRIMITIVE_DISABLED');
  }

  return {
    listProfiles,
    getProfile,
    saveProfile,
    saveBrowserLoginState,
    confirmBrowserApiIdentity,
    deleteProfile,
  };
}
