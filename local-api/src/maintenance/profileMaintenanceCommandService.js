import { createHash, randomBytes } from 'node:crypto';
import { DATA_DOMAIN_REGISTRY } from '../data/dataDomainRegistry.js';
import {
  DATA_RESOURCE_REGISTRY,
  getOrdinaryCacheClearResourceIds,
} from '../data/unifiedDataResourceRegistry.js';

export const PROFILE_MAINTENANCE_COMMAND_SERVICE_VERSION = 'profile-maintenance-command-service-v3';
export const PROFILE_DOMAIN_REBUILD_PROOF_VERSION = 'profile-domain-rebuild-trusted-source-proof-v2';
export const PROFILE_DOMAIN_REBUILD_TICKET_VERSION = 'profile-domain-rebuild-one-time-ticket-v1';

export const PROFILE_MAINTENANCE_COMMANDS = Object.freeze({
  RELEASE_SPACE: 'release-space',
  REBUILD_DOMAIN: 'rebuild-domain',
});

export const PROFILE_MAINTENANCE_CONFIRMATIONS = Object.freeze({
  [PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE]: 'RELEASE_RETIRED_PROFILE_SPACE_ONLY',
  [PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN]: 'REBUILD_ONE_PROFILE_DOMAIN_FROM_SOURCE_ONLY',
});

const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_REBUILD_ROWS = 20_000;
const REBUILD_STAGE_TABLE = 'profile_domain_rebuild_stage';
const DOMAIN_PATTERN = /^[a-z][a-z0-9-]{0,79}$/u;
const TRUSTED_ADAPTER_ID_PATTERN = /^[a-z][a-z0-9._:-]{2,119}$/u;
const TRUSTED_VERIFICATION_KINDS = new Set([
  'internal-source-adapter',
  'persisted-successful-sync-proof',
]);
const CALLER_SOURCE_FIELDS = Object.freeze([
  'adapterContext',
  'candidate',
  'evidence',
  'proof',
  'replacementRows',
  'rows',
  'rowsSha256',
  'sourceProof',
  'trustedSourceProof',
]);

const UNAVAILABLE_REBUILD_REASONS = Object.freeze({
  'catalog-category-nodes': Object.freeze({
    code: 'PERSISTED_OZON_CANDIDATE_MISSING',
    message: '尚无与完整类目树绑定的持久成功 Ozon 同步候选；不能把现有目标缓存回抄成来源。',
  }),
  'catalog-category-mappings': Object.freeze({
    code: 'DETERMINISTIC_RECOMPUTER_MISSING',
    message: '映射状态、置信度和备注没有经过审计的 canonical 确定性重算器。',
  }),
  'catalog-attributes': Object.freeze({
    code: 'PERSISTED_OZON_CANDIDATE_MISSING',
    message: '尚无与完整类目/类型范围绑定的持久成功 Ozon 属性候选。',
  }),
  'catalog-attribute-values': Object.freeze({
    code: 'PERSISTED_OZON_CANDIDATE_MISSING',
    message: '尚无与完整属性范围绑定的持久成功 Ozon 字典值候选。',
  }),
  'data-analysis-snapshots': Object.freeze({
    code: 'VERSIONED_RECOMPUTER_MISSING',
    message: '分析类型、口径和计算版本没有统一的 local-api canonical 重算器。',
  }),
  'profit-ledger-snapshots': Object.freeze({
    code: 'VERSIONED_RECOMPUTER_MISSING',
    message: '利润快照依赖版本化计算口径；本入口不得复制旧快照或绕过受保护计算。',
  }),
  'exchange-rate-cache': Object.freeze({
    code: 'PERSISTED_EXTERNAL_SYNC_PROOF_MISSING',
    message: '汇率服务尚未持久化独立于目标缓存的成功同步候选，确认链也禁止临时联网。',
  }),
  'response-cache': Object.freeze({
    code: 'PERSISTED_OZON_CANDIDATE_MISSING',
    message: '通用响应缓存跨多个 endpoint，尚无完整、同一快照的远端候选证明。',
  }),
  'catalog-cache-keys': Object.freeze({
    code: 'CANONICAL_REQUEST_DESCRIPTOR_MISSING',
    message: '请求 cache key 的完整参数描述未保存为 canonical 事实，不能从其他缓存反推。',
  }),
  'catalog-cache-key-registry': Object.freeze({
    code: 'CANONICAL_REQUEST_DESCRIPTOR_MISSING',
    message: '旧类目 cache key 与 canonical 共享类目事实不存在无损一对一映射。',
  }),
  'purchase-browser-plugin-state': Object.freeze({
    code: 'OWNED_RUNTIME_RECONCILER_MISSING',
    message: '插件安装状态属于采购浏览器运行时，必须由其 owner runtime 对账，不能由 local-api 猜测。',
  }),
});

export class ProfileMaintenanceCommandError extends Error {
  constructor(code, message, { status = 409, rollbackVerified = false } = {}) {
    super(message);
    this.name = 'ProfileMaintenanceCommandError';
    this.code = code;
    this.status = status;
    this.rollbackVerified = rollbackVerified;
  }
}

function commandError(code, message, options) {
  return new ProfileMaintenanceCommandError(code, message, options);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function qualifiedTable(schema, tableName) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeValue(value) {
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
  if (Buffer.isBuffer(value)) return { type: 'buffer', value: value.toString('base64') };
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw commandError('PROFILE_MAINTENANCE_ROW_VALUE_INVALID', '重建数据包含非有限数字。', { status: 400 });
  }
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    throw commandError('PROFILE_MAINTENANCE_ROW_VALUE_INVALID', '重建行字段只能使用 SQLite 标量值。', { status: 400 });
  }
  return value;
}

