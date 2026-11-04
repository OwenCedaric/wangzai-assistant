import assert from 'node:assert/strict';
import test from 'node:test';
import { createPurchaseBrowserPolicy } from './purchaseBrowserPolicy.js';

test('purchase browser navigation allows approved web origins and rejects protocols, credentials, and lookalikes', () => {
  const policy = createPurchaseBrowserPolicy({ fixtureOrigins: ['http://127.0.0.1:49152'] });
  for (const url of [
    'https://detail.1688.com/offer/123.html',
    'https://login.alibaba.com/',
    'https://auth.alipay.com/',
    'https://item.taobao.com/item.htm?id=123',
    'https://mobile.yangkeduo.com/goods.html?goods_id=123',
    'https://www.ozon.ru/product/123',
    'http://127.0.0.1:49152/purchase-fixture',
  ]) {
    assert.equal(policy.classifyUrl(url).allowed, true, url);
  }
  for (const url of [
    'http://detail.1688.com/offer/123.html',
    'https://1688.com.evil.invalid/',
    'https://user:password@detail.1688.com/',
    'file:///C:/secret.txt',
    'javascript:alert(1)',
    'http://127.0.0.1:49153/purchase-fixture',
  ]) {
    assert.equal(policy.classifyUrl(url).allowed, false, url);
  }
});

test('production global-link policy allows ordinary HTTP inside CEF without permissions', () => {
  const policy = createPurchaseBrowserPolicy({ allowHttpNavigation: true });
  assert.equal(policy.classifyUrl('http://example.com/help').allowed, true);
  assert.equal(policy.classifyUrl('http://example.com/help').kind, 'external-site');
  assert.equal(policy.canRequestPermission('storage-access', 'http://example.com/help', {}), false);
});
test('purchase browser permissions and downloads default deny', () => {
  const policy = createPurchaseBrowserPolicy({ fixtureOrigins: ['http://127.0.0.1:49152'] });
  const origin = 'https://detail.1688.com';
  assert.equal(policy.canRequestPermission('notifications', origin, {}), false);
  assert.equal(policy.canRequestPermission('media', origin, {}), false);
  assert.equal(policy.canRequestPermission('geolocation', origin, { geolocation: { mode: 'deny' } }), false);
  assert.equal(policy.canRequestPermission('geolocation', origin, { geolocation: { mode: 'fixed' } }), true);
  assert.equal(policy.canRequestPermission('fullscreen', origin, {}), true);
  assert.equal(policy.canRequestPermission('storage-access', origin, {}), true);
  assert.equal(policy.canRequestPermission('top-level-storage-access', origin, {}), true);
  assert.equal(policy.canRequestPermission('storage-access', 'https://evil.invalid', {}), false);
  assert.equal(policy.canDownload({ url: 'https://detail.1688.com/file.pdf' }), false);
  assert.equal(policy.canDownload({ url: 'https://detail.1688.com/file.pdf', userApproved: true }), true);
  assert.equal(policy.canDownload({ url: 'https://evil.invalid/file.pdf', userApproved: true }), false);
});

