import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource.js';

const appSource = readSplitAppSource();
const afterSalesPageSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'orders', 'afterSales', 'AfterSalesOrdersPage.jsx'),
  'utf8'
);
const afterSalesCachedClassificationSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'orders', 'afterSales', 'services', 'afterSalesCachedClassificationService.js'), 'utf8'
);
const afterSalesWorkbenchContextSource = readFileSync(
  join(
    process.cwd(),
    'src',
    'features',
    'orders',
    'afterSales',
    'lib',
    'afterSalesOzonProductWorkbenchContext.js'
  ),
  'utf8'
);
const localApiClientSource = readFileSync(join(process.cwd(), 'src', 'api', 'localApiClient.js'), 'utf8');
const appShellSource = readFileSync(join(process.cwd(), 'src', 'App.jsx'), 'utf8');
const realtimeSnapshotSource = readFileSync(
  join(process.cwd(), 'src', 'entities', 'marketing', 'marketingSnapshotRuntime.jsx'),
  'utf8'
);
const localDataLayerSource = [
  'ozonLocalDataLayer.js',
  'ozonLocalDataLayerMerge.js',
  'ozonLocalDataLayerRead.js',
  'ozonAfterSalesCacheMergePolicy.js',
]
  .map((fileName) => readFileSync(join(process.cwd(), 'src', 'services', fileName), 'utf8'))
  .join('\n');

function getFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextExportFunction = source.indexOf('\nexport function ', start + marker.length);
  const nextPlainFunction = source.indexOf('\nfunction ', start + marker.length);
  const candidates = [nextExportFunction, nextPlainFunction].filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