function canonicalRow(row, columns) {
  return JSON.stringify(columns.map((column) => [column, normalizeValue(row[column])]));
}

export function createProfileMaintenanceRowsSha256(rows = [], columns = []) {
  const hash = createHash('sha256');
  rows
    .map((row) => canonicalRow(row, columns))
    .sort()
    .forEach((row) => hash.update(row).update('\n'));
  return hash.digest('hex');
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function listTables(db) {
  return db.prepare(`
    SELECT name, COALESCE(sql, '') AS sql
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => ({ name: String(row.name), sql: String(row.sql || '') }));
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`).all()
    .filter((column) => Number(column.hidden || 0) === 0)
    .sort((left, right) => Number(left.cid) - Number(right.cid))
    .map((column) => String(column.name));
}

function readRows(db, tableName, columns, schema = 'main') {
  if (!columns.length) {
    throw commandError('PROFILE_MAINTENANCE_TABLE_COLUMNS_REQUIRED', `表 ${tableName} 没有可验证字段。`);
  }
  return db.prepare(
    `SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${qualifiedTable(schema, tableName)}`,
  ).all();
}

function tableFingerprint(db, tableName) {
  const columns = tableColumns(db, tableName);
  const rows = readRows(db, tableName, columns);
  return {
    rows: rows.length,
    columns,
    rowsSha256: createProfileMaintenanceRowsSha256(rows, columns),
  };
}

function fingerprintSetDigest(fingerprints) {
  return hashJson(Object.entries(fingerprints)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tableName, fingerprint]) => ({ tableName, ...fingerprint })));
}

function quickCheck(db) {
  return String(db.prepare('PRAGMA quick_check').get()?.quick_check || '');
}

function isExecutableSqliteResource(resource) {
  return resource?.physicalResourceType === 'sqlite-table'
    && resource.storageKind === 'sqlite'
    && typeof resource.sourceRegistryDomain === 'string'
    && resource.sourceRegistryDomain.length > 0;
}

function executablePolicy(resource, policyByDomain) {
  const policy = policyByDomain.get(resource.sourceRegistryDomain);
  if (
    !policy
    || policy.physicalResourceType !== 'sqlite-table'
    || typeof policy.canonicalTable !== 'string'
    || policy.canonicalTable.includes(':')
    || resource.resource !== policy.canonicalTable
  ) {
    throw commandError(
      'PROFILE_MAINTENANCE_RESOURCE_REGISTRY_DRIFT',
      `统一资源注册表 ${resource.id} 未与数据领域注册表的 SQLite 实体对齐。`,
      { status: 500 },
    );
  }
  return Object.freeze({
    ...policy,
    resourceId: resource.id,
    resourceStorageKind: resource.storageKind,
    ordinaryCacheClearDisposition: resource.ordinaryCacheClearDisposition,
    registeredSpaceReleaseDisposition: resource.spaceReleaseDisposition,
    registeredDomainRebuildDisposition: resource.domainRebuildDisposition,
    registeredRebuildStrategy: resource.rebuildStrategy,
  });
}

function releaseSpacePolicies({ domainRegistry, resourceRegistry, ordinaryResourceIds }) {
  const approvedIds = new Set(ordinaryResourceIds);
  const policyByDomain = new Map(domainRegistry.map((policy) => [policy.domain, policy]));
  return resourceRegistry
    .filter((resource) => (
      approvedIds.has(resource.id)
      && isExecutableSqliteResource(resource)
      && resource.ordinaryCacheClearDisposition === 'delete'
      && String(resource.spaceReleaseDisposition || '').includes('space-release')
      && resource.dataClass === 'cache'
      && resource.backup === 'excluded'
      && resource.rebuildable === true
    ))
    .map((resource) => executablePolicy(resource, policyByDomain));
}

function rebuildDomainPolicies({ domainRegistry, resourceRegistry }) {
  const policyByDomain = new Map(domainRegistry.map((policy) => [policy.domain, policy]));
  return resourceRegistry
    .filter((resource) => (
      isExecutableSqliteResource(resource)
      && resource.dataClass === 'cache'
      && resource.backup === 'excluded'
      && resource.rebuildable === true
      && resource.source !== 'user'
      && String(resource.domainRebuildDisposition || '').startsWith('preview-confirm')
    ))
    .map((resource) => executablePolicy(resource, policyByDomain));
}

function normalizeCommand(value) {
  const command = String(value || '').trim();
  if (!Object.values(PROFILE_MAINTENANCE_COMMANDS).includes(command)) {
    throw commandError(
      'PROFILE_MAINTENANCE_COMMAND_BOUNDARY',
      '该入口只执行 release-space 或 rebuild-domain；普通清缓存和永久删店必须走各自独立流程。',
      { status: 400 },
    );
  }
  return command;
}

function normalizeDomain(value) {
  const domain = String(value || '').trim();
  if (!DOMAIN_PATTERN.test(domain)) {
    throw commandError('PROFILE_MAINTENANCE_DOMAIN_REQUIRED', 'rebuild-domain 必须指定一个已登记领域。', { status: 400 });
  }
  return domain;
}

