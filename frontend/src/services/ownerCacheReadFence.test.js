import { describe, expect, it } from 'vitest';
import { createOwnerCacheReadFence } from './ownerCacheReadFence.js';

describe('owner cache in-flight read tickets', () => {
  it('invalidates exact owner/client aliases without an epoch shared with B', () => {
    const reads = createOwnerCacheReadFence();
    const a = reads.capture(['shop-a', 'client-a', 'shop-a']);
    const b = reads.capture(['shop-b', 'client-b']);
    const prefixNeighbor = reads.capture(['shop-a:neighbor']);
    expect(reads.snapshot()).toEqual({ activeReads: 3, indexedIdentifiers: 5 });
    expect(reads.invalidate(['client-a', 'shop-a']).invalidatedReads).toBe(1);
    expect(a.current).toBe(false);
    expect(b.current).toBe(true);
    expect(prefixNeighbor.current).toBe(true);
    expect(reads.snapshot()).toEqual({ activeReads: 2, indexedIdentifiers: 3 });
    b.finish(); prefixNeighbor.finish();
    expect(reads.snapshot()).toEqual({ activeReads: 0, indexedIdentifiers: 0 });
  });

  it('same-ID new reads never revive an invalidated ticket and completion retains no raw identifier index', () => {
    const reads = createOwnerCacheReadFence();
    const oldRead = reads.capture(['shop-a', 'client-a']);
    reads.invalidate(['shop-a']);
    expect(reads.snapshot()).toEqual({ activeReads: 0, indexedIdentifiers: 0 });
    const nextRead = reads.capture(['shop-a', 'client-a']);
    oldRead.finish(); oldRead.finish();
    expect(oldRead.current).toBe(false);
    expect(nextRead.current).toBe(true);
    expect(reads.snapshot()).toEqual({ activeReads: 1, indexedIdentifiers: 2 });
    nextRead.finish();
    expect(reads.snapshot()).toEqual({ activeReads: 0, indexedIdentifiers: 0 });
  });

  it('client-ID invalidation removes only the cache entry owned by its ticket', () => {
    const reads = createOwnerCacheReadFence();
    const a = reads.capture(['shop-a', 'client-a']);
    const b = reads.capture(['shop-b', 'client-b']);
    const cache = new Map([['shop-a-key', { readTicket: a }], ['shop-b-key', { readTicket: b }]]);
    expect(reads.invalidate(['client-a'], cache)).toEqual({ invalidatedReads: 1, removedCacheEntries: 1 });
    expect([...cache.keys()]).toEqual(['shop-b-key']);
    b.finish();
  });

  it('unknown fences do not create tombstones and empty read scope fails closed', () => {
    const reads = createOwnerCacheReadFence();
    expect(reads.invalidate(['unknown-owner'])).toEqual({ invalidatedReads: 0, removedCacheEntries: 0 });
    expect(reads.snapshot()).toEqual({ activeReads: 0, indexedIdentifiers: 0 });
    expect(() => reads.capture([])).toThrow('OWNER_CACHE_READ_SCOPE_REQUIRED');
  });
});
