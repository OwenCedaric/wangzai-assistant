import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), accounts: vi.fn() }));
vi.mock('../../api/localApiClient.js', async original => ({ ...(await original()), getProfileSetting: io.get, saveProfileSetting: io.save }));
vi.mock('../../services/crossBorderAccountClient.js', async original => ({ ...(await original()), readCrossBorderAccounts: io.accounts }));
const preference = id => ({ setting: { value: { crossBorderAccountId: id } } });
const account = (id, ref) => ({ id, name: id, status: 'active', hasServerAuthorization: true, authorizationRef: ref });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let runtime;
beforeEach(async () => {
  vi.resetModules(); Object.values(io).forEach(mock => mock.mockReset());
  runtime = await import('./ozonRuntime.jsx');
});

describe('cross-border settings owner read tickets', () => {
  it('does not finish a barrier until its existing hydration settles and prevents A readback', async () => {
    io.get.mockResolvedValue(preference('account-a'));
    const oldRead = deferred(); io.accounts.mockReturnValue(oldRead.promise);
    const hydration = runtime.hydrateCrossBorderSettingsFromLocalApi({});
    const stale = expect(hydration).rejects.toMatchObject({ code: 'CROSS_BORDER_SETTINGS_READ_SUPERSEDED' });
    await vi.waitFor(() => expect(io.accounts).toHaveBeenCalledTimes(1));
    let drained = false;
    const barrier = runtime.fenceAndDrainCrossBorderSettingsWrites('account-a').then(result => { drained = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(drained).toBe(false);
    oldRead.resolve({ rows: [account('account-a', 'old-ref')] });
    await stale;
    await barrier;
    expect(runtime.countCrossBorderSettingsMemoryReferences('account-a')).toBe(0);
  });
  it('keeps a same-id new authorization when a read started during the fence finishes after release', async () => {
    await runtime.fenceAndDrainCrossBorderSettingsWrites('account-a');
    const oldPreferences = deferred(); io.get.mockReturnValueOnce(oldPreferences.promise).mockResolvedValue(preference('account-a'));
    io.accounts.mockResolvedValue({ rows: [account('account-a', 'new-ref')] });
    io.save.mockImplementation(async (_namespace, value) => ({ setting: { value } }));
    const hydration = runtime.hydrateCrossBorderSettingsFromLocalApi({});
    const stale = expect(hydration).rejects.toMatchObject({ code: 'CROSS_BORDER_SETTINGS_READ_SUPERSEDED' });
    await vi.waitFor(() => expect(io.get).toHaveBeenCalledTimes(1));
    runtime.releaseCrossBorderSettingsWriteFence('account-a');
    runtime.saveCrossBorderSettings({ crossBorderAccountId: 'account-a', hasServerAuthorization: true, authorizationRef: 'new-ref' });
    oldPreferences.resolve(preference('account-a'));
    await stale;
    await runtime.fenceAndDrainCrossBorderSettingsWrites('unrelated-observer');
    expect(runtime.readSavedCrossBorderSettings({}).authorizationRef).toBe('new-ref');
  });
  it('still hydrates unrelated B while A is fenced', async () => {
    await runtime.fenceAndDrainCrossBorderSettingsWrites('account-a');
    io.get.mockResolvedValue(preference('account-b'));
    io.accounts.mockResolvedValue({ rows: [account('account-a', 'old-ref'), account('account-b', 'b-ref')] });
    expect(await runtime.hydrateCrossBorderSettingsFromLocalApi({})).toMatchObject({ crossBorderAccountId: 'account-b', authorizationRef: 'b-ref' });
    expect(runtime.readSavedCrossBorderSettings({}).authorizationRef).toBe('b-ref');
  });
  it('preserves the original preference failure for its caller while the barrier observes settlement', async () => {
    const pending = deferred(); io.get.mockReturnValue(pending.promise);
    const hydration = runtime.hydrateCrossBorderSettingsFromLocalApi({});
    const error = new Error('synthetic preference read failure');
    const failed = expect(hydration).rejects.toBe(error);
    const barrier = runtime.fenceAndDrainCrossBorderSettingsWrites('account-a');
    pending.reject(error);
    await failed;
    expect(await barrier).toMatchObject({ drained: true, failedWrites: 1 });
  });
});
