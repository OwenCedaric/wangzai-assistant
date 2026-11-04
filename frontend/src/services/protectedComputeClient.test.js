import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeCollectionPricingQuote,
  executeProfitabilityQuote,
  getProtectedComputeStatus,
  listProtectedComputeContracts,
} from './protectedComputeClient.js';

const INPUT = Object.freeze({
  acquiringBasisPoints: 150,
  commissionBasisPoints: 1_700,
  costMinor: 2_500,
  currency: 'rub',
  logisticsMinor: 600,
  salePriceMinor: 5_516,
  taxBasisPoints: 600,
});
const COLLECTION_INPUT = Object.freeze({
  commissionBasisPoints: 1_700,
  currency: 'cny',
  currentPriceMinor: 5_516,
  extraCostMinor: 100,
  firstMileCostMinor: 600,
  purchaseCostMinor: 2_500,
  targetMarginBasisPoints: 2_000,
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.window?.wangzaiDesktop;
});

function installBridge(handler) {
  vi.stubGlobal('window', {
    wangzaiDesktop: { localApiRequest: vi.fn(handler) },
  });
  return globalThis.window.wangzaiDesktop.localApiRequest;
}

describe('protected compute renderer client', () => {
  it('sends only the typed minimal DTO to local-api and accepts verified output', async () => {
    const bridge = installBridge(async (_request) => ({
      ok: true,
      status: 200,
      data: {
        ok: true,
        contract: 'local-protected-compute-result/v1',
        capability: 'profitability.quote',
        version: 1,
        result: {
          contributionMinor: 917,
          currency: 'RUB',
          decision: 'review',
          marginBasisPoints: 1_662,
        },
        source: 'server-signed',
        signatureVerified: true,
        verification: { responseId: 'response-1' },
      },
    }));

    const result = await executeProfitabilityQuote(INPUT);
    expect(result.result.contributionMinor).toBe(917);
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge.mock.calls[0][0]).toMatchObject({
      path: '/api/protected-compute/execute',
      method: 'POST',
      body: {
        capability: 'profitability.quote',
        version: 1,
        input: { ...INPUT, currency: 'RUB' },
      },
    });
    expect(JSON.stringify(bridge.mock.calls[0][0])).not.toMatch(/accessToken|serverBaseUrl|signature/u);
  });

  it('rejects secret-shaped or extra input before calling the desktop bridge', async () => {
    const bridge = installBridge(async () => ({ ok: true, status: 200, data: {} }));
    await expect(executeProfitabilityQuote({ ...INPUT, api_key: 'not-forwarded' })).rejects.toMatchObject({
      code: 'PROTECTED_COMPUTE_SECRET_REJECTED',
    });
    await expect(executeProfitabilityQuote({ ...INPUT, arbitrary: 1 })).rejects.toMatchObject({
      code: 'PROTECTED_COMPUTE_INPUT_FIELDS_INVALID',
    });
    expect(bridge).not.toHaveBeenCalled();
  });

  it('executes collection-pricing.quote@1 with its exact minimal DTO and typed signed result', async () => {
    const bridge = installBridge(async () => ({
      ok: true,
      status: 200,
      data: {
        ok: true,
        contract: 'local-protected-compute-result/v1',
        capability: 'collection-pricing.quote',
        version: 1,
        result: {
          breakEvenPriceMinor: 3_856,
          currency: 'CNY',
          currentMarginBasisPoints: 2_498,
          currentProfitMinor: 1_378,
          suggestedPriceMinor: 4_627,
          totalCostMinor: 3_200,
        },
        source: 'server-signed',
        signatureVerified: true,
        verification: { responseId: 'collection-response-1' },
      },
    }));

    const result = await executeCollectionPricingQuote(COLLECTION_INPUT);
    expect(result.result.suggestedPriceMinor).toBe(4_627);
    expect(bridge).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/protected-compute/execute',
        method: 'POST',
        body: {
          capability: 'collection-pricing.quote',
          version: 1,
          input: { ...COLLECTION_INPUT, currency: 'CNY' },
        },
      })
    );
  });

  it('rejects collection pricing secrets, extra fields, and unverified output before use', async () => {
    const bridge = installBridge(async () => ({
      ok: true,
      status: 200,
      data: {
        ok: true,
        contract: 'local-protected-compute-result/v1',
        capability: 'collection-pricing.quote',
        version: 1,
        result: {},
        source: 'server-signed',
        signatureVerified: false,
      },
    }));
    await expect(
      executeCollectionPricingQuote({ ...COLLECTION_INPUT, cookie: 'must-not-forward' })
    ).rejects.toMatchObject({ code: 'PROTECTED_COMPUTE_SECRET_REJECTED' });
    await expect(executeCollectionPricingQuote({ ...COLLECTION_INPUT, arbitrary: 1 })).rejects.toMatchObject({
      code: 'PROTECTED_COMPUTE_INPUT_FIELDS_INVALID',
    });
    expect(bridge).not.toHaveBeenCalled();
    await expect(executeCollectionPricingQuote(COLLECTION_INPUT)).rejects.toMatchObject({
      code: 'PROTECTED_COMPUTE_RESULT_UNVERIFIED',
    });
  });

  it('fails before network when the Electron protected-compute proxy is unavailable', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    delete globalThis.window?.wangzaiDesktop;
    await expect(executeCollectionPricingQuote(COLLECTION_INPUT)).rejects.toMatchObject({
      code: 'PROTECTED_COMPUTE_DESKTOP_PROXY_REQUIRED',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when local-api does not mark the result as signature verified', async () => {
    installBridge(async () => ({
      ok: true,
      status: 200,
      data: {
        ok: true,
        contract: 'local-protected-compute-result/v1',
        capability: 'profitability.quote',
        version: 1,
        result: {},
        source: 'server-signed',
        signatureVerified: false,
      },
    }));
    await expect(executeProfitabilityQuote(INPUT)).rejects.toMatchObject({
      code: 'PROTECTED_COMPUTE_RESULT_UNVERIFIED',
    });
  });

  it('uses typed status and contract-list routes', async () => {
    const bridge = installBridge(async ({ path }) => ({
      ok: true,
      status: 200,
      data: path.endsWith('/status')
        ? {
            ok: true,
            contract: 'local-protected-compute-status/v1',
            available: false,
            configured: false,
            configVersion: null,
            configExpiresAt: null,
            offlineEnabled: false,
            reasonCode: 'PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED',
            contracts: [
              { capability: 'profitability.quote', version: 1 },
              { capability: 'collection-pricing.quote', version: 1 },
            ],
          }
        : {
            ok: true,
            contract: 'local-protected-compute-contracts/v1',
            contracts: [
              { capability: 'profitability.quote', version: 1 },
              { capability: 'collection-pricing.quote', version: 1 },
            ],
          },
    }));
    expect((await getProtectedComputeStatus()).available).toBe(false);
    expect(await listProtectedComputeContracts()).toEqual([
      { capability: 'profitability.quote', version: 1 },
      { capability: 'collection-pricing.quote', version: 1 },
    ]);
    expect(bridge.mock.calls.map(([request]) => request.path)).toEqual([
      '/api/protected-compute/status',
      '/api/protected-compute/contracts',
    ]);
  });

  it('rejects malformed, duplicate, or unversioned protected-compute contract lists', async () => {
    const cases = [
      {
        ok: true,
        contracts: [{ capability: 'profitability.quote', version: 1 }],
      },
      {
        ok: true,
        contract: 'local-protected-compute-contracts/v1',
        contracts: [{ capability: 'profitability.quote', version: '1' }],
      },
      {
        ok: true,
        contract: 'local-protected-compute-contracts/v1',
        contracts: [{ capability: 'profitability.quote', version: 1, arbitrary: true }],
      },
      {
        ok: true,
        contract: 'local-protected-compute-contracts/v1',
        contracts: [
          { capability: 'profitability.quote', version: 1 },
          { capability: 'profitability.quote', version: 1 },
        ],
      },
    ];

    for (const payload of cases) {
      installBridge(async () => ({ ok: true, status: 200, data: payload }));
      await expect(listProtectedComputeContracts()).rejects.toMatchObject({
        code: 'PROTECTED_COMPUTE_CONTRACTS_INVALID',
      });
    }
  });

  it('rejects contradictory or malformed protected-compute runtime status', async () => {
    const base = {
      ok: true,
      contract: 'local-protected-compute-status/v1',
      available: false,
      configured: false,
      configVersion: null,
      configExpiresAt: null,
      offlineEnabled: false,
      reasonCode: 'PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED',
      contracts: [{ capability: 'profitability.quote', version: 1 }],
    };
    const cases = [
      { ...base, available: true },
      { ...base, configVersion: 0 },
      { ...base, configExpiresAt: 'not-a-time' },
      { ...base, reasonCode: 'arbitrary' },
      { ...base, contracts: [{ capability: 'profitability.quote', version: 1, extra: true }] },
    ];

    for (const payload of cases) {
      installBridge(async () => ({ ok: true, status: 200, data: payload }));
      await expect(getProtectedComputeStatus()).rejects.toMatchObject({
        code: expect.stringMatching(/^PROTECTED_COMPUTE_(?:STATUS|CONTRACTS)_INVALID$/u),
      });
    }
  });
});
