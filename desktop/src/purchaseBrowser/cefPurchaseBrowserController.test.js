import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCefPurchaseBrowserController,
  followSellerCollectorOwnerRef,
  marketCollectorOwnerRef,
  ozonFollowSellerCommandTimeoutMs,
  productLinkParserOwnerRef,
  PURCHASE_BROWSER_PURGE_RESOURCE_IDS,
  INTEGRATION_BROWSER_PURGE_RESOURCE_IDS,
} from './cefPurchaseBrowserController.js';
import {
  BUILT_IN_CEF_ADDON,
  BUILT_IN_CROSS_BORDER_ADDON,
} from './purchaseBrowserBuiltinManager.js';
import { createPurchaseBrowserPolicy } from './purchaseBrowserPolicy.js';
import { createPurchaseBrowserProfileStore } from './purchaseBrowserProfileStore.js';

const FIXTURE_URL = 'http://127.0.0.1:49152/purchase-fixture';

test('follow-seller queue timeout scales with the SKU workload', () => {
  assert.equal(ozonFollowSellerCommandTimeoutMs([]), 95_000);
  assert.equal(ozonFollowSellerCommandTimeoutMs(['1760246018']), 95_000);
  assert.equal(ozonFollowSellerCommandTimeoutMs(
    Array.from({ length: 250 }, (_, index) => String(1760246000 + index)),
  ), 135_000);
  assert.equal(ozonFollowSellerCommandTimeoutMs(
    Array.from({ length: 1_000 }, (_, index) => String(1760246000 + index)),
  ), 275_000);
});

function createFixture({
  blockPagination = false,
	paginationFailures = 0,
	blockFollowSellerCapture = false,
  embeddedSurfaceWarmupFailures = 0,
  inspectContextFailures = 0,
  recoverableNavigateFailures = 0,
  pinduoduoOrderCaptures = [],
  alibaba1688OrderCapture = null,
  genericPurchaseCapture = null,
  genericInspection = null,
  rehearsalAccounts = null,
  rehearsalPurchaseSourceLinks = [],
  rehearsalProductSourceLinks = [],
  purchaseReadback = null,
  purchaseCaptureConflicts = [],
  standaloneBoundsClamp = null,
  runtimePageTitle = 'CEF Fixture',
  ozonLoginVerification = null,
  integrationLoginSaveFailures = 0,
  alipayPaymentWindowController = null,
  emptyPurchaseSessionCookies = false,
  getAlipayLoginCredential = async () => null,
  saveAlipayLoginCredential = async (input) => ({ ok: true, ...input }),
  clearAlipayLoginCredential = async () => ({ ok: true }),
  getAlipayLoginCredentialStatus = async () => ({ configured: false, loginAccount: '' }),
  resolveFollowSellerAutoProxy = async () => null,
  preparedRemoval = null,
  removalObserveTimeoutMs = 20_000,
  removalOperationReadback = operationId => ({ operationId, completed: false }),
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cef-controller-'));
  const profiles = createPurchaseBrowserProfileStore({
    filePath: path.join(directory, 'profiles.enc.json'),
    protector: {
      protect: (value) => Buffer.from(value, 'utf8'),
      unprotect: (value) => Buffer.from(value).toString('utf8'),
    },
    baseUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36',
  });
  const addonOwners = new Set();
  const addonManager = {
    install: ({ ownerRef }) => {
      addonOwners.add(ownerRef);
      return {
        directory: path.join(directory, 'addon'),
        installState: 'active',
        extensionId: 'purchase-browser@wangzai.local',
        extensionVersion: '4.0.0',
        packageSha256: 'd'.repeat(64),
      };
    },
    purgeOwner(ownerRef) { addonOwners.delete(ownerRef); },
    readState(ownerRef) { return { activeSha: addonOwners.has(ownerRef) ? 'd'.repeat(64) : '' }; },
  };
  const sessions = new Map();
  const runtimeOpenCalls = [];
  let remainingEmbeddedSurfaceWarmupFailures = Math.max(0, Number(embeddedSurfaceWarmupFailures) || 0);
  let remainingInspectContextFailures = Math.max(0, Number(inspectContextFailures) || 0);
  let remainingRecoverableNavigateFailures = Math.max(0, Number(recoverableNavigateFailures) || 0);
  let remainingPaginationFailures = Math.max(0, Number(paginationFailures) || 0);
  let remainingIntegrationLoginSaveFailures = Math.max(0, Number(integrationLoginSaveFailures) || 0);
  const pendingPinduoduoOrderCaptures = [...pinduoduoOrderCaptures];
  let lastPinduoduoOrderCapture = pendingPinduoduoOrderCaptures.at(-1) || null;
  let resolvePaginationStarted;
  const paginationStarted = new Promise((resolve) => { resolvePaginationStarted = resolve; });
	let resolveFollowSellerCaptureStarted;
	let releaseFollowSellerCapture;
	const followSellerCaptureStarted = new Promise((resolve) => { resolveFollowSellerCaptureStarted = resolve; });
	const followSellerCaptureRelease = new Promise((resolve) => { releaseFollowSellerCapture = resolve; });
  const runtime = {
    open: async ({ profile, profileRoot, downloadsDirectory, url, initialBounds, navigationWaitUntil, workbench }) => {
    runtimeOpenCalls.push({
      ownerRef: profile.ownerRef,
      storageRef: profile.storageRef,
      browserRole: profile.browserRole,
      background: profile.background === true,
      proxy: { ...profile.proxy },
      initialBounds: { ...initialBounds },
      navigationWaitUntil,
      workbench,
      url,
    });
      const profileDirectory = path.join(profileRoot, profile.ownerRef);
      fs.mkdirSync(profileDirectory, { recursive: true });
      fs.mkdirSync(downloadsDirectory, { recursive: true });
      const state = {
        url,
        title: runtimePageTitle,
        loading: false,
        crashed: false,
        canGoBack: false,
        canGoForward: false,
        extensionVersion: '4.0.1',
        crossBorderVersion: '1.0.11',
      };
      let receipt = null;
      const listeners = new Set();
      const browser = {
        state,
        bounds: null,
        boundsRequestCount: 0,
        requests: [],
        requestPayloads: [],
        visible: false,
        workbench: workbench || null,
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async request(command, payload = {}, _timeoutMs, signal) {
          browser.requests.push(command);
          browser.requestPayloads.push({ command, payload });
          if (command === 'bounds') {
            browser.boundsRequestCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            browser.visible = payload.bounds?.visible === true;
            browser.bounds = { ...payload.bounds };
            const embedded = browser.workbench?.displayMode === 'embedded';
            if (browser.visible && !embedded && typeof standaloneBoundsClamp === 'function') {
              browser.bounds = { ...standaloneBoundsClamp(browser.bounds) };
            }
            const surfaceVisible = browser.visible && (
              !embedded || remainingEmbeddedSurfaceWarmupFailures <= 0
            );
            if (browser.visible && embedded && remainingEmbeddedSurfaceWarmupFailures > 0) {
              remainingEmbeddedSurfaceWarmupFailures -= 1;
            }
            const nativeBounds = embedded && !browser.visible
              ? { ...browser.bounds, x: -32000, y: -32000 }
              : { ...browser.bounds };
            state.embedding = {
              requested: embedded,
              embedded,
              childStyle: embedded,
              parentHwnd: embedded ? '123' : '0',
              actualParentHwnd: embedded ? '123' : '0',
              windowStyle: embedded ? '0x56000000' : '0x86000000',
			  windowVisible: browser.visible,
			  browserPanelVisible: browser.visible,
			  browserPresentationVisible: browser.visible,
			  browserSurfaceVisible: surfaceVisible,
			  chromiumWindows: [{
			    hwnd: '456',
			    parentHwnd: '123',
			    className: 'Chrome_WidgetWin_0',
			    visible: browser.visible,
			    onScreen: surfaceVisible,
			    bounds: nativeBounds,
			  }],
              bounds: nativeBounds,
            };
          } else if (command === 'show-follow-seller-verification-browser') {
            browser.visible = true;
            state.embedding = {
              requested: false,
              embedded: false,
              childStyle: false,
              windowVisible: true,
              browserPanelVisible: true,
              browserPresentationVisible: true,
              browserSurfaceVisible: true,
              chromiumWindows: [{ visible: true, onScreen: true }],
              bounds: browser.bounds || { x: 120, y: 100, width: 1280, height: 800 },
            };
            return {
              ok: true,
              visible: true,
              windowVisible: true,
              browserPanelVisible: true,
              browserPresentationVisible: true,
              browserControlVisible: true,
              embedding: state.embedding,
            };
          } else if (command === 'hide-follow-seller-verification-browser') {
            browser.visible = false;
            state.embedding = {
              ...(state.embedding || {}),
              windowVisible: false,
              browserPanelVisible: false,
              browserPresentationVisible: false,
              browserSurfaceVisible: false,
            };
            return { ok: true, visible: false, embedding: state.embedding };
          } else if (command === 'follow-seller-verification-status') {
            const challengeDetected = String(state.url || '').includes('__rr');
            return {
              pageReady: true,
              challengeDetected,
              verificationReady: !challengeDetected,
              url: state.url,
            };
          } else if (command === 'navigate') {
            if (remainingRecoverableNavigateFailures > 0) {
              remainingRecoverableNavigateFailures -= 1;
              const error = new Error('PURCHASE_BROWSER_COMMAND_TIMEOUT');
              error.code = 'PURCHASE_BROWSER_COMMAND_TIMEOUT';
              throw error;
            }
            state.url = payload.url;
            state.title = 'CEF Fixture';
          } else if (command === 'workbench') {
            browser.workbench = payload.workbench || null;
          } else if (command === 'execute') {
            receipt = {
              orderNumber: 'fixture-order-001',
              amount: Number(payload.task.expectedAmount).toFixed(2),
              status: '已提交',
              pageUrl: state.url,
            };
            return receipt;
          } else if (command === 'cross-border-sync') {
            return { ok: true, total: 1, synced: 1, commit: payload.commit !== false };
          } else if (command === 'ozon-login-status') {
			return (typeof ozonLoginVerification === 'function'
			  ? await ozonLoginVerification({ command, payload, profile, state })
			  : ozonLoginVerification) || {
              loggedIn: true,
              cookieSaved: true,
              cookieCount: 7,
              verifiedAt: '2026-07-21T08:00:00.000Z',
            };
          } else if (command === 'ozon-open-order') {
            return {
              ok: true,
              exact: true,
              opened: true,
              posting: payload.postingNumber,
              pageUrl: `${state.url}/${encodeURIComponent(payload.postingNumber)}`,
              confirmation: 'url',
            };
          } else if (command === 'purchase-login-status') {
            return {
              loggedIn: true,
              cookieSaved: true,
              cookieCount: 6,
              platformKey: profile.platformKey,
              verificationSource: 'strong-auth-cookie',
              verifiedAt: '2026-08-11T08:30:00.000Z',
            };
          } else if (command === 'import-purchase-session-cookies') {
            return {
              ok: true,
              importedCookieCount: Array.isArray(payload.cookies) ? payload.cookies.length : 0,
              cookieSaved: Array.isArray(payload.cookies) && payload.cookies.length > 0,
            };
          } else if (command === 'export-purchase-session-cookies') {
            if (emptyPurchaseSessionCookies) return { ok: true, cookies: [] };
            const cookie = profile.platformKey === '1688'
              ? { name: '_m_h5_tk', value: 'fixture-1688-token', domain: '.1688.com' }
              : ['taobao', 'tmall'].includes(profile.platformKey)
                ? { name: '_tb_token_', value: 'fixture-taobao-token', domain: '.taobao.com' }
                : { name: 'PDDAccessToken', value: 'fixture-pdd-access-token', domain: '.yangkeduo.com' };
            return {
              ok: true,
              cookies: [{
                ...cookie,
                path: '/',
                secure: true,
                httpOnly: false,
              }],
            };
          } else if (command === 'ozon-data-status') {
            return {
              installed: true,
              enabled: true,
              ready: true,
              extensionId: 'abcdefghijklmnopabcdefghijklmnop',
              extensionVersion: '2.0.0',
              runtime: { ready: true, version: '2.0.0', queueLength: 1, lastSequence: 4 },
            };
          } else if (command === 'ozon-data-read') {
            return {
              ready: true,
              version: '2.0.0',
              queueLength: payload.drain ? 0 : 1,
              lastSequence: 4,
              entries: [{
                sequence: 4,
                endpoint: '/api/site/exa-products-api/missing_items',
                payload: { items: [{ sku: 123 }] },
              }],
            };
          } else if (command === 'ozon-data-catalog') {
            return { ready: true, version: '2.0.0', endpointCount: 1, endpoints: [] };
          } else if (command === 'ozon-data-normalize') {
            return { ready: true, version: '2.0.0', datasets: [{ sequence: 4, records: [{ id: 123 }] }] };
          } else if (command === 'ozon-data-payload') {
            return {
              ready: true,
              version: '2.1.0',
              sourceSequence: payload.sourceSequence,
              offset: payload.offset,
              nextOffset: 2,
              totalChars: 2,
              complete: true,
              encoding: 'json',
              chunk: '{}',
            };
          } else if (command === 'ozon-data-search') {
            return {
              ready: true,
              version: '2.2.0',
              sourceSequence: payload.sourceSequence,
              query: payload.query,
              capturedSequence: 8,
              status: 200,
              quality: 'confirmed-data',
              recordCount: 5,
            };
          } else if (command === 'ozon-data-probe') {
            return {
              ready: true,
              version: '2.4.0',
              sourceSequence: payload.sourceSequence,
              capturedSequence: 9,
              endpoint: payload.path,
              status: 200,
              quality: 'confirmed-data',
              recordCount: 50,
            };
          } else if (command === 'ozon-data-follow-sellers') {
			if (blockFollowSellerCapture) {
			  resolveFollowSellerCaptureStarted();
			  await followSellerCaptureRelease;
			}
            return {
              ready: true,
              source: 'ozon-public-other-offers',
              requested: payload.skus.length,
              confirmed: payload.skus.length,
              failed: 0,
              results: payload.skus.map((sku) => ({
                sku,
                confirmed: true,
                followSellerCount: 2,
                followMinPrice: 1200,
                followMaxPrice: 1500,
              })),
            };
          } else if (command === 'ozon-submit-follow-seller-complaint') {
            return {
              ok: true,
              ticketId: 'ticket-10001',
              messageId: 'ticket-10001',
              evidenceId: payload.evidenceId,
              submittedAt: '2026-08-15T08:00:00.000Z',
            };
          } else if (command === 'ozon-submit-follow-seller-quick-complaint') {
            return {
              ok: true,
              scheme: 'scheme1-seller-backend',
              ticketId: 'ticket-scheme1-10001',
              messageId: 'ticket-scheme1-10001',
              evidenceId: payload.evidenceId,
              submittedAt: '2026-08-15T08:00:00.000Z',
            };
          } else if (command === 'ozon-data-paginate') {
            if (remainingPaginationFailures > 0) {
              remainingPaginationFailures -= 1;
              const error = new Error('PURCHASE_BROWSER_COMMAND_TIMEOUT');
              error.code = 'PURCHASE_BROWSER_COMMAND_TIMEOUT';
              throw error;
            }
            if (blockPagination) {
              resolvePaginationStarted();
              return await new Promise((resolve, reject) => {
                signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('cancelled'), {
                  code: 'PURCHASE_BROWSER_COMMAND_CANCELLED',
                })), { once: true });
              });
            }
            return { ready: true, version: '2.0.0', sourceSequence: payload.sourceSequence, pagesFetched: 2 };
          } else if (command === 'ozon-data-cancel-pagination') {
            return { ready: true, version: '2.6.5', cancelled: true, generation: 2 };
          } else if (command === 'inspect') {
            if (remainingInspectContextFailures > 0) {
              remainingInspectContextFailures -= 1;
              throw Object.assign(new Error('PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY'), {
                code: 'PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY',
              });
            }
            return receipt || genericInspection || {
              fixture: true,
              extensionVersion: '4.0.1',
        crossBorderVersion: '1.0.11',
              platform: 'fixture',
              pageUrl: state.url,
              pageTitle: state.title,
            };
          } else if (command === 'inspect-pinduoduo-order') {
            if (pendingPinduoduoOrderCaptures.length) {
              lastPinduoduoOrderCapture = pendingPinduoduoOrderCaptures.shift();
            }
            return lastPinduoduoOrderCapture || {
              platform: '拼多多',
              pageType: 'unknown',
              pageUrl: state.url,
              sourceUrl: state.url,
              purchaseOrderStatus: '',
              paymentConfirmed: false,
            };
          } else if (command === 'inspect-1688-order') {
            return alibaba1688OrderCapture || {
              platform: '1688',
              pageType: 'order-list',
              pageUrl: state.url,
              sourceUrl: state.url,
              orderCandidates: [],
            };
          } else if (command === 'capture-purchase') {
            return genericPurchaseCapture || {
              platform: 'unknown',
              pageType: 'unknown',
              pageUrl: state.url,
            };
          }
          return { ...state, ...(command === 'bounds' ? { bounds: { ...browser.bounds } } : {}) };
        },
        emit(event, details) { for (const listener of listeners) listener(event, details); },
      };
      sessions.set(profile.ownerRef, browser);
      return browser;
    },
    close: async (ownerRef) => {
      const existed = sessions.delete(ownerRef);
      return { ok: true, existed };
    },
    forceTerminate: (ownerRef) => {
      const existed = sessions.delete(ownerRef);
      return { ok: true, existed };
    },
    get: (ownerRef) => sessions.get(ownerRef) || null,
    dispose() { sessions.clear(); },
    nativeWindowHandle: () => '123',
  };
  const bindings = {
    'account-a': { accountId: 'account-a', accountIncarnation: '2026-07-17T00:00:00.000Z', platformName: '1688' },
    'account-b': { accountId: 'account-b', accountIncarnation: '2026-07-17T00:00:00.000Z', platformName: '淘宝' },
    'account-tmall': { accountId: 'account-tmall', accountIncarnation: '2026-08-10T00:00:00.000Z', platformName: '天猫' },
    'account-pdd': { accountId: 'account-pdd', accountIncarnation: '2026-08-10T00:00:00.000Z', platformName: '拼多多' },
    'account-ozon-buyer': { accountId: 'account-ozon-buyer', accountIncarnation: '2026-08-10T00:00:00.000Z', platformName: 'Ozon' },
    'integration-ozon-a': {
      accountId: 'integration-ozon-a',
      accountIncarnation: '2026-07-21T00:00:00.000Z',
      platformName: 'Ozon',
      ownerType: 'integration_profile',
    },
    'integration-follow-front-a': {
      accountId: 'integration-follow-front-a',
      accountIncarnation: '2026-08-14T00:00:00.000Z',
      platformName: 'Ozon买家',
      ownerType: 'integration_profile',
      integrationType: 'ozon-follow-seller-session',
    },
  };
  const tasks = new Map([['task-a', {
    taskId: 'task-a',
    ownerId: 'account-a',
    preview: {
      targetUrl: FIXTURE_URL,
      productTitle: '测试商品',
      variant: '黑色',
      quantity: 2,
      address: '中文地址',
      expectedAmount: '18.50',
    },
  }]]);
  const calls = [];
  const integrationLoginSaves = [];
  let latestCapturePreview = null;
  let latestRefundPreview = null;
  const bindingReads = [];
  const localApiClient = {
    async listAccounts() {
      return {
        ok: true,
        accounts: rehearsalAccounts || Object.values(bindings)
          .filter((binding) => binding.ownerType !== 'integration_profile')
          .map((binding) => ({
            id: binding.accountId,
            platformName: binding.platformName,
            browserLoginStatus: '已登录',
            cookieStatus: 'Cookie 已保存',
          })),
      };
    },
    async listPurchaseSourceLinks() {
      return { ok: true, rows: rehearsalPurchaseSourceLinks };
    },
    async listProductSourceLinks() {
      return rehearsalProductSourceLinks;
    },
    async getOwnerBinding(accountId) {
      bindingReads.push(accountId);
      return { binding: bindings[accountId] };
    },
    async recordPluginState(value) {
      // Mirror local-api's audit contract so a human-readable Firefox name
      // cannot regress into the invalid Chromium ID field again.
      assert.match(value.extensionId, /^[a-p]{32}$/u);
      assert.equal(value.packageSha256, BUILT_IN_CEF_ADDON.sha256);
      assert.equal(value.addons[0].extensionId, BUILT_IN_CROSS_BORDER_ADDON.geckoId);
      calls.push({ type: 'plugin', value });
    },
    async saveIntegrationProfileLoginStatus(profileId, value) {
      if (remainingIntegrationLoginSaveFailures > 0) {
        remainingIntegrationLoginSaveFailures -= 1;
        const error = new Error('PURCHASE_BROWSER_LOCAL_API_TRANSPORT_FAILED');
        error.code = 'PURCHASE_BROWSER_LOCAL_API_TRANSPORT_FAILED';
        error.causeCode = 'ECONNRESET';
        error.attempts = 3;
        throw error;
      }
      integrationLoginSaves.push({ profileId, value });
      const authenticated = value.loggedIn === true && value.cookieSaved === true;
      const identityStatus = authenticated && value.companyId ? 'browser-matched' : '';
      const connected = authenticated && !identityStatus;
      return {
        ok: true,
        connected,
        identityMatched: identityStatus ? true : null,
        identityStatus,
        profile: {
          id: profileId,
          configStatus: identityStatus ? '等待 API 核对' : connected ? '连接成功' : '需要重新登录',
          tokenStatus: authenticated ? 'Cookie 已保存' : 'Cookie 已失效',
          browserCompanyId: value.companyId || '',
          browserCompanyName: value.companyName || '',
          identityStatus,
        },
      };
    },
    async getTask(taskId) { return { task: tasks.get(taskId) }; },
    async claimTask(taskId) { calls.push({ type: 'claim', taskId }); return { attemptId: 'attempt-a' }; },
    async completeTask(taskId, value) { calls.push({ type: 'complete', taskId, value }); return { task: { ...tasks.get(taskId), completed: true } }; },
    async failTask(taskId, value) { calls.push({ type: 'fail', taskId, value }); },
    async readbackPurchaseCapture() {
      return purchaseReadback || { override: null, sourceLinks: [] };
    },
    async previewPurchaseCapture(value) {
      calls.push({ type: 'capture-preview', value });
      latestCapturePreview = value;
      const captured = value.capture || {};
      return {
        ok: true,
        previewId: 'capture-preview-a',
        confirmationToken: 'capture-confirmation-a',
        captureHash: 'a'.repeat(64),
        after: {
          override: {
            purchasePlatform: captured.platform || '',
            purchaseOrderNumber: captured.purchaseOrderNumber || '',
            purchaseOrderUrl: captured.purchaseOrderUrl || captured.pageUrl || captured.sourceUrl || '',
            sourceCostCny: captured.purchasePrice ?? null,
            purchaseOrderStatus: captured.purchaseOrderStatus || '',
          },
          sourceLink: { url: captured.sourceUrl || '' },
        },
        missingFields: [],
        conflicts: purchaseCaptureConflicts,
      };
    },
    async confirmPurchaseCapture(value) {
      calls.push({ type: 'capture-confirm', value });
      const captured = latestCapturePreview?.capture || {};
      return {
        ok: true,
        readbackVerified: true,
        readback: {
          override: {
            purchasePlatform: captured.platform || '',
            purchaseOrderNumber: captured.purchaseOrderNumber || '',
            purchaseOrderUrl: captured.purchaseOrderUrl || captured.pageUrl || captured.sourceUrl || '',
            sourceCostCny: captured.purchasePrice ?? null,
            manualStatus: captured.purchaseOrderStatus || '',
          },
          sourceLinks: [{ url: captured.sourceUrl || '' }],
        },
      };
    },
    async previewPurchaseRefund(value) {
      calls.push({ type: 'refund-preview', value });
      latestRefundPreview = value;
      return {
        ok: true,
        previewId: 'refund-preview-a',
        confirmationToken: 'refund-confirmation-a',
        captureHash: 'b'.repeat(64),
        idempotencyKey: value.idempotencyKey,
        missingFields: [],
        conflicts: [],
      };
    },
    async confirmPurchaseRefund(value) {
      calls.push({ type: 'refund-confirm', value });
      const captured = latestRefundPreview?.capture || {};
      return {
        ok: true,
        readbackVerified: true,
        readback: {
          override: {
            purchasePlatform: '',
            purchaseOrderNumber: '',
            purchaseOrderUrl: '',
            sourceCostCny: null,
            forcePurchaseStatus: '待拍单',
            voidedPurchaseOrderNo: captured.purchaseOrderNumber || '',
            purchaseRefundConfirmed: true,
            purchaseRefundStatus: captured.purchaseOrderStatus || '',
          },
          sourceLinks: [{ url: captured.purchaseOrderUrl || '' }],
        },
      };
    },
    async prepareAccountRemoval(operationId) {
      calls.push({ type: 'purge-prepare', operationId });
      const prepared = typeof preparedRemoval === 'function' ? await preparedRemoval(operationId)
        : preparedRemoval || { operationId, binding: { ...bindings['account-a'], ownerType: 'purchase_account' }, resourceIds: PURCHASE_BROWSER_PURGE_RESOURCE_IDS };
      if (!Object.hasOwn(prepared, 'receiptBinding')) prepared.receiptBinding = {
        version: 'purchase-browser-removal-receipt-v2', operationId: prepared.operationId,
        nonce: `fixture-receipt-${operationId}`,
        ownerGenerationHash: createHash('sha256').update(`${prepared.binding?.ownerType || 'purchase_account'}\0${prepared.binding?.accountId || ''}\0${prepared.binding?.accountIncarnation || ''}`).digest('hex'),
      };
      return prepared;
    },
    async getAccountRemovalOperation(operationId) { calls.push({ type: 'purge-operation-readback', operationId }); return removalOperationReadback(operationId); },
    async recordAccountRemovalReceipt(operationId, proof) { calls.push({ type: 'purge-receipt', operationId, proof }); },
  };
  const sent = [];
  const logs = [];
  const hostWindow = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1200, height: 800 }),
    webContents: { send: (...args) => sent.push(args) },
  };
  const controller = createCefPurchaseBrowserController({
    cefRuntime: runtime,
    profileStore: profiles,
    addonManager,
    policy: createPurchaseBrowserPolicy({ fixtureOrigins: [FIXTURE_URL] }),
    localApiClient,
    dataRoot: directory,
    appendLog: (_stream, message) => logs.push(String(message || '')),
    createTabId: (() => { let next = 0; return () => `tab-${++next}`; })(),
    alipayPaymentWindowController,
    removalObserveTimeoutMs,
    getAlipayLoginCredential,
    saveAlipayLoginCredential,
    clearAlipayLoginCredential,
    getAlipayLoginCredentialStatus,
	resolveFollowSellerAutoProxy,
	waitForDelay: async () => undefined,
  });
  return {
    directory,
    controller,
    hostWindow,
    runtime,
    runtimeOpenCalls,
    profiles,
    calls,
    sent,
    logs,
    paginationStarted,
	followSellerCaptureStarted,
	releaseFollowSellerCapture,
    addonOwners,
    bindingReads,
    integrationLoginSaves,
  };
}

