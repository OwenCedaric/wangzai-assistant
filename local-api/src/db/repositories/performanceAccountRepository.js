import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../security/secretCrypto.js';
import { createSavedSecretHint } from '../../security/secretPresentation.js';

const VALID_STATUSES = new Set(['inactive', 'active', 'disabled', 'error']);
import { configurePerformanceSnapshotRuntime } from '../../integrations/performanceSnapshotRuntime.js';
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

function createAccountId() {
  return `performance_${randomUUID()}`;
}

function normalizeEncryptedSecret(value) {
  const secret = normalizeText(value);
  if (!secret) return null;
  return isEncryptedSecret(secret) ? secret : encryptSecret(secret);
}

function hasOwn(input, name) {
  return Object.prototype.hasOwnProperty.call(input, name);
}

function shouldClearClientSecret(input = {}) {
  return input.clearClientSecret === true || input.clearPerformanceClientSecret === true;
}

function toPublicAccount(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    title: row.name,
    status: row.status || 'inactive',
    shopId: row.shop_id || '',
    hasClientId: Boolean(row.client_id),
    hasClientSecret: Boolean(row.client_secret_encrypted),
    clientId: row.client_id || '',
    clientIdMasked: row.client_id ? '已填写' : '',
    clientSecretHint: createSavedSecretHint(row.client_secret_encrypted),
    lastTestAt: row.last_test_at || '',
    lastTestMessage: row.last_test_message || '',
    campaignCount: row.campaign_count ?? null,
    statisticsTaskCount: row.statistics_task_count ?? null,
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeAccountInput(input = {}, existing = null) {
  const requestedId = normalizeText(input.id ?? input.accountId);
  const name = normalizeText(input.name ?? input.title ?? input.platformName ?? existing?.name);
  if (!name) throw new Error('Performance account name is required.');

  const hasClientSecretField =
    hasOwn(input, 'clientSecret') ||
    hasOwn(input, 'client_secret') ||
    hasOwn(input, 'performanceClientSecret') ||
    hasOwn(input, 'clientSecretEncrypted');

  const clientSecretCandidate =
    input.clientSecretEncrypted ??
    input.clientSecret ??
    input.client_secret ??
    input.performanceClientSecret;
  const normalizedClientSecretCandidate = normalizeText(clientSecretCandidate);
  const clearClientSecret = shouldClearClientSecret(input);
  const hasShopIdField = hasOwn(input, 'shopId') || hasOwn(input, 'shop_id');

  return {
    id: requestedId || createAccountId(),
    name,
    status: normalizeStatus(input.status ?? existing?.status),
    shop_id: hasShopIdField
      ? normalizeOptionalText(input.shopId ?? input.shop_id)
      : existing?.shop_id || null,
    client_id: normalizeOptionalText(
      input.clientId ?? input.client_id ?? input.performanceClientId ?? existing?.client_id,
    ),
    // A masked password field is returned to the renderer as an empty string.
    // Empty/missing input therefore means "keep the saved secret".  Clearing a
    // credential is deliberately separate and must use clearClientSecret=true.
    client_secret_encrypted: clearClientSecret
      ? null
      : hasClientSecretField && normalizedClientSecretCandidate
        ? normalizeEncryptedSecret(normalizedClientSecretCandidate)
        : existing?.client_secret_encrypted || null,
    last_test_at: normalizeOptionalText(input.lastTestAt ?? input.last_test_at ?? existing?.last_test_at),
    last_test_message: normalizeOptionalText(
      input.lastTestMessage ?? input.last_test_message ?? existing?.last_test_message,
    ),
    campaign_count:
      input.campaignCount ?? input.campaign_count ?? existing?.campaign_count ?? null,
    statistics_task_count:
      input.statisticsTaskCount ??
      input.statistics_task_count ??
      existing?.statistics_task_count ??
      null,
    note: normalizeOptionalText(input.note ?? existing?.note),
  };
}

export function createPerformanceAccountRepository(db) {
  configurePerformanceSnapshotRuntime(db);
  const selectSql = `
    SELECT id, name, status, shop_id, client_id, client_secret_encrypted, last_test_at,
      last_test_message, campaign_count, statistics_task_count, note, created_at, updated_at
    FROM performance_accounts
  `;
  let getAccountStatement = null;
  let upsertAccountStatement = null;

  function getAccountRow(accountId) {
    const id = normalizeText(accountId);
    if (!id) return null;
    if (!getAccountStatement) getAccountStatement = db.prepare(`${selectSql} WHERE id = ?`);
    return getAccountStatement.get(id) || null;
  }

  function getUpsertAccountStatement() {
    if (upsertAccountStatement) return upsertAccountStatement;
    upsertAccountStatement = db.prepare(`
      INSERT INTO performance_accounts (
        id, name, status, shop_id, client_id, client_secret_encrypted, last_test_at,
        last_test_message, campaign_count, statistics_task_count, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        shop_id = excluded.shop_id,
        client_id = excluded.client_id,
        client_secret_encrypted = excluded.client_secret_encrypted,
        last_test_at = excluded.last_test_at,
        last_test_message = excluded.last_test_message,
        campaign_count = excluded.campaign_count,
        statistics_task_count = excluded.statistics_task_count,
        note = excluded.note,
        updated_at = excluded.updated_at
    `);
    return upsertAccountStatement;
  }

  function persistAccount(account, existing, timestamp) {
    getUpsertAccountStatement().run(
      account.id,
      account.name,
      account.status,
      account.shop_id,
      account.client_id,
      account.client_secret_encrypted,
      account.last_test_at,
      account.last_test_message,
      account.campaign_count,
      account.statistics_task_count,
      account.note,
      existing?.created_at || timestamp,
      timestamp,
    );
  }

  function listAccounts() {
    return db
      .prepare(`${selectSql} ORDER BY updated_at DESC, name ASC`)
      .all()
      .map(toPublicAccount);
  }

  function getPublicAccountById(accountId) {
    return toPublicAccount(getAccountRow(accountId));
  }

  function getCredentialsForInternalUse(accountId) {
    const row = getAccountRow(accountId);
    if (!row) return null;
    return {
      accountId: row.id,
      shopId: row.shop_id || null,
      clientId: row.client_id || null,
      clientSecret: decryptSecret(row.client_secret_encrypted),
      hasClientId: Boolean(row.client_id),
      hasClientSecret: Boolean(row.client_secret_encrypted),
    };
  }

  function saveAccount(input = {}) {
    const requestedId = normalizeText(input.id ?? input.accountId);
    const existing = requestedId ? getAccountRow(requestedId) : null;
    const account = normalizeAccountInput(input, existing);
    if (account.shop_id) {
      const shop = db
        .prepare("SELECT id, status FROM shops WHERE id = ? LIMIT 1")
        .get(account.shop_id);
      if (!shop) throw new Error('PERFORMANCE_ACCOUNT_SHOP_NOT_FOUND');
      if (shop.status === 'disabled') throw new Error('PERFORMANCE_ACCOUNT_SHOP_DISABLED');
    }
    const timestamp = nowIso();
    persistAccount(account, existing, timestamp);
    return { ok: true, created: !existing, account: getPublicAccountById(account.id) };
  }

  function updateTestResult(accountId, payload = {}) {
    const id = normalizeText(accountId);
    if (!id) throw new Error('Performance account id is required.');
    const now = nowIso();
    db.prepare(`
      UPDATE performance_accounts
      SET status = ?, last_test_at = ?, last_test_message = ?,
        campaign_count = ?, statistics_task_count = ?, updated_at = ?
      WHERE id = ?
    `).run(
      payload.ok ? 'active' : 'error',
      now,
      normalizeText(payload.message),
      payload.campaignCount ?? null,
      payload.statisticsTaskCount ?? null,
      now,
      id,
    );
    return getPublicAccountById(id);
  }

  function deleteAccount(accountId) {
    const id = normalizeText(accountId);
    if (!id) throw new Error('Performance account id is required.');
    throw new Error('ACCOUNT_REMOVAL_LEGACY_PRIMITIVE_DISABLED');
  }

  return {
    listAccounts,
    getPublicAccountById,
    getCredentialsForInternalUse,
    saveAccount,
    updateTestResult,
    deleteAccount,
  };
}
