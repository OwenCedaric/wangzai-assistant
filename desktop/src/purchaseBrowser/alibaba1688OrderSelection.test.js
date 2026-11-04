import assert from 'node:assert/strict';
import test from 'node:test';
import {
  purchaseTitleSimilarity,
  selectAlibaba1688OrderCandidate,
} from './alibaba1688OrderSelection.js';

test('1688 candidate matching prefers exact offer id and never takes the first visible row', () => {
  const selected = selectAlibaba1688OrderCandidate({
    pageUrl: 'https://trade.1688.com/order/buyer_order_list.htm',
    orderCandidates: [
      {
        purchaseOrderNumber: '3316000000000000001',
        sourceUrl: 'https://detail.1688.com/offer/111.html',
        sourceProductId: '111',
        productTitle: '其他产品',
      },
      {
        purchaseOrderNumber: '3316000000000000002',
        sourceUrl: 'https://detail.1688.com/offer/778899.html',
        sourceProductId: '778899',
        productTitle: '现代简约落地式铁艺花盆支架',
        purchasePrice: 38.6,
      },
    ],
  }, {
    expectedSourceUrl: 'https://detail.1688.com/offer/778899.html?spm=a260k',
    targetProductTitle: '现代简约落地式铁艺花盆支架',
  });

  assert.equal(selected.purchaseOrderNumber, '3316000000000000002');
  assert.equal(selected.purchasePrice, 38.6);
});

test('1688 status refresh matches only the already bound order number', () => {
  const selected = selectAlibaba1688OrderCandidate({
    orderCandidates: [
      { purchaseOrderNumber: '3316000000000000001', purchaseOrderStatus: '待发货' },
      { purchaseOrderNumber: '3316000000000000002', purchaseOrderStatus: '已发货' },
    ],
  }, { expectedOrderNumber: '3316000000000000002' });

  assert.equal(selected.purchaseOrderNumber, '3316000000000000002');
  assert.equal(selected.purchaseOrderStatus, '已发货');
});

test('1688 title similarity supports shortened Chinese order titles', () => {
  assert.ok(purchaseTitleSimilarity(
    '现代简约落地式铁艺花盆支架可移动拼装型多层室内外花盆收纳架',
    '现代简约落地式铁艺花盆支架',
  ) >= 0.5);
});

test('1688 title similarity matches the real reordered flower-rack order title', () => {
  assert.ok(purchaseTitleSimilarity(
    '现代简约落地式铁艺花盆支架可移动拼装型多层室内外花盆收纳架',
    '花架室内置物架铁艺多层带轮落地式绿萝花盆架家用客厅阳台花架',
  ) >= 0.5);
});

test('1688 candidate matching fails closed when two rows are equally plausible', () => {
  assert.throws(
    () => selectAlibaba1688OrderCandidate({
      orderCandidates: [
        { purchaseOrderNumber: '3316000000000000001', productTitle: '相同标题花盆架' },
        { purchaseOrderNumber: '3316000000000000002', productTitle: '相同标题花盆架' },
      ],
    }, { targetProductTitle: '相同标题花盆架' }),
    (error) => error.code === 'PURCHASE_BROWSER_1688_ORDER_AMBIGUOUS',
  );
});
