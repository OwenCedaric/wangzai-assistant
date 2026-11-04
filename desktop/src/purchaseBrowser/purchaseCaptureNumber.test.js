import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parseCaptureNumber } from './purchaseCaptureNumber.js';
import { normalizePurchaseCapture } from './adapters/purchaseCaptureRegistry.js';

const moduleText = fs.readFileSync(new URL('./purchaseCaptureNumber.js', import.meta.url), 'utf8');
const injected = vm.runInNewContext(moduleText.replaceAll('export function ', 'function ') + '\nparseCaptureNumber');
const formats = [
  ['$1,299.90', 1299.9], ['1.299,90 €', 1299.9], ['1 299,90 ₽', 1299.9], ['1\u00a0299,90 ₽', 1299.9],
  ['1\u202f299,90 ₽', 1299.9], ['¥1,299.90', 1299.9], ['1,299', 1299], ['1,299,999.90', 1299999.9],
  ['1.299.999,90 EUR', 1299999.9], ['12,90', 12.9], ['3.299', 3.299], ['1e3', 1000],
  ['0.00', 0], [0, 0], [-12.3, -12.3], ['-12,30', -12.3],
  ['', null], [' \t\n ', null], [true, null], [false, null], [null, null], [undefined, null],
  [NaN, null], [Infinity, null], [[], null], [{ value: 12.3 }, null], ['没有返回', null], ['1.2.3', null],
];
for (const [index, [value, expected]] of formats.entries()) {
  test(`shared numeric case ${index}: Node and native-injected script agree`, () => {
    assert.equal(parseCaptureNumber(value), expected);
    assert.equal(injected(value), expected);
  });
}

test('all ten platform adapters preserve currency and keep missing numeric values unknown', () => {
  for (const platform of ['1688', '淘宝', '天猫', '拼多多', '京东', 'Ozon买家', 'Wildberries', 'Amazon', 'Temu', 'AliExpress']) {
    for (const raw of [' ', false, true, null]) {
      const result = normalizePurchaseCapture({ platform, purchasePrice: raw, currency: 'EUR', weightKg: raw,
        skus: [{ id: 'fixture-sku', price: raw, weightKg: raw }] });
      assert.equal(result.purchasePrice, null, platform);
      assert.equal(result.weightKg, null, platform);
      assert.equal(result.skus[0].price, null, platform);
      assert.equal(result.skus[0].weightKg, null, platform);
      assert.equal(result.currency, 'EUR', platform);
    }
  }
});

test('native packaging embeds the same pure parser used by the desktop adapter', () => {
  const project = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/Wangzai.CefBrowserHost.csproj', import.meta.url), 'utf8');
  const loader = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/PurchaseCaptureNumberScript.cs', import.meta.url), 'utf8');
  const extractor = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/PurchaseProductPlatformExtractors.cs', import.meta.url), 'utf8');
  assert.match(project, /EmbeddedResource Include="\.\.\/\.\.\/src\/purchaseBrowser\/purchaseCaptureNumber\.js" LogicalName="Wangzai\.PurchaseCaptureNumber\.js"/u);
  assert.match(loader, /GetManifestResourceStream\(\s*"Wangzai\.PurchaseCaptureNumber\.js"/u);
  assert.match(extractor, /Value = PurchaseCaptureNumberScript\.Value \+/u);
});

test('native price arrays keep the existing minimum-price and cent-unit semantics', () => {
  const source = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/PurchaseProductPlatformExtractors.cs', import.meta.url), 'utf8');
  const extractor = source.match(/"""([\s\S]*?)""";/u)?.[1];
  const nativeNumber = vm.runInNewContext(`const clean=(value,max=500)=>String(value??'').trim().slice(0,max);\n${moduleText.replaceAll('export function ', 'function ')}\n${extractor}\nplatformNumber`);
  assert.equal(nativeNumber([25.5, 26.5]), '25.5');
  assert.equal(nativeNumber([5271, 6990], true), '52.71');
  assert.equal(nativeNumber(['$1,299.90', '$1,399.90']), '1299.9');
});
