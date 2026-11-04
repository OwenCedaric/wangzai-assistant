import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDirectory, '..');
const databasePath = path.resolve(
  process.argv[2] || path.join(workspaceRoot, '.runtime-profile', 'local-api-data', 'wangzai-local-api.sqlite')
);

if (!existsSync(databasePath)) throw new Error(`真实SQLite不存在：${databasePath}`);

const db = new DatabaseSync(databasePath, { readOnly: true });
const tableNames = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
);
const pages = [];

function tableExists(name) {
  return tableNames.has(name);
}

function scalar(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return Number(Object.values(row || {})[0]) || 0;
}

function rows(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function addPage(id, label, details = {}, failures = [], warnings = []) {
  pages.push({
    id,
    label,
    status: failures.length ? 'failed' : warnings.length ? 'warning' : 'passed',
    details,
    failures,
    warnings,
  });
}

function requireTables(names, failures) {
  names.forEach((name) => {
    if (!tableExists(name)) failures.push(`缺少正式表 ${name}`);
  });
}

const quickCheck = Object.values(db.prepare('PRAGMA quick_check').get() || {})[0] || '';
const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
const shops = rows("SELECT id, COALESCE(NULLIF(alias, ''), name) AS label FROM shops WHERE status = 'active' ORDER BY created_at");
const shopIds = new Set(shops.map((shop) => shop.id));
const shopCounts = (table, predicate = '1 = 1') => rows(
  `SELECT shop_id AS shopId, COUNT(*) AS count FROM ${table} WHERE ${predicate} GROUP BY shop_id ORDER BY shop_id`
);
const unexpectedShopRows = (table, predicate = '1 = 1') => shopCounts(table, predicate)
  .filter((row) => !shopIds.has(row.shopId))
  .reduce((sum, row) => sum + Number(row.count || 0), 0);

{
  const failures = [];
  requireTables(['shops', 'ozon_orders', 'ozon_products', 'ozon_returns'], failures);
  if (quickCheck !== 'ok') failures.push(`SQLite quick_check=${quickCheck}`);
  if (foreignKeyViolations) failures.push(`SQLite外键违规 ${foreignKeyViolations}`);
  if (!shops.length) failures.push('没有活动Ozon店铺');
  addPage('dashboard', '旺崽汇总', {
    activeShops: shops.length,
    orders: scalar('SELECT COUNT(*) FROM ozon_orders WHERE is_stale = 0'),
    products: scalar('SELECT COUNT(*) FROM ozon_products WHERE is_stale = 0'),
    returns: scalar('SELECT COUNT(*) FROM ozon_returns WHERE is_stale = 0'),
  }, failures);
}

const productFailures = [];
const productCount = scalar('SELECT COUNT(*) FROM ozon_products WHERE is_stale = 0');
const invalidProducts = scalar(`
  SELECT COUNT(*) FROM ozon_products
  WHERE is_stale = 0 AND (
    product_id IS NULL OR TRIM(product_id) = '' OR name IS NULL OR TRIM(name) = ''
    OR price_value IS NULL OR stock_value IS NULL
  )
`);
const productsWithoutPrimaryImage = scalar(`
  SELECT COUNT(*) FROM ozon_products
  WHERE is_stale = 0 AND (primary_image_url IS NULL OR TRIM(primary_image_url) = '')
`);
if (!productCount) productFailures.push('正式商品缓存为空');
if (invalidProducts) productFailures.push(`商品关键字段缺失 ${invalidProducts} 行`);
if (unexpectedShopRows('ozon_products', 'is_stale = 0')) productFailures.push('活动商品包含非当前店铺行');
addPage('products', '商品列表', {
  total: productCount,
  byShop: shopCounts('ozon_products', 'is_stale = 0'),
  productsWithoutPrimaryImage,
  imageSourceStatus: productsWithoutPrimaryImage
    ? '这些商品的primary/images/raw图片字段均为空，页面应显示未返回占位，不伪造图片'
    : '全部商品均有图片来源',
}, productFailures);

const orderFailures = [];
const orderCount = scalar('SELECT COUNT(*) FROM ozon_orders WHERE is_stale = 0');
const invalidOrders = scalar(`
  SELECT COUNT(*) FROM ozon_orders
  WHERE is_stale = 0 AND (
    posting_number IS NULL OR TRIM(posting_number) = '' OR payment_at IS NULL
    OR amount_value IS NULL OR status IS NULL OR TRIM(status) = ''
    OR products_json IS NULL OR products_json = '[]'
  )
`);
if (!orderCount) orderFailures.push('正式订单缓存为空');
if (invalidOrders) orderFailures.push(`订单关键字段缺失 ${invalidOrders} 行`);
if (unexpectedShopRows('ozon_orders', 'is_stale = 0')) orderFailures.push('活动订单包含非当前店铺行');
addPage('sales-orders', '销售订单', { total: orderCount, byShop: shopCounts('ozon_orders', 'is_stale = 0') }, orderFailures);

addPage('purchase-orders', '拍单管理', {
  orders: orderCount,
  purchaseOverrides: scalar('SELECT COUNT(*) FROM purchase_order_overrides'),
  crossBorderOrders: scalar('SELECT COUNT(*) FROM cross_border_order_records'),
  purchaseSourceLinks: scalar('SELECT COUNT(*) FROM purchase_source_links'),
}, tableExists('purchase_order_overrides') && tableExists('cross_border_order_records') ? [] : ['拍单本地事实表不完整']);

const returnFailures = [];
const returnCount = scalar('SELECT COUNT(*) FROM ozon_returns WHERE is_stale = 0');
const invalidReturns = scalar(`
  SELECT COUNT(*) FROM ozon_returns
  WHERE is_stale = 0 AND (
    posting_number IS NULL OR TRIM(posting_number) = '' OR status IS NULL OR TRIM(status) = ''
    OR return_reason IS NULL OR TRIM(return_reason) = ''
  )
`);
if (!returnCount) returnFailures.push('售后缓存为空');
if (invalidReturns) returnFailures.push(`售后关键字段缺失 ${invalidReturns} 行`);
if (unexpectedShopRows('ozon_returns', 'is_stale = 0')) returnFailures.push('活动售后包含非当前店铺行');
addPage('after-sales-orders', '售后订单', { total: returnCount, byShop: shopCounts('ozon_returns', 'is_stale = 0') }, returnFailures);

const pendingCount = scalar(`
  SELECT COUNT(*) FROM ozon_orders
  WHERE is_stale = 0 AND (
    LOWER(COALESCE(status, '') || ' ' || COALESCE(substatus, '')) LIKE '%awaiting%'
    OR LOWER(COALESCE(status, '') || ' ' || COALESCE(substatus, '')) LIKE '%pending%'
    OR LOWER(COALESCE(status, '') || ' ' || COALESCE(substatus, '')) LIKE '%processing%'
    OR LOWER(COALESCE(status, '') || ' ' || COALESCE(substatus, '')) LIKE '%acceptance%'
    OR LOWER(COALESCE(status, '') || ' ' || COALESCE(substatus, '')) LIKE '%arbitration%'
  )
`);
addPage('pending-orders', '待处理单', { matchingOrders: pendingCount, matchingReturns: returnCount });

addPage('print-shipping', '打单发货', {
  orders: orderCount,
  withDeadline: scalar('SELECT COUNT(*) FROM ozon_orders WHERE is_stale = 0 AND cutoff_at IS NOT NULL'),
  withShipmentDate: scalar('SELECT COUNT(*) FROM ozon_orders WHERE is_stale = 0 AND shipment_date IS NOT NULL'),
});

const cefExecutable = path.join(workspaceRoot, 'desktop', 'native', 'Wangzai.CefBrowserHost', 'publish', 'Wangzai.CefBrowserHost.exe');
const purchaseAccounts = scalar('SELECT COUNT(*) FROM purchase_accounts');
addPage('purchase-rehearsal', '自动拍单', {
  purchaseAccounts,
  cefExecutablePresent: existsSync(cefExecutable),
  installedBrowserProfiles: scalar('SELECT COUNT(*) FROM purchase_browser_plugin_state'),
}, [
  ...(!purchaseAccounts ? ['没有采购账号'] : []),
  ...(!existsSync(cefExecutable) ? ['CEF浏览器程序缺失'] : []),
]);

let profitLedgerRows = [];
let profitManifest = null;
if (tableExists('profit_ledger_snapshots')) {
  const manifestRow = db.prepare(`
    SELECT snapshot_json FROM profit_ledger_snapshots
    WHERE snapshot_key LIKE '%range:all-history:%' AND snapshot_key NOT LIKE '%::chunk:%'
    ORDER BY updated_at DESC LIMIT 1
  `).get();
  if (manifestRow) {
    profitManifest = JSON.parse(manifestRow.snapshot_json);
    for (const chunkKey of profitManifest.chunkKeys || []) {
      const chunkRow = db.prepare('SELECT snapshot_json FROM profit_ledger_snapshots WHERE snapshot_key = ?').get(chunkKey);
      if (!chunkRow) continue;
      const payload = JSON.parse(chunkRow.snapshot_json);
      profitLedgerRows.push(...(Array.isArray(payload) ? payload : payload.rows || []));
    }
  }
}
const orderKeys = new Set(rows("SELECT shop_id, posting_number FROM ozon_orders WHERE is_stale = 0")
  .map((row) => `${row.shop_id}:${row.posting_number}`));
const ledgerKeys = new Set(profitLedgerRows.map((row) => `${row.shopId}:${row.orderSnapshot?.posting || ''}`));
const profitFailures = [];
if (!profitManifest) profitFailures.push('缺少全历史利润账本');
if (profitLedgerRows.length !== orderCount) profitFailures.push(`利润账本${profitLedgerRows.length}行，订单${orderCount}行`);
const ordersMissingLedger = [...orderKeys].filter((key) => !ledgerKeys.has(key)).length;
const ledgerMissingOrders = [...ledgerKeys].filter((key) => !orderKeys.has(key)).length;
if (ordersMissingLedger || ledgerMissingOrders) profitFailures.push(`利润与订单键不一致 ${ordersMissingLedger}/${ledgerMissingOrders}`);
addPage('shipping', '订单利润', {
  orders: orderCount,
  ledgerRows: profitLedgerRows.length,
  ordersMissingLedger,
  ledgerMissingOrders,
}, profitFailures);

const financeFailures = [];
const financeCount = scalar('SELECT COUNT(*) FROM ozon_finance_transactions WHERE is_stale = 0');
const financeMissingAmount = scalar('SELECT COUNT(*) FROM ozon_finance_transactions WHERE is_stale = 0 AND amount_total IS NULL');
if (!financeCount) financeFailures.push('财务流水为空');
if (financeMissingAmount) financeFailures.push(`财务流水金额缺失 ${financeMissingAmount} 行`);
addPage('profit-report', '利润报表', { financeRows: financeCount, missingAmount: financeMissingAmount }, financeFailures);

addPage('inventory', '营销活动', {
  activities: scalar('SELECT COUNT(*) FROM ozon_marketing_activities'),
  activityProducts: scalar('SELECT COUNT(*) FROM ozon_marketing_activity_products WHERE is_stale = 0'),
}, tableExists('ozon_marketing_activities') && tableExists('ozon_marketing_activity_products') ? [] : ['营销缓存表不完整']);

addPage('paid-promotion', '付费推广', {
  accounts: scalar('SELECT COUNT(*) FROM performance_accounts'),
}, tableExists('performance_accounts') ? [] : ['Performance账号表缺失']);

addPage('data-analysis', '数据分析', {
  dailyAnalytics: scalar('SELECT COUNT(*) FROM ozon_analytics_daily WHERE is_stale = 0'),
  snapshots: scalar('SELECT COUNT(*) FROM data_analysis_snapshots'),
}, tableExists('ozon_analytics_daily') && tableExists('data_analysis_snapshots') ? [] : ['数据分析事实表不完整']);

const hasProfileNamespace = (namespace) => scalar('SELECT COUNT(*) FROM profile_settings WHERE namespace = ?', namespace) > 0;
addPage('prompt-library', '智能工具', {
  promptLibrarySaved: hasProfileNamespace('prompt-library'),
  modelAccounts: scalar('SELECT COUNT(*) FROM model_api_accounts'),
}, hasProfileNamespace('prompt-library') ? [] : ['智能工具配置未迁移']);

addPage('collection-pricing', '采集核价', {
  purchaseAccounts,
  cefExecutablePresent: existsSync(cefExecutable),
});

addPage('points-packages', '积分套餐', { rendererSmokeRequired: true });

addPage('follow-seller-defense', '剔除跟卖', {
  patrolRuns: scalar('SELECT COUNT(*) FROM follow_seller_patrol_runs'),
  cases: scalar('SELECT COUNT(*) FROM follow_seller_cases'),
}, tableExists('follow_seller_cases') && tableExists('follow_seller_patrol_runs') ? [] : ['跟卖记录表不完整']);

const customerEvents = scalar("SELECT COUNT(*) FROM ozon_notification_events WHERE enabled = 1 AND domain = 'customer'");
addPage('customer-consultation', '在线客服', {
  customerEvents,
  preferencesSaved: hasProfileNamespace('customer-consultation-preferences'),
}, hasProfileNamespace('customer-consultation-preferences') ? [] : ['客服偏好未迁移']);

addPage('smart-reply', '智能回复', {
  settingsSaved: hasProfileNamespace('smart-reply-local-internal-v1'),
}, hasProfileNamespace('smart-reply-local-internal-v1') ? [] : ['智能回复设置未迁移']);

const warehouseCache = scalar(`
  SELECT COUNT(*) FROM ozon_response_cache
  WHERE is_stale = 0 AND endpoint_key IN ('warehouse.list', 'deliveryMethod.list')
`);
addPage('warehouse-logistics', '仓储物流', {
  cacheRows: warehouseCache,
  expectedShopEndpointPairs: shops.length * 2,
}, warehouseCache >= shops.length * 2 ? [] : [`仓库/配送缓存只有${warehouseCache}行`]);

addPage('data-backup', '数据备份', {
  exportTablePresent: tableExists('data_backup_exports'),
  importTablePresent: tableExists('data_backup_imports'),
}, tableExists('data_backup_exports') && tableExists('data_backup_imports') ? [] : ['备份导入导出表不完整']);

const summary = {
  generatedAt: new Date().toISOString(),
  databasePath,
  quickCheck,
  foreignKeyViolations,
  pageCount: pages.length,
  passed: pages.filter((page) => page.status === 'passed').length,
  warnings: pages.filter((page) => page.status === 'warning').length,
  failed: pages.filter((page) => page.status === 'failed').length,
  pages,
};

console.log(JSON.stringify(summary, null, 2));
db.close();
if (summary.failed) process.exitCode = 1;
