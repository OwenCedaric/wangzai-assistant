import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  aggregateCrossBorderOrderCharges,
  createCrossBorderChargePhysicalIdentity,
  inferCrossBorderChargeDirection,
  summarizeCrossBorderLedger,
} from '../src/domain/logistics/crossBorderChargeAccounting.js';
import {
  compactCrossBorderRechargePolicy,
  createCrossBorderRechargePolicy,
  resolveCrossBorderCashRate,
} from '../src/domain/logistics/crossBorderChargeConversion.js';
import { buildCrossBorderOrderOverridePatch } from '../src/domain/logistics/crossBorderChargeService.js';
import { createCrossBorderChargeRepository } from '../src/db/repositories/crossBorderChargeRepository.js';
import { createCrossBorderOrderRepository } from '../src/db/repositories/crossBorderOrderRepository.js';
import { createPurchaseOrderOverrideRepository } from '../src/db/repositories/purchaseOrderOverrideRepository.js';
import { createStableHash } from '../src/utils/stableHash.js';

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join('|') : value == null ? '' : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function writeCsv(path, rows) {
  const columns = [
    'shopId', 'postingNumber', 'collectionNumbers', 'collectionCount', 'statementCount',
    'expenseCny', 'incomeCny', 'ledgerNetCny', 'cashExpenseCny', 'cashIncomeCny', 'cashNetCny',
    'conversionRate', 'oldActualFeeCny', 'newActualFeeCny',
    'differenceCny', 'changed', 'conserved',
  ];
  const lines = [columns.join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))];
  writeFileSync(path, `${lines.join('\r\n')}\r\n`, 'utf8');
}

function toStatement(row) {
  return {
    collectionNumber: row.collection_number,
    direction: inferCrossBorderChargeDirection({ direction: row.direction, reason: row.reason, amountCny: row.amount_cny }),
    amountCny: Math.abs(Number(row.amount_cny) || 0),
    balanceAfterCny: row.balance_after_cny,
    reason: row.reason || '',
    occurredAt: row.occurred_at || '',
    warehouse: row.warehouse || '',
    serviceCompany: row.service_company || '',
  };
}

function materializeLegacyRechargeHistory(value, policy) {
  const root = value && typeof value === 'object' && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : {};
  const state = root.global && typeof root.global === 'object' && !Array.isArray(root.global)
    ? root.global
    : root;
  const plans = Array.isArray(state.plans) ? state.plans : [];
  const plan = plans.find((item) => String(item?.id || '') === String(policy.planId || ''));
  if (!plan?.settings || (Array.isArray(plan.settings.rechargeRateHistory)
    && plan.settings.rechargeRateHistory.length > 0)) {
    return { changed: false, value: root };
  }
  const entries = (Array.isArray(policy.entries) ? policy.entries : []).filter((entry) => entry.id !== 'unconfigured-one-to-one');
  if (!entries.length) return { changed: false, value: root };
  plan.settings.rechargeRateHistory = entries.map((entry) => ({
    id: entry.id,
    effectiveAt: entry.effectiveAt,
    rechargeAmount: String(entry.cashPaidCny),
    giftAmount: String(entry.giftCreditCny),
  }));
  return { changed: true, value: root };
}

function physicalRecordKey(row, sourceRecordHash) {
  return [row.tenant_id, row.user_id, row.profile_id, row.browser_account_ref, sourceRecordHash].join('\u001f');
}

function collectionScopeKey(row) {
  return [row.tenant_id, row.user_id, row.profile_id, row.browser_account_ref, row.collection_number].join('\u001f');
}

const applyChanges = process.argv.includes('--apply');
const skipBackup = process.argv.includes('--skip-backup');
const defaultDatabase = resolve(
  process.env.APPDATA || '',
  'wangzai-desktop',
  'local-api-data',
  'wangzai-local-api.sqlite',
);
const databasePath = resolve(argValue('database', defaultDatabase));
if (!existsSync(databasePath)) throw new Error(`数据库不存在：${databasePath}`);

