import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRetiredMarketingActivityCacheFile,
  isBlockedLegacyLocalDataFileKey,
  readLocalDataFile,
  readRetiredMarketingActivityCacheFile,
  readRetiredPurchasePluginContextFile,
  writeLocalDataFile,
  writeRetiredPurchasePluginContextMarker,
} from './localDataFileClient.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('retired purchase plugin local-data boundary', () => {
  it('blocks retired plugin and marketing cache keys from the generic local-data client', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(isBlockedLegacyLocalDataFileKey('purchase-source-plugin-context')).toBe(true);
    expect(isBlockedLegacyLocalDataFileKey('marketing-activity-cache')).toBe(true);
    [
      'ozon-local-data-layer',
      'profit-local-cache',
      'after-sales-display-snapshots',
      'local-mirror-read-log',
      'local-mirror-retry-queue',
      'ozon-shop-settings',
      'sales-source-links',
      'product-material-profiles',
      'product-source-links',
      'purchase-source-links',
      'purchase-order-local-overrides',
      'cross-border-bus-order-records',
      'browser-local-storage',
    ].forEach((key) => expect(isBlockedLegacyLocalDataFileKey(key)).toBe(true));
    await expect(writeLocalDataFile('purchase-source-plugin-context', { context: { offerId: 'no-runtime-json' } }))
      .resolves.toEqual({});
    await expect(readLocalDataFile('marketing-activity-cache')).resolves.toEqual({});
    await expect(writeLocalDataFile('marketing-activity-cache', { replacement: 'must-not-write' })).resolves.toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the fixed migration route and accepts only its fixed marker shape', async () => {
    const marker = {
      migration: 'profile-settings',
      namespace: 'purchase-plugin-context',
      migratedAt: '2026-07-13T00:00:00.000Z',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { context: { offerId: 'legacy-only' } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }));

    await expect(readRetiredPurchasePluginContextFile()).resolves.toEqual({ context: { offerId: 'legacy-only' } });
    await expect(writeRetiredPurchasePluginContextMarker('purchase-source-plugin-context', marker)).resolves.toBe(true);
    expect(fetchSpy.mock.calls[0][0]).toBe('/legacy-migration-api/purchase-source-plugin-context');
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({ method: 'PUT' });
    await expect(writeRetiredPurchasePluginContextMarker('purchase-source-plugin-context', { context: {} }))
      .rejects.toThrow('marker is invalid');
  });

  it('uses only the fixed marketing migration route with opaque revision and conditional delete', async () => {
    const revision = 'a'.repeat(64);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, data: { 'shop-1': { activityRows: [] } }, revision, exists: true }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, data: {}, revision: 'b'.repeat(64), exists: false }), {
          status: 200,
        })
      );

    await expect(readRetiredMarketingActivityCacheFile()).resolves.toEqual({
      data: { 'shop-1': { activityRows: [] } },
      revision,
      exists: true,
    });
    await expect(clearRetiredMarketingActivityCacheFile('marketing-activity-cache', revision)).resolves.toBe(true);

    expect(fetchSpy.mock.calls[0][0]).toBe('/legacy-migration-api/marketing-activity-cache');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'GET' });
    expect(fetchSpy.mock.calls[1][0]).toBe('/legacy-migration-api/marketing-activity-cache');
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ expectedRevision: revision });
    await expect(clearRetiredMarketingActivityCacheFile('marketing-activity-cache', 'invalid')).rejects.toThrow(
      'expected revision is invalid'
    );
  });

  it('surfaces a conditional cleanup conflict without retrying or replacing the legacy aggregate', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, code: 'LEGACY_SOURCE_CHANGED', message: 'changed' }),
        { status: 409 }
      )
    );

    await expect(clearRetiredMarketingActivityCacheFile('marketing-activity-cache', 'c'.repeat(64))).rejects.toMatchObject({
      code: 'LEGACY_SOURCE_CHANGED',
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
