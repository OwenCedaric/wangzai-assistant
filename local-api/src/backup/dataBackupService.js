import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createAccountRemovalOwnerRef } from '../db/repositories/accountRemovalOperationRepository.js';
import {
  ACCOUNT_REMOVAL_SQLITE_RESOURCES,
  quoteAccountRemovalIdentifier,
} from '../domain/accountRemoval/accountRemovalSqliteCatalog.js';
import {
  inspectRequiredAccountOwnerBackupRows,
  normalizeDataBackupOwner,
} from './accountOwnerBackupPolicy.js';
import {
  assertRequiredDataBackupShopDomainCoverage,
  createRecoveryExporter,
} from './recoveryExporter.js';
import { createRecoveryKeyEnvelope, generateRecoveryKeyset } from './recoveryKeyEnvelope.js';
import {
  createRecoveryProfileCore,
  RECOVERY_OWNER_IDENTITY_DOMAINS,
} from './recoveryProfileCore.js';
import { createRecoveryStorageAdapter } from './recoveryStorageAdapter.js';
import {
  createDataBackupPackage,
  DATA_BACKUP_PACKAGE_VERSION,
  openDataBackupPackage,
} from './dataBackupPackage.js';
import { createDataBackupWatermark } from './dataBackupWatermark.js';
import {
  removeDataBackupStagingFile,
  writeDataBackupStagingFile,
} from './dataBackupStagingFile.js';

export const DATA_BACKUP_SKIP_CONFIRMATION_CODE = 'SKIP_BACKUP_AND_DELETE_PERMANENTLY';

const DOMAIN_LABELS = Object.freeze({
  shops: '店铺资料',
  'shop-credentials': '店铺凭证',
  'recovery-keyset': '数据恢复密钥',
  'cross-border-accounts': '跨境巴士账号',
  'cross-border-account-shop-bindings': '跨境账号店铺绑定',
  'performance-accounts': '营销账号',
  'purchase-accounts': '采购账号',
  'model-api-accounts': '模型接口账号',
  'integration-profiles': '外部服务配置',
  'integration-credentials': '外部服务凭证',
  'profile-assets': '账号资源',
  'purchase-browser-tasks': '采购浏览任务',
  'purchase-browser-receipts': '采购执行回执',
  'profile-settings': '账号相关设置',
  'purchase-overrides': '采购补录',
  'purchase-source-links': '采购货源',
  'sales-source-links': '销售来源',
  'product-source-links': '商品货源',
  'product-material-profiles': '商品材积',
  'order-split-relations': '订单拆分关系',
  'notification-settings': '通知设置',
  'cross-border-order-records': '跨境巴士记录',
  'purchase-completion-history': '拍单完成记录',
  'product-image-assets': '商品图片资产',
  'follow-seller-login-preferences': '剔除跟卖登录偏好',
  'product-identities': '商品识别信息',
  'product-dimension-facts': '商品长宽高信息',
  'product-manual-cost-profiles': '商品历史成本',
  'historical-order-facts': '历史订单导入数据',
});

const OWNER_TYPE_LABELS = Object.freeze({
  ozon_shop: 'Ozon 店铺',
  cross_border_bus: '跨境巴士账号',
  promotion_account: '推广账号',
  purchase_account: '采购账号',
  model_api_account: '模型接口账号',
  integration_profile: '外部服务配置',
});

export function getDataBackupOwnerTypeLabel(ownerType) {
  return OWNER_TYPE_LABELS[String(ownerType || '').trim()] || '其他账号';
}

export function getDataBackupDomainLabel(domain) {
  return DOMAIN_LABELS[String(domain || '').trim()] || '其他用户数据';
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function normalizeShopId(value) {
  const shopId = String(value || '').trim();
  if (!shopId) fail('DATA_BACKUP_SHOP_ID_REQUIRED');
  return shopId;
}

function normalizeExportOwner({ owner, shopId } = {}) {
  return normalizeDataBackupOwner(owner || {
    ownerType: 'ozon_shop',
    ownerId: normalizeShopId(shopId),
  });
}

function normalizeFingerprint(value, code) {
  const fingerprint = String(value || '').trim();
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) fail(code);
  return fingerprint;
}