const runId = compactTimestamp();
const outputDir = resolve(argValue('output-dir', resolve('..', 'outputs', 'cross-border-charge-reconciliation', runId)));
mkdirSync(outputDir, { recursive: true });
const db = new DatabaseSync(databasePath, { readOnly: !applyChanges });
db.exec('PRAGMA busy_timeout = 30000');

const recordRows = db.prepare('SELECT * FROM cross_border_charge_records ORDER BY tenant_id, user_id, profile_id, browser_account_ref, collection_number, occurred_at, id').all();
const linkRows = db.prepare('SELECT * FROM cross_border_charge_links ORDER BY tenant_id, user_id, profile_id, browser_account_ref, collection_number').all();
const overrideRows = db.prepare('SELECT shop_id, order_key, raw_json FROM purchase_order_overrides').all();
const overridesByKey = new Map(overrideRows.map((row) => [[row.shop_id, row.order_key].join('\u001f'), parseJson(row.raw_json, {})]));
const feeSettingRow = db.prepare("SELECT value_json, updated_at FROM profile_settings WHERE namespace = 'fee-settings'").get();
const feeSettingValue = parseJson(feeSettingRow?.value_json, {});
const rechargePolicy = createCrossBorderRechargePolicy(feeSettingValue, {
  updatedAt: feeSettingRow?.updated_at || '',
});
const compactRechargePolicy = compactCrossBorderRechargePolicy(rechargePolicy);
const materializedFeeSetting = materializeLegacyRechargeHistory(feeSettingValue, compactRechargePolicy);
const ledgerOptions = {
  resolveCashRate: (occurredAt) => resolveCrossBorderCashRate(rechargePolicy, occurredAt),
};

const deduplicatedRecords = new Map();
let correctedDirectionCount = 0;
recordRows.forEach((row) => {
  const statement = toStatement(row);
  if (statement.direction !== row.direction) correctedDirectionCount += 1;
  const physicalIdentity = createCrossBorderChargePhysicalIdentity(statement);
  const sourceRecordHash = createStableHash(physicalIdentity, { length: 40 });
  const normalized = { ...row, ...statement, sourceRecordHash, raw: { ...parseJson(row.raw_json, {}), ...statement } };
  deduplicatedRecords.set(physicalRecordKey(row, sourceRecordHash), normalized);
});
const normalizedRecords = [...deduplicatedRecords.values()];

const recordsByCollection = new Map();
normalizedRecords.forEach((row) => {
  const key = collectionScopeKey(row);
  const rows = recordsByCollection.get(key) || [];
  rows.push(row);
  recordsByCollection.set(key, rows);
});

const orphanLinks = [];
const recalculatedLinks = linkRows.map((row) => {
  const statements = recordsByCollection.get(collectionScopeKey(row)) || [];
  if (!statements.length) orphanLinks.push({ collectionNumber: row.collection_number, postingNumber: row.posting_number });
  const oldEvidence = parseJson(row.evidence_json, {});
  const ledger = statements.length
    ? summarizeCrossBorderLedger(statements, ledgerOptions)
    : {
      statementCount: 0,
      expenseCny: 0,
      incomeCny: 0,
      ledgerNetCny: Number(row.ledger_net_cny) || 0,
      actualFeeCny: Number(row.actual_fee_cny) || 0,
      cashExpenseCny: Number(oldEvidence.cashExpenseCny) || 0,
      cashIncomeCny: Number(oldEvidence.cashIncomeCny) || 0,
      cashNetCny: Number(oldEvidence.cashNetCny) || Number(row.actual_fee_cny) || 0,
      conversions: [],
    };
  const sourceHash = createStableHash({
    browserAccountRef: row.browser_account_ref,
    crossBorderAccountId: row.cross_border_account_id || '',
    externalAccountRef: row.external_account_ref || '',
    collectionNumber: row.collection_number,
    postingNumber: row.posting_number,
    statementHashes: statements.map((statement) => statement.sourceRecordHash),
    ledgerNetCny: ledger.ledgerNetCny,
    cashNetCny: ledger.cashNetCny,
    actualFeeCny: ledger.actualFeeCny,
    conversionPolicy: compactRechargePolicy,
    matchStatus: row.match_status,
    shopId: row.shop_id || '',
  }, { length: 40 });
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    profileId: row.profile_id,
    browserAccountRef: row.browser_account_ref,
    crossBorderAccountId: row.cross_border_account_id || '',
    externalAccountRef: row.external_account_ref || '',
    shopId: row.shop_id || '',
    collectionNumber: row.collection_number,
    postingNumber: row.posting_number || '',
    ozonOrderKey: row.ozon_order_key || row.posting_number || '',
    purchaseOrderNumber: row.purchase_order_number || '',
    internalOrderId: oldEvidence.internalOrderId || '',
    serviceName: row.service_name || '',
    warehouse: row.warehouse || statements[0]?.warehouse || '',
    matchStatus: row.match_status,
    confidence: row.confidence,
    currency: row.currency || 'CNY',
    sourceHash,
    statements,
    conversionPolicy: compactRechargePolicy,
    conversions: ledger.conversions,
    ...ledger,
    evidence: {
      ...oldEvidence,
      source: 'cross-border-bus-ledger-cash-converted',
      sourceHash,
      statementCount: ledger.statementCount,
      expenseCny: ledger.expenseCny,
      incomeCny: ledger.incomeCny,
      ledgerNetCny: ledger.ledgerNetCny,
      balanceNetCny: ledger.ledgerNetCny,
      cashExpenseCny: ledger.cashExpenseCny,
      cashIncomeCny: ledger.cashIncomeCny,
      cashNetCny: ledger.cashNetCny,
      actualFeeCny: ledger.actualFeeCny,
      conversionPolicy: compactRechargePolicy,
      conversions: ledger.conversions,
      reconciledAt: new Date().toISOString(),
    },
  };
});