test('CEF controller opens the isolated public Ozon profile without a configured purchase account', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'open',
      accountId: 'builtin-ozon-public',
      ownerType: 'builtin_public_profile',
      url: FIXTURE_URL,
    });

    assert.deepEqual(fixture.bindingReads, []);
    assert.equal(fixture.calls.some((call) => call.type === 'plugin'), false);
    assert.equal(fixture.runtimeOpenCalls[0].background, false);
    const profile = fixture.profiles.get({
      accountId: 'builtin-ozon-public',
      accountIncarnation: 'ozon-public-browser-v1',
    });
    assert.equal(profile.platformKey, 'ozon-buyer');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('CEF controller opens and verifies one exact Ozon Seller posting in the shop-bound tab', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'integration-ozon-a',
      ownerType: 'integration_profile',
      url: 'https://seller.ozon.ru/app/postings/fbs',
      bounds: { x: 100, y: 100, width: 1200, height: 760, visible: true },
    });
    const result = await fixture.controller.dispatch({
      command: 'ozon-open-order',
      tabId: opened.activeTabId,
      postingNumber: '0149891397-1014-1',
      routeKind: 'fbs',
    });
    assert.equal(result.result.exact, true);
    assert.equal(result.result.posting, '0149891397-1014-1');
    const runtime = fixture.runtime.get(fixture.runtimeOpenCalls[0].ownerRef);
    assert.deepEqual(runtime.requestPayloads.find((entry) => entry.command === 'ozon-open-order')?.payload, {
      postingNumber: '0149891397-1014-1',
      routeKind: 'fbs',
    });
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('CEF controller forwards and refreshes the fixed order workbench presentation', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const firstWorkbench = {
      kind: 'purchase-order',
      order: { orderNo: 'WORKBENCH-TEST-1' },
    };
    await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: FIXTURE_URL,
      workbench: firstWorkbench,
    });
    assert.deepEqual(fixture.runtimeOpenCalls[0].workbench, firstWorkbench);

    const profile = fixture.profiles.get({
      accountId: 'account-a',
      accountIncarnation: '2026-07-17T00:00:00.000Z',
    });
    const secondWorkbench = {
      kind: 'purchase-order',
      order: { orderNo: 'WORKBENCH-TEST-2' },
    };
    await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: `${FIXTURE_URL}?next=1`,
      workbench: secondWorkbench,
    });
    assert.deepEqual(fixture.runtime.get(profile.ownerRef).workbench, secondWorkbench);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('PDD buyer links stay embedded in the original order workbench while keeping automatic capture active', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-pdd',
      url: 'http://yangkeduo.com/goods.html?goods_id=98765',
      purchaseTarget: {
        targetId: 'shop-3:0215352801-0034-2:mz-26032810-471686',
        shopId: 'shop-3',
        orderKey: '0215352801-0034-2',
        sku: 'mz-26032810-471686',
      },
      bounds: { x: 460, y: 120, width: 900, height: 680, visible: true },
      workbench: { kind: 'purchase-order', displayMode: 'embedded' },
    });
    const call = fixture.runtimeOpenCalls[0];
    assert.equal(call.url, 'https://mobile.yangkeduo.com/goods.html?goods_id=98765');
    assert.equal(call.workbench.displayMode, 'embedded');
    const active = opened.tabs.find((tab) => tab.tabId === opened.activeTabId);
    assert.equal(active.requestedUrl, call.url);
    assert.equal(active.displayMode, 'embedded');
    assert.equal(active.browserLayout, '');
    assert.equal(active.embedding.requested, true);
    assert.equal(active.embedding.embedded, true);
    assert.equal(active.target?.orderKey, '0215352801-0034-2');
    const initialRuntime = fixture.runtime.get(active.storageRef);
    assert.ok(
      initialRuntime.requests.indexOf('set-target') < initialRuntime.requests.indexOf('bounds'),
      'the exact order target must be locked before the embedded browser becomes visible',
    );

    await fixture.controller.dispatch({
      command: 'navigate',
      tabId: opened.activeTabId,
      url: 'https://www.pinduoduo.com/personal.html',
    });
    const runtime = fixture.runtime.get(active.storageRef);
    const navigation = runtime.requestPayloads.findLast((entry) => entry.command === 'navigate');
    assert.equal(navigation.payload.url, 'https://mobile.yangkeduo.com/personal.html');
    await fixture.controller.dispatch({
      command: 'open-extension-manager',
      tabId: opened.activeTabId,
    });
    assert.equal(runtime.requests.at(-1), 'open-extension-manager');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('PDD payment success is captured once and bound to the exact locked Ozon order target', async () => {
  const productUrl = 'https://mobile.yangkeduo.com/goods.html?goods_id=98765';
  const orderUrl = 'https://mobile.yangkeduo.com/order.html?order_sn=PDD20260810001';
  const fixture = createFixture({
    pinduoduoOrderCaptures: [
      {
        platform: '拼多多',
        pageType: 'product',
        pageUrl: productUrl,
        sourceUrl: productUrl,
        sourceProductId: '98765',
        productTitle: '多层铁艺花架',
        purchasePrice: 52.71,
        purchaseOrderStatus: '待付款',
        paymentConfirmed: false,
      },
      {
        platform: '拼多多',
        pageType: 'order-detail',
        pageUrl: orderUrl,
        sourceUrl: orderUrl,
        purchaseOrderUrl: orderUrl,
        purchaseOrderNumber: 'PDD20260810001',
        purchaseOrderStatus: '待发货',
        paymentConfirmed: true,
      },
    ],
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-pdd',
      url: productUrl,
      bounds: { x: 460, y: 120, width: 900, height: 680, visible: true, boundsVersion: 1 },
      workbench: { kind: 'purchase-order', displayMode: 'embedded' },
    });
    const target = {
      targetId: 'target-pdd-paid-1',
      shopId: 'shop-pdd-a',
      orderKey: 'shop-pdd-a:79452088-0097-1',
      ozonOrderId: '79452088-0097',
      sku: 'mz-26060316-604875',
      quantity: 1,
      requiredFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'sourceUrl'],
    };
    await fixture.controller.dispatch({
      command: 'set-target',
      tabId: opened.activeTabId,
      target,
    });

    const deadline = Date.now() + 4_000;
    let event = null;
    while (Date.now() < deadline) {
      event = fixture.sent
        .map(([, payload]) => payload)
        .find((payload) => payload?.event === 'purchase-order-auto-captured');
      if (event) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(event, 'expected a paid PDD order auto-capture event');
    assert.equal(event.target.shopId, target.shopId);
    assert.equal(event.target.orderKey, target.orderKey);
    assert.equal(event.target.sku, target.sku);
    assert.equal(event.readbackVerified, true);
    assert.equal(event.capture.purchaseOrderNumber, 'PDD20260810001');
    assert.equal(event.capture.purchaseOrderStatus, '待发货');
    assert.equal(event.capture.purchasePrice, 52.71);
    const previewCalls = fixture.calls.filter((call) => call.type === 'capture-preview');
    const confirmCalls = fixture.calls.filter((call) => call.type === 'capture-confirm');
    assert.equal(previewCalls.length, 1);
    assert.equal(confirmCalls.length, 1);
    assert.equal(previewCalls[0].value.target.shopId, target.shopId);
    assert.equal(previewCalls[0].value.target.orderKey, target.orderKey);
    assert.equal(previewCalls[0].value.target.sku, target.sku);
    assert.equal(previewCalls[0].value.capture.sourceUrl, productUrl);
    assert.equal(previewCalls[0].value.capture.purchaseOrderUrl, orderUrl);
    assert.equal(confirmCalls[0].value.acceptConflicts, false);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('PDD Alipay H5 redirect opens the isolated payment window and returns the workbench to PDD', async () => {
  const openedPayments = [];
  const fixture = createFixture({
    alipayPaymentWindowController: {
      async open(payload) {
        openedPayments.push(payload);
        return { ok: true };
      },
      async purgeOwner() { return { ok: true, verified: true }; },
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const productUrl = 'https://mobile.yangkeduo.com/goods.html?goods_id=98765';
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-pdd',
      url: productUrl,
      workbench: { displayMode: 'embedded' },
      bounds: { x: 20, y: 40, width: 900, height: 640, visible: true },
    });
    await fixture.controller.dispatch({
      command: 'set-target',
      tabId: opened.activeTabId,
      target: {
        targetId: 'pdd-alipay-target',
        shopId: 'shop-1',
        orderKey: 'order-1',
        sku: 'sku-1',
        quantity: 1,
        requiredFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny'],
      },
    });
    const tab = opened.tabs.find((item) => item.tabId === opened.activeTabId);
    const browser = fixture.runtime.get(tab.storageRef);
    const paymentUrl = 'https://mclient.alipay.com/h5pay/cashierPreConfirm/index.html?token=one-time-secret';
    browser.state.url = paymentUrl;
    browser.emit('address', { state: { ...browser.state, url: paymentUrl, loading: false, canGoBack: false } });

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && openedPayments.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    while (Date.now() < deadline && browser.state.url !== productUrl) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(openedPayments.length, 1);
    assert.equal(openedPayments[0].paymentUrl, paymentUrl);
    assert.equal(openedPayments[0].sourceTabId, opened.activeTabId);
    assert.equal(openedPayments[0].ownerRef, 'account-pdd');
    assert.equal(browser.state.url, productUrl);
    assert.ok(browser.requests.includes('navigate'));
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('manual payment login exports the exact PDD account cookies into the independent Electron window', async () => {
  const loginWindows = [];
  const fixture = createFixture({
    alipayPaymentWindowController: {
      async openLogin(payload) {
        loginWindows.push(payload);
        return { ok: true, reused: false };
      },
      async purgeOwner() { return { ok: true, verified: true }; },
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-pdd',
      url: 'https://mobile.yangkeduo.com/orders.html?type=1&order_index=75',
      restoreVisible: false,
    });
    const result = await fixture.controller.dispatch({
      command: 'open-purchase-payment-login',
      accountId: 'account-pdd',
      platform: '拼多多',
    });
    assert.equal(result.mode, 'independent-electron-pdd-to-alipay-login');
    assert.equal(loginWindows.length, 1);
    assert.equal(loginWindows[0].accountId, 'account-pdd');
    assert.equal(loginWindows[0].ownerRef, 'account-pdd');
    assert.equal(loginWindows[0].purchaseUrl, 'https://mobile.yangkeduo.com/orders.html?type=1&order_index=75');
    assert.equal(loginWindows[0].cookies[0].name, 'PDDAccessToken');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('1688 Alipay redirect is transferred from CEF to the account-isolated Electron payment window', async () => {
  const openedPayments = [];
  const fixture = createFixture({
    alipayPaymentWindowController: {
      async open(payload) { openedPayments.push(payload); return { ok: true }; },
      async purgeOwner() { return { ok: true, verified: true }; },
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const orderUrl = 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?tradeStatus=waitbuyerpay&page=1&pageSize=10';
    const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: orderUrl });
    await fixture.controller.dispatch({
      command: 'set-target', tabId: opened.activeTabId,
      target: { targetId: '1688-pay-target', shopId: 'shop-1', orderKey: 'order-1688', sku: 'sku-1', quantity: 1 },
    });
    const tab = opened.tabs.find((item) => item.tabId === opened.activeTabId);
    const browser = fixture.runtime.get(tab.storageRef);
    const paymentUrl = 'https://cashier.alipay.com/business/cashiermain.htm?trade_no=1688fixture';
    browser.state.url = paymentUrl;
    browser.emit('address', { state: { ...browser.state, url: paymentUrl, loading: false, canGoBack: false } });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && openedPayments.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(openedPayments.length, 1);
    assert.equal(openedPayments[0].platform, '1688');
    assert.equal(openedPayments[0].ownerRef, 'account-a');
    assert.equal(openedPayments[0].paymentUrl, paymentUrl);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Taobao Tmall and 1688 payment login export their isolated CEF cookies into Electron', async () => {
  const loginWindows = [];
  const cookieSyncs = [];
  const fixture = createFixture({
    alipayPaymentWindowController: {
      async openLogin(payload) { loginWindows.push(payload); return { ok: true, reused: false }; },
      async syncLoginCookies(payload) { cookieSyncs.push(payload); return { ok: true }; },
      snapshot() { return { windows: [] }; },
      async purgeOwner() { return { ok: true, verified: true }; },
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    for (const input of [
      { accountId: 'account-b', platform: '淘宝', cookie: '_tb_token_' },
      { accountId: 'account-tmall', platform: '天猫', cookie: '_tb_token_' },
      { accountId: 'account-a', platform: '1688', cookie: '_m_h5_tk' },
    ]) {
      const result = await fixture.controller.dispatch({ command: 'open-purchase-payment-login', ...input });
      assert.match(result.mode, /^independent-electron-/u);
      const opened = loginWindows.at(-1);
      assert.equal(opened.accountId, input.accountId);
      assert.equal(opened.platform, input.platform);
      assert.deepEqual(opened.cookies, []);
      const syncDeadline = Date.now() + 2_000;
      while (Date.now() < syncDeadline && cookieSyncs.length < loginWindows.length) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(cookieSyncs.at(-1).cookies[0].name, input.cookie);
    }
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Taobao payment window starts before its background CEF cookie export completes', async () => {
  const loginWindows = [];
  const cookieSyncs = [];
  let releaseLogin;
  const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
  const fixture = createFixture({
    alipayPaymentWindowController: {
      async openLogin(payload) {
        loginWindows.push(payload);
        await loginGate;
        return { ok: true, reused: false };
      },
      async syncLoginCookies(payload) { cookieSyncs.push(payload); return { ok: true }; },
      snapshot() { return { windows: [] }; },
      async purgeOwner() { return { ok: true, verified: true }; },
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opening = fixture.controller.dispatch({
      command: 'open-purchase-payment-login',
      accountId: 'account-b',
      platform: '淘宝',
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && (loginWindows.length === 0 || cookieSyncs.length === 0)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(loginWindows.length, 1);
    assert.equal(cookieSyncs.length, 1);
    assert.deepEqual(loginWindows[0].cookies, []);
    assert.equal(cookieSyncs[0].cookies[0].name, '_tb_token_');
    releaseLogin();
    const result = await opening;
    assert.equal(result.cookieSyncPending, true);
  } finally {
    releaseLogin?.();
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Taobao and 1688 first login opens Electron even when the marketplace CEF profile has no cookies yet', async () => {
  const loginWindows = [];
  const fixture = createFixture({
    emptyPurchaseSessionCookies: true,
    alipayPaymentWindowController: {
      async openLogin(payload) { loginWindows.push(payload); return { ok: true, reused: false }; },
      snapshot() { return { windows: [] }; },
      async purgeOwner() { return { ok: true, verified: true }; },
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    for (const input of [
      { accountId: 'account-b', platform: '淘宝' },
      { accountId: 'account-a', platform: '1688' },
    ]) {
      const result = await fixture.controller.dispatch({ command: 'open-purchase-payment-login', ...input });
      assert.match(result.mode, /^independent-electron-/u);
      assert.equal(result.importedCookieCount, 0);
      assert.deepEqual(loginWindows.at(-1).cookies, []);
      assert.equal(loginWindows.at(-1).accountId, input.accountId);
    }
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('payment login reports a platform-account mismatch instead of a missing marketplace session', async () => {
  const fixture = createFixture({
    alipayPaymentWindowController: {
      async openLogin() { return { ok: true, reused: false }; },
      snapshot() { return { windows: [] }; },
      async purgeOwner() { return { ok: true, verified: true }; },
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await assert.rejects(
      () => fixture.controller.dispatch({
        command: 'open-purchase-payment-login',
        accountId: 'account-pdd',
        platform: '淘宝',
      }),
      { code: 'PURCHASE_PAYMENT_PLATFORM_ACCOUNT_MISMATCH' },
    );
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('payment login status imports the real Electron account cookies into the exact marketplace CEF profile', async () => {
  const electronCookies = [
    { name: 'unb', value: 'fixture-user', domain: '.taobao.com', path: '/', secure: true },
    { name: '_tb_token_', value: 'fixture-session', domain: '.taobao.com', path: '/', secure: true },
  ];
  const fixture = createFixture({
    alipayPaymentWindowController: {
      async getLoginStatus() {
        return {
          loggedIn: true,
          cookieSaved: true,
          cookieCount: electronCookies.length,
          windowOpen: true,
          verificationSource: 'electron-strong-auth-cookie',
        };
      },
      async exportLoginCookies() { return { cookies: electronCookies, cookieCount: electronCookies.length }; },
      async syncLoginCookies() { return { ok: true }; },
      snapshot() { return { windows: [] }; },
      async purgeOwner() { return { ok: true, verified: true }; },
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const result = await fixture.controller.dispatch({
      command: 'purchase-payment-login-status',
      accountId: 'account-b',
      platform: '淘宝',
    });
    assert.equal(result.loggedIn, true);
    assert.equal(result.cookieSaved, true);
    assert.equal(result.verificationSource, 'electron-strong-auth-cookie');
    const tab = result.cef ? fixture.controller.snapshot().tabs.find((candidate) => candidate.accountId === 'account-b') : null;
    assert.ok(tab);
    const browser = fixture.runtime.get(tab.storageRef);
    assert.ok(browser.requests.includes('import-purchase-session-cookies'));
    assert.ok(browser.requests.includes('purchase-login-status'));
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('shared Alipay login supports passwordless SMS verification and synchronizes its session to purchase accounts', async () => {
  let savedCredential = null;
  const opened = [];
  const synchronizedOwners = [];
  const fixture = createFixture({
    getAlipayLoginCredential: async () => savedCredential,
    saveAlipayLoginCredential: async (input) => {
      savedCredential = { ...input };
      return { ok: true, loginAccount: input.loginAccount };
    },
    getAlipayLoginCredentialStatus: async () => ({
      configured: Boolean(savedCredential?.loginAccount),
      passwordConfigured: Boolean(savedCredential?.loginPassword),
      loginAccount: savedCredential?.loginAccount || '',
    }),
    clearAlipayLoginCredential: async () => { savedCredential = null; return { ok: true }; },
    alipayPaymentWindowController: {
      async openSharedLogin(payload) { opened.push(payload); return { ok: true, platform: '支付宝' }; },
      async getSharedLoginStatus() {
        return { loggedIn: true, cookieSaved: true, windowOpen: true, verificationSource: 'shared-alipay-strong-auth-cookie' };
      },
      async syncSharedLoginToOwners(ownerRefs) {
        synchronizedOwners.push(...ownerRefs);
        return { ok: true, loggedIn: true, syncedOwnerCount: ownerRefs.length };
      },
      async purgeOwner() { return { ok: true }; },
      snapshot() { return { windows: [] }; },
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const login = await fixture.controller.dispatch({
      command: 'open-shared-alipay-login',
      loginAccount: '13800000000',
      loginPassword: '',
    });
    assert.equal(login.credentialConfigured, true);
    assert.equal(opened[0].loginAccount, '13800000000');
    assert.equal(opened[0].loginPassword, '');
    assert.equal(opened[0].purchaseUrl, 'https://mobile.yangkeduo.com/orders.html?type=1&order_index=75');
    assert.equal(opened[0].cookies[0].name, 'PDDAccessToken');
    assert.equal(login.mode, 'queshou-pdd-wait-pay-to-alipay-login');
    assert.equal(login.purchaseAccountId, 'account-pdd');
    const status = await fixture.controller.dispatch({ command: 'shared-alipay-login-status' });
    assert.equal(status.loggedIn, true);
    assert.equal(status.configured, true);
    assert.ok(status.syncedOwnerCount >= 4);
    assert.ok(synchronizedOwners.includes('account-pdd'));
    assert.ok(synchronizedOwners.includes('account-b'));
    assert.ok(synchronizedOwners.includes('account-a'));
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('PDD confirmed refund keeps monitoring after payment and clears the exact locked purchase record', async () => {
  const productUrl = 'https://mobile.yangkeduo.com/goods.html?goods_id=98765';
  const orderUrl = 'https://mobile.yangkeduo.com/order.html?order_sn=PDD20260810001';
  const fixture = createFixture({
    pinduoduoOrderCaptures: [
      {
        platform: '拼多多', pageType: 'product', pageUrl: productUrl, sourceUrl: productUrl,
        sourceProductId: '98765', productTitle: '多层铁艺花架', purchasePrice: 52.71,
        purchaseOrderStatus: '待付款', paymentConfirmed: false,
      },
      {
        platform: '拼多多', pageType: 'order-detail', pageUrl: orderUrl, sourceUrl: orderUrl,
        purchaseOrderUrl: orderUrl, purchaseOrderNumber: 'PDD20260810001',
        purchaseOrderStatus: '待发货', paymentConfirmed: true,
      },
      {
        platform: '拼多多', pageType: 'order-detail', pageUrl: orderUrl, sourceUrl: orderUrl,
        purchaseOrderUrl: orderUrl, purchaseOrderNumber: 'PDD20260810001',
        purchaseOrderStatus: '极速退款成功', paymentConfirmed: false, refundConfirmed: true,
      },
    ],
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-pdd',
      url: productUrl,
      bounds: { x: 460, y: 120, width: 900, height: 680, visible: true, boundsVersion: 1 },
      workbench: { kind: 'purchase-order', displayMode: 'embedded' },
    });
    const target = {
      targetId: 'target-pdd-refund-1',
      shopId: 'shop-pdd-a',
      orderKey: 'shop-pdd-a:79452088-0097-1',
      ozonOrderId: '79452088-0097',
      sku: 'mz-26060316-604875',
      quantity: 1,
      requiredFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'sourceUrl'],
    };
    await fixture.controller.dispatch({ command: 'set-target', tabId: opened.activeTabId, target });

    const deadline = Date.now() + 7_000;
    let refundEvent = null;
    while (Date.now() < deadline) {
      refundEvent = fixture.sent
        .map(([, payload]) => payload)
        .find((payload) => payload?.event === 'purchase-order-refund-captured');
      if (refundEvent) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(refundEvent, 'expected a confirmed PDD refund capture event');
    assert.equal(refundEvent.target.shopId, target.shopId);
    assert.equal(refundEvent.target.orderKey, target.orderKey);
    assert.equal(refundEvent.target.sku, target.sku);
    assert.equal(refundEvent.capture.purchaseOrderNumber, 'PDD20260810001');
    assert.equal(refundEvent.capture.purchaseOrderStatus, '极速退款成功');
    assert.equal(refundEvent.readbackVerified, true);
    assert.equal(refundEvent.readback.override.forcePurchaseStatus, '待拍单');
    assert.equal(refundEvent.readback.override.purchaseOrderNumber, '');
    assert.equal(fixture.calls.filter((call) => call.type === 'capture-preview').length, 1);
    assert.equal(fixture.calls.filter((call) => call.type === 'capture-confirm').length, 1);
    assert.equal(fixture.calls.filter((call) => call.type === 'refund-preview').length, 1);
    assert.equal(fixture.calls.filter((call) => call.type === 'refund-confirm').length, 1);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('1688 payment read selects the exact source item and automatically saves its canonical source', async () => {
  const sourceUrl = 'https://detail.1688.com/offer/7788990011.html';
  const fixture = createFixture({
    purchaseReadback: {
      override: null,
      sourceLinks: [{ productKey: 'sku-1688-a', platform: '1688', url: sourceUrl, priceValue: null }],
    },
    alibaba1688OrderCapture: {
      platform: '1688',
      pageType: 'order-list',
      pageUrl: 'https://trade.1688.com/order/buyer_order_list.htm',
      orderCandidates: [
        {
          purchaseOrderNumber: '3316316300000000001',
          sourceUrl: 'https://detail.1688.com/offer/1111000011.html',
          sourceProductId: '1111000011',
          productTitle: '完全无关的厨房商品',
          quantity: 1,
          purchasePrice: 9.9,
          purchaseOrderStatus: '待发货',
          paymentConfirmed: true,
        },
        {
          purchaseOrderNumber: '3316316306834029783',
          purchaseOrderUrl: 'https://trade.1688.com/order/order_detail.htm?orderId=3316316306834029783',
          sourceUrl,
          sourceProductId: '7788990011',
          productTitle: '现代简约落地式铁艺花盆支架可移动拼装型多层室内外花盆收纳架',
          quantity: 1,
          purchasePrice: 38.6,
          purchaseOrderStatus: '待发货',
          paymentConfirmed: true,
        },
      ],
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: 'https://trade.1688.com/order/buyer_order_list.htm',
      bounds: { x: 460, y: 120, width: 900, height: 680, visible: true },
      workbench: { kind: 'purchase-order', displayMode: 'embedded' },
    });
    const target = {
      targetId: 'target-1688-paid-1',
      shopId: 'shop-1688-a',
      orderKey: 'shop-1688-a:79452088-0097-1',
      sku: 'sku-1688-a',
      productTitle: '现代简约落地式铁艺花盆支架可移动拼装型多层室内外花盆收纳架',
      quantity: 1,
      requiredFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'sourceUrl'],
    };
    await fixture.controller.dispatch({ command: 'set-target', tabId: opened.activeTabId, target });
    const previewResult = await fixture.controller.dispatch({
      command: 'read-payment-info',
      tabId: opened.activeTabId,
    });

    assert.equal(previewResult.readbackVerified, true);
    assert.equal(previewResult.pendingSave, false);
    assert.equal(previewResult.operation, 'read-payment-info');
    assert.equal(previewResult.capture.purchaseOrderNumber, '3316316306834029783');
    assert.equal(previewResult.capture.purchasePrice, 38.6);
    assert.equal(previewResult.capture.sourceUrl, sourceUrl);
    assert.equal(previewResult.capture.sourceProductId, '7788990011');
    assert.equal(previewResult.capture.sourceMethod, '1688-source-reader');
    const preview = fixture.calls.find((call) => call.type === 'capture-preview');
    assert.equal(preview.value.capture.sourceUrl, sourceUrl);
    assert.equal(preview.value.capture.purchaseOrderNumber, '3316316306834029783');
    const confirmation = fixture.calls.find((call) => call.type === 'capture-confirm');
    assert.equal(confirmation.value.acceptConflicts, false);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('1688 payment read trusts the visible detail order id when the Ozon title is Russian', async () => {
  const exactOrderNumber = '3316316306834029783';
  const sourceUrl = 'https://detail.1688.com/offer/923805736089.html';
  const fixture = createFixture({
    purchaseReadback: {
      override: null,
      sourceLinks: [],
    },
    alibaba1688OrderCapture: {
      platform: '1688',
      pageType: 'order-detail',
      pageUrl: `https://air.1688.com/app/ctf-page/trade-order-detail/index.html?orderId=${exactOrderNumber}`,
      currentOrderNumber: exactOrderNumber,
      orderCandidates: [
        {
          purchaseOrderNumber: '3316316300000000001',
          productTitle: '其他订单',
          purchasePrice: 9.9,
          purchaseOrderStatus: '待发货',
          paymentConfirmed: true,
        },
        {
          purchaseOrderNumber: exactOrderNumber,
          purchaseOrderUrl: `https://air.1688.com/app/ctf-page/trade-order-detail/index.html?orderId=${exactOrderNumber}`,
          sourceUrl,
          sourceProductId: '923805736089',
          productTitle: '花架室内置物架铁艺多层带轮落地式绿萝花盆架',
          quantity: 1,
          purchasePrice: 38.6,
          purchaseOrderStatus: '待发货',
          paymentConfirmed: true,
        },
      ],
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: `https://air.1688.com/app/ctf-page/trade-order-detail/index.html?orderId=${exactOrderNumber}`,
    });
    await fixture.controller.dispatch({
      command: 'set-target',
      tabId: opened.activeTabId,
      target: {
        targetId: 'target-1688-russian-title',
        shopId: 'shop-1688-a',
        orderKey: 'shop-1688-a:79452088-0097-1',
        sku: 'sku-1688-a',
        productTitle: 'Подставка для цветов, 103.4 см x 20 см x 50 см',
        quantity: 1,
        requiredFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'sourceUrl'],
      },
    });

    const previewResult = await fixture.controller.dispatch({
      command: 'read-payment-info',
      tabId: opened.activeTabId,
    });

    assert.equal(previewResult.readbackVerified, true);
    assert.equal(previewResult.pendingSave, false);
    assert.equal(previewResult.capture.purchaseOrderNumber, exactOrderNumber);
    assert.equal(previewResult.capture.purchasePrice, 38.6);
    const preview = fixture.calls.find((call) => call.type === 'capture-preview');
    assert.equal(preview.value.capture.sourceUrl, sourceUrl);
    assert.equal(fixture.calls.find((call) => call.type === 'capture-confirm')?.value.acceptConflicts, false);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('1688 payment read keeps the manual Save action when local data conflicts', async () => {
  const sourceUrl = 'https://detail.1688.com/offer/7788990011.html';
  const fixture = createFixture({
    purchaseReadback: { override: null, sourceLinks: [] },
    purchaseCaptureConflicts: [{ field: 'purchaseOrderNumber', before: 'old-order', after: 'new-order' }],
    alibaba1688OrderCapture: {
      platform: '1688',
      pageType: 'order-detail',
      pageUrl: 'https://trade.1688.com/order/order_detail.htm?orderId=3316316306834029783',
      currentOrderNumber: '3316316306834029783',
      orderCandidates: [{
        purchaseOrderNumber: '3316316306834029783',
        purchaseOrderUrl: 'https://trade.1688.com/order/order_detail.htm?orderId=3316316306834029783',
        sourceUrl,
        sourceProductId: '7788990011',
        productTitle: '现代简约花盆架',
        quantity: 1,
        purchasePrice: 38.6,
        purchaseOrderStatus: '待发货',
        paymentConfirmed: true,
      }],
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: 'https://trade.1688.com/order/order_detail.htm?orderId=3316316306834029783',
    });
    await fixture.controller.dispatch({
      command: 'set-target',
      tabId: opened.activeTabId,
      target: {
        targetId: 'target-1688-conflict', shopId: 'shop-1688-a',
        orderKey: 'shop-1688-a:79452088-0097-1', sku: 'sku-1688-a',
        productTitle: '现代简约花盆架', quantity: 1,
      },
    });

    const preview = await fixture.controller.dispatch({
      command: 'read-payment-info', tabId: opened.activeTabId,
    });
    assert.equal(preview.pendingSave, true);
    assert.equal(preview.readbackVerified, false);
    assert.equal(fixture.calls.some((call) => call.type === 'capture-confirm'), false);

    const saved = await fixture.controller.dispatch({
      command: 'save-payment-info', tabId: opened.activeTabId,
    });
    assert.equal(saved.readbackVerified, true);
    assert.equal(fixture.calls.find((call) => call.type === 'capture-confirm')?.value.acceptConflicts, true);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('1688 manual status refresh requires and reads the exact bound purchase order number', async () => {
  const sourceUrl = 'https://detail.1688.com/offer/7788990011.html';
  const boundOrderNumber = '3316316306834029783';
  const fixture = createFixture({
    purchaseReadback: {
      override: {
        purchasePlatform: '1688',
        purchaseOrderNumber: boundOrderNumber,
        purchaseOrderUrl: 'https://trade.1688.com/order/order_detail.htm?orderId=3316316306834029783',
        sourceCostCny: 38.6,
        purchaseOrderStatus: '待发货',
      },
      sourceLinks: [{ productKey: 'sku-1688-a', platform: '1688', url: sourceUrl, priceValue: 38.6 }],
    },
    alibaba1688OrderCapture: {
      platform: '1688',
      pageType: 'order-list',
      pageUrl: 'https://trade.1688.com/order/buyer_order_list.htm',
      orderCandidates: [
        {
          purchaseOrderNumber: '3316316300000000001',
          productTitle: '其他订单',
          purchasePrice: 99,
          purchaseOrderStatus: '交易成功',
        },
        {
          purchaseOrderNumber: boundOrderNumber,
          productTitle: '现代简约落地式铁艺花盆支架',
          purchasePrice: null,
          purchaseOrderStatus: '已发货',
          paymentConfirmed: true,
        },
      ],
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open', accountId: 'account-a',
      url: 'https://trade.1688.com/order/buyer_order_list.htm',
    });
    await fixture.controller.dispatch({
      command: 'set-target', tabId: opened.activeTabId,
      target: {
        targetId: 'target-1688-status-1', shopId: 'shop-1688-a',
        orderKey: 'shop-1688-a:79452088-0097-1', sku: 'sku-1688-a',
        productTitle: '现代简约落地式铁艺花盆支架', quantity: 1,
      },
    });
    const previewResult = await fixture.controller.dispatch({
      command: 'refresh-order-status', tabId: opened.activeTabId,
    });

    assert.equal(previewResult.operation, 'refresh-order-status');
    assert.equal(previewResult.pendingSave, true);
    assert.equal(previewResult.capture.purchaseOrderNumber, boundOrderNumber);
    assert.equal(previewResult.capture.purchaseOrderStatus, '已发货');
    assert.equal(previewResult.capture.purchasePrice, 38.6);
    const saved = await fixture.controller.dispatch({
      command: 'save-payment-info', tabId: opened.activeTabId,
    });
    assert.equal(saved.readbackVerified, true);
    assert.equal(saved.sourceOperation, 'refresh-order-status');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('1688 exact refunded order refresh clears the persisted purchase binding immediately', async () => {
  const sourceUrl = 'https://detail.1688.com/offer/7788990011.html';
  const boundOrderNumber = '3316316306834029783';
  const orderUrl = `https://trade.1688.com/order/new_step_order_detail.htm?orderId=${boundOrderNumber}`;
  const fixture = createFixture({
    purchaseReadback: {
      override: {
        purchasePlatform: '1688',
        purchaseOrderNumber: boundOrderNumber,
        purchaseOrderUrl: orderUrl,
        sourceCostCny: 38.6,
        purchaseOrderStatus: '待发货',
      },
      sourceLinks: [{ productKey: 'sku-1688-a', platform: '1688', url: sourceUrl, priceValue: 38.6 }],
    },
    alibaba1688OrderCapture: {
      platform: '1688',
      pageType: 'order-detail',
      pageUrl: orderUrl,
      currentOrderNumber: boundOrderNumber,
      orderCandidates: [{
        purchaseOrderNumber: boundOrderNumber,
        purchaseOrderUrl: orderUrl,
        sourceUrl,
        sourceProductId: '7788990011',
        productTitle: '现代简约落地式铁艺花盆支架',
        quantity: 1,
        purchasePrice: 38.6,
        purchaseOrderStatus: '退款成功',
        refundConfirmed: true,
      }],
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open', accountId: 'account-a', url: orderUrl,
    });
    await fixture.controller.dispatch({
      command: 'set-target', tabId: opened.activeTabId,
      target: {
        targetId: 'target-1688-refund-1', shopId: 'shop-1688-a',
        orderKey: 'shop-1688-a:79452088-0097-1', sku: 'sku-1688-a',
        productTitle: '现代简约落地式铁艺花盆支架', quantity: 1,
      },
    });
    const result = await fixture.controller.dispatch({
      command: 'refresh-order-status', tabId: opened.activeTabId,
    });

    assert.equal(result.refunded, true);
    assert.equal(result.readbackVerified, true);
    assert.equal(result.purchaseContext, null);
    assert.equal(result.readback.override.purchasePlatform, '');
    assert.equal(result.readback.override.purchaseOrderNumber, '');
    assert.equal(result.readback.override.sourceCostCny, null);
    assert.equal(result.readback.override.forcePurchaseStatus, '待拍单');
    assert.ok(fixture.calls.some((call) => call.type === 'refund-confirm'));
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    label: '淘宝',
    accountId: 'account-b',
    url: 'https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=991001',
    sourceUrl: 'https://item.taobao.com/item.htm?id=7788990011',
    orderNumber: 'TAOBAO-ORDER-991001',
  },
  {
    label: '天猫',
    accountId: 'account-tmall',
    url: 'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=992002',
    sourceUrl: 'https://detail.tmall.com/item.htm?id=7788990011',
    orderNumber: 'TMALL-ORDER-992002',
  },
  {
    label: 'Ozon买家',
    accountId: 'account-ozon-buyer',
    url: 'https://www.ozon.ru/my/orderdetails/?order=993003',
    sourceUrl: 'https://www.ozon.ru/product/test-7788990011/',
    orderNumber: 'OZON-BUYER-993003',
  },
]) {
  test(`${scenario.label} manual payment read writes the exact visible order and verifies readback`, async () => {
    const fixture = createFixture({
      purchaseReadback: {
        override: null,
        sourceLinks: [{ productKey: 'sku-platform-a', platform: scenario.label, url: scenario.sourceUrl }],
      },
      genericPurchaseCapture: {
        platform: scenario.label,
        pageType: 'order-detail',
        pageUrl: scenario.url,
        purchaseOrderUrl: scenario.url,
        sourceUrl: scenario.sourceUrl,
        sourceProductId: scenario.label === 'Ozon买家' ? '' : '7788990011',
        productTitle: '现代简约落地式铁艺花盆支架',
        quantity: 1,
        purchaseOrderNumber: scenario.orderNumber,
        purchasePrice: 38.6,
        purchaseOrderStatus: '买家已付款',
        paymentConfirmed: true,
      },
    });
    try {
      fixture.controller.attachHost(fixture.hostWindow);
      const opened = await fixture.controller.dispatch({
        command: 'open', accountId: scenario.accountId, url: scenario.url,
      });
      await fixture.controller.dispatch({
        command: 'set-target', tabId: opened.activeTabId,
        target: {
          targetId: `target-${scenario.orderNumber}`,
          shopId: 'shop-platform-a',
          orderKey: 'shop-platform-a:79452088-0097-1',
          sku: 'sku-platform-a',
          productTitle: '现代简约落地式铁艺花盆支架',
          quantity: 1,
        },
      });
      const previewResult = await fixture.controller.dispatch({
        command: 'read-payment-info', tabId: opened.activeTabId,
      });

      assert.equal(previewResult.readbackVerified, false);
      assert.equal(previewResult.pendingSave, true);
      assert.equal(previewResult.capture.platform, scenario.label);
      assert.equal(previewResult.capture.purchaseOrderNumber, scenario.orderNumber);
      assert.equal(previewResult.capture.purchasePrice, 38.6);
      assert.equal(fixture.calls.some((call) => call.type === 'capture-confirm'), false);
      const saved = await fixture.controller.dispatch({
        command: 'save-payment-info', tabId: opened.activeTabId,
      });
      assert.equal(saved.readbackVerified, true);
      assert.equal(saved.capture.purchaseOrderNumber, scenario.orderNumber);
      assert.equal(fixture.calls.find((call) => call.type === 'capture-confirm')?.value.acceptConflicts, true);
    } finally {
      fixture.controller.dispose();
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
}

test('Pinduoduo manual payment read uses the exact order-detail capture path', async () => {
  const orderUrl = 'https://mobile.yangkeduo.com/order.html?order_sn=260810-579034202431518';
  const fixture = createFixture({
    purchaseReadback: { override: null, sourceLinks: [] },
    pinduoduoOrderCaptures: [{
      platform: '拼多多',
      pageType: 'order-detail',
      pageUrl: orderUrl,
      purchaseOrderUrl: orderUrl,
      sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=7788990011',
      sourceProductId: '7788990011',
      productTitle: '现代简约落地式铁艺花盆支架',
      quantity: 1,
      purchaseOrderNumber: '260810-579034202431518',
      purchasePrice: 52.71,
      purchaseOrderStatus: '待发货',
      paymentConfirmed: true,
    }],
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open', accountId: 'account-pdd', url: orderUrl,
    });
    await fixture.controller.dispatch({
      command: 'set-target', tabId: opened.activeTabId,
      target: {
        targetId: 'target-pdd-manual', shopId: 'shop-pdd-a',
        orderKey: 'shop-pdd-a:79452088-0097-1', sku: 'sku-pdd-a',
        productTitle: '现代简约落地式铁艺花盆支架', quantity: 1,
      },
    });
    const previewResult = await fixture.controller.dispatch({
      command: 'read-payment-info', tabId: opened.activeTabId,
    });
    assert.equal(previewResult.pendingSave, true);
    assert.equal(previewResult.capture.platform, '拼多多');
    assert.equal(previewResult.capture.purchaseOrderNumber, '260810-579034202431518');
    assert.equal(previewResult.capture.purchasePrice, 52.71);
    const saved = await fixture.controller.dispatch({
      command: 'save-payment-info', tabId: opened.activeTabId,
    });
    assert.equal(saved.readbackVerified, true);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('manual status refresh clears every platform purchase after an exact refunded order readback', async () => {
  const orderUrl = 'https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=REFUND-1';
  const fixture = createFixture({
    purchaseReadback: {
      override: {
        purchasePlatform: '淘宝',
        purchaseOrderNumber: 'TAOBAO-REFUND-1',
        purchaseOrderUrl: orderUrl,
        sourceCostCny: 28.8,
        purchaseOrderStatus: '待发货',
      },
      sourceLinks: [{ productKey: 'sku-refund-a', platform: '淘宝', url: 'https://item.taobao.com/item.htm?id=7788990011' }],
    },
    genericPurchaseCapture: {
      platform: '淘宝',
      pageType: 'order-detail',
      pageUrl: orderUrl,
      purchaseOrderUrl: orderUrl,
      sourceUrl: 'https://item.taobao.com/item.htm?id=7788990011',
      sourceProductId: '7788990011',
      productTitle: '现代简约落地式铁艺花盆支架',
      quantity: 1,
      purchaseOrderNumber: 'TAOBAO-REFUND-1',
      purchasePrice: 28.8,
      purchaseOrderStatus: '退款成功',
      refundConfirmed: true,
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-b', url: orderUrl });
    await fixture.controller.dispatch({
      command: 'set-target', tabId: opened.activeTabId,
      target: {
        targetId: 'target-refund-a', shopId: 'shop-refund-a',
        orderKey: 'shop-refund-a:order-1', sku: 'sku-refund-a',
        productTitle: '现代简约落地式铁艺花盆支架', quantity: 1,
      },
    });
    const result = await fixture.controller.dispatch({
      command: 'refresh-order-status', tabId: opened.activeTabId,
    });
    assert.equal(result.refunded, true);
    assert.equal(result.purchaseContext, null);
    assert.equal(result.readback.override.purchasePlatform, '');
    assert.equal(result.readback.override.purchaseOrderNumber, '');
    assert.equal(result.readback.override.sourceCostCny, null);
    assert.ok(fixture.calls.some((call) => call.type === 'refund-confirm'));
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('purchase context never resurrects a refunded platform or amount from retained source evidence', async () => {
  const fixture = createFixture({
    purchaseReadback: {
      override: {
        purchasePlatform: '',
        purchaseOrderNumber: '',
        sourceCostCny: null,
        forcePurchaseStatus: '待拍单',
        voidedPurchaseOrderNo: 'VOIDED-PDD-1',
        purchaseRefundConfirmed: true,
      },
      sourceLinks: [{ platform: '拼多多', url: 'https://mobile.yangkeduo.com/goods.html?goods_id=1', priceValue: 52.71 }],
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    await fixture.controller.dispatch({
      command: 'set-target', tabId: opened.activeTabId,
      target: { targetId: 'target-voided', shopId: 'shop-a', orderKey: 'shop-a:order-1' },
    });
    await assert.rejects(
      fixture.controller.dispatch({ command: 'purchase-context', tabId: opened.activeTabId }),
      (error) => error.code === 'CROSS_BORDER_PACKAGE_CONTEXT_MISSING',
    );
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('embedded open applies exact bounds and target URL in the same queued command', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: FIXTURE_URL,
      bounds: { x: 510, y: 120, width: 860, height: 640, visible: true, boundsVersion: 7 },
      workbench: { kind: 'purchase-order', displayMode: 'embedded' },
    });
    const active = opened.tabs.find((tab) => tab.tabId === opened.activeTabId);
    assert.equal(opened.visible, true);
    assert.equal(active.accountId, 'account-a');
    assert.equal(active.requestedUrl, FIXTURE_URL);
    assert.equal(active.embedding.embedded, true);
    assert.equal(active.embedding.parentHwnd, active.embedding.actualParentHwnd);
    assert.deepEqual(fixture.runtimeOpenCalls[0].initialBounds, {
      x: 510,
      y: 120,
      width: 860,
      height: 640,
      visible: true,
    });
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('embedded open waits for the Chromium surface after a fit-width zoom handoff', async () => {
  const fixture = createFixture({ embeddedSurfaceWarmupFailures: 2 });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: FIXTURE_URL,
      bounds: { x: 510, y: 120, width: 860, height: 640, visible: true, boundsVersion: 7 },
      workbench: { kind: 'purchase-order', displayMode: 'embedded' },
    });
    const active = opened.tabs.find((tab) => tab.tabId === opened.activeTabId);
    const profile = fixture.profiles.get({
      accountId: 'account-a',
      accountIncarnation: '2026-07-17T00:00:00.000Z',
    });
    assert.equal(opened.visible, true);
    assert.equal(active.embedding.browserSurfaceVisible, true);
    assert.equal(fixture.runtime.get(profile.ownerRef).boundsRequestCount, 3);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('standalone product open accepts native minimum-size readback after leaving an embedded workbench', async () => {
  const fixture = createFixture({
    standaloneBoundsClamp: (bounds) => ({
      ...bounds,
      width: Math.max(1240, Number(bounds.width) || 0),
      height: Math.max(720, Number(bounds.height) || 0),
    }),
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: FIXTURE_URL,
      bounds: { x: 510, y: 120, width: 860, height: 640, visible: true, boundsVersion: 7 },
      workbench: { kind: 'purchase-order', displayMode: 'embedded' },
    });

    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: `${FIXTURE_URL}?product=1`,
      bounds: { x: 200, y: 100, width: 960, height: 620, visible: true, boundsVersion: 8 },
      workbench: null,
    });
    const active = opened.tabs.find((tab) => tab.tabId === opened.activeTabId);
    const profile = fixture.profiles.get({
      accountId: 'account-a',
      accountIncarnation: '2026-07-17T00:00:00.000Z',
    });

    assert.equal(opened.visible, true);
    assert.equal(active.embedding.requested, false);
    assert.equal(fixture.runtime.get(profile.ownerRef).workbench, null);
    assert.equal(fixture.runtime.get(profile.ownerRef).bounds.width, 1240);
    assert.equal(fixture.runtime.get(profile.ownerRef).bounds.height, 720);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('embedded interactive open preempts a long Ozon collector read without losing target accuracy', async () => {
  const fixture = createFixture({ blockPagination: true });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const collector = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'integration-ozon-a',
      ownerType: 'integration_profile',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    });
    const collectorTab = collector.tabs.find((tab) => tab.background === true);
    assert.ok(collectorTab?.tabId);
    const collectorRuntime = fixture.runtime.get(fixture.runtimeOpenCalls[0].ownerRef);
    const collectorRequest = collectorRuntime.request.bind(collectorRuntime);
    collectorRuntime.request = (command, ...args) => (
      command === 'bounds' ? new Promise(() => undefined) : collectorRequest(command, ...args)
    );

    const pagination = fixture.controller.dispatch({
      command: 'ozon-data-paginate',
      tabId: collectorTab.tabId,
      sourceSequence: 1,
      maxPages: 250,
      delayMs: 3_000,
    });
    const paginationCancelled = assert.rejects(
      pagination,
      (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED',
    );
    await fixture.paginationStarted;
    const startedAt = Date.now();
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: FIXTURE_URL,
      bounds: { x: 463, y: 135, width: 921, height: 701, visible: true, boundsVersion: 9 },
      workbench: { kind: 'purchase-order', displayMode: 'embedded' },
    });

    await paginationCancelled;
    const active = opened.tabs.find((tab) => tab.tabId === opened.activeTabId);
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(active.accountId, 'account-a');
    assert.equal(active.requestedUrl, FIXTURE_URL);
    assert.equal(opened.tabs.some((tab) => tab.tabId === collectorTab.tabId && tab.background === true), true);
    assert.match(fixture.logs.join(''), /interactive command=open preempt=ozon-data-paginate/u);
    assert.match(fixture.logs.join(''), /open stage=queue-ready/u);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a pagination timeout keeps the market collector session alive for an exact batch retry', async () => {
  const fixture = createFixture({ paginationFailures: 1 });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'integration-ozon-a',
      ownerType: 'integration_profile',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries',
    });
    const collectorTab = opened.tabs.find((tab) => tab.background === true);
    assert.ok(collectorTab?.tabId);

    await assert.rejects(
      fixture.controller.dispatch({
        command: 'ozon-data-paginate',
        tabId: collectorTab.tabId,
        sourceSequence: 7,
        maxPages: 5,
        delayMs: 100,
      }),
      (error) => error.code === 'PURCHASE_BROWSER_COMMAND_TIMEOUT',
    );

    const afterTimeout = fixture.controller.snapshot().tabs.find((tab) => tab.tabId === collectorTab.tabId);
    assert.ok(afterTimeout);
    assert.equal(afterTimeout.crashed, false);
    assert.equal(afterTimeout.sessionId, collectorTab.sessionId);
    assert.equal(afterTimeout.generation, collectorTab.generation);

    const retried = await fixture.controller.dispatch({
      command: 'ozon-data-paginate',
      tabId: collectorTab.tabId,
      sourceSequence: 7,
      maxPages: 5,
      delayMs: 100,
    });
    assert.equal(retried.result.pagesFetched, 2);
    assert.equal(retried.sessionId, collectorTab.sessionId);
    assert.equal(fixture.controller.snapshot().tabs.some((tab) => tab.tabId === collectorTab.tabId), true);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('standalone purchase-account login open preempts a long Ozon collector read', async () => {
  const fixture = createFixture({ blockPagination: true });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const collector = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'integration-ozon-a',
      ownerType: 'integration_profile',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    });
    const collectorTab = collector.tabs.find((tab) => tab.background === true);
    assert.ok(collectorTab?.tabId);

    const pagination = fixture.controller.dispatch({
      command: 'ozon-data-paginate',
      tabId: collectorTab.tabId,
      sourceSequence: 1,
      maxPages: 250,
      delayMs: 3_000,
    });
    const paginationCancelled = assert.rejects(
      pagination,
      (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED',
    );
    await fixture.paginationStarted;

    const startedAt = Date.now();
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: FIXTURE_URL,
      bounds: { x: 240, y: 120, width: 1240, height: 720, visible: true, boundsVersion: 10 },
      workbench: null,
    });

    await paginationCancelled;
    const active = opened.tabs.find((tab) => tab.tabId === opened.activeTabId);
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(active.accountId, 'account-a');
    assert.equal(active.requestedUrl, FIXTURE_URL);
    assert.equal(active.embedding.requested, false);
    assert.equal(opened.tabs.some((tab) => tab.tabId === collectorTab.tabId && tab.background === true), true);
    assert.match(fixture.logs.join(''), /interactive command=open preempt=ozon-data-paginate/u);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('automatic workbench target binding preempts a collector read instead of leaving the card loading', async () => {
  const fixture = createFixture({ blockPagination: true });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const interactive = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: FIXTURE_URL,
    });
    const interactiveTab = interactive.tabs.find((tab) => tab.accountId === 'account-a');
    const collector = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'integration-ozon-a',
      ownerType: 'integration_profile',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    });
    const collectorTab = collector.tabs.find((tab) => tab.background === true);
    assert.ok(interactiveTab?.tabId && collectorTab?.tabId);

    const pagination = fixture.controller.dispatch({
      command: 'ozon-data-paginate',
      tabId: collectorTab.tabId,
      sourceSequence: 1,
      maxPages: 250,
      delayMs: 3_000,
    });
    const paginationCancelled = assert.rejects(
      pagination,
      (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED',
    );
    await fixture.paginationStarted;
    const target = {
      targetId: 'target-auto-bind',
      shopId: 'shop-a',
      orderKey: 'client-a:posting-a',
      sku: 'sku-a',
      requiredFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'sourceUrl'],
    };
    const startedAt = Date.now();
    const locked = await fixture.controller.dispatch({
      command: 'set-target',
      tabId: interactiveTab.tabId,
      target,
    });

    await paginationCancelled;
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(locked.targetPhase, 'target-locked');
    assert.equal(locked.target.orderKey, 'client-a:posting-a');
    assert.match(fixture.logs.join(''), /interactive command=set-target preempt=ozon-data-paginate/u);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('interactive collector probe preempts a background pagination task on the same hidden tab', async () => {
  const fixture = createFixture({ blockPagination: true });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'integration-ozon-a',
      ownerType: 'integration_profile',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    });
    const tab = opened.tabs.find((item) => item.background === true);
    assert.ok(tab?.tabId);
    const pagination = fixture.controller.dispatch({
      command: 'ozon-data-paginate',
      tabId: tab.tabId,
      sourceSequence: 1,
      maxPages: 250,
      delayMs: 3_000,
    });
    const paginationCancelled = assert.rejects(
      pagination,
      (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED',
    );
    await fixture.paginationStarted;
    const probe = await fixture.controller.dispatch({
      command: 'ozon-data-probe',
      collectorPriority: 'interactive',
      tabId: tab.tabId,
      path: '/api/site/exa-products-api/missing_items',
      method: 'POST',
      body: { filter: { product_name: 'платье' }, limit: '50', offset: '0' },
      origin: 'https://api.seller.ozon.ru',
    });
    await paginationCancelled;
    assert.equal(probe.result.quality, 'confirmed-data');
    assert.match(fixture.logs.join(''), /interactive command=ozon-data-probe preempt=ozon-data-paginate/u);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('embedded open does not wait for an unrelated interactive tab that is already hidden', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: FIXTURE_URL,
      bounds: { x: 20, y: 30, width: 800, height: 600, visible: true },
    });
    await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-b',
      url: FIXTURE_URL,
    });
    const accountAProfile = fixture.profiles.get({
      accountId: 'account-a',
      accountIncarnation: '2026-07-17T00:00:00.000Z',
    });
    const inactiveBrowser = fixture.runtime.get(accountAProfile.ownerRef);
    const inactiveRequest = inactiveBrowser.request.bind(inactiveBrowser);
    inactiveBrowser.request = (command, ...args) => (
      command === 'bounds' ? new Promise(() => undefined) : inactiveRequest(command, ...args)
    );

    const startedAt = Date.now();
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-b',
      url: `${FIXTURE_URL}?exact=1`,
      bounds: { x: 463, y: 135, width: 921, height: 701, visible: true, boundsVersion: 11 },
      workbench: { kind: 'purchase-order', displayMode: 'embedded' },
    });
    const active = opened.tabs.find((tab) => tab.tabId === opened.activeTabId);
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(active.accountId, 'account-b');
    assert.equal(active.requestedUrl, `${FIXTURE_URL}?exact=1`);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('CEF controller keeps the existing IPC contract while isolating accounts and completing readback', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'bounds',
      bounds: { x: 10, y: 20, width: 900, height: 600, visible: true },
    });
    const first = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    assert.equal(first.engine, 'cef');
    assert.deepEqual(fixture.runtimeOpenCalls[0].initialBounds, {
      x: 10,
      y: 20,
      width: 900,
      height: 600,
      visible: true,
    });
    assert.equal(fixture.runtimeOpenCalls[0].navigationWaitUntil, 'commit');
    const accountAProfileAtOpen = fixture.profiles.get({
      accountId: 'account-a',
      accountIncarnation: '2026-07-17T00:00:00.000Z',
    });
    assert.equal(fixture.runtime.get(accountAProfileAtOpen.ownerRef).visible, true);
    const second = await fixture.controller.dispatch({ command: 'open', accountId: 'account-b', url: FIXTURE_URL });
    assert.equal(second.tabs.length, 2);
    assert.notEqual(fixture.profiles.get({ accountId: 'account-a', accountIncarnation: '2026-07-17T00:00:00.000Z' }).ownerRef,
      fixture.profiles.get({ accountId: 'account-b', accountIncarnation: '2026-07-17T00:00:00.000Z' }).ownerRef);
    assert.equal(fixture.profiles.get({ accountId: 'account-a', accountIncarnation: '2026-07-17T00:00:00.000Z', platformName: '1688' }).platformKey, '1688');
    assert.equal(fixture.profiles.get({ accountId: 'account-b', accountIncarnation: '2026-07-17T00:00:00.000Z', platformName: '淘宝' }).platformKey, 'taobao');

    const completed = await fixture.controller.dispatch({
      command: 'execute-task',
      tabId: 'tab-1',
      taskId: 'task-a',
      executionCapability: 'fixture-capability',
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.task.completed, true);
    assert.equal(fixture.calls.filter((call) => call.type === 'complete').length, 1);
    assert.equal(fixture.calls.filter((call) => call.type === 'fail').length, 0);

    const crossBorder = await fixture.controller.dispatch({
      command: 'cross-border-sync',
      tabId: 'tab-1',
      payload: { commit: true, confirmed: true },
    });
    assert.deepEqual(crossBorder.result, { ok: true, total: 1, synced: 1, commit: true });

    const bounded = await fixture.controller.dispatch({
      command: 'bounds',
      bounds: { x: 10, y: 20, width: 900, height: 600, visible: true },
    });
    assert.equal(bounded.visible, true);
    assert.ok(fixture.sent.length > 0);

    const target = {
      targetId: 'target-a',
      shopId: 'shop-a',
      orderKey: 'order-a',
      sku: 'sku-a',
    };
    const locked = await fixture.controller.dispatch({ command: 'set-target', tabId: 'tab-1', target });
    assert.equal(locked.target.orderKey, 'order-a');
    const capturePreview = await fixture.controller.dispatch({ command: 'capture-preview', tabId: 'tab-1' });
    assert.equal(capturePreview.preview.previewId, 'capture-preview-a');
    const captureComplete = await fixture.controller.dispatch({
      command: 'capture-confirm',
      tabId: 'tab-1',
      confirmationToken: capturePreview.preview.confirmationToken,
    });
    assert.equal(captureComplete.result.readbackVerified, true);
    assert.equal(fixture.calls.filter((call) => call.type === 'capture-preview').length, 1);
    assert.equal(fixture.calls.filter((call) => call.type === 'capture-confirm').length, 1);

    const accountBProfile = fixture.profiles.get({
      accountId: 'account-b',
      accountIncarnation: '2026-07-17T00:00:00.000Z',
    });
    fixture.runtime.get(accountBProfile.ownerRef).emit('crashed', {
      code: 'PURCHASE_BROWSER_CEF_PROCESS_EXITED',
    });
    await assert.rejects(
      fixture.controller.dispatch({ command: 'activate', tabId: 'tab-2' }),
      { code: 'PURCHASE_BROWSER_SESSION_CRASHED' },
    );
    const restarted = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-b',
      url: FIXTURE_URL,
    });
    assert.equal(restarted.tabs.length, 2);
    assert.equal(restarted.activeTabId, 'tab-3');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Ozon integration profile verifies persistent login without writing purchase-account plugin state', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      url: 'https://seller.ozon.ru/app/registration/signin?registration=1&locale=zh-hans',
    });
    const response = await fixture.controller.dispatch({
      command: 'ozon-login-status',
      tabId: 'tab-1',
    });
    assert.deepEqual(response.result, {
      loggedIn: true,
      cookieSaved: true,
      cookieCount: 7,
      verifiedAt: '2026-07-21T08:00:00.000Z',
      connected: true,
      identityMatched: null,
      identityStatus: '',
      profile: {
        id: 'integration-ozon-a',
        configStatus: '连接成功',
        tokenStatus: 'Cookie 已保存',
        browserCompanyId: '',
        browserCompanyName: '',
        identityStatus: '',
      },
    });
    assert.equal(fixture.integrationLoginSaves.length, 1);
    assert.equal(fixture.integrationLoginSaves[0].profileId, 'integration-ozon-a');
    const observer = await fixture.controller.dispatch({
      command: 'ozon-data-status',
      tabId: 'tab-1',
    });
    assert.equal(observer.result.ready, true);
    assert.equal(observer.result.extensionVersion, '2.0.0');
    const captured = await fixture.controller.dispatch({
      command: 'ozon-data-read',
      tabId: 'tab-1',
      afterSequence: 3,
      limit: 5,
      drain: true,
    });
    assert.equal(captured.result.entries[0].endpoint, '/api/site/exa-products-api/missing_items');
    assert.equal(captured.result.queueLength, 0);
    const normalized = await fixture.controller.dispatch({
      command: 'ozon-data-normalize',
      tabId: 'tab-1',
      afterSequence: 0,
      limit: 10,
    });
    assert.equal(normalized.result.datasets[0].records[0].id, 123);
    const rawPayload = await fixture.controller.dispatch({
      command: 'ozon-data-payload',
      tabId: 'tab-1',
      sourceSequence: 4,
      offset: 0,
      limit: 256 * 1024,
    });
    assert.equal(rawPayload.result.chunk, '{}');
    assert.equal(rawPayload.result.complete, true);
    const searched = await fixture.controller.dispatch({
      command: 'ozon-data-search',
      tabId: 'tab-1',
      sourceSequence: 4,
      query: 'машинка на радиоуправлении',
    });
    assert.equal(searched.result.capturedSequence, 8);
    assert.equal(searched.result.recordCount, 5);
    assert.equal(searched.result.query, 'машинка на радиоуправлении');
    const probed = await fixture.controller.dispatch({
      command: 'ozon-data-probe',
      tabId: 'tab-1',
      path: '/api/site/seller-analytics/what_to_sell/data/v3',
      method: 'POST',
      body: { limit: '50', offset: '0' },
      origin: 'https://api.seller.ozon.ru',
    });
    assert.equal(probed.result.endpoint, '/api/site/seller-analytics/what_to_sell/data/v3');
    assert.equal(probed.result.recordCount, 50);
    const paginated = await fixture.controller.dispatch({
      command: 'ozon-data-paginate',
      tabId: 'tab-1',
      sourceSequence: 4,
      maxPages: 2,
      delayMs: 250,
    });
    assert.equal(paginated.result.pagesFetched, 2);
    assert.equal(fixture.calls.some((call) => call.type === 'plugin'), false);
    assert.equal(fixture.profiles.get({
      accountId: 'integration-ozon-a',
      accountIncarnation: '2026-07-21T00:00:00.000Z',
    }).platformKey, 'ozon');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Ozon integration profile invalidates stale persisted Cookie state and blocks market reads', async () => {
  const fixture = createFixture({
    ozonLoginVerification: {
      loggedIn: false,
      cookieSaved: false,
      cookieCount: 5,
      verificationSource: 'login-page',
      probeStatus: 401,
      verifiedAt: '2026-08-12T02:00:00.000Z',
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries',
    });
    const collector = opened.tabs.find((tab) => tab.browserRole === 'market-collector');
    const status = await fixture.controller.dispatch({
      command: 'ozon-login-status',
      tabId: collector.tabId,
      persistStatus: true,
    });

    assert.equal(status.result.loggedIn, false);
    assert.equal(status.result.profile.configStatus, '需要重新登录');
    assert.equal(status.result.profile.tokenStatus, 'Cookie 已失效');
    await assert.rejects(
      fixture.controller.dispatch({ command: 'ozon-data-status', tabId: collector.tabId }),
      { code: 'OZON_LOGIN_REQUIRED' },
    );
    assert.equal(fixture.integrationLoginSaves.length, 1);
    assert.equal(fixture.integrationLoginSaves.at(-1).value.loggedIn, false);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Ozon login gate converts exhausted local transport retries into a stable pre-submit failure', async () => {
  const fixture = createFixture({
    integrationLoginSaveFailures: 1,
    ozonLoginVerification: {
      loggedIn: true,
      cookieSaved: true,
      cookieCount: 18,
      verificationSource: 'seller-app-shell',
      verifiedAt: '2026-08-17T12:07:39.000Z',
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      browserRole: 'follow-seller-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    });
    const collector = opened.tabs.find((tab) => tab.browserRole === 'follow-seller-collector');

    await assert.rejects(
      fixture.controller.dispatch({
        command: 'ozon-login-status',
        tabId: collector.tabId,
        persistStatus: true,
      }),
      (error) => {
        assert.equal(error.code, 'PURCHASE_BROWSER_INTEGRATION_LOGIN_STATUS_PERSIST_FAILED');
        assert.equal(error.causeCode, 'ECONNRESET');
        assert.equal(error.attempts, 3);
        return true;
      },
    );
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Ozon Seller browser forwards company identity and accepts API-verification pending state', async () => {
  const fixture = createFixture({
    ozonLoginVerification: {
      loggedIn: true,
      cookieSaved: true,
      cookieCount: 7,
      companyId: '4616153',
      companyName: 'SuperBaiss',
      verificationSource: 'seller-company-context',
      verifiedAt: '2026-08-15T15:16:32.000Z',
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      browserRole: 'interactive',
      background: false,
      restoreVisible: true,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    });
    const status = await fixture.controller.dispatch({
      command: 'ozon-login-status',
      tabId: opened.activeTabId,
      persistStatus: true,
    });
    assert.equal(status.result.loggedIn, true);
    assert.equal(status.result.connected, false);
    assert.equal(status.result.identityMatched, true);
    assert.equal(status.result.identityStatus, 'browser-matched');
    assert.equal(status.result.profile.browserCompanyId, '4616153');
    assert.deepEqual(fixture.integrationLoginSaves.at(-1), {
      profileId: 'integration-ozon-a',
      value: {
        loggedIn: true,
        cookieSaved: true,
        verifiedAt: '2026-08-15T15:16:32.000Z',
        verificationSource: 'seller-company-context',
        probeStatus: 0,
        companyId: '4616153',
        companyName: 'SuperBaiss',
      },
    });
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Ozon startup pending state never overwrites the last confirmed Cookie state', async () => {
  const fixture = createFixture({
    ozonLoginVerification: {
      loggedIn: false,
      cookieSaved: false,
      cookieCount: 15,
      verificationOutcome: 'pending',
      verificationPending: true,
      verificationSource: 'seller-page-pending',
      probeStatus: 403,
      pageProbeStatus: 403,
      verifiedAt: '2026-08-12T02:58:54.000Z',
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    });
    const collector = opened.tabs.find((tab) => tab.browserRole === 'market-collector');
    const status = await fixture.controller.dispatch({
      command: 'ozon-login-status',
      tabId: collector.tabId,
      persistStatus: true,
    });

    assert.equal(status.result.verificationPending, true);
    assert.equal(status.result.verificationOutcome, 'pending');
    assert.equal(status.result.profile, undefined);
    assert.equal(fixture.integrationLoginSaves.length, 0);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('shared Ozon command gate waits for startup pending to become connected', async () => {
	let verificationAttempt = 0;
	const fixture = createFixture({
	  ozonLoginVerification: async () => {
	    verificationAttempt += 1;
	    if (verificationAttempt < 3) {
	      return {
	        loggedIn: false,
	        cookieSaved: false,
	        cookieCount: 18,
	        verificationOutcome: 'pending',
	        verificationPending: true,
	        verificationSource: 'seller-page-pending',
	        probeStatus: 403,
	      };
	    }
	    return {
	      loggedIn: true,
	      cookieSaved: true,
	      cookieCount: 18,
	      verificationOutcome: 'connected',
	      verificationPending: false,
	      verificationSource: 'seller-app-shell',
	      verifiedAt: '2026-08-17T13:50:59.000Z',
	    };
	  },
	});
	try {
	  fixture.controller.attachHost(fixture.hostWindow);
	  const opened = await fixture.controller.dispatch({
	    command: 'open',
	    ownerType: 'integration_profile',
	    accountId: 'integration-ozon-a',
	    browserRole: 'follow-seller-collector',
	    background: true,
	    restoreVisible: false,
	    url: 'https://seller.ozon.ru/app/dashboard/main',
	  });
	  const collector = opened.tabs.find((tab) => tab.browserRole === 'follow-seller-collector');
	  const result = await fixture.controller.dispatch({ command: 'ozon-data-status', tabId: collector.tabId });

	  assert.equal(result.result.ready, true);
	  assert.equal(verificationAttempt, 3);
	  assert.equal(fixture.integrationLoginSaves.length, 0);
	  assert.equal(fixture.logs.filter((line) => line.includes('ozon login gate pending')).length, 2);
	} finally {
	  fixture.controller.dispose();
	  fs.rmSync(fixture.directory, { recursive: true, force: true });
	}
});

test('shared Ozon command gate keeps exhausted pending distinct from explicit logout', async () => {
	let verificationAttempt = 0;
	const fixture = createFixture({
	  ozonLoginVerification: async () => {
	    verificationAttempt += 1;
	    return {
	      loggedIn: false,
	      cookieSaved: false,
	      cookieCount: 18,
	      verificationOutcome: 'pending',
	      verificationPending: true,
	      verificationSource: 'seller-page-pending',
	      probeStatus: 403,
	    };
	  },
	});
	try {
	  fixture.controller.attachHost(fixture.hostWindow);
	  const opened = await fixture.controller.dispatch({
	    command: 'open',
	    ownerType: 'integration_profile',
	    accountId: 'integration-ozon-a',
	    browserRole: 'follow-seller-collector',
	    background: true,
	    restoreVisible: false,
	    url: 'https://seller.ozon.ru/app/dashboard/main',
	  });
	  const collector = opened.tabs.find((tab) => tab.browserRole === 'follow-seller-collector');

	  await assert.rejects(
	    fixture.controller.dispatch({ command: 'ozon-data-status', tabId: collector.tabId }),
	    { code: 'OZON_LOGIN_VERIFICATION_PENDING' },
	  );
	  assert.equal(verificationAttempt, 12);
	  assert.equal(fixture.integrationLoginSaves.length, 0);
	  assert.equal(fixture.logs.filter((line) => line.includes('ozon login gate pending')).length, 12);
	} finally {
	  fixture.controller.dispose();
	  fs.rmSync(fixture.directory, { recursive: true, force: true });
	}
});

test('purchase account login verification stays on the exact interactive native tab', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: 'https://www.1688.com/',
    });
    const response = await fixture.controller.dispatch({
      command: 'purchase-login-status',
      tabId: 'tab-1',
    });
    assert.deepEqual(response.result, {
      loggedIn: true,
      cookieSaved: true,
      cookieCount: 6,
      platformKey: '1688',
      verificationSource: 'strong-auth-cookie',
      verifiedAt: '2026-08-11T08:30:00.000Z',
    });
    const browser = fixture.runtime.get(fixture.runtimeOpenCalls[0].ownerRef);
    assert.ok(browser.requests.includes('purchase-login-status'));
    assert.equal(response.state.tabs[0].accountId, 'account-a');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('market collector has its own hidden session while sharing profile storage with the interactive Ozon tab', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'bounds',
      bounds: { x: 20, y: 30, width: 1100, height: 720, visible: true },
    });
    const interactiveState = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      browserRole: 'interactive',
      url: 'https://www.ozon.ru/category/mashinki-radioupravlyaemye-7151/',
    });
    const interactive = interactiveState.tabs.find((tab) => tab.browserRole === 'interactive');
    assert.ok(interactive?.tabId);

    const withCollector = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries',
    });
    const collector = withCollector.tabs.find((tab) => tab.browserRole === 'market-collector');
    assert.ok(collector?.tabId);
    assert.notEqual(collector.tabId, interactive.tabId);
    assert.notEqual(collector.sessionId, interactive.sessionId);
    assert.equal(collector.background, true);
    assert.equal(collector.storageRef, interactive.storageRef);
    assert.equal(withCollector.activeTabId, interactive.tabId);
    assert.equal(withCollector.visible, true);
    assert.equal(fixture.runtimeOpenCalls.length, 2);
    assert.equal(fixture.runtimeOpenCalls[1].ownerRef, marketCollectorOwnerRef(interactive.storageRef));
    assert.equal(fixture.runtimeOpenCalls[1].storageRef, interactive.storageRef);
    assert.equal(fixture.runtimeOpenCalls[1].initialBounds.visible, false);
    assert.equal(fixture.runtime.get(fixture.runtimeOpenCalls[1].ownerRef).visible, false);

    await fixture.controller.dispatch({
      command: 'navigate',
      tabId: collector.tabId,
      url: 'https://seller.ozon.ru/app/analytics/graphs',
    });
    const afterCollectorNavigation = fixture.controller.snapshot();
    assert.equal(
      afterCollectorNavigation.tabs.find((tab) => tab.tabId === interactive.tabId).url,
      'https://www.ozon.ru/category/mashinki-radioupravlyaemye-7151/',
    );
    await assert.rejects(
      fixture.controller.dispatch({ command: 'activate', tabId: collector.tabId }),
      (error) => error.code === 'PURCHASE_BROWSER_BACKGROUND_TAB_NOT_ACTIVATABLE',
    );

    const closedInteractive = await fixture.controller.closeInteractiveTabs();
    assert.equal(closedInteractive.tabs.length, 1);
    assert.equal(closedInteractive.tabs[0].tabId, collector.tabId);
    assert.equal(closedInteractive.activeTabId, '');
    assert.equal(closedInteractive.visible, false);
    assert.equal(fixture.runtime.get(interactive.storageRef), null);
    assert.ok(fixture.runtime.get(marketCollectorOwnerRef(interactive.storageRef)));
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('product-link parser has its own hidden session and command queue beside a busy market collector', async () => {
  const fixture = createFixture({ blockPagination: true });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const collectorState = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries',
    });
    const collector = collectorState.tabs.find((tab) => tab.browserRole === 'market-collector');
    const pagination = fixture.controller.dispatch({
      command: 'ozon-data-paginate',
      tabId: collector.tabId,
      sourceSequence: 4,
      maxPages: 20,
    });
    await fixture.paginationStarted;

    const parserState = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      browserRole: 'product-link-parser',
      background: true,
      restoreVisible: false,
      url: 'https://www.ozon.ru/product/123',
    });
    const parser = parserState.tabs.find((tab) => tab.browserRole === 'product-link-parser');
    assert.ok(parser?.tabId);
    assert.equal(parser.background, true);
    assert.equal(parser.storageRef, collector.storageRef);
    assert.notEqual(parser.tabId, collector.tabId);
    assert.equal(
      fixture.runtimeOpenCalls.find((call) => call.browserRole === 'product-link-parser')?.ownerRef,
      productLinkParserOwnerRef(collector.storageRef),
    );
    assert.equal(fixture.controller.snapshot().queue.active?.name, 'ozon-data-paginate');
    assert.equal(fixture.controller.snapshot().productLinkQueue.active, null);

    await fixture.controller.dispatch({ command: 'force-close', tabId: collector.tabId });
    await assert.rejects(pagination, (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('follow-seller patrol owns a temporary hidden session and queue without touching other Ozon browsers', async () => {
  const fixture = createFixture({ blockPagination: true });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const interactiveState = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      browserRole: 'interactive',
      url: 'https://seller.ozon.ru/app/dashboard/main',
    });
    const interactive = interactiveState.tabs.find((tab) => tab.browserRole === 'interactive');
    const frontInteractiveState = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-follow-front-a',
      browserRole: 'interactive',
      url: 'https://www.ozon.ru/',
    });
    const frontInteractive = frontInteractiveState.tabs.find((tab) => (
      tab.browserRole === 'interactive' && tab.accountId === 'integration-follow-front-a'
    ));
    assert.equal(frontInteractive.integrationType, 'ozon-follow-seller-session');
    const collectorState = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries',
    });
    const collector = collectorState.tabs.find((tab) => tab.browserRole === 'market-collector');
    await assert.rejects(
      fixture.controller.dispatch({
        command: 'ozon-data-follow-sellers',
        tabId: collector.tabId,
        skus: ['1760246018'],
      }),
      { code: 'PURCHASE_BROWSER_FOLLOW_SELLER_ROLE_REQUIRED' },
    );

    const pagination = fixture.controller.dispatch({
      command: 'ozon-data-paginate',
      tabId: collector.tabId,
      sourceSequence: 4,
      maxPages: 20,
    });
    await fixture.paginationStarted;

    const followState = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-follow-front-a',
      browserRole: 'follow-seller-collector',
      background: true,
      restoreVisible: false,
      url: 'https://www.ozon.ru/',
    });
    const follow = followState.tabs.find((tab) => tab.browserRole === 'follow-seller-collector');
    assert.ok(follow?.tabId);
    assert.equal(follow.background, true);
    assert.equal(follow.storageRef, frontInteractive.storageRef);
    assert.notEqual(follow.storageRef, collector.storageRef);
    assert.notEqual(follow.tabId, collector.tabId);
    assert.notEqual(follow.tabId, interactive.tabId);
    assert.equal(
      fixture.runtimeOpenCalls.find((call) => call.browserRole === 'follow-seller-collector')?.ownerRef,
      followSellerCollectorOwnerRef(frontInteractive.storageRef),
    );
    assert.equal(
      fixture.runtimeOpenCalls.find((call) => call.browserRole === 'follow-seller-collector')?.proxy?.mode,
      'system',
    );
    assert.equal(fixture.controller.snapshot().queue.active?.name, 'ozon-data-paginate');
    assert.equal(fixture.controller.snapshot().followSellerQueue.active, null);

    const status = await fixture.controller.dispatch({ command: 'ozon-data-status', tabId: follow.tabId });
    assert.equal(status.result.ready, true);
    const followBrowser = fixture.runtime.get(followSellerCollectorOwnerRef(frontInteractive.storageRef));
    assert.equal(followBrowser.requests.includes('purchase-login-status'), true);
    assert.equal(followBrowser.requests.includes('ozon-login-status'), false);
    followBrowser.emit('follow-seller-result', {
      captureToken: 'capture-stream-1',
      result: { sku: '1760246018', followSellerConfirmed: true, followSellerCount: 2 },
    });
    const streamedEvent = fixture.sent
      .map(([, payload]) => payload)
      .find((payload) => payload?.event === 'follow-seller-result');
    assert.ok(streamedEvent);
    assert.equal(streamedEvent.tabId, follow.tabId);
    assert.equal(streamedEvent.captureToken, 'capture-stream-1');
    assert.equal(streamedEvent.result.sku, '1760246018');
    assert.equal(streamedEvent.result.followSellerCount, 2);
    const captured = await fixture.controller.dispatch({
      command: 'ozon-data-follow-sellers',
      tabId: follow.tabId,
      skus: ['1760246018', 'invalid', '1760246018', '1760246019'],
      concurrency: 99,
      includeProductFacts: false,
      captureToken: 'capture-command-1',
    });
    assert.equal(captured.result.requested, 2);
    assert.equal(captured.result.confirmed, 2);
    assert.deepEqual(
      captured.result.results.map((result) => result.sku),
      ['1760246018', '1760246019'],
    );
    const capturePayload = followBrowser.requestPayloads.find((item) => (
      item.command === 'ozon-data-follow-sellers'
    ))?.payload;
    assert.equal(capturePayload.concurrency, 8);
    assert.equal(capturePayload.includeProductFacts, false);
    assert.equal(capturePayload.captureToken, 'capture-command-1');
    const evidenceDirectory = path.join(fixture.directory, 'follow-seller-evidence', 'case-1');
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const psdPath = path.join(evidenceDirectory, 'evidence.psd');
    const pdfPath = path.join(evidenceDirectory, 'evidence.pdf');
    fs.writeFileSync(psdPath, Buffer.from('8BPS-fixture-psd'));
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.7 fixture %%EOF'));
    const fileHash = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const complaint = await fixture.controller.dispatch({
      command: 'ozon-submit-follow-seller-complaint',
      tabId: follow.tabId,
      evidenceId: 'evidence-1',
      speech: { ru: 'Фактическое обращение' },
      attachments: [
        { kind: 'psd', path: psdPath, sha256: fileHash(psdPath) },
        { kind: 'pdf', path: pdfPath, sha256: fileHash(pdfPath) },
      ],
    });
    assert.equal(complaint.result.ticketId, 'ticket-10001');
    const complaintPayload = followBrowser.requestPayloads.find((item) => (
      item.command === 'ozon-submit-follow-seller-complaint'
    ))?.payload;
    assert.equal(complaintPayload.attachments.length, 2);
    assert.deepEqual(complaintPayload.attachments.map((item) => item.kind), ['pdf', 'psd']);
    assert.equal(complaintPayload.speech.ru, 'Фактическое обращение');
    const manifestPath = path.join(evidenceDirectory, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ evidenceId: 'evidence-1' }));
    const currentImagePath = path.join(evidenceDirectory, 'current-image.png');
    fs.writeFileSync(currentImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    const quickComplaint = await fixture.controller.dispatch({
      command: 'ozon-submit-follow-seller-quick-complaint',
      tabId: follow.tabId,
      evidenceId: 'scheme1-evidence-1',
      evidencePath: manifestPath,
      sourceProductUrl: 'https://www.ozon.ru/product/1760246018/',
      originalSku: '1760246018',
	      offerId: 'OFFER-1760246018',
	      followerSkus: ['3771432837', '3771432838', '3771432837', '3771432839'],
	      followers: [
	        { sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' },
	        { sku: '3771432838', productLink: 'https://www.ozon.ru/product/3771432838/' },
	        { sku: '3771432839', productLink: 'https://www.ozon.ru/product/3771432839/' },
	      ],
	      evidenceFollowers: [
	        { sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' },
	        { sku: '3771432838', productLink: 'https://www.ozon.ru/product/3771432838/' },
	        { sku: '3771432839', productLink: 'https://www.ozon.ru/product/3771432839/' },
	      ],
	      resumeExisting: true,
	      reusePreparedEvidence: true,
	      resumeTicketId: '90620788',
	      resumePageUrl: 'https://seller.ozon.ru/app/messenger/?id=resume-ticket-1&group=support_v2',
	      resumePhase: 'wait-evidence-prompt',
	      stopAfterRepeatedPromptDetection: true,
	      speech: {
	        ru: 'Первичное доказательство',
	        initialEvidenceRu: 'Первичное доказательство',
	        supplementRu: 'Дата размещения карточки: {{LISTING_DATE}}.',
	        followerBatchRu: '3771432837\n3771432838\n3771432839',
	        zh: '准确话术',
	      },
      attachments: [{ kind: 'current_image', path: currentImagePath, sha256: fileHash(currentImagePath) }],
    });
    assert.equal(quickComplaint.result.ticketId, 'ticket-scheme1-10001');
    const quickPayload = followBrowser.requestPayloads.find((item) => (
      item.command === 'ozon-submit-follow-seller-quick-complaint'
    ))?.payload;
    assert.equal(quickPayload.materialDirectory, path.resolve(evidenceDirectory));
	    assert.deepEqual(quickPayload.followerSkus, ['3771432837', '3771432838', '3771432839']);
	    assert.equal(quickPayload.offerId, 'OFFER-1760246018');
	    assert.equal(quickPayload.evidenceFollowers.length, 3);
	    assert.equal(quickPayload.resumeExisting, true);
	    assert.equal(quickPayload.reusePreparedEvidence, true);
	    assert.equal(quickPayload.resumeTicketId, '90620788');
	    assert.equal(quickPayload.resumePageUrl, 'https://seller.ozon.ru/app/messenger/?id=resume-ticket-1&group=support_v2');
	    assert.equal(quickPayload.resumePhase, 'wait-evidence-prompt');
	    assert.equal(quickPayload.stopAfterRepeatedPromptDetection, true);
	    assert.equal(quickPayload.speech.supplementRu, 'Дата размещения карточки: {{LISTING_DATE}}.');
    assert.equal(quickPayload.attachments[0].kind, 'current_image');
    await assert.rejects(
      fixture.controller.dispatch({ command: 'ozon-data-read', tabId: follow.tabId }),
      { code: 'PURCHASE_BROWSER_FOLLOW_SELLER_COMMAND_INVALID' },
    );

    const afterFollowClose = await fixture.controller.dispatch({ command: 'force-close', tabId: follow.tabId });
    assert.deepEqual(
      afterFollowClose.tabs.map((tab) => tab.tabId).sort(),
      [interactive.tabId, frontInteractive.tabId, collector.tabId].sort(),
    );
    assert.ok(fixture.runtime.get(interactive.storageRef));
    assert.ok(fixture.runtime.get(marketCollectorOwnerRef(collector.storageRef)));
    assert.equal(fixture.runtime.get(followSellerCollectorOwnerRef(frontInteractive.storageRef)), null);

    await fixture.controller.dispatch({ command: 'force-close', tabId: collector.tabId });
    await assert.rejects(pagination, (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('follow-seller verification reveals the exact hidden CEF tab and hides the same session after manual recovery', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-follow-front-a',
      browserRole: 'follow-seller-collector',
      background: true,
      restoreVisible: false,
      url: 'https://www.ozon.ru/',
    });
    const follow = opened.tabs.find((tab) => tab.browserRole === 'follow-seller-collector');
    const ownerRef = followSellerCollectorOwnerRef(follow.storageRef);
    const browser = fixture.runtime.get(ownerRef);
    assert.equal(follow.background, true);
    assert.equal(browser.visible, false);
    assert.equal(fixture.runtimeOpenCalls.filter((call) => call.ownerRef === ownerRef).length, 1);

    const shown = await fixture.controller.dispatch({
      command: 'show-follow-seller-verification',
      tabId: follow.tabId,
      url: 'https://www.ozon.ru/product/product-1760246018/',
    });
    const shownTab = shown.tabs.find((tab) => tab.tabId === follow.tabId);
    assert.equal(shownTab.background, false);
    assert.equal(shownTab.followSellerVerificationVisible, true);
    assert.deepEqual(shownTab.followSellerVerificationStatus, {
      pageReady: true,
      challengeDetected: false,
      verificationReady: true,
      url: 'https://www.ozon.ru/product/product-1760246018/',
    });
    assert.equal(shownTab.url, 'https://www.ozon.ru/product/product-1760246018/');
    assert.equal(shown.activeTabId, follow.tabId);
    assert.equal(shown.visible, true);
    assert.equal(browser.visible, true);
    assert.equal(browser.requests.filter((command) => command === 'show-follow-seller-verification-browser').length, 2);
    assert.equal(fixture.runtime.get(ownerRef), browser);
    assert.equal(fixture.runtimeOpenCalls.filter((call) => call.ownerRef === ownerRef).length, 1);
    assert.equal(browser.requestPayloads.some((entry) => (
      entry.command === 'navigate'
      && entry.payload.url === 'https://www.ozon.ru/product/product-1760246018/'
    )), true);

    const hidden = await fixture.controller.dispatch({
      command: 'hide-follow-seller-verification',
      tabId: follow.tabId,
    });
    const hiddenTab = hidden.tabs.find((tab) => tab.tabId === follow.tabId);
    assert.equal(hiddenTab.background, true);
    assert.equal(hiddenTab.followSellerVerificationVisible, false);
    assert.deepEqual(hiddenTab.followSellerVerificationStatus, {
      pageReady: true,
      challengeDetected: false,
      verificationReady: true,
      url: 'https://www.ozon.ru/product/product-1760246018/',
    });
    assert.equal(hidden.visible, false);
    assert.equal(browser.visible, false);
    assert.equal(browser.requests.filter((command) => command === 'hide-follow-seller-verification-browser').length, 2);
    assert.equal(fixture.runtime.get(ownerRef), browser);
    assert.equal(fixture.runtimeOpenCalls.filter((call) => call.ownerRef === ownerRef).length, 1);

    const hiddenRead = await fixture.controller.dispatch({
      command: 'read-follow-seller-verification',
      tabId: follow.tabId,
    });
    assert.equal(hiddenRead.tabs.find((tab) => tab.tabId === follow.tabId)?.followSellerVerificationVisible, false);

    const reshown = await fixture.controller.dispatch({
      command: 'show-follow-seller-verification',
      tabId: follow.tabId,
      url: 'https://www.ozon.ru/product/product-1760246018/',
    });
    assert.equal(reshown.tabs.find((tab) => tab.tabId === follow.tabId)?.followSellerVerificationVisible, true);
    assert.equal(browser.requestPayloads.filter((entry) => entry.command === 'navigate').length, 1);

    browser.emit('window-hidden', { state: { ...browser.state } });
    const afterNativeClose = await fixture.controller.dispatch({ command: 'state' });
    const afterNativeCloseTab = afterNativeClose.tabs.find((tab) => tab.tabId === follow.tabId);
    assert.equal(afterNativeCloseTab.background, true);
    assert.equal(afterNativeCloseTab.followSellerVerificationVisible, false);
    assert.equal(afterNativeClose.visible, false);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('scheme1 visualization bypasses the busy follow-seller queue and targets the exact native session', async () => {
	const fixture = createFixture({ blockFollowSellerCapture: true });
	try {
		fixture.controller.attachHost(fixture.hostWindow);
		const opened = await fixture.controller.dispatch({
			command: 'open',
			ownerType: 'integration_profile',
			accountId: 'integration-follow-front-a',
			browserRole: 'follow-seller-collector',
			background: true,
			restoreVisible: false,
			url: 'https://www.ozon.ru/',
		});
		const follow = opened.tabs.find((tab) => tab.browserRole === 'follow-seller-collector');
		const capture = fixture.controller.dispatch({
			command: 'ozon-data-follow-sellers',
			tabId: follow.tabId,
			skus: ['1760246018'],
		});
		await fixture.followSellerCaptureStarted;

		const shown = await fixture.controller.dispatch({
			command: 'show-follow-seller-quick-browser',
			tabId: follow.tabId,
		});
		const ownerRef = followSellerCollectorOwnerRef(follow.storageRef);
		const browser = fixture.runtime.get(ownerRef);
		assert.equal(shown.command, 'show-follow-seller-quick-browser');
		assert.equal(browser.requestPayloads.some((entry) => entry.command === 'show-follow-seller-quick-browser'), true);

		fixture.releaseFollowSellerCapture();
		await capture;
	} finally {
		fixture.releaseFollowSellerCapture?.();
		fixture.controller.dispose();
		fs.rmSync(fixture.directory, { recursive: true, force: true });
	}
});

test('native CEF host keeps hidden launches inactive and shares RequestContext by storageRef', () => {
  const hostSource = fs.readFileSync(
    new URL('../../native/Wangzai.CefBrowserHost/BrowserHostForm.cs', import.meta.url),
    'utf8',
  );
  const sessionSource = fs.readFileSync(
    new URL('../../native/Wangzai.CefBrowserHost/BrowserSession.cs', import.meta.url),
    'utf8',
  );
  assert.match(hostSource, /Dictionary<string, SharedRequestContext> requestContexts/u);
  assert.match(hostSource, /AcquireRequestContext\(profile\)/u);
  assert.match(hostSource, /Boolean\(launchBounds, "visible"\)[\s\S]*!profile\.Background/u);
  assert.match(hostSource, /case "open-extension-manager"[\s\S]*OpenExtensionManager\(\)/u);
  assert.match(hostSource, /if \(embeddedMode\) extensionManagerForm\.Show\(\);[\s\S]*extensionManagerForm\.Show\(this\);/u);
  assert.match(sessionSource, /RequestContext sharedRequestContext/u);
  assert.match(sessionSource, /EvaluateScriptAsPromiseAsync\([\s\S]*return \(\{script\}\)/u);
  assert.match(sessionSource, /OZON_DATA_PAGINATION_UNAVAILABLE/u);
  assert.match(sessionSource, /OZON_DATA_PAGINATION_NOT_SAFE/u);
  assert.match(sessionSource, /OZON_DATA_PAYLOAD_NOT_FOUND/u);
  // The bounded wait-pay DOM scan returns a JSON string synchronously. Keep
  // the Promise guard for every other response reader; do not ban this one
  // verified synchronous call merely because it also names its result response.
  const waitPayReader = sessionSource.match(/private async Task<object> ScanPurchaseWaitPayOrdersAsync[\s\S]*?(?=\r?\n\tprivate async Task<object> ExecutePurchaseAutoOrderAsync)/u)?.[0];
  assert.ok(waitPayReader);
  assert.match(waitPayReader, /response\s*=\s*await Browser\.EvaluateScriptAsync\(\s*PurchaseWaitPayScanScript\.Value/u);
  const waitPaySource = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/PurchaseWaitPayScanScript.cs', import.meta.url), 'utf8');
  assert.doesNotMatch(waitPaySource, /\b(?:async|await)\b/u);
  assert.doesNotMatch(sessionSource.replace(waitPayReader, ''), /response\s*=\s*await Browser\.EvaluateScriptAsync\(/u);
  assert.doesNotMatch(sessionSource, /requestContext\.Dispose\(\)/u);
});

test('follow-seller patrol can reopen its isolated browser on the direct route without changing other browser profiles', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const systemState = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-follow-front-a',
      browserRole: 'follow-seller-collector',
      background: true,
      restoreVisible: false,
      networkMode: 'auto',
      url: 'https://www.ozon.ru/',
    });
    const systemTab = systemState.tabs.find((tab) => tab.browserRole === 'follow-seller-collector');
    assert.equal(fixture.runtimeOpenCalls.at(-1).proxy.mode, 'system');
    await fixture.controller.dispatch({ command: 'force-close', tabId: systemTab.tabId });

    await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-follow-front-a',
      browserRole: 'follow-seller-collector',
      background: true,
      restoreVisible: false,
      networkMode: 'direct',
      url: 'https://www.ozon.ru/',
    });
    assert.equal(fixture.runtimeOpenCalls.at(-1).proxy.mode, 'direct');
    await assert.rejects(
      fixture.controller.dispatch({
        command: 'open',
        ownerType: 'integration_profile',
        accountId: 'integration-follow-front-a',
        browserRole: 'follow-seller-collector',
        background: true,
        restoreVisible: false,
        networkMode: 'invalid-route',
        url: 'https://www.ozon.ru/',
      }),
      { code: 'PURCHASE_BROWSER_NETWORK_MODE_INVALID' },
    );
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('follow-seller auto route prefers a verified loopback HTTP proxy without changing explicit direct mode', async () => {
  const fixture = createFixture({
    resolveFollowSellerAutoProxy: async () => ({
      mode: 'fixed_servers',
      rules: 'http=127.0.0.1:7890;https=127.0.0.1:7890',
      bypassRules: '<-loopback>',
      credentialRef: '',
      source: 'verified-loopback-http-proxy',
    }),
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const autoState = await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-follow-front-a',
      browserRole: 'follow-seller-collector',
      background: true,
      restoreVisible: false,
      networkMode: 'auto',
      url: 'https://seller.ozon.ru/app/messenger?channel=SCRM',
    });
    const autoTab = autoState.tabs.find((tab) => tab.browserRole === 'follow-seller-collector');
    assert.equal(fixture.runtimeOpenCalls.at(-1).proxy.mode, 'fixed_servers');
    assert.equal(
      fixture.runtimeOpenCalls.at(-1).proxy.rules,
      'http=127.0.0.1:7890;https=127.0.0.1:7890',
    );
    await fixture.controller.dispatch({ command: 'force-close', tabId: autoTab.tabId });

    await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-follow-front-a',
      browserRole: 'follow-seller-collector',
      background: true,
      restoreVisible: false,
      networkMode: 'direct',
      url: 'https://www.ozon.ru/',
    });
    assert.equal(fixture.runtimeOpenCalls.at(-1).proxy.mode, 'direct');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('follow-seller recoverable reopen preserves the requested direct route', async () => {
  const fixture = createFixture({ recoverableNavigateFailures: 1 });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-follow-front-a',
      browserRole: 'follow-seller-collector',
      background: true,
      restoreVisible: false,
      networkMode: 'direct',
      url: 'https://www.ozon.ru/',
    });
    await fixture.controller.dispatch({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-follow-front-a',
      browserRole: 'follow-seller-collector',
      background: true,
      restoreVisible: false,
      networkMode: 'direct',
      url: 'https://www.ozon.ru/product/product-3559566970/',
    });

    assert.equal(fixture.runtimeOpenCalls.length, 2);
    assert.deepEqual(fixture.runtimeOpenCalls.map((item) => item.proxy.mode), ['direct', 'direct']);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('follow-seller capture uses hundred-row transport batches and never treats a batch as the shop total', () => {
  const hostSource = fs.readFileSync(
    new URL('../../native/Wangzai.CefBrowserHost/BrowserHostForm.cs', import.meta.url),
    'utf8',
  );
  const captureSource = fs.readFileSync(
    new URL('../../native/Wangzai.CefBrowserHost/OzonFollowSellerCapture.cs', import.meta.url),
    'utf8',
  );
  const controllerSource = fs.readFileSync(
    new URL('./cefPurchaseBrowserController.js', import.meta.url),
    'utf8',
  );
  const sessionSource = fs.readFileSync(
    new URL('../../native/Wangzai.CefBrowserHost/BrowserSession.cs', import.meta.url),
    'utf8',
  );

  assert.match(hostSource, /CaptureOzonFollowSellerPayloadsAsync[\s\S]*Take\(100\)/u);
  assert.match(hostSource, /const offersRoute = `\/modal\/otherOffersFromSellers\?product_id=\$\{sku\}&page_changed=true`;[\s\S]*requestStates\(\s*offersRoute/u);
  assert.match(hostSource, /string initialUrl = \$"https:\/\/www\.ozon\.ru\/product\/product-\{safeSkus\[0\]\}\/"/u);
  assert.match(hostSource, /const fetchWithDeadline = async[\s\S]*new AbortController\(\)/u);
  assert.match(hostSource, /const isRrChallengeUrl = \(value\)[\s\S]*searchParams\.has\('__rr'\)/u);
  assert.match(hostSource, /challengeDetected: true,[\s\S]*detail: 'OZON_RR_CHALLENGE'/u);
  assert.match(hostSource, /await sleep\(120 \+ \(\(index \* 47\) % 141\)\)/u);
  assert.match(hostSource, /Math\.Clamp\(concurrency, 1, 6\)/u);
  assert.match(hostSource, /const product = !includeProductFacts/u);
  assert.match(hostSource, /pageRefreshChallenge/u);
  assert.match(captureSource, /challengeDetected[\s\S]*OZON_RR_CHALLENGE/u);
  assert.match(hostSource, /requestStates\(\s*`\/product\/product-\$\{sku\}\/`,\s*'\/api\/composer-api\.bx\/page\/json\/v2',\s*sourceProductUrl,?\s*\)/u);
  assert.match(hostSource, /fetchWithDeadline\(`\/product\/product-\$\{sku\}\/`/u);
  assert.match(hostSource, /script\[type="application\/ld\+json"\]/u);
  assert.match(hostSource, /aggregateRating\?\.reviewCount \?\? aggregateRating\?\.ratingCount/u);
  assert.match(hostSource, /data-widget="webPrice"/u);
  assert.match(hostSource, /'totalScore'/u);
  assert.match(hostSource, /cardPriceCurrency/u);
  assert.match(hostSource, /OZON_PRODUCT_HTML_FACTS_NOT_FOUND/u);
  assert.match(hostSource, /\['webPrice-', 'webSale-', 'webProductPrice-'\]/u);
  assert.match(hostSource, /\['webReviewProductScore-', 'webProductReviews-'\]/u);
  assert.match(hostSource, /followSellerConfirmed: offers\.ok/u);
  assert.match(hostSource, /sku: String\(seller\?\.sku/u);
  assert.match(hostSource, /productLink: String\(seller\?\.productLink/u);
  assert.match(hostSource, /credentials: Array\.isArray\(seller\?\.credentials\)/u);
  assert.match(hostSource, /productFactsConfirmed: product\.ok/u);
  assert.match(hostSource, /orders: product\.ok[\s\S]*Number\.isInteger\(orders\)/u);
  assert.match(hostSource, /EvaluateScriptAsPromiseAsync\(script, scriptTimeout\)/u);
  assert.doesNotMatch(hostSource, /using IBrowser coreBrowser = browser\.GetBrowser\(\)/u);
  assert.doesNotMatch(
    sessionSource,
    /case "ozon-data-follow-sellers":\s*if \(!IsOzonDataPage\(\)\)/u,
  );
  assert.match(captureSource, /MaximumSkuCount = 100/u);
  assert.match(captureSource, /StreamingChunkSize = 12/u);
  assert.match(captureSource, /followSellerConfirmed/u);
  assert.match(captureSource, /\["sku"\] = SkuPattern\(\)\.IsMatch\(sellerSku\)/u);
  assert.match(captureSource, /\["productLink"\] = productLink/u);
  assert.match(captureSource, /private static string OzonLink/u);
  assert.match(captureSource, /productFactsConfirmed/u);
  assert.match(captureSource, /result\["orders"\] = orders/u);
  assert.doesNotMatch(captureSource, /new UrlRequest/u);
  assert.doesNotMatch(hostSource, /OzonProductLogisticsCapture|OzonSellerChromiumRequest/u);
  assert.equal(fs.existsSync(new URL(
    '../../native/Wangzai.CefBrowserHost/OzonProductLogisticsCapture.cs',
    import.meta.url,
  )), false);
  assert.equal(fs.existsSync(new URL(
    '../../native/Wangzai.CefBrowserHost/OzonSellerChromiumRequest.cs',
    import.meta.url,
  )), false);
  assert.match(controllerSource, /\.slice\(0, 100\)/u);
});

test('native CEF fences same-route navigation and self-heals a missing observer runtime', () => {
  const sessionSource = fs.readFileSync(
    new URL('../../native/Wangzai.CefBrowserHost/BrowserSession.cs', import.meta.url),
    'utf8',
  );
  const controllerSource = fs.readFileSync(
    new URL('./cefPurchaseBrowserController.js', import.meta.url),
    'utf8',
  );

  assert.match(
    sessionSource,
    /int requestedNavigation = Interlocked\.Increment\(ref navigationSequence\)[\s\S]*Interlocked\.Exchange\(ref navigationStartedSequence[\s\S]*requestedNavigation[\s\S]*Browser\.LoadUrl\(text\)/u,
  );
  assert.match(sessionSource, /navigationCompletedSequence = Volatile\.Read/u);
  assert.match(sessionSource, /EnsureOzonDataObserverRuntimeAsync\(package\)/u);
  assert.match(sessionSource, /ozon-analytics-observer\.js[\s\S]*EvaluateScriptAsync/u);
  assert.match(controllerSource, /navigationSequence: Number\(tab\.state\.navigationSequence\)/u);
  assert.match(controllerSource, /navigationCompletedSequence: Number\(tab\.state\.navigationCompletedSequence\)/u);
});

test('Ozon pagination budgets include per-page HTTP and serialization overhead in every controller layer', () => {
  const source = fs.readFileSync(
    new URL('./cefPurchaseBrowserController.js', import.meta.url),
    'utf8',
  );
  const nativeSource = fs.readFileSync(
    new URL('../../native/Wangzai.CefBrowserHost/BrowserSession.cs', import.meta.url),
    'utf8',
  );
  assert.match(source, /Math\.min\(1_200_000, 30_000 \+ boundedPages \* \(boundedDelay \+ 750\)\)/u);
  assert.match(source, /command === 'ozon-data-paginate'[\s\S]*Math\.min\(1_205_000, 150_000 \+ paginationPages \* \(paginationDelay \+ 30_000\)\)/u);
  assert.match(nativeSource, /PaginateOzonDataAsync\(payload\)[\s\S]*OzonAnalyticsCaptureScript\.Paginate\(payload\)[\s\S]*TimeSpan\.FromSeconds\(90\)/u);
  assert.match(nativeSource, /OzonAnalyticsCaptureScript\.CancelPagination[\s\S]*OZON_DATA_PAGINATION_TIMEOUT/u);
  assert.match(source, /boundedDelay = Math\.max\(100, Math\.min\(3000/u);
  assert.match(source, /paginationDelay = Math\.max\(100, Math\.min\(3000/u);
  assert.match(source, /command === 'ozon-data-probe'[\s\S]*45_000/u);
});

test('prewarm and first visible open share one CEF launch without a first-click failure', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'bounds',
      bounds: { x: 10, y: 20, width: 900, height: 600, visible: false },
    });
    const [prewarmResult, opened] = await Promise.all([
      fixture.controller.dispatch({ command: 'prewarm', accountId: 'account-a', url: FIXTURE_URL })
        .then((value) => ({ value }), (error) => ({ error })),
      fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL }),
    ]);
    assert.equal(fixture.runtimeOpenCalls.length, 1);
    assert.equal(prewarmResult.error?.code, 'PURCHASE_BROWSER_COMMAND_CANCELLED');
    assert.equal(opened.tabs.length, 1);
    assert.equal(opened.tabs[0].url, FIXTURE_URL);
    assert.equal(opened.tabs[0].crashed, false);
    const tabId = opened.tabs[0].tabId;
    const binding = { accountId: 'account-a', accountIncarnation: '2026-07-17T00:00:00.000Z' };
    const ownerRef = fixture.profiles.get(binding).ownerRef;
    const session = fixture.runtime.get(ownerRef);
    await fixture.controller.dispatch({ command: 'hide' });
    const activateRequestStart = session.requests.length;
    const restored = await fixture.controller.dispatch({ command: 'activate', tabId });
    const activateRequests = session.requests.slice(activateRequestStart);
    assert.equal(restored.activeTabId, tabId);
    assert.equal(restored.tabs[0].tabId, tabId);
    assert.equal(restored.tabs[0].url, FIXTURE_URL);
    assert.equal(fixture.profiles.get(binding).ownerRef, ownerRef);
    assert.equal(fixture.runtime.get(ownerRef), session, 'restore reuses the profile, cookies and browser process');
    assert.equal(activateRequests.filter((command) => command === 'restore').length, 0,
      'activation must not show the native window again after verified bounds');
    assert.equal(activateRequests.filter((command) => command === 'bounds').length, 1,
      'activation uses one visible bounds command');

    session.emit('navigation', {
      state: { ...session.state, url: 'https://mobile.yangkeduo.com/goods.html' },
    });
    const pddBounds = await fixture.controller.dispatch({
      command: 'bounds',
      bounds: { x: 20, y: 30, width: 1000, height: 700, visible: true },
    });
    assert.equal(pddBounds.visible, true);
    assert.equal(fixture.runtime.get(ownerRef).visible, true);
    assert.deepEqual(fixture.runtime.get(ownerRef).bounds, {
      x: 20,
      y: 30,
      width: 1000,
      height: 700,
      visible: true,
    });

    session.emit('navigation', { state: { ...session.state, url: FIXTURE_URL } });
    const normalBounds = await fixture.controller.dispatch({
      command: 'bounds',
      bounds: { x: 10, y: 20, width: 900, height: 600, visible: true },
    });
    assert.equal(normalBounds.visible, true);

    session.visible = false;
    session.emit('window-hidden', { state: { ...session.state } });
    const hiddenByNativeChrome = fixture.controller.snapshot();
    assert.equal(hiddenByNativeChrome.visible, false);
    assert.equal(hiddenByNativeChrome.tabs[0].phase, 'hidden');
    const hiddenBoundsVersion = hiddenByNativeChrome.boundsVersion;

    session.emit('loading', { state: { ...session.state, loading: false } });
    session.emit('address', { state: { ...session.state, url: FIXTURE_URL } });
    assert.equal(fixture.controller.snapshot().visible, false,
      'late page-state events cannot re-arm a window closed by native chrome');
    const staleVisible = await fixture.controller.dispatch({
      command: 'bounds',
      bounds: {
        x: 10,
        y: 20,
        width: 900,
        height: 600,
        visible: true,
        boundsVersion: hiddenBoundsVersion - 1,
      },
    });
    assert.equal(staleVisible.visible, false,
      'a visible bounds generation older than the native close fence is ignored');

    const reopenRequestStart = session.requests.length;
    const reopened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: FIXTURE_URL,
    });
    const reopenRequests = session.requests.slice(reopenRequestStart);
    assert.equal(reopened.visible, true);
    assert.equal(reopened.tabs[0].phase, 'ready');
    assert.equal(session.visible, true, 'opening again must restore the native form after its X button hides it');
    assert.equal(fixture.runtimeOpenCalls.length, 1, 'reopen keeps the existing account profile and CEF process');
    assert.equal(reopenRequests.filter((command) => command === 'restore').length, 0,
      'reopen must not show the stale rectangle before the verified bounds restore');
    assert.equal(reopenRequests.filter((command) => command === 'bounds').length, 1,
      'one visible bounds command owns the complete native restore');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('repeated prewarm requests for one platform account are coalesced before reaching CEF', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.attachBrowserOwner(fixture.hostWindow);
    const requests = Array.from(
      { length: 100 },
      () => fixture.controller.dispatch({ command: 'prewarm', accountId: 'account-a', url: FIXTURE_URL }),
    );
    const queued = fixture.controller.snapshot().queue;
    assert.equal(queued.active?.name, 'prewarm');
    assert.equal(queued.pending.filter((item) => item.name === 'prewarm').length, 0);

    const results = await Promise.all(requests);
    assert.equal(results.length, 100);
    assert.equal(fixture.runtimeOpenCalls.length, 1);
    assert.equal(results.every((result) => result.tabs.length === 1), true);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('PDD account prewarm also prepares one hidden independent payment window', async () => {
  const paymentPrewarms = [];
  const fixture = createFixture({
    alipayPaymentWindowController: {
      async prewarmLogin(payload) {
        paymentPrewarms.push(payload);
        return { ok: true, reused: false };
      },
      snapshot() { return { ok: true, windows: [] }; },
      async purgeOwner() { return { ok: true, verified: true }; },
    },
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'prewarm',
      accountId: 'account-pdd',
      url: 'https://mobile.yangkeduo.com/',
    });
    assert.equal(paymentPrewarms.length, 1);
    assert.equal(paymentPrewarms[0].ownerRef, 'account-pdd');
    assert.equal(paymentPrewarms[0].purchaseUrl, 'https://mobile.yangkeduo.com/orders.html?type=1&order_index=75');
    assert.equal(paymentPrewarms[0].cookies[0].name, 'PDDAccessToken');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Ozon integration prewarm without a URL restores the last profile URL and otherwise uses dashboard', async () => {
  const restoredFixture = createFixture();
  try {
    restoredFixture.controller.attachHost(restoredFixture.hostWindow);
    const binding = {
      accountId: 'integration-ozon-a',
      accountIncarnation: '2026-07-21T00:00:00.000Z',
      platformName: 'Ozon',
      ownerType: 'integration_profile',
    };
    restoredFixture.profiles.getOrCreate(binding, {
      lastUrl: 'https://seller.ozon.ru/app/analytics/what-to-sell',
    });
    await restoredFixture.controller.dispatch({
      command: 'prewarm',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
    });
    assert.equal(
      restoredFixture.runtimeOpenCalls[0].url,
      'https://seller.ozon.ru/app/analytics/what-to-sell',
    );
  } finally {
    restoredFixture.controller.dispose();
    fs.rmSync(restoredFixture.directory, { recursive: true, force: true });
  }

  const defaultFixture = createFixture();
  try {
    defaultFixture.controller.attachHost(defaultFixture.hostWindow);
    await defaultFixture.controller.dispatch({
      command: 'prewarm',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
    });
    assert.equal(
      defaultFixture.runtimeOpenCalls[0].url,
      'https://seller.ozon.ru/app/dashboard/main',
    );
  } finally {
    defaultFixture.controller.dispose();
    fs.rmSync(defaultFixture.directory, { recursive: true, force: true });
  }
});

test('CEF controller purges only the account profile, addon state and downloads after readback', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const result = await fixture.controller.dispatch({ command: 'purge-operation', operationId: 'removal-a' });
    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
    assert.equal(fixture.addonOwners.size, 0);
    assert.equal(fixture.calls.at(-1).type, 'purge-receipt');
    assert.equal(fixture.calls.at(-1).proof.profileAbsent, true);
    assert.equal(fixture.calls.at(-1).proof.artifactsAbsent, true);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('purge maintenance bypasses an unrelated collector and ignores renderer-selected owner paths', async () => {
  const fixture = createFixture({ blockPagination: true });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const collector = await fixture.controller.dispatch({ command: 'open', accountId: 'integration-ozon-a', ownerType: 'integration_profile', browserRole: 'market-collector', background: true, restoreVisible: false, url: 'https://seller.ozon.ru/app/dashboard/main' });
    const collectorTab = collector.tabs.find(tab => tab.background);
    const kept = await fixture.controller.dispatch({ command: 'open', accountId: 'account-b', url: FIXTURE_URL });
    const keptOwner = kept.tabs.find(tab => tab.accountId === 'account-b').storageRef;
    await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const pagination = fixture.controller.dispatch({ command: 'ozon-data-paginate', tabId: collectorTab.tabId, sourceSequence: 1, maxPages: 250, delayMs: 3000 });
    const cancelled = assert.rejects(pagination, { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
    await fixture.paginationStarted;
    const result = await fixture.controller.dispatch({ command: 'purge-operation', operationId: 'removal-a', accountId: 'account-b', ownerRef: keptOwner, storagePath: fixture.directory });
    assert.equal(result.verified, true);
    assert.equal(fixture.controller.snapshot().queue.active.name, 'ozon-data-paginate');
    assert.equal(fixture.controller.snapshot().tabs.some(tab => tab.accountId === 'account-a'), false);
    assert.equal(fixture.controller.snapshot().tabs.some(tab => tab.accountId === 'account-b'), true);
    assert.equal(fixture.profiles.hasOwnerRef(keptOwner), true);
    await fixture.controller.dispatch({ command: 'hide' });
    await cancelled;
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('purge fences only the trusted integration owner collector and preserves a different purchase account', async () => {
  const fixture = createFixture({ blockPagination: true, preparedRemoval: operationId => ({
    operationId, binding: { accountId: 'integration-ozon-a', accountIncarnation: '2026-07-21T00:00:00.000Z', ownerType: 'integration_profile' }, resourceIds: INTEGRATION_BROWSER_PURGE_RESOURCE_IDS,
  }) });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const collector = await fixture.controller.dispatch({ command: 'open', accountId: 'integration-ozon-a', ownerType: 'integration_profile', browserRole: 'market-collector', background: true, restoreVisible: false, url: 'https://seller.ozon.ru/app/dashboard/main' });
    const collectorTab = collector.tabs.find(tab => tab.background);
    await fixture.controller.dispatch({ command: 'open', accountId: 'account-b', url: FIXTURE_URL });
    const pagination = fixture.controller.dispatch({ command: 'ozon-data-paginate', tabId: collectorTab.tabId, sourceSequence: 1, maxPages: 250, delayMs: 3000 });
    const cancelled = assert.rejects(pagination, { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
    await fixture.paginationStarted;
    assert.equal((await fixture.controller.dispatch({ command: 'purge-operation', operationId: 'removal-integration' })).verified, true);
    await cancelled;
    assert.deepEqual(fixture.controller.snapshot().tabs.map(tab => tab.accountId), ['account-b']);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a purge observation timeout is pending and duplicate requests join the same cleanup and receipt', async (context) => {
  let release;
  let began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const fixture = createFixture({ alipayPaymentWindowController: { async purgeOwner() { began(); await gate; return { ok: true, verified: true }; } } });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const first = fixture.controller.dispatch({ command: 'purge-operation', operationId: 'slow-removal-a' });
    const duplicate = fixture.controller.dispatch({ command: 'purge-operation', operationId: 'slow-removal-a' });
    await started;
    await assert.rejects(fixture.controller.dispatch({ command: 'inspect', tabId: opened.tabs[0].tabId }), { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS' });
    context.mock.timers.tick(20_001);
    for (const result of await Promise.all([first, duplicate])) {
      assert.equal(result.inProgress, true);
      assert.equal(result.verified, false);
      assert.equal(result.code, 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS');
      assert.equal(result.operationId, 'slow-removal-a');
    }
    assert.equal(fixture.calls.filter(call => call.type === 'purge-prepare').length, 1);
    const rejoined = fixture.controller.dispatch({ command: 'purge-operation', operationId: 'slow-removal-a' });
    release();
    const completed = await rejoined;
    assert.equal(completed.verified, true);
    assert.equal(completed.phase, 'completed');
    assert.equal((await fixture.controller.dispatch({ command: 'purge-operation', operationId: 'slow-removal-a' })).verified, true);
    assert.equal(fixture.calls.filter(call => call.type === 'purge-prepare').length, 1);
    assert.equal(fixture.calls.filter(call => call.type === 'purge-receipt').length, 1);
  } finally {
    release();
    context.mock.timers.reset();
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('invalid backend operations and owner resource mismatches cannot remove any profile', async () => {
  for (const preparedRemoval of [
    async () => { throw Object.assign(new Error('fixture invalid operation'), { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_OPERATION_INVALID' }); },
    () => ({ operationId: 'different-operation', binding: {}, resourceIds: PURCHASE_BROWSER_PURGE_RESOURCE_IDS }),
    operationId => ({ operationId, binding: { accountId: 'account-a', accountIncarnation: '2026-07-17T00:00:00.000Z', ownerType: 'integration_profile' }, resourceIds: PURCHASE_BROWSER_PURGE_RESOURCE_IDS }),
    operationId => ({ operationId, binding: { accountId: 'account-a', accountIncarnation: '2026-07-17T00:00:00.000Z', ownerType: 'purchase_account' }, resourceIds: PURCHASE_BROWSER_PURGE_RESOURCE_IDS, receiptBinding: null }),
  ]) {
    const fixture = createFixture({ preparedRemoval });
    try {
      fixture.controller.attachHost(fixture.hostWindow);
      const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
      const ownerRef = opened.tabs[0].storageRef;
      await assert.rejects(fixture.controller.dispatch({ command: 'purge-operation', operationId: 'invalid-removal' }));
      assert.equal(fixture.profiles.hasOwnerRef(ownerRef), true);
      assert.equal(fixture.controller.snapshot().tabs.length, 1);
      assert.equal(fixture.calls.some(call => call.type === 'purge-receipt'), false);
    } finally {
      fixture.controller.dispose();
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('a profile backup write failure never posts a verified browser removal receipt', async () => {
  const fixture = createFixture();
  const originalRename = fs.renameSync;
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    fs.renameSync = (source, destination) => {
      if (destination === `${fixture.profiles.filePath}.bak`) throw Object.assign(new Error('fixture backup busy'), { code: 'EBUSY' });
      return originalRename(source, destination);
    };
    await assert.rejects(fixture.controller.dispatch({ command: 'purge-operation', operationId: 'removal-backup-failure' }), { code: 'EBUSY' });
    assert.equal(fixture.calls.some(call => call.type === 'purge-receipt'), false);
    fs.renameSync = originalRename;
    assert.equal((await fixture.controller.dispatch({ command: 'purge-operation', operationId: 'removal-backup-failure' })).verified, true);
    assert.equal(fixture.calls.filter(call => call.type === 'purge-receipt').length, 1);
  } finally {
    fs.renameSync = originalRename;
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('slow owner filesystem cleanup yields to the observation window and is read back before receipt', async (context) => {
  const fixture = createFixture();
  const originalRemove = fs.promises.rm;
  let release;
  let began;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const ownerRef = opened.tabs[0].storageRef;
    const directory = path.join(fixture.directory, 'purchase-browser', 'downloads', ownerRef);
    fs.promises.rm = async (candidate, options) => {
      if (candidate === directory) { began(); await blocked; }
      return originalRemove(candidate, options);
    };
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const first = fixture.controller.dispatch({ command: 'purge-operation', operationId: 'slow-filesystem-removal' });
    await started;
    context.mock.timers.tick(20_001);
    const pending = await first;
    assert.equal(pending.inProgress, true);
    assert.equal(pending.phase, 'deleting');
    assert.equal(fixture.calls.some(call => call.type === 'purge-receipt'), false);
    const rejoined = fixture.controller.dispatch({ command: 'purge-operation', operationId: 'slow-filesystem-removal' });
    release();
    assert.equal((await rejoined).verified, true);
    assert.equal(fixture.calls.filter(call => call.type === 'purge-receipt').length, 1);
  } finally {
    release();
    fs.promises.rm = originalRemove;
    context.mock.timers.reset();
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function writeLegacyRemovalMarker(fixture, { operationId, ownerRef, receiptBinding } = {}) {
  const root = path.join(fixture.directory, 'purchase-browser', 'pending-account-removals');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${createHash('sha256').update(operationId).digest('hex').slice(0, 40)}.json`);
  const storagePath = path.join(fixture.directory, 'purchase-browser', 'cef-profiles', ownerRef);
  fs.writeFileSync(file, JSON.stringify({ version: 2, operationId, ownerRef, storagePath, resourceIds: PURCHASE_BROWSER_PURGE_RESOURCE_IDS, ...(receiptBinding ? { receiptBinding } : {}) }));
  return { file, storagePath };
}

test('legacy pending purge obtains a fresh receipt binding before deleting and sanitizes profile backups', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const ownerRef = opened.tabs[0].storageRef;
    const marker = writeLegacyRemovalMarker(fixture, { operationId: 'legacy-pending-op', ownerRef });
    const recovered = await fixture.controller.recoverPendingPurges();
    assert.equal(recovered.recovered.length, 1);
    const receipt = fixture.calls.find(call => call.type === 'purge-receipt');
    assert.equal(receipt.proof.receiptBinding.operationId, 'legacy-pending-op');
    assert.equal(receipt.proof.receiptBinding.version, 'purchase-browser-removal-receipt-v2');
    assert.equal(receipt.proof.receiptBinding.nonce, 'fixture-receipt-legacy-pending-op');
    assert.equal(fs.existsSync(marker.file), false);
    assert.equal(fs.existsSync(marker.storagePath), false);
    assert.equal(fixture.profiles.hasOwnerRef(ownerRef), false);
    const calls = fixture.calls.filter(call => call.type.startsWith('purge-')).map(call => call.type);
    assert.deepEqual(calls, ['purge-operation-readback', 'purge-prepare', 'purge-receipt']);
  } finally { fixture.controller.dispose(); fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('an old pending marker cannot select another owner using a valid operation', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-b', url: FIXTURE_URL });
    const ownerRef = opened.tabs[0].storageRef;
    const marker = writeLegacyRemovalMarker(fixture, { operationId: 'belongs-to-account-a', ownerRef });
    await assert.rejects(fixture.controller.recoverPendingPurges(), { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_SCOPE_CHANGED' });
    assert.equal(fs.existsSync(marker.file), true);
    assert.equal(fs.existsSync(marker.storagePath), true);
    assert.equal(fixture.profiles.hasOwnerRef(ownerRef), true);
    assert.equal(fixture.calls.some(call => call.type === 'purge-receipt'), false);
  } finally { fixture.controller.dispose(); fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('completed and invalid pending operations never delete the path named in their marker', async () => {
  for (const completed of [true, false]) {
    const fixture = createFixture({ removalOperationReadback: operationId => {
      if (!completed) throw Object.assign(new Error('fixture missing operation'), { code: 'ACCOUNT_REMOVAL_OPERATION_NOT_FOUND' });
      return { operationId, completed: true };
    } });
    try {
      fixture.controller.attachHost(fixture.hostWindow);
      const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-b', url: FIXTURE_URL });
      const ownerRef = opened.tabs[0].storageRef;
      const marker = writeLegacyRemovalMarker(fixture, { operationId: 'old-pending-operation', ownerRef });
      if (completed) {
        const result = await fixture.controller.recoverPendingPurges();
        assert.equal(result.recovered[0].completed, true);
        assert.equal(result.recovered[0].skippedCleanup, true);
        assert.equal(fs.existsSync(marker.file), false);
      } else await assert.rejects(fixture.controller.recoverPendingPurges(), { code: 'ACCOUNT_REMOVAL_OPERATION_NOT_FOUND' });
      assert.equal(fs.existsSync(marker.storagePath), true);
      assert.equal(fixture.profiles.hasOwnerRef(ownerRef), true);
      assert.equal(fixture.calls.some(call => ['purge-prepare', 'purge-receipt'].includes(call.type)), false);
    } finally { fixture.controller.dispose(); fs.rmSync(fixture.directory, { recursive: true, force: true }); }
  }
});

test('controller fences stale session metadata, ignores old bounds versions, and makes close idempotent', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const first = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const oldTab = first.tabs.find((tab) => tab.accountId === 'account-a');
    assert.ok(oldTab?.sessionId);
    await fixture.controller.dispatch({ command: 'force-close', tabId: oldTab.tabId });
    const second = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const newTab = second.tabs.find((tab) => tab.accountId === 'account-a');
    assert.ok(newTab?.generation > oldTab.generation);
    await assert.rejects(
      fixture.controller.dispatch({
        command: 'inspect',
        tabId: newTab.tabId,
        sessionId: oldTab.sessionId,
        generation: oldTab.generation,
      }),
      (error) => error.code === 'PURCHASE_BROWSER_SESSION_STALE',
    );
    await fixture.controller.dispatch({
      command: 'bounds',
      bounds: { x: 500, y: 500, width: 900, height: 600, visible: true, boundsVersion: 20 },
    });
    const stale = await fixture.controller.dispatch({
      command: 'bounds',
      bounds: { x: 1, y: 1, width: 900, height: 600, visible: true, boundsVersion: 19 },
    });
    assert.equal(stale.boundsVersion, 20);
    const hidden = await fixture.controller.dispatch({ command: 'hide' });
    assert.equal(hidden.tabs.length, 1, 'ordinary hide keeps the live tab and profile session');
    assert.equal(hidden.visible, false);
    assert.equal(hidden.tabs[0].tabId, newTab.tabId);
    await fixture.controller.dispatch({ command: 'close', tabId: newTab.tabId });
    await fixture.controller.dispatch({ command: 'close', tabId: newTab.tabId });
    assert.equal(fixture.controller.snapshot().tabs.length, 0);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a cancelled reused open cannot restore a window after hide completes', async () => {
  const fixture = createFixture();
  let releaseParent;
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open', accountId: 'account-a', url: FIXTURE_URL,
      bounds: { x: 20, y: 30, width: 900, height: 640, visible: true },
    });
    const tab = opened.tabs.find(entry => entry.accountId === 'account-a');
    const browser = fixture.runtime.get(tab.storageRef);
    const request = browser.request.bind(browser);
    let parentStarted;
    const parentStartedPromise = new Promise(resolve => { parentStarted = resolve; });
    const parentRelease = new Promise(resolve => { releaseParent = resolve; });
    browser.request = async (command, ...args) => {
      if (command === 'parent') { parentStarted(); await parentRelease; }
      return request(command, ...args);
    };
    const requestStart = browser.requests.length;
    const reopening = fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const cancelled = assert.rejects(reopening, { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
    await parentStartedPromise;
    const hidden = await fixture.controller.dispatch({ command: 'hide' });
    await cancelled;
    assert.equal(hidden.visible, false);
    releaseParent();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.controller.snapshot().visible, false,
      'the old open must not undo the newer completed hide');
    assert.equal(browser.requests.slice(requestStart).includes('workbench'), false,
      'the cancelled open cannot continue with another native mutation');
    assert.equal(browser.visible, false);
  } finally {
    releaseParent?.();
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a cancelled reused open cannot change visibility or workbench after its tab is closed', async () => {
  const fixture = createFixture();
  let releaseParent;
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open', accountId: 'account-a', url: FIXTURE_URL,
      bounds: { x: 20, y: 30, width: 900, height: 640, visible: true },
    });
    const tab = opened.tabs.find(entry => entry.accountId === 'account-a');
    const browser = fixture.runtime.get(tab.storageRef);
    const request = browser.request.bind(browser);
    let parentStarted;
    const parentStartedPromise = new Promise(resolve => { parentStarted = resolve; });
    const parentRelease = new Promise(resolve => { releaseParent = resolve; });
    browser.request = async (command, ...args) => {
      if (command === 'parent') { parentStarted(); await parentRelease; }
      return request(command, ...args);
    };
    const requestStart = browser.requests.length;
    const reopening = fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const cancelled = assert.rejects(reopening, { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
    await parentStartedPromise;
    await fixture.controller.dispatch({ command: 'close', tabId: tab.tabId });
    await cancelled;
    releaseParent();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(browser.requests.slice(requestStart).includes('workbench'), false,
      'a stale open must not mutate the closed native tab');
    assert.equal(fixture.controller.snapshot().tabs.length, 0);
    assert.equal(fixture.controller.snapshot().visible, false);
  } finally {
    releaseParent?.();
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('native window X fences a reused open that is waiting for its parent response', async () => {
  const fixture = createFixture();
  let releaseParent;
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open', accountId: 'account-a', url: FIXTURE_URL,
      bounds: { x: 20, y: 30, width: 900, height: 640, visible: true },
    });
    const tab = opened.tabs.find(entry => entry.accountId === 'account-a');
    const browser = fixture.runtime.get(tab.storageRef);
    const request = browser.request.bind(browser);
    let parentStarted;
    const parentStartedPromise = new Promise(resolve => { parentStarted = resolve; });
    const parentRelease = new Promise(resolve => { releaseParent = resolve; });
    browser.request = async (command, ...args) => {
      if (command === 'parent') { parentStarted(); await parentRelease; }
      return request(command, ...args);
    };
    const requestStart = browser.requests.length;
    const reopening = fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    await parentStartedPromise;
    browser.visible = false;
    browser.emit('window-hidden', { state: { ...browser.state } });
    assert.equal(fixture.controller.snapshot().visible, false);
    releaseParent();
    await assert.rejects(reopening, { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
    assert.equal(fixture.controller.snapshot().visible, false);
    assert.equal(browser.requests.slice(requestStart).includes('workbench'), false);
    assert.equal(browser.visible, false);
  } finally {
    releaseParent?.();
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('closing interactive windows fences an unregistered launch and preserves all background roles', async () => {
  const fixture = createFixture();
  let releaseLaunch;
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    for (const background of [
      { accountId: 'integration-ozon-a', ownerType: 'integration_profile', browserRole: 'market-collector' },
      { accountId: 'integration-follow-front-a', ownerType: 'integration_profile', browserRole: 'follow-seller-collector' },
      { accountId: 'account-b', ownerType: 'purchase_account', browserRole: 'product-link-parser' },
    ]) {
      await fixture.controller.dispatch({ command: 'open', ...background, url: FIXTURE_URL, background: true });
    }
    const backgroundTabs = fixture.controller.snapshot().tabs;
    assert.equal(backgroundTabs.length, 3);
    const originalOpen = fixture.runtime.open.bind(fixture.runtime);
    const originalClose = fixture.runtime.close.bind(fixture.runtime);
    let launchStarted;
    let closedCancelledLaunch;
    let launchingOwnerRef = '';
    let gateLaunch = true;
    const launchStartedPromise = new Promise(resolve => { launchStarted = resolve; });
    const launchRelease = new Promise(resolve => { releaseLaunch = resolve; });
    const cancelledLaunchClosed = new Promise(resolve => { closedCancelledLaunch = resolve; });
    fixture.runtime.open = async input => {
      const browser = await originalOpen(input);
      if (gateLaunch && input.profile.browserRole === 'interactive') {
        gateLaunch = false;
        launchingOwnerRef = input.profile.ownerRef;
        launchStarted();
        await launchRelease;
      }
      return browser;
    };
    fixture.runtime.close = async ownerRef => {
      const result = await originalClose(ownerRef);
      if (ownerRef === launchingOwnerRef) closedCancelledLaunch();
      return result;
    };
    const opening = fixture.controller.dispatch({
      command: 'open', accountId: 'account-a', url: FIXTURE_URL,
      bounds: { x: 20, y: 30, width: 900, height: 640, visible: true },
    });
    opening.catch(() => undefined);
    await launchStartedPromise;
    const closed = await fixture.controller.closeInteractiveTabs();
    assert.equal(closed.visible, false);
    assert.equal(closed.queue.active, null, 'closing must release the cancelled interactive open queue immediately');
    await assert.rejects(opening, { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
    releaseLaunch();
    await cancelledLaunchClosed;
    await new Promise(resolve => setImmediate(resolve));
    const afterLateLaunch = fixture.controller.snapshot();
    assert.equal(afterLateLaunch.visible, false);
    assert.deepEqual(afterLateLaunch.tabs.map(tab => tab.tabId), backgroundTabs.map(tab => tab.tabId));
    for (const backgroundTab of backgroundTabs) {
      assert.ok(fixture.runtime.get(fixture.runtimeOpenCalls.find(call => call.browserRole === backgroundTab.browserRole).ownerRef));
    }
    const reopened = await fixture.controller.dispatch({
      command: 'open', accountId: 'account-a', url: FIXTURE_URL,
      bounds: { x: 20, y: 30, width: 900, height: 640, visible: true },
    });
    assert.equal(reopened.tabs.length, 4);
    assert.equal(reopened.tabs.find(tab => tab.tabId === reopened.activeTabId).accountId, 'account-a');
    assert.equal(reopened.visible, true);
    assert.equal(fixture.runtimeOpenCalls.filter(call => call.browserRole === 'interactive').length, 2);
  } finally {
    releaseLaunch?.();
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('closing the last visible tab reports no active visible browser', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open', accountId: 'account-a', url: FIXTURE_URL,
      bounds: { x: 20, y: 30, width: 900, height: 640, visible: true },
    });
    const closed = await fixture.controller.dispatch({ command: 'close', tabId: opened.activeTabId });
    assert.deepEqual({ activeTabId: closed.activeTabId, visible: closed.visible, tabCount: closed.tabs.length },
      { activeTabId: '', visible: false, tabCount: 0 });
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('native close failure still selects the surviving tab while preserving the close error', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const first = await fixture.controller.dispatch({
      command: 'open', accountId: 'account-a', url: FIXTURE_URL,
      bounds: { x: 20, y: 30, width: 900, height: 640, visible: true },
    });
    const second = await fixture.controller.dispatch({ command: 'open', accountId: 'account-b', url: FIXTURE_URL });
    fixture.runtime.close = async () => { throw Object.assign(new Error('native close failed'), { code: 'FIXTURE_NATIVE_CLOSE_FAILED' }); };
    await assert.rejects(fixture.controller.dispatch({ command: 'close', tabId: second.activeTabId }),
      { code: 'FIXTURE_NATIVE_CLOSE_FAILED' });
    const state = fixture.controller.snapshot();
    assert.equal(state.activeTabId, first.activeTabId,
      'a failed graceful close cannot leave activeTabId pointing at a removed tab');
    assert.equal(state.tabs.length, 1);
    assert.equal(state.visible, true);
    assert.equal(fixture.runtime.get(state.tabs[0].storageRef).visible, true);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('embedded close suspends the target, preempts collector work, and keeps the CEF session hot', async () => {
  const fixture = createFixture({ blockPagination: true });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const collector = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'integration-ozon-a',
      ownerType: 'integration_profile',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    });
    const collectorTab = collector.tabs.find((tab) => tab.background === true);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: FIXTURE_URL,
      bounds: { x: 463, y: 135, width: 921, height: 701, visible: true, boundsVersion: 30 },
      workbench: { kind: 'purchase-order', displayMode: 'embedded' },
    });
    const openedTab = opened.tabs.find((tab) => tab.tabId === opened.activeTabId);
    await fixture.controller.dispatch({
      command: 'set-target',
      tabId: openedTab.tabId,
      target: {
        targetId: 'embedded-close-target',
        shopId: 'shop-a',
        orderKey: 'shop-a:order-a',
        sku: 'sku-a',
        quantity: 1,
        requiredFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny'],
      },
    });
    const pagination = fixture.controller.dispatch({
      command: 'ozon-data-paginate',
      tabId: collectorTab.tabId,
      sourceSequence: 1,
      maxPages: 250,
      delayMs: 3_000,
    });
    const paginationCancelled = assert.rejects(
      pagination,
      (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED',
    );
    await fixture.paginationStarted;
    const hidden = await fixture.controller.dispatch({
      command: 'suspend-workbench',
      bounds: { x: 0, y: 0, width: 1280, height: 800, visible: false, boundsVersion: 31 },
    });
    await paginationCancelled;
    const hiddenTab = hidden.tabs.find((tab) => tab.tabId === openedTab.tabId);
    assert.equal(hidden.visible, false);
    assert.equal(hidden.tabs.some((tab) => tab.tabId === collectorTab.tabId), true);
    assert.equal(hidden.tabs.some((tab) => tab.tabId === openedTab.tabId), true);
    assert.equal(hiddenTab.target, null);
    assert.equal(hiddenTab.targetPhase, 'idle');
    assert.equal(hiddenTab.embedding.bounds.x, -32000);
    assert.equal(hiddenTab.embedding.bounds.y, -32000);
    const collectorBrowser = fixture.runtime.get(fixture.runtimeOpenCalls[0].ownerRef);
    assert.ok(collectorBrowser.requests.includes('ozon-data-cancel-pagination'));
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('interactive observer status waits without cancelling pagination while a real probe still preempts it', async () => {
  const fixture = createFixture({ blockPagination: true });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'integration-ozon-a',
      ownerType: 'integration_profile',
      browserRole: 'market-collector',
      background: true,
      restoreVisible: false,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    });
    const collectorTab = opened.tabs.find((tab) => tab.background === true);
    const pagination = fixture.controller.dispatch({
      command: 'ozon-data-paginate',
      tabId: collectorTab.tabId,
      sourceSequence: 1,
      maxPages: 250,
      delayMs: 3_000,
    });
    await fixture.paginationStarted;
    const status = fixture.controller.dispatch({
      command: 'ozon-data-status',
      tabId: collectorTab.tabId,
      collectorPriority: 'interactive',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fixture.controller.snapshot().queue.active?.name, 'ozon-data-paginate');
    assert.equal(fixture.controller.snapshot().queue.pending.some((item) => item.name === 'ozon-data-status'), true);
    assert.doesNotMatch(fixture.logs.join(''), /interactive command=ozon-data-status preempt=ozon-data-paginate/u);

    const probe = fixture.controller.dispatch({
      command: 'ozon-data-probe',
      tabId: collectorTab.tabId,
      collectorPriority: 'interactive',
      path: '/api/site/exa-products-api/missing_items',
      method: 'POST',
      body: { filter: { product_name: 'платье' }, limit: '50', offset: '0' },
      origin: 'https://api.seller.ozon.ru',
    });

    await assert.rejects(pagination, (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED');
    const probeResult = await probe;
    const result = await status;
    assert.equal(probeResult.result.quality, 'confirmed-data');
    assert.equal(result.result.ready, true);
    const collectorBrowser = fixture.runtime.get(fixture.runtimeOpenCalls[0].ownerRef);
    const paginationIndex = collectorBrowser.requests.lastIndexOf('ozon-data-paginate');
    const cancelIndex = collectorBrowser.requests.lastIndexOf('ozon-data-cancel-pagination');
    const probeIndex = collectorBrowser.requests.lastIndexOf('ozon-data-probe');
    const statusIndex = collectorBrowser.requests.lastIndexOf('ozon-data-status');
    assert.ok(paginationIndex >= 0);
    assert.ok(cancelIndex > paginationIndex);
    assert.ok(probeIndex > cancelIndex);
    assert.ok(statusIndex > probeIndex);
    assert.match(fixture.logs.join(''), /interactive command=ozon-data-probe preempt=ozon-data-paginate/u);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('forceCloseAll immediately fences a navigation that is stuck in the Sidecar', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const tab = opened.tabs.find((entry) => entry.accountId === 'account-a');
    assert.ok(tab?.tabId);
    const ownerRef = fixture.profiles.getOrCreate(
      { accountId: 'account-a', accountIncarnation: '2026-07-17T00:00:00.000Z', platformName: '1688' },
      { lastUrl: FIXTURE_URL },
    ).ownerRef;
    const liveBrowser = fixture.runtime.get(ownerRef);
    assert.ok(liveBrowser);
    const originalRequest = liveBrowser.request;
    let releaseNavigation;
    let navigationStarted;
    const navigationStartedPromise = new Promise((resolve) => { navigationStarted = resolve; });
    liveBrowser.request = async (command, payload = {}) => {
      if (command === 'navigate') {
        navigationStarted();
        await new Promise((resolve) => { releaseNavigation = resolve; });
      }
      return originalRequest(command, payload);
    };
    const navigation = fixture.controller.dispatch({
      command: 'navigate',
      tabId: tab.tabId,
      url: FIXTURE_URL,
    });
    await navigationStartedPromise;
    const startedAt = Date.now();
    const closed = await fixture.controller.forceCloseAll();
    assert.ok(Date.now() - startedAt < 500, 'forced close must not wait for the stuck navigation');
    assert.equal(closed.tabs.length, 0);
    assert.equal(closed.visible, false);
    assert.equal(fixture.runtime.get(ownerRef), null);
    await assert.rejects(navigation, (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED');
    releaseNavigation?.();
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('forceCloseAll does not inherit a bounds request stuck behind the Sidecar', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const tab = opened.tabs.find((entry) => entry.accountId === 'account-a');
    const ownerRef = fixture.profiles.getOrCreate(
      { accountId: 'account-a', accountIncarnation: '2026-07-17T00:00:00.000Z', platformName: '1688' },
      { lastUrl: FIXTURE_URL },
    ).ownerRef;
    const liveBrowser = fixture.runtime.get(ownerRef);
    assert.ok(tab?.tabId && liveBrowser);
    const originalRequest = liveBrowser.request;
    let releaseBounds;
    let boundsStarted;
    const boundsStartedPromise = new Promise((resolve) => { boundsStarted = resolve; });
    liveBrowser.request = async (command, payload = {}) => {
      if (command === 'bounds' && payload.bounds?.visible === true) {
        boundsStarted();
        await new Promise((resolve) => { releaseBounds = resolve; });
      }
      return originalRequest(command, payload);
    };
    const bounds = fixture.controller.dispatch({
      command: 'bounds',
      bounds: { x: 20, y: 20, width: 900, height: 600, visible: true },
    });
    await boundsStartedPromise;
    const startedAt = Date.now();
    const closed = await fixture.controller.forceCloseAll();
    assert.ok(Date.now() - startedAt < 500, 'forced close must not wait for a stuck bounds request');
    assert.equal(closed.tabs.length, 0);
    assert.equal(closed.visible, false);
    releaseBounds?.();
    await assert.rejects(bounds, (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('target mode exposes every capture phase and restores only the saved target on a new generation', async () => {
  const fixture = createFixture();
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    await fixture.controller.dispatch({
      command: 'bounds',
      bounds: { x: 10, y: 20, width: 900, height: 600, visible: true },
    });
    const opened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const tabId = opened.activeTabId;
    const target = {
      targetId: 'target-phase-a',
      shopId: 'shop-a',
      orderKey: 'order-phase-a',
      sku: 'sku-a',
      requiredFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'sourceUrl'],
    };

    const locked = await fixture.controller.dispatch({ command: 'set-target', tabId, target });
    assert.equal(locked.targetPhase, 'target-locked');
    assert.equal(locked.state.tabs.find((tab) => tab.tabId === tabId)?.targetPhase, 'target-locked');

    const preview = await fixture.controller.dispatch({ command: 'capture-preview', tabId });
    assert.equal(preview.targetPhase, 'capture-preview');
    assert.equal(preview.state.tabs.find((tab) => tab.tabId === tabId)?.targetPhase, 'capture-preview');

    const completed = await fixture.controller.dispatch({
      command: 'capture-confirm',
      tabId,
      confirmationToken: preview.preview.confirmationToken,
    });
    assert.equal(completed.targetPhase, 'completed');
    assert.equal(completed.state.tabs.find((tab) => tab.tabId === tabId)?.targetPhase, 'completed');

    await fixture.controller.dispatch({ command: 'force-close', tabId });
    const reopened = await fixture.controller.dispatch({ command: 'open', accountId: 'account-a', url: FIXTURE_URL });
    const replacement = reopened.tabs.find((tab) => tab.accountId === 'account-a');
    const recovered = await fixture.controller.dispatch({
      command: 'target-recovery',
      tabId: replacement.tabId,
      target,
      sessionId: replacement.sessionId,
      generation: replacement.generation,
    });
    assert.equal(recovered.targetPhase, 'target-locked');
    assert.equal(recovered.target.orderKey, target.orderKey);
    await assert.rejects(
      fixture.controller.dispatch({
        command: 'target-recovery',
        tabId: replacement.tabId,
        target,
        targetHash: '0'.repeat(64),
      }),
      (error) => error.code === 'PURCHASE_BROWSER_TARGET_AMBIGUOUS',
    );
    await assert.rejects(
      fixture.controller.dispatch({
        command: 'target-recovery',
        tabId: replacement.tabId,
        target: { ...target, orderKey: 'different-order' },
      }),
      (error) => error.code === 'PURCHASE_BROWSER_TARGET_AMBIGUOUS',
    );
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('capture waits through one transient CEF main-frame context handoff', async () => {
  const fixture = createFixture({ inspectContextFailures: 1 });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const opened = await fixture.controller.dispatch({
      command: 'open',
      accountId: 'account-a',
      url: FIXTURE_URL,
    });
    const result = await fixture.controller.dispatch({
      command: 'capture-purchase',
      tabId: opened.activeTabId,
    });
    const profile = fixture.profiles.get({
      accountId: 'account-a',
      accountIncarnation: '2026-07-17T00:00:00.000Z',
    });
    const browser = fixture.runtime.get(profile.ownerRef);

    assert.equal(result.ok, true);
    assert.equal(result.capture.fixture, true);
    assert.equal(browser.requests.filter((command) => command === 'inspect').length, 2);
    assert.ok(fixture.logs.some((entry) => String(entry).includes('capture context retry')));
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('purchase rehearsal completes ten CEF reads and never invokes an order or payment mutation', async () => {
  const productUrl = 'https://detail.1688.com/offer/7733559911.html';
  const storedSku = 'stored-private-sku-42';
  const liveSku = 'live-private-sku-88';
  const fixture = createFixture({
    genericInspection: {
      platform: '1688',
      pageType: 'product',
      pageUrl: productUrl,
      sourceUrl: productUrl,
      sourceProductId: '7733559911',
      productTitle: '结构化测试采购商品',
      purchasePrice: 18.8,
      mainImages: ['https://cbu01.alicdn.com/img/ibank/test.jpg'],
      skus: [{
        id: liveSku,
        name: '蓝色 / 大号',
        attributes: [{ name: '颜色', value: '蓝色' }, { name: '尺寸', value: '大号' }],
        price: 18.8,
      }],
      sourceMethod: '1688-structured-state',
      sourceConfidence: 1,
    },
    rehearsalAccounts: [{
      id: 'account-a',
      platformName: '1688',
      browserLoginStatus: '已登录',
      cookieStatus: 'Cookie 已保存',
    }],
    rehearsalPurchaseSourceLinks: [{
      platform: '1688',
      url: productUrl,
      sourceProductId: '7733559911',
      sku: storedSku,
    }],
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const result = await fixture.controller.dispatch({
      command: 'purchase-rehearsal-batch',
      platform: '1688',
      runs: 10,
    });
    assert.equal(result.passed, true);
    assert.equal(result.passedRuns, 10);
    assert.equal(result.failedRuns, 0);
    assert.equal(result.stopStage, 'PAYMENT_PASSWORD_REQUIRED');
    assert.equal(result.results.every((row) => row.safety.createdPendingOrder === false), true);
    assert.equal(result.results.every((row) => row.safety.enteredPaymentPassword === false), true);
    assert.equal(fs.existsSync(result.reportPath), true);
    const reportText = fs.readFileSync(result.reportPath, 'utf8');
    assert.doesNotMatch(reportText, new RegExp(storedSku, 'u'));
    assert.doesNotMatch(reportText, new RegExp(liveSku, 'u'));
    assert.doesNotMatch(reportText, /detail\.1688\.com/u);
    const browser = fixture.runtime.get(fixture.runtimeOpenCalls[0].ownerRef);
    assert.equal(browser.requests.filter((command) => command === 'inspect').length, 10);
    assert.equal(browser.requests.includes('execute'), false);
    assert.equal(browser.requests.includes('capture-confirm'), false);
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('purchase rehearsal stops after one real manual-verification page instead of hammering the platform', async () => {
  const productUrl = 'https://detail.1688.com/offer/7733559911.html';
  const fixture = createFixture({
    runtimePageTitle: '验证码拦截',
    genericInspection: {
      platform: '1688',
      pageType: 'unknown',
      pageUrl: productUrl,
    },
    rehearsalAccounts: [{
      id: 'account-a',
      platformName: '1688',
      browserLoginStatus: '已登录',
      cookieStatus: 'Cookie 已保存',
    }],
    rehearsalPurchaseSourceLinks: [{
      platform: '1688',
      url: productUrl,
      sourceProductId: '7733559911',
    }],
  });
  try {
    fixture.controller.attachHost(fixture.hostWindow);
    const result = await fixture.controller.dispatch({
      command: 'purchase-rehearsal-batch',
      platform: '1688',
      runs: 10,
    });
    assert.equal(result.passed, false);
    assert.equal(result.passedRuns, 0);
    assert.equal(result.failedRuns, 1);
    assert.equal(result.attemptedRuns, 1);
    assert.equal(result.failures[0].code, 'PURCHASE_REHEARSAL_MANUAL_VERIFICATION_REQUIRED');
  } finally {
    fixture.controller.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});



