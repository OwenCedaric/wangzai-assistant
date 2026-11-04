import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfileSetting: vi.fn(),
  readCrossBorderAccounts: vi.fn(),
  saveProfileSetting: vi.fn(),
}));

vi.mock('../../api/localApiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  getProfileSetting: mocks.getProfileSetting,
  saveProfileSetting: mocks.saveProfileSetting,
}));
vi.mock('../../services/crossBorderAccountClient', async (importOriginal) => ({
  ...(await importOriginal()),
  readCrossBorderAccounts: mocks.readCrossBorderAccounts,
}));

const RETIRED_CROSS_BORDER_KEY = 'wangzai-cross-border-bus-settings';

const alternatePublicAccount = {
  id: 'cross-border-alt',
  name: 'SQLite 跨境授权',
  status: 'active',
  hasUserName: true,
  hasPassword: true,
  hasCompanySecret: true,
  hasAccessToken: true,
  hasAppUid: true,
  authorizationRef: 'server-auth-ref-alt',
  hasServerAuthorization: true,
  defaultStorehouse: 'sqlite-warehouse',
  defaultSection: '',
  defaultService: 'sqlite-service',
};

function profileSetting(value) {
  return { setting: { namespace: 'cross-border-preferences', value } };
}

let crossBorderRuntime;

beforeEach(async () => {
  globalThis.localStorage.clear();
  vi.clearAllMocks();
  vi.resetModules();
  crossBorderRuntime = await import('./ozonRuntime.jsx');
});

afterEach(() => {
  globalThis.localStorage.clear();
});

describe('cross-border preference SQLite boundary', () => {
  it('uses the canonical preference account id before reading its public SQLite account', async () => {
    mocks.getProfileSetting.mockResolvedValue(profileSetting({
      crossBorderAccountId: 'cross-border-alt',
      cooperationWarehouse: 'sqlite-warehouse',
      packageService: 'sqlite-service',
    }));
    mocks.readCrossBorderAccounts.mockResolvedValue({
      rows: [
        { ...alternatePublicAccount, id: 'cross-border-main', defaultStorehouse: 'wrong-main-warehouse' },
        alternatePublicAccount,
      ],
    });

    const settings = await crossBorderRuntime.hydrateCrossBorderSettingsFromLocalApi({});

    expect(settings).toMatchObject({
      crossBorderAccountId: 'cross-border-alt',
      cooperationWarehouse: 'sqlite-warehouse',
      packageService: 'sqlite-service',
      hasCompanySecret: false,
      hasAccessToken: false,
      hasAppUid: false,
      authorizationRef: 'server-auth-ref-alt',
      hasServerAuthorization: true,
    });
    expect(mocks.getProfileSetting).toHaveBeenCalledWith('cross-border-preferences', { timeoutMs: 10000 });
    expect(mocks.readCrossBorderAccounts).toHaveBeenCalledWith({ timeoutMs: 2500 });
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
  });

  it('ignores the retired browser key and returns defaults without manufacturing a canonical profile', async () => {
    globalThis.localStorage.setItem(RETIRED_CROSS_BORDER_KEY, JSON.stringify({
      crossBorderAccountId: 'legacy-account',
      userName: 'legacy-user',
      password: 'legacy-password',
      companySecret: 'legacy-secret',
    }));
    mocks.getProfileSetting.mockResolvedValue({ setting: null });
    mocks.readCrossBorderAccounts.mockResolvedValue({ rows: [] });

    expect(crossBorderRuntime.readSavedCrossBorderSettings({ cooperationWarehouse: 'default-warehouse' }))
      .toMatchObject({ cooperationWarehouse: 'default-warehouse' });

    const settings = await crossBorderRuntime.hydrateCrossBorderSettingsFromLocalApi({
      cooperationWarehouse: 'default-warehouse',
      packageService: 'default-service',
    });

    expect(settings).toMatchObject({
      cooperationWarehouse: 'default-warehouse',
      packageService: 'default-service',
    });
    expect(settings).not.toHaveProperty('userName', 'legacy-user');
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem(RETIRED_CROSS_BORDER_KEY)).not.toBeNull();
  });

  it('persists safe preferences through local-api after a user edit without writing browser storage', async () => {
    const savedPreferences = { cooperationWarehouse: 'edited-warehouse', packageService: 'edited-service' };
    mocks.saveProfileSetting.mockResolvedValue(profileSetting(savedPreferences));
    mocks.getProfileSetting.mockResolvedValue(profileSetting(savedPreferences));
    mocks.readCrossBorderAccounts.mockResolvedValue({ rows: [] });

    const next = crossBorderRuntime.saveCrossBorderSettings({
      userName: 'visible-only-user',
      password: 'visible-only-password',
      companySecret: 'secret',
      cooperationWarehouse: 'edited-warehouse',
      packageService: 'edited-service',
    });
    await vi.waitFor(() => expect(mocks.saveProfileSetting).toHaveBeenCalled());

    expect(next).toMatchObject({ cooperationWarehouse: 'edited-warehouse', packageService: 'edited-service' });
    const persistedValue = mocks.saveProfileSetting.mock.calls[0][1];
    expect(JSON.stringify(persistedValue)).not.toContain('visible-only-user');
    expect(JSON.stringify(persistedValue)).not.toContain('visible-only-password');
    expect(JSON.stringify(persistedValue)).not.toContain('secret');
    expect(globalThis.localStorage.getItem(RETIRED_CROSS_BORDER_KEY)).toBeNull();
  });

  it('keeps a deleted account fenced until an explicit successful rebind releases it', async () => {
    const ownerId = 'cross-border-rebind';
    await crossBorderRuntime.fenceAndDrainCrossBorderSettingsWrites(ownerId);
    expect(() => crossBorderRuntime.saveCrossBorderSettings({
      crossBorderAccountId: ownerId,
      cooperationWarehouse: 'must-not-persist',
    })).toThrow('ACCOUNT_REMOVAL_OWNER_QUIESCED');
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();

    expect(crossBorderRuntime.releaseCrossBorderSettingsWriteFence(ownerId)).toEqual({
      ownerId,
      released: true,
    });
    mocks.saveProfileSetting.mockResolvedValue(profileSetting({
      crossBorderAccountId: ownerId,
      cooperationWarehouse: 'clean-rebind',
    }));
    expect(crossBorderRuntime.saveCrossBorderSettings({
      crossBorderAccountId: ownerId,
      cooperationWarehouse: 'clean-rebind',
    })).toMatchObject({ cooperationWarehouse: 'clean-rebind' });
    await vi.waitFor(() => expect(mocks.saveProfileSetting).toHaveBeenCalledTimes(1));
  });
});