describe('after-sales page rules', () => {
  it('does not keep the deprecated mock after-sales rows', () => {
    expect(appSource).not.toMatch(/const\s+afterSalesOrderRows\s*=\s*\[/);
  });

  it('does not keep the deprecated mock sales order rows', () => {
    expect(appSource).not.toMatch(/const\s+salesOrderRows\s*=\s*\[/);
    expect(appSource).not.toContain('salesOrderRows[0].id');
  });

  it('restores refused refund status when refusal or disposal evidence is present', () => {
    const decisionSource = getFunctionSource(appSource, 'getAfterSalesRefundLossDecision');
    expect(decisionSource).toContain('function getAfterSalesRefundLossDecision(ruleState = {}, options = {})');
    expect(decisionSource).toContain('if (ruleState.signedRefundConfirmed)');
    expect(decisionSource).toContain('if (ruleState.confirmedRefundLoss || ruleState.canonicalClassification?.type === AFTER_SALES_TYPE_REJECTED_REFUND)');
    expect(decisionSource).toContain('if (originalOrderEvidence?.delivered)');
    expect(decisionSource).toContain('if (ruleState.hasRefusedAndDestroyedEvidence)');
    expect(decisionSource).toContain("reason: '命中拒收/未取和销毁证据，恢复按拒收后退款处理'");
    expect(decisionSource).not.toContain('function isOzonAfterSalesRefundOrDisposalState(item = {})');
    expect(decisionSource).not.toContain('partialcompensationreturnedbyozon');
    expect(decisionSource).not.toContain('hasOzonRefundOrDisposalState && !deliveryEvidence.preShipment');
    expect(decisionSource).not.toContain(
      'confirmedRefundLoss: hasRefusedAndDestroyedEvidence && financeConfirmed && !originalOrderEvidence.delivered,'
    );
    expect(decisionSource).not.toContain(
      'confirmedRefundLoss: hasRefusedAndDestroyedEvidence && !originalOrderEvidence.delivered,'
    );
    expect(appSource).toContain('classifyAfterSalesOrder({');
    expect(appSource).toContain('getAfterSalesRefundLossDecision(ruleState');
    expect(appSource).toContain('getAfterSalesStatusByRules');
  });

  it('removes deprecated order preview mock rows and fallback page', () => {
    expect(appSource).not.toContain('const orderPreviewConfig =');
    expect(appSource).not.toContain('function OrderPreviewPage');
    expect(appSource).not.toMatch(/\b(SO|AS|PO|MK|PF)-240\d{6}-\d{3}\b/);
  });

  it('keeps Russian stockout and cancellation reasons in pre-shipment cancellation', () => {
    expect(appSource).toContain('AFTER_SALES_PRE_SIGNED_CANCEL_PATTERN');
    expect(appSource).toContain('getAfterSalesRefundLossDecision');
  });
  it('does not treat planned delivery window as delivered evidence for refused refund classification', () => {
    const mergeSource = getFunctionSource(appSource, 'mergeAfterSalesOriginalOrderEvidence');
    expect(mergeSource).toContain(
      'originalOrderDeliveredAt: firstFilled(originalRaw.delivered_at, originalRaw.deliveredAt),'
    );
    expect(mergeSource).not.toContain('originalRaw.delivery_date_end');
    expect(mergeSource).not.toContain('originalRaw.deliveryDateEnd');
  });

  it('bumps the after-sales classification version when changing status rules', () => {
    expect(appSource).toContain('const AFTER_SALES_CLASSIFICATION_VERSION = 15;');
  });

  it('upgrades cached after-sales rows before page filtering and counts', () => {
    expect(appSource).toContain('function upgradeAfterSalesClassificationRow(row = {})');
    expect(appSource).toContain('function normalizeAfterSalesRowsForDisplayCache(rows = [])');
    expect(appSource).toContain('dedupeAfterSalesRowsByBusinessKey(upgradeAfterSalesClassificationRows');
    expect(appSource).toContain('normalizeAfterSalesRowsForDisplayCache(afterSalesSync.data?.rows ?? [])');
    expect(appSource).toContain('upgradeAfterSalesClassificationRow(');
    expect(afterSalesPageSource).toContain('const untranslatedBaseAfterSalesRows = React.useMemo(');
    expect(afterSalesPageSource).toContain(
      'const baseAfterSalesRows = useAfterSalesReasonTranslations(classifiedBaseAfterSalesRows);'
    );
    expect(afterSalesPageSource).toContain('const afterSalesClassification = useAfterSalesCachedClassification(');
    expect(afterSalesPageSource).toContain('const classifiedBaseAfterSalesRows = afterSalesClassification.rows;');
    expect(appSource).toContain('normalizeAfterSalesAmountCurrencyForDisplay(order)');
    expect(appSource).toContain('item.originalOrderCancelledEvidence');
    expect(appSource).toContain('item.originalOrderDeliveredEvidence');
  });

  it('keeps after-sales status counts, list, pagination, and detail on the same filtered dataset', () => {
    const pageSource = afterSalesPageSource;

    expect(pageSource).toContain('const afterSalesRowsIndex = React.useMemo');
    expect(pageSource).toContain('const filteredOrders = React.useMemo');
    expect(pageSource).toContain('queryRowsIndex(afterSalesRowsIndex');
    expect(pageSource).toContain('const filteredOrdersWithStatus = React.useMemo');
    expect(pageSource).toContain('sortAfterSalesRowsByNewestActivityTime(');
    expect(pageSource).toContain('filterRowsByStatus(filteredOrders, status');
    expect(pageSource).toContain('const afterSalesPagination = React.useMemo');
    expect(pageSource).toContain('paginateRows(filteredOrdersWithStatus, afterSalesPage, afterSalesPageSize)');
    expect(pageSource).toContain('const afterSalesStatusCounts = React.useMemo');
    expect(pageSource).toContain('buildStatusCounts(filteredOrders, afterSalesOrderStatusTabs');
    expect(pageSource).toContain('const visibleOrders = afterSalesPagination.rows;');
    expect(pageSource).toContain('detailSourceRows: filteredOrdersWithStatus');
    expect(pageSource).not.toContain('afterSalesSync.data?.statusCounts');
    expect(pageSource).not.toContain('afterSalesSync.statusCounts');
  });

  it('keeps displayed after-sales id separate from original posting number', () => {
    const pageSource = afterSalesPageSource;

    expect(afterSalesWorkbenchContextSource).toContain('export function getAfterSalesWorkbenchDisplayId(row = {})');
    expect(afterSalesWorkbenchContextSource).toContain(
      "function isUsableDisplayId(value, row = {}, salesOrder = '')"
    );
    expect(afterSalesWorkbenchContextSource).toContain("text.startsWith('posting:')");
    expect(afterSalesWorkbenchContextSource).toContain(
      "return isUsableDisplayId(row.id, row, salesOrder) ? row.id : '未返回';"
    );
    expect(pageSource).toContain('const afterSalesDisplayId = getAfterSalesWorkbenchDisplayId(order);');
    expect(pageSource).toContain('{afterSalesDisplayId}');
    expect(pageSource).toContain('const selectedAfterSalesDisplayId = React.useMemo(');
    expect(pageSource).not.toContain(
      'id: firstFilled(displayRow.id, displayRow.returnId, displayRow.return_id, displayRow.salesOrder)'
    );
  });

  it('defines split lock detail variables inside the after-sales page before rendering detail alerts', () => {
    const pageSource = afterSalesPageSource;

    expect(pageSource).toContain('const detailAfterSalesOperateAllowed = canOperateAfterSalesOrder(selectedOrder);');
    expect(pageSource).toContain('const detailSplitLocked = Boolean(');
    expect(pageSource).toContain('const detailSplitLockReason = detailSplitLocked');
    expect(pageSource).toContain('!\u0064etailAfterSalesOperateAllowed');
    expect(pageSource).toContain('\u5904\u7406\u552e\u540e');
    expect(pageSource).toContain('disabled');
    expect(pageSource.indexOf('const detailSplitLocked = Boolean(')).toBeLessThan(
      pageSource.indexOf('{detailSplitLocked ? (')
    );
  });

  it('does not run deprecated visible-row after-sales supplement effects', () => {
    const pageSource = afterSalesPageSource;

    expect(pageSource).not.toContain('afterSalesDetailMap');
    expect(pageSource).not.toContain('afterSalesImageMap');
    expect(pageSource).not.toContain('afterSalesImageErrorText');
    expect(pageSource).not.toContain('visibleAfterSalesSupplementKey');
    expect(pageSource).not.toContain('requestOzonRfbsReturnDetail(orderShop');
    expect(pageSource).not.toContain('requestOzonAfterSalesOriginalOrderDetail(orderShop');
    expect(pageSource).not.toContain('requestOzonAfterSalesRefundFinanceEvidence(orderShop');
    expect(pageSource).not.toContain('enrichAfterSalesRowsWithOzonProductImagesForShops(readableShops');
    expect(appSource).not.toContain('function enrichAfterSalesRowsWithOzonProductImagesForShops');
    expect(appSource).not.toContain('function enrichAfterSalesRowsWithOzonProductImages');
    expect(appSource).not.toContain('function mergeAfterSalesProductsWithOriginalDetail');
    expect(appSource).not.toContain('function mergeAfterSalesProductWithDetailProduct');
    expect(appSource).not.toContain('function normalizeAfterSalesProductsForImageLookup');
    expect(appSource).not.toContain('function mergeOzonSalesSnapshotRows');
  });

  it('uses one canonical after-sales read with classification evidence instead of a stale JSON fast path', () => {
    const pageSource = afterSalesPageSource;

    expect(appSource).toContain('requestOzonAfterSalesSnapshotForShops');
    expect(pageSource).toContain('enrichRfbsDetails: false');
    expect(pageSource).toContain('keepCurrentDataOnForceRefresh: true');
    expect(pageSource).toContain('enrichClassificationEvidence: null');
    expect(afterSalesCachedClassificationSource).toContain('readLocalProfitFinanceCacheForShop(shop, candidates');
    expect(afterSalesCachedClassificationSource).toContain('forceRefresh: false');
    expect(afterSalesCachedClassificationSource).toContain('startBackgroundSync: false');
    expect(afterSalesCachedClassificationSource).toContain('return applyAfterSalesFinanceEvidence(row,');
    expect(pageSource).not.toContain('enrichRfbsDetails: true');
    expect(pageSource).toContain('enrichLocalOriginalOrderEvidence: true');
    expect(pageSource).not.toContain('LOCAL_AFTER_SALES_DISPLAY_SNAPSHOT_FILE_KEY');
    expect(pageSource).not.toContain('writeOzonLocalDataSnapshot(');
    expect(pageSource).not.toContain('const latestSnapshot = await requestOzonAfterSalesSnapshotForShops');
    expect(appSource).toContain('requestedMaxRows');
    expect(appSource).toContain('candidates.length');
    expect(appSource).not.toContain('const OZON_AFTER_SALES_CLASSIFICATION_EVIDENCE_MAX_ROWS = 8;');
    expect(appSource).not.toContain('maxClassificationEvidenceRows: OZON_AFTER_SALES_CLASSIFICATION_EVIDENCE_MAX_ROWS');
    expect(pageSource).not.toContain('afterSalesEvidence.attempted > 0');
    expect(pageSource).not.toContain('afterSalesHasFreshRemoteResult && Number(afterSalesEvidence.attempted) > 0');
    expect(appSource).not.toContain('OZON_AFTER_SALES_CLASSIFICATION_EVIDENCE_MAX_ROWS = 8');
  });

  it('preloads the shared SQLite snapshot and route so after-sales and pending pages open immediately', () => {
    expect(appShellSource).toContain('function loadAfterSalesOrdersPage()');
    expect(appShellSource).toContain('module.preloadAfterSalesOrdersLocalCache?.(readableOzonShops)');
    expect(appShellSource).toContain('wangzaiAfterSalesOrdersCache');
    expect(afterSalesPageSource).toContain('export async function preloadAfterSalesOrdersLocalCache');
    expect(afterSalesPageSource).toContain('preloadOzonRealtimeSnapshot(');
    expect(afterSalesPageSource).toContain('cacheTtlMs: AFTER_SALES_INSTANT_CACHE_TTL_MS');
    expect(afterSalesPageSource).toContain('allowAggregateLocalData: true');
    expect(afterSalesPageSource).toContain('autoSync: false');
    expect(afterSalesPageSource).toContain('refreshOnCacheHit: false');
    expect(afterSalesPageSource).toContain('pendingAfterSalesCacheReloadRef.current');
    expect(afterSalesPageSource).toContain('void reloadAfterSalesCache().catch(() => undefined)');
    expect(realtimeSnapshotSource).toContain('export async function preloadOzonRealtimeSnapshot');
    expect(realtimeSnapshotSource).toContain('const existingRequest = ozonSnapshotInFlight.get(cacheKey);');
    expect(realtimeSnapshotSource).toContain('forceRefresh: false');
  });

  it('uses local orders cache to restore after-sales classification without remote per-row evidence calls', () => {
    expect(appSource).toMatch(/\bgetDomainCache\b/);
    expect(appSource).toMatch(/\brequestLocalOzon\b/);
    expect(appSource).toContain('async function enrichAfterSalesRowsWithLocalOriginalOrderEvidence');
    expect(appSource).toContain('async function readLocalOriginalOrderRowsForAfterSales');
    expect(appSource).toContain('getDomainCache(');
    expect(appSource).toContain("'orders'");
    expect(appSource).toContain('const raw = mergeAfterSalesOriginalOrderEvidence(row.raw ?? row, originalOrder);');
    expect(appSource).toContain('return normalizeOzonAfterSalesRow(raw, { source, shop });');
    expect(appSource).toContain('await enrichAfterSalesRowsWithLocalOriginalOrderEvidence(shop, mergedRows');
  });

  it('includes Ozon cancelled orders in the after-sales snapshot instead of isolating them from after-sales counts', () => {
    expect(appSource).toContain('function normalizeOzonCancelledOrderForAfterSales(item = {})');
    expect(appSource).toContain('buildOzonAfterSalesRowsFromCancelledOrderBase');
    expect(appSource).toContain("source: 'order-cancelled'");
    expect(appSource).toContain('ruleVersion: OZON_AFTER_SALES_SNAPSHOT_RULE_VERSION');
  });
  it('maps Ozon cancelled order cancellation reason into the after-sales reason fields', () => {
    expect(appSource).toContain('function normalizeOzonCancelledOrderForAfterSales(item = {})');
    expect(appSource).toContain('cancellation.cancel_reason_name');
    expect(appSource).toContain('cancellation.cancel_reason_message');
    expect(appSource).toContain('const preferredCancellationReason = isLowValueSupplementTarget(cancellationReason)');
    expect(appSource).toContain('reason: firstFilled(preferredCancellationReason, item.reason)');
    expect(appSource).toContain('refund_reason: firstFilled(preferredCancellationReason, item.refund_reason)');
    expect(appSource).toContain('cancel_reason: firstFilled(preferredCancellationReason, item.cancel_reason)');
    expect(appSource).toContain('originalOrderCancellationReason: preferredCancellationReason');
  });

  it('prefers original order cancellation reason over generic after-sales reason on pre-shipment cancellations', () => {
    expect(appSource).toContain("function getOzonAfterSalesDisplayReason(item = {}, status = '')");
    expect(appSource).toContain('const originalCancellationReason = getOzonOriginalOrderCancellationReasonText(item);');
    expect(appSource).toContain('const directReason = getOzonDirectAfterSalesReasonText(item);');
    expect(appSource).toContain("if (status === '发货前取消' && !isLowPriorityAfterSalesReason(originalCancellationReason))");
    expect(appSource).toContain('originalOrderCancellationReason: preferredCancellationReason');
  });
  it('hydrates after-sales products from the local product summary before returning the snapshot', () => {
    expect(appSource).toContain('async function enrichAfterSalesRowsWithLocalProductSummary');
    expect(appSource).toContain('readOzonLocalProductEntityRows(');
    expect(appSource).toContain('getAfterSalesOrderRecordKey');
    expect(appSource).toContain('mergedRows = await enrichAfterSalesRowsWithLocalProductSummary(shop, mergedRows');
    expect(appSource).toContain('signal: options.signal');
  });

  it('keeps after-sales product main image fields in the list and detail image candidate pool', () => {
    const productSource = appSource.slice(
      appSource.indexOf('function getOzonOrderProducts'),
      appSource.indexOf('function hasUsefulOzonOrderProductInfo')
    );
    const productImagesSource = productSource.slice(
      productSource.indexOf('const productImages = normalizeImageList(['),
      productSource.indexOf('return {', productSource.indexOf('const productImages = normalizeImageList(['))
    );

    expect(productImagesSource).toContain('product?.primary_image');
    expect(productImagesSource).toContain('product?.primaryImage');
    expect(productImagesSource).toContain('product?.main_image');
    expect(productImagesSource).toContain('product?.mainImage');
    expect(productImagesSource).toContain('financialProduct?.main_image');
    expect(productImagesSource).toContain('financialProduct?.mainImage');
    expect(productSource).toContain('image: productImages[0] ||');
    expect(productSource).toContain('images: productImages');
  });

  it('does not let already-checked after-sales evidence keep blocking later classification candidates', () => {
    expect(appSource).toContain('function hasAfterSalesOriginalOrderCheck(row = {})');
    expect(appSource).toContain('const hasOriginalOrderCheck = hasAfterSalesOriginalOrderCheck(row);');
    expect(appSource).toContain('originalOrderEvidenceChecked: true');
    expect(appSource).toContain('row.originalOrderEvidenceChecked || hasAfterSalesOriginalOrderCheck(row.raw ?? row)');
    expect(appSource).toContain('next.originalOrderEvidenceChecked = true;');
    expect(appSource).toContain(
      "if (source !== 'rfbs-return') return isMissingAfterSalesReason(row.reason) && !hasOriginalOrderCheck;"
    );
    expect(appSource).toContain('return !hasOriginalOrderCheck;');
    expect(appSource).toContain('!hasOriginalOrderCheck');
    expect(appSource).not.toContain(
      'return ruleState.hasRefusedAndDestroyedEvidence || isMissingAfterSalesReason(row.reason);'
    );
  });

  it('shows after-sales data source from the actual snapshot source', () => {
    const pageSource = afterSalesPageSource;

    expect(appSource).toContain('function getOzonRealtimeSnapshotSourceHint(snapshotState = {}, options = {})');
    expect(appSource).toContain("performanceEventId.endsWith(':local-file')");
    expect(appSource).toContain("performanceEventId.endsWith(':api')");
    expect(pageSource).toContain('const afterSalesSourceHint = getOzonRealtimeSnapshotSourceHint(afterSalesSync);');
    expect(pageSource).toContain('hint: afterSalesSourceHint');
    expect(pageSource).not.toContain("hint: afterSalesBackgroundSyncing ? '姝ｅ湪鍚屾' : 'Ozon 瀹炴椂璇诲彇'");
  });

  it('keeps after-sales on the canonical source and derives notifications from successive canonical results', () => {
    const pageSource = afterSalesPageSource;

    expect(pageSource).toContain('onOrderNotifications');
    expect(pageSource).toContain('function normalizeAfterSalesRowsForDisplayCache(rows = [])');
    expect(pageSource).toContain('refreshOnMount: true');
    expect(pageSource).toContain('keepCurrentDataOnForceRefresh: true');
    expect(pageSource).toContain('snapshotIdentityKey: afterSalesCanonicalScopeKey');
    expect(pageSource).toContain('const afterSalesLoaderOptions = React.useMemo');
    expect(pageSource).toContain('recordNotifications: true');
    expect(pageSource).toContain("schedulerProfile: 'background'");
    expect(pageSource).toContain("syncSource: 'after-sales-canonical-read'");
    expect(pageSource).toContain("requestedBy: 'frontend-after-sales-canonical-read'");
    expect(pageSource).toContain('const notificationRowsRef = React.useRef([]);');
    expect(pageSource).toContain('createOzonAfterSalesChangeNotifications(previousRows, baseAfterSalesRows');
    expect(pageSource).toContain('onOrderNotifications(notifications)');
    expect(pageSource).not.toContain('LOCAL_AFTER_SALES_DISPLAY_SNAPSHOT_FILE_KEY');
    expect(pageSource).not.toContain('afterSalesLocalSnapshotKey');
    expect(pageSource).not.toContain('createAfterSalesDisplaySnapshot');
    expect(pageSource).not.toContain('writeOzonLocalDataSnapshot(');
    expect(localApiClientSource).toContain('readLocalReturnsCacheForOzon');
    expect(localApiClientSource).toContain("startDomainSync(\n      'returns'");
    expect(localApiClientSource).toContain('waitForLocalOrderSyncJob');
    expect(localApiClientSource).toContain('LOCAL_RETURNS_SYNC_TIMEOUT');
    expect(localApiClientSource).toContain("getDomainCache('returns'");
  });

  it('does not keep legacy signed-refund cache protection in local data merge path', () => {
    const legacySignedRefundStatusName = ['AFTER_SALES_LEGACY', 'SIGNED_REFUND_STATUS'].join('_');
    const legacySignedRefundEvidenceFunctionName = ['hasAfterSalesDurable', 'SignedRefundEvidence'].join('');

    expect(localDataLayerSource).not.toContain(legacySignedRefundStatusName);
    expect(localDataLayerSource).not.toContain(legacySignedRefundEvidenceFunctionName);
  });

  it('does not replay historical after-sales partial refresh notices from local cache', () => {
    const pageSource = afterSalesPageSource;

    expect(pageSource).toContain('const afterSalesPerformanceEventId = afterSalesSync.performance?.eventId ||');
    expect(pageSource).toContain(
      "const afterSalesHasFreshRemoteResult = afterSalesPerformanceEventId.endsWith(':api');"
    );
    expect(pageSource).toContain('afterSalesHasFreshRemoteResult && afterSalesSync.data?.errors?.length');
    expect(pageSource).not.toContain('afterSalesHasFreshRemoteResult && Number(afterSalesEvidence.attempted) > 0');
    expect(pageSource).not.toContain('afterSalesEvidence.attempted > 0');
  });

  it('hydrates cached after-sales rows with shop identity before shop filtering', () => {
    expect(appSource).toContain('function attachOzonShopIdentityToRow(row = {}, shops = [])');
    expect(appSource).toContain('const labelMatches = rowLabel');
    expect(appSource).toContain('attachOzonShopIdentityToRow(');
    expect(appSource).toContain(
      'const matchedShop = matchedById || matchedByClient || (labelMatches.length === 1 ? labelMatches[0] : null);'
    );
    expect(appSource).toContain('shopId,');
    expect(appSource).toContain('shopClientId,');
    expect(appSource).not.toContain('shopClientId: row.shopClientId || shopClientId');
  });

  it('keeps only one after-sales status line when finance evidence is merged', () => {
    expect(appSource).toContain('updateAfterSalesTimelineStatus');
    expect(appSource).toContain('timeline: updateAfterSalesTimelineStatus(row.timeline, status)');
  });
  it('uses returnId as the canonical after-sales entity key', () => {
    expect(appSource).toContain('function getAfterSalesBusinessDedupeKey(row = {})');
    expect(appSource).toContain('function getAfterSalesStableIdentityKey(row = {})');
    expect(appSource).toContain('function getAfterSalesBasePostingNumber(row = {})');
    expect(appSource).toContain('function getAfterSalesReturnIdentity(row = {})');
    expect(appSource).toContain('if (returnId) return `${identityPrefix}return:${returnId}`;');
    expect(appSource).toContain(
      'function shouldSkipOrderCancelledFallbackRow(row = {}, concreteReturnPostingKeys = new Set())'
    );
    expect(appSource).not.toContain('return `${identityPrefix}return:${returnId}:base:${basePosting}`;');
    expect(appSource).not.toContain('if (returnId) return `${shopPrefix}return:${returnId}`;');
    expect(appSource).not.toContain('salesOrder ? `${shopPrefix}order:${salesOrder}`');
  });

  it('merges duplicate after-sales rows before status decisions and finance evidence checks', () => {
    expect(appSource).toContain('function mergeAfterSalesRowsForBusinessDedupe(current = {}, row = {})');
    expect(appSource).toContain('function protectAfterSalesStrongEvidenceFields(merged = {}, left = {}, right = {})');
    expect(appSource).toContain('statusRecalculationSource = {');
    expect(appSource).toContain('const mergedRows = mergeAfterSalesRowsByBusinessKey(originalRows);');
    expect(appSource).toContain('const enrichedRows = mergeAfterSalesRowsByBusinessKey(originalRows);');
    expect(appSource).toContain('function hasAfterSalesExplicitFinanceNonConfirmation(row = {})');
    expect(appSource).toContain('const rightClearsStaleFinance =');
    expect(appSource).toContain('if (financeChecked) next.financeRefundConfirmed = financeConfirmed;');
    expect(appSource).toMatch(
      /rightClearsStaleFinance\s*\?\s*false\s*:\s*Boolean\([\s\S]*leftFinance\.confirmed[\s\S]*rightFinance\.confirmed/u
    );
  });

  it('imports the finance amount helper used by after-sales evidence summaries', () => {
    expect(appSource).toMatch(
      /import\s*\{[^}]*\bgetFinanceOperationAmount\b[^}]*\}\s*from ['"][^'"]*profitFinanceBreakdown/u
    );
    expect(appSource).toContain('operations.map(getFinanceOperationAmount)');
  });

  it('checks both child and base posting numbers when confirming after-sales refund finance evidence', () => {
    expect(appSource).toContain('function getAfterSalesPostingLookupKeys(row = {})');
    expect(appSource).toContain('return getProfitPostingLookupKeys(');
    expect(appSource).toContain(
      'async function requestOzonAfterSalesRefundFinanceEvidence(shop, row = {}, options = {})'
    );
    expect(appSource).toContain('const lookupPostingNumbers = getAfterSalesPostingLookupKeys(row);');
    expect(appSource).toContain('preferBaseLookup: false');
    expect(appSource).toContain('stopAfterFirstMatchedLookup: false');
    expect(appSource).toContain('const basePostingNumber = getProfitPostingBaseKey(postingNumber);');
    expect(appSource).toContain('matchedPostingNumbers');
  });

  it('routes after-sales write actions through the returns write guard instead of the legacy adapter', () => {
    const writerSource = appSource.slice(
      appSource.indexOf('async function requestProtectedOzonOrderOperation'),
      appSource.indexOf('function getSalesPostingNumber')
    );
    const operationsSource = appSource.slice(
      appSource.indexOf('const ozonProtectedOrderOperations = {'),
      appSource.indexOf('const crossBorderProtectedOrderOperations')
    );

    expect(appSource).toContain('requestReturnsWriteOperation');
    expect(writerSource).toContain('requestReturnsWriteOperation');
    expect(writerSource).not.toContain('requestOzonWrite(');
    expect(operationsSource).toMatch(
      /setRfbsReturnAction:\s*\{[\s\S]*domain:\s*'returns'[\s\S]*endpointKey:\s*'returns\.setRfbsReturnAction'/u
    );
    expect(operationsSource).toMatch(/rejectRfbsReturn:\s*\{[\s\S]*endpointKey:\s*'returns\.rejectRfbsReturn'/u);
    expect(operationsSource).toMatch(
      /compensateRfbsReturn:\s*\{[\s\S]*endpointKey:\s*'returns\.compensateRfbsReturn'/u
    );
    expect(operationsSource).toMatch(/verifyRfbsReturn:\s*\{[\s\S]*endpointKey:\s*'returns\.verifyRfbsReturn'/u);
    expect(operationsSource).toMatch(/receiveRfbsReturn:\s*\{[\s\S]*endpointKey:\s*'returns\.receiveRfbsReturn'/u);
    expect(operationsSource).toMatch(/refundRfbsReturn:\s*\{[\s\S]*endpointKey:\s*'returns\.refundRfbsReturn'/u);
    expect(operationsSource).toMatch(
      /approveConditionalCancellation:\s*\{[\s\S]*endpointKey:\s*'returns\.approveConditionalCancellation'/u
    );
    expect(operationsSource).toMatch(
      /rejectConditionalCancellation:\s*\{[\s\S]*endpointKey:\s*'returns\.rejectConditionalCancellation'/u
    );
    expect(operationsSource).not.toMatch(/setRfbsReturnAction:.*endpointKey:\s*'orders\./u);
  });

  it('shows after-sales reads in the shared top progress panel instead of the table progress line', () => {
    expect(afterSalesPageSource).toContain(
      "import { ReadProgressPanel } from '../../../shared/ui/ReadProgressPanel.jsx';"
    );
    expect(afterSalesPageSource).toContain('ReadProgressPanel');
    expect(afterSalesPageSource).not.toContain('<LinearProgress className="order-sync-progress"');
  });

  it('keeps the after-sales workbench and gives generated rows an original-order fallback route', () => {
    expect(afterSalesPageSource).toContain(
      "import { resolveOzonSellerAfterSalesWorkbenchTarget } from '../../../services/ozonSellerAfterSalesPageLink';"
    );
    expect(afterSalesPageSource).toContain('查看原单');
    expect(afterSalesPageSource).toContain('disabled={!selectedAfterSalesSellerTarget.url}');
    expect(afterSalesPageSource).toContain('const openAfterSalesSellerDetail = React.useCallback(');
    expect(afterSalesPageSource).toContain('afterSalesOzonProductWorkbench.openPurchaseLink({');
    expect(afterSalesPageSource).toContain('onClick={() => openAfterSalesSellerDetail(');
    expect(afterSalesPageSource).not.toContain('originalOrderViewer');
    expect(afterSalesPageSource).not.toContain('AfterSalesOriginalOrderDialog');
  });
});