function assertCallerSourceFieldsForbidden(input = {}) {
  const forbidden = CALLER_SOURCE_FIELDS.filter((field) => Object.hasOwn(input, field));
  if (!forbidden.length) return;
  throw commandError(
    'PROFILE_MAINTENANCE_CALLER_SUPPLIED_PROOF_FORBIDDEN',
    `调用者字段 ${forbidden.join(', ')} 不能作为可信来源候选或证明。`,
    { status: 400 },
  );
}

function unavailableRebuildReason(policy) {
  return UNAVAILABLE_REBUILD_REASONS[policy.domain] || Object.freeze({
    code: 'TRUSTED_SOURCE_ADAPTER_MISSING',
    message: `领域 ${policy.domain} 尚无经过审计的可信来源 adapter。`,
  });
}

function inspectOperationState(db, targetPolicies) {
  const tables = listTables(db);
  const tableNames = new Set(tables.map((entry) => entry.name));
  const missingTargets = targetPolicies
    .map((policy) => policy.canonicalTable)
    .filter((tableName) => !tableNames.has(tableName));
  if (missingTargets.length) {
    throw commandError(
      'PROFILE_MAINTENANCE_SCHEMA_DRIFT',
      `注册表目标表不存在：${missingTargets.join(', ')}`,
    );
  }
  const targetTableNames = new Set(targetPolicies.map((policy) => policy.canonicalTable));
  const targets = Object.fromEntries(targetPolicies.map((policy) => [
    policy.canonicalTable,
    {
      domain: policy.domain,
      resourceId: policy.resourceId,
      table: policy.canonicalTable,
      dataClass: policy.dataClass,
      source: policy.source,
      backup: policy.backup,
      rebuildable: policy.rebuildable === true,
      ordinaryCacheClear: policy.ordinaryCacheClear,
      ordinaryCacheClearDisposition: policy.ordinaryCacheClearDisposition,
      spaceReleaseDisposition: policy.registeredSpaceReleaseDisposition,
      domainRebuildDisposition: policy.registeredDomainRebuildDisposition,
      rebuildStrategy: policy.registeredRebuildStrategy,
      storageKind: policy.resourceStorageKind,
      fingerprint: tableFingerprint(db, policy.canonicalTable),
    },
  ]));
  const protectedTables = Object.fromEntries(tables
    .filter((entry) => !targetTableNames.has(entry.name))
    .map((entry) => [entry.name, tableFingerprint(db, entry.name)]));
  const schemaDigest = hashJson(tables.map((entry) => ({ name: entry.name, sql: entry.sql })));
  const protectedDigest = fingerprintSetDigest(protectedTables);
  const targetDigest = fingerprintSetDigest(Object.fromEntries(
    Object.entries(targets).map(([tableName, entry]) => [tableName, entry.fingerprint]),
  ));
  const state = {
    quickCheck: quickCheck(db),
    schemaDigest,
    targetDigest,
    protectedDigest,
    targets,
    protectedTables,
  };
  return { ...state, stateDigest: hashJson({
    quickCheck: state.quickCheck,
    schemaDigest,
    targetDigest,
    protectedDigest,
  }) };
}

function publicTargetResources(state) {
  return Object.values(state.targets).map((entry) => ({
    domain: entry.domain,
    resourceId: entry.resourceId,
    table: entry.table,
    dataClass: entry.dataClass,
    source: entry.source,
    backup: entry.backup,
    rebuildable: entry.rebuildable,
    ordinaryCacheClear: entry.ordinaryCacheClear,
    ordinaryCacheClearDisposition: entry.ordinaryCacheClearDisposition,
    spaceReleaseDisposition: entry.spaceReleaseDisposition,
    domainRebuildDisposition: entry.domainRebuildDisposition,
    rebuildStrategy: entry.rebuildStrategy,
    storageKind: entry.storageKind,
    rows: entry.fingerprint.rows,
    rowsSha256: entry.fingerprint.rowsSha256,
    columns: entry.fingerprint.columns,
  }));
}

function assertProtectedUnchanged(before, after) {
  if (before.schemaDigest !== after.schemaDigest) {
    throw commandError('PROFILE_MAINTENANCE_PROTECTED_SCHEMA_CHANGED', '维护期间 SQLite schema 发生变化，事务已回滚。');
  }
  if (before.protectedDigest !== after.protectedDigest) {
    throw commandError('PROFILE_MAINTENANCE_PROTECTED_DATA_CHANGED', '维护期间 canonical/user/config/secret 或其他受保护资源发生变化，事务已回滚。');
  }
  if (after.quickCheck !== 'ok') {
    throw commandError('PROFILE_MAINTENANCE_SQLITE_READBACK_FAILED', `SQLite quick_check 回读失败：${after.quickCheck || 'unknown'}`);
  }
}

function assertExactRowShape(rows, columns) {
  if (!Array.isArray(rows) || rows.length > MAX_REBUILD_ROWS) {
    throw commandError('PROFILE_MAINTENANCE_REBUILD_ROWS_INVALID', `重建行必须是数组且不超过 ${MAX_REBUILD_ROWS} 行。`, { status: 400 });
  }
  const expected = [...columns].sort();
  rows.forEach((row, index) => {
    if (!isPlainObject(row)) {
      throw commandError('PROFILE_MAINTENANCE_REBUILD_ROWS_INVALID', `重建第 ${index + 1} 行不是对象。`, { status: 400 });
    }
    const actual = Object.keys(row).sort();
    if (actual.length !== expected.length || actual.some((key, position) => key !== expected[position])) {
      throw commandError(
        'PROFILE_MAINTENANCE_REBUILD_ROW_SHAPE_MISMATCH',
        `重建第 ${index + 1} 行字段必须与预览列完全一致。`,
        { status: 400 },
      );
    }
    columns.forEach((column) => normalizeValue(row[column]));
  });
}

