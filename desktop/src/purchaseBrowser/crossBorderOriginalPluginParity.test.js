import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const runtime = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/CrossBorderBuiltInRuntime.cs', import.meta.url), 'utf8');
const host = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/BrowserHostForm.cs', import.meta.url), 'utf8');

test('built-in logistics reader reuses the original cross-border bus routes, selectors and wait budget', () => {
  assert.match(runtime, /https:\/\/air\.1688\.com\/app\/ctf-m-page\/logistics-detail\/index\.html\?orderId=/u);
  assert.match(runtime, /captureOriginalPluginLogistics\(url, "1688"\)/u);
  assert.match(runtime, /WaitAsync\(TimeSpan\.FromSeconds\(45\)\)/u);
  assert.match(runtime, /cross-border-bus-plugin-original-v1\.0\.8/u);
  assert.match(host, /"\.content-container>\.name"/u);
  assert.match(host, /"\.content-container>\.mailNo"/u);
  assert.match(host, /"\.express-info>\.shipping-name"/u);
  assert.match(host, /"\.express-info>\.tracking-number"/u);
  assert.match(host, /settleDelay: TimeSpan\.FromSeconds\(2\)/u);
});
