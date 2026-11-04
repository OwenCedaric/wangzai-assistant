import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizePurchaseOrderWorkbench } from './purchaseOrderWorkbench.js';

test('purchase workbench sanitizer keeps the fixed test-order fields and drops unknown input', () => {
  const result = sanitizePurchaseOrderWorkbench({
    kind: 'purchase-order',
    displayMode: 'embedded',
    title: '订单操作台',
    order: { orderNo: 'WORKBENCH-TEST-1', shop: '测试店铺', secret: 'drop-me' },
    product: { title: '测试商品', sku: 'WB-SKU-1', quantity: 'x1' },
    source: { platform: 'PDD', amount: '¥18.80', url: 'https://mobile.yangkeduo.com/' },
    logistics: { orderId: 'TEST-ORDER-ID', weight: '0.35 kg' },
    profitItems: [{ label: '利润', value: '+ ¥8.20', tone: 'profit', secret: 'drop-me' }],
    unknown: 'drop-me',
  });
  assert.equal(result.order.orderNo, 'WORKBENCH-TEST-1');
  assert.equal(result.displayMode, 'embedded');
  assert.equal(result.source.url, 'https://mobile.yangkeduo.com/');
  assert.deepEqual(result.profitItems, [{ label: '利润', value: '+ ¥8.20', tone: 'profit' }]);
  assert.equal('secret' in result.order, false);
  assert.equal('unknown' in result, false);
});

test('purchase workbench sanitizer rejects unrelated payloads', () => {
  assert.equal(sanitizePurchaseOrderWorkbench(null), null);
  assert.equal(sanitizePurchaseOrderWorkbench({ kind: 'other' }), null);
});

test('purchase workbench sanitizer keeps profit and after-sales sidebar contracts without unknown fields', () => {
  const profit = sanitizePurchaseOrderWorkbench({
    kind: 'purchase-order',
    sidebarKind: 'profit',
    subtitle: '利润核算卡片',
    browserLabel: 'Ozon 商品页',
    profit: {
      actualProfit: '+￥18.00',
      actualProfitTone: 'profit',
      estimateItems: [{ label: '预估利润', value: '+￥20.00', hint: '真实台账' }],
      actualFeeItems: [{ label: '物流扣费', value: '￥4.00' }],
      secret: 'drop-me',
    },
  });
  assert.equal(profit.sidebarKind, 'profit');
  assert.equal(profit.subtitle, '利润核算卡片');
  assert.equal(profit.profit.actualProfit, '+￥18.00');
  assert.deepEqual(profit.profit.estimateItems, [{
    label: '预估利润', value: '+￥20.00', tone: '', hint: '真实台账',
  }]);
  assert.equal('secret' in profit.profit, false);

  const afterSales = sanitizePurchaseOrderWorkbench({
    kind: 'purchase-order',
    sidebarKind: 'after-sales',
    afterSales: {
      originalOrderNo: 'ORDER-1',
      afterSalesId: 'AFTER-1',
      refundAmount: '￥16.00',
      reason: '买家拒收',
      secret: 'drop-me',
    },
  });
  assert.equal(afterSales.sidebarKind, 'after-sales');
  assert.equal(afterSales.afterSales.afterSalesId, 'AFTER-1');
  assert.equal(afterSales.afterSales.reason, '买家拒收');
  assert.equal('secret' in afterSales.afterSales, false);
});
