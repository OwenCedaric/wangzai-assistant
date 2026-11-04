import assert from 'node:assert/strict';
import test from 'node:test';
import { readAlibaba1688SourceRecord } from './alibaba1688SourceReader.js';

test('1688 source reader returns the canonical detail URL without mutating order evidence', () => {
  const capture = {
    sourceProductId: '923805736089',
    sourceUrl: 'https://detail.1688.com/offer/923805736089.html?spm=a2615.7691456',
    productTitle: '花架',
    quantity: 1,
    purchasePrice: 38.6,
  };
  const before = structuredClone(capture);

  const result = readAlibaba1688SourceRecord(capture);

  assert.deepEqual(capture, before);
  assert.equal(result.sourceProductId, '923805736089');
  assert.equal(result.sourceUrl, 'https://detail.1688.com/offer/923805736089.html');
  assert.equal(result.sourceMethod, '1688-source-reader');
  assert.equal(result.sourceConfidence, 1);
  assert.equal(Object.isFrozen(result), true);
});

test('1688 source reader extracts offer id from a trusted mobile query URL', () => {
  const result = readAlibaba1688SourceRecord({
    sourceUrl: 'https://m.1688.com/offer/detail.html?offerId=7788990011',
  });

  assert.equal(result.sourceProductId, '7788990011');
  assert.equal(result.sourceUrl, 'https://detail.1688.com/offer/7788990011.html');
});

test('1688 source reader rejects conflicting order-line and URL offer identities', () => {
  assert.throws(
    () => readAlibaba1688SourceRecord({
      sourceProductId: '7788990011',
      sourceUrl: 'https://detail.1688.com/offer/1111000011.html',
    }),
    (error) => error.code === 'PURCHASE_BROWSER_1688_ORDER_NOT_FOUND',
  );
});

test('1688 source reader rejects non-1688 and non-product URLs', () => {
  for (const sourceUrl of [
    'https://1688.com.evil.invalid/offer/7788990011.html',
    'https://trade.1688.com/order/buyer_order_list.htm',
  ]) {
    assert.throws(
      () => readAlibaba1688SourceRecord({ sourceUrl }),
      (error) => error.code === 'PURCHASE_BROWSER_1688_ORDER_NOT_FOUND',
    );
  }
});

test('1688 source reader can build a canonical URL from a verified numeric offer id', () => {
  const result = readAlibaba1688SourceRecord({ sourceProductId: '7788990011' });
  assert.equal(result.sourceUrl, 'https://detail.1688.com/offer/7788990011.html');
});
