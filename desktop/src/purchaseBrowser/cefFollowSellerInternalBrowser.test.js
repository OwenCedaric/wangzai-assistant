import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..', '..');
const workspaceRoot = path.resolve(desktopRoot, '..');

function nativeSource(name) {
  return fs.readFileSync(
    path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', name),
    'utf8',
  );
}

function quickComplaintPageAdapterExpression() {
  const source = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
  const marker = 'private const string QuickComplaintPageAdapterExpression = """';
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf('\n""";', start);
  assert.ok(start >= marker.length && end > start);
  return source.slice(start, end).trim();
}

function quickComplaintBackendScript({
  resumeExisting = false,
	resumeTicketId = '',
  resumePhase = '',
  expectedInitialAttachmentCount = 0,
	answeredPromptTicketId = '',
	answeredPromptText = '',
	answeredPromptAction = '',
	answeredPromptReplayCount = 0,
	stopAfterRepeatedPromptDetection = false,
} = {}) {
  const source = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
  const methodStart = source.indexOf('private static async Task<JsonObject> EvaluateQuickBackendComplaintStateAsync');
  const scriptStartMarker = 'string script = $$"""';
  const scriptStart = source.indexOf(scriptStartMarker, methodStart) + scriptStartMarker.length;
  const scriptEnd = source.indexOf('\n""";', scriptStart);
  assert.ok(methodStart >= 0 && scriptStart >= scriptStartMarker.length && scriptEnd > scriptStart);
  const replacements = {
	QuickComplaintPageAdapterExpression: quickComplaintPageAdapterExpression(),
    evidenceJson: JSON.stringify('evidence-route-fixture'),
    originalSkuJson: JSON.stringify('900000001'),
    followerSkusJson: JSON.stringify(['3771432837']),
    initialEvidenceJson: JSON.stringify('initial evidence marker'),
    supplementJson: JSON.stringify('supplement evidence marker'),
    followerBatchJson: JSON.stringify('follower batch marker'),
    resumeJson: String(resumeExisting),
	resumeTicketJson: JSON.stringify(resumeTicketId),
    resumePhaseJson: JSON.stringify(resumePhase),
    expectedInitialAttachmentCountJson: String(expectedInitialAttachmentCount),
	answeredPromptTicketJson: JSON.stringify(answeredPromptTicketId),
	answeredPromptTextJson: JSON.stringify(answeredPromptText),
	answeredPromptActionJson: JSON.stringify(answeredPromptAction),
	answeredPromptReplayCountJson: String(answeredPromptReplayCount),
	stopAfterRepeatedPromptDetectionJson: String(stopAfterRepeatedPromptDetection),
  };
  return Object.entries(replacements).reduce(
    (script, [key, value]) => script.replaceAll(`{{${key}}}`, value),
    source.slice(scriptStart, scriptEnd),
  );
}

function createQuickComplaintDomHarness(options = {}) {
  const values = new Map();
  const page = {
    chatText: '',
    tileTexts: [],
    ticketVisible: true,
	newTicketHeaderVisible: false,
    composerVisible: true,
	composerInputKind: 'textarea',
    historyImageCount: 0,
	ticketEntries: [],
	searchVisible: true,
	searchValue: '',
	url: 'https://seller.ozon.ru/app/messenger?group=support_v2',
	ticketId: options.resumeExisting && options.resumeTicketId
	  ? options.resumeTicketId
	  : '90650001',
  };
  const visibleNode = (value = '') => ({
    innerText: value,
    textContent: value,
    className: 'om_6inde--yWDHe',
    outerHTML: `<button>${value}</button>`,
    disabled: false,
	readOnly: false,
	getAttribute: () => null,
    getClientRects: () => [1],
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 40 }),
	scrollIntoView() {},
    contains: () => false,
    remove() {},
  });
	const historyImage = (index) => ({
	  ...visibleNode(''),
	  currentSrc: `https://cdn.example.test/evidence-${index}.png`,
	  src: `https://cdn.example.test/evidence-${index}.png`,
	  complete: true,
	  naturalWidth: 720,
	  naturalHeight: 720,
	});
  const textarea = visibleNode('');
	textarea.value = '';
	Object.defineProperty(textarea, 'tagName', {
	  get: () => page.composerInputKind === 'input' ? 'INPUT' : 'TEXTAREA',
	});
	const ticketSearch = {
	  ...visibleNode(''),
	  placeholder: '根据请求进行搜索',
	  type: 'search',
	  get value() { return page.searchValue; },
	};
	const historyScroll = {
	  ...visibleNode(''),
	  get innerText() { return page.chatText; },
	  get textContent() { return page.chatText; },
	  clientHeight: 500,
	  scrollHeight: 500,
	};
  const conversation = {
	contains: (node) => node === composer,
	getClientRects: () => [1],
	getBoundingClientRect: () => ({ left: 800, top: 100, right: 1700, bottom: 1000, width: 900, height: 900 }),
    cloneNode: () => ({
      get innerText() { return page.chatText; },
      querySelector: (selector) => selector === '[current-chat-id]' ? visibleNode('') : null,
    }),
    querySelector: (selector) => selector === '.m9d-o7' && page.ticketVisible
	      ? visibleNode(`№${page.ticketId}`)
      : null,
      querySelectorAll: (selector) => selector === '.om_6inde--yWDHe'
      ? page.tileTexts.map(visibleNode)
	    : selector === 'img'
	      ? Array.from({ length: page.historyImageCount }, (_, index) => historyImage(index))
	      : selector.includes('*') ? [
			...(page.newTicketHeaderVisible ? [visibleNode(`新请求 №${page.ticketId}`)] : []),
			historyScroll,
		  ]
	      : [],
  };
  const composer = visibleNode('');
	composer.matches = () => false;
	composer.querySelectorAll = (selector) => page.composerVisible
	  && (page.composerInputKind === 'input' ? /input/u.test(selector) : /textarea/u.test(selector))
	    ? [textarea]
	    : [];
	composer.getBoundingClientRect = () => ({ left: 880, top: 850, right: 1740, bottom: 980, width: 860, height: 130 });
  composer.parentElement = conversation;
  const sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const context = {
    window: {},
    URL,
    sessionStorage,
	location: { get href() { return page.url; } },
	innerWidth: 1440,
	innerHeight: 1000,
    getComputedStyle: () => ({ visibility: 'visible' }),
    document: {
      body: { get innerText() { return page.chatText; } },
      querySelector: (selector) => {
        if (selector === '[current-chat-id]') return page.composerVisible ? composer : null;
        if (selector === 'textarea') return page.composerVisible ? textarea : null;
        return null;
      },
      querySelectorAll: (selector) => {
        if (selector === 'button,[role="button"],.om_6inde--yWDHe') return page.tileTexts.map(visibleNode);
		if (selector === 'button,a,[role="button"],[role="menuitem"],[role="option"],label,.om_6inde--yWDHe') {
		  return page.tileTexts.map(visibleNode);
		}
		if (selector === 'button,[role="button"],a,[tabindex],div,span') return page.ticketEntries.map(visibleNode);
		if (selector === 'input') return page.searchVisible ? [ticketSearch] : [];
        if (selector === 'iframe') return [];
        return [];
      },
    },
  };
  const storageKey = '__wangzaiScheme1Complaint:evidence-route-fixture';
  return {
    page,
    evaluate() {
	  return JSON.parse(vm.runInNewContext(quickComplaintBackendScript(options), context));
    },
    markPending(routeKey) {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
      stored.pendingRouteKey = routeKey;
      stored.pendingRouteAt = Date.now();
      sessionStorage.setItem(storageKey, JSON.stringify(stored));
      context.window.__wangzaiScheme1Complaint.pendingRouteKey = routeKey;
      context.window.__wangzaiScheme1Complaint.pendingRouteAt = stored.pendingRouteAt;
    },
	setRuntime(changes = {}) {
	  const stored = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
	  const runtime = {
		evidenceId: 'evidence-route-fixture',
		routeStep: 0,
		routeVerified: false,
		pendingRouteKey: '',
		pendingRouteAt: 0,
		routeStartedAt: Date.now(),
		phase: 'route',
		phaseStartedAt: Date.now(),
		conversationMissingAt: 0,
		baselineTicketId: '',
		freshRequestConfirmed: false,
		ticketLocked: false,
		ticketMismatchAt: 0,
		ticketRecoveredAt: 0,
		legacyReplayPrompt: '',
		clicked: [],
		startedAt: Date.now(),
		ticketId: '',
		...stored,
		...changes,
	  };
	  sessionStorage.setItem(storageKey, JSON.stringify(runtime));
	  context.window.__wangzaiScheme1Complaint = runtime;
	},
  };
}

