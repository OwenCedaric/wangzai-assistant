import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../security/secretCrypto.js';
import { createSavedSecretHint } from '../../security/secretPresentation.js';

const VALID_STATUSES = new Set(['inactive', 'active', 'disabled', 'error']);
const DEFAULT_TENANT_ID = 'tenant_local_default';
const DEFAULT_USER_ID = 'user_local_default';
const DEFAULT_PROFILE_ID = 'default';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeOptionalText(value) {
  const text = normalizeText(value);
  return text || null;
}

function normalizeStatus(value) {
  const status = normalizeText(value) || 'inactive';
  return VALID_STATUSES.has(status) ? status : 'inactive';
}

function normalizeEncryptedSecret(value) {
  const secret = normalizeText(value);
  if (!secret) return null;
  return isEncryptedSecret(secret) ? secret : encryptSecret(secret);
}

function decryptAccountIdentifier(value) {
  try {
    return decryptSecret(value) || '';
  } catch {
    return '';
  }
}

function createAccountId() {
  return `cross_border_${randomUUID()}`;
}

function normalizeShopIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => normalizeText(entry)).filter(Boolean))].slice(0, 500);
}

function toPublicAccount(row = {}, shopIds = []) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status || 'inactive',
    userName: decryptAccountIdentifier(row.user_name_encrypted),
    hasUserName: Boolean(row.user_name_encrypted),
    hasPassword: Boolean(row.password_encrypted),
    hasCompanySecret: Boolean(row.company_secret_encrypted),
    hasAccessToken: Boolean(row.access_token_encrypted),
    hasExpiresToken: Boolean(row.expires_token_encrypted),
    hasAppUid: Boolean(row.app_uid_encrypted),
    authorizationRef: decryptAccountIdentifier(row.authorization_ref_encrypted),
    authorizationExpiresAt: row.authorization_expires_at || '',
    hasServerAuthorization: Boolean(row.authorization_ref_encrypted),
    userNameHint: createSavedSecretHint(row.user_name_encrypted),
    passwordHint: createSavedSecretHint(row.password_encrypted),
    companySecretHint: createSavedSecretHint(row.company_secret_encrypted),
    accessTokenHint: createSavedSecretHint(row.access_token_encrypted),
    expiresTokenHint: createSavedSecretHint(row.expires_token_encrypted),
    appUidHint: createSavedSecretHint(row.app_uid_encrypted),
    defaultStorehouse: row.default_storehouse || '',
    defaultSection: row.default_section || '',
    defaultService: row.default_service || '',
    note: row.note || '',
    shopIds: [...shopIds],
    shopCount: shopIds.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeAccountInput(input = {}, existing = null) {
  const name = normalizeText(input.name ?? input.accountName ?? existing?.name);
  if (!name) throw new Error('Cross-border account name is required.');
  const hasUserName = Object.prototype.hasOwnProperty.call(input, 'userName') || Object.prototype.hasOwnProperty.call(input, 'user_name');
  const hasPassword = Object.prototype.hasOwnProperty.call(input, 'password') || Object.prototype.hasOwnProperty.call(input, 'passwordEncrypted');
  const hasCompanySecret = Object.prototype.hasOwnProperty.call(input, 'companySecret') || Object.prototype.hasOwnProperty.call(input, 'companySecretEncrypted');
  const hasAccessToken = Object.prototype.hasOwnProperty.call(input, 'accessToken') || Object.prototype.hasOwnProperty.call(input, 'accessTokenEncrypted');
  const hasExpiresToken = Object.prototype.hasOwnProperty.call(input, 'expiresToken') || Object.prototype.hasOwnProperty.call(input, 'expiresTokenEncrypted');
  const hasAppUid = Object.prototype.hasOwnProperty.call(input, 'appUid') || Object.prototype.hasOwnProperty.call(input, 'appUidEncrypted');
  const hasAuthorizationRef = Object.prototype.hasOwnProperty.call(input, 'authorizationRef')
    || Object.prototype.hasOwnProperty.call(input, 'authorization_ref');
  return {
    id: normalizeText(input.id ?? existing?.id) || createAccountId(),
    name,
    status: normalizeStatus(input.status ?? existing?.status),
    user_name_encrypted: hasUserName
      ? normalizeEncryptedSecret(input.userName ?? input.user_name)
      : existing?.user_name_encrypted || null,
    password_encrypted: hasPassword
      ? normalizeEncryptedSecret(input.passwordEncrypted ?? input.password)
      : existing?.password_encrypted || null,
    company_secret_encrypted: hasCompanySecret
      ? normalizeEncryptedSecret(input.companySecretEncrypted ?? input.companySecret)
      : existing?.company_secret_encrypted || null,
    access_token_encrypted: hasAccessToken
      ? normalizeEncryptedSecret(input.accessTokenEncrypted ?? input.accessToken)
      : existing?.access_token_encrypted || null,
    expires_token_encrypted: hasExpiresToken
      ? normalizeEncryptedSecret(input.expiresTokenEncrypted ?? input.expiresToken)
      : existing?.expires_token_encrypted || null,
    app_uid_encrypted: hasAppUid
      ? normalizeEncryptedSecret(input.appUidEncrypted ?? input.appUid)
      : existing?.app_uid_encrypted || null,
    authorization_ref_encrypted: hasAuthorizationRef
      ? normalizeEncryptedSecret(input.authorizationRef ?? input.authorization_ref)
      : existing?.authorization_ref_encrypted || null,
    authorization_expires_at: normalizeOptionalText(
      input.authorizationExpiresAt
      ?? input.authorization_expires_at
      ?? existing?.authorization_expires_at,
    ),
    default_storehouse: normalizeOptionalText(input.defaultStorehouse ?? input.default_storehouse ?? existing?.default_storehouse),
    default_section: normalizeOptionalText(input.defaultSection ?? input.default_section ?? existing?.default_section),
    default_service: normalizeOptionalText(input.defaultService ?? input.default_service ?? existing?.default_service),
    note: normalizeOptionalText(input.note ?? existing?.note),
  };
}

