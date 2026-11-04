import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestLocalApi: vi.fn(),
  saveIntegrationProfile: vi.fn(),
  listIntegrationProfiles: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  requestLocalApi: mocks.requestLocalApi,
  saveIntegrationProfile: mocks.saveIntegrationProfile,
  listIntegrationProfiles: mocks.listIntegrationProfiles,
}));

import {
  captureFollowSellersForTargets,
  collectFollowSellerScheme2EvidenceInBrowser,
  createFollowSellerLoginProfile,
  getFollowSellerOverview,
  openFollowSellerLoginBrowser,
	showActiveFollowSellerQuickBrowser,
  toggleActiveFollowSellerVerificationBrowser,
  submitFollowSellerComplaintInBrowser,
  submitFollowSellerQuickBatchInBrowser,
} from './followSellerDefenseService.js';

function createBrowserCommand({ captureError = null, complaintError = null } = {}) {
  let dedicatedOpen = false;
  const baseTabs = [
    {
      tabId: 'market-1',
      accountId: 'profile-1',
      browserRole: 'market-collector',
      background: true,
      url: 'https://seller.ozon.ru/app/analytics',
    },
    {
      tabId: 'interactive-1',
      accountId: 'profile-1',
      browserRole: 'interactive',
      background: false,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    },
  ];
  const state = () => ({
    tabs: dedicatedOpen
      ? [...baseTabs, {
          tabId: 'follow-1',
          accountId: 'profile-1',
          browserRole: 'follow-seller-collector',
          background: true,
          url: 'https://www.ozon.ru/',
        }]
      : [...baseTabs],
  });
  return vi.fn(async (input) => {
    if (input.command === 'state') return { state: state() };
    if (input.command === 'open') {
      expect(input).toMatchObject({
        ownerType: 'integration_profile',
        accountId: 'profile-1',
        browserRole: 'follow-seller-collector',
        background: true,
        restoreVisible: false,
        platformName: 'Ozon买家',
        url: 'https://www.ozon.ru/',
      });
      dedicatedOpen = true;
      return { state: state() };
    }
    if (input.command === 'ozon-data-status') {
      throw new Error('follow-seller public capture must not depend on the Seller observer');
    }
    if (input.command === 'ozon-data-follow-sellers') {
      expect(input.tabId).toBe('follow-1');
      if (captureError) throw captureError;
      return {
        result: {
          failed: 0,
          results: input.skus.map((sku) => ({
            sku,
            followSellerConfirmed: true,
            followSellerCount: sku.endsWith('0') ? 1 : 0,
          })),
        },
      };
    }
    if (input.command === 'ozon-submit-follow-seller-complaint') {
      expect(input).toMatchObject({
        tabId: 'follow-1',
        evidenceId: 'evidence-1',
        speech: { ru: 'Фактическое обращение' },
        listingDate: '2026-08-01',
        attachments: [
          expect.objectContaining({ kind: 'psd', sha256: 'a'.repeat(64) }),
          expect.objectContaining({ kind: 'pdf', sha256: 'b'.repeat(64) }),
        ],
        supplementAttachments: [
          expect.objectContaining({ kind: 'supplement_image', sha256: 'c'.repeat(64) }),
        ],
      });
      if (complaintError) throw complaintError;
      return { result: { ok: true, ticketId: 'ticket-10001', messageId: 'ticket-10001' } };
    }
    if (input.command === 'force-close') {
      expect(input.tabId).toBe('follow-1');
      dedicatedOpen = false;
      return { state: state() };
    }
    throw new Error(`unexpected command ${input.command}`);
  });
}

