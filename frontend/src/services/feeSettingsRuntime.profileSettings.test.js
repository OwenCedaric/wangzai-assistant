import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfileSetting: vi.fn(),
  saveProfileSetting: vi.fn(),
}));

vi.mock('../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProfileSetting: mocks.getProfileSetting,
  saveProfileSetting: mocks.saveProfileSetting,
}));

import {
  loadFeePlanState,
  readSavedFeePlanState,
  saveFeePlanState,
} from './feeSettingsRuntime.js';

const feeState = {
  activeId: 'plan-a',
  plans: [
    {
      id: 'plan-a',
      name: '跨境巴士费用',
      settings: { platform: 'crossBorderBus', labelFeeUnit: '1.5', rechargeAmount: '100', giftAmount: '', forecastOrderFee: '0.2' },
    },
  ],
};

afterEach(() => {
  globalThis.localStorage.clear();
  vi.clearAllMocks();
});

describe('fee settings canonical SQLite runtime', () => {
  it('loads the local-api profile record as the only durable input', async () => {
    globalThis.localStorage.setItem('wangzai-fee-plan-state', JSON.stringify({ activeId: 'retired-plan' }));
    globalThis.localStorage.setItem('wangzai-fee-settings', JSON.stringify({ platform: 'purchase' }));
    mocks.getProfileSetting.mockResolvedValue({
      setting: { namespace: 'fee-settings', value: feeState, updatedAt: '2026-07-15T08:32:25.979Z' },
    });

    const state = await loadFeePlanState();

    expect(mocks.getProfileSetting).toHaveBeenCalledWith('fee-settings', { timeoutMs: 10000 });
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
    expect(state).toMatchObject(feeState);
    expect(state.plans[0].settings.rechargeRateHistory[0]).toMatchObject({
      effectiveAt: '2026-07-15T08:32:25.979Z',
      rechargeAmount: '100',
      giftAmount: '0',
    });
    expect(readSavedFeePlanState()).toMatchObject(feeState);
    expect(globalThis.localStorage.getItem('wangzai-fee-plan-state')).not.toBeNull();
    expect(globalThis.localStorage.getItem('wangzai-fee-settings')).not.toBeNull();
  });

  it('does not resurrect either retired browser key when canonical SQLite has no record', async () => {
    const retiredPlanRaw = JSON.stringify(feeState);
    const retiredSettingsRaw = JSON.stringify(feeState.plans[0].settings);
    globalThis.localStorage.setItem('wangzai-fee-plan-state', retiredPlanRaw);
    globalThis.localStorage.setItem('wangzai-fee-settings', retiredSettingsRaw);
    mocks.getProfileSetting.mockResolvedValue({ setting: null });

    const state = await loadFeePlanState();

    expect(state.plans).toHaveLength(1);
    expect(state.plans[0].settings.platform).toBe('');
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem('wangzai-fee-plan-state')).toBe(retiredPlanRaw);
    expect(globalThis.localStorage.getItem('wangzai-fee-settings')).toBe(retiredSettingsRaw);
  });

  it('keeps a failed canonical read fail-closed instead of falling back to browser or file data', async () => {
    mocks.getProfileSetting.mockRejectedValue(new Error('canonical unavailable'));
    globalThis.localStorage.setItem('wangzai-fee-settings', JSON.stringify(feeState.plans[0].settings));

    await expect(loadFeePlanState()).rejects.toThrow('canonical unavailable');
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem('wangzai-fee-settings')).not.toBeNull();
  });

  it('persists later edits through local-api SQLite', async () => {
    mocks.getProfileSetting.mockResolvedValue({ setting: null });
    await loadFeePlanState();
    mocks.saveProfileSetting.mockResolvedValue({ setting: { namespace: 'fee-settings', value: feeState } });

    const state = saveFeePlanState(feeState);

    expect(state).toMatchObject(feeState);
    await vi.waitFor(() =>
      expect(mocks.saveProfileSetting).toHaveBeenCalledWith('fee-settings', expect.any(Object), { timeoutMs: 30000 })
    );
  });
});
