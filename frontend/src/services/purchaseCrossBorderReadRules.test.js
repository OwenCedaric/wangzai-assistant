import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasCompleteCrossBorderCoreInfo,
  shouldAutoReadPurchaseCrossBorder,
} from '../features/orders/purchase/model/usePurchaseCrossBorderAutoReadState.jsx';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const mainSource = readFileSync(join(process.cwd(), 'src', 'main.jsx'), 'utf8');
const purchaseOrdersPageViewSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'orders', 'purchase', 'view', 'PurchaseOrdersPageView.jsx'),
  'utf8'
);
const purchaseCrossBorderRuntimeSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'purchaseCrossBorderRuntime.js'),
  'utf8'
);

function getReadCrossBorderForOrderSource() {
  const start = appSource.indexOf('const readCrossBorderForOrder = React.useCallback');
  const end = appSource.indexOf('const handleBatchReadCrossBorder = React.useCallback', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return appSource.slice(start, end);
}

describe('purchase cross-border read rules', () => {
  const readSource = getReadCrossBorderForOrderSource();

  it('drops stale cross-border responses by lookup key before updating row state', () => {
    expect(readSource.match(/currentEntry\.lookupKey && currentEntry\.lookupKey !== lookupKey/g)).toHaveLength(2);
    expect(readSource).toContain('if (currentEntry.lookupKey && currentEntry.lookupKey !== lookupKey) return current;');
  });

  it('does not clear existing cross-border volume data when a retry fails', () => {
    const catchStart = readSource.indexOf('} catch (error) {');
    expect(catchStart).toBeGreaterThanOrEqual(0);
    const catchSource = readSource.slice(catchStart);

    expect(catchSource).not.toContain('volumeItems: []');
    expect(catchSource).not.toContain("message: ''");
    expect(catchSource).toContain('...stableCurrentEntry,');
    expect(catchSource).toContain('error: friendlyError');
  });

  it('restores the previous cross-border status text when a retry fails', () => {
    const catchStart = readSource.indexOf('} catch (error) {');
    expect(catchStart).toBeGreaterThanOrEqual(0);
    const catchSource = readSource.slice(catchStart);

    expect(readSource).toContain('previousMessage: current[order.id]?.message ||');
    expect(readSource).toContain('previousReadStatus: current[order.id]?.readStatus ||');
    expect(readSource.match(/delete stableCurrentEntry\.previousMessage/g)).toHaveLength(2);
    expect(readSource.match(/delete stableCurrentEntry\.previousReadStatus/g)).toHaveLength(2);
    expect(catchSource).toContain("message: previousMessage || '读取失败'");
    expect(catchSource).toContain('readStatus: previousReadStatus || currentEntry.readStatus');
  });

  it('reuses the shared cross-border order cache key matcher before remote search', () => {
    const localSearchStart = appSource.indexOf('async function requestLocalCrossBorderOrderSearch');
    const remoteSearchStart = appSource.indexOf('async function requestCrossBorderOrderSearch', localSearchStart);
    const localSearchSource = appSource.slice(localSearchStart, remoteSearchStart);
    const remoteSearchSource = appSource.slice(
      remoteSearchStart,
      appSource.indexOf('function getCrossBorderOrderSearchBodyVariants', remoteSearchStart)
    );

    expect(appSource).toContain('areCrossBorderOrderCacheKeysEquivalent');
    expect(localSearchSource).toContain('areCrossBorderOrderCacheKeysEquivalent(value, key)');
    expect(remoteSearchSource).toContain(
      'const localResult = await requestLocalCrossBorderOrderSearch(searchBody, scope);'
    );
    expect(remoteSearchSource).toContain('if (localResult?.items?.length) {');
    expect(remoteSearchSource).toContain('return localResult;');
  });

  it('scopes purchase-order cache lookups by internal shop id and client id', () => {
    expect(purchaseCrossBorderRuntimeSource).toContain(
      'const shopId = normalizeOzonId(order.shopId ?? order.shop_id).trim();'
    );
    expect(purchaseCrossBorderRuntimeSource).toContain('const shopScope = { shopId, shopClientId };');
    expect(purchaseCrossBorderRuntimeSource).toContain(
      'requestCrossBorderOrderSearch(settings, { order_id: existingOrderId }, shopScope)'
    );
    expect(purchaseCrossBorderRuntimeSource).toContain(
      'requestCrossBorderOrderSearch(settings, { [field]: key }, shopScope)'
    );
    const findStart = purchaseCrossBorderRuntimeSource.indexOf('export async function findPurchaseCrossBorderOrders');
    const findEnd = purchaseCrossBorderRuntimeSource.indexOf('export async function requestPurchaseCrossBorderDetail', findStart);
    const findSource = purchaseCrossBorderRuntimeSource.slice(findStart, findEnd);
    expect(findSource).toContain("{ field: 'order_number', key: orderKey }");
    expect(findSource).toContain("{ field: 'platform_order', key: orderKey }");
    expect(findSource).toContain("{ field: 'from_order', key: purchaseOrderKey }");
    expect(findSource).not.toContain("'sheet_order_sn'");
    expect(findSource).not.toContain("'logistics_order'");
    expect(findSource).not.toContain('for (const key of keys)');
  });

  it('routes cross-border order reads through local-api read client instead of the old remote proxy', () => {
    const readOnlyStart = appSource.indexOf('async function requestCrossBorderReadOnly');
    const readOnlyEnd = appSource.indexOf('function canUseCrossBorderOrderWrite', readOnlyStart);
    expect(readOnlyStart).toBeGreaterThanOrEqual(0);
    expect(readOnlyEnd).toBeGreaterThan(readOnlyStart);
    const readOnlySource = appSource.slice(readOnlyStart, readOnlyEnd);

    expect(appSource).toContain("from './services/crossBorderReadClient'");
    expect(appSource).toContain("from './services/crossBorderAccountClient'");
    expect(readOnlySource).toContain('readCrossBorderEndpoint({');
    expect(readOnlySource).toContain('legacyEndpoint: endpoint');
    expect(readOnlySource).not.toContain('requestCrossBorderApi(endpoint');
    expect(readOnlySource).not.toContain('CROSS_BORDER_API_BASE');
  });

  it('uses SQLite as the only cross-border order-record cache after retiring the old local file fallback', () => {
    const readStart = appSource.indexOf('async function readLocalCrossBorderOrderRecords');
    const mergeStart = appSource.indexOf('async function mergeLocalCrossBorderOrderRecords', readStart);
    const nextStart = appSource.indexOf('async function requestLocalCrossBorderOrderSearch', mergeStart);
    expect(readStart).toBeGreaterThanOrEqual(0);
    expect(mergeStart).toBeGreaterThan(readStart);
    expect(nextStart).toBeGreaterThan(mergeStart);
    const readSource = appSource.slice(readStart, mergeStart);
    const mergeSource = appSource.slice(mergeStart, nextStart);

    expect(appSource).toContain("from './services/crossBorderOrderRecordClient'");
    expect(readSource).toContain('readCrossBorderRecords({');
    expect(readSource).not.toContain('readLocalDataFile(LOCAL_CROSS_BORDER_ORDER_RECORDS_FILE_KEY)');
    expect(mergeSource).toContain('saveCrossBorderRecords(freshRecords');
    expect(mergeSource).not.toContain('writeLocalDataFile(LOCAL_CROSS_BORDER_ORDER_RECORDS_FILE_KEY');
  });

  it('runs cross-border reads through the purchase background regulator without blocking the page', () => {
    const modelSource = readFileSync(
      join(process.cwd(), 'src', 'features', 'orders', 'purchase', 'model', 'usePurchaseOrdersPageModel.jsx'),
      'utf8'
    );
    const autoReadSource = readFileSync(
      join(process.cwd(), 'src', 'features', 'orders', 'purchase', 'model', 'usePurchaseCrossBorderAutoReadState.jsx'),
      'utf8'
    );

    expect(modelSource).toContain('usePurchaseCrossBorderAutoReadState({');
    expect(modelSource).toContain('onOrderNotifications');
    expect(autoReadSource).toContain('const PURCHASE_CROSS_BORDER_AUTO_READ_INTERVAL_MS = 2 * 60 * 1000');
    expect(autoReadSource).toContain('const PURCHASE_CROSS_BORDER_AUTO_READ_BATCH_SIZE = 6');
    expect(autoReadSource).toContain('const PURCHASE_CROSS_BORDER_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000');
    expect(autoReadSource).toContain(
      'const PURCHASE_CROSS_BORDER_AUTO_READ_COOLDOWN_MS = PURCHASE_CROSS_BORDER_AUTO_READ_INTERVAL_MS'
    );
    expect(autoReadSource).toContain('shouldAutoReadPurchaseCrossBorder');
    expect(autoReadSource).toContain('readCrossBorderForOrder(order, { force: true, background: true })');
    expect(autoReadSource).toContain("domain: 'purchase'");
    expect(autoReadSource).toContain("title: '跨境巴士已回查'");
    expect(appSource).not.toContain('function getFriendlyCrossBorderOrderError');
  });

  it('keeps polling bus rows until id, weight and dimensions are all fixed', () => {
    expect(
      hasCompleteCrossBorderCoreInfo({
        packageOrderId: '49774985',
        readStatus: '已发货',
      })
    ).toBe(false);
    expect(
      hasCompleteCrossBorderCoreInfo({
        orderId: '0123640791-0163',
        packageWeight: '0.07 kg',
        packageSize: '11.8 cm x 9.5 cm x 3.1 cm',
      })
    ).toBe(false);
    expect(
      hasCompleteCrossBorderCoreInfo({
        packageOrderId: '49774985',
        packageWeight: '0.07 kg',
        packageSize: '11.8 cm x 9.5 cm x 3.1 cm',
      })
    ).toBe(true);
    expect(
      hasCompleteCrossBorderCoreInfo({
        crossBorderOrderId: '49774985',
        volumeItems: [{ grossWeight: 0.07, length: 11.8, width: 9.5, height: 3.1 }],
      })
    ).toBe(true);
  });

  it('stops background bus polling only after complete core bus material is present', () => {
    const baseOrder = {
      id: '0123640791-0163-1',
      purchaseOrderNo: '260624-284667440772967',
      status: '已拍单-已发货',
    };

    expect(
      shouldAutoReadPurchaseCrossBorder({
        ...baseOrder,
        packageOrderId: '49774985',
        readStatus: '已发货',
      })
    ).toBe(true);
    expect(
      shouldAutoReadPurchaseCrossBorder({
        ...baseOrder,
        packageOrderId: '49774985',
        packageWeight: '0.07 kg',
        packageSize: '11.8 cm x 9.5 cm x 3.1 cm',
      })
    ).toBe(false);
  });

  it('does not background-query orders that are still waiting for their first forecast', () => {
    expect(
      shouldAutoReadPurchaseCrossBorder({
        id: '0213172054-0337-1',
        purchaseOrderNo: '3316377399123004165',
        status: '已拍单-待预报',
      })
    ).toBe(false);
    expect(
      shouldAutoReadPurchaseCrossBorder({
        id: '0213172054-0337-1',
        purchaseOrderNo: '3316377399123004165',
        packageOrderId: 'bus-order-1',
        status: '已拍单-待预报',
      })
    ).toBe(true);
  });

  it('does not show cross-border writes as completed before a successful readback', () => {
    // Read the extracted production hook instead of slicing across unrelated pages.
    const hookSource = readFileSync(join(process.cwd(), 'src/features/orders/purchase/model/usePurchaseOperationExecutionState.jsx'), 'utf8');
    const operationStart = hookSource.indexOf('const executePurchaseOperation = async () => {');
    const operationEnd = hookSource.indexOf('const executePurchaseForecastAuto = async () => {', operationStart);
    expect(operationStart).toBeGreaterThanOrEqual(0);
    expect(operationEnd).toBeGreaterThan(operationStart);
    const operationSource = hookSource.slice(operationStart, operationEnd);

    expect(operationSource).toContain('const sheetReadBack = await readCrossBorderForOrder');
    expect(operationSource).toContain('const packageReadBack = await readCrossBorderForOrder');
    expect(operationSource).toContain('const cancelReadBack = await readCrossBorderForOrder');
    expect(operationSource).toContain('等待回查确认；回查未确认前不算完成');
    expect(operationSource).toContain('已提交废弃，待回查确认');
    expect(operationSource).not.toContain(
      "await readCrossBorderForOrder(operationOrder, { force: true }).catch(() => null);\n        showPurchaseNotice('跨境巴士面单已更新。', 'success');"
    );
    expect(operationSource).not.toContain(
      "await readCrossBorderForOrder(operationOrder, { force: true }).catch(() => null);\n        showPurchaseNotice('跨境巴士包裹已更新。', 'success');"
    );
    expect(operationSource).not.toContain("showPurchaseNotice('跨境巴士预报订单已废弃。', 'success');");
  });

  it('uses SQLite for interactive override writes without turning a failed save into a legacy-file success', () => {
    const saveStart = appSource.indexOf('function savePurchaseOrderLocalOverrides(overrides = {}, options = {})');
    const saveEnd = appSource.indexOf('function writePurchaseOrderLocalOverrides(overrides = {})', saveStart);
    const saveSource = appSource.slice(saveStart, saveEnd);
    expect(appSource).not.toContain('function readPurchaseOrderLocalOverridesFromBrowser()');
    expect(appSource).not.toContain('readLegacyJsonValue(PURCHASE_ORDER_LOCAL_OVERRIDE_STORAGE_KEY, {})');
    expect(saveSource).toContain('return savePurchaseOrderOverridesToLocalApi(normalizedOverrides);');
    expect(saveSource).not.toContain('if (result.failedKeys.length && options.persistFile !== false)');
    expect(saveSource).toContain('if (options.persistLocalApi === false)');
    expect(saveSource).toContain('if (options.persistFile === true)');
    expect(saveSource).not.toContain('if (options.persistFile !== false) {');
    expect(saveSource).not.toContain('window.localStorage.setItem(PURCHASE_ORDER_LOCAL_OVERRIDE_STORAGE_KEY');
    expect(mainSource).not.toContain('BROWSER_LOCAL_STORAGE_MIRROR_KEYS');
  });

  it('shows purchase reads in the shared top progress panel instead of the table progress line', () => {
    expect(purchaseOrdersPageViewSource).toContain(
      "import { ReadProgressPanel } from '../../../../shared/ui/ReadProgressPanel.jsx';"
    );
    expect(purchaseOrdersPageViewSource).toContain('ariaLabel="拍单订单读取进度"');
    expect(purchaseOrdersPageViewSource).toContain('后台正在同步 Ozon 拍单订单，当前缓存');
    expect(purchaseOrdersPageViewSource).not.toContain('<LinearProgress className="order-sync-progress"');
    expect(purchaseOrdersPageViewSource).not.toContain("from '@mui/material/LinearProgress'");
  });
});
