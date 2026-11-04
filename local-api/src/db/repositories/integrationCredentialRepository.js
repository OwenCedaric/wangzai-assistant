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

function hasOwn(input, name) {
  return Object.prototype.hasOwnProperty.call(input, name);
}

function encryptOptionalSecret(value) {
  const secret = normalizeText(value);
  if (!secret) return null;
  return isEncryptedSecret(secret) ? secret : encryptSecret(secret);
}

function parseMetadata(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function publicCredential(row = {}) {
  return {
    profileId: row.profile_id,
    baseUrl: row.base_url || '',
    loginAccount: row.login_account || '',
    hasLoginPassword: Boolean(row.login_password_encrypted),
    loginPasswordHint: createSavedSecretHint(row.login_password_encrypted),
    hasApiKey: Boolean(row.api_key_encrypted),
    apiKeyHint: createSavedSecretHint(row.api_key_encrypted),
    lastTestStatus: row.last_test_status || '',
    lastTestMessage: row.last_test_message || '',
    lastTestAt: row.last_test_at || '',
    lastTestMetadata: parseMetadata(row.last_test_metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createIntegrationCredentialRepository(db) {
  const selectSql = `
    SELECT profile_id, base_url, login_account, login_password_encrypted,
      api_key_encrypted, last_test_status, last_test_message, last_test_at,
      last_test_metadata_json, created_at, updated_at
    FROM integration_credentials
  `;
  const getRow = (profileId) => db.prepare(`${selectSql} WHERE profile_id = ?`)
    .get(normalizeText(profileId)) || null;

  function listCredentials() {
    return db.prepare(`${selectSql} ORDER BY updated_at DESC, profile_id ASC`).all().map(publicCredential);
  }

  function getCredential(profileId) {
    const row = getRow(profileId);
    return row ? publicCredential(row) : null;
  }

  function saveCredential(profileId, input = {}) {
    const id = normalizeText(profileId);
    if (!id) throw new Error('Integration profile id is required.');
    const existing = getRow(id);
    const baseUrl = normalizeText(input.baseUrl ?? input.base_url ?? existing?.base_url);
    if (!baseUrl) throw new Error('Integration base URL is required.');
    const loginPasswordProvided = hasOwn(input, 'loginPassword') || hasOwn(input, 'login_password');
    const apiKeyProvided = hasOwn(input, 'apiKey') || hasOwn(input, 'api_key') || hasOwn(input, 'token');
    const connectionChanged = baseUrl !== normalizeText(existing?.base_url) || apiKeyProvided;
    const timestamp = nowIso();
    const stored = {
      profile_id: id,
      base_url: baseUrl,
      login_account: optionalText(input.loginAccount ?? input.login_account ?? existing?.login_account),
      login_password_encrypted: loginPasswordProvided
        ? encryptOptionalSecret(input.loginPassword ?? input.login_password)
        : existing?.login_password_encrypted || null,
      api_key_encrypted: apiKeyProvided
        ? encryptOptionalSecret(input.apiKey ?? input.api_key ?? input.token)
        : existing?.api_key_encrypted || null,
      last_test_status: connectionChanged ? null : existing?.last_test_status || null,
      last_test_message: connectionChanged ? null : existing?.last_test_message || null,
      last_test_at: connectionChanged ? null : existing?.last_test_at || null,
      last_test_metadata_json: connectionChanged ? null : existing?.last_test_metadata_json || null,
      created_at: existing?.created_at || timestamp,
      updated_at: timestamp,
    };
    db.prepare(`
      INSERT INTO integration_credentials (
        profile_id, base_url, login_account, login_password_encrypted,
        api_key_encrypted, last_test_status, last_test_message, last_test_at,
        last_test_metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        base_url = excluded.base_url,
        login_account = excluded.login_account,
        login_password_encrypted = excluded.login_password_encrypted,
        api_key_encrypted = excluded.api_key_encrypted,
        last_test_status = excluded.last_test_status,
        last_test_message = excluded.last_test_message,
        last_test_at = excluded.last_test_at,
        last_test_metadata_json = excluded.last_test_metadata_json,
        updated_at = excluded.updated_at
    `).run(
      stored.profile_id,
      stored.base_url,
      stored.login_account,
      stored.login_password_encrypted,
      stored.api_key_encrypted,
      stored.last_test_status,
      stored.last_test_message,
      stored.last_test_at,
      stored.last_test_metadata_json,
      stored.created_at,
      stored.updated_at,
    );
    return { ok: true, created: !existing, credential: publicCredential(getRow(id)) };
  }

  function updateTestResult(profileId, result = {}) {
    const id = normalizeText(profileId);
    const existing = getRow(id);
    if (!existing) throw new Error('Integration credential is not configured.');
    const testedAt = normalizeText(result.testedAt) || nowIso();
    db.prepare(`
      UPDATE integration_credentials
      SET last_test_status = ?, last_test_message = ?, last_test_at = ?,
        last_test_metadata_json = ?, updated_at = ?
      WHERE profile_id = ?
    `).run(
      optionalText(result.status),
      optionalText(result.message),
      testedAt,
      result.metadata && typeof result.metadata === 'object' ? JSON.stringify(result.metadata) : null,
      testedAt,
      id,
    );
    return getCredential(id);
  }

  function getCredentialsForInternalUse(profileId) {
    const row = getRow(profileId);
    if (!row) return null;
    return {
      profileId: row.profile_id,
      baseUrl: row.base_url || '',
      loginAccount: row.login_account || '',
      loginPassword: decryptSecret(row.login_password_encrypted),
      apiKey: decryptSecret(row.api_key_encrypted),
      hasLoginPassword: Boolean(row.login_password_encrypted),
      hasApiKey: Boolean(row.api_key_encrypted),
      lastTestStatus: row.last_test_status || '',
      lastTestAt: row.last_test_at || '',
    };
  }

  return {
    listCredentials,
    getCredential,
    saveCredential,
    updateTestResult,
    getCredentialsForInternalUse,
  };
}
