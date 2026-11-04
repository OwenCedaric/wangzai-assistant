import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeRoot = path.resolve(here, '../../native/Wangzai.CefBrowserHost');
const scriptSource = fs.readFileSync(path.join(nativeRoot, 'OzonSellerOrderOpenScript.cs'), 'utf8');
const sessionSource = fs.readFileSync(path.join(nativeRoot, 'BrowserSession.cs'), 'utf8');

test('exact Seller-order script searches, activates and verifies the requested posting', () => {
  assert.match(scriptSource, /const posting = \{\{postingJson\}\}/u);
  assert.match(scriptSource, /HTMLInputElement\.prototype/u);
  assert.match(scriptSource, /\^\(所有\|все\|all\)\$/u);
  assert.match(scriptSource, /statusContextMarkers/u);
  assert.match(scriptSource, /deadlineWait\(\(\) => exactLeaf\(\) \|\| findOrderHeader\(\), 20000/u);
  assert.match(scriptSource, /货件编号\|订单号\|номер\\s\+отправ/u);
  assert.match(scriptSource, /headerTrigger/u);
  assert.match(scriptSource, /elementFromPoint/u);
  assert.match(scriptSource, /explicitHeaderTrigger/u);
  assert.match(scriptSource, /headerSearchGlyph/u);
  assert.match(scriptSource, /contenteditable/u);
  assert.match(scriptSource, /rowLinks\.find\(\(node\) => clean\(node\.textContent\)\.includes\(posting\)\)/u);
  assert.match(scriptSource, /typeof node\.click === 'function'/u);
  assert.match(scriptSource, /KeyboardEvent\('keydown'.*key: 'Enter'/u);
  assert.match(scriptSource, /activateExactOrder\(resultLeaf\)/u);
  assert.match(scriptSource, /interactive\.focus\(\)/u);
  assert.match(sessionSource, /DispatchMouseEventType\.MousePressed/u);
  assert.match(sessionSource, /DateTimeOffset\.UtcNow\.AddSeconds\(30\)/u);
  assert.doesNotMatch(scriptSource, /exact:\s*true[^\n]+original-order-list/u);
});

test('native CEF refuses to report success when exact-order readback is missing', () => {
  assert.match(sessionSource, /case "ozon-open-order"/u);
  assert.match(sessionSource, /result\["exact"\].*== true && result\["opened"\].*== true/u);
  assert.match(sessionSource, /PURCHASE_BROWSER_OZON_ORDER_NOT_FOUND/u);
  assert.match(sessionSource, /PURCHASE_BROWSER_OZON_ORDER_OPEN_FAILED/u);
});
