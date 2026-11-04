import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadCollectionPricingDraft,
  saveCollectionPricingDraft,
} from './collectionPricingDraftStore.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

describe('collection pricing draft store', () => {
  it('loads the persisted collection list', async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { schemaVersion: 2, savedAt: '2026-08-03T00:00:00.000Z', items: [{ id: '1688:1', title: '商品' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(loadCollectionPricingDraft('user@example.com')).resolves.toEqual([{ id: '1688:1', title: '商品' }]);
    expect(fetch.mock.calls[0][0]).toBe('/collection-pricing-draft-api?scope=user%40example.com');
  });

  it('persists an empty list after manual deletion or clear', async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { itemCount: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await saveCollectionPricingDraft([], 'user@example.com');
    const [, options] = fetch.mock.calls[0];
    expect(fetch.mock.calls[0][0]).toBe('/collection-pricing-draft-api?scope=user%40example.com');
    expect(JSON.parse(options.body)).toMatchObject({ schemaVersion: 2, items: [] });
  });

  it('supports a large working list while enforcing the 500-item boundary', async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { itemCount: 500 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await saveCollectionPricingDraft(Array.from({ length: 520 }, (_, index) => ({ id: `1688:${index}` })), 'bulk-user');
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload.items).toHaveLength(500);
  });
});