test('follow seller patrol reuses its dedicated internal CEF session', () => {
  const session = nativeSource('BrowserSession.cs');
  const host = nativeSource('BrowserHostForm.cs');

  assert.match(session, /CaptureOzonFollowSellerPayloadsAsync\([\s\S]*?concurrency,[\s\S]*?includeProductFacts,[\s\S]*?Browser\)/u);
  assert.match(session, /OnFollowSellerCaptureProgress\([\s\S]*?captureToken,[\s\S]*?result/u);
  assert.match(host, /ChromiumWebBrowser\? sessionBrowser = null/u);
  assert.match(host, /ExecuteOzonPatrolSessionScriptAsync\([\s\S]*?sessionBrowser/u);
});

test('internal patrol requests use per-SKU product referrers and stop request bursts after a challenge', () => {
  const host = nativeSource('BrowserHostForm.cs');

  assert.match(host, /Math\.Clamp\(concurrency, 1, 6\)/u);
  assert.match(host, /const includeProductFacts =/u);
  assert.match(host, /const product = !includeProductFacts/u);
  assert.match(host, /await sleep\(120 \+ \(\(index \* 47\) % 141\)\)/u);
  assert.match(host, /referrer:\s*sourceProductUrl/u);
  assert.match(host, /referrerPolicy:\s*'strict-origin-when-cross-origin'/u);
  assert.match(host, /riskControlTripped\s*=\s*true/u);
  assert.match(host, /pageRefreshChallenge/u);
  assert.doesNotMatch(host, /const \[offers, product\] = await Promise\.all/u);
});

test('native patrol streams twelve-SKU chunks and emits every normalized result', () => {
  const capture = nativeSource('OzonFollowSellerCapture.cs');
  const host = nativeSource('BrowserHostForm.cs');

  assert.match(capture, /StreamingChunkSize = 12/u);
  assert.match(capture, /browserCapture\(chunk, concurrency, includeProductFacts\)/u);
  assert.match(capture, /onResult\?\.Invoke\(captureToken, result\)/u);
  assert.match(host, /eventName = "follow-seller-result"/u);
});

test('standalone follow-seller verification explicitly observes the same background CEF session', () => {
  const host = nativeSource('BrowserHostForm.cs');
  const controller = fs.readFileSync(
    path.join(desktopRoot, 'src', 'purchaseBrowser', 'cefPurchaseBrowserController.js'),
    'utf8',
  );

  assert.match(host, /case "show-follow-seller-verification-browser"/u);
  assert.match(host, /case "hide-follow-seller-verification-browser"/u);
  assert.match(host, /followSellerVerificationObservationOwnerRef = ownerRef/u);
  assert.match(host, /RestoreSessionForObservation\(ownerRef\)/u);
  assert.match(host, /\(!boundedSession\.Profile\.Background \|\| followSellerVerificationObservation\)/u);
  assert.match(host, /RestoreSession\(ownerRef, allowBackground: followSellerVerificationObservation\)/u);
  assert.match(host, /FOLLOW_SELLER_VERIFICATION_WINDOW_NOT_VISIBLE/u);
  assert.match(host, /HideFollowSellerVerificationSurface\(string ownerRef, bool fenceVisibility\)/u);
  assert.match(host, /base\.Enabled = true;[\s\S]*?ApplyTaskbarVisibility\(visible: false\);[\s\S]*?SwHide/u);
  assert.match(controller, /followSellerVerificationVisible:/u);
  assert.match(controller, /nativePresentation\?\.windowVisible !== true/u);
  assert.match(controller, /show-follow-seller-verification-browser/u);
  assert.match(controller, /hide-follow-seller-verification-browser/u);
  assert.match(controller, /read-follow-seller-verification/u);
  assert.match(controller, /event === 'window-hidden'[\s\S]*?followSellerVerificationPresentation[\s\S]*?visible: false/u);
  assert.match(controller, /applyVisibility\(\)[\s\S]*?hide-follow-seller-verification-browser/u);
  assert.match(nativeSource('BrowserSession.cs'), /case "follow-seller-verification-status"/u);
  assert.match(nativeSource('BrowserSession.cs'), /GetFollowSellerVerificationStatusAsync/u);
});

test('every internal browser role restores the stable account fingerprint', () => {
  const nativeRoot = path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost');
  const requests = nativeSource('FingerprintResourceRequestHandler.cs');
  const renderer = nativeSource('FingerprintRenderProcessMessageHandler.cs');
  const script = nativeSource('FingerprintScript.cs');
  const internal = nativeSource('InternalRequestHandler.cs');
  const session = nativeSource('BrowserSession.cs');
  const host = [
    nativeSource('BrowserHostForm.cs'),
    nativeSource('BrowserHostForm.FollowSellerComplaint.cs'),
    nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs'),
  ].join('\n');

  assert.equal(fs.existsSync(path.join(nativeRoot, 'BrowserIdentityPolicy.cs')), false);
  assert.match(internal, /new FingerprintResourceRequestHandler\(profile, alibaba1688OrderCapture\)/u);
  assert.match(requests, /alibaba1688OrderCapture\?\.Observe\(request\.Url\)/u);
  assert.match(requests, /headers\["User-Agent"\] = profile\.UserAgent/u);
  assert.match(requests, /requestUri\.Scheme\.Equals\("wss"/u);
  assert.doesNotMatch(requests, /headers\["Sec-CH-UA"\]/u);
  assert.match(requests, /headers\["Accept-Language"\] = profile\.AcceptLanguage/u);
  assert.match(renderer, /fingerprintScript = FingerprintScript\.Build\(profile\)/u);
  assert.match(script, /__wangzaiCefFingerprintV2/u);
  assert.match(script, /Navigator\.prototype, 'webdriver', undefined/u);
  assert.match(script, /patchWebGl/u);
  assert.match(script, /HTMLCanvasElement\.prototype\.toDataURL/u);
  assert.match(`${session}\n${host}`, /RenderProcessMessageHandler = new FingerprintRenderProcessMessageHandler\(profile\)/u);
});

test('CEF 150 runtime presents a matching Chrome 150 Ozon identity without rewriting WebSocket headers', () => {
  const project = nativeSource('Wangzai.CefBrowserHost.csproj');
  const program = nativeSource('Program.cs');
  const session = nativeSource('BrowserSession.cs');
  const profile = nativeSource('BrowserProfile.cs');
  const fingerprintScript = nativeSource('FingerprintScript.cs');
  const preferences = nativeSource('BrowserRequestContextPreferences.cs');
  const requestHandler = nativeSource('FingerprintResourceRequestHandler.cs');
  const main = fs.readFileSync(path.join(desktopRoot, 'src', 'main.js'), 'utf8');

  assert.match(project, /CefSharp\.WinForms\.NETCore" Version="150\.0\.110"/u);
  assert.match(main, /Chrome\/150\.0\.0\.0/u);
  assert.match(profile, /Chrome\/150\.0\.0\.0/u);
  assert.match(program, /UserAgent = "Mozilla\/5\.0[^"]+Chrome\/150\.0\.0\.0/u);
  assert.match(fingerprintScript, /if \(start < 0\) return 150/u);
  assert.match(fingerprintScript, /brand = "Google Chrome"/u);
  assert.match(requestHandler, /preserve the native handshake/u);
  assert.doesNotMatch(program, /disable-background-networking/u);
  assert.match(session, /case "ozon-support-status"/u);
  assert.match(session, /case "ozon-support-open"/u);
  assert.match(session, /ready: conversationVisible && \(composerVisible \|\| conversationListVisible \|\| emptyConversationVisible\)/u);
  assert.match(session, /BrowserProfile\.Text\(Profile\.Proxy, "mode", "direct", 40\)/u);
  assert.match(preferences, /OnRequestContextInitialized\(IRequestContext requestContext\)/u);
  assert.match(preferences, /mode == "fixed_servers"/u);
  assert.match(preferences, /mode is not \("direct" or "system"\)/u);
  assert.match(preferences, /context\.SetPreference\("proxy", proxy, out _\)/u);
  assert.match(preferences, /context\.GetPreference\("proxy"\)/u);
});

test('CEF host waits for browser subprocesses before shutdown', () => {
  const program = nativeSource('Program.cs');

  assert.match(program, /Cef\.EnableWaitForBrowsersToClose\(\)/u);
  assert.match(program, /Application\.Run\(form\)[\s\S]*?Cef\.WaitForBrowsersToClose\(\)[\s\S]*?Cef\.Shutdown\(\)/u);
});

test('follow seller UI no longer requires an external Chrome or Edge relay', () => {
  const service = fs.readFileSync(
    path.join(workspaceRoot, 'frontend', 'src', 'features', 'followSellerDefense', 'services', 'followSellerDefenseService.js'),
    'utf8',
  );
  const page = fs.readFileSync(
    path.join(workspaceRoot, 'frontend', 'src', 'features', 'followSellerDefense', 'FollowSellerDefensePage.jsx'),
    'utf8',
  );

  assert.doesNotMatch(service, /system-browser-relay|relay\/status/u);
  assert.doesNotMatch(page, /复制扩展目录|真实 Chrome\/Edge/u);
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, 'frontend', 'scripts', 'purchase-bridge', 'follow-seller-browser-relay.mjs')),
    false,
  );
});

