import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTaobaoResults, normalize1688SearchResult } from './search-parsers.mjs';

test('normalizes a 1688 image-search item including list metrics', () => {
  const result = normalize1688SearchResult({
    data: {
      offerId: '123456789',
      title: '汽车中控防滑垫',
      afterPriceList: [
        { matKey: 'saleQuantity', text: '已售 120 件' },
        { matKey: 'quantity', text: '2 件起批' },
      ],
    },
  });

  assert.equal(result.offerId, '123456789');
  assert.equal(result.title, '汽车中控防滑垫');
  assert.equal(result.sales, '已售 120 件');
  assert.equal(result.minOrder, '2 件起批');
});

test('extracts a visible Taobao item title without runtime reference errors', () => {
  const results = extractTaobaoResults(
    '<script>{"nid":"7654321","raw_title":"汽车中控防滑垫","view_price":"19.90"}</script>',
    'https://s.taobao.com/search',
  );

  assert.equal(results[0]?.title, '汽车中控防滑垫');
});
