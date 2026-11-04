import { createExternalOzonIdentityHash } from "../db/repositories/shopIdentityRepository.js";
import { getDataBackupDomainLabel } from "./dataBackupService.js";
import { readDataBackupStagingFile } from "./dataBackupStagingFile.js";
import { canonicalJson } from "./recoveryChunkCodec.js";
import { planOwnerScopedRecoveryProfileSettingMerge } from "./recoveryProfileCore.js";
import { createHash } from "node:crypto";

export function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

export function normalizeStrategy(value) {
  const strategy = normalizeText(value) || 'preserve';
  if (!['preserve', 'overwrite'].includes(strategy)) fail('DATA_BACKUP_IMPORT_STRATEGY_INVALID');
  return strategy;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(normalizeText(value));
}

export function decodeBase64Package(value, alphabet) {
  const encoded = normalizeText(value);
  if (!encoded) fail('DATA_BACKUP_IMPORT_PACKAGE_REQUIRED');
  const withoutPadding = encoded.replace(/=+$/u, '');
  const valid = alphabet === 'base64url'
    ? /^[A-Za-z0-9_-]+$/u.test(withoutPadding)
    : /^[A-Za-z0-9+/]+$/u.test(withoutPadding);
  if (!valid || /=/u.test(encoded.slice(0, -2))) fail('DATA_BACKUP_IMPORT_PACKAGE_ENCODING_INVALID');
  let bytes;
  try {
    bytes = Buffer.from(withoutPadding, alphabet);
  } catch {
    fail('DATA_BACKUP_IMPORT_PACKAGE_ENCODING_INVALID');
  }
  if (!bytes.length) fail('DATA_BACKUP_IMPORT_PACKAGE_REQUIRED');
  const canonical = bytes.toString(alphabet).replace(/=+$/u, '');
  if (canonical !== withoutPadding) fail('DATA_BACKUP_IMPORT_PACKAGE_ENCODING_INVALID');
  return bytes;
}

export function packageBytesFromInput(input = {}, { stagingDirectory = '' } = {}) {
  const stagingFileName = normalizeText(input.stagingFileName || input.staging_file_name);
  if (stagingFileName) {
    if (!String(stagingDirectory || '').trim()) fail('DATA_BACKUP_STAGING_DIRECTORY_REQUIRED');
    return readDataBackupStagingFile({
      stagingDirectory,
      stagingFileName,
      expectedSha256: input.packageSha256 || input.package_sha256,
      expectedBytes: input.packageBytes ?? input.package_bytes,
    }).bytes;
  }
  if (Buffer.isBuffer(input.bytes)) {
    if (!input.bytes.length) fail('DATA_BACKUP_IMPORT_PACKAGE_REQUIRED');
    return Buffer.from(input.bytes);
  }
  const base64url = input.contentB64u
    ?? input.packageContentB64u
    ?? input.package_content_b64u
    ?? input.content_b64u;
  if (base64url !== undefined && base64url !== null && String(base64url).trim()) {
    return decodeBase64Package(base64url, 'base64url');
  }
  const base64 = input.contentBase64
    ?? input.packageBase64
    ?? input.package_content_base64
    ?? input.content_base64;
  return decodeBase64Package(base64, 'base64');
}

export function wipeOpenedPackage(opened) {
  for (const key of ['chunkEncryptionKey', 'dedupeKey']) {
    const value = opened?.keyset?.[key];
    if (Buffer.isBuffer(value)) value.fill(0);
  }
}

export function recordsFor(openedProfile, domain) {
  return openedProfile.domains.get(domain)?.records || [];
}

export function assertSourceIdentity(opened, openedProfile) {
  if (opened.owner?.ownerType !== 'ozon_shop') fail('DATA_BACKUP_IMPORT_OWNER_UNSUPPORTED');
  const sourceShopId = normalizeText(opened.owner.ownerId);
  if (!sourceShopId || sourceShopId !== normalizeText(opened.shopId)) {
    fail('DATA_BACKUP_IMPORT_SOURCE_SCOPE_INVALID');
  }
  if (!opened.dataWatermark || !isSha256(opened.dataFingerprint)) {
    fail('DATA_BACKUP_IMPORT_WATERMARK_REQUIRED');
  }
  const shops = recordsFor(openedProfile, 'shops');
  const credentials = recordsFor(openedProfile, 'shop-credentials');
  if (
    shops.length !== 1
    || normalizeText(shops[0]?.value?.id) !== sourceShopId
    || credentials.length !== 1
    || normalizeText(credentials[0]?.value?.shop_id) !== sourceShopId
  ) fail('DATA_BACKUP_IMPORT_SOURCE_IDENTITY_INVALID');
  const clientId = normalizeText(credentials[0]?.value?.client_id);
  const externalIdentityHash = createExternalOzonIdentityHash(clientId);
  if (!clientId || !externalIdentityHash) fail('DATA_BACKUP_IMPORT_SOURCE_CLIENT_ID_REQUIRED');
  const sourceShop = shops[0].value;
  return {
    sourceShopId,
    externalIdentityHash,
    displayName: normalizeText(sourceShop.alias) || normalizeText(sourceShop.name) || sourceShopId,
  };
}