function commitCapabilityHash(value) {
  const capability = String(value || '');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) {
    fail('DATA_BACKUP_COMMIT_CAPABILITY_REQUIRED');
  }
  const bytes = Buffer.from(capability, 'base64url');
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== capability) {
    fail('DATA_BACKUP_COMMIT_CAPABILITY_REQUIRED');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function capabilityHashMatches(expected, actual) {
  if (!/^[a-f0-9]{64}$/u.test(String(expected || '')) || !/^[a-f0-9]{64}$/u.test(String(actual || ''))) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function opaqueSuggestedFileName(packageSha256, createdAt) {
  const packageToken = /^[a-f0-9]{64}$/u.test(String(packageSha256 || ''))
    ? String(packageSha256).slice(0, 12)
    : 'unknown-package';
  const timestamp = String(createdAt || '').replace(/[^0-9TZ-]/gu, '-').slice(0, 32);
  return `旺崽数据备份-${packageToken}${timestamp ? `-${timestamp}` : ''}.wzb`;
}

function requiredRestoreDomains(owner) {
  return new Set(RECOVERY_OWNER_IDENTITY_DOMAINS[owner?.ownerType] || []);
}

function publicDomains(owner, ...candidates) {
  const required = requiredRestoreDomains(owner);
  const domains = candidates.flatMap((candidate) => candidate?.domains || [])
    .filter((domain) => Number(domain.recordCount) > 0)
    .map((domain) => ({
    domain: domain.domain,
    schemaVersion: Number(domain.schemaVersion ?? 1),
    label: getDataBackupDomainLabel(domain.domain),
    recordCount: Number(domain.recordCount) || 0,
    logicalBytes: Number(domain.cipherBytes) || 0,
    recordsRootHash: domain.recordsRootHash,
    requiredForRestore: required.has(domain.domain),
    })).sort((left, right) => left.domain.localeCompare(right.domain));
  if (new Set(domains.map((domain) => domain.domain)).size !== domains.length) {
    fail('DATA_BACKUP_DOMAIN_DUPLICATE');
  }
  return domains;
}

function readSqliteUserVersion(sourceDb) {
  const row = sourceDb.prepare('PRAGMA user_version;').get() || {};
  const value = Number(row.user_version ?? Object.values(row)[0] ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) fail('DATA_BACKUP_SQLITE_VERSION_INVALID');
  return value;
}

function publicBackupRow(row) {
  if (!row) return null;
  let domains = [];
  try { domains = JSON.parse(row.domain_summary_json || '[]'); } catch { /* invalid rows stay visibly empty */ }
  const publicDomains = Array.isArray(domains) ? domains : [];
  return {
    backupId: row.backup_id,
    status: row.status,
    dataFingerprint: row.data_fingerprint,
    packageSha256: row.package_sha256,
    packageBytes: Number(row.package_bytes) || 0,
    domains: publicDomains,
    totalRecords: publicDomains.reduce((total, domain) => total + (Number(domain?.recordCount) || 0), 0),
    logicalBytes: publicDomains.reduce((total, domain) => total + (Number(domain?.logicalBytes) || 0), 0),
    packageVersion: DATA_BACKUP_PACKAGE_VERSION,
    suggestedFileName: opaqueSuggestedFileName(row.package_sha256, row.created_at),
    survivesAccountRemoval: Number(row.survives_account_removal) === 1,
    createdAt: row.created_at,
    verifiedAt: row.verified_at || null,
    failureCode: row.failure_code || null,
  };
}

export function createDataBackupService({
  db,
  storageAdapter,
  decryptShopSecret,
  stagingDirectory = '',
  now = () => new Date(),
  createBackupId = () => `data_backup_${randomUUID()}`,
} = {}) {
  if (!db) throw new Error('createDataBackupService requires db.');
  storageAdapter ||= createRecoveryStorageAdapter({ db });
  if (typeof decryptShopSecret !== 'function') {
    throw new Error('createDataBackupService requires decryptShopSecret.');
  }

  function requireShop(shopIdInput, sourceDb = db) {
    const shopId = normalizeShopId(shopIdInput);
    const shop = sourceDb.prepare(`
      SELECT id, client_id, shop_incarnation,
             COALESCE(NULLIF(alias, ''), NULLIF(name, ''), id) AS display_name
      FROM shops WHERE id = ?
    `).get(shopId);
    if (!shop) fail('DATA_BACKUP_SHOP_NOT_FOUND');
    const shopIncarnation = String(shop.shop_incarnation || '').trim();
    if (!shopIncarnation) fail('DATA_BACKUP_SHOP_INCARNATION_REQUIRED');
    return {
      shopId,
      clientId: String(shop.client_id || '').trim(),
      shopIncarnation,
      displayName: String(shop.display_name || shopId),
    };
  }

  function requireOwner(ownerInput, sourceDb = db) {
    const owner = normalizeDataBackupOwner(ownerInput);
    if (owner.ownerType === 'ozon_shop') {
      const shop = requireShop(owner.ownerId, sourceDb);
      const inspected = inspectRequiredAccountOwnerBackupRows(sourceDb, owner, {
        resolveDomainDatabase: storageAdapter.resolveDatabase,
      });
      return {
        owner,
        clientId: shop.clientId,
        ownerIncarnation: shop.shopIncarnation,
        displayName: shop.displayName,
        registryDomains: inspected.domains,
      };
    }
    const inspected = inspectRequiredAccountOwnerBackupRows(sourceDb, owner);
    const accountDescriptor = (ACCOUNT_REMOVAL_SQLITE_RESOURCES[owner.ownerType] || [])
      .find((descriptor) => descriptor.accountRow === true);
    const account = accountDescriptor
      ? sourceDb.prepare(`
          SELECT * FROM ${quoteAccountRemovalIdentifier(accountDescriptor.table)}
          WHERE ${quoteAccountRemovalIdentifier(accountDescriptor.ownerField)} = ?
        `).get(owner.ownerId)
      : null;
    const displayName = String(
      account?.name
      || account?.alias
      || account?.api_alias
      || account?.platform_name
      || account?.client_id
      || account?.login_account
      || owner.ownerId,
    ).trim();
    return {
      owner,
      ownerIncarnation: inspected.ownerIncarnation,
      displayName,
      registryDomains: inspected.domains,
    };
  }

  function listOwners(sourceDb = db) {
    const owners = [];
    for (const [ownerType, descriptors] of Object.entries(ACCOUNT_REMOVAL_SQLITE_RESOURCES)) {
      const account = descriptors.find((descriptor) => descriptor.accountRow === true);
      if (!account) continue;
      const rows = sourceDb.prepare(`
        SELECT ${quoteAccountRemovalIdentifier(account.ownerField)} AS owner_id
        FROM ${quoteAccountRemovalIdentifier(account.table)}
        ${ownerType === 'ozon_shop' ? "WHERE COALESCE(status, 'active') != 'inactive'" : ''}
        ORDER BY ${quoteAccountRemovalIdentifier(account.ownerField)}
      `).all();
      for (const row of rows) {
        const ownerId = String(row.owner_id || '').trim();
        if (ownerId) owners.push({ ownerType, ownerId });
      }
    }
    return owners;
  }

  function buildCandidates(sourceDb, ownerInput, {
    encryptionKey,
    dedupeKey,
    aad,
    includeDomains,
  }) {
    const owner = normalizeDataBackupOwner(ownerInput);
    let shopCandidate = null;
    if (owner.ownerType === 'ozon_shop') {
      // Shop-only generic and special profile-core channels share this gate.
      assertRequiredDataBackupShopDomainCoverage();
      shopCandidate = createRecoveryExporter({
        db: sourceDb,
        resolveDomainDatabase: storageAdapter.resolveDatabase,
        // Portable user exports live on the user's own disk. They are not a
        // metered remote backup product and therefore have no product quota.
        quotaBytes: null,
      }).buildShopCandidate({
        shopId: owner.ownerId,
        encryptionKey,
        dedupeKey,
        aad,
        mode: 'core-only',
        includeDomains,
      });
    }
    const profileCandidate = createRecoveryProfileCore({
      db: sourceDb,
      decryptShopSecret,
    }).buildOwnerCandidate({
      owner,
      encryptionKey,
      dedupeKey,
      aad,
      includeDomains,
    });
    return { profileCandidate, shopCandidate };
  }

  function assertRegistryPreviewMatches(scope, domains, selectedDomains) {
    const selected = selectedDomains ? new Set(selectedDomains) : null;
    const expected = new Map((scope.registryDomains || [])
      .filter((domain) => domain.recordCount > 0)
      .filter((domain) => !selected || selected.has(domain.domain))
      .map((domain) => [domain.domain, domain.recordCount]));
    const actual = new Map(domains.map((domain) => [domain.domain, domain.recordCount]));
    if (
      expected.size !== actual.size
      || [...expected].some(([domain, count]) => actual.get(domain) !== count)
    ) fail('DATA_BACKUP_OWNER_REGISTRY_COVERAGE_MISMATCH');
  }

  function normalizeSelectedDomains(value, scope, availableDomains) {
    const available = new Set(availableDomains.map((domain) => domain.domain));
    const mandatory = requiredRestoreDomains(scope.owner);
    if (value === undefined || value === null) return [...available].sort();
    if (!Array.isArray(value)) fail('DATA_BACKUP_SELECTED_DOMAINS_INVALID');
    const normalized = value.map((domain) => String(domain || '').trim());
    if (
      normalized.some((domain) => !/^[a-z][a-z0-9-]{0,127}$/u.test(domain))
      || new Set(normalized).size !== normalized.length
      || normalized.some((domain) => !available.has(domain))
    ) fail('DATA_BACKUP_SELECTED_DOMAINS_INVALID');
    if ([...mandatory].some((domain) => available.has(domain) && !normalized.includes(domain))) {
      fail('DATA_BACKUP_REQUIRED_DOMAIN_NOT_SELECTED');
    }
    if (!normalized.length) fail('DATA_BACKUP_SELECTED_DOMAINS_REQUIRED');
    return normalized.sort();
  }

  function latestVerified(owner) {
    const ownerRef = createAccountRemovalOwnerRef(owner);
    return db.prepare(`
      SELECT * FROM data_backup_exports
      WHERE owner_type = ? AND owner_ref = ? AND status = 'verified'
        AND survives_account_removal = 1
      ORDER BY verified_at DESC, created_at DESC
      LIMIT 1
    `).get(owner.ownerType, ownerRef) || null;
  }

  function buildOwnerPreviewFromDb(sourceDb, ownerInput) {
    const scope = requireOwner(ownerInput, sourceDb);
    const { profileCandidate, shopCandidate } = buildCandidates(sourceDb, scope.owner, {
      encryptionKey: randomBytes(32),
      dedupeKey: randomBytes(32),
      aad: 'wangzai-data-backup:preview',
    });
    const domains = publicDomains(scope.owner, shopCandidate, profileCandidate);
    assertRegistryPreviewMatches(scope, domains);
    const latest = latestVerified(scope.owner);
    const watermark = createDataBackupWatermark({
      owner: scope.owner,
      ownerIncarnation: scope.ownerIncarnation,
      sqliteUserVersion: readSqliteUserVersion(sourceDb),
      domains,
    });
    const fingerprint = watermark.dataFingerprint;
    const latestPublic = publicBackupRow(latest);
    const currentDomainNames = domains.map((domain) => domain.domain).sort();
    const latestDomainNames = (latestPublic?.domains || []).map((domain) => domain.domain).sort();
    const latestIsPartial = Boolean(latestPublic) && (
      latestDomainNames.length !== currentDomainNames.length
      || latestDomainNames.some((domain, index) => domain !== currentDomainNames[index])
    );
    return {
      owner: scope.owner,
      ...(scope.owner.ownerType === 'ozon_shop'
        ? { shopId: scope.owner.ownerId, clientId: scope.clientId }
        : {}),
      displayName: scope.displayName,
      ownerIncarnation: scope.ownerIncarnation,
      domains: domains.map(({ recordsRootHash, ...domain }) => domain),
      totalRecords: domains.reduce((total, domain) => total + domain.recordCount, 0),
      estimatedBytes: domains.reduce((total, domain) => total + domain.logicalBytes, 0),
      dataFingerprint: fingerprint,
      watermarkVersion: watermark.version,
      sqliteUserVersion: watermark.sqliteUserVersion,
      latestVerifiedBackup: latestPublic
        ? {
            ...latestPublic,
            coversCurrentData: latestPublic.dataFingerprint === fingerprint,
            coverageMode: latestIsPartial ? 'partial' : 'full',
          }
        : null,
    };
  }

  function previewShop(shopId) {
    return {
      ok: true,
      mode: 'read-only-preview',
      shops: [buildOwnerPreviewFromDb(db, { ownerType: 'ozon_shop', ownerId: shopId })],
    };
  }

  function previewOwner(owner) {
    return { ok: true, mode: 'read-only-preview', owner: buildOwnerPreviewFromDb(db, owner) };
  }

  function previewAll() {
    const ownerPreviews = listOwners(db).map((owner) => buildOwnerPreviewFromDb(db, owner));
    return {
      ok: true,
      mode: 'read-only-preview',
      owners: ownerPreviews.map((preview) => ({
        ...preview,
        ownerTypeLabel: getDataBackupOwnerTypeLabel(preview.owner.ownerType),
      })),
      shops: ownerPreviews.filter((preview) => preview.owner.ownerType === 'ozon_shop'),
    };
  }

  function listOwnerHistory(ownerInput, { limit = 20 } = {}) {
    const { owner } = requireOwner(ownerInput);
    const currentDomains = buildOwnerPreviewFromDb(db, owner).domains
      .map((domain) => domain.domain)
      .sort();
    const ownerRef = createAccountRemovalOwnerRef(owner);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const backups = db.prepare(`
      SELECT * FROM data_backup_exports
      WHERE owner_type = ? AND owner_ref = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(owner.ownerType, ownerRef, safeLimit).map(publicBackupRow).map((backup) => {
      const backupDomains = backup.domains.map((domain) => domain.domain).sort();
      return {
        ...backup,
        coverageMode: backupDomains.length === currentDomains.length
          && backupDomains.every((domain, index) => domain === currentDomains[index])
          ? 'full'
          : 'partial',
      };
    });
    return { ok: true, backups };
  }

  function listHistory(shopIdInput, options) {
    return listOwnerHistory({ ownerType: 'ozon_shop', ownerId: shopIdInput }, options);
  }

  function portableKeyset(backupId) {
    // Local portable backups must not reuse the disaster-recovery keyset. The
    // package gets one independent keyset and carries its own random unlock
    // secret so a new computer can restore it without a user-managed password.
    const keyset = generateRecoveryKeyset();
    const unlockSecret = randomBytes(32).toString('base64url');
    const recoveryAad = `wangzai-user-data-backup:v1:${backupId}`;
    const envelope = createRecoveryKeyEnvelope({
      keyset,
      passphrase: unlockSecret,
      aad: recoveryAad,
    });
    return { keyset, envelope, recoveryAad, unlockSecret };
  }

  function prepareExport({
    owner: ownerInput,
    shopId: shopIdInput,
    expectedDataFingerprint,
    commitCapability,
    stagingFileName = '',
    selectedDomains,
  } = {}) {
    const owner = normalizeExportOwner({ owner: ownerInput, shopId: shopIdInput });
    const capabilityHash = commitCapabilityHash(commitCapability);
    const backupId = String(createBackupId()).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,160}$/u.test(backupId)) fail('DATA_BACKUP_ID_INVALID');
    const state = portableKeyset(backupId);
    const createdAt = now().toISOString();
    const built = storageAdapter.withSnapshot({ shopIds: owner.ownerType === 'ozon_shop' ? [owner.ownerId] : [] }, (snapshotDb, snapshotEvidence) => {
      const scope = requireOwner(owner, snapshotDb);
      const fullCandidates = buildCandidates(snapshotDb, scope.owner, {
        encryptionKey: state.keyset.chunkEncryptionKey,
        dedupeKey: state.keyset.dedupeKey,
        aad: state.recoveryAad,
      });
      const fullDomains = publicDomains(
        scope.owner,
        fullCandidates.shopCandidate,
        fullCandidates.profileCandidate,
      );
      assertRegistryPreviewMatches(scope, fullDomains);
      const fullWatermark = createDataBackupWatermark({
        owner: scope.owner,
        ownerIncarnation: scope.ownerIncarnation,
        sqliteUserVersion: readSqliteUserVersion(snapshotDb),
        domains: fullDomains,
      });
      const currentFingerprint = fullWatermark.dataFingerprint;
      if (expectedDataFingerprint && normalizeFingerprint(
        expectedDataFingerprint,
        'DATA_BACKUP_EXPECTED_FINGERPRINT_INVALID',
      ) !== currentFingerprint) fail('DATA_BACKUP_PREVIEW_STALE');
      const normalizedSelection = normalizeSelectedDomains(selectedDomains, scope, fullDomains);
      const allSelected = normalizedSelection.length === fullDomains.length
        && normalizedSelection.every((domain, index) => domain === [...fullDomains]
          .map((item) => item.domain).sort()[index]);
      const { profileCandidate, shopCandidate } = allSelected
        ? fullCandidates
        : buildCandidates(snapshotDb, scope.owner, {
            encryptionKey: state.keyset.chunkEncryptionKey,
            dedupeKey: state.keyset.dedupeKey,
            aad: state.recoveryAad,
            includeDomains: normalizedSelection,
          });
      const domains = publicDomains(scope.owner, shopCandidate, profileCandidate);
      assertRegistryPreviewMatches(scope, domains, normalizedSelection);
      const watermark = createDataBackupWatermark({
        owner: scope.owner,
        ownerIncarnation: scope.ownerIncarnation,
        sqliteUserVersion: readSqliteUserVersion(snapshotDb),
        domains,
      });
      const fingerprint = watermark.dataFingerprint;
      const packageResult = createDataBackupPackage({
        owner: scope.owner,
        profileCandidate,
        shopCandidate,
        keyEnvelope: state.envelope,
        encryptionKey: state.keyset.chunkEncryptionKey,
        dedupeKey: state.keyset.dedupeKey,
        aad: state.recoveryAad,
        backupId,
        createdAt,
        dataWatermark: watermark,
        quotaBytes: null,
        selfContainedUnlockSecret: state.unlockSecret,
      });
      const opened = openDataBackupPackage({ bytes: packageResult.bytes });
      if (
        opened.packageSha256 !== packageResult.packageSha256
        || opened.owner?.ownerType !== scope.owner.ownerType
        || opened.owner?.ownerId !== scope.owner.ownerId
        || opened.dataFingerprint !== fingerprint
      ) {
        fail('DATA_BACKUP_SELF_VERIFY_FAILED');
      }
      return {
        scope,
        profileCandidate,
        shopCandidate,
        domains,
        fingerprint,
        watermark,
        packageResult,
        snapshotEvidence,
      };
    });
    const ownerRef = createAccountRemovalOwnerRef(owner);
    const suggestedFileName = opaqueSuggestedFileName(built.packageResult.packageSha256, createdAt);
    const publicDomainSummary = built.domains.map(({ recordsRootHash, ...domain }) => domain);
    const normalizedStagingFileName = String(stagingFileName || '').trim();
    let staged = null;
    if (normalizedStagingFileName) {
      if (!String(stagingDirectory || '').trim()) fail('DATA_BACKUP_STAGING_DIRECTORY_REQUIRED');
      staged = writeDataBackupStagingFile({
        stagingDirectory,
        stagingFileName: normalizedStagingFileName,
        bytes: built.packageResult.bytes,
      });
    }
    try {
      db.prepare(`
        INSERT INTO data_backup_exports (
          backup_id, owner_type, owner_ref, status, data_fingerprint,
          package_sha256, package_bytes, domain_summary_json, suggested_file_name,
          survives_account_removal, commit_capability_hash, created_at
        ) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        backupId,
        owner.ownerType,
        ownerRef,
        built.fingerprint,
        built.packageResult.packageSha256,
        built.packageResult.packageBytes,
        JSON.stringify(publicDomainSummary),
        suggestedFileName,
        capabilityHash,
        createdAt,
      );
    } catch (error) {
      if (staged) {
        try {
          removeDataBackupStagingFile({ stagingDirectory, stagingFileName: staged.stagingFileName });
        } catch { /* preserve the database failure */ }
      }
      throw error;
    }
    return {
      ok: true,
      backupId,
      ...(staged
        ? { stagingFileName: staged.stagingFileName }
        : { contentB64u: built.packageResult.bytes.toString('base64url') }),
      packageSha256: built.packageResult.packageSha256,
      packageBytes: built.packageResult.packageBytes,
      suggestedFileName,
      dataFingerprint: built.fingerprint,
      watermarkVersion: built.watermark.version,
      sqliteUserVersion: built.watermark.sqliteUserVersion,
      domains: publicDomainSummary,
      totalRecords: publicDomainSummary.reduce((total, domain) => total + domain.recordCount, 0),
      createdAt,
      snapshot: built.snapshotEvidence,
    };
  }

  function commitExport({
    backupId: backupIdInput,
    packageSha256,
    packageBytes,
    commitCapability,
  } = {}) {
    const backupId = String(backupIdInput || '').trim();
    const capabilityHash = commitCapabilityHash(commitCapability);
    const row = db.prepare(`SELECT * FROM data_backup_exports WHERE backup_id = ?`).get(backupId);
    if (!row) fail('DATA_BACKUP_PREPARED_EXPORT_NOT_FOUND');
    if (row.status !== 'prepared' || row.capability_consumed_at) {
      fail('DATA_BACKUP_COMMIT_CAPABILITY_CONSUMED');
    }
    if (!capabilityHashMatches(row.commit_capability_hash, capabilityHash)) {
      fail('DATA_BACKUP_COMMIT_CAPABILITY_INVALID');
    }
    if (
      normalizeFingerprint(packageSha256, 'DATA_BACKUP_PACKAGE_HASH_INVALID') !== row.package_sha256
      || Number(packageBytes) !== Number(row.package_bytes)
    ) fail('DATA_BACKUP_FILE_READBACK_MISMATCH');
    const verifiedAt = now().toISOString();
    const update = db.prepare(`
      UPDATE data_backup_exports
      SET status = 'verified', verified_at = ?, failure_code = NULL,
          capability_consumed_at = ?
      WHERE backup_id = ? AND status = 'prepared'
        AND commit_capability_hash = ? AND capability_consumed_at IS NULL
    `).run(verifiedAt, verifiedAt, backupId, capabilityHash);
    if (Number(update.changes || 0) !== 1) fail('DATA_BACKUP_COMMIT_CAPABILITY_CONSUMED');
    const verified = db.prepare(`SELECT * FROM data_backup_exports WHERE backup_id = ?`).get(backupId);
    return { ok: true, verified: true, ...publicBackupRow(verified) };
  }

  function failExport({
    backupId: backupIdInput,
    failureCode = 'DATA_BACKUP_FILE_WRITE_FAILED',
    commitCapability,
  } = {}) {
    const backupId = String(backupIdInput || '').trim();
    if (!backupId) fail('DATA_BACKUP_ID_REQUIRED');
    const capabilityHash = commitCapabilityHash(commitCapability);
    const row = db.prepare(`SELECT * FROM data_backup_exports WHERE backup_id = ?`).get(backupId);
    if (!row) fail('DATA_BACKUP_PREPARED_EXPORT_NOT_FOUND');
    if (row.status !== 'prepared' || row.capability_consumed_at) {
      fail('DATA_BACKUP_COMMIT_CAPABILITY_CONSUMED');
    }
    if (!capabilityHashMatches(row.commit_capability_hash, capabilityHash)) {
      fail('DATA_BACKUP_COMMIT_CAPABILITY_INVALID');
    }
    const consumedAt = now().toISOString();
    const update = db.prepare(`
      UPDATE data_backup_exports
      SET status = 'failed', failure_code = ?, capability_consumed_at = ?
      WHERE backup_id = ? AND status = 'prepared'
        AND commit_capability_hash = ? AND capability_consumed_at IS NULL
    `).run(
      String(failureCode || 'DATA_BACKUP_FILE_WRITE_FAILED').slice(0, 120),
      consumedAt,
      backupId,
      capabilityHash,
    );
    if (Number(update.changes || 0) !== 1) fail('DATA_BACKUP_COMMIT_CAPABILITY_CONSUMED');
    return { ok: true, failed: true, backupId };
  }

  function reviewAccountRemoval({ owner, previewFingerprint } = {}) {
    const preview = buildOwnerPreviewFromDb(db, owner);
    return {
      required: preview.totalRecords > 0,
      previewFingerprint: previewFingerprint || null,
      domains: preview.domains,
      totalRecords: preview.totalRecords,
      dataFingerprint: preview.dataFingerprint,
      latestVerifiedBackup: preview.latestVerifiedBackup,
    };
  }

  function authorizeAccountRemoval({ owner, previewFingerprint, authorization } = {}) {
    const canonicalOwner = normalizeDataBackupOwner(owner);
    const review = reviewAccountRemoval({ owner: canonicalOwner, previewFingerprint });
    if (!review.required) return { outcome: 'not-required', dataFingerprint: review.dataFingerprint || null };
    if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
      fail('ACCOUNT_REMOVAL_BACKUP_REVIEW_REQUIRED');
    }
    if (String(authorization.previewFingerprint || '') !== String(previewFingerprint || '')) {
      fail('ACCOUNT_REMOVAL_BACKUP_PREVIEW_MISMATCH');
    }
    if (String(authorization.dataFingerprint || '') !== review.dataFingerprint) {
      fail('ACCOUNT_REMOVAL_BACKUP_STALE');
    }
    const outcome = String(authorization.outcome || '').trim();
    if (outcome === 'explicitly-skipped') {
      if (authorization.skipConfirmationCode !== DATA_BACKUP_SKIP_CONFIRMATION_CODE) {
        fail('ACCOUNT_REMOVAL_BACKUP_SKIP_CONFIRMATION_REQUIRED');
      }
      return {
        outcome,
        previewFingerprint: String(previewFingerprint || ''),
        dataFingerprint: review.dataFingerprint,
        skipConfirmationCode: DATA_BACKUP_SKIP_CONFIRMATION_CODE,
      };
    }
    if (!['exported', 'recent-verified'].includes(outcome)) fail('ACCOUNT_REMOVAL_BACKUP_OUTCOME_INVALID');
    const backupId = String(authorization.backupId || '').trim();
    const row = db.prepare(`SELECT * FROM data_backup_exports WHERE backup_id = ?`).get(backupId);
    const ownerRef = createAccountRemovalOwnerRef(canonicalOwner);
    if (
      !row
      || row.owner_type !== canonicalOwner.ownerType
      || row.owner_ref !== ownerRef
      || row.status !== 'verified'
      || Number(row.survives_account_removal) !== 1
      || !row.commit_capability_hash
      || !row.capability_consumed_at
      || row.data_fingerprint !== review.dataFingerprint
    ) fail('ACCOUNT_REMOVAL_BACKUP_NOT_VERIFIED');
    return {
      outcome,
      backupId,
      previewFingerprint: String(previewFingerprint || ''),
      dataFingerprint: review.dataFingerprint,
      packageSha256: row.package_sha256,
      verifiedAt: row.verified_at,
    };
  }

  return {
    authorizeAccountRemoval,
    commitExport,
    failExport,
    listHistory,
    listOwnerHistory,
    prepareExport,
    previewAll,
    previewOwner,
    previewShop,
    listOwners,
    reviewAccountRemoval,
  };
}