const exactGroups = aggregateCrossBorderOrderCharges(recalculatedLinks).map((group) => ({
  ...group,
  conversionPolicy: compactRechargePolicy,
  sourceHash: createStableHash({
    shopId: group.shopId,
    orderKey: group.orderKey,
    collections: group.collections,
    expenseCny: group.expenseCny,
    incomeCny: group.incomeCny,
    ledgerNetCny: group.ledgerNetCny,
    cashExpenseCny: group.cashExpenseCny,
    cashIncomeCny: group.cashIncomeCny,
    cashNetCny: group.cashNetCny,
    actualFeeCny: group.actualFeeCny,
    conversionPolicy: compactRechargePolicy,
  }, { length: 40 }),
}));

const reportRows = exactGroups.map((group) => {
  const oldOverride = overridesByKey.get([group.shopId, group.orderKey].join('\u001f')) || {};
  const oldActualFeeCny = oldOverride.actualCrossBorderBusFeeCny == null
    ? null
    : roundMoney(oldOverride.actualCrossBorderBusFeeCny);
  const differenceCny = roundMoney(group.actualFeeCny - (oldActualFeeCny || 0));
  const collectionNet = roundMoney(group.collections.reduce((sum, row) => sum + row.ledgerNetCny, 0));
  return {
    shopId: group.shopId,
    postingNumber: group.postingNumber,
    collectionNumbers: group.collectionNumbers,
    collectionCount: group.collectionNumbers.length,
    statementCount: group.statementCount,
    expenseCny: group.expenseCny,
    incomeCny: group.incomeCny,
    ledgerNetCny: group.ledgerNetCny,
    cashExpenseCny: group.cashExpenseCny,
    cashIncomeCny: group.cashIncomeCny,
    cashNetCny: group.cashNetCny,
    conversionRate: compactRechargePolicy.defaultRate,
    oldActualFeeCny,
    newActualFeeCny: group.actualFeeCny,
    differenceCny,
    changed: oldActualFeeCny === null || differenceCny !== 0,
    conserved: collectionNet === group.ledgerNetCny,
  };
}).sort((left, right) => left.postingNumber.localeCompare(right.postingNumber));

const ledger = summarizeCrossBorderLedger(normalizedRecords, ledgerOptions);
const exactLedgerNetCny = roundMoney(exactGroups.reduce((sum, row) => sum + row.ledgerNetCny, 0));
const unmatchedLedgerNetCny = roundMoney(recalculatedLinks
  .filter((row) => row.matchStatus === 'unmatched')
  .reduce((sum, row) => sum + row.ledgerNetCny, 0));
