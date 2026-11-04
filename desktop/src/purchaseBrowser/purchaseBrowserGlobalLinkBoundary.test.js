import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const nativeRoot = path.resolve(root, '..', 'native', 'Wangzai.CefBrowserHost');

test('desktop external links have one CEF route and no OS-browser fallback', () => {
  const main = read('main.js');
  const mainWindow = read('window/mainWindow.js');
  const ipc = read('runtime/desktopIpc.js');
  assert.doesNotMatch(mainWindow, /shell\.openExternal|openExternal\s*\(/u);
  assert.match(mainWindow, /setWindowOpenHandler/u);
  assert.match(mainWindow, /openInternalUrl\(url\)/u);
  assert.match(mainWindow, /will-navigate/u);
  assert.match(main, /routeExternalLinkToInternalBrowser/u);
  assert.match(main, /createPurchaseBrowserCefWindowController/u);
  assert.doesNotMatch(read('purchaseBrowser/purchaseBrowserCefWindowController.js'), /purchaseBrowserHostWindow/u);
  assert.doesNotMatch(main, /createPurchaseBrowserHostWindowController/u);
  assert.match(ipc, /command === 'open-external'/u);
  assert.match(ipc, /command === 'embed-bounds'/u);
  assert.match(ipc, /setEmbeddedViewport/u);
  assert.match(ipc, /embeddedBounds/u);
  assert.match(ipc, /purchaseBrowserExternalLinkRouter\.open/u);
});

test('native CEF owns cross-border commands and never recurses through the toolbar bridge', () => {
  const session = fs.readFileSync(path.join(nativeRoot, 'BrowserSession.cs'), 'utf8');
  const form = fs.readFileSync(path.join(nativeRoot, 'BrowserHostForm.cs'), 'utf8');
  const program = fs.readFileSync(path.join(nativeRoot, 'Program.cs'), 'utf8');
  assert.match(session, /crossBorder\.ExecuteAsync\(command, payload\)/u);
  assert.doesNotMatch(session, /RequestBuiltInActionAsync/u);
  assert.match(form, /ActionButton\("采集到操作台", "collection-pricing-capture"\)/u);
  assert.match(form, /ActionButton\("目标订单", "target-mode"\)/u);
  assert.match(form, /if \(hostActionInFlight\)/u);
  assert.match(form, /actionToolbarPanel\.Enabled = false/u);
  assert.match(form, /"PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY" => "商品页面仍在加载/u);
  assert.match(form, /ShowInlineStatus = true/u);
  assert.match(form, /采集成功，已加入采集列表，可继续采集下一件/u);
  assert.doesNotMatch(form, /ReturnToWorkbench/u);
  assert.match(form, /GwlHwndParent, IntPtr\.Zero/u);
  assert.match(program, /CefSharp\.BrowserSubprocess\.exe/u);
  assert.match(program, /com\.wangzai\.assistant\.purchase-browser/u);
});