export function credentialSnapshot(row) {
  return {
    profileId: row.profile_id,
    shopId: row.id,
    clientId: row.client_id,
    encryptedApiKey: row.api_key_encrypted,
    externalIdentityHash: row.external_identity_hash,
    shopIncarnation: row.shop_incarnation,
    credentialRevision: Number(row.credential_revision),
    status: row.status,
    disabledAt: row.disabled_at || null,
  };
}

export function assertCredentialSnapshotUnchanged(before, after) {
  if (!after || canonicalJson(before) !== canonicalJson(credentialSnapshot(after))) {
    fail('DATA_BACKUP_IMPORT_CURRENT_CREDENTIALS_CHANGED');
  }
}

export function domainSummary(domain, recordCount = 0) {
  return {
    domain,
    label: getDataBackupDomainLabel(domain),
    recordCount: Number(recordCount) || 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    preserved: 0,
    conflicts: 0,
    preservedFields: 0,
    skippedMissingDependency: 0,
  };
}

export function buildProfilePlan(db, openedProfile, { sourceShopId, targetShopId, strategy }) {
  const summaries = new Map();
  const expectedReadback = {
    settings: [],
    tasks: [],
    receipts: [],
    completionHistory: [],
  };
  const getSummary = (domain) => {
    const records = recordsFor(openedProfile, domain);
    const summary = summaries.get(domain) || domainSummary(domain, records.length);
    summaries.set(domain, summary);
    return summary;
  };

  for (const domain of ['shops', 'shop-credentials']) {
    const records = recordsFor(openedProfile, domain);
    if (!records.length) continue;
    getSummary(domain).preserved += records.length;
  }

  const settings = recordsFor(openedProfile, 'profile-settings');
  if (settings.length) {
    const summary = getSummary('profile-settings');
    for (const record of settings) {
      const namespace = normalizeText(record?.value?.namespace);
      const expectedSetting = planOwnerScopedRecoveryProfileSettingMerge({
        db,
        row: record?.value || {},
        sourceOwner: { ownerType: 'ozon_shop', ownerId: sourceShopId },
        targetOwner: { ownerType: 'ozon_shop', ownerId: targetShopId },
        strategy,
      });
      const present = namespace
        && db.prepare('SELECT 1 AS present FROM profile_settings WHERE namespace = ?').get(namespace)?.present;
      if (present) {
        if (strategy === 'preserve') summary.preserved += 1;
        else summary.updated += 1;
        summary.conflicts += 1;
      } else {
        summary.inserted += 1;
      }
      if (namespace) expectedReadback.settings.push(expectedSetting);
    }
  }

  const taskDisposition = new Map();
  const tasks = recordsFor(openedProfile, 'purchase-browser-tasks');
  if (tasks.length) {
    const summary = getSummary('purchase-browser-tasks');
    for (const record of tasks) {
      const row = record?.value || {};
      const account = db.prepare('SELECT created_at FROM purchase_accounts WHERE id = ?').get(row.owner_id);
      if (!account || normalizeText(account.created_at) !== normalizeText(row.owner_incarnation)) {
        summary.skippedMissingDependency += 1;
        taskDisposition.set(row.id, 'skipped');
        continue;
      }
      const existing = db.prepare('SELECT 1 AS present FROM purchase_browser_tasks WHERE id = ?').get(row.id)?.present;
      if (existing && strategy === 'preserve') {
        summary.preserved += 1;
        summary.conflicts += 1;
        taskDisposition.set(row.id, 'preserved');
      } else if (existing) {
        summary.updated += 1;
        summary.conflicts += 1;
        taskDisposition.set(row.id, 'updated');
      } else {
        summary.inserted += 1;
        taskDisposition.set(row.id, 'inserted');
      }
      expectedReadback.tasks.push({
        id: row.id,
        shopId: row.shop_id ? targetShopId : null,
        disposition: taskDisposition.get(row.id),
        record: row,
      });
    }
  }

  const receipts = recordsFor(openedProfile, 'purchase-browser-receipts');
  if (receipts.length) {
    const summary = getSummary('purchase-browser-receipts');
    for (const record of receipts) {
      const row = record?.value || {};
      const parentDisposition = taskDisposition.get(row.task_id);
      const existing = db.prepare('SELECT 1 AS present FROM purchase_browser_receipts WHERE id = ?').get(row.id)?.present;
      if (parentDisposition === 'skipped' || (parentDisposition === 'preserved' && !existing)) {
        summary.skippedMissingDependency += 1;
        continue;
      }
      let disposition;
      if (existing && strategy === 'preserve') {
        summary.preserved += 1;
        summary.conflicts += 1;
        disposition = 'preserved';
      } else if (existing) {
        summary.updated += 1;
        summary.conflicts += 1;
        disposition = 'updated';
      } else {
        summary.inserted += 1;
        disposition = 'inserted';
      }
      expectedReadback.receipts.push({
        id: row.id,
        shopId: row.shop_id ? targetShopId : null,
        disposition,
        record: row,
      });
    }
  }

  const history = recordsFor(openedProfile, 'purchase-completion-history');
  if (history.length) {
    const summary = getSummary('purchase-completion-history');
    for (const record of history) {
      const row = record?.value || {};
      const existing = db.prepare(`
        SELECT 1 AS present FROM purchase_completion_history
        WHERE shop_id = ? AND source_receipt_id = ?
      `).get(targetShopId, row.source_receipt_id)?.present;
      let disposition;
      if (existing && strategy === 'preserve') {
        summary.preserved += 1;
        summary.conflicts += 1;
        disposition = 'preserved';
      } else if (existing) {
        summary.updated += 1;
        summary.conflicts += 1;
        disposition = 'updated';
      } else {
        summary.inserted += 1;
        disposition = 'inserted';
      }
      expectedReadback.completionHistory.push({
        shopId: targetShopId,
        sourceReceiptId: row.source_receipt_id,
        disposition,
        record: row,
      });
    }
  }

  // A package is authenticated under its old local id before any of the
  // dispositions above are calculated.  Keep this assertion close to the plan
  // so future profile domains cannot accidentally plan against the target id.
  if (normalizeText(openedProfile.owner.ownerId) !== sourceShopId) {
    fail('DATA_BACKUP_IMPORT_SOURCE_SCOPE_INVALID');
  }
  return {
    domains: [...summaries.values()].sort((left, right) => left.domain.localeCompare(right.domain)),
    expectedReadback,
  };
}