const ambiguousLedgerNetCny = roundMoney(recalculatedLinks
  .filter((row) => row.matchStatus === 'ambiguous')
  .reduce((sum, row) => sum + row.ledgerNetCny, 0));
const allocatedLedgerNetCny = roundMoney(exactLedgerNetCny + unmatchedLedgerNetCny + ambiguousLedgerNetCny);
const exactCashNetCny = Math.round(exactGroups.reduce((sum, row) => sum + row.cashNetCny, 0) * 1_000_000) / 1_000_000;
const unmatchedCashNetCny = Math.round(recalculatedLinks
  .filter((row) => row.matchStatus === 'unmatched')
  .reduce((sum, row) => sum + row.cashNetCny, 0) * 1_000_000) / 1_000_000;
const ambiguousCashNetCny = Math.round(recalculatedLinks
  .filter((row) => row.matchStatus === 'ambiguous')
  .reduce((sum, row) => sum + row.cashNetCny, 0) * 1_000_000) / 1_000_000;
const allocatedCashNetCny = Math.round((exactCashNetCny + unmatchedCashNetCny + ambiguousCashNetCny) * 1_000_000) / 1_000_000;
const summary = {
  runId,
  mode: applyChanges ? 'apply' : 'dry-run',
  databasePath,
  databaseFile: basename(databasePath),
  sourceRecordCount: recordRows.length,
  normalizedRecordCount: normalizedRecords.length,
  duplicatePhysicalRecordCount: recordRows.length - normalizedRecords.length,
  correctedDirectionCount,
  linkCount: recalculatedLinks.length,
  exactCollectionCount: recalculatedLinks.filter((row) => row.matchStatus === 'exact').length,
  exactOrderCount: exactGroups.length,
  unmatchedCollectionCount: recalculatedLinks.filter((row) => row.matchStatus === 'unmatched').length,
  ambiguousCollectionCount: recalculatedLinks.filter((row) => row.matchStatus === 'ambiguous').length,
  orphanLinkCount: orphanLinks.length,
  changedOrderCount: reportRows.filter((row) => row.changed).length,
  multipleCollectionOrderCount: reportRows.filter((row) => row.collectionCount > 1).length,
  unconservedOrderCount: reportRows.filter((row) => !row.conserved).length,
  expenseCny: ledger.expenseCny,
  incomeCny: ledger.incomeCny,
  ledgerNetCny: ledger.ledgerNetCny,
  exactLedgerNetCny,
  unmatchedLedgerNetCny,
  ambiguousLedgerNetCny,
  allocatedLedgerNetCny,
  globalConserved: allocatedLedgerNetCny === ledger.ledgerNetCny,
  cashExpenseCny: ledger.cashExpenseCny,
  cashIncomeCny: ledger.cashIncomeCny,
  cashNetCny: ledger.cashNetCny,
  exactCashNetCny,
  unmatchedCashNetCny,
  ambiguousCashNetCny,
  allocatedCashNetCny,
  cashGlobalConserved: allocatedCashNetCny === ledger.cashNetCny,
  conversionPolicy: compactRechargePolicy,
  feeSettingHistoryMigrated: materializedFeeSetting.changed,
  exactActualFeeCny: roundMoney(exactGroups.reduce((sum, row) => sum + row.actualFeeCny, 0)),
};

