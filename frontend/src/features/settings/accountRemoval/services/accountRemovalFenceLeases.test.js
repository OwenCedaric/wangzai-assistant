import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountRemovalFenceLeases } from './accountRemovalFenceLeases.js';
import { getAccountRemovalRendererBarrierDiagnostics, prepareAccountRemovalBarrier, releaseAccountRemovalRendererBarrier } from './accountRemovalRuntime.js';
import { configureProductMaterialProfileStore, resetProductMaterialProfileStoreForTest, saveProductMaterialProfileCanonical } from '../../../../services/productMaterialProfileStore.js';
import { getProductListPageCacheKey, writeProductListPageMemoryCache } from '../../../../entities/product/productLocalData.jsx';

const preview = (ownerId, incarnation = 'old') => ({
  owner: { ownerType: 'ozon_shop', ownerId }, previewFingerprint: 'b'.repeat(64),
  ownerGeneration: { ownerId, clientId: `${ownerId}-client`, profileId: 'default', shopIncarnation: incarnation, credentialRevision: 1 },
});
const restore = [];
afterEach(() => { restore.splice(0).forEach(fn => fn()); resetProductMaterialProfileStoreForTest(); });
function syntheticRuntime() {
  const previous = Object.getOwnPropertyDescriptor(window, 'wangzaiDesktop');
  Object.defineProperty(window, 'wangzaiDesktop', { configurable: true, value: {
    recoveryRequest: vi.fn().mockResolvedValue({ ok: true, data: { ok: true } }),
  } });
  restore.push(() => { if (previous) Object.defineProperty(window, 'wangzaiDesktop', previous); else delete window.wangzaiDesktop; });
  resetProductMaterialProfileStoreForTest();
  const save = vi.fn().mockResolvedValue({ ok: true });
  configureProductMaterialProfileStore({ saveProfileToLocalApi: save });
  return save;
}
const material = ownerId => ({ shopId: ownerId, key: `${ownerId}:synthetic-product`, weight: 10 });

describe('account removal renderer fence lease release', () => {
  it('requires proof and does not unlock a newer same-id generation with an old receipt', () => {
    const leases = createAccountRemovalFenceLeases();
    const old = preview('lease-only'), current = preview('lease-only', 'new');
    const release = vi.fn();
    leases.register(old);
    expect(() => leases.release(old, {}, release)).toThrow('FENCE_RELEASE_UNVERIFIED');
    leases.register(current);
    expect(leases.release(old, { verifiedNoOperation: true }, release)).toEqual({ released: false, stale: true });
    expect(release).not.toHaveBeenCalled();
    expect(leases.release(current, { verifiedNoOperation: true }, release).released).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('allows the cancelled owner to save again while keeping a different owner fenced', async () => {
    const save = syntheticRuntime();
    const first = preview('cancelled-a'), second = preview('still-fenced-b');
    await prepareAccountRemovalBarrier(first); await prepareAccountRemovalBarrier(second);
    await expect(saveProductMaterialProfileCanonical(material(first.owner.ownerId))).rejects.toThrow('OWNER_QUIESCED');
    expect(releaseAccountRemovalRendererBarrier(first, { verifiedNoOperation: true }).released).toBe(true);
    await expect(saveProductMaterialProfileCanonical(material(first.owner.ownerId))).resolves.toMatchObject({ weight: 10 });
    await expect(saveProductMaterialProfileCanonical(material(second.owner.ownerId))).rejects.toThrow('OWNER_QUIESCED');
    expect(save).toHaveBeenCalledTimes(1);
    releaseAccountRemovalRendererBarrier(second, { verifiedNoOperation: true });
  });
  it('keeps writes blocked for unknown outcomes and does not release a newer real store fence', async () => {
    syntheticRuntime();
    const old = preview('reused-account'), current = preview('reused-account', 'new');
    await prepareAccountRemovalBarrier(old);
    expect(() => releaseAccountRemovalRendererBarrier(old, {})).toThrow('FENCE_RELEASE_UNVERIFIED');
    await prepareAccountRemovalBarrier(current);
    expect(releaseAccountRemovalRendererBarrier(old, { verifiedNoOperation: true }).released).toBe(false);
    await expect(saveProductMaterialProfileCanonical(material(current.owner.ownerId))).rejects.toThrow('OWNER_QUIESCED');
    releaseAccountRemovalRendererBarrier(current, { verifiedNoOperation: true });
    await expect(saveProductMaterialProfileCanonical(material(current.owner.ownerId))).resolves.toMatchObject({ weight: 10 });
  });
  it('keeps the completed incarnation cache tombstone while allowing a new generation cache key', async () => {
    syntheticRuntime();
    const old = preview('completed-cache-owner');
    const shop = { id: old.owner.ownerId, ...old.ownerGeneration };
    await prepareAccountRemovalBarrier(old);
    expect(releaseAccountRemovalRendererBarrier(old, { completed: true }).released).toBe(true);
    expect(writeProductListPageMemoryCache(getProductListPageCacheKey(shop, '全部商品', 20, 1), [{ id: 'late-old' }])).toBe(false);
    expect(writeProductListPageMemoryCache(getProductListPageCacheKey({ ...shop, shopIncarnation: 'new' }, '全部商品', 20, 1), [{ id: 'new' }])).toBe(true);
  });
  it('records a historical save failure while allowing the now-settled barrier to finish', async () => {
    const save = syntheticRuntime();
    const target = preview('settled-failed-owner');
    const reason = new Error('synthetic rejected material save');
    save.mockRejectedValueOnce(reason);
    const write = saveProductMaterialProfileCanonical(material(target.owner.ownerId));
    await expect(write).rejects.toBe(reason);
    const proof = await prepareAccountRemovalBarrier(target);
    expect(Object.keys(proof).sort()).toEqual(['version', 'owner', 'previewFingerprint', 'fencedResourceIds', 'drainedResourceIds'].sort());
    expect(getAccountRemovalRendererBarrierDiagnostics(target)).toEqual({ failedWrites: 1, lastWriteFailed: true });
    await expect(write).rejects.toBe(reason);
    expect(save).toHaveBeenCalledTimes(1);
    releaseAccountRemovalRendererBarrier(target, { verifiedNoOperation: true });
  });
  it('does not finish deletion preparation while another owner still has a real pending global write', async () => {
    const save = syntheticRuntime();
    let finish;
    save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const write = saveProductMaterialProfileCanonical(material('other-pending-owner'));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const target = preview('pending-delete-owner');
    let ready = false;
    const barrier = prepareAccountRemovalBarrier(target).then(result => { ready = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(ready).toBe(false);
    await expect(saveProductMaterialProfileCanonical(material(target.owner.ownerId))).rejects.toThrow('OWNER_QUIESCED');
    expect(ready).toBe(false);
    finish({ ok: true });
    await write; await barrier;
    expect(ready).toBe(true);
    expect(getAccountRemovalRendererBarrierDiagnostics(target).failedWrites).toBe(0);
    releaseAccountRemovalRendererBarrier(target, { verifiedNoOperation: true });
  });
});
