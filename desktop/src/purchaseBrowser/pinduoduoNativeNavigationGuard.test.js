import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const nativeRoot = path.resolve(currentDirectory, '../../native/Wangzai.CefBrowserHost');

async function readNativeSource(fileName) {
  return readFile(path.join(nativeRoot, fileName), 'utf8');
}

test('Pinduoduo popup navigation leaves the CEF callback before loading the target URL', async () => {
  const source = await readNativeSource('InternalLifeSpanHandler.cs');
  assert.match(source, /BeginInvoke\s*\(/);
  assert.match(source, /browserControl\.LoadUrl\(deferredUrl\)/);
  assert.doesNotMatch(source, /chromiumWebBrowser\.LoadUrl\(targetUrl\)/);
  assert.match(source, /IsAllowedInteractiveNavigation\(normalizedTargetUrl, extensions\)/);
  assert.match(source, /NormalizePinduoduoTopLevelUrl\(targetUrl\)/);
});

test('Pinduoduo personal and login pages remain available while app-install redirects are blocked', async () => {
  const source = await readNativeSource('BrowserUrlPolicy.cs');
  assert.match(source, /a11\.app\.qq\.com/);
  assert.match(source, /sj\.qq\.com/);
  assert.match(source, /\/down_download\.html/);
  assert.match(source, /\/undefined\.html/);
  assert.match(source, /add_download_task=1/);
  assert.doesNotMatch(source, /personal\.html/);
  assert.doesNotMatch(source, /login\.html/);
});

test('main-frame native navigation uses the same interactive redirect guard', async () => {
  const source = await readNativeSource('InternalRequestHandler.cs');
  assert.match(source, /IsAllowedInteractiveNavigation\(request\.Url, extensions\)/);
  assert.match(source, /NormalizePinduoduoTopLevelUrl\(request\.Url\)/);
  assert.match(source, /browserControl\.BeginInvoke/u);
  assert.match(source, /browserControl\.LoadUrl\(normalizedUrl\)/u);
});

test('Pinduoduo keeps direct mobile routes inside the original embeddable order workbench', async () => {
  const coordinator = await readNativeSource('BrowserHostCoordinator.cs');
  const program = await readNativeSource('Program.cs');
  const hostForm = await readNativeSource('BrowserHostForm.cs');
  const urlPolicy = await readNativeSource('BrowserUrlPolicy.cs');
  assert.match(program, /using var pinduoduoForm = new BrowserHostForm/u);
  assert.match(program, /new BrowserHostCoordinator\(form, pinduoduoForm\)/u);
  assert.match(coordinator, /BrowserHostForm target = generalForm/u);
  assert.match(coordinator, /JsonObject routed = Clone\(payload\)/u);
  assert.doesNotMatch(coordinator, /ForceStandalonePinduoduo/u);
  assert.doesNotMatch(coordinator, /workbench\["displayMode"\] = "window"/u);
  assert.doesNotMatch(coordinator, /"pinduoduo-dedicated"/u);
  assert.match(hostForm, /NavigatePinduoduo\("\/personal\.html"\)/u);
  assert.match(hostForm, /NavigatePinduoduo\("\/orders\.html"\)/u);
  assert.match(urlPolicy, /Host = "mobile\.yangkeduo\.com"/u);
});

test('native purchase browser passes an unweighted language list to CEF', async () => {
  const profile = await readNativeSource('BrowserProfile.cs');
  const hostForm = await readNativeSource('BrowserHostForm.cs');
  const session = await readNativeSource('BrowserSession.cs');
  assert.match(profile, /CefAcceptLanguageList/u);
  assert.match(profile, /Split\(';', 2\)\[0\]\.Trim\(\)/u);
  assert.match(hostForm, /AcceptLanguageList = profile\.CefAcceptLanguageList/u);
  assert.match(session, /SetPreference\("intl\.accept_languages", Profile\.CefAcceptLanguageList/u);
});

test('Pinduoduo product pages retain the complete pre-React rawData snapshot', async () => {
  const handler = await readNativeSource('FingerprintRenderProcessMessageHandler.cs');
  const hostForm = await readNativeSource('BrowserHostForm.cs');
  const snapshot = await readNativeSource('PinduoduoProductSnapshotScript.cs');
  assert.match(handler, /OnContextCreated/u);
  assert.match(handler, /PinduoduoProductSnapshotScript\.Value/u);
  assert.match(handler, /ExecuteJavaScriptAsync\(fingerprintScript\)/u);
  assert.match(handler, /ExecuteJavaScriptAsync\(PinduoduoProductSnapshotScript\.Value\)/u);
  assert.match(snapshot, /window\.rawData\?\.store\?\.initDataObj\?\.goods/u);
  assert.match(snapshot, /__wangzaiPddProductSnapshotV1/u);
  assert.match(snapshot, /value\?\.skus/u);
  assert.match(snapshot, /MutationObserver/u);
  assert.match(hostForm, /KeepBackgroundProductParserAlive/u);
  assert.match(hostForm, /Profile\.BrowserRole\.Equals\("product-link-parser"/u);
  assert.match(hostForm, /SwpShowWindow/u);
});

test('Pinduoduo checkout transitions do not inject scripts into disposable subframes', async () => {
  const handler = await readNativeSource('FingerprintRenderProcessMessageHandler.cs');
  assert.match(handler, /if \(!frame\.IsMain \|\| !frame\.IsValid\) return;/u);
  assert.match(handler, /catch \(ObjectDisposedException\)/u);
  assert.match(handler, /catch \(InvalidOperationException\)/u);
});

test('purchase browser denies media permissions used by Pinduoduo WebRTC probes', async () => {
  const permissionHandler = await readNativeSource('InternalPermissionHandler.cs');
  const profile = await readNativeSource('BrowserProfile.cs');
  assert.match(permissionHandler, /callback\.Cancel\(\)/u);
  assert.match(permissionHandler, /PermissionRequestResult\.Deny/u);
  assert.match(profile, /platformKey\.Equals\("pinduoduo"/u);
  assert.match(profile, /webRtcPolicy = "disable_non_proxied_udp"/u);
});

test('native browser stays on the known stable CEF 150 runtime', async () => {
  const project = await readNativeSource('Wangzai.CefBrowserHost.csproj');
  const program = await readNativeSource('Program.cs');
  assert.match(project, /CefSharp\.WinForms\.NETCore" Version="150\.0\.110"/u);
  assert.match(program, /Chrome\/150\.0\.0\.0/u);
  assert.doesNotMatch(project, /151\.3\.170/u);
});

test('product parser stops retrying after the page leaves product detail', async () => {
  const controller = await readFile(path.join(currentDirectory, 'cefPurchaseBrowserController.js'), 'utf8');
  assert.match(controller, /tab\.browserRole === 'product-link-parser' && capture\.pageType !== 'product'/u);
  assert.match(controller, /fail\('PURCHASE_BROWSER_PRODUCT_PAGE_REQUIRED'\)/u);
});

test('CEF protocol keeps a persistent socket error listener and rejects writes after a crash', async () => {
  const runtime = await readFile(path.join(currentDirectory, 'cefBrowserRuntime.js'), 'utf8');
  assert.match(runtime, /socket\.on\('error', \(error\) => this\.crash\(error\)\)/u);
  assert.match(runtime, /if \(this\.crashed \|\| !this\.socket \|\| this\.socket\.destroyed \|\| !this\.socket\.writable\)/u);
});
