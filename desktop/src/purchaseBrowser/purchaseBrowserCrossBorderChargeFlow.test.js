import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..');
const nativeRoot = path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost');

test('native toolbar freezes the actual-charge login then save-effective flow', () => {
  const host = fs.readFileSync(path.join(nativeRoot, 'BrowserHostForm.cs'), 'utf8');
  const runtime = fs.readFileSync(path.join(nativeRoot, 'CrossBorderBuiltInRuntime.cs'), 'utf8');
  const session = fs.readFileSync(path.join(nativeRoot, 'BrowserSession.cs'), 'utf8');
  const controller = fs.readFileSync(
    path.join(desktopRoot, 'src', 'purchaseBrowser', 'cefPurchaseBrowserController.js'),
    'utf8',
  );
  const toolbar = fs.readFileSync(
    path.join(desktopRoot, 'src', 'purchaseBrowser', 'purchaseBrowserToolbarActions.js'),
    'utf8',
  );

  assert.match(host, /ActionButton\("实际扣费", "cross-border-charges-open"\)/u);
  assert.match(host, /ActionButton\("保存生效", "cross-border-charges-save"\)/u);
  assert.match(host, /crossBorderChargeSaveButton\.Enabled[\s\S]*IsCrossBorderPageUrl\(session\.Address\)/u);
  assert.match(host, /kind == "cross-border-charges-opened"[\s\S]*ShowInlineStatus = true/u);
  assert.match(host, /ToolbarActionGroup\([\s\S]*"采集"/u);
  assert.match(host, /ToolbarActionGroup\([\s\S]*"订单"/u);
  assert.match(host, /ToolbarActionGroup\([\s\S]*"跨境"/u);
  assert.match(host, /ToolbarActionGroup\([\s\S]*"账号"/u);
  assert.doesNotMatch(host, /ActionButton\("实际扣费", "cross-border-charges-preview"\)/u);

  assert.match(toolbar, /action === 'cross-border-charges-open'/u);
  assert.match(toolbar, /action === 'cross-border-charges-save'/u);
  assert.match(toolbar, /selectedCrossBorderChargePage\(tab\.url\)/u);
  assert.match(toolbar, /pageUrl: chargePage\.pageUrl/u);
  assert.doesNotMatch(toolbar, /payload\?\.shopId \|\| tab\.target\?\.shopId/u);

  assert.match(runtime, /IsCrossBorderPageUrl\(selectedPageUrl\)/u);
  assert.match(runtime, /\["selectedPageUrl"\] = selectedPageUrl/u);
  assert.match(runtime, /MaximumChargeRows = 100000/u);
  assert.match(runtime, /MaximumChargePages = 2000/u);
  assert.match(runtime, /result\.Rows\.Count >= result\.ExpectedTotal/u);
  assert.doesNotMatch(runtime, /result\.RawRowCount >= result\.ExpectedTotal/u);
  assert.match(host, /CROSS_BORDER_CHARGE_AMOUNT_INVALID.*金额缺失/u);
  assert.doesNotMatch(runtime, /pageRows\.Count < pageSize/u);
  assert.match(runtime, /CROSS_BORDER_CHARGE_PAGINATION_REPEATED_PAGE/u);
  assert.match(runtime, /BuildChargePageForm\(input, selectedFilters, page, pageSize\)/u);
  assert.match(runtime, /foreach \(KeyValuePair<string, JsonNode\?> filter in selectedFilters\)/u);
  assert.match(session, /ReadCrossBorderChargePageContextAsync\(\)/u);
  assert.match(session, /reason: pick\('reason'\)/u);
  assert.match(session, /chargePayload\["pageUrl"\] = pageContext\["pageUrl"\]/u);
  assert.match(session, /crossBorder\.ExecuteAsync\(command, chargePayload\)/u);
  assert.match(controller, /command === 'cross-border-charges'[\s\S]*\? 630_000/u);
  assert.match(controller, /command === 'cross-border-charges' \? 600_000/u);
});
