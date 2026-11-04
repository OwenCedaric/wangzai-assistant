import assert from 'node:assert/strict';
import test from 'node:test';
import { isBlockedPurchaseImageAddress, isLocalImageUrl } from './image-proxy.mjs';

test('keeps literal local and private image addresses blocked', () => {
  assert.equal(isLocalImageUrl('http://127.0.0.1/image.jpg'), true);
  assert.equal(isLocalImageUrl('http://192.168.1.10/image.jpg'), true);
  assert.equal(isLocalImageUrl('http://198.18.0.167/image.jpg'), true);
});

test('allows a proxy synthetic address only after resolving a public hostname', () => {
  assert.equal(isBlockedPurchaseImageAddress('198.18.0.167', 4), true);
  assert.equal(
    isBlockedPurchaseImageAddress('198.18.0.167', 4, { allowProxySynthetic: true }),
    false,
  );
  assert.equal(
    isBlockedPurchaseImageAddress('127.0.0.1', 4, { allowProxySynthetic: true }),
    true,
  );
});
