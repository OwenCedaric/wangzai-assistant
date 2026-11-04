import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const runtime = fs.readFileSync(
  new URL('../../native/Wangzai.CefBrowserHost/CrossBorderBuiltInRuntime.cs', import.meta.url),
  'utf8',
);

test('original plugin fetch path keeps a bounded twelve-lane hundred-order reader', () => {
  assert.match(runtime, /MaximumDirectReadOrders = 100/u);
  assert.match(runtime, /DirectReadConcurrency = 12/u);
  assert.match(runtime, /\.Take\(MaximumDirectReadOrders\)/u);
  assert.match(runtime, /new\(DirectReadConcurrency, DirectReadConcurrency\)/u);
  assert.match(runtime, /directReadGate\.WaitAsync\(\)/u);
  assert.match(runtime, /directReadGate\.Release\(\)/u);
  assert.match(runtime, /captureOriginalPluginLogistics\(url, "1688"\)/u);
});
