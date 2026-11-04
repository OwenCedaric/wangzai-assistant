import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const appEntrySource = readFileSync(join(process.cwd(), 'src', 'App.jsx'), 'utf8');
const stylesSource = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const mainSource = readFileSync(join(process.cwd(), 'src', 'main.jsx'), 'utf8');
// The marketing activity cache was split out of orderShopScope.jsx; read the pieces in
// their original order so slices and (negative) assertions see the same code as before.
const orderShopScopeSource = [
  ['entities', 'marketing', 'marketingActivityCache.jsx'],
  ['entities', 'marketing', 'marketingActivityLegacyMigration.jsx'],
  ['entities', 'marketing', 'marketingActivityDisplay.jsx'],
  ['entities', 'order', 'orderShopScope.jsx'],
]
  .map((parts) => readFileSync(join(process.cwd(), 'src', ...parts), 'utf8'))
  .join('\n');
const marketingActivityListStateSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'marketing', 'model', 'useMarketingActivityListState.jsx'),
  'utf8'
);
const marketingActivityClientSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'marketingActivityClient.js'),
  'utf8'
);
const marketingWriteFeedbackSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'marketing', 'model', 'useMarketingWriteFeedback.jsx'),
  'utf8'
);

describe('marketing activity local-first rules', () => {
  it('uses the SQLite snapshot endpoint for normal marketing cache reads', () => {
    const runtimeReadStart = orderShopScopeSource.indexOf('export async function getMarketingActivityLocalCache');
    const runtimeReadEnd = orderShopScopeSource.indexOf('export let marketingActivityViewStateWriteQueue', runtimeReadStart);
    const runtimeReadSource = orderShopScopeSource.slice(runtimeReadStart, runtimeReadEnd);

    expect(runtimeReadSource).toContain('readMarketingActivitySnapshotCache(');
    expect(runtimeReadSource).toContain('{ shopId, includeProductPool: false }');
    expect(runtimeReadSource).not.toContain('readLocalDataFile(');
    expect(runtimeReadSource).not.toContain('readLegacyBrowserValue(');
    expect(runtimeReadSource).not.toContain('writeLocalDataFile(');
    expect(marketingActivityClientSource).toContain('readMarketingActivitySnapshotCache');
    expect(marketingActivityClientSource).toContain("scope: 'snapshot'");
  });

  it('limits the retired JSON file read to the one-time SQLite migration bridge', () => {
    const migrationStart = orderShopScopeSource.indexOf('export async function migrateLegacyMarketingActivityCacheStore');
    const migrationSource = orderShopScopeSource.slice(migrationStart);

    expect(migrationSource).toContain('readLegacyMarketingFileStore()');
    expect(orderShopScopeSource).toContain('readRetiredMarketingActivityCacheFile');
    expect(orderShopScopeSource).toContain('clearRetiredMarketingActivityCacheFile');
    expect(orderShopScopeSource).not.toContain('readLegacyBrowserValue');
    expect(orderShopScopeSource).not.toContain('compareAndRemoveLegacyBrowserValue');
    expect(orderShopScopeSource).toContain('async function verifyOrImportLegacyMarketingSnapshots');
    expect(orderShopScopeSource).toContain('getMarketingActivitySnapshotDigest(candidate.snapshot)');
    expect(migrationSource).toContain('verifyOrImportLegacyMarketingSnapshots(candidates)');
    expect(migrationSource).toContain('canRetireLegacyMarketingSource(fileSource, fileAssignments, migratedShopIdSet)');
    expect(migrationSource).toContain('clearVerifiedLegacyMarketingFileSource(fileSource)');
    expect(orderShopScopeSource).not.toContain('readLocalDataFile(');
    expect(orderShopScopeSource).not.toContain('writeLocalDataFile(');
    expect(orderShopScopeSource).not.toContain('clearLegacyBrowserValues(MARKETING_ACTIVITY_CACHE_STORAGE_KEY)');
    expect(orderShopScopeSource).not.toContain('rewriteLegacyMarketingFileStore');
    expect(migrationSource).not.toContain('requestOzon');
  });

  it('starts the legacy migration after shop hydration and passes the hydrated shops', () => {
    const hydrateIndex = appEntrySource.indexOf('hydrateOzonShopSettingsWithRetry({');
    const migrationIndex = appEntrySource.indexOf('migrateLegacyMarketingActivityCacheStore({ shops: store.shops })');

    expect(appEntrySource).toContain('migrateLegacyMarketingActivityCacheStore');
    expect(hydrateIndex).toBeGreaterThanOrEqual(0);
    expect(migrationIndex).toBeGreaterThan(hydrateIndex);
    expect(appEntrySource).toContain('migrateLegacyMarketingActivityCacheStore({ shops: store.shops }).catch((error) => {');
    expect(appEntrySource).not.toContain('migrateLegacyMarketingActivityCacheStore().catch((error) => {');
    expect(appEntrySource).toContain("safeWarn('[营销活动] 本地迁移失败，已保留旧副本', error);");
  });

  it('persists runtime view state through SQLite rather than JSON or browser storage', () => {
    const queueStart = orderShopScopeSource.indexOf('function queueMarketingActivityViewStateWrite');
    const queueEnd = orderShopScopeSource.indexOf('export async function flushMarketingActivityViewStateWritesForTest', queueStart);
    const saveStart = orderShopScopeSource.indexOf('export function saveMarketingActivityCache');
    const saveEnd = orderShopScopeSource.indexOf('export function mergeMarketingActivityCache', saveStart);
    const queueSource = orderShopScopeSource.slice(queueStart, queueEnd);
    const saveSource = orderShopScopeSource.slice(saveStart, saveEnd);

    expect(mainSource).not.toContain('BROWSER_LOCAL_STORAGE_MIRROR_KEYS');
    expect(saveSource).toContain('rememberMarketingActivityCacheSnapshot(shop, normalized)');
    expect(saveSource).toContain('queueMarketingActivityViewStateWrite(shop, normalized)');
    expect(queueSource).toContain('saveMarketingActivityViewState({ shopId, viewState })');
    expect(saveSource).not.toContain('writeLocalDataFile(');
    expect(saveSource).not.toContain('window.localStorage.setItem(MARKETING_ACTIVITY_CACHE_STORAGE_KEY');
  });

  it('restores marketing cache on page entry without JSON fallback or automatic Ozon reads', () => {
    const restoreStart = marketingActivityListStateSource.indexOf('const restoreMarketingActivitySqliteSnapshot = React.useCallback');
    const restoreEnd = marketingActivityListStateSource.indexOf('  React.useEffect(() => {', restoreStart);
    const restoreSource = marketingActivityListStateSource.slice(restoreStart, restoreEnd);
    const entryEffectStart = restoreEnd;
    const entryEffectEnd = marketingActivityListStateSource.indexOf('\n\n  return {', entryEffectStart);
    const entrySource = marketingActivityListStateSource.slice(entryEffectStart, entryEffectEnd);

    expect(restoreSource).toContain('getMarketingActivityLocalCache(shop, { timeoutMs: 2500 })');
    expect(entrySource).toContain('restoreMarketingActivitySqliteSnapshot(selectedShop');
    expect(entrySource).toContain('marketingCacheRestoreSeqRef');
    expect(entrySource).toContain('cacheRestoreKeyRef');
    expect(marketingActivityListStateSource).not.toContain('readLocalDataFile(');
    expect(marketingActivityListStateSource).not.toContain('readLegacyBrowserValue(');
    expect(marketingActivityListStateSource).not.toContain('readMarketingActivityLocalApiSnapshot(');
    expect(entrySource).not.toContain('autoReadKeyRef');
    expect(entrySource).not.toContain('autoReadKey');
    expect(entrySource).not.toContain('readActivitiesForShop(');
    expect(entrySource).not.toContain('requestOzonMarketingActivities(');
    expect(entrySource).not.toContain('startMarketingActivitySync(');
  });

  it('fences marketing reads and writes when the global or page-local shop changes', () => {
    expect(marketingActivityListStateSource).toContain(
      'const [selectedShopId, setSelectedShopSelection] = useSynchronizedOzonShopSelection({'
    );
    expect(marketingActivityListStateSource).toContain('onScopeChange: resetMarketingShopScope');
    expect(marketingActivityListStateSource).toContain('marketingScopeGenerationRef.current += 1;');
    expect(marketingActivityListStateSource).toContain('marketingReadSeqRef.current += 1;');
    expect(marketingActivityListStateSource).toContain('productReadSeqRef.current += 1;');
    expect(marketingActivityListStateSource).toContain('resetMarketingShopScope();');
    expect(marketingActivityListStateSource).toContain(
      'const selectedShop = safeShops.find((shop) => shop.id === selectedShopId) ?? null;'
    );
    expect(marketingActivityListStateSource).not.toContain('if (activeShopId) setSelectedShopId(activeShopId);');
    expect(marketingWriteFeedbackSource).toContain(
      'const writeScopeGeneration = marketingScopeGenerationRef?.current ?? 0;'
    );
    expect(marketingWriteFeedbackSource).toContain(
      'if ((marketingScopeGenerationRef?.current ?? 0) !== writeScopeGeneration) return;'
    );
  });

  it('keeps manual marketing refresh as the remote activity reader', () => {
    const handleStart = appSource.indexOf('const handleReadActivities = () => {');
    const handleEnd = appSource.indexOf('const handleMarketingShopChange', handleStart);
    const handleSource = appSource.slice(handleStart, handleEnd);
    const readerStart = appSource.indexOf('async function requestOzonMarketingActivities');
    const readerEnd = appSource.indexOf('function getFriendlyOzonReadError', readerStart);
    const readerSource = appSource.slice(readerStart, readerEnd);

    expect(handleSource).toContain('readActivitiesForShop(selectedShop');
    expect(handleSource).not.toContain('automatic');
    expect(appSource).toContain('const activityReadResult = await requestOzonMarketingActivities(shop, {');
    expect(appSource).toContain('const nextActivities = activityReadResult.activityRows || [];');
    expect(readerSource).toContain('startMarketingActivitySync(');
    expect(readerSource).toContain('readMarketingActivityLocalApiSnapshot(shop');
    expect(readerSource).toContain('includeCacheSnapshot: false');
    expect(readerSource).toContain('waitForResult: false');
    expect(readerSource).not.toContain("requestOzonReadOnly('/v1/actions'");
    expect(readerSource).not.toContain("requestOzonReadOnly('/v1/seller-actions/list'");
    expect(appSource).not.toContain("options.automatic ? '??????");
  });

  it('routes marketing activity product pool through local-api sync and cache', () => {
    const poolStart = appSource.indexOf('async function requestOzonMarketingProductPool');
    const poolEnd = appSource.indexOf('async function requestOzonMarketingSummary', poolStart);
    const poolSource = appSource.slice(poolStart, poolEnd);

    expect(appSource).toContain("from './services/marketingActivityClient'");
    expect(poolSource).toContain('startMarketingProductPoolSync(');
    expect(poolSource).toContain('readMarketingProductPoolLocalApiResult(');
    expect(poolSource).toContain('includeCacheSnapshot: false');
    expect(poolSource).toContain('waitForResult: false');
    expect(poolSource).not.toContain('requestOzonMarketingJoinedItems(');
    expect(poolSource).not.toContain('requestOzonMarketingCandidateItems(');
  });

  it('blocks old direct marketing writes and uses local-api write guard', () => {
    const addStart = appSource.indexOf('async function requestOzonMarketingActivateProducts');
    const addEnd = appSource.indexOf('async function requestOzonMarketingDeactivateProducts', addStart);
    const removeEnd = appSource.indexOf('function normalizeMarketingActivityProduct', addEnd);
    const addSource = appSource.slice(addStart, addEnd);
    const removeSource = appSource.slice(addEnd, removeEnd);

    expect(appSource).toContain('previewMarketingWrite(');
    expect(appSource).toContain('confirmMarketingWrite(');
    expect(addSource).toContain('requestMarketingGuardedWrite(');
    expect(removeSource).toContain('requestMarketingGuardedWrite(');
    expect(addSource).not.toContain('requestOzonWrite(');
    expect(removeSource).not.toContain('requestOzonWrite(');
    expect(appSource).toContain('realWrite: true,');
    expect(appSource).toContain('dryRun: false,');
    expect(appSource).toContain('fastAck: false,');
    expect(appSource).toContain('asyncWrite: false,');
    expect(appSource).toContain('waitForResult: true,');
    expect(appSource).toContain('await refreshCurrentProductPool();');
    expect(appSource).not.toContain('await readActivitiesForShop(selectedShop, { keepExisting: true });');
  });

  it('does not let an empty marketing refresh overwrite visible cached activity data', () => {
    const readerStart = appSource.indexOf('const readActivitiesForShop = async');
    const readerEnd = appSource.indexOf('const handleReadActivities = () => {', readerStart);
    const readerSource = appSource.slice(readerStart, readerEnd);
    const emptyResultIndex = readerSource.indexOf('if (nextActivities.length === 0) {');
    const preserveIndex = readerSource.indexOf('if (hadVisibleData) {', emptyResultIndex);
    const clearRowsIndex = readerSource.indexOf('setActivityRows([]);', emptyResultIndex);

    expect(emptyResultIndex).toBeGreaterThanOrEqual(0);
    expect(preserveIndex).toBeGreaterThan(emptyResultIndex);
    expect(clearRowsIndex).toBeGreaterThan(preserveIndex);
    expect(readerSource).toContain('本次未读取到活动，已保留上次读取结果。');
    expect(readerSource).toContain('setIsShowingCachedMarketingData(true);');
    expect(readerSource).toContain('return;');
  });

  it('auto refreshes marketing product pool when scope or activity has no page cache', () => {
    const pageStart = appSource.indexOf('function MarketingActivityPage');
    const pageEnd = appSource.indexOf('function ProfitCalculationPage');
    const pageSource = appSource.slice(pageStart, pageEnd);
    const loaderStart = pageSource.indexOf('const loadActivityProductPool = async');
    const loaderEnd = pageSource.indexOf('const readActivitiesForShop = async', loaderStart);
    const scopeStart = pageSource.indexOf('const handleProductScopeChange = async');
    const scopeEnd = pageSource.indexOf('const applyDiscountPercent', scopeStart);
    const selectActivityStart = pageSource.indexOf('const handleSelectActivity = async');
    const selectActivityEnd = pageSource.indexOf('const refreshCurrentProductPool = async', selectActivityStart);
    const refreshPoolStart = pageSource.indexOf('const refreshCurrentProductPool = async');
    const refreshPoolEnd = pageSource.indexOf('const marketingFilterCard = (', refreshPoolStart);
    const loaderSource = pageSource.slice(loaderStart, loaderEnd);
    const scopeSource = pageSource.slice(scopeStart, scopeEnd);
    const selectActivitySource = pageSource.slice(selectActivityStart, selectActivityEnd);
    const refreshPoolSource = pageSource.slice(refreshPoolStart, refreshPoolEnd);

    expect(loaderSource).toContain(
      'const allowRemote = options.cacheOnly ? false : options.force || Boolean(options.allowRemote);'
    );
    expect(loaderSource).toContain('if (!cachedResult && !allowRemote && !options.cacheOnly) return null;');
    expect(loaderSource).toContain('readCachedMarketingProductPool(activity, shop, scope)');
    expect(scopeSource).toContain('const cachedResult = await loadActivityProductPool');
    expect(scopeSource).not.toContain('force: true');
    expect(scopeSource).toContain('allowRemote: true');
    expect(scopeSource).toContain('forceRefresh: true');
    expect(scopeSource).toContain('正在读取可添加商品池。');
    expect(scopeSource).toContain('已先显示可添加商品池，Ozon 后台正在复核。');
    expect(selectActivitySource).toContain('const cachedResult = await loadActivityProductPool');
    expect(selectActivitySource).not.toContain('force: true');
    expect(selectActivitySource).toContain('allowRemote: true');
    expect(selectActivitySource).toContain('forceRefresh: true');
    expect(selectActivitySource).toContain('正在读取当前活动商品池。');
    expect(refreshPoolSource).toContain('force: true');
  });

  it('drops stale remote marketing product pool results before caching or state updates', () => {
    const pageStart = appSource.indexOf('function MarketingActivityPage');
    const pageEnd = appSource.indexOf('function ProfitCalculationPage');
    const pageSource = appSource.slice(pageStart, pageEnd);
    const loaderStart = pageSource.indexOf('const loadActivityProductPool = async');
    const loaderEnd = pageSource.indexOf('const readActivitiesForShop = async', loaderStart);
    const loaderSource = pageSource.slice(loaderStart, loaderEnd);

    const remoteResultMatch = /const result\s*=\s*cachedResult\s*\|\|\s*\(?await requestOzonMarketingProductPool/u.exec(
      loaderSource
    );
    const remoteResultIndex = remoteResultMatch?.index ?? -1;
    const staleGuardIndex = loaderSource.indexOf(
      'if (options.canApply && !options.canApply()) return result;',
      remoteResultIndex
    );
    const rememberIndex = loaderSource.indexOf('rememberMarketingProductPoolResult', remoteResultIndex);
    const setProductPoolIndex = loaderSource.indexOf('setProductPool(dedupedProducts);', remoteResultIndex);

    expect(remoteResultIndex).toBeGreaterThanOrEqual(0);
    expect(staleGuardIndex).toBeGreaterThan(remoteResultIndex);
    expect(rememberIndex).toBeGreaterThan(staleGuardIndex);
    expect(setProductPoolIndex).toBeGreaterThan(staleGuardIndex);
  });

  it('uses shared local index and pagination for the marketing product pool', () => {
    const pageStart = appSource.indexOf('function MarketingActivityPage');
    const pageEnd = appSource.indexOf('function ProfitCalculationPage');
    const pageSource = appSource.slice(pageStart, pageEnd);

    expect(pageSource).toContain('const marketingProductRowsIndex = React.useMemo');
    expect(pageSource).toContain('buildRowsIndex(productPool');
    expect(pageSource).toContain('queryRowsIndex(marketingProductRowsIndex');
    expect(pageSource).toContain('paginateRows(productRows, productPage, rowsPerPage)');
    expect(pageSource).not.toContain('const filteredProducts = productPool.filter');
    expect(pageSource).not.toContain('const visibleProductRows = productRows.slice');
  });

  it('records page-level consistency logs for activity product rows', () => {
    const pageStart = appSource.indexOf('function MarketingActivityPage');
    const pageEnd = appSource.indexOf('function ProfitCalculationPage');
    const pageSource = appSource.slice(pageStart, pageEnd);

    expect(pageSource).toContain('const marketingProductDatasetConsistency = React.useMemo');
    expect(pageSource).toContain('validatePageDatasetConsistency(');
    expect(pageSource).toContain("domain: '12_marketing_activities'");
    expect(pageSource).toContain(
      "status: marketingProductDatasetConsistency.ok ? 'consistency-ok' : 'consistency-failed'"
    );
    expect(pageSource).toContain('shopId: selectedShop?.id ||');
    expect(pageSource).toContain('selectedActivityId: selectedActivity.id ||');
    expect(pageSource).toContain('consistency: marketingProductDatasetConsistency');
    const logMatch = pageSource.match(
      /recordLocalMirrorReadLog\(\{\s*domain:\s*'12_marketing_activities'[\s\S]*?\}\)\.catch\(\(\) => undefined\);/u
    );
    expect(logMatch).not.toBeNull();
    expect(logMatch[0]).not.toContain('selectedShop?.clientId');
  });

  it('stores lightweight marketing cache rows without raw interface payloads', () => {
    const productFieldsStart = appSource.indexOf('const MARKETING_ACTIVITY_CACHE_PRODUCT_FIELDS = [');
    const productFieldsEnd = appSource.indexOf('];', productFieldsStart);
    const activityFieldsStart = appSource.indexOf('const MARKETING_ACTIVITY_CACHE_ACTIVITY_FIELDS = [');
    const activityFieldsEnd = appSource.indexOf('];', activityFieldsStart);
    const normalizerStart = appSource.indexOf('function normalizeMarketingCacheSnapshot(snapshot)');
    const normalizerEnd = appSource.indexOf('function getMarketingActivityCacheFromStore', normalizerStart);
    const productFieldsSource = appSource.slice(productFieldsStart, productFieldsEnd);
    const activityFieldsSource = appSource.slice(activityFieldsStart, activityFieldsEnd);
    const normalizerSource = appSource.slice(normalizerStart, normalizerEnd);

    expect(productFieldsSource).toContain("'offerId'");
    expect(productFieldsSource).toContain("'sourceActivityPrice'");
    expect(productFieldsSource).not.toContain("'raw'");
    expect(productFieldsSource).not.toContain("'detail'");
    expect(activityFieldsSource).toContain("'sourceType'");
    expect(activityFieldsSource).not.toContain("'raw'");
    expect(normalizerSource).toContain('snapshot.activityRows.map(normalizeMarketingCacheActivity).filter(Boolean)');
    expect(normalizerSource).toContain('snapshot.productPool.map(normalizeMarketingCacheProduct).filter(Boolean)');
  });

  it('keeps old marketing activity presentation for local-api rows', () => {
    const normalizerStart = appSource.indexOf('function normalizeLocalApiMarketingActivity');
    const normalizerEnd = appSource.indexOf('function getMarketingLocalApiShopId', normalizerStart);
    const normalizerSource = appSource.slice(normalizerStart, normalizerEnd);

    expect(normalizerSource).toContain('const mapped = mapOzonMarketingActivity(raw, index, sourceLabel);');
    expect(normalizerSource).toContain('title: mapped.title || row.title || row.originalTitle');
    expect(normalizerSource).toContain('originalTitle: row.originalTitle || mapped.originalTitle || row.title');
    expect(normalizerSource).toContain('source: mapped.source || sourceLabel');
    expect(normalizerSource).toContain('sourceTone: mapped.sourceTone ||');
    expect(normalizerSource).toContain('description: mapped.description || row.description ||');
    expect(normalizerSource).toContain("estimate: mapped.estimate || row.estimate || '-'");
    expect(normalizerSource).not.toContain('title: row.title || mapped.title');
    expect(normalizerSource).not.toContain('description: row.description || mapped.description');
    expect(normalizerSource).not.toContain('source: sourceLabel,');
  });

  it('keeps marketing stats and product identities visible from cache fallbacks', () => {
    const pageStart = appSource.indexOf('function MarketingActivityPage');
    const pageEnd = appSource.indexOf('function ProfitCalculationPage');
    const pageSource = appSource.slice(pageStart, pageEnd);

    expect(appSource).toContain('function getMarketingStatResolvedValue(...values)');
    expect(appSource).toContain('function getMarketingProductOfferDisplay(product = {})');
    expect(appSource).toContain('function getMarketingProductSkuDisplay(product = {})');
    expect(pageSource).toContain('const marketingActivityDisplayTotal = activityRows.length;');
    expect(pageSource).toContain('const marketingJoinedActivityDisplayTotal = Math.min(');
    expect(pageSource).toContain('countJoinedMarketingActivities(activityRows)');
    expect(pageSource).toContain('value: formatMarketingStatValue(marketingActivityDisplayTotal)');
    expect(pageSource).toContain('value: formatMarketingStatValue(marketingJoinedActivityDisplayTotal)');
    expect(pageSource).not.toContain('value: formatMarketingStatValue(marketingSummary.joinedActivityTotal)');
    expect(pageSource).toContain('const marketingJoinedProductDisplayTotal = getMarketingStatResolvedValue(');
    expect(pageSource).toContain('productPool.length ? loadedJoinedCount : null');
    expect(pageSource).toContain('const marketingIssueProductDisplayTotal = getMarketingStatResolvedValue(');
    expect(pageSource).toContain('productPool.length ? reviewIssueCount : null');
    expect(pageSource).toContain('const productOfferDisplay = getMarketingProductOfferDisplay(product);');
    expect(pageSource).toContain('const productSkuDisplay = getMarketingProductSkuDisplay(product);');
    expect(pageSource).toContain('title={productOfferDisplay}');
    expect(pageSource).toContain('title={productSkuDisplay}');
    const offerHelperStart = appSource.indexOf('function getMarketingProductOfferDisplay(product = {})');
    const offerHelperEnd = appSource.indexOf('function getMarketingProductSkuDisplay(product = {})', offerHelperStart);
    const offerHelperSource = appSource.slice(offerHelperStart, offerHelperEnd);
    expect(offerHelperSource).not.toContain('product.sku');
    expect(offerHelperSource).not.toContain('product.sku,');
    expect(offerHelperSource).not.toContain('raw.sku');
  });

  it('places cancel activity in the top action slot and only removes joined products', () => {
    const pageStart = appSource.indexOf('function MarketingActivityPage');
    const pageEnd = appSource.indexOf('function ProfitCalculationPage');
    const pageSource = appSource.slice(pageStart, pageEnd);
    const writableStart = pageSource.indexOf('const getMarketingWritableSelection = (action) => {');
    const writableEnd = pageSource.indexOf('const openMarketingWriteDialog', writableStart);
    const writableSource = pageSource.slice(writableStart, writableEnd);
    const cancelCssStart = stylesSource.indexOf('.marketing-plan-actions .marketing-action-cancel {');
    const cancelCssEnd = stylesSource.indexOf('}', cancelCssStart);
    const cancelCssSource = stylesSource.slice(cancelCssStart, cancelCssEnd);

    expect(writableSource).toContain("if (action === 'cancel') {");
    expect(writableSource).toContain("product.status === '已添加'");
    expect(writableSource).toContain('getMarketingProductNumericId(product) !== null');
    expect(pageSource).toContain(
      'requestOzonMarketingDeactivateProducts(selectedShop, selectedActivity, products, { confirmed: true })'
    );
    expect(pageSource).not.toContain('marketing-plan-ratio-stack');
    expect(stylesSource).toContain('grid-template-areas:');
    expect(stylesSource).toContain('"ratio cancel"');
    expect(stylesSource).toContain('"plan submit"');
    expect(cancelCssSource).toContain('grid-area: cancel;');
  });

  it('locks the marketing activity page structure after acceptance', () => {
    const pageStart = appSource.indexOf('function MarketingActivityPage');
    const pageEnd = appSource.indexOf('function ProfitCalculationPage');
    const pageSource = appSource.slice(pageStart, pageEnd);

    expect(pageStart).toBeGreaterThanOrEqual(0);
    expect(pageSource).toContain('function MarketingActivityPage');
    expect(pageSource).toContain('<Box className="marketing-page">');
    expect(pageSource).toContain('<Box className="marketing-stat-grid">');
    expect(pageSource).toContain('<Box className="marketing-layout">');
    expect(pageSource).toContain('<Card className="marketing-activity-card">');
    expect(pageSource).toContain('const currentActivityCard = (');
    expect(pageSource).toContain('const marketingFilterCard = (');
    expect(pageSource).toContain('const executionPlanCard = (');
    expect(pageSource).toContain('<Card ref={productCardRef} className="marketing-products-card">');
    expect(pageSource).toContain('const reviewResultCard = (');
    expect(pageSource).toContain('const reminderCard = (');
    expect(pageSource).toContain('活动总数');
    expect(pageSource).toContain('已参加活动');
    expect(pageSource).toContain('已添加商品');
    expect(pageSource).toContain('异常商品');
    expect(pageSource).toContain('读取活动');
    expect(pageSource).toContain('再次读取并复核');
    expect(pageSource).toContain('商品货号 / Ozon SKU');
    expect(pageSource).toContain('暂无符合条件的商品');
  });

  it('locks marketing write flow to confirmed real write plus read-after-write', () => {
    const guardedWriteSource = appSource.slice(
      appSource.indexOf('async function requestMarketingGuardedWrite'),
      appSource.indexOf('async function requestOzonMarketingActivateProducts')
    );
    const pageStart = appSource.indexOf('function MarketingActivityPage');
    const pageEnd = appSource.indexOf('function ProfitCalculationPage');
    const pageSource = appSource.slice(pageStart, pageEnd);
    const dialogStart = pageSource.indexOf('const openMarketingWriteDialog = (action) => {');
    const dialogEnd = pageSource.indexOf('const handleSubmitMarketingChanges = () => {', dialogStart);
    const dialogSource = pageSource.slice(dialogStart, dialogEnd);
    const confirmStart = pageSource.indexOf('const handleConfirmMarketingWrite = async () => {');
    const confirmEnd = pageSource.indexOf('const handleSubmitMarketingChanges = () => {', confirmStart);
    const confirmSource = pageSource.slice(confirmStart, confirmEnd);

    expect(guardedWriteSource).toContain('previewMarketingWrite(');
    expect(guardedWriteSource).toContain('confirmMarketingWrite(');
    expect(guardedWriteSource).toContain('realWrite: true,');
    expect(guardedWriteSource).toContain('dryRun: false,');
    expect(guardedWriteSource).toContain('fastAck: false,');
    expect(guardedWriteSource).toContain('asyncWrite: false,');
    expect(guardedWriteSource).toContain('waitForResult: true,');
    expect(dialogSource).toContain('确认修改比例');
    expect(dialogSource).toContain('确认提交修改');
    expect(dialogSource).toContain('确认取消活动');
    expect(confirmSource).toContain('await requestOzonMarketingDeactivateProducts');
    expect(confirmSource).toContain('await requestOzonMarketingActivateProducts');
    expect(confirmSource).toContain('productPoolCacheRef.current.clear();');
    expect(confirmSource).toContain('await refreshCurrentProductPool();');
    expect(confirmSource).toContain('submitted_waiting_readback');
    expect(confirmSource).toContain('readback_merged');
    expect(confirmSource).toContain('回读成功，SQLite 已合并');
    expect(confirmSource).toContain('已提交 Ozon，正在等待活动商品池回读确认');
    expect(confirmSource).toContain('回读成功并合并 SQLite 前不显示完成');
    expect(confirmSource).not.toContain('活动修改已同步到 Ozon，并已回读最新状态');
    expect(confirmSource).not.toContain('取消活动已同步到 Ozon，并已回读最新状态');
    expect(pageSource).not.toContain('applyOptimisticMarketingWrite');
    expect(pageSource).not.toContain('pollMarketingWriteResult');
  });
});
