import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../security/secretCrypto.js';
import { createSavedSecretHint } from '../../security/secretPresentation.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function optionalText(value) {
  return normalizeText(value) || null;
}

const PURCHASE_PLATFORM_PRESETS = Object.freeze([
  Object.freeze({
    platformName: '拼多多',
    platformAliases: Object.freeze(['Pinduoduo', 'PDD']),
    accountAlias: '拼多多采购号',
    platformUrl: 'https://mobile.yangkeduo.com/',
  }),
  Object.freeze({ platformName: '天猫', accountAlias: '天猫采购号', platformUrl: 'https://www.tmall.com/' }),
  Object.freeze({ platformName: '淘宝', accountAlias: '淘宝采购号', platformUrl: 'https://www.taobao.com/' }),
  Object.freeze({ platformName: '1688', accountAlias: '1688采购号', platformUrl: 'https://www.1688.com/' }),
  Object.freeze({
    platformName: 'Ozon买家',
    platformAliases: Object.freeze(['Ozon Buyer', 'ozon-buyer', 'Ozon 买家']),
    accountAlias: 'Ozon买家采购号',
    platformUrl: 'https://www.ozon.ru/',
  }),
  Object.freeze({
    platformName: '京东',
    platformAliases: Object.freeze(['JD', 'jd.com']),
    accountAlias: '京东采购号',
    platformUrl: 'https://www.jd.com/',
  }),
  Object.freeze({
    platformName: 'Wildberries',
    platformAliases: Object.freeze(['WB', 'wildberries.ru']),
    accountAlias: 'Wildberries采购号',
    platformUrl: 'https://www.wildberries.ru/',
  }),
  Object.freeze({
    platformName: 'Amazon',
    platformAliases: Object.freeze(['amazon.com']),
    accountAlias: 'Amazon采购号',
    platformUrl: 'https://www.amazon.com/',
  }),
  Object.freeze({
    platformName: 'Temu',
    platformAliases: Object.freeze(['temu.com']),
    accountAlias: 'Temu采购号',
    platformUrl: 'https://www.temu.com/',
  }),
  Object.freeze({
    platformName: 'AliExpress',
    platformAliases: Object.freeze(['Ali Express', 'aliexpress.com']),
    accountAlias: 'AliExpress采购号',
    platformUrl: 'https://www.aliexpress.com/',
  }),
]);

const PURCHASE_RECIPIENT_PROFILE_SCHEMA_V1 = 'purchase-account-recipient-v1';
const PURCHASE_ACCOUNT_PROFILE_SCHEMA_V2 = 'purchase-account-profile-v2';

function normalizeAlias(value) {
  return normalizeText(value).replace(/\s+/gu, '');
}

function resolvePlatformPreset(platformName, accountAlias = '') {
  const normalizedPlatform = normalizeText(platformName);
  if (normalizedPlatform) {
    return PURCHASE_PLATFORM_PRESETS.find(
      (preset) => preset.platformName === normalizedPlatform || preset.platformAliases?.includes(normalizedPlatform)
    ) || null;
  }
  const normalizedAlias = normalizeAlias(accountAlias);
  if (!normalizedAlias) return null;
  return PURCHASE_PLATFORM_PRESETS.find((preset) => normalizeAlias(preset.accountAlias) === normalizedAlias) || null;
}

function boundedOptionalText(value, maximum, label) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (normalized.length > maximum) throw new Error(`${label} is too long.`);
  return normalized;
}

function normalizeBrowserLogin(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const verifiedAt = normalizeText(source.lastVerifiedAt ?? source.verifiedAt);
  const verifiedTime = Date.parse(verifiedAt);
  const saved = source.status === '已登录'
    && source.cookieStatus === 'Cookie 已保存'
    && Number.isFinite(verifiedTime);
  return saved
    ? {
        status: '已登录',
        cookieStatus: 'Cookie 已保存',
        lastVerifiedAt: new Date(verifiedTime).toISOString(),
      }
    : null;
}

function parseAccountProfile(value) {
  const text = normalizeText(value);
  if (!text || !text.startsWith('{')) return {};
  try {
    const parsed = JSON.parse(text);
    if (![PURCHASE_RECIPIENT_PROFILE_SCHEMA_V1, PURCHASE_ACCOUNT_PROFILE_SCHEMA_V2].includes(parsed?.schema)) {
      return {};
    }
    return {
      recipientNickname: boundedOptionalText(parsed.recipientNickname, 80, 'Recipient nickname'),
      recipientPhone: boundedOptionalText(parsed.recipientPhone, 40, 'Recipient phone'),
      recipientAddress: boundedOptionalText(parsed.recipientAddress, 1000, 'Recipient address'),
      browserLogin: parsed.schema === PURCHASE_ACCOUNT_PROFILE_SCHEMA_V2
        ? normalizeBrowserLogin(parsed.browserLogin)
        : null,
    };
  } catch {
    return {};
  }
}