export function createCrossBorderAccountRepository(db, options = {}) {
  const profileId = normalizeText(options.profileId) || DEFAULT_PROFILE_ID;
  const tenantId = normalizeText(options.tenantId) || DEFAULT_TENANT_ID;
  const userId = normalizeText(options.userId)
    || (profileId !== DEFAULT_PROFILE_ID ? profileId : DEFAULT_USER_ID);
  const selectSql = `
    SELECT id, name, status, user_name_encrypted, password_encrypted,
      company_secret_encrypted, access_token_encrypted, expires_token_encrypted, app_uid_encrypted,
      authorization_ref_encrypted, authorization_expires_at,
      default_storehouse, default_section, default_service, note,
      tenant_id, user_id, profile_id, created_at, updated_at
    FROM cross_border_accounts
  `;

  // Existing desktop profiles had one profile-global account. Adopt only the
  // legacy default scope into the current sealed profile, then materialize its
  // existing one-account-to-many-shops relation once.
  db.prepare(`
    UPDATE cross_border_accounts
    SET tenant_id = ?, user_id = ?, profile_id = ?
    WHERE profile_id IN ('', ?)
      AND tenant_id IN ('', ?)
      AND user_id IN ('', ?, ?)
  `).run(
    tenantId,
    userId,
    profileId,
    DEFAULT_PROFILE_ID,
    DEFAULT_TENANT_ID,
    DEFAULT_USER_ID,
    profileId,
  );

  const scopedAccountRows = db.prepare(`
    SELECT id FROM cross_border_accounts
    WHERE tenant_id = ? AND user_id = ? AND profile_id = ?
    ORDER BY id
  `).all(tenantId, userId, profileId);
  const bindingCount = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM cross_border_account_shop_bindings
    WHERE tenant_id = ? AND user_id = ? AND profile_id = ?
  `).get(tenantId, userId, profileId)?.count || 0);
  if (scopedAccountRows.length === 1 && bindingCount === 0) {
    const timestamp = nowIso();
    db.prepare(`
      INSERT OR IGNORE INTO cross_border_account_shop_bindings (
        tenant_id, user_id, profile_id, account_id, shop_id, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, id, ?, ?
      FROM shops
      WHERE tenant_id = ? AND user_id = ? AND profile_id = ?
    `).run(
      tenantId,
      userId,
      profileId,
      scopedAccountRows[0].id,
      timestamp,
      timestamp,
      tenantId,
      userId,
      profileId,
    );
  }

  function getAccountRow(accountId) {
    const id = normalizeText(accountId);
    if (!id) return null;
    return db.prepare(`${selectSql} WHERE tenant_id = ? AND user_id = ? AND profile_id = ? AND id = ?`)
      .get(tenantId, userId, profileId, id) || null;
  }

  function listBoundShopIds(accountId) {
    const id = normalizeText(accountId);
    if (!id) return [];
    return db.prepare(`
      SELECT shop_id FROM cross_border_account_shop_bindings
      WHERE tenant_id = ? AND user_id = ? AND profile_id = ? AND account_id = ?
      ORDER BY shop_id
    `).all(tenantId, userId, profileId, id).map((row) => row.shop_id);
  }

  function listAccounts() {
    return db.prepare(`${selectSql} WHERE tenant_id = ? AND user_id = ? AND profile_id = ? ORDER BY updated_at DESC, name ASC`)
      .all(tenantId, userId, profileId)
      .map((row) => toPublicAccount(row, listBoundShopIds(row.id)));
  }

  function getPublicAccountById(accountId) {
    const row = getAccountRow(accountId);
    return row ? toPublicAccount(row, listBoundShopIds(row.id)) : null;
  }

  function getCredentialsForInternalUse(accountId) {
    const row = getAccountRow(accountId);
    if (!row) return null;
    return {
      accountId: row.id,
      userName: decryptSecret(row.user_name_encrypted),
      password: decryptSecret(row.password_encrypted),
      companySecret: decryptSecret(row.company_secret_encrypted),
      accessToken: decryptSecret(row.access_token_encrypted),
      expiresToken: decryptSecret(row.expires_token_encrypted),
      appUid: decryptSecret(row.app_uid_encrypted),
      hasCompanySecret: Boolean(row.company_secret_encrypted),
      hasAccessToken: Boolean(row.access_token_encrypted),
      hasExpiresToken: Boolean(row.expires_token_encrypted),
      hasAppUid: Boolean(row.app_uid_encrypted),
      hasUserName: Boolean(row.user_name_encrypted),
      hasPassword: Boolean(row.password_encrypted),
      defaultStorehouse: row.default_storehouse || '',
      defaultSection: row.default_section || '',
      defaultService: row.default_service || '',
      shopIds: listBoundShopIds(row.id),
    };
  }

  function assertOwnedShopIds(shopIds) {
    if (!shopIds.length) return;
    const rows = db.prepare(`
      SELECT id FROM shops
      WHERE tenant_id = ? AND user_id = ? AND profile_id = ?
        AND id IN (${shopIds.map(() => '?').join(', ')})
    `).all(tenantId, userId, profileId, ...shopIds);
    const allowed = new Set(rows.map((row) => row.id));
    if (shopIds.some((shopId) => !allowed.has(shopId))) {
      const error = new Error('CROSS_BORDER_ACCOUNT_SHOP_FORBIDDEN');
      error.code = 'CROSS_BORDER_ACCOUNT_SHOP_FORBIDDEN';
      throw error;
    }
  }

  function saveAccount(input = {}) {
    const requestedId = normalizeText(input.id);
    const existing = requestedId ? getAccountRow(requestedId) : null;
    if (requestedId && !existing) {
      const unscoped = db.prepare('SELECT tenant_id, user_id, profile_id FROM cross_border_accounts WHERE id = ?').get(requestedId);
      if (unscoped) {
        const error = new Error('CROSS_BORDER_ACCOUNT_SCOPE_FORBIDDEN');
        error.code = 'CROSS_BORDER_ACCOUNT_SCOPE_FORBIDDEN';
        throw error;
      }
    }
    const account = normalizeAccountInput(input, existing);
    const hasShopIds = Object.prototype.hasOwnProperty.call(input, 'shopIds')
      || Object.prototype.hasOwnProperty.call(input, 'shop_ids');
    const shopIds = hasShopIds
      ? normalizeShopIds(input.shopIds ?? input.shop_ids)
      : existing ? listBoundShopIds(existing.id) : [];
    assertOwnedShopIds(shopIds);
    const timestamp = nowIso();
    const created = !existing;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO cross_border_accounts (
          id, name, status, user_name_encrypted, password_encrypted,
          company_secret_encrypted, access_token_encrypted, expires_token_encrypted, app_uid_encrypted,
          authorization_ref_encrypted, authorization_expires_at,
          default_storehouse, default_section, default_service, note,
          tenant_id, user_id, profile_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          status = excluded.status,
          user_name_encrypted = excluded.user_name_encrypted,
          password_encrypted = excluded.password_encrypted,
          company_secret_encrypted = excluded.company_secret_encrypted,
          access_token_encrypted = excluded.access_token_encrypted,
          expires_token_encrypted = excluded.expires_token_encrypted,
          app_uid_encrypted = excluded.app_uid_encrypted,
          authorization_ref_encrypted = excluded.authorization_ref_encrypted,
          authorization_expires_at = excluded.authorization_expires_at,
          default_storehouse = excluded.default_storehouse,
          default_section = excluded.default_section,
          default_service = excluded.default_service,
          note = excluded.note,
          updated_at = excluded.updated_at
      `).run(
        account.id,
        account.name,
        account.status,
        account.user_name_encrypted,
        account.password_encrypted,
        account.company_secret_encrypted,
        account.access_token_encrypted,
        account.expires_token_encrypted,
        account.app_uid_encrypted,
        account.authorization_ref_encrypted,
        account.authorization_expires_at,
        account.default_storehouse,
        account.default_section,
        account.default_service,
        account.note,
        tenantId,
        userId,
        profileId,
        existing?.created_at || timestamp,
        timestamp,
      );
      if (hasShopIds || created) {
        db.prepare(`
          DELETE FROM cross_border_account_shop_bindings
          WHERE tenant_id = ? AND user_id = ? AND profile_id = ? AND account_id = ?
        `).run(tenantId, userId, profileId, account.id);
        const insertBinding = db.prepare(`
          INSERT INTO cross_border_account_shop_bindings (
            tenant_id, user_id, profile_id, account_id, shop_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        shopIds.forEach((shopId) => insertBinding.run(
          tenantId,
          userId,
          profileId,
          account.id,
          shopId,
          timestamp,
          timestamp,
        ));
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, created, account: getPublicAccountById(account.id) };
  }

  function resolveAccountShopScope(input = {}) {
    const explicitAccountId = normalizeText(input.crossBorderAccountId ?? input.cross_border_account_id);
    const legacyAccountId = normalizeText(input.accountId ?? input.account_id);
    // Older browser callers used accountId for the browser storage reference.
    // Only treat that alias as a logical bus account when it actually resolves
    // in this tenant/user/profile; an arbitrary browser ref must keep the
    // pre-binding compatibility path instead of becoming a false 404.
    const requestedAccountId = explicitAccountId
      || (legacyAccountId && getAccountRow(legacyAccountId) ? legacyAccountId : '');
    let row = requestedAccountId ? getAccountRow(requestedAccountId) : null;
    if (requestedAccountId && !row) {
      const error = new Error('CROSS_BORDER_ACCOUNT_NOT_FOUND');
      error.code = 'CROSS_BORDER_ACCOUNT_NOT_FOUND';
      throw error;
    }
    if (!row) {
      const rows = db.prepare(`${selectSql} WHERE tenant_id = ? AND user_id = ? AND profile_id = ? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC`)
        .all(tenantId, userId, profileId);
      if (rows.length > 1) {
        return { ok: false, ambiguous: true, accountId: '', shopIds: [] };
      }
      row = rows[0] || null;
    }
    if (!row) return { ok: true, configured: false, ambiguous: false, accountId: '', shopIds: [] };
    return {
      ok: true,
      configured: true,
      ambiguous: false,
      accountId: row.id,
      shopIds: listBoundShopIds(row.id),
    };
  }

  function deleteAccount(accountId) {
    const id = normalizeText(accountId);
    if (!id) throw new Error('Cross-border account id is required.');
    throw new Error('ACCOUNT_REMOVAL_LEGACY_PRIMITIVE_DISABLED');
  }

  return {
    profileId,
    tenantId,
    userId,
    listAccounts,
    listBoundShopIds,
    getPublicAccountById,
    getCredentialsForInternalUse,
    saveAccount,
    resolveAccountShopScope,
    deleteAccount,
  };
}