function normalizeTrustedAdapterCandidate({ candidate, policy, columns, adapter }) {
  if (!isPlainObject(candidate) || !Array.isArray(candidate.rows) || !isPlainObject(candidate.evidence)) {
    throw commandError(
      'PROFILE_MAINTENANCE_TRUSTED_SOURCE_CANDIDATE_INVALID',
      `可信来源 adapter ${adapter.adapterId} 未返回完整候选和持久成功证据。`,
      { status: 500 },
    );
  }
  assertExactRowShape(candidate.rows, columns);
  const evidence = candidate.evidence;
  const validEvidence = evidence.contractVersion === PROFILE_DOMAIN_REBUILD_PROOF_VERSION
    && evidence.domain === policy.domain
    && evidence.source === policy.source
    && typeof evidence.proofId === 'string'
    && evidence.proofId.trim().length >= 8
    && typeof evidence.observedAt === 'string'
    && !Number.isNaN(Date.parse(evidence.observedAt))
    && TRUSTED_VERIFICATION_KINDS.has(evidence.verificationKind);
  if (!validEvidence) {
    throw commandError(
      'PROFILE_MAINTENANCE_TRUSTED_SOURCE_EVIDENCE_INVALID',
      `可信来源 adapter ${adapter.adapterId} 的成功证据不完整。`,
      { status: 500 },
    );
  }
  const rows = candidate.rows.map((row) => Object.fromEntries(
    columns.map((column) => [column, normalizeValue(row[column])]),
  ));
  return Object.freeze({
    adapterId: adapter.adapterId,
    evidence: Object.freeze({
      contractVersion: evidence.contractVersion,
      domain: evidence.domain,
      observedAt: evidence.observedAt,
      proofId: evidence.proofId.trim(),
      source: evidence.source,
      verificationKind: evidence.verificationKind,
    }),
    rowCount: rows.length,
    rows,
    rowsSha256: createProfileMaintenanceRowsSha256(rows, columns),
  });
}

function insertRows(db, schema, tableName, columns, rows) {
  if (!rows.length) return;
  const placeholders = columns.map(() => '?').join(', ');
  const statement = db.prepare(
    `INSERT INTO ${qualifiedTable(schema, tableName)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${placeholders})`,
  );
  rows.forEach((row) => statement.run(...columns.map((column) => row[column])));
}

function assertRestoredAfterRollback(db, before, targetPolicies) {
  const restored = inspectOperationState(db, targetPolicies);
  if (restored.stateDigest !== before.stateDigest) {
    throw commandError(
      'PROFILE_MAINTENANCE_ROLLBACK_FAILED',
      '维护事务失败后未能恢复原始 canonical snapshot。',
      { status: 500 },
    );
  }
  return true;
}