function serializeAccountProfile(profile = {}) {
  const recipientNickname = boundedOptionalText(profile.recipientNickname, 80, 'Recipient nickname');
  const recipientPhone = boundedOptionalText(profile.recipientPhone, 40, 'Recipient phone');
  const recipientAddress = boundedOptionalText(profile.recipientAddress, 1000, 'Recipient address');
  const browserLogin = normalizeBrowserLogin(profile.browserLogin);
  if (!recipientNickname && !recipientPhone && !recipientAddress && !browserLogin) return null;
  return JSON.stringify({
    schema: PURCHASE_ACCOUNT_PROFILE_SCHEMA_V2,
    recipientNickname,
    recipientPhone,
    recipientAddress,
    ...(browserLogin ? { browserLogin } : {}),
  });
}

function encryptPassword(value) {
  const password = normalizeText(value);
  if (!password) return null;
  return isEncryptedSecret(password) ? password : encryptSecret(password);
}

function hasOwn(input, field) {
  return Object.prototype.hasOwnProperty.call(input, field);
}

function publicAccount(row = {}) {
  const preset = resolvePlatformPreset(row.platform_name, row.name);
  const accountProfile = parseAccountProfile(row.note);
  const browserLogin = accountProfile.browserLogin;
  return {
    id: row.id,
    name: preset?.accountAlias || row.name,
    platformName: preset?.platformName || row.platform_name || '',
    platformUrl: preset?.platformUrl || '',
    loginAccount: row.login_account || '',
    hasLoginPassword: Boolean(row.login_password_encrypted),
    loginPasswordHint: createSavedSecretHint(row.login_password_encrypted),
    recipientNickname: accountProfile.recipientNickname || '',
    recipientPhone: accountProfile.recipientPhone || '',
    recipientAddress: accountProfile.recipientAddress || '',
    browserLoginStatus: browserLogin?.status || '未验证',
    cookieStatus: browserLogin?.cookieStatus || 'Cookie 未保存',
    lastLoginVerifiedAt: browserLogin?.lastVerifiedAt || '',
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPurchaseAccountRepository(db) {
  const selectSql = `
    SELECT id, name, platform_name, login_account, login_password_encrypted,
      default_usage, risk_note, note, is_default, created_at, updated_at
    FROM purchase_accounts
  `;
  let getRowStatement = null;
  let clearDefaultAccountStatement = null;
  let upsertAccountStatement = null;

  function getRow(id) {
    const normalizedId = normalizeText(id);
    if (!normalizedId) return null;
    if (!getRowStatement) getRowStatement = db.prepare(`${selectSql} WHERE id = ?`);
    return getRowStatement.get(normalizedId) || null;
  }

  function getClearDefaultAccountStatement() {
    if (!clearDefaultAccountStatement) {
      clearDefaultAccountStatement = db.prepare('UPDATE purchase_accounts SET is_default = 0');
    }
    return clearDefaultAccountStatement;
  }

  function getUpsertAccountStatement() {
    if (upsertAccountStatement) return upsertAccountStatement;
    upsertAccountStatement = db.prepare(`
      INSERT INTO purchase_accounts (
        id, name, platform_name, login_account, login_password_encrypted,
        default_usage, risk_note, note, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, platform_name = excluded.platform_name,
        login_account = excluded.login_account, login_password_encrypted = excluded.login_password_encrypted,
        default_usage = excluded.default_usage, risk_note = excluded.risk_note, note = excluded.note,
        is_default = excluded.is_default, updated_at = excluded.updated_at
    `);
    return upsertAccountStatement;
  }

  function toStoredAccount(input = {}, existing = null) {
    const requestedId = normalizeText(input.id ?? input.accountId);
    if (requestedId.length > 128) throw new Error('Purchase account id is too long.');
    const requestedPlatformName = normalizeText(input.platformName ?? input.platform_name ?? existing?.platform_name);
    const requestedName = normalizeText(input.name ?? input.accountAlias ?? input.title ?? existing?.name);
    const preset = resolvePlatformPreset(requestedPlatformName, requestedName);
    if (requestedPlatformName && !preset) throw new Error('Purchase account platform is invalid.');
    const requestedPlatformUrl = normalizeText(input.platformUrl ?? input.platform_url);
    if (preset && requestedPlatformUrl && requestedPlatformUrl !== preset.platformUrl) {
      throw new Error('Purchase account platform URL does not match the selected platform.');
    }
    const name = boundedOptionalText(preset?.accountAlias || requestedName, 80, 'Purchase account name');
    if (!name) throw new Error('Purchase account name is required.');
    const existingAccountProfile = parseAccountProfile(existing?.note);
    const accountProfile = {
      recipientNickname: hasOwn(input, 'recipientNickname') || hasOwn(input, 'recipient_nickname')
        ? input.recipientNickname ?? input.recipient_nickname
        : existingAccountProfile.recipientNickname,
      recipientPhone: hasOwn(input, 'recipientPhone') || hasOwn(input, 'recipient_phone')
        ? input.recipientPhone ?? input.recipient_phone
        : existingAccountProfile.recipientPhone,
      recipientAddress: hasOwn(input, 'recipientAddress') || hasOwn(input, 'recipient_address')
        ? input.recipientAddress ?? input.recipient_address
        : existingAccountProfile.recipientAddress,
      browserLogin: existingAccountProfile.browserLogin,
    };
    const passwordProvided = hasOwn(input, 'loginPassword')
      || hasOwn(input, 'login_password')
      || hasOwn(input, 'loginPasswordEncrypted');
    const requestedDefault = input.isDefault ?? input.is_default ?? existing?.is_default ?? false;
    return {
      id: requestedId || `purchase_${randomUUID()}`,
      name,
      platform_name: optionalText(preset?.platformName || requestedPlatformName),
      login_account: optionalText(
        boundedOptionalText(input.loginAccount ?? input.login_account ?? existing?.login_account, 256, 'Login account')
      ),
      login_password_encrypted: passwordProvided
        ? encryptPassword(input.loginPasswordEncrypted ?? input.loginPassword ?? input.login_password)
        : existing?.login_password_encrypted || null,
      // Physical legacy columns are retained for backup compatibility, but their old UI meanings are retired.
      default_usage: null,
      risk_note: null,
      note: serializeAccountProfile(accountProfile),
      is_default: requestedDefault ? 1 : 0,
    };
  }

  function persistAccount(account, existing, timestamp) {
    getUpsertAccountStatement().run(
      account.id,
      account.name,
      account.platform_name,
      account.login_account,
      account.login_password_encrypted,
      account.default_usage,
      account.risk_note,
      account.note,
      account.is_default,
      existing?.created_at || timestamp,
      timestamp,
    );
  }

  function listAccounts() {
    return db.prepare(`${selectSql} ORDER BY is_default DESC, updated_at DESC, name ASC`).all().map(publicAccount);
  }

  function saveAccount(input = {}) {
    const requestedId = normalizeText(input.id ?? input.accountId);
    const existing = requestedId ? getRow(requestedId) : null;
    const account = toStoredAccount(input, existing);
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (account.is_default) getClearDefaultAccountStatement().run();
      persistAccount(account, existing, timestamp);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, created: !existing, account: publicAccount(getRow(account.id)) };
  }

  function saveLoginState(accountId, input = {}) {
    const id = normalizeText(accountId);
    if (!id) throw new Error('PURCHASE_BROWSER_ACCOUNT_ID_REQUIRED');
    const existing = getRow(id);
    if (!existing) throw new Error('PURCHASE_BROWSER_ACCOUNT_NOT_FOUND');
    if (input.loggedIn !== true || input.cookieSaved !== true) {
      throw new Error('PURCHASE_BROWSER_LOGIN_NOT_VERIFIED');
    }
    const verifiedAt = normalizeText(input.verifiedAt);
    const verifiedTime = Date.parse(verifiedAt);
    if (!Number.isFinite(verifiedTime)) throw new Error('PURCHASE_BROWSER_LOGIN_VERIFIED_AT_INVALID');
    const existingProfile = parseAccountProfile(existing.note);
    const note = serializeAccountProfile({
      ...existingProfile,
      browserLogin: {
        status: '已登录',
        cookieStatus: 'Cookie 已保存',
        lastVerifiedAt: new Date(verifiedTime).toISOString(),
      },
    });
    const timestamp = nowIso();
    db.prepare('UPDATE purchase_accounts SET note = ?, updated_at = ? WHERE id = ?').run(note, timestamp, id);
    const account = publicAccount(getRow(id));
    if (account.cookieStatus !== 'Cookie 已保存' || !account.lastLoginVerifiedAt) {
      throw new Error('PURCHASE_BROWSER_LOGIN_READBACK_FAILED');
    }
    return { ok: true, account };
  }

  function deleteAccount(accountId) {
    const id = normalizeText(accountId);
    if (!id) throw new Error('Purchase account id is required.');
    throw new Error('ACCOUNT_REMOVAL_LEGACY_PRIMITIVE_DISABLED');
  }

  function getCredentialsForInternalUse(accountId) {
    const row = getRow(accountId);
    if (!row) return null;
    return {
      accountId: row.id,
      loginAccount: row.login_account || null,
      loginPassword: decryptSecret(row.login_password_encrypted),
      hasLoginPassword: Boolean(row.login_password_encrypted),
    };
  }

  return {
    listAccounts,
    saveAccount,
    saveLoginState,
    deleteAccount,
    getCredentialsForInternalUse,
  };
}
