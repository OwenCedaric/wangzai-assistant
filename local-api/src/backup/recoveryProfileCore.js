import { getDataDomain } from '../data/dataDomainRegistry.js';
import { normalizeProfileSettingValue } from '../db/repositories/profileSettingsRepository.js';
import { normalizeProfileAssetInput } from '../db/repositories/profileAssetRepository.js';
import { buildRecoveryRecordKey } from './recoveryExporter.js';
import { canonicalJson } from './recoveryChunkCodec.js';
import {
  assertEncryptedChunk,
  buildEncryptedDomain,
  openProfileDomain,
} from "./recoveryProfileCrypto.js";
import {
  crossBorderAccountRecords,
  followSellerLoginPreferenceRecords,
  integrationCredentialRecords,
  integrationProfileRecords,
  modelApiAccountRecords,
  performanceAccountRecords,
  profileAssetRecords,
  profileSettingRecords,
  purchaseAccountRecords,
  purchaseBrowserReceiptRecords,
  purchaseBrowserTaskRecords,
  purchaseCompletionHistoryRecords,
  restoredPurchaseTaskStatus,
} from "./recoveryProfileRecords.js";
import { RECOVERY_PROFILE_CORE_VERSION } from "./recoveryProfileDomains.js";
export {
  RECOVERY_OWNER_IDENTITY_DOMAINS,
  RECOVERY_OWNER_PROFILE_DOMAINS,
  RECOVERY_PROFILE_CORE_DOMAINS,
  assertRecoveryProfileCoreCandidateShape,
} from "./recoveryProfileDomains.js";
import {
  RECOVERY_OWNER_PROFILE_DOMAINS,
  assertRecoveryProfileCoreCandidateShape,
} from "./recoveryProfileDomains.js";
import {
  assertOwnerScopedCandidateOwner,
  buildOwnerProfileSettingSlice,
  isOwnerScopedProfileRecord,
  mergeOwnerScopedProfileSetting,
  normalizeRemovalOwner,
  remapOwnerScopedProfileSettingRow,
} from "./recoveryProfileOwnerScope.js";
export {
  assertOwnerScopedRecoveryProfileCandidate,
  listRecoveryProfileOwners,
  openOwnerScopedRecoveryProfileCandidate,
  planOwnerScopedRecoveryProfileSettingMerge,
  removeRecoveryProfileOwner,
} from "./recoveryProfileOwnerScope.js";
import { assertOwnerScopedRecoveryProfileCandidate } from "./recoveryProfileOwnerScope.js";

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function assertSqlReadback(row, expected, code) {
  if (!row) throw new Error(code);
  for (const [column, expectedValue] of Object.entries(expected)) {
    const actualValue = row[column];
    if (actualValue === expectedValue) continue;
    if (actualValue == null && expectedValue == null) continue;
    if (String(actualValue) === String(expectedValue)) continue;
    throw new Error(`${code}:${column}`);
  }
}