let backupPath = '';
if (applyChanges) {
  if (!skipBackup) {
    const backupDir = resolve(outputDir, 'backup');
    mkdirSync(backupDir, { recursive: true });
    backupPath = resolve(backupDir, `${basename(databasePath)}.${runId}.bak`);
    await backup(db, backupPath, { rate: 256 });
  }

  const timestamp = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const chargeRepository = createCrossBorderChargeRepository(db);
    const crossBorderOrderRepository = createCrossBorderOrderRepository(db);
    const purchaseOverrideRepository = createPurchaseOrderOverrideRepository(db);
    if (materializedFeeSetting.changed) {
      db.prepare("UPDATE profile_settings SET value_json = ? WHERE namespace = 'fee-settings'")
        .run(JSON.stringify(materializedFeeSetting.value));
    }
    const preserveRecordCreatedAt = db.prepare(`
      UPDATE cross_border_charge_records
      SET created_at = ?
      WHERE tenant_id = ? AND user_id = ? AND profile_id = ?
        AND browser_account_ref = ? AND source_record_hash = ?
    `);
    db.exec('DELETE FROM cross_border_charge_records');
    normalizedRecords.forEach((row) => {
      chargeRepository.upsertChargeRecords([{
        browserAccountRef: row.browser_account_ref,
        crossBorderAccountId: row.cross_border_account_id || '',
        externalAccountRef: row.external_account_ref || '',
        shopId: row.shop_id || '',
        collectionNumber: row.collection_number,
        postingNumber: row.posting_number || '',
        purchaseOrderNumber: row.purchase_order_number || '',
        direction: row.direction,
        amountCny: row.amountCny,
        balanceAfterCny: row.balanceAfterCny,
        reason: row.reason,
        occurredAt: row.occurredAt,
        warehouse: row.warehouse,
        serviceCompany: row.serviceCompany,
        raw: row.raw,
      }], { tenantId: row.tenant_id, userId: row.user_id, profileId: row.profile_id });
      preserveRecordCreatedAt.run(
        row.created_at || timestamp,
        row.tenant_id,
        row.user_id,
        row.profile_id,
        row.browser_account_ref,
        row.sourceRecordHash,
      );
    });

    recalculatedLinks.forEach((row) => {
      chargeRepository.upsertChargeLinks([{ ...row, lastSeenAt: timestamp }], row);
      if (row.matchStatus !== 'exact') return;
      crossBorderOrderRepository.upsertRecord({
        shopId: row.shopId,
        recordKey: row.collectionNumber || row.postingNumber,
        orderId: row.internalOrderId || row.collectionNumber,
        platformOrder: row.postingNumber,
        purchaseOrderNumber: row.purchaseOrderNumber,
        collectionNumber: row.collectionNumber,
        warehouse: row.warehouse,
        actualCrossBorderBusFeeCny: row.actualFeeCny,
        actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
        crossBorderChargeEvidence: row.evidence,
      });
    });

    exactGroups.forEach((group) => {
      const existing = purchaseOverrideRepository.getOverride({ shopId: group.shopId, orderKey: group.orderKey }) || {};
      purchaseOverrideRepository.upsertOverride(buildCrossBorderOrderOverridePatch(group, timestamp, existing));
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const postCounts = {
    records: Number(db.prepare('SELECT COUNT(*) total FROM cross_border_charge_records').get().total),
    links: Number(db.prepare('SELECT COUNT(*) total FROM cross_border_charge_links').get().total),
  };
  if (postCounts.records !== normalizedRecords.length || postCounts.links !== recalculatedLinks.length) {
    throw new Error(`回写计数校验失败：${JSON.stringify(postCounts)}`);
  }
  const postValidation = {
    quickCheck: db.prepare('PRAGMA quick_check').get()?.quick_check || '',
    refundDirectionMismatches: Number(db.prepare(`
      SELECT COUNT(*) total
      FROM cross_border_charge_records
      WHERE (reason LIKE '%退还%' OR reason LIKE '%退回%' OR reason LIKE '%退款%'
        OR reason LIKE '%返还%' OR reason LIKE '%冲正%')
        AND direction <> 'income'
    `).get().total),
    linkLedgerMismatches: Number(db.prepare(`
      WITH ledger AS (
        SELECT tenant_id, user_id, profile_id, browser_account_ref, collection_number,
          ROUND(SUM(CASE direction WHEN 'expense' THEN amount_cny ELSE -amount_cny END), 2) net
        FROM cross_border_charge_records
        GROUP BY tenant_id, user_id, profile_id, browser_account_ref, collection_number
      )
      SELECT COUNT(*) total
      FROM cross_border_charge_links AS link
      JOIN ledger USING (tenant_id, user_id, profile_id, browser_account_ref, collection_number)
      WHERE ROUND(link.ledger_net_cny, 2) <> ledger.net
         OR ROUND(link.actual_fee_cny, 2) <> ROUND(
           CAST(json_extract(link.evidence_json, '$.actualFeeCny') AS REAL), 2
         )
    `).get().total),
    exactOverrideMismatches: Number(db.prepare(`
      WITH exact_orders AS (
        SELECT shop_id, COALESCE(NULLIF(ozon_order_key, ''), posting_number) order_key,
          ROUND(SUM(CAST(json_extract(evidence_json, '$.cashNetCny') AS REAL)), 6) cash_net
        FROM cross_border_charge_links
        WHERE match_status = 'exact'
        GROUP BY tenant_id, user_id, profile_id, shop_id,
          COALESCE(NULLIF(ozon_order_key, ''), posting_number)
      )
      SELECT COUNT(*) total
      FROM exact_orders AS exact_order
      LEFT JOIN purchase_order_overrides AS purchase
        ON purchase.shop_id = exact_order.shop_id AND purchase.order_key = exact_order.order_key
      WHERE purchase.id IS NULL
         OR ROUND(CAST(json_extract(purchase.raw_json, '$.actualCrossBorderBusFeeCny') AS REAL), 2)
           <> ROUND(MAX(0, exact_order.cash_net) + 0.000000001, 2)
    `).get().total),
  };
  if (postValidation.quickCheck !== 'ok'
    || postValidation.refundDirectionMismatches !== 0
    || postValidation.linkLedgerMismatches !== 0
    || postValidation.exactOverrideMismatches !== 0) {
    throw new Error(`回写独立校验失败：${JSON.stringify(postValidation)}`);
  }
  summary.backupPath = backupPath;
  summary.postCounts = postCounts;
  summary.postValidation = postValidation;
}

const report = {
  summary,
  changedOrders: reportRows.filter((row) => row.changed),
  multipleCollectionOrders: reportRows.filter((row) => row.collectionCount > 1),
  orphanLinks,
  orders: reportRows,
};
const jsonPath = resolve(outputDir, 'cross-border-charge-reconciliation.json');
const csvPath = resolve(outputDir, 'cross-border-charge-orders.csv');
const markdownPath = resolve(outputDir, 'README.md');
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
writeCsv(csvPath, reportRows);
writeFileSync(markdownPath, [
  '# 跨境巴士真实扣费逐单核算',
  '',
  `- 模式：${summary.mode}`,
  `- 原流水：${summary.sourceRecordCount} 条；纠正方向：${summary.correctedDirectionCount} 条`,
  `- 余额扣款：${summary.expenseCny.toFixed(2)}；余额退款：${summary.incomeCny.toFixed(2)}；余额净扣：${summary.ledgerNetCny.toFixed(2)}`,
  `- 折算现金扣款：¥${summary.cashExpenseCny.toFixed(2)}；现金退款：¥${summary.cashIncomeCny.toFixed(2)}；现金净成本：¥${summary.cashNetCny.toFixed(2)}`,
  `- 当前折算：${summary.conversionPolicy.configured ? '已配置' : '未配置，按 1:1'}；默认系数：${summary.conversionPolicy.defaultRate.toFixed(6)}`,
  `- 精确 Ozon 订单：${summary.exactOrderCount}；金额变化：${summary.changedOrderCount}`, 
  `- 多预报单订单：${summary.multipleCollectionOrderCount}；未匹配：${summary.unmatchedCollectionCount}；歧义：${summary.ambiguousCollectionCount}`,
  `- 余额守恒：${summary.globalConserved ? '通过' : '失败'}；现金守恒：${summary.cashGlobalConserved ? '通过' : '失败'}；逐单守恒异常：${summary.unconservedOrderCount}`,
  `- 备份：${backupPath || 'dry-run 未创建'}`,
  '',
  '完整逐单数据见 `cross-border-charge-orders.csv` 与 `cross-border-charge-reconciliation.json`。',
  '',
].join('\n'), 'utf8');

db.close();
console.log(JSON.stringify({
  ok: summary.globalConserved && summary.cashGlobalConserved
    && summary.unconservedOrderCount === 0 && orphanLinks.length === 0,
  outputDir,
  summary,
}, null, 2));