describe('followSellerDefenseService browser capture', () => {
  afterEach(() => {
    vi.clearAllMocks();
    if (globalThis.window?.wangzaiDesktop) delete globalThis.window.wangzaiDesktop;
  });

  it('reads every overview page and does not truncate a shop after one thousand records', async () => {
    const allCases = Array.from({ length: 1205 }, (_, index) => ({
      id: `case-${index + 1}`,
      sku: String(9000000000 + index),
      status: index < 205 ? 'detected' : 'clear',
    }));
    mocks.requestLocalApi.mockImplementation(async (url) => {
      const requestUrl = new URL(url, 'http://localhost');
      const offset = Number(requestUrl.searchParams.get('offset')) || 0;
      const limit = Number(requestUrl.searchParams.get('limit')) || 500;
      return {
        ok: true,
        cases: allCases.slice(offset, offset + limit),
        patrols: [{ id: 'patrol-all' }],
        counts: { total: 1205, detected: 205, clear: 1000 },
        pagination: { offset, limit, total: 1205 },
      };
    });

    const result = await getFollowSellerOverview({ shopId: 'shop-1' });

    expect(result.cases).toHaveLength(1205);
    expect(result.counts).toEqual({ total: 1205, detected: 205, clear: 1000 });
    expect(mocks.requestLocalApi).toHaveBeenCalledTimes(3);
    expect(mocks.requestLocalApi.mock.calls.map(([url]) => (
      new URL(url, 'http://localhost').searchParams.get('offset')
    ))).toEqual(['0', '500', '1000']);
  });

  it('never falls back to a shop Seller browser login', async () => {
    const command = createBrowserCommand();
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    await expect(captureFollowSellersForTargets({
      targets: [{ sku: '9000000001' }],
      shopId: 'shop-2',
    })).rejects.toMatchObject({ code: 'OZON_BROWSER_PROFILE_REQUIRED' });

    expect(command).not.toHaveBeenCalled();
  });

  it('creates a patrol-only profile, persists selection and opens its independent login', async () => {
    mocks.saveIntegrationProfile.mockResolvedValue({
      profile: {
        id: 'follow-login-1',
        integrationType: 'ozon-follow-seller-session',
        platformName: 'Ozon 前台巡查 1',
      },
    });
    mocks.requestLocalApi.mockResolvedValue({ ok: true, selectedProfileId: 'follow-login-1' });
    const profile = await createFollowSellerLoginProfile({ sequence: 1 });
    expect(profile.id).toBe('follow-login-1');
    expect(mocks.saveIntegrationProfile).toHaveBeenCalledWith(expect.objectContaining({
      integrationType: 'ozon-follow-seller-session',
      platformName: 'Ozon 前台巡查 1',
      tokenStatus: 'Cookie 未保存',
    }), expect.any(Object));
    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/follow-seller-defense/logins/select',
      expect.objectContaining({ body: { profileId: 'follow-login-1' } }),
    );

    const command = vi.fn(async (input) => {
      expect(input).toMatchObject({
        command: 'open',
        ownerType: 'integration_profile',
        accountId: 'follow-login-1',
        browserRole: 'interactive',
        background: false,
        platformName: 'Ozon买家',
        url: 'https://www.ozon.ru/',
      });
      return {
        state: {
          tabs: [{ tabId: 'login-tab-1', accountId: 'follow-login-1', browserRole: 'interactive' }],
        },
      };
    });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    const opened = await openFollowSellerLoginBrowser({
      profileId: profile.id,
      profileName: profile.platformName,
    });
    expect(opened.tab.tabId).toBe('login-tab-1');
  });

  it('uses an on-demand dedicated public browser without waiting for the Seller observer', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      profiles: [{ id: 'profile-1', connected: true }],
      selectedProfileId: 'profile-1',
    });
    const command = createBrowserCommand();
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    const targets = Array.from({ length: 1260 }, (_, index) => ({ sku: String(9000000000 + index) }));
    const progress = vi.fn();
    const batches = vi.fn(async () => undefined);

    const result = await captureFollowSellersForTargets({
      targets,
      profileId: 'profile-1',
      interBatchDelayMs: 0,
      periodicCooldownMs: 0,
      onProgress: progress,
      onBatch: batches,
    });

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1260);
    const captureCalls = command.mock.calls.filter(([input]) => input.command === 'ozon-data-follow-sellers');
    expect(command.mock.calls.some(([input]) => input.command === 'ozon-data-status')).toBe(false);
    expect(captureCalls).toHaveLength(14);
    expect(captureCalls[0][0].skus).toHaveLength(1);
    expect(captureCalls[0][0]).toMatchObject({ concurrency: 1, includeProductFacts: false });
    expect(captureCalls[1][0].skus).toHaveLength(100);
    expect(captureCalls[1][0]).toMatchObject({ concurrency: 6, includeProductFacts: false });
    expect(captureCalls.every(([input]) => /^follow-seller-[a-z0-9]+-[a-z0-9]+$/u.test(input.captureToken))).toBe(true);
    expect(captureCalls[13][0].skus).toHaveLength(59);
    expect(batches).toHaveBeenCalledTimes(14);
    expect(batches).toHaveBeenLastCalledWith(expect.objectContaining({ done: 1260, total: 1260, failed: 0 }));
    expect(progress).toHaveBeenLastCalledWith({ done: 1260, total: 1260, failed: 0 });
    expect(command.mock.calls.filter(([input]) => input.command === 'open')).toHaveLength(1);
    expect(command.mock.calls.filter(([input]) => input.command === 'force-close')).toHaveLength(1);
    expect(command.mock.calls.some(([input]) => (
      ['market-1', 'interactive-1'].includes(input.tabId)
      && input.command !== 'state'
    ))).toBe(false);
    const finalState = await command({ command: 'state' });
    expect(finalState.state.tabs.map((tab) => tab.tabId)).toEqual(['market-1', 'interactive-1']);
  });

  it('streams each native result to the page before the transport batch is persisted', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      profiles: [{ id: 'profile-1', connected: true }],
      selectedProfileId: 'profile-1',
    });
    const baseCommand = createBrowserCommand();
    const listeners = new Set();
    const command = vi.fn(async (input) => {
      if (input.command === 'ozon-data-follow-sellers') {
        for (const sku of input.skus) {
          for (const listener of listeners) {
            listener({
              event: 'follow-seller-result',
              tabId: 'follow-1',
              captureToken: input.captureToken,
              result: { sku, followSellerConfirmed: true, followSellerCount: sku.endsWith('1') ? 3 : 0 },
            });
          }
        }
      }
      return baseCommand(input);
    });
    const onEvent = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command, onEvent } };
    const callOrder = [];

    const result = await captureFollowSellersForTargets({
      targets: [{ sku: '9300000001' }, { sku: '9300000002' }],
      profileId: 'profile-1',
      interBatchDelayMs: 0,
      periodicCooldownMs: 0,
      onResult: ({ result: item }) => callOrder.push(`result:${item.sku}`),
      onBatch: async ({ results }) => callOrder.push(`batch:${results.map((item) => item.sku).join(',')}`),
    });

    expect(result.results).toHaveLength(2);
    expect(callOrder).toEqual([
      'result:9300000001',
      'batch:9300000001',
      'result:9300000002',
      'batch:9300000002',
    ]);
    expect(listeners.size).toBe(0);
  });

  it('shows the exact failed patrol page, waits for one user refresh and slider, then resumes the same CEF session', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      profiles: [{ id: 'profile-1', connected: true }],
      selectedProfileId: 'profile-1',
    });
    let networkMode = '';
    let loginOpen = true;
    let challengeVisible = false;
    let verificationPassed = false;
    let captureAttempt = 0;
    const patrolTab = () => ({
      tabId: 'follow-1',
      accountId: 'profile-1',
      browserRole: 'follow-seller-collector',
      background: !challengeVisible,
      followSellerVerificationVisible: challengeVisible,
      followSellerVerificationStatus: {
        pageReady: true,
        challengeDetected: !verificationPassed,
        verificationReady: verificationPassed,
      },
      url: verificationPassed
        ? 'https://www.ozon.ru/product/product-9100000000/'
        : 'https://www.ozon.ru/product/product-9100000000/?__rr=1',
      loading: false,
      loadErrorCode: 0,
      navigationCompletedSequence: verificationPassed ? 2 : 1,
      proxyMode: 'direct',
    });
    const command = vi.fn(async (input) => {
      if (input.command === 'state' || input.command === 'read-follow-seller-verification') {
        if (challengeVisible) verificationPassed = true;
        return {
          state: {
            tabs: [
              ...(loginOpen ? [{
                tabId: 'patrol-login-1',
                accountId: 'profile-1',
                browserRole: 'interactive',
                integrationType: 'ozon-follow-seller-session',
                background: false,
              }] : []),
              ...(networkMode ? [patrolTab()] : []),
            ],
          },
        };
      }
      if (input.command === 'open') {
        networkMode = input.networkMode;
        return {
          state: {
            tabs: [patrolTab()],
          },
        };
      }
      if (input.command === 'force-close') {
        if (input.tabId === 'patrol-login-1') {
          loginOpen = false;
          return { state: { tabs: [] } };
        }
        networkMode = '';
        return { state: { tabs: [] } };
      }
      if (input.command === 'show-follow-seller-verification') {
        expect(input).toMatchObject({
          tabId: 'follow-1',
          url: 'https://www.ozon.ru/product/product-9100000000/',
        });
        challengeVisible = true;
        verificationPassed = false;
        return { state: { tabs: [patrolTab()] } };
      }
      if (input.command === 'hide-follow-seller-verification') {
        challengeVisible = false;
        return { state: { tabs: [patrolTab()] } };
      }
      if (input.command === 'ozon-data-follow-sellers') {
        captureAttempt += 1;
        if (captureAttempt === 1) {
          return {
            result: {
              failed: input.skus.length,
              results: input.skus.map((sku) => ({
                sku,
                status: 403,
                errorCode: 'HTTP_403',
                followSellerConfirmed: false,
              })),
            },
          };
        }
        expect(networkMode).toBe('auto');
        expect(input.concurrency).toBeLessThanOrEqual(4);
        expect(input.skus.length).toBeLessThanOrEqual(20);
        return {
          result: {
            failed: 0,
            results: input.skus.map((sku) => ({
              sku,
              followSellerConfirmed: true,
              followSellerCount: 0,
            })),
          },
        };
      }
      throw new Error(`unexpected command ${input.command}`);
    });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    const batches = vi.fn(async () => undefined);
    const targets = Array.from({ length: 25 }, (_, index) => ({ sku: String(9100000000 + index) }));

    const result = await captureFollowSellersForTargets({
      targets,
      profileId: 'profile-1',
      cooldownDelaysMs: [],
      interBatchDelayMs: 0,
      periodicCooldownMs: 0,
      manualVerificationPollMs: 0,
      manualVerificationTimeoutMs: 1_000,
      onBatch: batches,
    });

    expect(result.results).toHaveLength(25);
    expect(result.failed).toBe(0);
    expect(command.mock.calls.filter(([input]) => input.command === 'open').map(([input]) => input.networkMode))
      .toEqual(['auto']);
    expect(command.mock.calls.filter(([input]) => input.command === 'show-follow-seller-verification')).toHaveLength(1);
    expect(command.mock.calls.filter(([input]) => input.command === 'hide-follow-seller-verification')).toHaveLength(0);
    expect(command.mock.calls.some(([input]) => (
      input.command === 'force-close' && input.tabId === 'patrol-login-1'
    ))).toBe(true);
    expect(batches).toHaveBeenCalledTimes(3);
    expect(batches.mock.calls.flatMap(([batch]) => batch.results).some((item) => item.status === 403)).toBe(false);
  });

  it('opens one manual verification window for a thrown RR challenge even when automatic retries are disabled', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      profiles: [{ id: 'profile-1', connected: true }],
      selectedProfileId: 'profile-1',
    });
    let dedicatedOpen = false;
    let challengeVisible = false;
    let verificationPassed = false;
    let captureAttempt = 0;
    const patrolTab = () => ({
      tabId: 'follow-1',
      accountId: 'profile-1',
      browserRole: 'follow-seller-collector',
      background: !challengeVisible,
      followSellerVerificationVisible: challengeVisible,
      followSellerVerificationStatus: {
        pageReady: true,
        challengeDetected: !verificationPassed,
        verificationReady: verificationPassed,
      },
      url: verificationPassed
        ? 'https://www.ozon.ru/product/product-9300000001/'
        : 'https://www.ozon.ru/product/product-9300000001/?__rr=1',
      loading: false,
      loadErrorCode: 0,
      navigationCompletedSequence: verificationPassed ? 2 : 1,
      proxyMode: 'system',
    });
    const command = vi.fn(async (input) => {
      if (input.command === 'state' || input.command === 'read-follow-seller-verification') {
        if (challengeVisible) verificationPassed = true;
        return { state: { tabs: dedicatedOpen ? [patrolTab()] : [] } };
      }
      if (input.command === 'open') {
        dedicatedOpen = true;
        return { state: { tabs: [patrolTab()] } };
      }
      if (input.command === 'show-follow-seller-verification') {
        challengeVisible = true;
        verificationPassed = false;
        return { state: { tabs: [patrolTab()] } };
      }
      if (input.command === 'hide-follow-seller-verification') {
        challengeVisible = false;
        return { state: { tabs: [patrolTab()] } };
      }
      if (input.command === 'ozon-data-follow-sellers') {
        captureAttempt += 1;
        if (captureAttempt === 1) {
          throw Object.assign(new Error('OZON_RR_CHALLENGE'), { code: 'OZON_RR_CHALLENGE' });
        }
        return {
          result: {
            failed: 0,
            results: input.skus.map((sku) => ({
              sku,
              followSellerConfirmed: true,
              followSellerCount: 0,
            })),
          },
        };
      }
      if (input.command === 'force-close') {
        dedicatedOpen = false;
        return { state: { tabs: [] } };
      }
      throw new Error(`unexpected command ${input.command}`);
    });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    const result = await captureFollowSellersForTargets({
      targets: [{ sku: '9300000001' }],
      profileId: 'profile-1',
      cooldownDelaysMs: [],
      interBatchDelayMs: 0,
      periodicCooldownMs: 0,
      manualVerificationPollMs: 0,
      manualVerificationTimeoutMs: 1_000,
    });

    expect(result).toMatchObject({ failed: 0 });
    expect(command.mock.calls.filter(([input]) => input.command === 'show-follow-seller-verification')).toHaveLength(1);
    expect(command.mock.calls.filter(([input]) => input.command === 'hide-follow-seller-verification')).toHaveLength(0);
    expect(command.mock.calls.filter(([input]) => input.command === 'ozon-data-follow-sellers')).toHaveLength(2);
  });

  it('stops and hides the patrol session when native visibility is not confirmed', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      profiles: [{ id: 'profile-1', connected: true }],
      selectedProfileId: 'profile-1',
    });
    const hiddenTab = {
      tabId: 'follow-hidden-1',
      accountId: 'profile-1',
      browserRole: 'follow-seller-collector',
      background: true,
      followSellerVerificationVisible: false,
      url: 'https://www.ozon.ru/product/product-9300000002/?__rr=1',
      loading: false,
      loadErrorCode: 0,
      navigationCompletedSequence: 1,
      proxyMode: 'system',
    };
    const command = vi.fn(async (input) => {
      if (input.command === 'state' || input.command === 'open') {
        return { state: { tabs: [hiddenTab] } };
      }
      if (input.command === 'ozon-data-follow-sellers') {
        throw Object.assign(new Error('OZON_RR_CHALLENGE'), { code: 'OZON_RR_CHALLENGE' });
      }
      if (input.command === 'show-follow-seller-verification') {
        return { state: { tabs: [hiddenTab] } };
      }
      if (input.command === 'hide-follow-seller-verification' || input.command === 'force-close') {
        return { state: { tabs: [] } };
      }
      throw new Error(`unexpected command ${input.command}`);
    });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    await expect(captureFollowSellersForTargets({
      targets: [{ sku: '9300000002' }],
      profileId: 'profile-1',
      cooldownDelaysMs: [],
      interBatchDelayMs: 0,
      periodicCooldownMs: 0,
    })).rejects.toMatchObject({ code: 'FOLLOW_SELLER_VERIFICATION_WINDOW_NOT_VISIBLE' });

    expect(command.mock.calls.filter(([input]) => input.command === 'hide-follow-seller-verification')).toHaveLength(1);
    expect(command.mock.calls.filter(([input]) => input.command === 'force-close')).toHaveLength(1);
  });

  it('keeps the verification window open when only the automatic product navigation has completed', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      profiles: [{ id: 'profile-1', connected: true }],
      selectedProfileId: 'profile-1',
    });
    const visibleTab = {
      tabId: 'follow-visible-1',
      accountId: 'profile-1',
      browserRole: 'follow-seller-collector',
      background: false,
      followSellerVerificationVisible: true,
      followSellerVerificationStatus: {
        pageReady: true,
        challengeDetected: false,
        verificationReady: true,
      },
      url: 'https://www.ozon.ru/product/product-9300000003/',
      loading: false,
      loadErrorCode: 0,
      navigationCompletedSequence: 2,
      proxyMode: 'system',
    };
    const command = vi.fn(async (input) => {
      if (input.command === 'state' || input.command === 'open') {
        return { state: { tabs: [visibleTab] } };
      }
      if (input.command === 'ozon-data-follow-sellers') {
        throw Object.assign(new Error('OZON_RR_CHALLENGE'), { code: 'OZON_RR_CHALLENGE' });
      }
      if (input.command === 'show-follow-seller-verification'
        || input.command === 'read-follow-seller-verification') {
        return { state: { tabs: [visibleTab] } };
      }
      if (input.command === 'hide-follow-seller-verification' || input.command === 'force-close') {
        return { state: { tabs: [] } };
      }
      throw new Error(`unexpected command ${input.command}`);
    });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    await expect(captureFollowSellersForTargets({
      targets: [{ sku: '9300000003' }],
      profileId: 'profile-1',
      cooldownDelaysMs: [],
      interBatchDelayMs: 0,
      periodicCooldownMs: 0,
      manualVerificationPollMs: 50,
      manualVerificationTimeoutMs: 1_000,
    })).rejects.toMatchObject({ code: 'FOLLOW_SELLER_MANUAL_VERIFICATION_TIMEOUT' });

    const hidden = await toggleActiveFollowSellerVerificationBrowser();

    expect(command.mock.calls.filter(([input]) => input.command === 'ozon-data-follow-sellers')).toHaveLength(1);
    expect(command.mock.calls.filter(([input]) => input.command === 'read-follow-seller-verification').length).toBeGreaterThan(1);
    expect(hidden).toMatchObject({ available: true, visible: false, tabId: 'follow-visible-1' });
    expect(command.mock.calls.filter(([input]) => input.command === 'hide-follow-seller-verification')).toHaveLength(1);
    expect(command.mock.calls.filter(([input]) => input.command === 'force-close')).toHaveLength(0);
  });

  it('can present the same internal patrol page again when Ozon requests a second manual verification', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      profiles: [{ id: 'profile-1', connected: true }],
      selectedProfileId: 'profile-1',
    });
    let networkMode = '';
    let captureAttempt = 0;
    let challengeVisible = false;
    let challengeRound = 0;
    let verificationPassed = false;
    const patrolTab = () => ({
      tabId: 'follow-1',
      accountId: 'profile-1',
      browserRole: 'follow-seller-collector',
      background: !challengeVisible,
      followSellerVerificationVisible: challengeVisible,
      followSellerVerificationStatus: {
        pageReady: true,
        challengeDetected: !verificationPassed,
        verificationReady: verificationPassed,
      },
      url: verificationPassed
        ? 'https://www.ozon.ru/product/product-9200000001/'
        : `https://www.ozon.ru/product/product-9200000001/?__rr=${challengeRound}`,
      loading: false,
      loadErrorCode: 0,
      navigationCompletedSequence: challengeRound * 2 + (verificationPassed ? 1 : 0),
      proxyMode: 'system',
    });
    const command = vi.fn(async (input) => {
      if (input.command === 'state' || input.command === 'read-follow-seller-verification') {
        if (challengeVisible) verificationPassed = true;
        return {
          state: {
            tabs: networkMode ? [patrolTab()] : [],
          },
        };
      }
      if (input.command === 'open') {
        networkMode = input.networkMode;
        return {
          state: {
            tabs: [patrolTab()],
          },
        };
      }
      if (input.command === 'force-close') {
        networkMode = '';
        return { state: { tabs: [] } };
      }
      if (input.command === 'show-follow-seller-verification') {
        challengeRound += 1;
        challengeVisible = true;
        verificationPassed = false;
        return { state: { tabs: [patrolTab()] } };
      }
      if (input.command === 'hide-follow-seller-verification') {
        challengeVisible = false;
        return { state: { tabs: [patrolTab()] } };
      }
      if (input.command === 'ozon-data-follow-sellers') {
        captureAttempt += 1;
        if (captureAttempt <= 2) {
          return {
            result: {
              failed: input.skus.length,
              results: input.skus.map((sku) => ({
                sku,
                status: 403,
                errorCode: 'HTTP_403',
                followSellerConfirmed: false,
              })),
            },
          };
        }
        expect(input.concurrency).toBe(captureAttempt === 3 ? 1 : 2);
        expect(input.skus.length).toBeLessThanOrEqual(12);
        return {
          result: {
            failed: 0,
            results: input.skus.map((sku) => ({
              sku,
              followSellerConfirmed: true,
              followSellerCount: 0,
            })),
          },
        };
      }
      throw new Error(`unexpected command ${input.command}`);
    });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    const batches = vi.fn(async () => undefined);
    const recoveries = vi.fn();

    const result = await captureFollowSellersForTargets({
      targets: [{ sku: '9200000001' }, { sku: '9200000002' }],
      profileId: 'profile-1',
      cooldownDelaysMs: [1, 1],
      interBatchDelayMs: 0,
      periodicCooldownMs: 0,
      manualVerificationPollMs: 0,
      manualVerificationTimeoutMs: 1_000,
      onBatch: batches,
      onRecovery: recoveries,
    });

    expect(result).toMatchObject({ failed: 0 });
    expect(result.results).toHaveLength(2);
    expect(command.mock.calls.filter(([input]) => input.command === 'open').map(([input]) => input.networkMode))
      .toEqual(['auto']);
    expect(command.mock.calls.filter(([input]) => input.command === 'show-follow-seller-verification')).toHaveLength(2);
    expect(command.mock.calls.filter(([input]) => input.command === 'hide-follow-seller-verification')).toHaveLength(0);
    expect(recoveries).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      delayMs: 0,
		networkMode: 'auto',
      status: 403,
      reason: 'manual_verification',
    }));
    expect(recoveries).toHaveBeenCalledWith(expect.objectContaining({
      status: 200,
      reason: 'manual_verification_complete',
    }));
    expect(batches.mock.calls.flatMap(([batch]) => batch.results).some((item) => item.status === 403)).toBe(false);
  });

  it('force-closes the dedicated browser when capture fails', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      profiles: [{ id: 'profile-1', connected: true }],
      selectedProfileId: 'profile-1',
    });
    const captureError = Object.assign(new Error('network failed'), { code: 'FAILED_TO_FETCH' });
    const command = createBrowserCommand({ captureError });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    await expect(captureFollowSellersForTargets({
      targets: [{ sku: '9000000001' }],
      profileId: 'profile-1',
      cooldownDelaysMs: [],
    })).rejects.toMatchObject({ code: 'FOLLOW_SELLER_NETWORK_ROUTE_UNAVAILABLE' });

    expect(command.mock.calls.filter(([input]) => input.command === 'force-close')).toHaveLength(2);
    const finalState = await command({ command: 'state' });
    expect(finalState.state.tabs.map((tab) => tab.tabId)).toEqual(['market-1', 'interactive-1']);
  });

  it('submits exactly PSD and PDF in the dedicated browser and closes it after receipt', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      profiles: [{ id: 'profile-1', connected: true }],
      selectedProfileId: 'profile-1',
    });
    const command = createBrowserCommand();
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    const result = await submitFollowSellerComplaintInBrowser({
      profileId: 'profile-1',
      submission: {
        caseId: 'case-1',
        previewId: 'preview-1',
        evidenceId: 'evidence-1',
        manifestPath: 'C:/follow-seller-evidence/case-1/manifest.json',
        materialDirectory: 'C:/follow-seller-evidence/case-1',
        originalSku: '900000001',
        offerId: 'WZ-SAME-001',
        followerSkus: ['3771432837', '3771432838'],
        listingDate: '2026-08-01',
        speech: {
          ru: 'Фактическое обращение',
          initialEvidenceRu: 'Фактическое обращение',
          supplementRu: 'Дополнение с датой {{LISTING_DATE}}',
          followerBatchRu: '3771432837\n3771432838',
        },
        files: [
          { kind: 'psd', name: 'evidence.psd', path: 'C:/follow-seller-evidence/evidence.psd', sha256: 'a'.repeat(64) },
          { kind: 'pdf', name: 'evidence.pdf', path: 'C:/follow-seller-evidence/evidence.pdf', sha256: 'b'.repeat(64) },
        ],
        supplementFiles: [
          { name: 'own-seller-list.png', path: 'C:/follow-seller-evidence/case-1/own-seller-list.png', sha256: 'c'.repeat(64) },
        ],
      },
    });

    expect(result.ticketId).toBe('ticket-10001');
    expect(command.mock.calls.filter(([input]) => input.command === 'ozon-submit-follow-seller-complaint')).toHaveLength(1);
    expect(command.mock.calls.filter(([input]) => input.command === 'force-close')).toHaveLength(1);
  });

  it('keeps a single submit attempt and closes the browser after submit failure', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      profiles: [{ id: 'profile-1', connected: true }],
      selectedProfileId: 'profile-1',
    });
    const complaintError = Object.assign(new Error('selector changed'), { code: 'FOLLOW_SELLER_COMPLAINT_ROUTE_CHANGED' });
    const command = createBrowserCommand({ complaintError });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    await expect(submitFollowSellerComplaintInBrowser({
      profileId: 'profile-1',
      submission: {
        caseId: 'case-1',
        previewId: 'preview-1',
        evidenceId: 'evidence-1',
        manifestPath: 'C:/follow-seller-evidence/case-1/manifest.json',
        materialDirectory: 'C:/follow-seller-evidence/case-1',
        originalSku: '900000001',
        offerId: 'WZ-SAME-001',
        followerSkus: ['3771432837'],
        listingDate: '2026-08-01',
        speech: {
          ru: 'Фактическое обращение',
          initialEvidenceRu: 'Фактическое обращение',
          supplementRu: 'Дополнение с датой {{LISTING_DATE}}',
          followerBatchRu: '3771432837',
        },
        files: [
          { kind: 'psd', path: 'C:/follow-seller-evidence/evidence.psd', sha256: 'a'.repeat(64) },
          { kind: 'pdf', path: 'C:/follow-seller-evidence/evidence.pdf', sha256: 'b'.repeat(64) },
        ],
        supplementFiles: [
          { path: 'C:/follow-seller-evidence/case-1/own-seller-list.png', sha256: 'c'.repeat(64) },
        ],
      },
    })).rejects.toMatchObject({ code: 'FOLLOW_SELLER_COMPLAINT_ROUTE_CHANGED' });

    expect(command.mock.calls.filter(([input]) => input.command === 'ozon-submit-follow-seller-complaint')).toHaveLength(1);
    expect(command.mock.calls.filter(([input]) => input.command === 'force-close')).toHaveLength(1);
  });

  it('captures scheme 2 pages with the exact shop seller profile and closes the temporary browser', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({
      profiles: [
        { id: 'seller-wrong', integrationType: 'ozon-browser-session', shopId: 'shop-2', configStatus: '连接成功', tokenStatus: 'Cookie 已保存' },
        {
          id: 'seller-shop-1',
          integrationType: 'ozon-browser-session',
          shopId: 'shop-1',
          configStatus: '等待 API 核对',
          tokenStatus: 'Cookie 已保存',
          identityStatus: 'browser-matched',
          browserCompanyId: '4067587',
          apiIdentityId: '4067587',
          identityVerifiedAt: '2026-08-17T10:29:17.030Z',
        },
      ],
    });
    let open = false;
    const tab = {
      tabId: 'scheme2-evidence-tab',
      accountId: 'seller-shop-1',
      browserRole: 'follow-seller-collector',
      background: true,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    };
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return { state: { tabs: open ? [tab] : [] } };
      if (input.command === 'open') {
        expect(input).toMatchObject({
          accountId: 'seller-shop-1',
          platformName: 'Ozon',
          url: 'https://seller.ozon.ru/app/dashboard/main',
          browserRole: 'follow-seller-collector',
          background: true,
          networkMode: 'direct',
        });
        open = true;
        return { state: { tabs: [tab] } };
      }
      if (input.command === 'ozon-prepare-follow-seller-scheme2-evidence') {
        expect(input).toMatchObject({
          tabId: 'scheme2-evidence-tab',
          originalSku: '900000001',
          offerId: 'WZ-SAME-001',
          followerSkus: ['3771432837'],
        });
        return { result: {
          ok: true,
          listingDate: '2026-08-01',
          ownProductPage: { path: 'C:/follow-seller-evidence/case-1/own-product-page.png' },
          ownSellerList: { path: 'C:/follow-seller-evidence/case-1/own-seller-list.png' },
          followerProductPages: [{ path: 'C:/follow-seller-evidence/case-1/follower-01-3771432837-page.png' }],
        } };
      }
      if (input.command === 'force-close') {
        open = false;
        return { state: { tabs: [] } };
      }
      throw new Error(`unexpected command ${input.command}`);
    });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    const result = await collectFollowSellerScheme2EvidenceInBrowser({
      captureRequest: {
        caseId: 'case-1',
        shopId: 'shop-1',
        previewId: 'preview-1',
        evidenceId: 'evidence-1',
        materialDirectory: 'C:/follow-seller-evidence/case-1',
        sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
        originalSku: '900000001',
        offerId: 'WZ-SAME-001',
        followerSkus: ['3771432837'],
        evidenceFollowers: [{ sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' }],
      },
    });

    expect(result.listingDate).toBe('2026-08-01');
    expect(command.mock.calls.filter(([input]) => input.command === 'ozon-prepare-follow-seller-scheme2-evidence')).toHaveLength(1);
    expect(command.mock.calls.filter(([input]) => input.command === 'force-close')).toHaveLength(1);
    expect(open).toBe(false);
  });

  it('submits a scheme1 batch through the exact shop seller profile and reuses one hidden backend tab', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({
      profiles: [
        { id: 'wrong-shop', integrationType: 'ozon-browser-session', shopId: 'shop-2', configStatus: '连接成功', tokenStatus: 'Cookie 已保存' },
        {
          id: 'seller-shop-1',
          integrationType: 'ozon-browser-session',
          shopId: 'shop-1',
          configStatus: '等待 API 核对',
          tokenStatus: 'Cookie 已保存',
          identityStatus: 'browser-matched',
          browserCompanyId: '4067587',
          apiIdentityId: '4067587',
          identityVerifiedAt: '2026-08-17T10:29:17.030Z',
        },
      ],
    });
    let open = false;
    let progressListener = null;
    const unsubscribe = vi.fn();
    const onEvent = vi.fn((listener) => {
      progressListener = listener;
      return unsubscribe;
    });
    const state = () => ({ tabs: open ? [{
      tabId: 'scheme1-tab', accountId: 'seller-shop-1', browserRole: 'follow-seller-collector', background: true,
    }] : [] });
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return { state: state() };
      if (input.command === 'open') {
        expect(input).toMatchObject({
          accountId: 'seller-shop-1',
          platformName: 'Ozon',
          url: 'https://seller.ozon.ru/app/dashboard/main',
          browserRole: 'follow-seller-collector',
          background: true,
        });
        open = true;
        return { state: state() };
      }
	  if (input.command === 'show-follow-seller-quick-browser') {
		expect(input.tabId).toBe('scheme1-tab');
		return { result: { ok: true, visible: true } };
	  }
      if (input.command === 'ozon-submit-follow-seller-quick-complaint') {
        expect(input.tabId).toBe('scheme1-tab');
        expect(input.progressToken).toMatch(/^scheme1-progress-/u);
        expect(input.originalSku).toBe('900000001');
        expect(input.followerSkus).toEqual(['3771432837']);
		expect(input.followers).toEqual([{ sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' }]);
		if (input.evidenceId === 'evidence-1') await showActiveFollowSellerQuickBrowser();
		if (input.evidenceId === 'evidence-2') {
		  expect(input).toMatchObject({
			resumeExisting: true,
			resumeTicketId: '90620788',
			resumePageUrl: 'https://seller.ozon.ru/app/messenger/?id=resume-ticket-1&group=support_v2',
			resumePhase: 'wait-evidence-prompt',
		  });
		}
        progressListener?.({
          event: 'follow-seller-scheme1-progress',
          tabId: 'scheme1-tab',
          progressToken: input.progressToken,
          stage: 'select:quality-control',
          status: 'running',
          message: '正在选择“质量监督”',
          at: '2026-08-16T15:00:00.000Z',
        });
        return { result: { ok: true, ticketId: `ticket-${input.evidenceId}`, messageId: `ticket-${input.evidenceId}` } };
      }
      if (input.command === 'force-close') {
        open = false;
        return { state: state() };
      }
      throw new Error(`unexpected command ${input.command}`);
    });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command, onEvent } };
    const makeSubmission = (suffix) => ({
      scheme: 'scheme1-seller-backend',
      caseId: `case-${suffix}`,
      shopId: 'shop-1',
      previewId: `preview-${suffix}`,
      evidenceId: `evidence-${suffix}`,
      manifestPath: `C:/follow-seller-evidence/scheme1/${suffix}/manifest.json`,
      materialDirectory: `C:/follow-seller-evidence/scheme1/${suffix}`,
      sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
      originalSku: '900000001',
	      offerId: 'offer-900000001',
      followerSkus: ['3771432837'],
	  followers: [{ sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' }],
	      evidenceFollowers: [{ sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' }],
	      speech: {
	        ru: 'Первичное доказательство',
	        initialEvidenceRu: 'Первичное доказательство',
	        supplementRu: 'Дата размещения карточки: {{LISTING_DATE}}.',
	        followerBatchRu: '3771432837\nПрошу принять жалобу.',
	        zh: '准确话术',
	      },
      files: [{ kind: 'current_image', name: 'current.png', path: `C:/follow-seller-evidence/scheme1/${suffix}/current.png`, sha256: 'a'.repeat(64) }],
    });
	const resumedSubmission = {
	  ...makeSubmission('2'),
	  continuation: {
		requested: true,
		ticketId: '90620788',
		pageUrl: 'https://seller.ozon.ru/app/messenger/?id=resume-ticket-1&group=support_v2',
		phase: 'wait-evidence-prompt',
		previousSubmissionStarted: true,
	  },
	};
    const progress = vi.fn();
    const result = await submitFollowSellerQuickBatchInBrowser({
      shopId: 'shop-1',
	  submissions: [makeSubmission('1'), resumedSubmission],
      onProgress: progress,
    });
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(command.mock.calls.filter(([input]) => input.command === 'open')).toHaveLength(1);
    expect(command.mock.calls.filter(([input]) => input.command === 'ozon-submit-follow-seller-quick-complaint')).toHaveLength(2);
	expect(command.mock.calls.filter(([input]) => input.command === 'show-follow-seller-quick-browser')).toHaveLength(1);
    expect(command.mock.calls.filter(([input]) => input.command === 'force-close')).toHaveLength(1);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'select:quality-control',
      message: '正在选择“质量监督”',
      caseId: 'case-1',
      offerId: 'offer-900000001',
    }));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('stops confirmed login failures and retries only explicit pre-send browser failures per product', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({
      profiles: [{
        id: 'seller-shop-1',
        integrationType: 'ozon-browser-session',
        shopId: 'shop-1',
        configStatus: '连接成功',
        tokenStatus: 'Cookie 已保存',
      }],
    });
    let open = false;
    const attempts = new Map();
    const state = () => ({ tabs: open ? [{
      tabId: 'scheme1-tab', accountId: 'seller-shop-1', browserRole: 'follow-seller-collector', background: true,
    }] : [] });
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return { state: state() };
      if (input.command === 'open') {
        open = true;
        return { state: state() };
      }
      if (input.command === 'force-close') {
        open = false;
        return { state: state() };
      }
      if (input.command !== 'ozon-submit-follow-seller-quick-complaint') {
        throw new Error(`unexpected command ${input.command}`);
      }
      const attempt = (attempts.get(input.evidenceId) || 0) + 1;
      attempts.set(input.evidenceId, attempt);
      if (input.evidenceId === 'evidence-login' && attempt === 1) {
        return { result: {
          ok: false,
          submissionStarted: false,
          stage: 'seller-backend:login-transition',
          error: { code: 'OZON_LOGIN_REQUIRED', message: 'OZON_LOGIN_REQUIRED' },
        } };
      }
	  if (input.evidenceId === 'evidence-pending' && attempt === 1) {
		throw Object.assign(new Error('OZON_LOGIN_VERIFICATION_PENDING'), {
		  code: 'OZON_LOGIN_VERIFICATION_PENDING',
		});
	  }
      if (input.evidenceId === 'evidence-cef' && attempt === 1) {
        throw Object.assign(new Error('PURCHASE_BROWSER_CEF_FAILED'), { code: 'PURCHASE_BROWSER_CEF_FAILED' });
      }
      if (input.evidenceId === 'evidence-local' && attempt === 1) {
        throw new Error("Error invoking remote method 'desktop:purchase-browser-command': Error: PURCHASE_BROWSER_INTEGRATION_LOGIN_STATUS_PERSIST_FAILED");
      }
      if (input.evidenceId === 'evidence-started') {
        return { result: {
          ok: false,
          submissionStarted: true,
          stage: 'seller-backend:wait-initial-reply',
          error: { code: 'PURCHASE_BROWSER_CEF_FAILED', message: 'PURCHASE_BROWSER_CEF_FAILED' },
        } };
      }
	  if (input.evidenceId === 'evidence-persisted' && attempt === 1) {
		return { result: {
		  ok: false,
		  submissionStarted: false,
		  stage: 'seller-backend:browser-recovery',
		  phase: 'route',
		  ticketId: '90650002',
		  pageUrl: 'https://seller.ozon.ru/app/messenger/?id=90650002',
		  error: {
			code: 'FOLLOW_SELLER_SCHEME1_BROWSER_TRANSIENT_FAILED',
			message: 'FOLLOW_SELLER_SCHEME1_BROWSER_TRANSIENT_FAILED',
		  },
		} };
	  }
	  if (input.evidenceId === 'evidence-persisted' && attempt === 2) {
		expect(input).toMatchObject({
		  reusePreparedEvidence: true,
		  resumeExisting: true,
		  resumeTicketId: '90650002',
		  resumePageUrl: 'https://seller.ozon.ru/app/messenger/?id=90650002',
		});
		return { result: {
		  ok: false,
		  submissionStarted: true,
		  stage: 'prepare-evidence',
		  error: { code: 'PURCHASE_BROWSER_CEF_FAILED', message: 'PURCHASE_BROWSER_CEF_FAILED' },
		} };
	  }
	  if (input.evidenceId === 'evidence-route') {
		return { result: {
		  ok: false,
		  submissionStarted: false,
		  stage: 'seller-backend:waiting',
		  error: { code: 'FOLLOW_SELLER_SCHEME1_ROUTE_REPLY_TIMEOUT', message: 'FOLLOW_SELLER_SCHEME1_ROUTE_REPLY_TIMEOUT' },
		} };
	  }
	  if (input.evidenceId === 'evidence-daily' && attempt === 1) {
		return { result: {
		  ok: false,
		  submissionStarted: false,
		  error: { code: 'FOLLOW_SELLER_SCHEME1_BROWSER_TRANSIENT_FAILED', message: 'transient' },
		} };
	  }
	  if (input.evidenceId === 'evidence-daily' && attempt === 2) {
		return { result: {
		  ok: false,
		  submissionStarted: false,
		  error: { code: 'FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT', message: 'daily limit' },
		} };
	  }
      return { result: {
        ok: true,
        submissionStarted: true,
        ticketId: `ticket-${input.evidenceId}`,
        messageId: `ticket-${input.evidenceId}`,
      } };
    });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    const makeSubmission = (suffix) => ({
      scheme: 'scheme1-seller-backend',
      caseId: `case-${suffix}`,
      shopId: 'shop-1',
      previewId: `preview-${suffix}`,
      evidenceId: `evidence-${suffix}`,
      manifestPath: `C:/follow-seller-evidence/scheme1/${suffix}/manifest.json`,
      materialDirectory: `C:/follow-seller-evidence/scheme1/${suffix}`,
      sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
      originalSku: '900000001',
      offerId: `offer-${suffix}`,
      followerSkus: ['3771432837'],
      followers: [{ sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' }],
      evidenceFollowers: [{ sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' }],
      speech: {
        initialEvidenceRu: 'Первичное доказательство',
        supplementRu: 'Дата размещения карточки: {{LISTING_DATE}}.',
        followerBatchRu: '3771432837\nПрошу принять жалобу.',
      },
      files: [{
        kind: 'current_image',
        name: 'current.png',
        path: `C:/follow-seller-evidence/scheme1/${suffix}/current.png`,
        sha256: 'a'.repeat(64),
      }],
    });
    const progress = vi.fn();

    const result = await submitFollowSellerQuickBatchInBrowser({
      shopId: 'shop-1',
      submissions: [
		makeSubmission('login'),
		makeSubmission('pending'),
		makeSubmission('cef'),
		makeSubmission('local'),
		makeSubmission('started'),
		makeSubmission('persisted'),
		makeSubmission('route'),
		makeSubmission('daily'),
	  ],
      onProgress: progress,
    });

    expect(result.ok).toBe(false);
    expect(result.results.map((item) => item.result.ok)).toEqual([false, true, true, true, false, false, false, false]);
	expect(result.results[5].result).toMatchObject({
	  recoveryAttempted: true,
	  submissionStarted: true,
	  ticketId: '90650002',
	  error: { code: 'FOLLOW_SELLER_SCHEME1_BROWSER_TRANSIENT_FAILED' },
	  retryFailure: { error: { code: 'PURCHASE_BROWSER_CEF_FAILED' } },
	});
	expect(result.results[7].result).toMatchObject({
	  submissionStarted: false,
	  recoveryAttempted: true,
	  error: { code: 'FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT' },
	  initialFailure: { error: { code: 'FOLLOW_SELLER_SCHEME1_BROWSER_TRANSIENT_FAILED' } },
	});
    expect(attempts).toEqual(new Map([
	  ['evidence-login', 1],
	  ['evidence-pending', 2],
	  ['evidence-cef', 2],
	  ['evidence-local', 2],
	  ['evidence-started', 1],
	  ['evidence-persisted', 2],
	  ['evidence-route', 1],
	  ['evidence-daily', 2],
	]));
    expect(command.mock.calls.filter(([input]) => input.command === 'ozon-submit-follow-seller-quick-complaint')).toHaveLength(13);
    expect(progress.mock.calls.filter(([entry]) => entry.stage === 'case-recovering')).toHaveLength(5);
    expect(command.mock.calls.filter(([input]) => input.command === 'force-close')).toHaveLength(1);
  }, 12_000);

  it('cancels the active scheme 1 browser and returns only already completed case results', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({
      profiles: [{
        id: 'seller-shop-1',
        integrationType: 'ozon-browser-session',
        shopId: 'shop-1',
        configStatus: '连接成功',
        tokenStatus: 'Cookie 已保存',
      }],
    });
    let open = false;
    let releaseSecondStart;
    const secondStarted = new Promise((resolve) => { releaseSecondStart = resolve; });
    const state = () => ({ tabs: open ? [{
      tabId: 'scheme1-tab', accountId: 'seller-shop-1', browserRole: 'follow-seller-collector', background: true,
    }] : [] });
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return { state: state() };
      if (input.command === 'open') {
        open = true;
        return { state: state() };
      }
      if (input.command === 'force-close') {
        open = false;
        return { state: state() };
      }
      if (input.command === 'ozon-submit-follow-seller-quick-complaint') {
        if (input.evidenceId === 'evidence-1') {
          return { result: { ok: true, submissionStarted: true, ticketId: 'ticket-1' } };
        }
        releaseSecondStart();
        return new Promise(() => {});
      }
      throw new Error(`unexpected command ${input.command}`);
    });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    const makeSubmission = (suffix) => ({
      scheme: 'scheme1-seller-backend',
      caseId: `case-${suffix}`,
      shopId: 'shop-1',
      previewId: `preview-${suffix}`,
      evidenceId: `evidence-${suffix}`,
      manifestPath: `C:/follow-seller-evidence/scheme1/${suffix}/manifest.json`,
      materialDirectory: `C:/follow-seller-evidence/scheme1/${suffix}`,
      sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
      originalSku: '900000001',
      offerId: `offer-${suffix}`,
      followerSkus: ['3771432837'],
      followers: [{ sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' }],
      evidenceFollowers: [{ sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' }],
      speech: {
        initialEvidenceRu: 'Первичное доказательство',
        supplementRu: 'Дата размещения карточки: {{LISTING_DATE}}.',
        followerBatchRu: '3771432837\nПрошу принять жалобу.',
      },
      files: [{
        kind: 'current_image',
        name: 'current.png',
        path: `C:/follow-seller-evidence/scheme1/${suffix}/current.png`,
        sha256: 'a'.repeat(64),
      }],
    });
    const controller = new AbortController();
    const run = submitFollowSellerQuickBatchInBrowser({
      shopId: 'shop-1',
      submissions: [makeSubmission('1'), makeSubmission('2')],
      signal: controller.signal,
    });

    await secondStarted;
    controller.abort();
    const result = await run;

    expect(result).toMatchObject({ ok: false, canceled: true });
    expect(result.results).toEqual([expect.objectContaining({
      caseId: 'case-1',
      result: expect.objectContaining({ ok: true, ticketId: 'ticket-1' }),
    })]);
    expect(command.mock.calls.filter(([input]) => input.command === 'force-close').length).toBeGreaterThanOrEqual(1);
  });
});