function publicShopRecord(row) {
  return {
    id: row.id,
    name: row.name,
    alias: row.alias || null,
    status: row.status || 'inactive',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Exports profile-scoped configuration and credentials as separate encrypted chunks. Source
 * secrets are decrypted only in memory and immediately re-encrypted by the recovery codec.
 */
export function createRecoveryProfileCore({ db, decryptShopSecret } = {}) {
  if (!db) throw new Error('createRecoveryProfileCore requires db.');
  if (typeof decryptShopSecret !== 'function') throw new Error('createRecoveryProfileCore requires decryptShopSecret.');

  function collectDomainCandidates() {
    const shopPolicy = getDataDomain('shops');
    const credentialPolicy = getDataDomain('shop-credentials');
    const crossBorderPolicy = getDataDomain('cross-border-accounts');
    const performancePolicy = getDataDomain('performance-accounts');
    const purchasePolicy = getDataDomain('purchase-accounts');
    const modelApiPolicy = getDataDomain('model-api-accounts');
    const integrationProfilePolicy = getDataDomain('integration-profiles');
    const integrationCredentialPolicy = getDataDomain('integration-credentials');
    const followSellerLoginPreferencesPolicy = getDataDomain('follow-seller-login-preferences');
    const profileSettingsPolicy = getDataDomain('profile-settings');
    const profileAssetsPolicy = getDataDomain('profile-assets');
    const purchaseBrowserTasksPolicy = getDataDomain('purchase-browser-tasks');
    const purchaseBrowserReceiptsPolicy = getDataDomain('purchase-browser-receipts');
    const purchaseCompletionHistoryPolicy = getDataDomain('purchase-completion-history');
    const rows = db.prepare(`
      SELECT id, name, alias, client_id, api_key_encrypted, status, created_at, updated_at
      FROM shops ORDER BY id
    `).all();
    const shopRecords = rows.map((row) => ({ key: `id:${row.id}`, value: publicShopRecord(row) }));
    const credentialRecords = rows
      .filter((row) => row.client_id || row.api_key_encrypted)
      .map((row) => {
        let apiKey = null;
        try {
          apiKey = row.api_key_encrypted ? decryptShopSecret(row.api_key_encrypted) : null;
        } catch {
          throw new Error(`BACKUP_SECRET_DECRYPT_FAILED:${row.id}`);
        }
        if (row.api_key_encrypted && !apiKey) throw new Error(`BACKUP_SECRET_DECRYPT_FAILED:${row.id}`);
        const value = { shop_id: row.id, client_id: row.client_id || null, api_key: apiKey || null };
        return { key: buildRecoveryRecordKey(credentialPolicy, value), value };
      });
    const domainCandidates = [
      [shopPolicy, 'profile:shops', shopRecords],
      [credentialPolicy, 'profile:shop-credentials', credentialRecords],
      [crossBorderPolicy, 'profile:cross-border-accounts', crossBorderAccountRecords(db, decryptShopSecret, crossBorderPolicy)],
      [performancePolicy, 'profile:performance-accounts', performanceAccountRecords(db, decryptShopSecret, performancePolicy)],
      [purchasePolicy, 'profile:purchase-accounts', purchaseAccountRecords(db, decryptShopSecret, purchasePolicy)],
      [modelApiPolicy, 'profile:model-api-accounts', modelApiAccountRecords(db, decryptShopSecret, modelApiPolicy)],
      [integrationProfilePolicy, 'profile:integration-profiles', integrationProfileRecords(db, integrationProfilePolicy)],
      [integrationCredentialPolicy, 'profile:integration-credentials', integrationCredentialRecords(db, decryptShopSecret, integrationCredentialPolicy)],
      [
        followSellerLoginPreferencesPolicy,
        'profile:follow-seller-login-preferences',
        followSellerLoginPreferenceRecords(db, followSellerLoginPreferencesPolicy),
      ],
      [profileSettingsPolicy, 'profile:profile-settings', profileSettingRecords(db, profileSettingsPolicy)],
      [profileAssetsPolicy, 'profile:profile-assets', profileAssetRecords(db, profileAssetsPolicy)],
      [
        purchaseBrowserTasksPolicy,
        'profile:purchase-browser-tasks',
        purchaseBrowserTaskRecords(db, decryptShopSecret, purchaseBrowserTasksPolicy),
      ],
      [
        purchaseBrowserReceiptsPolicy,
        'profile:purchase-browser-receipts',
        purchaseBrowserReceiptRecords(db, decryptShopSecret, purchaseBrowserReceiptsPolicy),
      ],
      [
        purchaseCompletionHistoryPolicy,
        'profile:purchase-completion-history',
        purchaseCompletionHistoryRecords(
          db,
          decryptShopSecret,
          purchaseCompletionHistoryPolicy,
        ),
      ],
    ];
    return domainCandidates;
  }

  function encodeDomainCandidates(domainCandidates, { encryptionKey, dedupeKey, aad = '', ownerScope } = {}) {
    const encoded = domainCandidates.map(([policy, partitionKey, records]) =>
      buildEncryptedDomain({ policy, partitionKey, records, encryptionKey, dedupeKey, aad })
    );
    const chunks = encoded.map((item) => item.encrypted);
    const domains = encoded.map((item) => item.manifest);
    return {
      ok: true,
      format: 'wangzai-recovery-profile-core',
      version: RECOVERY_PROFILE_CORE_VERSION,
      ...(ownerScope ? { ownerScope } : {}),
      domains,
      chunks,
      totalCipherBytes: chunks.reduce((total, chunk) => total + chunk.cipherBytes, 0),
    };
  }

  function buildCandidate({ encryptionKey, dedupeKey, aad = '' } = {}) {
    return encodeDomainCandidates(collectDomainCandidates(), { encryptionKey, dedupeKey, aad });
  }

  function buildOwnerCandidate({
    owner: ownerInput,
    encryptionKey,
    dedupeKey,
    aad = '',
    includeDomains,
  } = {}) {
    const owner = normalizeRemovalOwner(ownerInput);
    const allowedDomains = new Set(RECOVERY_OWNER_PROFILE_DOMAINS[owner.ownerType] || []);
    const included = includeDomains === undefined
      ? null
      : new Set((Array.isArray(includeDomains) ? includeDomains : []).map((domain) => String(domain || '').trim()));
    const scoped = collectDomainCandidates().map(([policy, partitionKey, records]) => {
      let ownerRecords = [];
      if (allowedDomains.has(policy.domain) && (!included || included.has(policy.domain))) {
        ownerRecords = policy.domain === 'profile-settings'
          ? records.map((record) => buildOwnerProfileSettingSlice(record, owner)).filter(Boolean)
          : records.filter((record) => isOwnerScopedProfileRecord(policy.domain, record, owner));
      }
      return [
        policy,
        `owner:${owner.ownerType}:${owner.ownerId}:${policy.domain}`,
        ownerRecords,
      ];
    });
    const candidate = encodeDomainCandidates(scoped, {
      encryptionKey,
      dedupeKey,
      aad,
      ownerScope: owner,
    });
    assertOwnerScopedRecoveryProfileCandidate({ candidate, owner, encryptionKey, aad });
    return candidate;
  }

  return { buildCandidate, buildOwnerCandidate };
}

/** Staging-only profile restore. The caller chooses when a verified staging profile becomes active. */
export function createRecoveryProfileCoreImporter({ db, encryptShopSecret } = {}) {
  if (!db) throw new Error('createRecoveryProfileCoreImporter requires db.');
  if (typeof encryptShopSecret !== 'function') throw new Error('createRecoveryProfileCoreImporter requires encryptShopSecret.');

  function importCandidate({
    candidate,
    encryptionKey,
    aad = '',
    manageTransaction = true,
    shopIdMap = null,
    targetProfileId = '',
    preserveExistingShops = false,
    preserveShopCredentials = false,
    missingPurchaseAccount = 'error',
    mergeStrategy = 'overwrite',
  } = {}) {
    if (!candidate?.ok || candidate.format !== 'wangzai-recovery-profile-core') throw new Error('RESTORE_PROFILE_CANDIDATE_INVALID');
    assertRecoveryProfileCoreCandidateShape(candidate);
    const ownerScope = candidate.ownerScope
      ? assertOwnerScopedCandidateOwner(candidate, candidate.ownerScope)
      : null;
    if (ownerScope) {
      assertOwnerScopedRecoveryProfileCandidate({ candidate, owner: ownerScope, encryptionKey, aad });
    }
    const shopsChunk = assertEncryptedChunk(candidate, 'shops');
    const credentialsChunk = assertEncryptedChunk(candidate, 'shop-credentials');
    const shops = openProfileDomain(candidate, 'shops', encryptionKey, aad);
    const credentials = openProfileDomain(candidate, 'shop-credentials', encryptionKey, aad);
    // Older generation v1 objects contain only shops and shop credentials. Missing newer
    // profile chunks are restored as empty; newly produced candidates always include all.
    const crossBorderAccounts = openProfileDomain(candidate, 'cross-border-accounts', encryptionKey, aad, { optional: true });
    const performanceAccounts = openProfileDomain(candidate, 'performance-accounts', encryptionKey, aad, { optional: true });
    const purchaseAccounts = openProfileDomain(candidate, 'purchase-accounts', encryptionKey, aad, { optional: true });
    const modelApiAccounts = openProfileDomain(candidate, 'model-api-accounts', encryptionKey, aad, { optional: true });
    const integrationProfiles = openProfileDomain(candidate, 'integration-profiles', encryptionKey, aad, { optional: true });
    const integrationCredentials = openProfileDomain(candidate, 'integration-credentials', encryptionKey, aad, { optional: true });
    const followSellerLoginPreferences = openProfileDomain(
      candidate,
      'follow-seller-login-preferences',
      encryptionKey,
      aad,
      { optional: true },
    );
    const hasFollowSellerLoginPreferencesDomain = candidate.domains.some(
      (domain) => domain.domain === 'follow-seller-login-preferences',
    );
    const profileSettings = openProfileDomain(candidate, 'profile-settings', encryptionKey, aad, { optional: true });
    const profileAssets = openProfileDomain(candidate, 'profile-assets', encryptionKey, aad, { optional: true });
    const purchaseBrowserTasks = openProfileDomain(
      candidate,
      'purchase-browser-tasks',
      encryptionKey,
      aad,
      { optional: true },
    );
    const purchaseBrowserReceipts = openProfileDomain(
      candidate,
      'purchase-browser-receipts',
      encryptionKey,
      aad,
      { optional: true },
    );
    const purchaseCompletionHistory = openProfileDomain(
      candidate,
      'purchase-completion-history',
      encryptionKey,
      aad,
      { optional: true },
    );
    const hasPurchaseCompletionHistoryDomain = candidate.domains.some(
      (domain) => domain.domain === 'purchase-completion-history',
    );
    if (
      shops.header.domain !== 'shops'
      || credentials.header.domain !== 'shop-credentials'
      || shops.recordsRootHash !== shopsChunk.manifest.recordsRootHash
      || credentials.recordsRootHash !== credentialsChunk.manifest.recordsRootHash
    ) throw new Error('RESTORE_PROFILE_INTEGRITY_MISMATCH');
    const normalizedShopIdMap = shopIdMap && typeof shopIdMap === 'object' && !Array.isArray(shopIdMap)
      ? Object.fromEntries(Object.entries(shopIdMap).map(([source, target]) => [
          normalizeText(source),
          normalizeText(target),
        ]).filter(([source, target]) => source && target))
      : {};
    const mapShopId = (value) => normalizedShopIdMap[normalizeText(value)] || normalizeText(value);
    if (!['preserve', 'overwrite'].includes(mergeStrategy)) {
      throw new Error('RESTORE_PROFILE_MERGE_STRATEGY_INVALID');
    }
    const targetOwnerScope = ownerScope?.ownerType === 'ozon_shop'
      ? { ...ownerScope, ownerId: mapShopId(ownerScope.ownerId) }
      : ownerScope;
    const normalizedTargetProfileId = normalizeText(targetProfileId);
    const includeMergeSummary = preserveExistingShops
      || preserveShopCredentials
      || missingPurchaseAccount === 'skip'
      || normalizedTargetProfileId
      || Object.keys(normalizedShopIdMap).length > 0;
    if (!['error', 'skip'].includes(missingPurchaseAccount)) {
      throw new Error('RESTORE_PROFILE_PURCHASE_ACCOUNT_POLICY_INVALID');
    }
    const sourceShopIds = new Set();
    const shopIds = new Set();
    const skippedPurchaseTaskIds = new Set();
    const preservedPurchaseTaskIds = new Set();
    let skippedPurchaseTasks = 0;
    let skippedPurchaseReceipts = 0;
    let preservedPurchaseTasks = 0;
    let preservedPurchaseReceipts = 0;
    let preservedPurchaseCompletionHistory = 0;
    if (manageTransaction) db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of shops.records) {
        const row = record.value || {};
        if (record.key !== `id:${row.id}` || !normalizeText(row.id) || !normalizeText(row.name)) throw new Error('RESTORE_PROFILE_SHOP_INVALID');
        const sourceShopId = normalizeText(row.id);
        const targetShopId = mapShopId(sourceShopId);
        sourceShopIds.add(sourceShopId);
        shopIds.add(targetShopId);
        const existingShop = db.prepare('SELECT id, profile_id FROM shops WHERE id = ?').get(targetShopId);
        if (
          preserveExistingShops
          && existingShop
          && normalizedTargetProfileId
          && normalizeText(existingShop.profile_id) !== normalizedTargetProfileId
        ) throw new Error('RESTORE_PROFILE_TARGET_SCOPE_MISMATCH');
        if (!(preserveExistingShops && existingShop)) {
          db.prepare(`
            INSERT INTO shops (
              id, name, alias, client_id, api_key_encrypted, status,
              profile_id, created_at, updated_at
            )
            VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name, alias = excluded.alias, status = excluded.status,
              profile_id = excluded.profile_id,
              created_at = excluded.created_at, updated_at = excluded.updated_at
          `).run(
            targetShopId,
            row.name,
            row.alias || null,
            row.status || 'inactive',
            normalizedTargetProfileId || 'default',
            row.created_at,
            row.updated_at,
          );
        }
      }
      const credentialPolicy = getDataDomain('shop-credentials');
      for (const record of credentials.records) {
        const row = record.value || {};
        if (!sourceShopIds.has(row.shop_id) || buildRecoveryRecordKey(credentialPolicy, row) !== record.key) {
          throw new Error('RESTORE_PROFILE_CREDENTIAL_SCOPE_MISMATCH');
        }
        if (preserveShopCredentials) continue;
        const encryptedApiKey = row.api_key ? encryptShopSecret(row.api_key) : null;
        db.prepare(`UPDATE shops SET client_id = ?, api_key_encrypted = ? WHERE id = ?`)
          .run(row.client_id || null, encryptedApiKey, mapShopId(row.shop_id));
      }
      const crossBorderPolicy = getDataDomain('cross-border-accounts');
      for (const record of crossBorderAccounts.records) {
        const row = record.value || {};
        if (!normalizeText(row.id) || !normalizeText(row.name) || buildRecoveryRecordKey(crossBorderPolicy, row) !== record.key) {
          throw new Error('RESTORE_PROFILE_CROSS_BORDER_ACCOUNT_INVALID');
        }
        db.prepare(`
          INSERT INTO cross_border_accounts (
            id, name, status, user_name_encrypted, password_encrypted,
            company_secret_encrypted, access_token_encrypted, expires_token_encrypted, app_uid_encrypted,
            default_storehouse, default_section, default_service, note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, status = excluded.status,
            user_name_encrypted = excluded.user_name_encrypted,
            password_encrypted = excluded.password_encrypted,
            company_secret_encrypted = excluded.company_secret_encrypted,
            access_token_encrypted = excluded.access_token_encrypted,
            expires_token_encrypted = excluded.expires_token_encrypted,
            app_uid_encrypted = excluded.app_uid_encrypted,
            default_storehouse = excluded.default_storehouse, default_section = excluded.default_section,
            default_service = excluded.default_service, note = excluded.note,
            created_at = excluded.created_at, updated_at = excluded.updated_at
        `).run(
          row.id,
          row.name,
          row.status || 'inactive',
          row.user_name ? encryptShopSecret(row.user_name) : null,
          row.password ? encryptShopSecret(row.password) : null,
          row.company_secret ? encryptShopSecret(row.company_secret) : null,
          row.access_token ? encryptShopSecret(row.access_token) : null,
          row.expires_token ? encryptShopSecret(row.expires_token) : null,
          row.app_uid ? encryptShopSecret(row.app_uid) : null,
          row.default_storehouse || null,
          row.default_section || null,
          row.default_service || null,
          row.note || null,
          row.created_at,
          row.updated_at,
        );
      }
      const performancePolicy = getDataDomain('performance-accounts');
      for (const record of performanceAccounts.records) {
        const row = record.value || {};
        if (!normalizeText(row.id) || !normalizeText(row.name) || buildRecoveryRecordKey(performancePolicy, row) !== record.key) {
          throw new Error('RESTORE_PROFILE_PERFORMANCE_ACCOUNT_INVALID');
        }
        db.prepare(`
          INSERT INTO performance_accounts (
            id, name, status, shop_id, client_id, client_secret_encrypted, last_test_at,
            last_test_message, campaign_count, statistics_task_count, note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, status = excluded.status, shop_id = excluded.shop_id,
            client_id = excluded.client_id,
            client_secret_encrypted = excluded.client_secret_encrypted,
            last_test_at = excluded.last_test_at, last_test_message = excluded.last_test_message,
            campaign_count = excluded.campaign_count,
            statistics_task_count = excluded.statistics_task_count,
            note = excluded.note, created_at = excluded.created_at, updated_at = excluded.updated_at
        `).run(
          row.id,
          row.name,
          row.status || 'inactive',
          row.shop_id || null,
          row.client_id || null,
          row.client_secret ? encryptShopSecret(row.client_secret) : null,
          row.last_test_at || null,
          row.last_test_message || null,
          row.campaign_count ?? null,
          row.statistics_task_count ?? null,
          row.note || null,
          row.created_at,
          row.updated_at,
        );
      }
      const purchasePolicy = getDataDomain('purchase-accounts');
      for (const record of purchaseAccounts.records) {
        const row = record.value || {};
        if (!normalizeText(row.id) || !normalizeText(row.name) || buildRecoveryRecordKey(purchasePolicy, row) !== record.key) {
          throw new Error('RESTORE_PROFILE_PURCHASE_ACCOUNT_INVALID');
        }
        db.prepare(`
          INSERT INTO purchase_accounts (
            id, name, platform_name, login_account, login_password_encrypted,
            default_usage, risk_note, note, is_default, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, platform_name = excluded.platform_name,
            login_account = excluded.login_account, login_password_encrypted = excluded.login_password_encrypted,
            default_usage = excluded.default_usage, risk_note = excluded.risk_note, note = excluded.note,
            is_default = excluded.is_default, created_at = excluded.created_at, updated_at = excluded.updated_at
        `).run(
          row.id, row.name, row.platform_name || null, row.login_account || null,
          row.login_password ? encryptShopSecret(row.login_password) : null,
          row.default_usage || null, row.risk_note || null, row.note || null,
          Number(row.is_default) === 1 ? 1 : 0, row.created_at, row.updated_at,
        );
      }
      const purchaseBrowserTasksPolicy = getDataDomain('purchase-browser-tasks');
      for (const record of purchaseBrowserTasks.records) {
        const row = record.value || {};
        const account = db.prepare('SELECT created_at FROM purchase_accounts WHERE id = ?').get(row.owner_id);
        const status = restoredPurchaseTaskStatus(row.status);
        const preview = row.preview && typeof row.preview === 'object' && !Array.isArray(row.preview)
          ? row.preview
          : null;
        if (
          !normalizeText(row.id)
          || !preview
          || preview.ownerId !== row.owner_id
          || preview.ownerIncarnation !== row.owner_incarnation
          || buildRecoveryRecordKey(purchaseBrowserTasksPolicy, row) !== record.key
          || !/^[a-f0-9]{64}$/u.test(String(row.idempotency_key_hash || ''))
          || !/^[a-f0-9]{64}$/u.test(String(row.request_fingerprint || ''))
          || !/^[a-f0-9]{64}$/u.test(String(row.preview_fingerprint || ''))
          || !Number.isSafeInteger(Number(row.attempt_count))
          || Number(row.attempt_count) < 0
          || (status === 'completed' && !normalizeText(row.receipt_id))
        ) {
          throw new Error('RESTORE_PURCHASE_BROWSER_TASK_INVALID');
        }
        if (!account || normalizeText(account.created_at) !== normalizeText(row.owner_incarnation)) {
          if (missingPurchaseAccount === 'skip') {
            skippedPurchaseTaskIds.add(row.id);
            skippedPurchaseTasks += 1;
            continue;
          }
          throw new Error('RESTORE_PURCHASE_BROWSER_TASK_INVALID');
        }
        const mappedTaskShopId = row.shop_id ? mapShopId(row.shop_id) : null;
        const existingTask = db.prepare(`
          SELECT id, owner_id, owner_incarnation, shop_id
          FROM purchase_browser_tasks WHERE id = ?
        `).get(row.id);
        if (mergeStrategy === 'preserve' && existingTask) {
          if (
            existingTask.owner_id !== row.owner_id
            || existingTask.owner_incarnation !== row.owner_incarnation
            || normalizeText(existingTask.shop_id) !== normalizeText(mappedTaskShopId)
          ) throw new Error('RESTORE_PURCHASE_BROWSER_TASK_SCOPE_MISMATCH');
          preservedPurchaseTaskIds.add(row.id);
          preservedPurchaseTasks += 1;
          continue;
        }
        const previewEncrypted = encryptShopSecret(JSON.stringify(preview));
        const restoredLastError = status === 'interrupted'
          ? 'PURCHASE_BROWSER_PROCESS_INTERRUPTED'
          : row.last_error_code || null;
        const restoredCompletedAt = status === 'completed' ? row.completed_at || null : null;
        db.prepare(`
          INSERT INTO purchase_browser_tasks (
            id, owner_id, owner_incarnation, shop_id, order_key, product_key,
            idempotency_key_hash, request_fingerprint, preview_encrypted,
            preview_fingerprint, status, execution_capability_hash, attempt_id,
            attempt_count, receipt_id, last_error_code, created_at, updated_at,
            confirmed_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            owner_id = excluded.owner_id, owner_incarnation = excluded.owner_incarnation,
            shop_id = excluded.shop_id, order_key = excluded.order_key, product_key = excluded.product_key,
            idempotency_key_hash = excluded.idempotency_key_hash,
            request_fingerprint = excluded.request_fingerprint,
            preview_encrypted = excluded.preview_encrypted,
            preview_fingerprint = excluded.preview_fingerprint, status = excluded.status,
            execution_capability_hash = NULL, attempt_id = NULL,
            attempt_count = excluded.attempt_count, receipt_id = excluded.receipt_id,
            last_error_code = excluded.last_error_code, created_at = excluded.created_at,
            updated_at = excluded.updated_at, confirmed_at = excluded.confirmed_at,
            completed_at = excluded.completed_at
        `).run(
          row.id,
          row.owner_id,
          row.owner_incarnation,
          mappedTaskShopId,
          row.order_key,
          row.product_key,
          row.idempotency_key_hash,
          row.request_fingerprint,
          previewEncrypted,
          row.preview_fingerprint,
          status,
          Number(row.attempt_count),
          row.receipt_id || null,
          restoredLastError,
          row.created_at,
          row.updated_at,
          row.confirmed_at || null,
          restoredCompletedAt,
        );
        const taskReadback = db.prepare(`
          SELECT id, owner_id, owner_incarnation, shop_id, order_key, product_key,
            idempotency_key_hash, request_fingerprint, preview_encrypted,
            preview_fingerprint, status, execution_capability_hash, attempt_id,
            attempt_count, receipt_id, last_error_code, created_at, updated_at,
            confirmed_at, completed_at
          FROM purchase_browser_tasks WHERE id = ?
        `).get(row.id);
        assertSqlReadback(taskReadback, {
          id: row.id,
          owner_id: row.owner_id,
          owner_incarnation: row.owner_incarnation,
          shop_id: mappedTaskShopId,
          order_key: row.order_key,
          product_key: row.product_key,
          idempotency_key_hash: row.idempotency_key_hash,
          request_fingerprint: row.request_fingerprint,
          preview_encrypted: previewEncrypted,
          preview_fingerprint: row.preview_fingerprint,
          status,
          execution_capability_hash: null,
          attempt_id: null,
          attempt_count: Number(row.attempt_count),
          receipt_id: row.receipt_id || null,
          last_error_code: restoredLastError,
          created_at: row.created_at,
          updated_at: row.updated_at,
          confirmed_at: row.confirmed_at || null,
          completed_at: restoredCompletedAt,
        }, 'RESTORE_PURCHASE_BROWSER_TASK_READBACK_FAILED');
      }
      const purchaseBrowserReceiptsPolicy = getDataDomain('purchase-browser-receipts');
      for (const record of purchaseBrowserReceipts.records) {
        const row = record.value || {};
        const receiptRecordValid = (
          normalizeText(row.id)
          && row.receipt
          && typeof row.receipt === 'object'
          && !Array.isArray(row.receipt)
          && buildRecoveryRecordKey(purchaseBrowserReceiptsPolicy, row) === record.key
          && /^[a-f0-9]{64}$/u.test(String(row.receipt_hash || ''))
          && /^[a-f0-9]{64}$/u.test(String(row.website_readback_hash || ''))
        );
        if (!receiptRecordValid) throw new Error('RESTORE_PURCHASE_BROWSER_RECEIPT_INVALID');
        if (skippedPurchaseTaskIds.has(row.task_id)) {
          skippedPurchaseReceipts += 1;
          continue;
        }
        if (preservedPurchaseTaskIds.has(row.task_id)) {
          const existingReceipt = db.prepare(
            'SELECT task_id, owner_id, shop_id FROM purchase_browser_receipts WHERE id = ?',
          ).get(row.id);
          if (existingReceipt) {
            if (
              existingReceipt.task_id !== row.task_id
              || existingReceipt.owner_id !== row.owner_id
              || normalizeText(existingReceipt.shop_id)
                !== normalizeText(row.shop_id ? mapShopId(row.shop_id) : null)
            ) throw new Error('RESTORE_PURCHASE_BROWSER_RECEIPT_SCOPE_MISMATCH');
            preservedPurchaseReceipts += 1;
          }
          else skippedPurchaseReceipts += 1;
          continue;
        }
        const mappedReceiptShopId = row.shop_id ? mapShopId(row.shop_id) : null;
        const existingReceipt = db.prepare(`
          SELECT task_id, owner_id, shop_id FROM purchase_browser_receipts WHERE id = ?
        `).get(row.id);
        if (mergeStrategy === 'preserve' && existingReceipt) {
          if (
            existingReceipt.task_id !== row.task_id
            || existingReceipt.owner_id !== row.owner_id
            || normalizeText(existingReceipt.shop_id) !== normalizeText(mappedReceiptShopId)
          ) throw new Error('RESTORE_PURCHASE_BROWSER_RECEIPT_SCOPE_MISMATCH');
          preservedPurchaseReceipts += 1;
          continue;
        }
        const task = db.prepare(`
          SELECT owner_id, shop_id, receipt_id, status
          FROM purchase_browser_tasks WHERE id = ?
        `).get(row.task_id);
        const receipt = row.receipt && typeof row.receipt === 'object' && !Array.isArray(row.receipt)
          ? row.receipt
          : null;
        if (
          !normalizeText(row.id)
          || !task
          || task.owner_id !== row.owner_id
          || String(task.shop_id || '') !== String(mappedReceiptShopId || '')
          || task.receipt_id !== row.id
          || task.status !== 'completed'
          || !receipt
        ) {
          throw new Error('RESTORE_PURCHASE_BROWSER_RECEIPT_INVALID');
        }
        const receiptEncrypted = encryptShopSecret(JSON.stringify(receipt));
        db.prepare(`
          INSERT INTO purchase_browser_receipts (
            id, task_id, owner_id, shop_id, attempt_id, receipt_encrypted,
            receipt_hash, website_readback_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            task_id = excluded.task_id, owner_id = excluded.owner_id, shop_id = excluded.shop_id,
            attempt_id = excluded.attempt_id, receipt_encrypted = excluded.receipt_encrypted,
            receipt_hash = excluded.receipt_hash,
            website_readback_hash = excluded.website_readback_hash,
            created_at = excluded.created_at
        `).run(
          row.id,
          row.task_id,
          row.owner_id,
          mappedReceiptShopId,
          row.attempt_id,
          receiptEncrypted,
          row.receipt_hash,
          row.website_readback_hash,
          row.created_at,
        );
        const receiptReadback = db.prepare(`
          SELECT id, task_id, owner_id, shop_id, attempt_id, receipt_encrypted,
            receipt_hash, website_readback_hash, created_at
          FROM purchase_browser_receipts WHERE id = ?
        `).get(row.id);
        assertSqlReadback(receiptReadback, {
          id: row.id,
          task_id: row.task_id,
          owner_id: row.owner_id,
          shop_id: mappedReceiptShopId,
          attempt_id: row.attempt_id,
          receipt_encrypted: receiptEncrypted,
          receipt_hash: row.receipt_hash,
          website_readback_hash: row.website_readback_hash,
          created_at: row.created_at,
        }, 'RESTORE_PURCHASE_BROWSER_RECEIPT_READBACK_FAILED');
      }
      const purchaseCompletionHistoryPolicy = getDataDomain('purchase-completion-history');
      for (const record of purchaseCompletionHistory.records) {
        const row = record.value || {};
        const receipt = row.receipt && typeof row.receipt === 'object' && !Array.isArray(row.receipt)
          ? row.receipt
          : null;
        const orderProduct = row.order_product
          && typeof row.order_product === 'object'
          && !Array.isArray(row.order_product)
          ? row.order_product
          : null;
        const sourceSummary = row.source_summary
          && typeof row.source_summary === 'object'
          && !Array.isArray(row.source_summary)
          ? row.source_summary
          : null;
        if (
          !sourceShopIds.has(row.shop_id)
          || !normalizeText(row.source_task_id)
          || !normalizeText(row.source_receipt_id)
          || !receipt
          || !orderProduct
          || !sourceSummary
          || !normalizeText(row.archive_origin)
          || !normalizeText(row.completed_at)
          || !normalizeText(row.archived_at)
          || !normalizeText(row.created_at)
          || !normalizeText(row.updated_at)
          || buildRecoveryRecordKey(purchaseCompletionHistoryPolicy, row) !== record.key
          || !/^[a-f0-9]{64}$/u.test(String(row.source_account_ref_hash || ''))
          || !/^[a-f0-9]{64}$/u.test(String(row.order_number_hash || ''))
          || !/^[a-f0-9]{64}$/u.test(String(row.receipt_hash || ''))
          || !/^[a-f0-9]{64}$/u.test(String(row.website_readback_hash || ''))
          || !/^[a-f0-9]{64}$/u.test(String(row.order_product_hash || ''))
          || !/^[a-f0-9]{64}$/u.test(String(row.source_summary_hash || ''))
        ) {
          throw new Error('RESTORE_PURCHASE_COMPLETION_HISTORY_INVALID');
        }
        const mappedHistoryShopId = mapShopId(row.shop_id);
        const existingHistory = db.prepare(`
          SELECT shop_id, source_receipt_id FROM purchase_completion_history
          WHERE shop_id = ? AND source_receipt_id = ?
        `).get(mappedHistoryShopId, row.source_receipt_id);
        if (mergeStrategy === 'preserve' && existingHistory) {
          preservedPurchaseCompletionHistory += 1;
          continue;
        }
        const historyReceiptEncrypted = encryptShopSecret(JSON.stringify(receipt));
        const historyOrderProductEncrypted = encryptShopSecret(JSON.stringify(orderProduct));
        const historySourceSummaryEncrypted = encryptShopSecret(JSON.stringify(sourceSummary));
        db.prepare(`
          INSERT INTO purchase_completion_history (
            shop_id, source_task_id, source_receipt_id,
            source_account_ref_hash, order_number_hash, receipt_encrypted,
            receipt_hash, website_readback_hash, order_product_encrypted,
            order_product_hash, source_summary_encrypted, source_summary_hash,
            archive_origin, completed_at, archived_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(shop_id, source_receipt_id) DO UPDATE SET
            source_task_id = excluded.source_task_id,
            source_account_ref_hash = excluded.source_account_ref_hash,
            order_number_hash = excluded.order_number_hash,
            receipt_encrypted = excluded.receipt_encrypted,
            receipt_hash = excluded.receipt_hash,
            website_readback_hash = excluded.website_readback_hash,
            order_product_encrypted = excluded.order_product_encrypted,
            order_product_hash = excluded.order_product_hash,
            source_summary_encrypted = excluded.source_summary_encrypted,
            source_summary_hash = excluded.source_summary_hash,
            archive_origin = excluded.archive_origin,
            completed_at = excluded.completed_at,
            archived_at = excluded.archived_at,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `).run(
          mappedHistoryShopId,
          row.source_task_id,
          row.source_receipt_id,
          row.source_account_ref_hash,
          row.order_number_hash,
          historyReceiptEncrypted,
          row.receipt_hash,
          row.website_readback_hash,
          historyOrderProductEncrypted,
          row.order_product_hash,
          historySourceSummaryEncrypted,
          row.source_summary_hash,
          row.archive_origin,
          row.completed_at,
          row.archived_at,
          row.created_at,
          row.updated_at,
        );
        const historyReadback = db.prepare(`
          SELECT shop_id, source_task_id, source_receipt_id,
            source_account_ref_hash, order_number_hash, receipt_encrypted,
            receipt_hash, website_readback_hash, order_product_encrypted,
            order_product_hash, source_summary_encrypted, source_summary_hash,
            archive_origin, completed_at, archived_at, created_at, updated_at
          FROM purchase_completion_history
          WHERE shop_id = ? AND source_receipt_id = ?
        `).get(mappedHistoryShopId, row.source_receipt_id);
        assertSqlReadback(historyReadback, {
          shop_id: mappedHistoryShopId,
          source_task_id: row.source_task_id,
          source_receipt_id: row.source_receipt_id,
          source_account_ref_hash: row.source_account_ref_hash,
          order_number_hash: row.order_number_hash,
          receipt_encrypted: historyReceiptEncrypted,
          receipt_hash: row.receipt_hash,
          website_readback_hash: row.website_readback_hash,
          order_product_encrypted: historyOrderProductEncrypted,
          order_product_hash: row.order_product_hash,
          source_summary_encrypted: historySourceSummaryEncrypted,
          source_summary_hash: row.source_summary_hash,
          archive_origin: row.archive_origin,
          completed_at: row.completed_at,
          archived_at: row.archived_at,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }, 'RESTORE_PURCHASE_COMPLETION_HISTORY_READBACK_FAILED');
      }
      const integrationProfilePolicy = getDataDomain('integration-profiles');
      const integrationCredentialPolicy = getDataDomain('integration-credentials');
      const modelApiPolicy = getDataDomain('model-api-accounts');
      const profileSettingsPolicy = getDataDomain('profile-settings');
      const profileAssetsPolicy = getDataDomain('profile-assets');
      for (const record of modelApiAccounts.records) {
        const row = record.value || {};
        if (
          !normalizeText(row.id)
          || !normalizeText(row.api_alias)
          || buildRecoveryRecordKey(modelApiPolicy, row) !== record.key
        ) {
          throw new Error('RESTORE_PROFILE_MODEL_API_ACCOUNT_INVALID');
        }
        db.prepare(`
          INSERT INTO model_api_accounts (
            id, api_alias, provider, website_url, login_account, login_password_encrypted,
            base_url, api_key_encrypted, default_model, usage_scene, upscale, quality, style,
            available_models_json, capabilities_json, discovery_verified,
            detection_status, detected_source, detected_at, is_default, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            api_alias = excluded.api_alias, provider = excluded.provider, website_url = excluded.website_url,
            login_account = excluded.login_account, login_password_encrypted = excluded.login_password_encrypted,
            base_url = excluded.base_url, api_key_encrypted = excluded.api_key_encrypted,
            default_model = excluded.default_model, usage_scene = excluded.usage_scene,
            upscale = excluded.upscale, quality = excluded.quality, style = excluded.style,
            available_models_json = excluded.available_models_json,
            capabilities_json = excluded.capabilities_json,
            discovery_verified = excluded.discovery_verified,
            detection_status = excluded.detection_status, detected_source = excluded.detected_source,
            detected_at = excluded.detected_at, is_default = excluded.is_default,
            created_at = excluded.created_at, updated_at = excluded.updated_at
        `).run(
          row.id, row.api_alias, row.provider || null, row.website_url || null,
          row.login_account || null, row.login_password ? encryptShopSecret(row.login_password) : null,
          row.base_url || null, row.api_key ? encryptShopSecret(row.api_key) : null,
          row.default_model || null, row.usage_scene || null, row.upscale || null,
          row.quality || null, row.style || null,
          row.available_models_json || null, row.capabilities_json || null,
          Number(row.discovery_verified) === 1 ? 1 : 0,
          row.detection_status || null,
          row.detected_source || null, row.detected_at || null,
          Number(row.is_default) === 1 ? 1 : 0, row.created_at, row.updated_at,
        );
      }
      for (const record of integrationProfiles.records) {
        const row = record.value || {};
        if (
          !normalizeText(row.id)
          || !normalizeText(row.integration_type)
          || !normalizeText(row.platform_name)
          || buildRecoveryRecordKey(integrationProfilePolicy, row) !== record.key
        ) {
          throw new Error('RESTORE_PROFILE_INTEGRATION_PROFILE_INVALID');
        }
        db.prepare(`
          INSERT INTO integration_profiles (
            id, integration_type, platform_name, shop_id, api_type, auth_mode, config_status,
            token_status, read_scope, write_scope, note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            integration_type = excluded.integration_type, platform_name = excluded.platform_name,
            shop_id = excluded.shop_id,
            api_type = excluded.api_type, auth_mode = excluded.auth_mode,
            config_status = excluded.config_status, token_status = excluded.token_status,
            read_scope = excluded.read_scope, write_scope = excluded.write_scope,
            note = excluded.note, created_at = excluded.created_at, updated_at = excluded.updated_at
        `).run(
          row.id, row.integration_type, row.platform_name, row.shop_id || null, row.api_type || null,
          row.auth_mode || null, row.config_status || null, row.token_status || null,
          row.read_scope || null, row.write_scope || null, row.note || null,
          row.created_at, row.updated_at,
        );
      }
      for (const record of integrationCredentials.records) {
        const row = record.value || {};
        if (
          !normalizeText(row.profile_id)
          || !normalizeText(row.base_url)
          || buildRecoveryRecordKey(integrationCredentialPolicy, row) !== record.key
        ) {
          throw new Error('RESTORE_PROFILE_INTEGRATION_CREDENTIAL_INVALID');
        }
        db.prepare(`
          INSERT INTO integration_credentials (
            profile_id, base_url, login_account, login_password_encrypted,
            api_key_encrypted, last_test_status, last_test_message, last_test_at,
            last_test_metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_id) DO UPDATE SET
            base_url = excluded.base_url, login_account = excluded.login_account,
            login_password_encrypted = excluded.login_password_encrypted,
            api_key_encrypted = excluded.api_key_encrypted,
            last_test_status = excluded.last_test_status,
            last_test_message = excluded.last_test_message,
            last_test_at = excluded.last_test_at,
            last_test_metadata_json = excluded.last_test_metadata_json,
            created_at = excluded.created_at, updated_at = excluded.updated_at
        `).run(
          row.profile_id, row.base_url, row.login_account || null,
          row.login_password ? encryptShopSecret(row.login_password) : null,
          row.api_key ? encryptShopSecret(row.api_key) : null,
          row.last_test_status || null, row.last_test_message || null,
          row.last_test_at || null, row.last_test_metadata_json || null,
          row.created_at, row.updated_at,
        );
      }
      const followSellerLoginPreferencesPolicy = getDataDomain('follow-seller-login-preferences');
      for (const record of followSellerLoginPreferences.records) {
        const row = record.value || {};
        const profile = db.prepare(`
          SELECT integration_type
          FROM integration_profiles
          WHERE id = ?
        `).get(row.profile_id);
        if (
          row.preference_key !== 'global'
          || !normalizeText(row.profile_id)
          || profile?.integration_type !== 'ozon-follow-seller-session'
          || buildRecoveryRecordKey(followSellerLoginPreferencesPolicy, row) !== record.key
        ) {
          throw new Error('RESTORE_FOLLOW_SELLER_LOGIN_PREFERENCE_INVALID');
        }
        db.prepare(`
          INSERT INTO follow_seller_login_preferences (
            preference_key, profile_id, created_at, updated_at
          ) VALUES ('global', ?, ?, ?)
          ON CONFLICT(preference_key) DO UPDATE SET
            profile_id = excluded.profile_id,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `).run(row.profile_id, row.created_at, row.updated_at);
        assertSqlReadback(
          db.prepare(`
            SELECT preference_key, profile_id, created_at, updated_at
            FROM follow_seller_login_preferences
            WHERE preference_key = 'global'
          `).get(),
          {
            preference_key: 'global',
            profile_id: row.profile_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
          'RESTORE_FOLLOW_SELLER_LOGIN_PREFERENCE_READBACK_FAILED',
        );
      }
      for (const record of profileSettings.records) {
        const sourceRow = record.value || {};
        if (
          !normalizeText(sourceRow.namespace)
          || buildRecoveryRecordKey(profileSettingsPolicy, sourceRow) !== record.key
        ) {
          throw new Error('RESTORE_PROFILE_SETTING_INVALID');
        }
        const row = ownerScope
          ? remapOwnerScopedProfileSettingRow(sourceRow, ownerScope, targetOwnerScope)
          : sourceRow;
        let value;
        try {
          value = normalizeProfileSettingValue(row.namespace, row.value);
        } catch {
          throw new Error('RESTORE_PROFILE_SETTING_INVALID');
        }
        const merged = targetOwnerScope
          ? mergeOwnerScopedProfileSetting(db, row, targetOwnerScope, { strategy: mergeStrategy })
          : { value, createdAt: row.created_at, updatedAt: row.updated_at };
        const mergedValueJson = JSON.stringify(merged.value);
        db.prepare(`
          INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(namespace) DO UPDATE SET
            value_json = excluded.value_json, created_at = excluded.created_at, updated_at = excluded.updated_at
        `).run(
          row.namespace,
          mergedValueJson,
          merged.createdAt,
          merged.updatedAt,
        );
        const settingReadback = db.prepare(`
          SELECT value_json, created_at, updated_at
          FROM profile_settings WHERE namespace = ?
        `).get(row.namespace);
        let readbackValue;
        try {
          readbackValue = JSON.parse(settingReadback?.value_json || '');
        } catch {
          throw new Error('RESTORE_PROFILE_SETTING_READBACK_FAILED');
        }
        if (
          canonicalJson(readbackValue) !== canonicalJson(merged.value)
          || normalizeText(settingReadback?.created_at) !== normalizeText(merged.createdAt)
          || normalizeText(settingReadback?.updated_at) !== normalizeText(merged.updatedAt)
        ) throw new Error('RESTORE_PROFILE_SETTING_READBACK_FAILED');
      }
      for (const record of profileAssets.records) {
        const row = record.value || {};
        let asset;
        try {
          asset = normalizeProfileAssetInput({ mimeType: row.mime_type, dataBase64: row.data_base64 });
        } catch {
          throw new Error('RESTORE_PROFILE_ASSET_INVALID');
        }
        if (
          !normalizeText(row.id)
          || row.id !== `asset_${asset.sha256}`
          || row.sha256 !== asset.sha256
          || Number(row.byte_length) !== asset.data.byteLength
          || buildRecoveryRecordKey(profileAssetsPolicy, row) !== record.key
        ) {
          throw new Error('RESTORE_PROFILE_ASSET_INVALID');
        }
        db.prepare(`
          INSERT INTO profile_assets (id, sha256, mime_type, byte_length, data_base64, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            sha256 = excluded.sha256, mime_type = excluded.mime_type, byte_length = excluded.byte_length,
            data_base64 = excluded.data_base64, created_at = excluded.created_at, updated_at = excluded.updated_at
        `).run(
          row.id, asset.sha256, asset.mimeType, asset.data.byteLength, asset.dataBase64, row.created_at, row.updated_at,
        );
      }
      if (manageTransaction) db.exec('COMMIT');
    } catch (error) {
      if (manageTransaction) {
        try { db.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
      }
      throw error;
    }
    return {
      ok: true,
      mode: 'staging-only',
      shops: shops.records.length,
      credentials: credentials.records.length,
      crossBorderAccounts: crossBorderAccounts.records.length,
      performanceAccounts: performanceAccounts.records.length,
      purchaseAccounts: purchaseAccounts.records.length,
      modelApiAccounts: modelApiAccounts.records.length,
      integrationProfiles: integrationProfiles.records.length,
      ...(hasFollowSellerLoginPreferencesDomain
        ? { followSellerLoginPreferences: followSellerLoginPreferences.records.length }
        : {}),
      profileSettings: profileSettings.records.length,
      ...(ownerScope ? { profileSettingsMergeMode: 'owner-slice-merge' } : {}),
      profileAssets: profileAssets.records.length,
      purchaseBrowserTasks: purchaseBrowserTasks.records.length,
      purchaseBrowserReceipts: purchaseBrowserReceipts.records.length,
      ...(hasPurchaseCompletionHistoryDomain
        ? { purchaseCompletionHistory: purchaseCompletionHistory.records.length }
        : {}),
      ...(includeMergeSummary ? {
        skippedPurchaseTasks,
        skippedPurchaseReceipts,
        preservedPurchaseTasks,
        preservedPurchaseReceipts,
        preservedPurchaseCompletionHistory,
      } : {}),
    };
  }

  return { importCandidate };
}
