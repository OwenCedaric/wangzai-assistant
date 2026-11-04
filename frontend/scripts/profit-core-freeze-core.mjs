import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function auditProfitCoreFreeze({ root, manifest }) {
  const violations = [];
  const calculationFiles =
    manifest?.calculationFiles && typeof manifest.calculationFiles === 'object' ? manifest.calculationFiles : {};
  const runtimeFiles = manifest?.runtimeFiles && typeof manifest.runtimeFiles === 'object' ? manifest.runtimeFiles : {};
  const protectedFiles = { ...calculationFiles, ...runtimeFiles };
  for (const [file, calculationHash] of Object.entries(calculationFiles)) {
    if (Object.hasOwn(runtimeFiles, file) && runtimeFiles[file] !== calculationHash) {
      violations.push({
        kind: 'conflicting-protected-hash', file,
        message: '同一利润文件的计算/运行时冻结哈希不一致；不得用运行时哈希覆盖计算基线，必须复核两者差异。',
      });
    }
  }
  if (manifest?.schemaVersion !== 2) {
    violations.push({ kind: 'manifest-schema', message: '利润核心冻结清单版本必须为2。' });
  }
  if (!String(manifest?.calculationVersion || '').startsWith('profit-ledger-v16-')) {
    violations.push({ kind: 'calculation-version', message: '冻结清单必须绑定已验证的利润台账v16版本。' });
  }
  const migratableCalculationVersions = Array.isArray(manifest?.migratableCalculationVersions)
    ? manifest.migratableCalculationVersions.map(String)
    : [];
  if (!migratableCalculationVersions.length) {
    violations.push({ kind: 'missing-migration-contract', message: '利润核心冻结必须声明可保字段迁移的旧版本。' });
  }
  if (!migratableCalculationVersions.includes('profit-ledger-v13-rfbs-finance-commission')) {
    violations.push({
      kind: 'missing-v13-bus-evidence-migration',
      message: 'v15 必须迁移 v13 订单行，保留 rFBS 佣金并重算跨境巴士实际扣费证据。',
    });
  }
  if (!migratableCalculationVersions.includes('profit-ledger-v14-final-cross-border-charge-evidence')) {
    violations.push({
      kind: 'missing-v14-final-zero-migration',
      message: 'v15 必须迁移 v14 订单行，保留佣金与财务证据并把终态缺失精确巴士流水改为实际费 0。',
    });
  }
  if (!migratableCalculationVersions.includes('profit-ledger-v15-final-cancel-zero-bus-without-exact-charge')) {
    violations.push({
      kind: 'missing-v15-per-order-rate-migration',
      message: 'v16 必须迁移 v15 订单行，保留已经确认的财务和跨境巴士证据并按订单补齐汇率。',
    });
  }
  if (!String(manifest?.runtimeVersion || '').startsWith('profit-page-runtime-v6-')) {
    violations.push({ kind: 'runtime-version', message: '利润页面运行时必须绑定已验证的v6回读确认与分块缓存版本。' });
  }
  if (!Object.keys(calculationFiles).length || !Object.keys(runtimeFiles).length) {
    violations.push({ kind: 'empty-manifest', message: '利润计算核心与页面运行时冻结清单都不能为空。' });
  }

  Object.entries(protectedFiles).forEach(([relativePath, expectedHash]) => {
    const filePath = resolve(root, relativePath);
    if (!existsSync(filePath)) {
      violations.push({ kind: 'missing-file', file: relativePath, message: '冻结的利润核心文件被删除或移动。' });
      return;
    }
    const actualHash = sha256File(filePath);
    if (actualHash !== expectedHash) {
      violations.push({
        kind: 'hash-mismatch',
        file: relativePath,
        expectedHash,
        actualHash,
        message: calculationFiles[relativePath]
          ? '冻结的利润计算文件发生变化。必须显式升级计算版本、复核全量数据后才能更新冻结清单。'
          : '冻结的利润页面运行时发生变化。必须显式升级运行时版本、复核订单数量和店铺隔离后才能更新冻结清单。',
      });
    }
  });

  const retiredPaths = Array.isArray(manifest?.retiredPaths) ? manifest.retiredPaths.map(String) : [];
  retiredPaths.forEach((relativePath) => {
    if (existsSync(resolve(root, relativePath))) {
      violations.push({
        kind: 'retired-path-restored',
        file: relativePath,
        message: '已删除的利润旧方案文件被恢复。',
      });
    }
  });

  const retiredSymbols =
    manifest?.retiredSymbols && typeof manifest.retiredSymbols === 'object' ? manifest.retiredSymbols : {};
  Object.entries(retiredSymbols).forEach(([symbol, relativePaths]) => {
    (Array.isArray(relativePaths) ? relativePaths : []).forEach((relativePath) => {
      const filePath = resolve(root, relativePath);
      if (!existsSync(filePath)) return;
      if (readFileSync(filePath, 'utf8').includes(symbol)) {
        violations.push({
          kind: 'retired-symbol-restored',
          file: relativePath,
          message: `已删除的利润旧方案符号被恢复：${symbol}`,
        });
      }
    });
  });

  const baseline = manifest?.verifiedDataBaseline || {};
  if (
    !Number.isInteger(baseline.salesOrders) ||
    baseline.salesOrders <= 0 ||
    baseline.distinctPostingNumbers !== baseline.salesOrders ||
    baseline.duplicateShopPostingPairs !== 0
  ) {
    violations.push({
      kind: 'invalid-data-baseline',
      message: '利润冻结基线必须记录非零订单数、相同去重单量且店铺+货件号重复数为0。',
    });
  }

  const runtimeBaseline = manifest?.verifiedRuntimeBaseline || {};
  const runtimeShopCounts =
    runtimeBaseline.shopCounts && typeof runtimeBaseline.shopCounts === 'object'
      ? Object.values(runtimeBaseline.shopCounts)
      : [];
  const runtimeShopOrderTotal = runtimeShopCounts.reduce((sum, value) => sum + (Number(value) || 0), 0);
  if (
    !String(runtimeBaseline.verifiedAt || '').trim() ||
    !String(runtimeBaseline.scope || '').trim() ||
    !String(runtimeBaseline.snapshotKey || '').trim() ||
    !Number.isInteger(runtimeBaseline.salesOrders) ||
    runtimeBaseline.salesOrders <= 0 ||
    runtimeBaseline.distinctPostingNumbers !== runtimeBaseline.salesOrders ||
    runtimeBaseline.distinctShopPostingPairs !== runtimeBaseline.salesOrders ||
    runtimeBaseline.duplicateShopPostingPairs !== 0 ||
    runtimeShopOrderTotal !== runtimeBaseline.salesOrders
  ) {
    violations.push({
      kind: 'invalid-runtime-data-baseline',
      message: '利润页面运行时冻结必须记录全量历史订单数、店铺分布、相同去重单量且店铺+货件号重复数为0。',
    });
  }

  const ledgerPath = resolve(root, 'src/services/profitLedgerService.js');
  if (existsSync(ledgerPath)) {
    const source = readFileSync(ledgerPath, 'utf8');
    const version = String(manifest?.calculationVersion || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!version || !new RegExp(`PROFIT_LEDGER_CALCULATION_VERSION\\s*=\\s*['"]${version}['"]`).test(source)) {
      violations.push({
        kind: 'version-source-mismatch',
        file: 'src/services/profitLedgerService.js',
        message: '利润源码计算版本与冻结清单不一致。',
      });
    }
    if (
      !source.includes('migrateProfitLedgerRowToCurrentVersion') ||
      !source.includes('snapshot.rows.map(migrateProfitLedgerRowToCurrentVersion)')
    ) {
      violations.push({
        kind: 'migration-path-missing',
        file: 'src/services/profitLedgerService.js',
        message: '利润快照读取必须保留兼容版本的已确认财务字段并迁移到当前版本。',
      });
    }
    if (
      !source.includes('invalidateMigratedCommissionEvidence') ||
      !source.includes('ozon-finance-sale-commission')
    ) {
      violations.push({
        kind: 'commission-migration-invalidation-missing',
        file: 'src/services/profitLedgerService.js',
        message: '旧利润快照迁移时必须保留可显示的预估佣金，并使实际佣金和实际 Ozon 汇总等待财务流水重建。',
      });
    }
  }

  return {
    ok: violations.length === 0,
    calculationVersion: manifest?.calculationVersion || '',
    runtimeVersion: manifest?.runtimeVersion || '',
    protectedFileCount: Object.keys(protectedFiles).length,
    calculationFileCount: Object.keys(calculationFiles).length,
    runtimeFileCount: Object.keys(runtimeFiles).length,
    violations,
  };
}
