import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn(), read: vi.fn(), save: vi.fn(), bulk: vi.fn() }));
vi.mock('../entities/product/productLocalData.jsx', () => ({ readLocalDataFile: io.readFile, writeLocalDataFile: io.writeFile }));
vi.mock('./purchaseOrderOverrideClient.js', () => ({
  readPurchaseOverrides: io.read, savePurchaseOverride: io.save, importLegacyPurchaseOverrides: io.bulk,
  removePurchaseOverride: vi.fn(), toPurchaseOverridePayload: (owner, patch) => ({ ...owner, ...patch }),
}));
const page = rows => ({ ok: true, rows, total: rows.length, hasMore: false, nextCursor: '' });
const row = (shopId, orderKey, cost = 10) => ({ shopId, orderKey, manualPurchasePriceValue: cost, updatedAt: '2026-09-01T00:00:00Z' });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let runtime;
beforeEach(async () => {
  vi.resetModules(); Object.values(io).forEach(mock => mock.mockReset());
  io.readFile.mockResolvedValue({}); io.writeFile.mockResolvedValue({}); io.save.mockResolvedValue({ ok: true });
  runtime = await import('./purchaseOrderRuntime.js');
});

describe('purchase override owner read tickets', () => {
  it('waits for the whole old hydration and excludes A while still returning B', async () => {
    const oldRead = deferred(); io.read.mockReturnValueOnce(oldRead.promise);
    const hydration = runtime.hydratePurchaseOrderLocalOverridesFromLocalFile();
    let drained = false;
    const barrier = runtime.fenceAndDrainPurchaseOrderOverrideWrites('shop-a').then(result => { drained = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(drained).toBe(false);
    oldRead.resolve(page([row('shop-a', 'a'), row('shop-b', 'b')]));
    expect(Object.values(await hydration).map(value => value.shopId)).toEqual(['shop-b']);
    await barrier;
    expect(runtime.countPurchaseOrderOverrideMemoryForShop('shop-a')).toBe(0);
    expect(runtime.countPurchaseOrderOverrideMemoryForShop('shop-b')).toBe(1);
  });
  it('does not revive A from a hydration begun while fenced, overwrite rebound A, or rewrite the old file', async () => {
    await runtime.fenceAndDrainPurchaseOrderOverrideWrites('shop-a');
    const a = row('shop-a', 'a-old'), b = row('shop-b', 'b');
    io.readFile.mockResolvedValue({ 'a-old': a, b });
    const oldRead = deferred(); io.read.mockReturnValueOnce(oldRead.promise).mockResolvedValue(page([b]));
    const hydration = runtime.hydratePurchaseOrderLocalOverridesFromLocalFile();
    await vi.waitFor(() => expect(io.read).toHaveBeenCalledTimes(1));
    runtime.removePurchaseOrderOverrideMemoryForShop('shop-a');
    runtime.releasePurchaseOrderOverrideOwnerFence('shop-a');
    await runtime.savePurchaseOrderLocalOverrides({ 'a-new': row('shop-a', 'a-new', 55) }, { persistLocalApi: false });
    oldRead.resolve(page([a]));
    expect(Object.values(await hydration).map(value => value.shopId)).toEqual(['shop-b']);
    const current = Object.values(runtime.readPurchaseOrderLocalOverrides());
    expect(current.find(value => value.shopId === 'shop-a')).toMatchObject({ orderKey: 'a-new', manualPurchasePriceValue: 55 });
    expect(current.some(value => value.shopId === 'shop-b')).toBe(true);
    expect(io.save.mock.calls.every(([owner]) => owner.shopId === 'shop-b')).toBe(true);
    expect(io.save).toHaveBeenCalledTimes(1);
    expect(io.writeFile).not.toHaveBeenCalled();
  });
  it('tracks direct canonical reads too and leaves the original failure observable', async () => {
    const oldRead = deferred(); io.read.mockReturnValue(oldRead.promise);
    const reading = runtime.readPurchaseOrderOverridesFromLocalApi();
    const error = new Error('synthetic canonical read failure');
    const failed = expect(reading).rejects.toMatchObject({ code: 'PURCHASE_OVERRIDE_CURSOR_READBACK_INCOMPLETE', readback: { error } });
    const barrier = runtime.fenceAndDrainPurchaseOrderOverrideWrites('shop-a');
    oldRead.reject(error);
    await failed;
    expect(await barrier).toMatchObject({ drained: true, failedWrites: 1 });
  });
});
