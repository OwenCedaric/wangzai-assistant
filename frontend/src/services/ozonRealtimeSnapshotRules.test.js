import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readSplitAppSource } from '../test/appSource';

function readAppSource() {
  return readSplitAppSource();
}

function readProjectSource(relativePath) {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function readOrderExperienceSource() {
  return readFileSync(path.join(process.cwd(), 'src', 'services', 'ozonOrderExperience.js'), 'utf8');
}

describe('useOzonRealtimeSnapshot local-first rules', () => {
  it('loads local snapshots on page entry without falling through to the external loader', () => {
    const appSource = readAppSource();
    const hookStart = appSource.indexOf('function useOzonRealtimeSnapshot');
    const hookEnd = appSource.indexOf('function firstMarketingValue', hookStart);
    const hookSource = appSource.slice(hookStart, hookEnd);

    expect(hookSource).toContain('localOnly = false');
    expect(hookSource).toContain('const loadLocalOnMount = options.loadLocalOnMount !== false');
    expect(hookSource).toContain('const allowAggregateLocalData = options.allowAggregateLocalData === true;');
    expect(hookSource).toContain('aggregateSource && !allowAggregateLocalData');
    expect(hookSource).toContain('refresh({ silent: true, localOnly: true });');
    expect(hookSource).toContain("const matchedLocalSnapshotKey = String(localSnapshot.localSnapshotKey || '');");
    expect(hookSource).toContain('matchedLocalSnapshotKey !== localDataSnapshotKey');

    const localOnlyGuardIndex = hookSource.indexOf('if (localOnly)');
    const sourceCredentialCheckIndex = hookSource.indexOf('if (!canUseOzonSnapshotSource(source))');
    const externalLoaderIndex = hookSource.search(
      /const requestPromise\s*=\s*existingRequest\s*\|\|\s*loader\(source/u
    );

    expect(localOnlyGuardIndex).toBeGreaterThan(-1);
    expect(localOnlyGuardIndex).toBeLessThan(sourceCredentialCheckIndex);
    expect(localOnlyGuardIndex).toBeLessThan(externalLoaderIndex);
  });

  it('keeps manual refresh as the only force path while allowing explicit non-force mount refresh', () => {
    const appSource = readAppSource();
    const hookStart = appSource.indexOf('function useOzonRealtimeSnapshot');
    const hookEnd = appSource.indexOf('function firstMarketingValue', hookStart);
    const hookSource = appSource.slice(hookStart, hookEnd);

    expect(hookSource).toContain('return refresh({ silent: false, force: true });');
    expect(hookSource).toContain('if (!enabled || !loadLocalOnMount) return undefined;');
    expect(hookSource).toContain('const refreshOnMount = options.refreshOnMount === true;');
    expect(hookSource).toContain('const abortOnUnmount = options.abortOnUnmount === true;');
    expect(hookSource).toContain('if (abortOnUnmount) requestAbortRef.current?.abort();');
    expect(hookSource).toContain('if (refreshOnMount && canUseOzonSnapshotSource(source)) return undefined;');
    expect(hookSource).toContain('if (!canUseOzonSnapshotSource(source)) return undefined;');
    expect(hookSource).toContain('refresh({ silent: true });');
    expect(hookSource).not.toContain(
      'ozonSnapshotManualRefreshAt.set(manualRefreshCooldownKey, Date.now());\\n    }\\n    refresh({ silent: true });'
    );
    expect(hookSource).not.toContain('window.setInterval');
    expect(hookSource).not.toContain('OZON_ORDER_SYNC_INTERVAL_MS');
    expect(hookSource).not.toContain('autoRefresh');
  });

  it('can invalidate stale local-first rows when a page snapshot identity changes', () => {
    const appSource = readAppSource();
    const hookStart = appSource.indexOf('function useOzonRealtimeSnapshot');
    const hookEnd = appSource.indexOf('function firstMarketingValue', hookStart);
    const hookSource = appSource.slice(hookStart, hookEnd);

    expect(hookSource).toContain(
      'const invalidateOnSnapshotKeyChange = options.invalidateOnSnapshotKeyChange === true;'
    );
    expect(hookSource).toContain(
      'const snapshotIdentityKey = options.snapshotIdentityKey || localDataSnapshotKey || cacheKey || inFlightKey;'
    );
    expect(hookSource).toContain('const snapshotIdentityRef = React.useRef(snapshotIdentityKey);');
    expect(hookSource).toContain('if (snapshotIdentityRef.current === snapshotIdentityKey) return undefined;');
    expect(hookSource).not.toContain('snapshotDataRef.current = null;');
    expect(hookSource).toContain('requestGenerationRef.current += 1;');
    expect(hookSource).toContain('requestAbortRef.current?.abort();');
    expect(hookSource).toContain('setSnapshot((current) => ({');
    expect(hookSource).toContain('refreshing: Boolean(current.data)');
    expect(hookSource).toContain('hasLoaded: Boolean(current.hasLoaded || current.data)');
    expect(appSource).toContain('snapshotIdentityKey: afterSalesCanonicalScopeKey');
    expect(appSource).toContain('invalidateOnSnapshotKeyChange: true');
  });

  it('drops aborted stale in-flight requests instead of reusing them for the next refresh', () => {
    const appSource = readAppSource();
    const hookStart = appSource.indexOf('function useOzonRealtimeSnapshot');
    const hookEnd = appSource.indexOf('function firstMarketingValue', hookStart);
    const hookSource = appSource.slice(hookStart, hookEnd);

    expect(hookSource).toContain('const requestInFlightRef = React.useRef(null);');
    expect(hookSource).toContain(
      'const existingSharedRequest = !force && !localOnly ? ozonSnapshotInFlight.get(inFlightKey) : null;'
    );
    expect(hookSource).toContain('if (force) {');
    expect(hookSource).toContain('const previousRequest = requestInFlightRef.current;');
    expect(hookSource).toContain('requestAbortRef.current?.abort();');
    expect(hookSource).toContain('if (previousRequest && ozonSnapshotInFlight.get(inFlightKey) === previousRequest)');
    expect(hookSource).toContain('ozonSnapshotInFlight.delete(inFlightKey);');
    expect(hookSource).toContain(
      'const existingRequest = existingSharedRequest || (force ? null : ozonSnapshotInFlight.get(inFlightKey));'
    );
    expect(hookSource).toContain('requestInFlightRef.current = requestPromise;');
    expect(hookSource).toContain('if (requestInFlightRef.current === requestPromise)');
  });

  it('rechecks request generation after local merge writes before updating state', () => {
    const appSource = readAppSource();
    const hookStart = appSource.indexOf('function useOzonRealtimeSnapshot');
    const hookEnd = appSource.indexOf('function firstMarketingValue', hookStart);
    const hookSource = appSource.slice(hookStart, hookEnd);
    const remoteWriteStart = hookSource.indexOf('prepareLocalSnapshot(data, {');
    const stateUpdateStart = hookSource.indexOf('setSnapshot({', remoteWriteStart);
    const remoteWriteSource = hookSource.slice(remoteWriteStart, stateUpdateStart);

    expect(remoteWriteStart).toBeGreaterThan(-1);
    expect(stateUpdateStart).toBeGreaterThan(remoteWriteStart);
    expect(remoteWriteSource).toContain('if (!isCurrentRequest()) return;');
  });

  it('keeps a successful loader result authoritative instead of replacing it with a stale local reread', () => {
    const appSource = readAppSource();
    const hookStart = appSource.indexOf('function useOzonRealtimeSnapshot');
    const hookEnd = appSource.indexOf('function firstMarketingValue', hookStart);
    const hookSource = appSource.slice(hookStart, hookEnd);

    expect(appSource).toContain('OZON_POST_LOAD_LOCAL_REREAD_FROZEN = true');
    expect(hookSource).toContain('let displayData = data;');
    expect(hookSource).toContain('if (!OZON_POST_LOAD_LOCAL_REREAD_FROZEN)');
    expect(hookSource).toContain('本地快照写入失败，已继续使用本次读取到的新数据');
  });

  it('keeps order pages local-first while the profit page uses only the canonical SQLite runtime', () => {
    const appSource = readAppSource();
    const snapshotCalls = [...appSource.matchAll(/useOzonRealtimeSnapshot\([\s\S]*?\}\);/g)].map((match) => match[0]);
    const orderLikeCalls = snapshotCalls.filter((call) =>
      /request(?:Ozon(?:AfterSales|SalesOrders|ProfitFull)Snapshot|PurchaseOrdersPreciseSnapshot)/.test(call)
    );

    expect(orderLikeCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of orderLikeCalls) {
      expect(call).not.toContain('autoRefresh');
      if (call.includes('requestOzonProfitFullSnapshotForShops')) {
        expect(call).toContain('refreshOnMount: false');
        expect(call).toContain('invalidateOnSnapshotKeyChange: true');
        expect(appSource).toContain('reloadProfitSnapshot({ silent: true });');
        expect(call).not.toContain('localDataSnapshotKey:');
        expect(call).not.toContain('prepareLocalSnapshot:');
        expect(appSource).not.toContain('profitLegacyOrderSnapshotOptions');
        expect(appSource).not.toContain('LEGACY_JSON_ORDER_SNAPSHOT_RUNTIME');
      } else if (call.includes('requestPurchaseOrdersPreciseSnapshotForShops')) {
        expect(call).toContain('refreshOnMount: true');
        expect(call).toContain('keepCurrentDataOnForceRefresh: true');
        expect(call).toContain('manualRefreshCooldownMs: 5000');
        expect(call).toContain('preciseSync: true');
        expect(call).not.toContain('localDataFileKey:');
        expect(call).not.toContain('localDataSnapshotKey:');
        expect(call).not.toContain('prepareLocalSnapshot:');
      } else if (call.includes('cacheGroup: salesOrderSnapshotGroup')) {
        expect(call).toContain('refreshOnMount: true');
        expect(call).toContain('refreshOnLocalHit: true');
        expect(call).toContain('preferLocalDataOnCacheHit: true');
        expect(call).toContain('keepCurrentDataOnForceRefresh: true');
        expect(call).toContain('manualRefreshCooldownMs: 5000');
      } else if (call.includes('requestOzonAfterSalesSnapshotForShops')) {
        expect(call).toContain('refreshOnMount: true');
        expect(call).toContain('keepCurrentDataOnForceRefresh: true');
        expect(call).toContain('manualRefreshCooldownMs: 5000');
        expect(call).toContain('loaderOptions: afterSalesLoaderOptions');
        expect(call).toContain('snapshotIdentityKey: afterSalesCanonicalScopeKey');
        expect(call).toContain('invalidateOnSnapshotKeyChange: true');
        expect(call).not.toContain('localDataFileKey:');
        expect(call).not.toContain('localDataSnapshotKey:');
      } else {
        expect(call).not.toContain('refreshOnMount');
        expect(call).toContain('refreshOnLocalHit: false');
      }
      if (!call.includes('requestOzonProfitFullSnapshotForShops') && !call.includes('requestOzonAfterSalesSnapshotForShops') && !call.includes('requestPurchaseOrdersPreciseSnapshotForShops')) {
        expect(call).toContain('localDataFileKey: LOCAL_OZON_DATA_LAYER_FILE_KEY');
      }
      if (call.includes('requestOzonAfterSalesSnapshotForShops')) {
        expect(appSource).toContain('dateRange: afterSalesTimeScope.apiRange');
        expect(appSource).toContain('timeScope: afterSalesTimeScope');
      } else {
        expect(call).toContain('dateRange:');
        expect(call).toContain('timeScope:');
      }
    }

    const salesPagedState = readProjectSource('src/features/orders/sales/model/useSalesOrderPagedCacheState.jsx');
    const salesCacheClient = readProjectSource('src/services/salesOrderPagedCacheClient.js');
    expect(salesPagedState).toContain('readSalesOrderPagedCache(queryOverride || queryInput');
    expect(salesPagedState).toContain("startDomainRefresh('orders'");
    expect(salesCacheClient).toContain("getDomainCache('orders'");
    const preciseLoader = readProjectSource('src/features/orders/purchase/services/purchaseOrderPreciseSyncService.js');
    expect(preciseLoader).toContain('if (options.forceRefresh !== true || options.preciseSync === false)');
    expect(preciseLoader).toContain('const snapshot = await readAllSalesOrderPagedCache({');
  });

  it('does not keep deprecated automatic snapshot refresh constants or session markers', () => {
    const appSource = readAppSource();

    expect(appSource).not.toContain('OZON_ORDER_SYNC_INTERVAL_MS');
    expect(appSource).not.toContain('ozonSnapshotSessionAutoRefreshAt');
    expect(appSource).not.toContain('PURCHASE_ORDER_AUTO_SYNC_COOLDOWN_MS');
  });

  it('keeps sales and purchase visible-row supplements local-only instead of remote prefetching on page changes', () => {
    const appSource = readAppSource();
    const salesStart = appSource.indexOf('function SalesOrdersPage');
    const purchaseStart = appSource.indexOf('function PurchaseOrdersPage', salesStart);
    const marketingStart = appSource.indexOf('function MarketingActivityPage', purchaseStart);
    const salesSource = appSource.slice(salesStart, purchaseStart);
    const purchaseSource = appSource.slice(purchaseStart, marketingStart);

    expect(salesSource).toContain('readOzonLocalProductEntityRows(');
    expect(purchaseSource).toContain('readOzonLocalProductEntityRows(');
    expect(salesSource).not.toContain('enrichPurchaseRowsWithOzonImagesForShops(readableShops');
    expect(salesSource).not.toContain('enrichSalesRowsWithVisibleCommissionsForShops(readableShops');
    expect(salesSource).not.toContain('salesImagePrefetchKeysRef');
    expect(salesSource).not.toContain('nextSalesOrderPageRows');
    expect(purchaseSource).not.toContain('enrichPurchaseRowsWithOzonImagesForShops(readableShops');
    expect(purchaseSource).not.toContain('enrichSalesRowsWithVisibleCommissionsForShops(readableShops');
    expect(purchaseSource).not.toContain('purchaseImagePrefetchKeysRef');
    expect(purchaseSource).not.toContain('nextPurchaseOrderPageRows');
    expect(appSource).not.toContain('hasOzonOrderSupplementImageCache');
    expect(readOrderExperienceSource()).not.toContain('hasOzonOrderSupplementCache');
  });
});
