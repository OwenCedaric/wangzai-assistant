import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const profitPageFileSource = readFileSync(join(process.cwd(), 'src', 'features', 'profit', 'ProfitPage.jsx'), 'utf8');
const profitModelSource = (name) => readFileSync(join(process.cwd(), 'src', 'features', 'profit', 'model', name), 'utf8');
const ledgerReadbackSource = profitModelSource('useProfitLedgerReadback.js');
const localInputsSource = profitModelSource('useProfitLocalInputs.js');
const calculationLanesSource = profitModelSource('useProfitCalculationLanes.js');
const profitRulesSource = readFileSync(
  join(process.cwd(), 'src', 'entities', 'profit', 'profitAfterSalesRules.jsx'),
  'utf8'
);

function getProfitPageSource() {
  const start = appSource.indexOf('function ProfitCalculationPage');
  const end = appSource.indexOf('function WarehouseLogisticsPage');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return appSource.slice(start, end);
}

describe('profit page manual refresh rules', () => {
  const pageSource = getProfitPageSource();

  it('does not keep deprecated automatic profit supplement effects', () => {
    [
      'shouldAutoSupplementProfitRows',
      'profitImageCooldown',
      'profitOrderRequestRef',
      'profitFinanceRequestRef',
      'profitRatingPenaltyRequestRef',
      'profitFinanceReloadToken',
      'visibleOrderImageKey',
      'visibleOrderFinanceKey',
      'allProfitOrderFinanceKey',
      'OZON_PROFIT_FINANCE_AUTO_ROW_LIMIT',
      'OZON_PROFIT_FINANCE_BATCH_CONCURRENCY',
      'function getProfitTone',
      'function requestOzonRatingPenaltyRangeOperationsForRows',
      'function requestOzonFinanceAccrualByDaySnapshot',
    ].forEach((marker) => {
      expect(appSource).not.toContain(marker);
    });
  });

  it('refreshes all profit orders through the full snapshot path without current-page row slicing', () => {
    const handlerStart = pageSource.indexOf('const handleRefreshAllProfitOrders = React.useCallback');
    const handlerEnd = pageSource.indexOf('React.useEffect(() => {', handlerStart);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handlerSource = pageSource.slice(handlerStart, handlerEnd);

    expect(pageSource).toContain('keepCurrentDataOnForceRefresh: true');
    expect(handlerSource).toContain('const snapshot = await profitSync.refresh();');
    expect(handlerSource).toContain('const refreshedRows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];');
    expect(handlerSource).not.toContain('persistProfitLedgerOrders(refreshedRows, snapshot?.errors ?? [])');
    expect(pageSource).toContain(
      'persistProfitLedgerOrders(profitRows, profitSync.data?.errors ?? []).catch((error) => {'
    );
    expect(pageSource).toContain("safeWarn('利润账本 SQLite 快照写入失败', error);");
    expect(handlerSource).not.toContain('visibleOrders');
    expect(handlerSource).not.toContain('requestOzonProfitCurrentPageRowsForShops');
    expect(pageSource).toContain('onClick={handleRefreshAllProfitOrders}');
    expect(pageSource).toContain("读取中' : '刷新全部订单'");
    expect(appSource).toContain(
      'const financeParentFallbackIndex = buildFinanceParentFallbackIndex(financeParentFallbackRows);'
    );
    expect(appSource).toContain('financeParentFallbackIndex: context.financeParentFallbackIndex');
    expect(appSource).toContain('canUseFinanceParentFallback(');
  });

  it('hydrates visible profit row images, estimated commission and material from one local product mirror read', () => {
    const supplementStart = pageSource.indexOf('const profitLocalProductSupplementRef = React.useRef');
    const supplementEnd = pageSource.indexOf(
      'React.useEffect(() => {',
      pageSource.indexOf('persistProfitLedgerOrders')
    );
    expect(supplementStart).toBeGreaterThanOrEqual(0);
    expect(supplementEnd).toBeGreaterThan(supplementStart);
    const supplementSource = pageSource.slice(supplementStart, supplementEnd);

    expect(profitPageFileSource).toContain("from '../../entities/product/productLocalMirror.jsx';");
    expect(profitPageFileSource).toContain('hasOzonOrderRowProductImage');
    expect(profitPageFileSource).toContain('hasOzonOrderRowEstimatedCommission');
    expect(profitPageFileSource).toContain('readOzonLocalProductEntityRows');
    expect(supplementSource).toContain('readOzonLocalProductEntityRows(');
    expect(supplementSource).toContain('LOCAL_OZON_DATA_LAYER_FILE_KEY');
    expect(supplementSource).toContain('getProfitOrderRecordKey');
    expect(supplementSource).toContain('getProfitProductSupplementGapCount(');
    expect(supplementSource).toContain('enableSkuFallback: true');
    expect(supplementSource).toContain('setProfitImageMap((current) =>');
    expect(supplementSource).not.toContain('readProfitProductSummarySupport(');
    expect(supplementSource).not.toContain('profitSync.loading');
    expect(supplementSource).not.toContain('requestOzonSalesOrderDetail(');
    expect(supplementSource).not.toContain('requestOzonOrderImageSupplementRows');
  });

  it('defaults the profit order read range to all cached history', () => {
    expect(pageSource).toContain('refreshOnMount: false');
    expect(pageSource).toContain('createProfitOrderTimeScope(paymentStartDate, paymentEndDate)');
    expect(profitPageFileSource).toContain('allHistory: true');
    expect(pageSource).toContain('dateRange: profitOrderTimeScope.apiRange');
    expect(pageSource).toContain('timeScope: profitOrderTimeScope');
    expect(pageSource).toContain('createProfitRollingSnapshotScopes(profitOrderTimeScope, 7)');
    expect(pageSource).not.toContain('refreshOnLocalHit: true');
    expect(pageSource).toContain('invalidateOnSnapshotKeyChange: true');
    expect(pageSource).toContain('const profitDateScopeLoadKey =');
    expect(pageSource).toContain('const reloadProfitSnapshot = profitSync.reload;');
    expect(pageSource).toContain('await reloadProfitSnapshot({ silent: true });');
    expect(pageSource).toContain('loaderForceRefresh: false');
    expect(pageSource).toContain('loaderForceRefresh: true');
    expect(pageSource).toContain('autoSync: false');
    expect(pageSource).toContain('forceOrderRefreshShopIds: profitDateRefreshRequest.shopIds');
    expect(appSource).toContain(
      'autoSync: forceRefreshShopIds ? shouldForceThisShop : options.autoSync'
    );
    expect(appSource).toContain('const refreshOnMount = options.refreshOnMount === true;');
    expect(appSource).toContain('return { ...snapshot, refresh: manualRefresh, reload: refresh };');
  });

  it('applies the selected date range once, reloads that scope, and excludes undated rows', () => {
    expect(pageSource).toContain('const [paymentStartDateDraft, setPaymentStartDateDraft]');
    expect(pageSource).toContain('const [paymentEndDateDraft, setPaymentEndDateDraft]');
    expect(pageSource).toContain('setPaymentStartDate(paymentStartDateDraft);');
    expect(pageSource).toContain('setPaymentEndDate(paymentEndDateDraft);');
    expect(pageSource).toContain('previous.key === profitDateScopeLoadKey && !explicitDateRefresh');
    expect(pageSource).toContain('queueProfitDateRefresh();');
    expect(pageSource).toContain('doesSalesOrderMatchPaymentDateRange(order, paymentStartKey, paymentEndKey)');
    expect(pageSource).not.toContain('!paymentDateKey || paymentDateKey >= paymentStartKey');
    expect(pageSource).not.toContain('!paymentDateKey || paymentDateKey <= paymentEndKey');
  });

  it('keeps automatic profit refresh stable and non-blocking after local rows are visible', () => {
    expect(pageSource).toContain("const profitSnapshotShopsRef = React.useRef({ sourceKey: '', shops: [] });");
    expect(pageSource).toContain(
      'if (profitSnapshotShopsRef.current.sourceKey !== readableShopsSourceKey) {'
    );
    expect(pageSource).toContain(
      'const profitSnapshotShops = profitSnapshotShopsRef.current.shops;'
    );
    expect(pageSource).toContain(
      'useOzonRealtimeSnapshot(profitSnapshotShops, requestOzonProfitFullSnapshotForShops, {'
    );
    expect(pageSource).toContain(
      'const profitBlockingLoading = Boolean(profitSync.loading && !hasVisibleProfitCache);'
    );
    expect(pageSource).toContain(
      'const profitProgressRunning = Boolean(profitBlockingLoading || profitPageRefreshing);'
    );
    expect(profitPageFileSource).toContain('利润页已显示本地缓存 ${profitCachedRows} 条，后台同步不阻塞使用');
    expect(pageSource).toContain(
      'disabled={!readableShops.length || profitBlockingLoading || profitPageRefreshing}'
    );
    expect(pageSource).not.toContain(
      'const profitProgressRunning = Boolean(profitSync.loading || profitSync.refreshing || profitPageRefreshing);'
    );
  });

  it('keeps the loaded profit page intact when switching to another workspace tab and back', () => {
    expect(pageSource).toContain('const profitSharedOrderLoadedKeyRef = React.useRef');
    expect(pageSource).toContain('profitSharedOrderLoadedKeyRef.current === profitSharedOrderLoadKey');
    expect(pageSource).toContain('useProfitLedgerReadback({');
    expect(ledgerReadbackSource).toContain('loadedKeyRef.current === snapshotKeyToken');
    expect(pageSource).toContain('useProfitLocalInputs({');
    expect(localInputsSource).toContain('appliedRef.current === requestedKey');
    expect(pageSource).not.toContain("if (!isActive || !readableShops.length) {\n      setProfitSharedOrderRows([]);");
    expect(pageSource).not.toContain("if (!isActive || !readableShops.length) {\n      profitDateScopeLoadRef.current = { key: '', revision:");
  });

  it('keeps profit page entry local-first while allowing daily rates for actual finance', () => {
    expect(pageSource).toContain('LOCAL_PROFIT_DATA_FILE_KEY');
    expect(pageSource).toContain('localDataFileKey: LOCAL_PROFIT_DATA_FILE_KEY');
    expect(profitRulesSource).not.toContain('realtimeOnlyExchangeRate: true');
    expect(profitRulesSource).toContain('skipDailyRates: !shouldReadDailyRates');
  });

  it('keeps profit ledger reads on the current scoped rolling snapshot scheme only', () => {
    const keyStart = pageSource.indexOf('const profitLedgerSnapshotKeys = React.useMemo');
    const keyEnd = pageSource.indexOf('const profitLedgerSnapshotKey =', keyStart);
    expect(keyStart).toBeGreaterThanOrEqual(0);
    expect(keyEnd).toBeGreaterThan(keyStart);
    const keySource = pageSource.slice(keyStart, keyEnd);

    expect(keySource).toContain('profitRollingSnapshotScopes.flatMap((scope)');
    expect(keySource).toContain('profitLedgerBaseSnapshotKeys.map((key) => appendOzonSnapshotScopeKey(key, scope))');
    expect(keySource).not.toContain('appendLegacyOzonDateRangeToSnapshotKey');
    expect(keySource).not.toContain('...profitLedgerBaseSnapshotKeys');
    expect(pageSource).not.toContain('clearProfitLedgerLocalSnapshot');
    expect(pageSource).not.toContain('handleClearProfitLedgerCache');
    expect(pageSource).not.toContain('清除缓存');
  });

  it('keeps final-zero orders pending until finance cache has been checked', () => {
    const statusStart = appSource.indexOf('function getProfitActualFinanceStatus');
    const statusEnd = appSource.indexOf('function rebuildProfitLedgerWithManualOverride', statusStart);
    expect(statusStart).toBeGreaterThanOrEqual(0);
    expect(statusEnd).toBeGreaterThan(statusStart);
    const statusSource = appSource.slice(statusStart, statusEnd);

    expect(appSource).toContain('delivered|received|signed|success/.test(statusText);');
    expect(appSource).not.toContain('\\bcompleted\\b|\\bcomplete\\b');
    expect(appSource).toContain('|awaiting|deliver|shipping|in_transit|processing/.test(');
    expect(appSource).not.toContain('|delivering|in_delivery|delivery_in_progress|shipping');
    expect(statusSource).toContain('const financeEvidence = getProfitFinanceEvidenceSummary(financeOperations);');
    expect(statusSource).toContain(
      "if (hasSignedRefund) return financeEvidence.hasSignedRefundClosure ? 'confirmed' : 'pending';"
    );
    expect(statusSource).toContain('financeEvidence.hasBalancedAcquiringRedistributionClosure');
    expect(statusSource).toContain(
      "return financeEvidence.hasRefundDeductionOperation || hasFinalZeroFinanceClosure ? 'confirmed' : 'pending';"
    );
    expect(statusSource).toContain(
      "if (isProfitFinalZeroAllowedStatus(statusText)) return financeLookupChecked ? 'confirmed' : 'pending';"
    );
    expect(statusSource).toContain("if (isProfitInProgressStatus(statusText)) return 'provisional';");
    expect(statusSource).toContain("if (isProfitCompletedStatus(statusText)) return 'pending';");
    expect(statusSource).toContain("if (!financeLookupChecked) return 'provisional';");
    expect(statusSource).toContain('if (!financeLookupChecked) {');
    expect(statusSource).toContain("if (hasRefund || isProfitCompletedStatus(statusText)) return 'pending';");
    expect(appSource).toContain(
      '!isFinalZeroStatus && !isProfitCompletedStatus(actualStatusText) && isProfitInProgressStatus(actualStatusText)'
    );
    expect(appSource).not.toContain('forceActualProfitPending: !isActualFinalizedStatus');
  });

  it('does not mask ready actual profit in the display adapter after the ledger has an amount', () => {
    expect(appSource).not.toContain('function maskProfitLedgerActualResultsForUnfinalizedOrder');
    expect(appSource).not.toContain('function createProfitPendingLedgerResult');
    expect(appSource).toContain('const ledger = ledgerRow || order.profitLedger;');
  });

  it('keeps the finance supplement helper reading rating penalties for every supplied row', () => {
    const ratingSnapshotStart = appSource.indexOf('async function requestOzonRatingPenaltyOperationsSnapshot');
    const ratingSnapshotEnd = appSource.indexOf('function addFinanceIndexKey', ratingSnapshotStart);
    const supplementStart = appSource.indexOf('async function requestOzonProfitFinanceSupplementForShop');
    const supplementEnd = appSource.indexOf('async function requestOzonProfitFinanceRowsForShops', supplementStart);
    expect(ratingSnapshotStart).toBeGreaterThanOrEqual(0);
    expect(ratingSnapshotEnd).toBeGreaterThan(ratingSnapshotStart);
    expect(supplementStart).toBeGreaterThanOrEqual(0);
    expect(supplementEnd).toBeGreaterThan(supplementStart);

    const ratingSnapshotSource = appSource.slice(ratingSnapshotStart, ratingSnapshotEnd);
    const supplementSource = appSource.slice(supplementStart, supplementEnd);

    expect(ratingSnapshotSource).toContain('const targetRows = options.includeAllRows');
    expect(supplementSource).toContain('includeAllRows: options.includeAllRatingPenaltyRows');
    expect(supplementSource).toContain('ratingPenaltyIndex: buildProfitPenaltyAttributionIndex(');
    expect(supplementSource).toContain('options.allRowsForParentFallback || rows');
  });

  it('uses a narrow per-order date window for posting-level finance and penalty lookups', () => {
    const requestsStart = appSource.indexOf('function getProfitFinancePostingRequests');
    const requestsEnd = appSource.indexOf('function getProfitOrderLookupKeys', requestsStart);
    expect(requestsStart).toBeGreaterThanOrEqual(0);
    expect(requestsEnd).toBeGreaterThan(requestsStart);
    const requestsSource = appSource.slice(requestsStart, requestsEnd);

    expect(appSource).toContain('const PROFIT_FINANCE_ROW_LOOKBACK_DAYS = 2;');
    expect(appSource).toContain('const PROFIT_FINANCE_ROW_LOOKAHEAD_DAYS = 14;');
    expect(requestsSource).toContain('const selectedRange = getExplicitOzonTimeRange(options);');
    expect(requestsSource).toContain('dateRange: getProfitFinanceDateRangeForRow(row, selectedRange || fallbackRange)');
    expect(requestsSource).not.toContain(
      'dateRange: selectedRange || getProfitFinanceDateRangeForRow(row, fallbackRange)'
    );
  });

  it('does not call manual all-order profit refresh from a page-entry effect', () => {
    const beforeHandlerSource = pageSource.slice(
      0,
      pageSource.indexOf('const handleRefreshAllProfitOrders = React.useCallback')
    );
    expect(beforeHandlerSource).not.toContain('requestOzonProfitCurrentPageRowsForShops');
    expect(beforeHandlerSource).not.toContain('handleRefreshAllProfitOrders()');
    expect(pageSource).not.toContain('handleRefreshCurrentProfitPage');
    expect(pageSource).not.toContain('补全近三月');
  });

  it('does not preload rating penalties from Ozon on page entry', () => {
    const beforeHandlerSource = pageSource.slice(
      0,
      pageSource.indexOf('const handleRefreshAllProfitOrders = React.useCallback')
    );

    expect(appSource).toContain('async function requestOzonRatingPenaltyBulkOperationsForRows');
    expect(appSource).toContain('function getProfitRowsNeedingRatingPenaltyPostingFallback');
    expect(beforeHandlerSource).toContain('const localProfitRatingPenaltyIndex = React.useMemo');
    expect(beforeHandlerSource).toContain('const mergedProfitRatingPenaltyIndex = localProfitRatingPenaltyIndex;');
    expect(beforeHandlerSource).not.toContain('requestOzonRatingPenaltyBulkOperationsForRows');
    expect(beforeHandlerSource).not.toContain('setProfitRatingPenaltyIndex');
    expect(beforeHandlerSource).not.toContain('错误费用索引');
    expect(beforeHandlerSource).not.toContain('requestOzonProfitCurrentPageRowsForShops');
    expect(beforeHandlerSource).not.toContain('requestOzonProfitFinanceRowsForShops(');
    expect(beforeHandlerSource).not.toContain('requestOzonRatingPenaltyOperationsSnapshot(');
  });

  it('keeps three-month rating penalty reads from being cancelled by one failed old date chunk', () => {
    const rangeStart = appSource.indexOf('async function requestOzonRatingPenaltyOperationsForDateRange');
    const rangeEnd = appSource.indexOf(
      'async function requestOzonRatingPenaltyOperationsForDateRangeCached',
      rangeStart
    );
    expect(rangeStart).toBeGreaterThanOrEqual(0);
    expect(rangeEnd).toBeGreaterThan(rangeStart);
    const rangeSource = appSource.slice(rangeStart, rangeEnd);

    expect(rangeSource).toContain('getOzonFinanceDateChunks(dateRange.since, dateRange.to).slice().reverse()');
    expect(rangeSource).toContain('const chunkErrors = [];');
    expect(rangeSource).toContain('let successfulChunks = 0;');
    expect(rangeSource).toContain('chunkErrors.push({ chunk, error });');
    expect(rangeSource).toContain('if (!successfulChunks && chunkErrors.length)');
    expect(rangeSource).not.toContain('const dateChunks = getOzonFinanceDateChunks(dateRange.since, dateRange.to);');
  });

  it('does not reject rating penalties only because the row has a shop label instead of a shop id', () => {
    const scopeStart = appSource.indexOf('function doesRatingPenaltyOperationMatchOrderScope');
    const scopeEnd = appSource.indexOf('function collectRatingPenaltyOperationsByKeys', scopeStart);
    expect(scopeStart).toBeGreaterThanOrEqual(0);
    expect(scopeEnd).toBeGreaterThan(scopeStart);
    const scopeSource = appSource.slice(scopeStart, scopeEnd);

    expect(scopeSource).toContain(
      'const orderShopClientId = normalizeOzonId(firstFilled(order.shopClientId, order.clientId)).trim();'
    );
    expect(scopeSource).toContain('const orderShopId = normalizeOzonId(order.shopId).trim();');
    expect(scopeSource).not.toContain('firstFilled(order.shopId, order.shop)');
  });

  it('persists rendered profit rows on page entry without wiring a manual finance refresh', () => {
    const beforeHandlerSource = pageSource.slice(
      0,
      pageSource.indexOf('const handleRefreshAllProfitOrders = React.useCallback')
    );

    expect(beforeHandlerSource).toContain('const profitRowsLedgerSignature = React.useMemo');
    expect(beforeHandlerSource).toContain('const profitLedgerPersistSignatureRef = React.useRef');
    expect(ledgerReadbackSource).toContain("!partial && [PROFIT_LEDGER_CHUNKED_FORMAT, 'profit-ledger-partitioned-v1'].includes(snapshot?.persistenceFormat)");
    expect(ledgerReadbackSource).toContain('? createPersistSignature(rows, snapshotKeyToken)');
    expect(beforeHandlerSource).toContain(
      'persistProfitLedgerOrders(profitRows, profitSync.data?.errors ?? []).catch((error) => {'
    );
    expect(beforeHandlerSource).toContain('profitLedgerPersistSignatureRef.current === profitRowsLedgerSignature');
    expect(beforeHandlerSource).not.toContain('persistProfitLedgerOrders(rawBaseProfitRows');
    expect(beforeHandlerSource).not.toContain('persistProfitLedgerOrders(baseProfitRows');
    expect(beforeHandlerSource).not.toContain('requestOzonProfitCurrentPageRowsForShops');
  });

  it('keeps page entry effects local and does not wire manual all-order refresh into effects', () => {
    const handlerStart = pageSource.indexOf('const handleRefreshAllProfitOrders = React.useCallback');
    const afterHandlerSource = pageSource.slice(handlerStart);
    const effectSources = [
      ...afterHandlerSource.matchAll(/React\.useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/g),
    ].map((match) => match[0]);

    expect(effectSources.length).toBeGreaterThan(0);
    effectSources.forEach((effectSource) => {
      expect(effectSource).not.toContain('handleRefreshCurrentProfitPage');
      expect(effectSource).not.toContain('requestOzonProfitCurrentPageRowsForShops');
    });
  });

  it('hydrates from SQLite and enables only targeted empty-finance verification without bulk page-entry Ozon refresh', () => {
    const beforeHandlerSource = pageSource.slice(
      0,
      pageSource.indexOf('const handleRefreshAllProfitOrders = React.useCallback')
    );

    expect(profitPageFileSource).toContain('readLocalProfitFinanceContextsForShops');
    expect(beforeHandlerSource).toContain('const cachedOnlyProfitFinanceRows = React.useMemo');
    expect(beforeHandlerSource).toContain('shouldHydrateCachedProfitFinanceOrder(order, { revalidateConfirmed: true })');
    expect(beforeHandlerSource).toContain('readLocalProfitFinanceContextsForShops(readableShops, baseProfitRows');
    expect(beforeHandlerSource).toContain('lookupRows: cachedOnlyProfitFinanceRows');
    expect(beforeHandlerSource).toContain('verifyEmptyFinance: true');
    expect(beforeHandlerSource).toContain('financeIndex: localFinanceContext.financeIndex');
    expect(beforeHandlerSource).toContain(
      'financeLookupCheckedIndex: localFinanceContext.financeLookupCheckedIndex'
    );
    expect(beforeHandlerSource).toContain(
      'financeParentFallbackIndex: localFinanceContext.financeParentFallbackIndex'
    );
    expect(beforeHandlerSource).not.toContain('requestOzonProfitFinanceRowsForShops(');
  });

  it('uses the shared local index before filtering and paginating profit rows', () => {
    expect(pageSource).toContain('const profitRowsIndex = React.useMemo');
    expect(pageSource).toContain('buildRowsIndex(profitRows');
    expect(pageSource).toContain('const profitIndexedRows = React.useMemo');
    expect(pageSource).toContain('queryRowsIndex(profitRowsIndex');
    expect(pageSource).toContain('profitIndexedRows.filter((order) => {');
    expect(pageSource).toContain('sortProfitOrdersByPaymentDateDesc(');
    expect(pageSource).toContain('paginateRows(filteredOrders, profitOrderPage, profitOrderPageSize)');
    expect(pageSource).not.toContain('const filteredOrders = profitRows.filter');
  });

  it('rebuilds the rating penalty index from local ledger penalty details without page-entry Ozon requests', () => {
    const beforeHandlerSource = pageSource.slice(
      0,
      pageSource.indexOf('const handleRefreshAllProfitOrders = React.useCallback')
    );

    expect(appSource).toContain('buildProfitPenaltyAttributionIndex');
    expect(pageSource).toContain('const [profitLocalPenaltyDetails, setProfitLocalPenaltyDetails]');
    expect(pageSource).toContain('const localProfitRatingPenaltyIndex = React.useMemo');
    expect(pageSource).toContain('const mergedProfitRatingPenaltyIndex = localProfitRatingPenaltyIndex;');
    expect(ledgerReadbackSource).toContain('snapshot?.profitPenaltyDetails ?? snapshot?.penaltyDetails ?? {}');
    expect(beforeHandlerSource).not.toContain('requestOzonRatingPenaltyOperationsSnapshot(');
  });

  it('selects the best available profit ledger instead of taking the first cached ledger', () => {
    const profitRowsSource = pageSource.slice(
      pageSource.indexOf('const createProfitRowCalculation = React.useCallback'),
      pageSource.indexOf('const [activeTab', pageSource.indexOf('const createProfitRowCalculation = React.useCallback'))
    );

    expect(appSource).toContain('selectBestProfitLedgerRow');
    expect(profitRowsSource).toContain(
      'const ledgerCandidates = [financeOrder?.profitLedger, ledgerRow, mergedWithFinance.profitLedger].filter'
    );
    expect(profitRowsSource).toContain('const selectedLedger = selectBestProfitLedgerRow(ledgerCandidates);');
    expect(profitRowsSource).not.toContain('PROFIT_CONTEXTLESS_PAGE_RECALCULATION_FROZEN');
    expect(profitRowsSource).not.toContain('return applyProfitLedgerToProfitOrder(materialReadyOrder, selectedLedger);');
    expect(profitRowsSource).toContain('const calculationOrder = prepareProfitCalculationOrder(materialReadyOrder, financeBaselineLedger)');
    expect(profitRowsSource).toContain("const normalizedOrder = yield { operation: 'normalize', input: { order: calculationOrder");
    expect(profitRowsSource).toContain("operation: 'rebuild-final', input: { order: calculationOrder, ledger: mergedLedger || selectedLedger }");
    expect(profitRowsSource).toContain('const mergedLedger = financeBaselineLedger');
    expect(profitRowsSource).toContain('protectProfitLedgerFinanceInputs(financeBaselineLedger, normalizedOrder.profitLedger');
    expect(profitRowsSource).toContain('financeReadbackComplete: hasLocalFinanceMatch');
    expect(profitRowsSource).toContain("operation: 'merge-ledger', input: { order: calculationOrder, cachedLedger: financeBaselineLedger, ledger: protectedFreshLedger }");
    expect(profitRowsSource).toContain("const existingLedger = yield { operation: 'rebuild-final'");
    expect(profitRowsSource).toContain('shouldIncludeOrderInBusinessFlow(calculatedOrder) ? calculatedOrder : null');
    expect(profitRowsSource).toContain('useProfitCalculationLanes({');
    // Row-level selection replaces the old whole-shop call shape; the
    // financial callback and its owner isolation remain behavior-tested.
    expect(calculationLanesSource).toContain('createProfitCalculationPlan(lanes');
    expect(calculationLanesSource).toContain('runProfitShopCalculationLanes(workRows');
    expect(calculationLanesSource).toContain('calculateProfitRow(row, index, shopId)');
    expect(calculationLanesSource).toContain('plan.rowCacheSafe');
    expect(profitRowsSource).not.toContain('filterProfitSplitAggregateRows');
    expect(profitRowsSource).not.toContain(
      '[financeOrder?.profitLedger, ledgerRow, mergedWithFinance.profitLedger].find'
    );
  });

  it('rebuilds final-zero ledgers to zero only after finance cache evidence exists', () => {
    const profitRowsSource = pageSource.slice(
      pageSource.indexOf('const createProfitRowCalculation = React.useCallback'),
      pageSource.indexOf('const [activeTab', pageSource.indexOf('const createProfitRowCalculation = React.useCallback'))
    );

    expect(appSource).toContain('function shouldRebuildProfitLedgerForFinalZeroActualSales');
    expect(appSource).toContain('const hasFinanceEvidence =');
    expect(appSource).toContain('hasProfitLedgerActualFinanceEvidence(ledger)');
    expect(appSource).toContain('if (!hasFinanceEvidence) return false;');
    expect(appSource).toContain('amounts.actualSalesAmountCny = 0;');
    expect(appSource).not.toContain('function isProfitLedgerMissingFinanceZeroPlaceholder');
    expect(appSource).toContain('if (amounts[key] === null) amounts[key] = 0;');
    expect(appSource).toContain("actualFinanceStatus: 'confirmed'");
    expect(appSource).toContain('hasActualFinance: true');
    expect(appSource).toContain('financeOperationCount: ledger.financeOperationCount');
    expect(appSource).toContain('afterSalesCount: ledger.afterSalesCount');
    expect(appSource).toContain(
      'if (actualPenaltyValue === null && !penaltySummary?.hasPenaltyEvent && penaltyDetails.length === 0)'
    );
    expect(appSource).toContain('getProfitLedgerPenaltyEvidenceRecords(ledger)');
    expect(profitRowsSource).toContain('const selectedLedger = selectBestProfitLedgerRow(ledgerCandidates);');
    expect(profitRowsSource).toContain('const mergedLedger = financeBaselineLedger');
    expect(profitRowsSource).toContain("const existingLedger = yield { operation: 'rebuild-final'");
  });

  it('displays missing actual fee detail fields as zero like the test version', () => {
    expect(appSource).toContain('const zeroActualFee = getProfitDisplayMoney(0, currencyCode);');
    expect(appSource).toContain(
      'getProfitLedgerExpenseDisplay(ledger.amounts?.actualCommissionFeeCny, currencyCode, zeroActualFee)'
    );
    expect(appSource).toContain("getProfitActualFeeValueByLabel(actualFees, ['佣金扣费', '销售佣金'], zeroActualFee)");
    expect(appSource).not.toContain('const pendingActualFee =');
  });

  it('drops stale all-order profit refreshes after shop or time scope changes', () => {
    const handlerStart = pageSource.indexOf('const handleRefreshAllProfitOrders = React.useCallback');
    const handlerEnd = pageSource.indexOf('React.useEffect(() => {', handlerStart);
    const handlerSource = pageSource.slice(handlerStart, handlerEnd);

    expect(pageSource).toContain('const visibleProfitOrderKey = React.useMemo');
    expect(pageSource).toContain('const profitVisibleImageScopeKey = React.useMemo');
    expect(pageSource).toContain('const profitAllOrderRefreshScopeKey = React.useMemo');
    expect(pageSource).toContain('const profitAllOrderRefreshScopeRef = React.useRef(profitAllOrderRefreshScopeKey);');
    expect(pageSource).toContain('const profitPageRefreshRequestRef = React.useRef(0);');
    expect(pageSource).toContain('profitPageRefreshRequestRef.current += 1;');

    expect(handlerSource).toContain('const requestId = profitPageRefreshRequestRef.current + 1;');
    expect(handlerSource).toContain('profitPageRefreshRequestRef.current = requestId;');
    expect(handlerSource).toContain('const requestScopeKey = profitAllOrderRefreshScopeKey;');
    expect(handlerSource).toContain('const isCurrentProfitRefresh = () =>');
    expect(handlerSource).toContain('profitAllOrderRefreshScopeRef.current === requestScopeKey');
    expect(handlerSource).toContain('if (!isCurrentProfitRefresh()) return;');
    expect(handlerSource).toContain(
      'if (profitPageRefreshRequestRef.current === requestId) setProfitPageRefreshing(false);'
    );
    expect(pageSource).toContain('setProfitPageRefreshing(false);');
  });

  it('shows profit reads in the shared top progress panel instead of the table progress line', () => {
    expect(profitPageFileSource).toContain(
      "import { ReadProgressPanel } from '../../shared/ui/ReadProgressPanel.jsx';"
    );
    expect(pageSource).toContain('ariaLabel="利润核算读取进度"');
    expect(pageSource).toContain('本地缓存已显示 ${profitCachedRows} 条，后台同步中');
    expect(pageSource).toContain('正在刷新全部利润订单，当前缓存');
    expect(pageSource).not.toContain('<LinearProgress className="order-sync-progress"');
    expect(profitPageFileSource).not.toContain("from '@mui/material/LinearProgress'");
  });

  it('does not render purchase source or cross-border cards in the profit detail card', () => {
    expect(profitPageFileSource).not.toContain("from '../../services/purchaseInfoSupport';");
    expect(profitPageFileSource).not.toContain(
      "import { LazyHoverImagePreview } from '../../shared/ui/ImagePreview.jsx';"
    );
    expect(profitPageFileSource).not.toContain("from '../../entities/order/crossBorderOrderApi.jsx';");
    expect(profitPageFileSource).not.toContain('readPurchaseInfoOverrideRows()');
    expect(profitPageFileSource).not.toContain('buildPurchaseInfoOverrideIndex(profitPurchaseOverrideRows)');
    expect(profitPageFileSource).not.toContain('findPurchaseInfoOverride(selectedOrder, profitPurchaseOverrideIndex)');
    expect(profitPageFileSource).not.toContain('getPurchaseInfoSupport(selectedOrder, selectedPurchaseOverride)');
    expect(profitPageFileSource).not.toContain(
      'getPurchaseInfoCrossBorderInfo(selectedOrder, selectedPurchaseOverride)'
    );
    expect(profitPageFileSource).not.toContain('selectedPurchaseInfoSupport?.sourceLink');
    expect(profitPageFileSource).not.toContain('<LazyHoverImagePreview');
    expect(profitPageFileSource).not.toContain('profit-source-cost-row');
    expect(profitPageFileSource).not.toContain('跨境巴士信息');
    expect(profitPageFileSource).not.toContain('getCrossBorderReadStatusDisplay(selectedCrossBorderInfo.readStatus)');
    expect(profitPageFileSource).not.toContain('<PurchaseInfoDialog');
    expect(profitPageFileSource).not.toContain('PROFIT_PURCHASE_INFO_STORAGE_KEY');
  });

  it('routes full profit snapshots through the unified order, after-sales and finance pipeline', () => {
    const fullSnapshotStart = appSource.indexOf('async function requestOzonProfitSnapshotForShops');
    const fullSnapshotEnd = appSource.indexOf(
      'async function requestOzonProfitFullSnapshotForShops',
      fullSnapshotStart
    );
    expect(fullSnapshotStart).toBeGreaterThanOrEqual(0);
    expect(fullSnapshotEnd).toBeGreaterThan(fullSnapshotStart);
    const fullSnapshotSource = appSource.slice(fullSnapshotStart, fullSnapshotEnd);
    const unifiedRowsStart = appSource.indexOf('async function requestOzonProfitFinanceRowsForShops');
    const unifiedRowsEnd = appSource.indexOf('async function requestOzonProfitSnapshotForShops', unifiedRowsStart);
    expect(unifiedRowsStart).toBeGreaterThanOrEqual(0);
    expect(unifiedRowsEnd).toBeGreaterThan(unifiedRowsStart);
    const unifiedRowsSource = appSource.slice(unifiedRowsStart, unifiedRowsEnd);

    expect(fullSnapshotSource).toContain(
      'requestOzonProfitFinanceRowsForShops(readableShops, salesSnapshot.rows'
    );
    expect(fullSnapshotSource).toContain("mode: 'unified-order-after-sales-finance'");
    expect(fullSnapshotSource).toContain("source: 'canonical'");
    expect(appSource).not.toContain('requestOzonProfitLegacyLocalOnlySnapshotForShops');
    expect(unifiedRowsSource).toContain('readProfitProductSummarySupport(rows, readableShops');
    expect(unifiedRowsSource).toContain('afterSalesIndex: new Map()');
    expect(unifiedRowsSource).toContain('financeIndex');
    expect(unifiedRowsSource).toContain('profitFinanceVersion: PROFIT_FINANCE_CACHE_VERSION');
    expect(unifiedRowsSource).toContain('applyOzonLocalProductEntitiesToRows(');
    expect(unifiedRowsSource).toContain('rowsWithProductSummary.map((row) =>');
    expect(unifiedRowsSource).toContain('productSourceLinks: mergedProductSourceLinks');
    expect(unifiedRowsSource).not.toContain(
      'enrichPurchaseRowsWithOzonImagesForShops(readableShops, salesSnapshot.rows'
    );
  });

  it('shows formula and source hints for every profit detail amount', () => {
    expect(appSource).toContain('function getProfitLedgerFormulaHint');
    expect(appSource).toContain('公式：${formula}');
    expect(appSource).toContain('商品成交额 × Ozon佣金比例');
    expect(appSource).toContain('销售收入 - 总预估扣费');
    expect(appSource).toContain('商品佣金 + 收单业务 + 配送服务 + 物流预估 + 货源成本 + 巴士费用');
    expect(pageSource).toContain('renderProfitEditableMoneyValue(');
    expect(pageSource).toContain('item.hint');
    expect(pageSource).toContain('title={item.hint || undefined}');
  });
});
