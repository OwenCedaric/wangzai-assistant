import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../test/appSource';

function readProjectFile(relativePath) {
  return readProjectSource(relativePath);
}

function getFunctionBlock(source, functionName, nextFunctionName) {
  const start = source.indexOf(`function ${functionName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = nextFunctionName ? source.indexOf(`\nfunction ${nextFunctionName}`, start) : -1;
  return source.slice(start, end > start ? end : undefined);
}

function getConstBlock(source, constName, nextConstName) {
  const start = source.indexOf(`const ${constName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = nextConstName ? source.indexOf(`\n  const ${nextConstName}`, start) : -1;
  return source.slice(start, end > start ? end : undefined);
}

describe('sales order write feedback rules', () => {
  it('uses local-api writeStatus/readBack copy instead of generic completed copy', () => {
    const marketingOrderFields = readProjectFile('src/entities/marketing/marketingOrderFields.jsx');
    const salesOperationState = readProjectFile('src/features/orders/sales/model/useSalesOrderOperationState.jsx');
    const salesPageView = readProjectFile('src/features/orders/sales/view/SalesOrdersPageView.jsx');
    const noticeBuilder = getFunctionBlock(
      marketingOrderFields,
      'buildSalesOperationNoticeMessage',
      'buildSalesOperationPartialNoticeMessage'
    );
    const partialNoticeBuilder = getFunctionBlock(marketingOrderFields, 'buildSalesOperationPartialNoticeMessage');

    expect(marketingOrderFields).toMatch(/localApiWrite\?\.message/u);
    expect(noticeBuilder).toMatch(/submitted_waiting_readback/u);
    expect(noticeBuilder).toMatch(/readback_merged/u);
    expect(noticeBuilder).toMatch(/\u7b49\u5f85\u56de\u8bfb/u);
    expect(noticeBuilder).toMatch(/SQLite \u5df2\u5408\u5e76/u);
    expect(salesOperationState).toMatch(/buildSalesOperationNoticeMessage\('\u53d6\u6d88\u8ba2\u5355'/u);
    expect(salesOperationState).toMatch(/buildSalesOperationNoticeMessage\('\u786e\u8ba4\u53d1\u8d27'/u);
    expect(salesOperationState).toMatch(/buildSalesOperationNoticeMessage\('\u62c6\u89e3\u8ba2\u5355'/u);
    expect(salesOperationState).not.toContain('\u5df2\u63d0\u4ea4\u5230 Ozon\u3002');
    expect(salesPageView).toContain('salesNotice.message');
    expect(partialNoticeBuilder).toContain('\u90e8\u5206\u7ed3\u679c');
    expect(partialNoticeBuilder).not.toContain('\u90e8\u5206\u5df2\u5904\u7406');
  });

  it('keeps sales order actions on the local-api write guard with real Ozon submit enabled', () => {
    const marketingOrderFields = readProjectFile('src/entities/marketing/marketingOrderFields.jsx');
    const protectedWrite = getFunctionBlock(
      marketingOrderFields,
      'requestProtectedOzonOrderOperation',
      'getSalesPostingNumber'
    );

    expect(protectedWrite).toContain('requestOrderWriteOperation');
    expect(protectedWrite).toContain('realWrite: true');
    expect(protectedWrite).toContain('dryRun: false');
    expect(protectedWrite).toContain('waitForResult: true');
    expect(protectedWrite).not.toContain('requestOzonWrite(');
    expect(protectedWrite).not.toContain('/api/' + 'ozon/request');
  });

  it('uses stable returns identifiers when building Ozon order write idempotency references', () => {
    const marketingOrderFields = readProjectFile('src/entities/marketing/marketingOrderFields.jsx');
    const referenceBuilder = getFunctionBlock(
      marketingOrderFields,
      'getOzonOrderWriteReference',
      'requestProtectedOzonOrderOperation'
    );

    expect(referenceBuilder).toContain('body?.return_id');
    expect(referenceBuilder).toContain('body?.returnId');
    expect(referenceBuilder).toContain('body?.cancellation_id');
    expect(referenceBuilder).toContain('body?.cancellationId');
    expect(referenceBuilder.indexOf('body?.return_id')).toBeLessThan(referenceBuilder.indexOf('body?.id'));
  });

  it('keeps batch operations from acting on split parent orders', () => {
    const filtersPaginationState = readProjectFile(
      'src/features/orders/sales/model/useSalesOrderFiltersPaginationState.jsx'
    );
    const cancellable = getConstBlock(filtersPaginationState, 'selectedCancellableOrders', 'selectedShippableOrders');
    const shippable = getConstBlock(filtersPaginationState, 'selectedShippableOrders', 'handleRefreshSalesOrders');

    expect(cancellable).toMatch(/!isSplitParentBusinessLocked\(order\)/u);
    expect(shippable).toMatch(/!isSplitParentBusinessLocked\(order\)/u);
  });

  it('wires the top logistics sync button to the dedicated sync workflow', () => {
    const salesPage = readProjectFile('src/features/orders/sales/view/SalesOrdersPageView.jsx');

    expect(salesPage).toMatch(
      /startIcon=\{<SyncRounded \/>\}\s*onClick=\{handleSyncLogistics\}[\s\S]*?\{logisticsSync\.running \? '\u540c\u6b65\u4e2d' : '\u540c\u6b65\u7269\u6d41'\}/u
    );
    expect(salesPage).not.toContain('\u9ad8\u7ea7\u7b5b\u9009');
  });
  it('surfaces split parent lock reason in the sales detail panel', () => {
    const salesOperationState = readProjectFile('src/features/orders/sales/model/useSalesOrderOperationState.jsx');
    const salesPageModel = readProjectFile('src/features/orders/sales/model/useSalesOrdersPageModel.jsx');
    const salesPageView = readProjectFile('src/features/orders/sales/view/SalesOrdersPageView.jsx');

    expect(salesOperationState).toContain('detailSplitLocked');
    expect(salesOperationState).toContain('detailSplitLockReason');
    expect(salesOperationState).toContain('!detailSplitLocked');
    expect(salesPageModel).toContain('detailSplitLocked');
    expect(salesPageModel).toContain('detailSplitLockReason');
    expect(salesPageView).toContain('detailSplitLocked');
    expect(salesPageView).toContain('detailSplitLockReason');
    expect(salesPageView).toContain('sales-split-lock-alert');
    expect(salesPageView).toContain('该拆单父单未在 Ozon 当前回读中确认，仅保留只读展示。');
  });

  it('persists TEST-SPLIT simulated children through local-api SQLite before refreshing the list', () => {
    const marketingRuntime = readProjectFile('src/entities/marketing/marketingSnapshotRuntime.jsx');
    const localApiClient = readProjectFile('src/api/localApiClient.js');

    expect(marketingRuntime).toContain('simulateOrderTestSplit');
    expect(marketingRuntime).toContain('splitQuantities: quantities');
    expect(localApiClient).toContain('/api/orders/test-split-simulation');
  });
});