test('scheme1 seller-backend routing follows the real support chatbot and preserves exact diagnostics', () => {
  const quickComplaint = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
  const complaintFiles = nativeSource('BrowserHostForm.FollowSellerComplaint.cs');
  const errorCode = nativeSource('ErrorCode.cs');

  assert.match(errorCode, /text\.StartsWith\("FOLLOW_SELLER_", StringComparison\.Ordinal\)/u);
  assert.match(quickComplaint, /messenger\?channel=SCRM/u);
  assert.match(quickComplaint, /messenger\?group=support_v2/u);
  assert.match(quickComplaint, /const step = route\[Math\.max/u);
  assert.match(quickComplaint, /\.om_6inde--yWDHe/u);
	  assert.doesNotMatch(quickComplaint, /runtime\.routeStep \+= 1/u);
  assert.match(quickComplaint, /key: 'product-prices'/u);
  assert.match(quickComplaint, /key: 'quality-control'/u);
  assert.match(quickComplaint, /key: 'seller-content-use'/u);
	  assert.match(quickComplaint, /SetQuickComplaintRoutePendingAsync\(browser, evidenceId, action\)[\s\S]*?DispatchQuickSessionPageClickAsync/u);
	  assert.match(quickComplaint, /pendingRouteKey: String\(stored\.pendingRouteKey \|\| ''\)/u);
	  assert.match(quickComplaint, /routeMatches = route\.map[\s\S]*?latestRouteDomIndex/u);
	  assert.match(quickComplaint, /nextMenuConfirmed[\s\S]*?activeRouteIndex === nextIndex/u);
	  assert.match(quickComplaint, /finalPromptConfirmed[\s\S]*?ownPrompt && textarea/u);
	  assert.doesNotMatch(quickComplaint, /finalPromptConfirmed[^\n]*activeRouteIndex < 0/u);
	  assert.match(quickComplaint, /runtime\.routeVerified = finalPromptConfirmed/u);
	  assert.match(quickComplaint, /runtime\.routeVerified && runtime\.routeStep >= route\.length[\s\S]*?action: 'original-sku'/u);
	  assert.match(quickComplaint, /runtime\.routeVerified && runtime\.phase === 'wait-evidence-prompt'[\s\S]*?status: 'initial-evidence-required'/u);
	  assert.match(quickComplaint, /const originalReply = afterMarker\(originalSku\)/u);
	  assert.match(quickComplaint, /const followerReply = afterMarker\(followerSkus\[0\] \|\| ''\)/u);
  assert.match(quickComplaint, /status: 'type-message-required'/u);
  assert.match(quickComplaint, /action: 'original-sku'/u);
  assert.match(quickComplaint, /action: 'follower-sku'/u);
	  assert.match(quickComplaint, /action: 'follower-batch'/u);
	  assert.match(quickComplaint, /status: 'initial-evidence-required'/u);
	  assert.match(quickComplaint, /status: 'supplement-required'/u);
	  assert.match(quickComplaint, /status: 'materials-rejected'/u);
	  assert.match(quickComplaint, /runtime\.phase === 'wait-initial-reply'/u);
	  assert.match(quickComplaint, /runtime\.phase === 'wait-supplement-reply'/u);
	  assert.match(quickComplaint, /history\?\.querySelector\('\[current-chat-id\]'\)\?\.remove\(\)/u);
	assert.match(quickComplaint, /if \(ticketId && observedTicketId !== ticketId\)/u);
	assert.match(quickComplaint, /action: 'restore-ticket'/u);
	assert.match(quickComplaint, /status: 'ticket-search-required'/u);
	assert.match(quickComplaint, /SetQuickComplaintTicketSearchAsync/u);
	assert.match(quickComplaint, /action: 'ticket-view-stable'/u);
	assert.match(quickComplaint, /FOLLOW_SELLER_SCHEME1_TICKET_VIEW_MISMATCH/u);
	  assert.match(quickComplaint, /SetQuickComplaintPhaseAsync/u);
	  assert.match(quickComplaint, /submitted-awaiting-support-reply/u);
  assert.match(quickComplaint, /Input\.InsertTextAsync\(message\)/u);
	  assert.match(quickComplaint, /FOLLOW_SELLER_SCHEME1_INITIAL_MESSAGE_REQUIRED/u);
	  assert.match(quickComplaint, /\.\. images\.Select\(item => item\.Path\)/u);
	  assert.match(quickComplaint, /\.\. screenshots\.FollowerProductPages/u);
	  assert.doesNotMatch(quickComplaint, /DispatchKeyEventType\.RawKeyDown/u);
	  assert.match(quickComplaint, /WaitForQuickComplaintMessageReadbackAsync/u);
  assert.match(quickComplaint, /FOLLOW_SELLER_COMPLAINT_SUBMIT_NOT_CONFIRMED/u);
  assert.match(quickComplaint, /scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/u);
	  assert.match(quickComplaint, /TimeSpan\.FromSeconds\(120\)/u);
	  assert.match(quickComplaint, /SubmitQuickComplaintBundleAsync/u);
	  assert.match(quickComplaint, /SubmitQuickComplaintSupplementBundleAsync/u);
	  assert.match(quickComplaint, /confirmationClicks < 4/u);
	  assert.match(quickComplaint, /residualTextReady: attachmentsSent && messageStillInComposer && sendReady && !confirm/u);
	  assert.match(quickComplaint, /send-residual-text/u);
	  assert.match(quickComplaint, /requireMessageReadback: false/u);
	  assert.match(quickComplaint, /bool requireMessageReadback = true/u);
	  assert.match(quickComplaint, /Action\? onConfirm = null/u);
	  assert.match(quickComplaint, /WaitForQuickSupplementSubmissionReadbackAsync/u);
	  assert.doesNotMatch(quickComplaint, /ClearQuickComplaintComposerAsync/u);
	  assert.match(quickComplaint, /batchPrompt && \/sku\/i\.test\(reply\) && textarea/u);
	  assert.match(quickComplaint, /supplementResidualTextCleared/u);
	  assert.match(quickComplaint, /resumePhase === 'wait-evidence-prompt'/u);
	  assert.match(quickComplaint, /historyAttachmentImages\.length >= expectedInitialAttachmentCount/u);
	  assert.match(quickComplaint, /initialImagesAlreadySent && runtime\.phase !== 'repair-initial-text'/u);
	  assert.match(quickComplaint, /const conversationLoadFailed = \/无法加载聊天列表\|не удалось загрузить список чат\|ws1006\/i/u);
	  assert.match(quickComplaint, /status: 'conversation-refresh-required'/u);
	  assert.match(quickComplaint, /Volatile\.Read\(ref submissionStarted\) != 0[\s\S]*?conversationRefreshAttempts >= 3/u);
	  assert.match(quickComplaint, /DispatchQuickSessionPageClickAsync\(browser, refreshX, refreshY\)[\s\S]*?browser\.Reload\(\)/u);
	  assert.match(quickComplaint, /AttachComplaintFilesAsync\(browser, attachmentPaths\)/u);
	  assert.match(quickComplaint, /historyImages - beforeCount >= expectedCount/u);
	  assert.match(quickComplaint, /composerImages === 0/u);
	  assert.match(quickComplaint, /WaitForQuickAttachmentSendReadinessAsync/u);
	  assert.match(quickComplaint, /const attachmentsStaged = composerImages >= expectedCount/u);
	  assert.match(quickComplaint, /const attachmentsAlreadyInHistory = completedAttachmentCount >= expectedCount/u);
	  assert.match(quickComplaint, /const attachmentsReady = attachmentsStaged \|\| attachmentsAlreadyInHistory/u);
	  assert.match(quickComplaint, /ready: attachmentsReady && activeUploadSignals === 0/u);
	  assert.match(quickComplaint, /!uploadError && messagePresent && sendReady/u);
	  assert.match(quickComplaint, /onSubmissionStarted\?\.Invoke\(\);[\s\S]*?await ClickQuickComplaintSendAsync/u);
	  assert.match(quickComplaint, /svg circle/u);
	  assert.match(quickComplaint, /style\.animationName/u);
	  assert.match(quickComplaint, /stableReads >= 12/u);
	  assert.doesNotMatch(quickComplaint, /WaitForQuickAttachmentHistoryUploadCompletionAsync|WaitForQuickAttachmentPreparationAsync|WaitForQuickAttachmentUploadCompletionAsync|GetQuickComposerImageCountAsync|addedImages|attachmentCountExact|attachmentsUploaded &&/u);
	  assert.match(quickComplaint, /Ozon 要求二次确认，正在确认发送当前证据内容/u);
	  assert.match(quickComplaint, /FOLLOW_SELLER_COMPLAINT_BUNDLE_SUBMIT_NOT_CONFIRMED/u);
	  assert.doesNotMatch(quickComplaint, /ClickQuickComplaintAttachmentSendAsync/u);
	  assert.match(quickComplaint, /status: 'daily-limit'/u);
	  assert.match(quickComplaint, /在这一天内/u);
	  assert.match(quickComplaint, /dailyLimitPattern\.test\(currentReplySource\)/u);
	  assert.doesNotMatch(quickComplaint, /dailyLimitPattern\.test\(bodyText\)/u);
	  assert.match(quickComplaint, /FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT/u);
	  assert.match(quickComplaint, /status: 'repeat-answer-required'/u);
	  assert.match(quickComplaint, /status: 'prompt-replay-baseline-required'/u);
	  assert.match(quickComplaint, /status: 'ticket-history-load-required'/u);
	  assert.match(
		quickComplaint,
		/if \(stopBeforeFirstMessage && action == "original-sku" && stateTicketId\.Length > 0\)[\s\S]*?\["submissionStarted"\] = false[\s\S]*?\["status"\] = "route-ready-observed"/u,
	  );
	  assert.match(quickComplaint, /if \(status == "prompt-replay-baseline-required"\)[\s\S]*?SaveQuickPromptReplayStateAsync\([\s\S]*?"initial-evidence",[\s\S]*?0\)/u);
	  assert.match(quickComplaint, /DispatchQuickTrustedScrollAsync\(browser, historyX, historyY, -historyDelta\)/u);
	  assert.doesNotMatch(quickComplaint, /scrollHeight[^\n]*clientHeight/u);
	  assert.match(quickComplaint, /initialMessageMarkerCount === 1/u);
	  assert.match(quickComplaint, /replayDiagnostics:[\s\S]*?legacyReplayCandidate:[\s\S]*?historyScrollPointFound:/u);
	  assert.match(quickComplaint, /stopAfterRepeatedPromptDetection[\s\S]*?status: 'repeated-prompt-observed'/u);
	  assert.match(quickComplaint, /status: 'repeated-prompt-limit'/u);
	  assert.match(quickComplaint, /FOLLOW_SELLER_SCHEME1_REPEATED_PROMPT_LIMIT/u);
	  assert.match(quickComplaint, /QuickPromptReplayStateLedgerName = "scheme1-prompt-replay-state\.json"/u);
	  assert.match(quickComplaint, /SaveQuickPromptReplayStateAsync/u);
  assert.match(quickComplaint, /FOLLOW_SELLER_COMPLAINT_COMPOSER_INPUT_FAILED/u);
  assert.match(quickComplaint, /FOLLOW_SELLER_SCHEME1_ORIGINAL_SKU_NOT_FOUND/u);
  assert.match(quickComplaint, /FOLLOW_SELLER_SCHEME1_FOLLOWER_SKU_NOT_FOUND/u);
  assert.match(quickComplaint, /chat\.querySelector\('\.m9d-o7'\)/u);
	assert.match(quickComplaint, /const ticketNumber = value =>/u);
	assert.match(quickComplaint, /\(\?:№\|#\).*\[0-9\]\{6,20\}/u);
	assert.match(quickComplaint, /input:not\(\[type="file"\]\)/u);
	assert.match(quickComplaint, /\[role="textbox"\]/u);
	assert.match(quickComplaint, /composerInputPresent: !!textarea/u);
  assert.match(quickComplaint, /QuickComplaintPageAdapterExpression/u);
  assert.match(quickComplaint, /pageAdapter\.ticketId\(conversation\)/u);
  assert.match(quickComplaint, /pageAdapter\.input\(composer\)/u);
  assert.equal((quickComplaint.match(/const inputSelector =/gu) || []).length, 1);
  assert.equal((quickComplaint.match(/const sendSelector =/gu) || []).length, 1);
  assert.equal((quickComplaint.match(/document\.querySelector\('\[current-chat-id\]'\)/gu) || []).length, 1);
  assert.match(quickComplaint, /button\[type="submit"\]/u);
  assert.match(quickComplaint, /sendButton, cloneHistory, historyText/u);
  assert.match(quickComplaint, /DispatchQuickSessionPageClickAsync/u);
  assert.match(quickComplaint, /document\.elementFromPoint/u);
  assert.match(quickComplaint, /action: 'confirm-send'/u);
  assert.match(
    complaintFiles,
	    /SetInterceptFileChooserDialogAsync\(true, false\)/u,
  );
  assert.match(
    complaintFiles,
	    /FileChooserOpened[\s\S]*?BackendNodeId[\s\S]*?SetFileInputFilesAsync\(filePaths, null, backendNodeId/u,
  );
	  assert.match(quickComplaint, /PrepareQuickEvidenceScreenshotsAsync/u);
	  assert.match(quickComplaint, /ParseQuickFollowers/u);
	  assert.match(quickComplaint, /FOLLOW_SELLER_SCHEME1_ALL_FOLLOWERS_NOT_FOUND/u);
	  assert.match(quickComplaint, /такой страницы не существует/u);
	  assert.match(quickComplaint, /BuildQuickLiveInitialEvidenceText/u);
	  assert.match(quickComplaint, /карточка\\s\+\(\?:другого\\s\+\)\?продавца/u);
	  assert.match(quickComplaint, /https:\/\/www\.ozon\.ru\/product\/\{item\.Sku\}\//u);
	  assert.match(quickComplaint, /BuildQuickLiveFollowerBatchText/u);
	  assert.match(quickComplaint, /own-product-page\.png/u);
	  assert.match(quickComplaint, /own-seller-list\.png/u);
	  assert.match(quickComplaint, /follower-\{liveFollowers\.Count \+ 1:D2\}-\{follower\.Sku\}-page\.png/u);
	  assert.doesNotMatch(quickComplaint, /CreateQuickProductEvidenceImage/u);
	  assert.match(quickComplaint, /scheme1-browser-evidence\.json/u);
  assert.doesNotMatch(quickComplaint, /data-menu-tab/u);
	  assert.match(quickComplaint, /\/app\/products\?search=/u);
	  assert.match(quickComplaint, /DispatchQuickSessionPageClickAsync[\s\S]*?target\.click\(\)/u);
	  assert.match(quickComplaint, /ChromiumWebBrowser\? browser = sessionBrowser/u);
	  assert.doesNotMatch(quickComplaint, /new ChromiumWebBrowser\(OzonSellerQuickComplaintStartUrl/u);
	  assert.match(quickComplaint, /LoadQuickPreparedEvidence[\s\S]*?PrepareQuickEvidenceScreenshotsAsync[\s\S]*?SaveQuickPreparedEvidenceAsync[\s\S]*?browser\.Load\(QuickComplaintEntryUrl\(resumeExisting, resumePageUrl\)\)/u);
	  assert.match(quickComplaint, /ExecuteQuickEvidenceStepWithRetryAsync/u);
  assert.match(quickComplaint, /QuickTransitionGuard loginTransitionGuard = new\(TimeSpan\.FromSeconds\(8\), 6\)/u);
  assert.match(quickComplaint, /if \(status == "login-required"\)[\s\S]*?!loginTransitionGuard\.IsConfirmed\(true\)[\s\S]*?Task\.Delay\(550\)[\s\S]*?FOLLOW_SELLER_COMPLAINT_LOGIN_REQUIRED/u);
  assert.match(quickComplaint, /catch \(Exception error\) when \(IsQuickBackendStateTransient\(error\)\)[\s\S]*?seller-backend:browser-recovery[\s\S]*?FOLLOW_SELLER_SCHEME1_BROWSER_TRANSIENT_FAILED/u);
  assert.match(quickComplaint, /IsQuickBackendStateTransient[\s\S]*?PURCHASE_BROWSER_CEF_FAILED[\s\S]*?FOLLOW_SELLER_SCHEME1_PAGE_SCRIPT_FAILED/u);
	  assert.match(quickComplaint, /scheme1-backend-diagnostic\.json/u);
	  assert.match(quickComplaint, /scheme1-backend-diagnostic\.png/u);
	  assert.match(quickComplaint, /scheme1-backend-diagnostic-\{diagnosticStamp\}-\{diagnosticCode\}/u);
	  assert.match(quickComplaint, /QuickPreparedEvidenceLedgerName = "scheme1-prepared-evidence\.json"/u);
	  assert.match(quickComplaint, /LoadQuickPreparedEvidence[\s\S]*?FileSha256\(fullPath\)/u);
	  assert.match(quickComplaint, /ThrowIfQuickComplaintWaitExpired[\s\S]*?FOLLOW_SELLER_SCHEME1_ROUTE_REPLY_TIMEOUT/u);
	  assert.match(quickComplaint, /resume-ticket-mismatch/u);
	  assert.match(quickComplaint, /runtime\.phase === 'resume-history'/u);
	  assert.match(quickComplaint, /action: 'repair-initial-text'/u);
	  assert.match(quickComplaint, /action: 'repair-supplement-text'/u);
  assert.match(quickComplaint, /frameUrls/u);
  assert.match(quickComplaint, /stage=\{stage\}/u);
  assert.doesNotMatch(quickComplaint, /helpCenter=page/u);
  assert.doesNotMatch(quickComplaint, /svg path\[fill-rule="evenodd"\]/u);
});

test('scheme1 page adapter owns ticket, composer and send-button discovery for every phase', () => {
	const visibleNode = (text = '') => ({
	  innerText: text,
	  textContent: text,
	  value: '',
	  disabled: false,
	  readOnly: false,
	  getClientRects: () => [1],
	  getAttribute: () => null,
	});
	const header = visibleNode('新请求 №90770306');
	const input = visibleNode('');
	const send = visibleNode('发送');
	const history = { innerText: 'Ozon机器人 请发送商品 SKU', querySelector: () => null };
	const conversation = {
	  cloneNode: () => history,
	  querySelector: () => null,
	  querySelectorAll: (selector) => selector === '*' || selector.includes('data-testid') ? [header] : [],
	};
	const composer = {
	  parentElement: conversation,
	  matches: () => false,
	  querySelectorAll: (selector) => {
		if (selector.includes('input:not')) return [input];
		if (selector.includes('button[type="submit"]')) return [send];
		return [];
	  },
	};
	const context = {
	  document: { querySelector: (selector) => selector === '[current-chat-id]' ? composer : null },
	  getComputedStyle: () => ({ visibility: 'visible' }),
	};
	const result = JSON.parse(vm.runInNewContext(`(() => {
	  const adapter = ${quickComplaintPageAdapterExpression()};
	  return JSON.stringify({
		ticketId: adapter.ticketId(),
		freshRequestTicketId: adapter.freshRequestTicketId(),
		inputFound: adapter.input() === input,
		sendFound: adapter.sendButton() === send,
		historyText: adapter.historyText(),
	  });
	})()`, { ...context, input, send }));

	assert.deepEqual(result, {
	  ticketId: '90770306',
	  freshRequestTicketId: '90770306',
	  inputFound: true,
	  sendFound: true,
	  historyText: 'Ozon机器人 请发送商品 SKU',
	});
});

test('scheme1 route fixture advances from the latest bot menu while historical buttons remain', () => {
  const harness = createQuickComplaintDomHarness();
  harness.page.chatText = 'Ozon机器人 请选择您感兴趣的方向。 商品和价格';
  harness.page.tileTexts = ['商品和价格'];
  assert.equal(harness.evaluate().action, 'product-prices');

  harness.markPending('product-prices');
	// The support route must create and lock a new ticket instead of treating
	// the previously selected historical conversation as the submission target.
	harness.page.ticketId = '90650002';
  harness.page.chatText += ' Ozon机器人 您对什么感兴趣？ 质量监督';
  harness.page.tileTexts = ['商品和价格', '质量监督'];
  assert.equal(harness.evaluate().action, 'quality-control');

  harness.markPending('quality-control');
  harness.page.chatText += ' Ozon机器人 您对什么感兴趣？ 卖家使用我的内容';
  harness.page.tileTexts = ['商品和价格', '质量监督', '卖家使用我的内容'];
  assert.equal(harness.evaluate().action, 'seller-content-use');

  harness.markPending('seller-content-use');
  harness.page.chatText += ' Ozon机器人 请发送被其他卖家使用的商品卡片对应的 SKU';
  const ready = harness.evaluate();
  assert.equal(ready.status, 'type-message-required');
  assert.equal(ready.action, 'original-sku');
  assert.equal(ready.ticketId, '90650002');

  harness.page.ticketVisible = false;
	  const transientTicketNode = harness.evaluate();
	  assert.equal(transientTicketNode.status, 'waiting');
	  assert.equal(transientTicketNode.action, 'ticket-view-match');
	  assert.equal(transientTicketNode.ticketId, '90650002');

	  harness.page.composerVisible = false;
	  const transientConversation = harness.evaluate();
	  assert.equal(transientConversation.action, 'restore-ticket-search');
	  assert.equal(transientConversation.ticketId, '90650002');
	  assert.ok(Date.now() - transientConversation.waitStartedAt < 1_000);
});

test('scheme1 completes all three route steps when the same fresh ticket is visible from the first read', () => {
	const harness = createQuickComplaintDomHarness();
	harness.page.ticketVisible = false;
	harness.page.newTicketHeaderVisible = true;
	harness.page.ticketId = '90770833';
	harness.page.url = 'https://seller.ozon.ru/app/messenger/?id=b57c88cf-00d8-4481-99df-1f2f779a3b12&group=support_v2';
	harness.page.chatText = '新请求 №90770833 Ozon机器人 请选择您感兴趣的方向。 商品和价格';
	harness.page.tileTexts = ['商品和价格'];
	assert.equal(harness.evaluate().action, 'product-prices');

	harness.markPending('product-prices');
	harness.page.chatText += ' Ozon机器人 您对什么感兴趣？ 质量监督';
	harness.page.tileTexts = ['商品和价格', '质量监督'];
	assert.equal(harness.evaluate().action, 'quality-control');

	harness.markPending('quality-control');
	harness.page.chatText += ' Ozon机器人 您对什么感兴趣？ 卖家使用我的内容';
	harness.page.tileTexts = ['商品和价格', '质量监督', '卖家使用我的内容'];
	assert.equal(harness.evaluate().action, 'seller-content-use');

	harness.markPending('seller-content-use');
	harness.page.chatText += ' Ozon机器人 请发送被其他卖家使用的商品卡片对应的SKU。请从商品卡片中的“货号”字段复制该 SKU。';
	harness.page.tileTexts = ['返回'];
	const ready = harness.evaluate();
	assert.equal(ready.status, 'type-message-required');
	assert.equal(ready.action, 'original-sku');
	assert.equal(ready.ticketId, '90770833');
});

test('scheme1 accepts the current Ozon request header and input-based composer after the final bot reply', () => {
	const harness = createQuickComplaintDomHarness();
	harness.setRuntime({
	  baselineTicketId: '90650001',
	  ticketLocked: false,
	  ticketId: '',
	  routeStep: 3,
	  routeVerified: false,
	  phase: 'route',
	  routeStartedAt: Date.now(),
	});
	harness.page.ticketVisible = false;
	harness.page.newTicketHeaderVisible = true;
	harness.page.composerInputKind = 'input';
	harness.page.ticketId = '90770306';
	harness.page.chatText = '新请求 №90770306 Ozon机器人 请发送被其他卖家使用的商品卡片对应的SKU。请从商品卡片中的“货号”字段复制该 SKU。';

	const result = harness.evaluate();
	assert.equal(result.status, 'type-message-required');
	assert.equal(result.action, 'original-sku');
	assert.equal(result.ticketId, '90770306');
	assert.equal(result.phase, 'route');
});

test('scheme1 locks the new ticket when its first readable state is already the completed fresh request', () => {
	const harness = createQuickComplaintDomHarness();
	harness.setRuntime({
	  baselineTicketId: '',
	  freshRequestConfirmed: false,
	  ticketLocked: false,
	  ticketId: '',
	  routeStep: 2,
	  routeVerified: false,
	  pendingRouteKey: 'seller-content-use',
	  pendingRouteAt: Date.now(),
	  clicked: [
		{ key: 'product-prices', at: Date.now() - 3000, confirmedAt: Date.now() - 2500 },
		{ key: 'quality-control', at: Date.now() - 2000, confirmedAt: Date.now() - 1500 },
	  ],
	  phase: 'route',
	  routeStartedAt: Date.now(),
	});
	harness.page.ticketVisible = false;
	harness.page.newTicketHeaderVisible = true;
	harness.page.composerInputKind = 'input';
	harness.page.ticketId = '90770833';
	harness.page.url = 'https://seller.ozon.ru/app/messenger/?id=b57c88cf-00d8-4481-99df-1f2f779a3b12&group=support_v2';
	harness.page.chatText = '新请求 №90770833 处理中 Ozon机器人 请发送被其他卖家使用的商品卡片对应的SKU。请从商品卡片中的“货号”字段复制该 SKU。 返回';

	const result = harness.evaluate();
	assert.equal(result.status, 'type-message-required');
	assert.equal(result.action, 'original-sku');
	assert.equal(result.ticketId, '90770833');
	assert.equal(result.phase, 'route');
});

test('scheme1 does not lock a historical request without the confirmed three-step route', () => {
	const harness = createQuickComplaintDomHarness();
	harness.setRuntime({
	  baselineTicketId: '',
	  freshRequestConfirmed: false,
	  ticketLocked: false,
	  ticketId: '',
	  routeStep: 0,
	  routeVerified: false,
	  clicked: [],
	  phase: 'route',
	  routeStartedAt: Date.now(),
	});
	harness.page.ticketVisible = false;
	harness.page.newTicketHeaderVisible = true;
	harness.page.ticketId = '90770833';
	harness.page.url = 'https://seller.ozon.ru/app/messenger/?id=b57c88cf-00d8-4481-99df-1f2f779a3b12&group=support_v2';
	harness.page.chatText = '新请求 №90770833 Ozon机器人 请发送被其他卖家使用的商品卡片对应的SKU。';

	const result = harness.evaluate();
	assert.equal(result.status, 'waiting');
	assert.equal(result.ticketId, '');
	assert.equal(result.ticketLocked, false);
	assert.equal(result.freshRequestConfirmed, false);
});

test('scheme1 never reads a historical conversation after the new ticket is locked', () => {
	const harness = createQuickComplaintDomHarness();
	harness.setRuntime({
	  ticketLocked: true,
	  ticketId: '90650002',
	  baselineTicketId: '90596504',
	  ticketMismatchAt: 0,
	  routeStep: 3,
	  routeVerified: true,
	  phase: 'wait-initial-reply',
	  phaseStartedAt: Date.now(),
	});
	harness.page.ticketId = '90596504';
	harness.page.ticketEntries = ['质量检查 / 其他卖家违反平台规则 №90650002'];
	harness.page.chatText = 'Ozon机器人 您在这一天内已超过了此问题的申请次数的限制。您可在24小时后创建新申请。';

	const result = harness.evaluate();
	assert.equal(result.status, 'click-required');
	assert.equal(result.action, 'restore-ticket');
	assert.equal(result.ticketId, '90650002');
	assert.equal(result.expectedTicketId, '90650002');
	assert.equal(result.observedTicketId, '90596504');
	assert.equal(result.x, 60);
	assert.equal(result.y, 40);

	harness.page.ticketId = '90650002';
	const stabilizing = harness.evaluate();
	assert.equal(stabilizing.status, 'waiting');
	assert.equal(stabilizing.action, 'ticket-view-stable');
	assert.equal(stabilizing.ticketId, '90650002');
});

test('scheme1 searches the exact ticket when the locked ticket is not visible in the conversation list', () => {
	const harness = createQuickComplaintDomHarness();
	harness.setRuntime({
	  ticketLocked: true,
	  ticketId: '90650002',
	  routeStep: 3,
	  routeVerified: true,
	  phase: 'wait-initial-reply',
	  phaseStartedAt: Date.now(),
	});
	harness.page.ticketId = '90596504';
	harness.page.chatText = 'Ozon机器人 历史工单内容';

	const result = harness.evaluate();
	assert.equal(result.status, 'ticket-search-required');
	assert.equal(result.action, 'restore-ticket-search');
	assert.equal(result.ticketId, '90650002');
	assert.equal(result.observedTicketId, '90596504');
	assert.equal(result.x, 60);
	assert.equal(result.y, 40);
});

test('scheme1 restores the saved ticket from an unselected support conversation list', () => {
	const harness = createQuickComplaintDomHarness({
	  resumeExisting: true,
	  resumeTicketId: '90771725',
	  resumePhase: 'wait-evidence-prompt',
	});
	harness.page.composerVisible = false;
	harness.page.ticketEntries = ['质量检查 / 其他卖家违反平台规则 №90771725'];

	const result = harness.evaluate();
	assert.equal(result.status, 'click-required');
	assert.equal(result.action, 'restore-ticket');
	assert.equal(result.ticketId, '90771725');
	assert.equal(result.observedTicketId, '');
	assert.equal(result.x, 60);
	assert.equal(result.y, 40);
});

test('scheme1 searches the saved ticket before waiting on an unselected support list', () => {
	const harness = createQuickComplaintDomHarness({
	  resumeExisting: true,
	  resumeTicketId: '90771725',
	  resumePhase: 'wait-evidence-prompt',
	});
	harness.page.composerVisible = false;

	const search = harness.evaluate();
	assert.equal(search.status, 'ticket-search-required');
	assert.equal(search.action, 'restore-ticket-search');
	assert.equal(search.ticketId, '90771725');
	assert.equal(search.observedTicketId, '');

	harness.page.searchValue = '90771725';
	const waiting = harness.evaluate();
	assert.equal(waiting.status, 'waiting');
	assert.equal(waiting.action, 'ticket-search-results');
	assert.equal(waiting.ticketId, '90771725');
});

test('scheme1 reuses the original seller and create-request entries before the frozen complaint route', () => {
	const sellerEntry = createQuickComplaintDomHarness();
	sellerEntry.page.composerVisible = false;
	sellerEntry.page.tileTexts = ['我是卖家'];
	assert.equal(sellerEntry.evaluate().action, 'seller-entry');

	const newRequest = createQuickComplaintDomHarness();
	newRequest.page.composerVisible = false;
	newRequest.page.tileTexts = ['新请求 №91016518', '创建申请'];
	const create = newRequest.evaluate();
	assert.equal(create.status, 'click-required');
	assert.equal(create.action, 'start-new-request');

	const historicalTitle = createQuickComplaintDomHarness();
	historicalTitle.page.composerVisible = false;
	historicalTitle.page.tileTexts = ['新请求'];
	const ignored = historicalTitle.evaluate();
	assert.equal(ignored.status, 'waiting');
	assert.equal(ignored.action, 'new-request');
});

test('scheme1 replays one exact answer once when Ozon repeats the identical prompt', () => {
	const prompt = '请发送被其他卖家使用的商品卡片对应的 SKU';
	const makeHarness = (replayCount) => {
	  const harness = createQuickComplaintDomHarness({
		answeredPromptTicketId: '90650001',
		answeredPromptText: prompt,
		answeredPromptAction: 'original-sku',
		answeredPromptReplayCount: replayCount,
	  });
	  harness.setRuntime({
		ticketLocked: true,
		ticketId: '90650001',
		baselineTicketId: '90596504',
		routeStep: 3,
		routeVerified: true,
		phase: 'wait-follower-prompt',
		phaseStartedAt: Date.now(),
	  });
	  harness.page.chatText = `Ozon机器人 ${prompt} 900000001 Ozon机器人 ${prompt}`;
	  return harness;
	};

	const repeatedOnce = makeHarness(0).evaluate();
	assert.equal(repeatedOnce.status, 'repeat-answer-required');
	assert.equal(repeatedOnce.action, 'original-sku');
	assert.equal(repeatedOnce.promptText, prompt);

	const repeatedAgain = makeHarness(1).evaluate();
	assert.equal(repeatedAgain.status, 'repeated-prompt-limit');
	assert.equal(repeatedAgain.action, 'original-sku');
});

test('scheme1 rebuilds a missing legacy replay baseline only from two identical evidence prompts around one completed message', () => {
	const prompt = '要确认内容的版权，请将证据（截图和指向源文件存储的链接）发给我们。';
	const makeHarness = (replyPrompt) => {
	  const harness = createQuickComplaintDomHarness({
		resumeExisting: true,
		resumeTicketId: '90679417',
		resumePhase: 'wait-initial-reply',
	  });
	  harness.setRuntime({
		ticketLocked: true,
		ticketId: '90679417',
		baselineTicketId: '90596504',
		routeStep: 3,
		routeVerified: true,
		phase: 'wait-initial-reply',
		phaseStartedAt: Date.now(),
	  });
	  harness.page.chatText = `Ozon机器人 ${prompt}01:52 01:53 01:53 initial evidence marker Ozon机器人 ${replyPrompt}01:53 返回`;
	  return harness;
	};

	const recovered = makeHarness(prompt).evaluate();
	assert.equal(recovered.status, 'prompt-replay-baseline-required');
	assert.equal(recovered.action, 'initial-evidence');
	assert.equal(recovered.promptText, prompt);
	assert.equal(recovered.ticketId, '90679417');

	const differentPrompt = makeHarness('请提供另一项不同材料。').evaluate();
	assert.equal(differentPrompt.status, 'waiting');
	assert.equal(differentPrompt.phase, 'wait-initial-reply');
});

test('scheme1 loads older messages and keeps the repeated prompt while the virtual chat window changes', () => {
	const prompt = '要确认内容的版权，请将证据（截图和指向源文件存储的链接）发给我们。';
	const harness = createQuickComplaintDomHarness({
	  resumeExisting: true,
	  resumeTicketId: '90679417',
	  resumePhase: 'wait-initial-reply',
	});
	harness.setRuntime({
	  ticketLocked: true,
	  ticketId: '90679417',
	  routeStep: 3,
	  routeVerified: true,
	  phase: 'wait-initial-reply',
	  phaseStartedAt: Date.now(),
	});

	// The bottom virtual window has the sent evidence and repeated prompt, but
	// the first prompt has already been removed from the rendered DOM.
	harness.page.chatText = `initial evidence marker Ozon机器人 ${prompt}`;
	const loadHistory = harness.evaluate();
	assert.equal(loadHistory.status, 'ticket-history-load-required');
	assert.equal(loadHistory.action, 'load-ticket-history');
	assert.equal(loadHistory.ticketId, '90679417');
	assert.equal(loadHistory.deltaY, 627.3);
	assert.equal(loadHistory.replayDiagnostics.resumeExisting, true);
	assert.equal(loadHistory.replayDiagnostics.initialMessageMarkerCount, 1);
	assert.equal(loadHistory.replayDiagnostics.legacyReplayCandidate, true);
	assert.equal(loadHistory.replayDiagnostics.legacyPreviousPromptLoaded, false);
	assert.equal(loadHistory.replayDiagnostics.historyScrollPointFound, true);

	// Scrolling upward renders the first prompt and the evidence message while
	// virtualizing the latest repeated prompt out. The saved candidate must keep
	// the exact comparison possible without weakening it to keyword matching.
	harness.page.chatText = `Ozon机器人 ${prompt} initial evidence marker`;
	const recovered = harness.evaluate();
	assert.equal(recovered.status, 'prompt-replay-baseline-required');
	assert.equal(recovered.action, 'initial-evidence');
	assert.equal(recovered.promptText, prompt);
});

test('scheme1 real-machine observation mode stops after detecting two identical evidence prompts without sending', () => {
	const prompt = '要确认内容的版权，请将证据（截图和指向源文件存储的链接）发给我们。';
	const harness = createQuickComplaintDomHarness({
	  resumeExisting: true,
	  resumeTicketId: '90679417',
	  resumePhase: 'wait-initial-reply',
	  stopAfterRepeatedPromptDetection: true,
	});
	harness.setRuntime({
	  ticketLocked: true,
	  ticketId: '90679417',
	  routeStep: 3,
	  routeVerified: true,
	  phase: 'wait-initial-reply',
	  phaseStartedAt: Date.now(),
	});
	harness.page.chatText = `Ozon机器人 ${prompt}01:52 01:53 01:53 initial evidence marker Ozon机器人 ${prompt}01:53 返回`;

	const observed = harness.evaluate();
	assert.equal(observed.status, 'repeated-prompt-observed');
	assert.equal(observed.action, 'initial-evidence');
	assert.equal(observed.ticketId, '90679417');
	assert.equal(observed.promptText, prompt);
	assert.equal(observed.replayDiagnostics.legacyPromptsExactMatch, true);
});

test('scheme1 refreshes the exact Ozon ws1006 chat error before resuming an existing ticket', () => {
	const harness = createQuickComplaintDomHarness({
		resumeExisting: true,
		resumeTicketId: '90659866',
		resumePhase: 'wait-evidence-prompt',
	});
	harness.page.composerVisible = false;
	harness.page.chatText = '出了点问题 无法加载聊天列表。请尝试刷新页面。如果仍无法解决，请带上编号联系客服 ws1006';
	harness.page.tileTexts = ['刷新'];

	const result = harness.evaluate();
	assert.deepEqual(result, {
		status: 'conversation-refresh-required',
		action: 'conversation-refresh',
		routeStep: 3,
		phase: 'resume-history',
		ticketId: '90659866',
		waitStartedAt: result.waitStartedAt,
		x: 60,
		y: 40,
		url: 'https://seller.ozon.ru/app/messenger?group=support_v2',
	});
});

test('scheme1 opens new complaints through the original SCRM entry and resumes saved support tickets directly', () => {
	const quickComplaint = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
	const harness = createQuickComplaintDomHarness({
		resumeExisting: true,
		resumeTicketId: '90659866',
		resumePhase: 'wait-evidence-prompt',
	});
	harness.page.url = 'https://seller.ozon.ru/app/messenger?group=customers_v2&helpCenter=page';

	const result = harness.evaluate();
	assert.deepEqual(result, {
		status: 'navigate-required',
		action: 'open-support',
		targetUrl: 'https://seller.ozon.ru/app/messenger?group=support_v2',
		url: harness.page.url,
	});

	const newRequest = createQuickComplaintDomHarness();
	newRequest.page.composerVisible = false;
	newRequest.page.url = 'https://seller.ozon.ru/app/messenger?channel=SCRM';
	const entry = newRequest.evaluate();
	assert.equal(entry.status, 'waiting');
	assert.equal(entry.action, 'new-request');
	assert.match(quickComplaint, /QuickComplaintEntryUrl\(resumeExisting, resumePageUrl\)/u);
	assert.match(quickComplaint, /OzonSellerQuickComplaintUrl = "https:\/\/seller\.ozon\.ru\/app\/messenger\?channel=SCRM"/u);
	assert.match(quickComplaint, /group=support_v2/u);
	assert.doesNotMatch(quickComplaint, /url\.searchParams\.get\('helpCenter'\) === 'page'/u);
	assert.match(quickComplaint, /currentUrl\.searchParams\.get\('channel'\) === 'SCRM'/u);
});

test('scheme1 refreshes a stalled existing-ticket or new-request skeleton only before sending', () => {
	const quickComplaint = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
	const harness = createQuickComplaintDomHarness({
		resumeExisting: true,
		resumeTicketId: '90659866',
		resumePhase: 'wait-evidence-prompt',
	});
	harness.page.composerVisible = false;
	harness.page.searchVisible = false;

	const loading = harness.evaluate();
	assert.equal(loading.status, 'waiting');
	assert.equal(loading.action, 'conversation-loading');
	assert.equal(loading.ticketId, '90659866');
	assert.match(quickComplaint, /IsQuickConversationSkeletonStalled\([\s\S]*?resumeExisting[\s\S]*?resumeTicketId/u);
	assert.match(quickComplaint, /bool exactExistingTicketSkeleton = resumeExisting[\s\S]*?action == "conversation-loading"/u);
	assert.match(quickComplaint, /bool newRequestSkeleton = !resumeExisting[\s\S]*?action == "new-request"/u);
	assert.match(quickComplaint, /ticketId\.Equals\(resumeTicketId, StringComparison\.Ordinal\)/u);
	assert.match(quickComplaint, /DateTimeOffset\.UtcNow\.ToUnixTimeMilliseconds\(\) - waitStartedAt >= 15000L/u);
	assert.match(quickComplaint, /status == "conversation-refresh-required" \|\| stalledConversationSkeleton/u);
	assert.match(quickComplaint, /Volatile\.Read\(ref submissionStarted\) != 0[\s\S]*?conversationRefreshAttempts >= 3/u);
	assert.match(quickComplaint, /FindQuickSupportNavigationAsync\(browser\)[\s\S]*?DispatchQuickSessionPageClickAsync\(browser, x, y\)/u);
	assert.match(quickComplaint, /conversationNavigationRecoveryAt < TimeSpan\.FromSeconds\(20\)/u);
});

test('scheme1 preserves seller credentials and only rebuilds transient support cookies after confirmed chat failure', () => {
	const quickComplaint = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
	const controller = fs.readFileSync(
		path.join(desktopRoot, 'src', 'purchaseBrowser', 'cefPurchaseBrowserController.js'),
		'utf8',
	);
	assert.match(quickComplaint, /QuickComplaintTransportCookieNames[\s\S]*?__Secure-sid[\s\S]*?__Secure-sso-state[\s\S]*?__Secure-token[\s\S]*?__Secure-ETC/u);
	assert.match(quickComplaint, /conversationRefreshAttempts >= 3[\s\S]*?!conversationTransportRecoveryAttempted[\s\S]*?RefreshQuickComplaintTransportSessionAsync\(requestContext\)/u);
	assert.match(quickComplaint, /DeleteCookiesAsync\("https:\/\/seller\.ozon\.ru\/", cookieName\)[\s\S]*?FlushStoreAsync/u);
	assert.doesNotMatch(quickComplaint, /__Secure-access-token|__Secure-refresh-token|sc_company_id/u);
	assert.doesNotMatch(quickComplaint, /navigator\.serviceWorker\.getRegistrations|caches\.delete/u);
	assert.match(quickComplaint, /SubmitOzonFollowSellerQuickComplaintAsync\([\s\S]*?ChromiumWebBrowser sessionBrowser[\s\S]*?ChromiumWebBrowser\? browser = sessionBrowser/u);
	assert.match(quickComplaint, /Cleanup\(\(\) => completion\.TrySetResult\(result\)\)[\s\S]*?browser = null/u);
	assert.doesNotMatch(quickComplaint, /browser\.Dispose\(\)|ReleaseRequestContext\(profile\.StorageRef\)/u);
	assert.match(
		quickComplaint,
		/return await SubmitOzonFollowSellerQuickComplaintCoreAsync\([\s\S]*?profile,[\s\S]*?requestContext,/u,
	);
	assert.match(
		controller,
		/const persistLoginVerification = false;[\s\S]*?persist: persistLoginVerification/u,
	);
	assert.match(
		controller,
		/stopBeforeFirstMessage: command === 'ozon-submit-follow-seller-quick-complaint'[\s\S]*?stopBeforeFirstMessage === true/u,
	);
});

test('scheme1 visualization reveals the exact temporary browser without interrupting automation', () => {
	const quickComplaint = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
	const host = nativeSource('BrowserHostForm.cs');
	const controller = fs.readFileSync(
		path.join(desktopRoot, 'src', 'purchaseBrowser', 'cefPurchaseBrowserController.js'),
		'utf8',
	);

	assert.doesNotMatch(quickComplaint, /class FollowSellerQuickBrowserSurface : Form/u);
	assert.match(quickComplaint, /RestoreSessionForObservation\(ownerRef\)/u);
	assert.match(host, /RestoreSessionForObservation\(string ownerRef\)[\s\S]*?allowBackground: true/u);
	assert.match(host, /private void ActivateSession\(string ownerRef, bool allowBackground\)[\s\S]*?if \(allowBackground\)[\s\S]*?session\.Value\.Browser\.Visible = session\.Key == ownerRef/u);
	assert.match(host, /private void RestoreSession\(string ownerRef, bool allowBackground\)[\s\S]*?ActivateSession\(ownerRef, allowBackground\)[\s\S]*?BringToFront\(\)[\s\S]*?Activate\(\)/u);
	assert.match(quickComplaint, /IsQuickComplaintOzonUrl\(currentUrl\)[\s\S]*?FOLLOW_SELLER_SCHEME1_BROWSER_TARGET_INVALID/u);
	assert.match(quickComplaint, /activeOwnerRef\.Equals\(ownerRef[\s\S]*?ReferenceEquals\(Active\.Browser, activeFollowSellerQuickBrowser\)/u);
	assert.match(quickComplaint, /ReportOnce\("browser-surface-ready", "方案1内置浏览器已经就绪，可点击“可视化操作页面”查看实时页面"\)/u);
	assert.match(host, /FormClosing[\s\S]*?e\.Cancel = true[\s\S]*?HideBrowser\(\)/u);
	assert.match(host, /private void HideBrowser\(bool fenceVisibility\)[\s\S]*?SetWindowPos\([\s\S]*?-32000,[\s\S]*?-32000,[\s\S]*?SwpHideWindow/u);
	assert.match(quickComplaint, /ReferenceEquals\(activeFollowSellerQuickBrowser, browser\)[\s\S]*?browserPresentationVisible[\s\S]*?HideBrowser\(fenceVisibility: false\)/u);
	assert.match(host, /case "show-follow-seller-quick-browser":[\s\S]*?ShowFollowSellerQuickBrowserAsync\(ownerRef\)/u);
	assert.match(controller, /command === 'show-follow-seller-quick-browser'[\s\S]*?executeCommand\(input\)/u);
	assert.match(quickComplaint, /WaitForQuickComplaintHumanVerificationAsync[\s\S]*?RestoreSessionForObservation\(ownerRef\)/u);
	assert.match(quickComplaint, /status == "captcha"[\s\S]*?await WaitForQuickComplaintHumanVerificationAsync\([\s\S]*?continue;/u);
	assert.match(quickComplaint, /stableClearReads >= 3/u);
	assert.match(quickComplaint, /Ozon 要求人机验证，已弹出当前内置浏览器/u);
	assert.match(quickComplaint, /人机验证已通过，正在从当前步骤自动继续/u);
});

test('scheme1 clicks support controls inside the reused page without disposing the session browser', () => {
	const quickComplaint = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
	const sessionClick = quickComplaint.match(
		/private static async Task DispatchQuickSessionPageClickAsync[\s\S]*?\n\t\}/u,
	)?.[0] || '';

	assert.match(sessionClick, /document\.elementFromPoint[\s\S]*?target\.click\(\)/u);
	assert.match(sessionClick, /EvaluateScriptAsync/u);
	assert.doesNotMatch(sessionClick, /GetBrowser\(\)|GetBrowserHost\(\)|GetDevToolsClient|DevToolsClient/u);
});

test('scheme1 continuation sends missing evidence text without uploading completed images again', () => {
	const harness = createQuickComplaintDomHarness({
	  resumeExisting: true,
	  resumeTicketId: '90650001',
	  resumePhase: 'wait-evidence-prompt',
	  expectedInitialAttachmentCount: 6,
	});
	harness.page.chatText = '900000001 3771432837 请将证据和源文件发送到当前对话';
	harness.page.historyImageCount = 6;

	const repair = harness.evaluate();
	assert.equal(repair.status, 'type-message-required');
	assert.equal(repair.action, 'repair-initial-text');
	assert.equal(repair.ticketId, '90650001');
});

test('scheme1 stages every image, sends residual text after attachment delivery and requires both history readbacks', () => {
  const quickComplaint = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
  const complaint = nativeSource('BrowserHostForm.FollowSellerComplaint.cs');

	  assert.match(quickComplaint, /GetQuickHistoryImageCountAsync\(browser\)[\s\S]*?TypeQuickComplaintMessageAsync\(browser, message\)[\s\S]*?AttachComplaintFilesAsync\(browser, attachmentPaths\)[\s\S]*?WaitForQuickAttachmentSendReadinessAsync\([\s\S]*?beforeHistoryImageCount[\s\S]*?CaptureQuickScreenshotAsync\([\s\S]*?onSubmissionStarted\?\.Invoke\(\);[\s\S]*?ClickQuickComplaintSendAsync\([\s\S]*?requireMessageReadback: false[\s\S]*?WaitForQuickBundleSubmissionReadbackAsync/u);
	  assert.match(quickComplaint, /attachmentsSent && messageStillInComposer && sendReady && !confirm[\s\S]*?!residualTextSent[\s\S]*?ClickQuickComplaintSendAsync\([\s\S]*?requireMessageReadback: false[\s\S]*?residualTextSent = true/u);
	  assert.match(quickComplaint, /messageSent && inputText === '' && attachmentsSent/u);
	assert.match(quickComplaint, /onConfirm\?\.Invoke\(\)[\s\S]*?DispatchQuickSessionPageClickAsync/u);
  assert.match(quickComplaint, /ok: messageSent && inputText === '' && attachmentsSent/u);
  assert.doesNotMatch(quickComplaint, /botReplyAdvanced/u);
  assert.doesNotMatch(quickComplaint, /WaitForQuickAttachmentReadbackAsync/u);
	  assert.match(quickComplaint, /initialImagesAlreadySent[\s\S]*?runtime\.phase = 'repair-initial-text'/u);
	  assert.match(quickComplaint, /!hasInitialMessage && \(insufficientPrompt \|\| batchPrompt \|\| hasBatchMessage\)/u);
  assert.match(quickComplaint, /!hasSupplementMessage && \(batchPrompt \|\| hasBatchMessage\)/u);
  assert.match(quickComplaint, /if \(!hasInitialMessage[\s\S]*?runtime\.phase = 'repair-initial-text';[\s\S]*?else if \(!hasSupplementMessage[\s\S]*?runtime\.phase = 'repair-supplement-text';[\s\S]*?else if \(hasBatchMessage\) runtime\.phase = 'submitted-awaiting-support-reply'/u);
  assert.match(complaint, /TypeQuickComplaintMessageAsync\(browser, message\)[\s\S]*?AttachComplaintFilesAsync\(browser, attachmentPaths\)[\s\S]*?ClickQuickComplaintSendAsync\(browser, message, requireMessageReadback: false\)[\s\S]*?WaitForComplaintDocumentSubmissionReadbackAsync/u);
});

test('scheme1 streams real browser steps to the UI and keeps raw errors out of the table', () => {
  const quickComplaint = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
  const controller = fs.readFileSync(
    path.join(desktopRoot, 'src', 'purchaseBrowser', 'cefPurchaseBrowserController.js'),
    'utf8',
  );
  const service = fs.readFileSync(
    path.join(workspaceRoot, 'frontend', 'src', 'features', 'followSellerDefense', 'services', 'followSellerDefenseService.js'),
    'utf8',
  );
  const page = fs.readFileSync(
    path.join(workspaceRoot, 'frontend', 'src', 'features', 'followSellerDefense', 'FollowSellerDefensePage.jsx'),
    'utf8',
  );
  const display = fs.readFileSync(
    path.join(workspaceRoot, 'frontend', 'src', 'features', 'followSellerDefense', 'lib', 'followSellerDefenseDisplay.js'),
    'utf8',
  );

  assert.match(quickComplaint, /eventName = "follow-seller-scheme1-progress"/u);
  assert.match(quickComplaint, /正在选择“商品和价格”/u);
  assert.match(quickComplaint, /正在选择“质量监督”/u);
  assert.match(quickComplaint, /正在选择“卖家使用我的内容”/u);
  assert.match(quickComplaint, /正在一次性发送说明和/u);
  assert.match(quickComplaint, /已取得 Ozon 工单/u);
  assert.match(controller, /event === 'follow-seller-scheme1-progress'/u);
  assert.match(controller, /progressToken: cleanOptionalText\(details\.progressToken, 200\)/u);
  assert.match(service, /payload\.event !== 'follow-seller-scheme1-progress'/u);
  assert.match(service, /progressToken: item\.progressToken/u);
  assert.match(page, /Scheme1ProgressPanel/u);
  assert.doesNotMatch(page, /这里直接读取当前店铺上次已经保存的巡查结果/u);
  assert.match(display, /FOLLOW_SELLER_SCHEME1_BACKEND_ROUTE_CHANGED/u);
  assert.match(display, /PURCHASE_BROWSER_CEF_FAILED/u);
});

test('scheme2 enforces the complete Ozon prompt-gated evidence workflow', () => {
  const complaint = nativeSource('BrowserHostForm.FollowSellerComplaint.cs');
  const quickComplaint = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
  const session = nativeSource('BrowserSession.cs');

  assert.match(session, /ozon-prepare-follow-seller-scheme2-evidence/u);
  assert.match(session, /PrepareOzonFollowSellerScheme2EvidenceAsync/u);
  assert.match(session, /ozon-submit-follow-seller-complaint/u);
  assert.match(complaint, /\["workflow"\] = "ozon-scheme2-browser-evidence-v1"/u);
  assert.match(quickComplaint, /own-product-page\.png/u);
  assert.match(quickComplaint, /own-seller-list\.png/u);
  assert.match(complaint, /scheme2-evidence-capture\.json/u);
  assert.match(complaint, /ParseComplaintSupplement/u);
  assert.match(complaint, /kind != "supplement_image"/u);
  assert.match(complaint, /Path\.GetExtension\(attachmentPaths\[0\]\).*?"\.psd"/su);
  assert.match(complaint, /Path\.GetExtension\(attachmentPaths\[1\]\).*?"\.pdf"/su);
  assert.match(complaint, /WaitForComplaintDocumentSubmissionReadbackAsync/u);
  assert.match(complaint, /namedCount === expectedNames\.length \|\| documentCount - beforeCount >= expectedNames\.length/u);
  assert.match(complaint, /stableReads >= 3/u);
  assert.match(complaint, /PrimeQuickComplaintRuntimeAsync\(browser, evidenceId, ticketId, 3\)/u);
  assert.match(complaint, /"original-sku" => originalSku/u);
  assert.match(complaint, /"follower-sku" => followerSkus\[0\]/u);
  assert.match(complaint, /"follower-batch" => followerBatchText/u);
  assert.match(complaint, /status == "initial-evidence-required"/u);
  assert.match(complaint, /status == "supplement-required"/u);
  assert.match(complaint, /SubmitComplaintDocumentBundleAsync/u);
  assert.match(complaint, /SubmitQuickComplaintBundleAsync/u);
  assert.match(complaint, /scheme2-browser-evidence\.json/u);
  assert.match(complaint, /initialAttachmentOrder/u);
  assert.match(complaint, /supplementAttachmentOrder/u);
  assert.match(complaint, /workflowTimeline/u);
  assert.match(complaint, /scheme2-diagnostic\.json/u);
  assert.match(complaint, /scheme2-diagnostic\.png/u);
  assert.match(complaint, /browser\.Dispose\(\)[\s\S]*?surface\.Close\(\)/u);
  assert.doesNotMatch(complaint, /status == "ready-to-submit"/u);

	  assert.match(quickComplaint, /runtime\.routeVerified && runtime\.routeStep >= route\.length && runtime\.phase === 'route' && ownPrompt/u);
  assert.match(quickComplaint, /runtime\.phase === 'wait-follower-prompt' && followerPrompt/u);
  assert.match(quickComplaint, /runtime\.phase === 'wait-evidence-prompt' && evidencePrompt/u);
  assert.match(quickComplaint, /runtime\.phase === 'wait-initial-reply'/u);
  assert.match(quickComplaint, /insufficientPrompt && reply/u);
  assert.match(quickComplaint, /runtime\.phase === 'wait-supplement-reply'/u);
  assert.match(quickComplaint, /batchPrompt && \/sku\/i\.test\(reply\) && textarea/u);
  assert.match(quickComplaint, /status: 'materials-rejected'/u);
});

test('follow seller submission keeps real-send guards without a points billing flow', () => {
  const quickComplaint = nativeSource('BrowserHostForm.FollowSellerQuickComplaint.cs');
  const complaint = nativeSource('BrowserHostForm.FollowSellerComplaint.cs');
  const hook = fs.readFileSync(
    path.join(workspaceRoot, 'frontend', 'src', 'features', 'followSellerDefense', 'model', 'useFollowSellerDefense.js'),
    'utf8',
  );
  const page = fs.readFileSync(
    path.join(workspaceRoot, 'frontend', 'src', 'features', 'followSellerDefense', 'FollowSellerDefensePage.jsx'),
    'utf8',
  );

  for (const source of [quickComplaint, complaint]) {
    assert.match(source, /Interlocked\.Exchange\(ref submissionStarted, 1\)/u);
    assert.match(source, /\["submissionStarted"\] = Volatile\.Read\(ref submissionStarted\) == 1/u);
    assert.match(source, /\["ok"\] = false/u);
  }
  assert.doesNotMatch(hook, /followSellerBillingService|assertFollowSellerPointBalance|isFollowSellerExecutionBillable|spendFollowSellerExecutionPoints|billing/u);
  assert.match(hook, /prepareFollowSellerVerification/u);
  assert.match(hook, /cooldownDelaysMs: \[\]/u);
  assert.match(hook, /本次只扫描一个商品/u);
  assert.doesNotMatch(page, /FOLLOW_SELLER_POINTS_PER_CASE|积分/u);
  assert.match(page, /复查剔除结果/u);
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, 'frontend', 'src', 'features', 'followSellerDefense', 'services', 'followSellerBillingService.js')),
    false,
  );
});
