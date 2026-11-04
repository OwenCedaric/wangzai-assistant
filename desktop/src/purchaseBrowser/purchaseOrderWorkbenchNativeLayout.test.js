import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..');
const hostFormSource = fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'BrowserHostForm.cs'),
  'utf8',
);
const nativeMethodsSource = fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'NativeMethods.cs'),
  'utf8',
);
const browserSessionSource = fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'BrowserSession.cs'),
  'utf8',
);
const desktopMainSource = fs.readFileSync(path.join(desktopRoot, 'src', 'main.js'), 'utf8');

test('embedded purchase workbench leaves all visible chrome to the React card', () => {
	const hideBody = hostFormSource.match(/public void HideBrowser\(\)[\s\S]*?public void OnSessionStateChanged/u)?.[0] || '';
  assert.match(hostFormSource, /private bool embeddedMode;/u);
  assert.match(hostFormSource, /titleBarPanel\.Visible = !embeddedMode;/u);
  assert.match(hostFormSource, /navigationPanel\.Visible = !embeddedMode;/u);
  assert.match(hostFormSource, /actionToolbarPanel\.Visible = !embeddedMode;/u);
  assert.match(hostFormSource, /if \(embeddedMode\) workbenchPanel\.Visible = false;/u);
  assert.match(hostFormSource, /MinimumSize = embeddedMode \? new Size\(320, 240\) : new Size\(1240, 720\);/u);
  assert.match(nativeMethodsSource, /SetWindowLongPtrW/u);
  assert.match(nativeMethodsSource, /SetParent/u);
  assert.match(nativeMethodsSource, /GetParent/u);
  assert.match(nativeMethodsSource, /WsChild/u);
  assert.match(hostFormSource, /NativeMethods\.SetParent\(handle, parentHwnd\)/u);
  assert.match(hostFormSource, /NativeMethods\.WsChild/u);
  assert.match(hostFormSource, /PURCHASE_BROWSER_EMBED_PARENT_FAILED/u);
  assert.match(hostFormSource, /actualParentHwnd/u);
	assert.match(nativeMethodsSource, /SwpHideWindow/u);
	assert.match(nativeMethodsSource, /ShowWindow/u);
	assert.match(nativeMethodsSource, /IsWindowVisible/u);
	assert.match(nativeMethodsSource, /EnumChildWindows/u);
	assert.match(hostFormSource, /browserPanel\.Visible = false;/u);
	assert.match(hostFormSource, /NativeMethods\.ShowWindow\(base\.Handle, NativeMethods\.SwHide\)/u);
	assert.match(hostFormSource, /browserSurfaceVisible = chromiumWindows\.Any/u);
	assert.match(hostFormSource, /nextEmbeddedMode && !embeddedMode && base\.Opacity < 1\.0/u);
	assert.doesNotMatch(hideBody, /Opacity/u, 'WS_CHILD 隐藏阶段不得再调用 Form.Opacity/UpdateLayered');
	assert.doesNotMatch(hostFormSource, /if \(!base\.Visible\)\s*\{\s*Show\(\);\s*\}\s*\}/u);
});

