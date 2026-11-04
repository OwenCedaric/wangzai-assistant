import { describe, expect, it, vi } from 'vitest';
import { createStableLegacyDigest, readEveryCursorPage } from './legacyCursorReadback.js';

describe('legacy cursor readback', () => {
  it('reads every declared page and preserves the complete public DTO order for caller-level scope checks', async () => {
    const readPage = vi.fn(async ({ cursor }) => {
      if (!cursor) return { rows: [{ id: 'a' }, { id: 'b' }], total: 5, hasMore: true, nextCursor: '2' };
      if (cursor === '2') return { rows: [{ id: 'c' }, { id: 'd' }], total: 5, hasMore: true, nextCursor: '4' };
      return { rows: [{ id: 'e' }], total: 5, hasMore: false, nextCursor: '' };
    });

    const result = await readEveryCursorPage(readPage, { pageSize: 2 });

    expect(result).toMatchObject({ complete: true, total: 5, pageCount: 3, pageLimitReached: false });
    expect(result.rows.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(readPage).toHaveBeenNthCalledWith(1, { cursor: '', limit: 2, cursorMode: 'legacy-migration' });
  });

  it.each([
    ['missing total', { rows: [], hasMore: false, nextCursor: '' }, 'CURSOR_PAGE_SHAPE_INVALID'],
    ['incomplete final page', { rows: [{ id: 'a' }], total: 2, hasMore: false, nextCursor: '' }, 'CURSOR_PAGE_INCOMPLETE'],
    ['has-more missing cursor', { rows: [{ id: 'a' }], total: 2, hasMore: true, nextCursor: '' }, 'CURSOR_NEXT_CURSOR_INVALID'],
  ])('fails closed on %s', async (_label, payload, reason) => {
    const result = await readEveryCursorPage(vi.fn(async () => payload));
    expect(result).toMatchObject({ complete: false, rows: [], reason, pageLimitReached: false });
  });

  it('fails closed on a repeated cursor and on the configured page limit', async () => {
    const repeated = await readEveryCursorPage(
      vi.fn(async () => ({ rows: [{ id: 'a' }], total: 3, hasMore: true, nextCursor: 'again' }))
    );
    const limited = await readEveryCursorPage(
      vi.fn(async ({ cursor }) => ({ rows: [{ id: cursor || 'a' }], total: 3, hasMore: true, nextCursor: cursor ? `${cursor}-next` : 'next' })),
      { maxPages: 1 }
    );

    expect(repeated).toMatchObject({ complete: false, reason: 'CURSOR_NEXT_CURSOR_INVALID', pageCount: 2 });
    expect(limited).toMatchObject({ complete: false, reason: 'CURSOR_PAGE_LIMIT_REACHED', pageLimitReached: true, pageCount: 1 });
  });

  it('creates a stable digest independent of object key insertion order', () => {
    const left = { id: 'scope-a', flags: { hasSecret: true, hasToken: false }, values: ['a', { z: 1, y: 2 }] };
    const right = { values: ['a', { y: 2, z: 1 }], flags: { hasToken: false, hasSecret: true }, id: 'scope-a' };

    expect(createStableLegacyDigest(left)).toBe(createStableLegacyDigest(right));
  });
});