export function publicGenericPlan(genericPlan) {
  return genericPlan.domains.map((domain) => ({
    ...domainSummary(domain.domain, domain.recordCount),
    inserted: Number(domain.inserted) || 0,
    updated: Number(domain.updated) || 0,
    unchanged: Number(domain.unchanged) || 0,
    conflicts: Number(domain.conflicts) || 0,
    preservedFields: Number(domain.preservedFields) || 0,
  }));
}

export function combinedPlanDomains(opened, genericPlan, profilePlan) {
  const plan = new Map([
    ...publicGenericPlan(genericPlan).map((domain) => [domain.domain, domain]),
    ...profilePlan.domains.map((domain) => [domain.domain, domain]),
  ]);
  return opened.domains.map((source) => {
    const summary = plan.get(source.domain) || domainSummary(source.domain, source.recordCount);
    return {
      ...summary,
      schemaVersion: Number(source.schemaVersion) || 1,
      recordCount: Number(source.recordCount) || 0,
    };
  }).sort((left, right) => left.domain.localeCompare(right.domain));
}

export function skippedSummary(domains) {
  const missingDependencies = domains.reduce(
    (total, domain) => total + (Number(domain.skippedMissingDependency) || 0),
    0,
  );
  return { missingDependencies, total: missingDependencies };
}

export function countSummary(domains) {
  const sum = (selector) => domains.reduce((total, domain) => total + selector(domain), 0);
  const incoming = sum((domain) => Number(domain.recordCount) || 0);
  return {
    total: incoming,
    incoming,
    added: sum((domain) => Number(domain.inserted) || 0),
    updated: sum((domain) => Number(domain.updated) || 0),
    preserved: sum((domain) => (
      (Number(domain.preserved) || 0) + (Number(domain.unchanged) || 0)
    )),
    conflicts: sum((domain) => Number(domain.conflicts) || 0),
    skipped: sum((domain) => Number(domain.skippedMissingDependency) || 0),
    failed: 0,
  };
}
