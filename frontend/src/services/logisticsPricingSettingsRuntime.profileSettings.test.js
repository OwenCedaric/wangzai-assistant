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
  loadLogisticsPricingSettings,
  readSavedLogisticsPricingSettings,
  saveLogisticsPricingSettings,
} from './logisticsPricingSettingsRuntime.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('logistics pricing settings canonical SQLite runtime', () => {
  it('loads and saves only through the profile settings namespace', async () => {
    const value = {
      globalSelection: { providerId: 'cel', market: 'RU', serviceLevel: 'standard' },
      shopSelections: {},
      accountSelections: {},
    };
    mocks.getProfileSetting.mockResolvedValue({ setting: { value } });
    const loaded = await loadLogisticsPricingSettings();
    expect(mocks.getProfileSetting).toHaveBeenCalledWith('logistics-pricing-settings', { timeoutMs: 10000 });
    expect(loaded.globalSelection).toMatchObject(value.globalSelection);
    expect(readSavedLogisticsPricingSettings().globalSelection.providerId).toBe('cel');

    mocks.saveProfileSetting.mockResolvedValue({ setting: { value } });
    saveLogisticsPricingSettings(value);
    await vi.waitFor(() => expect(mocks.saveProfileSetting).toHaveBeenCalledWith(
      'logistics-pricing-settings',
      expect.objectContaining({ globalSelection: expect.objectContaining({ providerId: 'cel' }) }),
      { timeoutMs: 30000 }
    ));
  });
});