export function createProfileMaintenanceCommandService({
  db,
  domainRegistry = DATA_DOMAIN_REGISTRY,
  resourceRegistry = DATA_RESOURCE_REGISTRY,
  ordinaryCacheClearResourceIds = getOrdinaryCacheClearResourceIds(),
  trustedRebuildSourceAdapters = {},
  resolveShopDomainDatabase = null,
  previewTtlMs = DEFAULT_PREVIEW_TTL_MS,
  now = () => Date.now(),
  testHooks = {},
} = {}) {
  if (!db?.prepare || !db?.exec) throw new Error('PROFILE_MAINTENANCE_DATABASE_REQUIRED');
  const releasePolicies = releaseSpacePolicies({
    domainRegistry,
    resourceRegistry,
    ordinaryResourceIds: ordinaryCacheClearResourceIds,
  });
  const rebuildPolicies = rebuildDomainPolicies({ domainRegistry, resourceRegistry });
  const approvedOrdinaryResourceIds = [...new Set(ordinaryCacheClearResourceIds)].sort();
  const executableReleaseResourceIds = new Set(releasePolicies.map((policy) => policy.resourceId));
  const deferredNonSqliteResourceIds = approvedOrdinaryResourceIds
    .filter((resourceId) => !executableReleaseResourceIds.has(resourceId));
  const rebuildByDomain = new Map(rebuildPolicies.map((policy) => [policy.domain, policy]));
  const adapterEntries = trustedRebuildSourceAdapters instanceof Map
    ? [...trustedRebuildSourceAdapters.entries()]
    : Object.entries(trustedRebuildSourceAdapters || {});
  const trustedAdapterByDomain = new Map();
  for (const [rawDomain, adapter] of adapterEntries) {
    const domain = normalizeDomain(rawDomain);
    const policy = rebuildByDomain.get(domain);
    if (!policy) throw new Error(`PROFILE_MAINTENANCE_TRUSTED_SOURCE_DOMAIN_INVALID:${domain}`);
    if (
      !adapter
      || typeof adapter !== 'object'
      || !TRUSTED_ADAPTER_ID_PATTERN.test(String(adapter.adapterId || ''))
      || adapter.source !== policy.source
      || typeof adapter.readVerifiedCandidate !== 'function'
    ) {
      throw new Error(`PROFILE_MAINTENANCE_TRUSTED_SOURCE_ADAPTER_INVALID:${domain}`);
    }
    trustedAdapterByDomain.set(domain, adapter);
  }
  const records = new Map();
  const trustedTickets = new Map();
  const consumedTrustedTicketDigests = new Map();
  let active = null;

  function assertCanonicalTargets(policies) {
    if (typeof resolveShopDomainDatabase !== 'function') return;
    const shopPolicies = policies.filter(policy => domainRegistry.find(item => item.domain === policy.domain)?.scopeType === 'shop');
    if (!shopPolicies.length) return;
    const shops = db.prepare('SELECT id FROM shops').all();
    for (const policy of shopPolicies) {
      for (const shop of shops) {
        const target = resolveShopDomainDatabase({ shopId: shop.id, policy, domain: policy.domain, canonicalTable: policy.canonicalTable });
        if ((target?.db || target) !== db) throw commandError('PROFILE_MAINTENANCE_SHOP_STORAGE_REQUIRED',
          '该数据已由独立店库管理，当前全局维护不能安全处理；尚未修改任何数据。', { status: 409 });
      }
    }
  }

  function listContracts() {
    return {
      ok: true,
      version: PROFILE_MAINTENANCE_COMMAND_SERVICE_VERSION,
      commands: {
        [PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE]: {
          confirmation: PROFILE_MAINTENANCE_CONFIRMATIONS[PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE],
          targetDomains: releasePolicies.map((policy) => policy.domain),
          targetResourceIds: releasePolicies.map((policy) => policy.resourceId),
          approvedRegistryResourceIds: approvedOrdinaryResourceIds,
          deferredNonSqliteResourceIds,
          policy: 'unified registry getOrdinaryCacheClearResourceIds + SQLite + cache + backup=excluded + rebuildable=true only',
        },
        [PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN]: {
          confirmation: PROFILE_MAINTENANCE_CONFIRMATIONS[PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN],
          targetDomains: rebuildPolicies
            .filter((policy) => trustedAdapterByDomain.has(policy.domain))
            .map((policy) => policy.domain),
          targetResourceIds: rebuildPolicies
            .filter((policy) => trustedAdapterByDomain.has(policy.domain))
            .map((policy) => policy.resourceId),
          registeredButUnavailableDomains: rebuildPolicies
            .filter((policy) => !trustedAdapterByDomain.has(policy.domain))
            .map((policy) => policy.domain),
          trustedSourceAdapters: rebuildPolicies
            .filter((policy) => trustedAdapterByDomain.has(policy.domain))
            .map((policy) => ({
              adapterId: trustedAdapterByDomain.get(policy.domain).adapterId,
              domain: policy.domain,
              resourceId: policy.resourceId,
              source: policy.source,
            })),
          unavailableDomains: rebuildPolicies
            .filter((policy) => !trustedAdapterByDomain.has(policy.domain))
            .map((policy) => ({
              domain: policy.domain,
              reason: unavailableRebuildReason(policy),
              rebuildStrategy: policy.registeredRebuildStrategy,
              resourceId: policy.resourceId,
              source: policy.source,
            })),
          proofVersion: PROFILE_DOMAIN_REBUILD_PROOF_VERSION,
          ticketVersion: PROFILE_DOMAIN_REBUILD_TICKET_VERSION,
          policy: 'one explicit registry cache domain; trusted internal adapter or persisted successful sync proof; one-time ticket; stage and read back before atomic activation',
        },
      },
      excludedCommand: 'permanent-delete',
      permanentDeleteRoute: '/api/account-removal/preview',
    };
  }

  function resolveTargetPolicies(command, domain) {
    if (command === PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE) return releasePolicies;
    const policy = rebuildByDomain.get(domain);
    if (!policy) {
      throw commandError(
        'PROFILE_MAINTENANCE_DOMAIN_NOT_REBUILDABLE',
        `领域 ${domain} 未在注册表中明确允许 stage/proof/activate 重建。`,
        { status: 400 },
      );
    }
    if (!trustedAdapterByDomain.has(domain)) {
      throw commandError(
        'PROFILE_MAINTENANCE_TRUSTED_SOURCE_UNAVAILABLE',
        `领域 ${domain} 没有注册可信 local-api 来源 adapter，默认拒绝重建。`,
        { status: 409 },
      );
    }
    return [policy];
  }

  function cleanupTrustedTicketState(atMs = Number(now())) {
    for (const [ticket, entry] of trustedTickets) {
      if (entry.expiresAtMs <= atMs) trustedTickets.delete(ticket);
    }
    for (const [digest, expiresAtMs] of consumedTrustedTicketDigests) {
      if (expiresAtMs <= atMs) consumedTrustedTicketDigests.delete(digest);
    }
  }

  function trustedTicketDigest(ticket) {
    return createHash('sha256').update(ticket, 'utf8').digest('hex');
  }

  function assertTrustedTicketNotReplayed(ticket) {
    if (!ticket) return;
    cleanupTrustedTicketState();
    if (consumedTrustedTicketDigests.has(trustedTicketDigest(ticket))) {
      throw commandError(
        'PROFILE_MAINTENANCE_TRUSTED_SOURCE_TICKET_REPLAYED',
        '可信来源 ticket 已消费，必须重新预览并从内部来源 adapter 取得新 ticket。',
        { status: 409 },
      );
    }
  }

  function consumeTrustedRebuildTicket({ ticket, previewToken, domain }) {
    const normalizedTicket = String(ticket || '').trim();
    if (!normalizedTicket) {
      throw commandError(
        'PROFILE_MAINTENANCE_TRUSTED_SOURCE_TICKET_REQUIRED',
        'rebuild-domain 必须提交由 local-api 内部可信来源 adapter 签发的一次性 ticket。',
        { status: 400 },
      );
    }
    assertTrustedTicketNotReplayed(normalizedTicket);
    const entry = trustedTickets.get(normalizedTicket);
    if (!entry) {
      throw commandError(
        'PROFILE_MAINTENANCE_TRUSTED_SOURCE_TICKET_INVALID',
        '可信来源 ticket 不存在、已过期或并非由当前 local-api 进程签发。',
        { status: 409 },
      );
    }
    trustedTickets.delete(normalizedTicket);
    consumedTrustedTicketDigests.set(trustedTicketDigest(normalizedTicket), entry.expiresAtMs);
    if (entry.expiresAtMs <= Number(now())) {
      throw commandError(
        'PROFILE_MAINTENANCE_TRUSTED_SOURCE_TICKET_EXPIRED',
        '可信来源 ticket 已过期，必须重新读取可信来源。',
        { status: 409 },
      );
    }
    if (entry.previewToken !== previewToken || entry.domain !== domain) {
      throw commandError(
        'PROFILE_MAINTENANCE_TRUSTED_SOURCE_TICKET_MISMATCH',
        '可信来源 ticket 与本次人工预览或领域不一致。',
        { status: 409 },
      );
    }
    return entry;
  }

  function issueTrustedRebuildTicket({
    domain: rawDomain,
    humanConfirmationToken,
    ...untrustedSourceInput
  } = {}) {
    assertCallerSourceFieldsForbidden(untrustedSourceInput);
    const domain = normalizeDomain(rawDomain);
    const previewToken = String(humanConfirmationToken || '').trim();
    const record = records.get(previewToken);
    if (
      !record
      || record.command !== PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN
      || record.domain !== domain
    ) {
      throw commandError(
        'PROFILE_MAINTENANCE_PREVIEW_REQUIRED',
        '可信来源 ticket 必须绑定仍有效的 rebuild-domain 人工预览。',
        { status: 400 },
      );
    }
    if (record.expiresAtMs <= Number(now())) {
      records.delete(previewToken);
      throw commandError('PROFILE_MAINTENANCE_PREVIEW_EXPIRED', '预览已过期，请重新预览。');
    }
    const policy = record.targetPolicies[0];
    assertCanonicalTargets(record.targetPolicies);
    const adapter = trustedAdapterByDomain.get(domain);
    if (!adapter) {
      throw commandError(
        'PROFILE_MAINTENANCE_TRUSTED_SOURCE_UNAVAILABLE',
        `领域 ${domain} 没有注册可信 local-api 来源 adapter，默认拒绝重建。`,
      );
    }
    const current = inspectOperationState(db, record.targetPolicies);
    if (current.stateDigest !== record.before.stateDigest) {
      throw commandError('PROFILE_MAINTENANCE_PREVIEW_STALE', '预览后数据或 schema 已变化，已拒绝签发 ticket。');
    }
    if (record.trustedTicketResponse) {
      const existingTicket = record.trustedTicketResponse.trustedSourceTicket;
      const existingEntry = trustedTickets.get(existingTicket);
      if (existingEntry && existingEntry.expiresAtMs > Number(now())) {
        return record.trustedTicketResponse;
      }
      record.trustedTicketResponse = null;
    }
    const columns = record.before.targets[policy.canonicalTable].fingerprint.columns;
    const candidate = adapter.readVerifiedCandidate(Object.freeze({
      domain,
      expectedSource: policy.source,
      previewIssuedAt: new Date(record.issuedAtMs).toISOString(),
      requiredColumns: Object.freeze([...columns]),
    }));
    if (candidate && typeof candidate.then === 'function') {
      throw commandError(
        'PROFILE_MAINTENANCE_TRUSTED_SOURCE_ADAPTER_ASYNC_UNSUPPORTED',
        '可信来源 adapter 必须读取已经持久成功的同步证明，不能在确认链中临时联网。',
        { status: 500 },
      );
    }
    const normalizedCandidate = normalizeTrustedAdapterCandidate({
      adapter,
      candidate,
      columns,
      policy,
    });
    cleanupTrustedTicketState();
    const trustedSourceTicket = randomBytes(48).toString('base64url');
    trustedTickets.set(trustedSourceTicket, Object.freeze({
      ...normalizedCandidate,
      domain,
      expiresAtMs: record.expiresAtMs,
      previewToken,
      ticketVersion: PROFILE_DOMAIN_REBUILD_TICKET_VERSION,
    }));
    const response = Object.freeze({
      ok: true,
      adapterId: normalizedCandidate.adapterId,
      domain,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      proofId: normalizedCandidate.evidence.proofId,
      rowCount: normalizedCandidate.rowCount,
      rowsSha256: normalizedCandidate.rowsSha256,
      source: policy.source,
      ticketVersion: PROFILE_DOMAIN_REBUILD_TICKET_VERSION,
      trustedSourceTicket,
    });
    record.trustedTicketResponse = response;
    return response;
  }

  function preview(input = {}) {
    const command = normalizeCommand(input.command);
    const domain = command === PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN
      ? normalizeDomain(input.domain)
      : null;
    const targetPolicies = resolveTargetPolicies(command, domain);
    assertCanonicalTargets(targetPolicies);
    const before = inspectOperationState(db, targetPolicies);
    if (before.quickCheck !== 'ok') {
      throw commandError('PROFILE_MAINTENANCE_SQLITE_INVALID', `SQLite quick_check 失败：${before.quickCheck || 'unknown'}`);
    }
    const issuedAtMs = Number(now());
    const expiresAtMs = issuedAtMs + Number(previewTtlMs);
    const humanConfirmationToken = randomBytes(32).toString('hex');
    const record = {
      command,
      domain,
      targetPolicies,
      before,
      issuedAtMs,
      expiresAtMs,
    };
    records.set(humanConfirmationToken, record);
    for (const [token, candidate] of records) {
      if (candidate.expiresAtMs <= issuedAtMs) records.delete(token);
    }
    const targetResources = publicTargetResources(before);
    return {
      ok: true,
      mode: 'profile-maintenance-read-only-preview',
      version: PROFILE_MAINTENANCE_COMMAND_SERVICE_VERSION,
      command,
      domain,
      confirmation: PROFILE_MAINTENANCE_CONFIRMATIONS[command],
      requiresHumanConfirmation: true,
      humanConfirmationToken,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      targetResources,
      targetRows: targetResources.reduce((sum, entry) => sum + entry.rows, 0),
      protected: {
        tables: Object.keys(before.protectedTables).length,
        digest: before.protectedDigest,
        schemaDigest: before.schemaDigest,
        rule: 'all non-target SQLite tables, including canonical/user/config/secret and unknown tables',
      },
      ...(command === PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE ? {
        registryBoundary: {
          approvedResourceIds: approvedOrdinaryResourceIds,
          executableResourceIds: releasePolicies.map((policy) => policy.resourceId),
          deferredNonSqliteResourceIds,
          deferredRule: 'non-SQLite resources require their owning runtime invalidation primitive; never guess or cross-process delete',
        },
      } : {}),
      ...(command === PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN ? {
        trustedSource: {
          adapterId: trustedAdapterByDomain.get(domain).adapterId,
          callerSuppliedProofAccepted: false,
          proofContractVersion: PROFILE_DOMAIN_REBUILD_PROOF_VERSION,
          source: targetPolicies[0].source,
          ticketVersion: PROFILE_DOMAIN_REBUILD_TICKET_VERSION,
          ticketIssuance: 'local-api-internal-only',
          oldCanonicalPreservedUntilProofActivation: true,
        },
      } : {}),
    };
  }

  function confirm(input = {}) {
    const command = normalizeCommand(input.command);
    const domain = command === PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN
      ? normalizeDomain(input.domain)
      : null;
    if (command === PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN) {
      assertCallerSourceFieldsForbidden(input);
    }
    const submittedTrustedTicket = command === PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN
      ? String(input.trustedSourceTicket || '').trim()
      : '';
    assertTrustedTicketNotReplayed(submittedTrustedTicket);
    const token = String(input.humanConfirmationToken || '').trim();
    if (!token) {
      throw commandError('PROFILE_MAINTENANCE_PREVIEW_REQUIRED', '必须先预览并提交 humanConfirmationToken。', { status: 400 });
    }
    const record = records.get(token);
    if (!record) {
      throw commandError('PROFILE_MAINTENANCE_PREVIEW_REQUIRED', '预览不存在或已经使用，请重新预览。', { status: 400 });
    }
    assertCanonicalTargets(record.targetPolicies);
    if (Number(now()) >= record.expiresAtMs) {
      records.delete(token);
      throw commandError('PROFILE_MAINTENANCE_PREVIEW_EXPIRED', '预览已过期，请重新预览。');
    }
    if (record.command !== command || record.domain !== domain) {
      throw commandError('PROFILE_MAINTENANCE_PREVIEW_MISMATCH', '确认命令或领域与预览不一致。');
    }
    if (input.confirmation !== PROFILE_MAINTENANCE_CONFIRMATIONS[command]) {
      throw commandError('PROFILE_MAINTENANCE_CONFIRMATION_REQUIRED', '缺少该维护命令独立的人工确认口令。', { status: 400 });
    }
    if (active) {
      throw commandError('PROFILE_MAINTENANCE_ALREADY_RUNNING', '另一个 profile 维护命令正在锁内执行。');
    }

    const trustedCandidate = command === PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN
      ? consumeTrustedRebuildTicket({
          ticket: submittedTrustedTicket,
          previewToken: token,
          domain,
        })
      : null;
    active = { command, domain, token };
    records.delete(token);
    let transactionOpen = false;
    let mutationStarted = false;
    let rollbackBaseline = null;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const current = inspectOperationState(db, record.targetPolicies);
      rollbackBaseline = current;
      if (current.stateDigest !== record.before.stateDigest) {
        throw commandError('PROFILE_MAINTENANCE_PREVIEW_STALE', '预览后数据或 schema 已变化，已拒绝执行。');
      }

      let operation;
      if (command === PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE) {
        mutationStarted = true;
        const deleted = record.targetPolicies.map((policy) => ({
          domain: policy.domain,
          table: policy.canonicalTable,
          rows: Number(db.prepare(`DELETE FROM ${qualifiedTable('main', policy.canonicalTable)}`).run().changes) || 0,
        }));
        testHooks.afterMutation?.({ command, domain, db, before: record.before });
        const after = inspectOperationState(db, record.targetPolicies);
        assertProtectedUnchanged(record.before, after);
        const remaining = Object.values(after.targets).filter((entry) => entry.fingerprint.rows !== 0);
        if (remaining.length) {
          throw commandError('PROFILE_MAINTENANCE_RELEASE_READBACK_FAILED', 'release-space 回读仍存在目标缓存行。');
        }
        operation = {
          deleted,
          releasedRows: deleted.reduce((sum, entry) => sum + entry.rows, 0),
          after,
        };
      } else {
        const policy = record.targetPolicies[0];
        const columns = record.before.targets[policy.canonicalTable].fingerprint.columns;
        const rows = trustedCandidate.rows;
        const proofReadback = {
          rowCount: trustedCandidate.rowCount,
          rowsSha256: trustedCandidate.rowsSha256,
        };

        db.exec(`DROP TABLE IF EXISTS ${qualifiedTable('temp', REBUILD_STAGE_TABLE)}`);
        db.exec(
          `CREATE TEMP TABLE ${quoteIdentifier(REBUILD_STAGE_TABLE)} AS SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${qualifiedTable('main', policy.canonicalTable)} WHERE 0`,
        );
        insertRows(db, 'temp', REBUILD_STAGE_TABLE, columns, rows);
        const stagedRows = readRows(db, REBUILD_STAGE_TABLE, columns, 'temp');
        const stagedSha256 = createProfileMaintenanceRowsSha256(stagedRows, columns);
        if (stagedRows.length !== proofReadback.rowCount || stagedSha256 !== proofReadback.rowsSha256) {
          throw commandError('PROFILE_MAINTENANCE_REBUILD_STAGE_PROOF_FAILED', 'staging 回读与来源 proof 不一致。');
        }

        mutationStarted = true;
        db.prepare(`DELETE FROM ${qualifiedTable('main', policy.canonicalTable)}`).run();
        db.exec(
          `INSERT INTO ${qualifiedTable('main', policy.canonicalTable)} (${columns.map(quoteIdentifier).join(', ')}) SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${qualifiedTable('temp', REBUILD_STAGE_TABLE)}`,
        );
        testHooks.afterMutation?.({ command, domain, db, before: record.before });
        const after = inspectOperationState(db, record.targetPolicies);
        assertProtectedUnchanged(record.before, after);
        const activated = after.targets[policy.canonicalTable].fingerprint;
        if (activated.rows !== proofReadback.rowCount || activated.rowsSha256 !== proofReadback.rowsSha256) {
          throw commandError('PROFILE_MAINTENANCE_REBUILD_ACTIVATION_FAILED', '重建 canonical 激活回读与 proof 不一致。');
        }
        db.exec(`DROP TABLE IF EXISTS ${qualifiedTable('temp', REBUILD_STAGE_TABLE)}`);
        operation = {
          activation: {
            domain,
            table: policy.canonicalTable,
            proofId: trustedCandidate.evidence.proofId,
            source: policy.source,
            trustedSource: {
              adapterId: trustedCandidate.adapterId,
              callerSuppliedProofAccepted: false,
              observedAt: trustedCandidate.evidence.observedAt,
              ticketVersion: trustedCandidate.ticketVersion,
              verificationKind: trustedCandidate.evidence.verificationKind,
            },
            oldCanonicalSnapshot: record.before.targets[policy.canonicalTable].fingerprint,
            stagedSnapshot: proofReadback,
            activatedSnapshot: activated,
            oldCanonicalPreservedUntilProofActivation: true,
            stagedProofVerifiedBeforeActivation: true,
            activatedAtomically: true,
          },
          after,
        };
      }

      db.exec('COMMIT');
      transactionOpen = false;
      return {
        ok: true,
        completed: true,
        mode: 'profile-maintenance-confirmed-and-read-back',
        version: PROFILE_MAINTENANCE_COMMAND_SERVICE_VERSION,
        command,
        domain,
        lock: { kind: 'service-exclusive + SQLite BEGIN IMMEDIATE', heldThroughReadback: true },
        humanConfirmationToken: token,
        protectedDigestBefore: record.before.protectedDigest,
        protectedDigestAfter: operation.after.protectedDigest,
        schemaDigestBefore: record.before.schemaDigest,
        schemaDigestAfter: operation.after.schemaDigest,
        ...operation,
      };
    } catch (caught) {
      let rollbackVerified = !mutationStarted;
      try {
        if (transactionOpen) db.exec('ROLLBACK');
        transactionOpen = false;
        db.exec(`DROP TABLE IF EXISTS ${qualifiedTable('temp', REBUILD_STAGE_TABLE)}`);
        rollbackVerified = mutationStarted
          ? assertRestoredAfterRollback(db, rollbackBaseline || record.before, record.targetPolicies)
          : true;
      } catch (rollbackError) {
        throw commandError(
          'PROFILE_MAINTENANCE_ROLLBACK_FAILED',
          `维护失败且原始 snapshot 回读失败：${rollbackError.message}`,
          { status: 500 },
        );
      }
      const error = caught instanceof ProfileMaintenanceCommandError
        ? caught
        : commandError('PROFILE_MAINTENANCE_EXECUTION_FAILED', caught?.message || String(caught), { status: 500 });
      error.rollbackVerified = rollbackVerified;
      throw error;
    } finally {
      if (transactionOpen) {
        try { db.exec('ROLLBACK'); } catch { /* best effort */ }
      }
      active = null;
    }
  }

  return Object.freeze({
    confirm,
    issueTrustedRebuildTicket,
    listContracts,
    preview,
  });
}
