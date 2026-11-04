import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureProductMaterialProfileStore, fenceAndDrainProductMaterialProfileWrites,
  hydrateProductMaterialProfilesFromLocalFile, readProductMaterialProfiles,
  releaseProductMaterialProfileOwnerFence, removeProductMaterialProfilesForShop,
  resetProductMaterialProfileStoreForTest, saveProductMaterialProfiles,
} from './productMaterialProfileStore.js';

const oldA = { shopId: 'read-race-a', key: 'read-race-a:p', weight: 10 };
const keptB = { shopId: 'read-race-b', key: 'read-race-b:p', weight: 20 };
const map = (...rows) => Object.fromEntries(rows.map(row => [row.key, row]));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => resetProductMaterialProfileStoreForTest());

describe('material hydration during account removal', () => {
  it('drains an older global hydration and excludes its deleted owner from memory, migration and file clearing', async () => {
    const delayed = deferred();
    const read = vi.fn(() => delayed.promise);
    const save = vi.fn(async () => ({ ok: true }));
    const importProfiles = vi.fn(async () => ({ ok: true, importedCount: 0 }));
    const clearFile = vi.fn(async () => undefined);
    configureProductMaterialProfileStore({ readLocalDataFile: async () => map(oldA), readProfilesFromLocalApi: read,
      saveProfileToLocalApi: save, importProfilesToLocalApi: importProfiles, writeLocalDataFile: clearFile });
    const hydration = hydrateProductMaterialProfilesFromLocalFile();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    let drained = false;
    const barrier = fenceAndDrainProductMaterialProfileWrites(oldA.shopId).then(result => { drained = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(drained).toBe(false);
    delayed.resolve(map(oldA, keptB));
    expect(await hydration).toEqual(map(keptB));
    expect((await barrier).drained).toBe(true);
    expect(readProductMaterialProfiles()).toEqual(map(keptB));
    expect(save).not.toHaveBeenCalled();
    expect(importProfiles).not.toHaveBeenCalled();
    expect(clearFile).not.toHaveBeenCalled();
    removeProductMaterialProfilesForShop(oldA.shopId);
    releaseProductMaterialProfileOwnerFence(oldA.shopId);
    expect(readProductMaterialProfiles()).toEqual(map(keptB));
  });

  it('a read started while fenced cannot revive or erase the rebound owner after release', async () => {
    const delayed = deferred();
    const read = vi.fn(() => delayed.promise);
    const save = vi.fn(async () => ({ ok: true }));
    const clearFile = vi.fn(async () => undefined);
    configureProductMaterialProfileStore({ readLocalDataFile: async () => map(oldA), readProfilesFromLocalApi: read,
      saveProfileToLocalApi: save, writeLocalDataFile: clearFile });
    await fenceAndDrainProductMaterialProfileWrites(oldA.shopId);
    const hydration = hydrateProductMaterialProfilesFromLocalFile();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    releaseProductMaterialProfileOwnerFence(oldA.shopId);
    const rebound = { ...oldA, weight: 999 };
    saveProductMaterialProfiles(map(rebound));
    delayed.resolve(map(oldA, keptB));
    expect(await hydration).toEqual(map(keptB));
    expect(readProductMaterialProfiles()).toEqual(map(rebound, keptB));
    expect(save).not.toHaveBeenCalled();
    expect(clearFile).not.toHaveBeenCalled();
    configureProductMaterialProfileStore({ readLocalDataFile: async () => ({}), readProfilesFromLocalApi: async () => map(rebound, keptB) });
    expect(await hydrateProductMaterialProfilesFromLocalFile()).toEqual(map(rebound, keptB));
  });
});