test('embedded 1688 pages receive a native fit-width zoom and other platforms stay at 100%', () => {
  assert.match(browserSessionSource, /Embedded1688ZoomLevel = -1\.25d/u);
  assert.match(browserSessionSource, /Profile\.PlatformKey, "1688"/u);
  assert.match(browserSessionSource, /fit1688[\s\S]*?\? Embedded1688ZoomLevel[\s\S]*?: 0\.0d;/u);
  assert.match(browserSessionSource, /Browser\.SetZoomLevel\(zoomLevel\)/u);
  assert.match(browserSessionSource, /\? "embedded-fit-width"[\s\S]*?: "native";/u);
  assert.match(hostFormSource, /workbenchSession\.ApplyEmbeddedPageFit\([\s\S]*?copy\?\["sidebarKind"\]/u);
  assert.match(hostFormSource, /value\.ApplyEmbeddedPageFit\([\s\S]*?presentation\?\["sidebarKind"\]/u);
});

test('only the Ozon after-sales workbench locks its browser at the approved 90% scale', () => {
  assert.match(browserSessionSource, /EmbeddedAfterSalesZoomLevel = -0\.5778829311823857d/u);
  assert.match(browserSessionSource, /sidebarKind, "after-sales"/u);
  assert.match(browserSessionSource, /"embedded-after-sales-fixed"/u);
  assert.match(browserSessionSource, /enforcedZoomTimer = new System\.Threading\.Timer/u);
  assert.match(browserSessionSource, /TimeSpan\.FromMilliseconds\(150\.0\)/u);
  assert.match(browserSessionSource, /enforcedZoomTimer\.Dispose\(\)/u);
  assert.match(browserSessionSource, /if \(!args\.IsLoading\) ApplyRequestedZoomLevel\(\)/u);
  assert.match(browserSessionSource, /Browser\.SetZoomLevel\(zoomLevel\)/u);
});

test('a normal product link resets an inherited embedded viewport before the atomic open', () => {
  const transition = desktopMainSource.match(
    /const leavingEmbeddedMode[\s\S]*?if \(!keepVisible && !embeddedOpen\)/u,
  )?.[0] || '';
  assert.match(transition, /visibleTab\?\.embedding\?\.requested === true/u);
  assert.match(transition, /clearEmbeddedViewport\?\.\(\{ notify: false \}\)/u);
  assert.match(transition, /input\.bounds = \{ \.\.\.standaloneBounds, visible: true \};/u);
});

test('a controller-restored standalone window is not shown a second time by the host adapter', () => {
  assert.match(desktopMainSource, /if \(keepVisible \|\| result\?\.visible === true\) return result;/u);
});

test('closing and reopening a standalone CEF page preserves the native Form handle', () => {
	const hideBody = hostFormSource.match(/public void HideBrowser\(\)[\s\S]*?public void OnSessionStateChanged/u)?.[0] || '';
	const restoreBody = hostFormSource.match(/public void RestoreSession\(string ownerRef\)[\s\S]*?public void HideBrowser/u)?.[0] || '';
	const constructorBody = hostFormSource.match(/public BrowserHostForm\(BrowserExtensionPackageManager extensions\)[\s\S]*?public void BindProtocol/u)?.[0] || '';
	const showInTaskbarWrites = hostFormSource.match(/base\.ShowInTaskbar\s*=/gu) || [];
	assert.match(nativeMethodsSource, /GwlExStyle/u);
	assert.match(nativeMethodsSource, /WsExToolWindow/u);
	assert.match(nativeMethodsSource, /WsExAppWindow/u);
	assert.match(hostFormSource, /private void ApplyTaskbarVisibility\(bool visible\)/u);
	assert.match(hideBody, /ApplyTaskbarVisibility\(visible: false\)/u);
	assert.match(restoreBody, /ApplyTaskbarVisibility\(visible: !embeddedMode\)/u);
	assert.match(constructorBody, /base\.ShowInTaskbar = true;/u);
	assert.equal(showInTaskbarWrites.length, 1,
		'CEF host must never recreate its Form HWND by changing ShowInTaskbar after construction');
	assert.doesNotMatch(hideBody, /ShowInTaskbar\s*=/u);
	assert.doesNotMatch(restoreBody, /ShowInTaskbar\s*=/u);
	assert.match(hostFormSource, /bool alreadyEmbedded = embeddedMode/u);
	assert.match(hostFormSource, /bool alreadyStandalone = !embeddedMode/u);
	assert.match(hostFormSource, /if \(alreadyEmbedded \|\| alreadyStandalone\)/u);
});

test('purchase login launch stores its owner before one atomic presentation transition', () => {
	const launchBody = hostFormSource.match(/private (?:async )?Task<object\?> LaunchAsync\(JsonObject payload\)[\s\S]*?private RequestContext AcquireRequestContext/u)?.[0] || '';
	const parentBody = hostFormSource.match(/private void ApplyParentWindow\(JsonObject payload, bool applyNativeMode\)[\s\S]*?private void CaptureTopLevelWindowStyle/u)?.[0] || '';
	assert.match(launchBody, /ApplyParentWindow\(payload, applyNativeMode: false\);/u);
	assert.match(launchBody, /ApplyWorkbench\(profile\.OwnerRef, payload\["workbench"\] as JsonObject\);/u);
	assert.ok(
		launchBody.indexOf('ApplyParentWindow(payload, applyNativeMode: false);')
			< launchBody.indexOf('ApplyWorkbench(profile.OwnerRef, payload["workbench"] as JsonObject);'),
		'owner handle must be stored before the target presentation is applied',
	);
	assert.match(parentBody, /if \(applyNativeMode && changed\)/u);
	assert.ok(
		launchBody.indexOf('ApplyWorkbench(profile.OwnerRef, payload["workbench"] as JsonObject);')
			< launchBody.indexOf('value.Browser.CreateControl();'),
		'final native presentation must be applied before Chromium creates its child HWND',
	);
});

test('native close fences one in-flight visible bounds generation until an explicit reopen', () => {
	assert.match(hostFormSource, /private long latestVisibilityVersion;/u);
	assert.match(hostFormSource, /private long hiddenVisibilityFence;/u);
	assert.match(hostFormSource, /LongInteger\(payload, "visibilityVersion", 0\)/u);
	assert.match(hostFormSource, /visibilityVersion > hiddenVisibilityFence/u);
	assert.match(hostFormSource, /latestVisibilityVersion \+ 1/u);
	assert.match(hostFormSource, /HideBrowser\(fenceVisibility: false\)/u);
});

test('standalone collection stays open, reports success inline and remains restorable from the taskbar', () => {
	const collectionDelivery = desktopMainSource.match(
		/onCollectionPricingCapture:[\s\S]*?return \{ delivered: true \};\s*\},/u,
	)?.[0] || '';
	assert.match(hostFormSource, /ShowActionStatus\(dialog\.Message\)/u);
	assert.match(hostFormSource, /ShowInlineStatus = true/u);
	assert.match(hostFormSource, /采集成功，已加入采集列表，可继续采集下一件/u);
	assert.match(hostFormSource, /GwlHwndParent, IntPtr\.Zero/u);
	assert.doesNotMatch(collectionDelivery, /windows\.focus\(\)/u);
});

test('standalone restore rejects the off-screen sentinel bounds and flushes account cookies', () => {
  assert.match(hostFormSource, /private static bool IsStandaloneBoundsVisible\(Rectangle bounds\)/u);
  assert.match(hostFormSource, /private Rectangle RecoverStandaloneBounds\(Rectangle candidate\)/u);
  assert.match(hostFormSource, /lastBounds = RecoverStandaloneBounds\(lastBounds\)/u);
  assert.match(hostFormSource, /requestedBounds = RecoverStandaloneBounds\(requestedBounds\)/u);
  assert.match(browserSessionSource, /FlushPersistentStorageAsync\(\)/u);
  assert.match(browserSessionSource, /FlushStoreAsync\(\)/u);
  assert.match(hostFormSource, /_ = Active\?\.FlushPersistentStorageAsync\(\)/u);
});

test('purchase-account login is saved inside the standalone native window and closes only after persistence', () => {
  assert.match(hostFormSource, /ActionButton\("保存账号", "purchase-login-save"\)/u);
  assert.match(hostFormSource, /purchaseLoginSaveButton\.Visible = !session\.Profile\.Background;/u);
  assert.match(hostFormSource, /actionToolbarPanel = new FlowLayoutPanel[\s\S]*?WrapContents = false/u);
  assert.match(hostFormSource, /private static FlowLayoutPanel ToolbarActionGroup[\s\S]*?WrapContents = false/u);
  assert.match(browserSessionSource, /case "purchase-login-status":/u);
  assert.match(browserSessionSource, /GetPurchaseLoginStatusAsync\(\)/u);
  assert.match(browserSessionSource, /HasPurchaseAuthenticationCookies/u);
  assert.match(browserSessionSource, /strongAuthenticationCookie && !explicitLoginPage/u);
  assert.match(hostFormSource, /if \(dialog\.AutoClose\)[\s\S]*?FlushPersistentStorageAsync\(\)[\s\S]*?HideBrowser\(\)/u);
  assert.match(hostFormSource, /kind == "purchase-login-saved"/u);
  assert.match(hostFormSource, /kind == "purchase-login-save-failed"/u);
  assert.match(hostFormSource, /kind == "purchase-login-identity-pending"/u);
  assert.match(hostFormSource, /kind == "purchase-login-shop-mismatch"/u);
  assert.match(hostFormSource, /"PURCHASE_BROWSER_INTEGRATION_LOGIN_READBACK_FAILED" => "Ozon 登录信息已保存/u);
});

test('successful Ozon login auto-close does not surface its cleanup cancellation as an operation failure', () => {
  assert.match(hostFormSource, /IsExpectedHostActionCancellation\(action, code\)/u);
  assert.match(hostFormSource, /action == "purchase-login-save"[\s\S]*?code == "PURCHASE_BROWSER_COMMAND_CANCELLED"/u);
  assert.match(hostFormSource, /if \(IsExpectedHostActionCancellation\(action, code\)\)[\s\S]*?return;[\s\S]*?MessageBox\.Show\(this, FriendlyError\(code\)/u);
});

test('Ozon login save accepts a real Seller app session without trusting a stale Cookie or login route', () => {
  const loginStatusBody = browserSessionSource.match(
    /private async Task<object> GetOzonLoginStatusAsync\(\)[\s\S]*?private async Task<JsonObject> ReadOzonSellerSessionEvidenceAsync\(\)/u,
  )?.[0] || '';
  assert.match(browserSessionSource, /OzonSellerSessionEvidenceScript/u);
  assert.match(browserSessionSource, /sellerAppShellReady/u);
  assert.match(browserSessionSource, /liveSellerResponse/u);
  assert.match(browserSessionSource, /pageProbeRedirectedToLogin/u);
  assert.match(loginStatusBody, /authenticatedByProbe \|\| authenticatedByPageContext/u);
  assert.match(loginStatusBody, /!explicitLoginPage/u);
  assert.match(loginStatusBody, /cookies\.Count > 0/u);
  assert.match(loginStatusBody, /"seller-app-shell"/u);
  assert.match(loginStatusBody, /"login-page"/u);
  assert.match(loginStatusBody, /verificationOutcome/u);
  assert.match(loginStatusBody, /verificationPending/u);
  assert.match(loginStatusBody, /"seller-page-pending"/u);
  assert.match(loginStatusBody, /probeStatus == 401/u);
  assert.match(loginStatusBody, /"sc_company_id"/u);
  assert.match(loginStatusBody, /"seller-company-cookie"/u);
  assert.match(loginStatusBody, /companyId = cookieCompanyId/u);
  assert.match(loginStatusBody, /companyContextReady = companyContextReady \|\| !string\.IsNullOrWhiteSpace\(companyId\)/u);
  assert.doesNotMatch(loginStatusBody, /bool authenticated = authenticatedByProbe;/u);
});
