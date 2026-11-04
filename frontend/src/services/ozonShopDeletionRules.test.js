import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();

describe('ozon shop deletion rules', () => {
  it('allows deleting the last Ozon shop and replaces it with a blank local entry', () => {
    const removeStart = appSource.indexOf('const removeOzonShop = (shopId) =>');
    const removeEnd = appSource.indexOf('const testOzonShopConnection = async', removeStart);
    const removeSource = appSource.slice(removeStart, removeEnd);
    const dialogStart = appSource.indexOf('function ShopSettingsDialog');
    const dialogEnd = appSource.indexOf('export { ShopSettingsDialog', dialogStart);
    const dialogSource = appSource.slice(dialogStart, dialogEnd);

    expect(removeSource).not.toContain('if (current.length <= 1) return current;');
    expect(removeSource).toContain('const remaining = current.filter((shop) => shop.id !== normalizedShopId);');
    expect(removeSource).toContain('remaining.length > 0 ? remaining : [createEmptyOzonShop(replacementId, 1)]');
    expect(removeSource).toContain("accountRemoval.deleteAccountDirectly({ ownerType: 'ozon_shop', ownerId: normalizedShopId }");
    expect(removeSource).not.toContain('accountRemoval.openAccountRemoval(');
    expect(removeSource).not.toContain('hasPersistedOzonShopAccount(normalizedShopId)');
    expect(removeSource).toContain('beforePreview: () => drainOzonShopSettingsWrites()');
    expect(removeSource).toContain('removeOzonShopSettingsMemorySlice(normalizedShopId);');
    expect(removeSource).toContain('onCompleted: removeFromView');
    expect(removeSource).toContain('onMissing: () => {');
    expect(removeSource).not.toContain('deleteLocalShop(normalizedShopId');
    expect(dialogSource).not.toContain('disabled={shops.length <= 1}');
  });
});
