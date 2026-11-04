import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createShopAggregateIndex } from './shopAggregateIndex.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function contract({ shopId, incarnation, scopeDigest, revision = 1, payloadHash = HASH_C } = {}) {
  return {
    scopeToken: { profileId: 'profile-a', shopId, shopIncarnation: incarnation },
    layout: {
      profileId: 'profile-a',
      shopId,
      shopIncarnation: incarnation,
      scopeDigest,
    },
    domain: 'orders',
    queryHash: HASH_A,
    contractKey: `orders:${HASH_A}`,
    payloadHash,
    revision,
    committedAt: `2026-09-03T11:00:0${revision}.000Z`,
  };
}

test('aggregate index stores only lightweight pointers and keeps shops independent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-aggregate-index-'));
  const databasePath = path.join(root, 'shop-aggregate-index.sqlite');
  const index = createShopAggregateIndex({ databasePath, profileId: 'profile-a' });
  try {
    index.record(contract({ shopId: 'shop-a', incarnation: 'inc-a', scopeDigest: HASH_A }));
    index.record(contract({ shopId: 'shop-b', incarnation: 'inc-b', scopeDigest: HASH_B }));
    assert.deepEqual(index.list({ shopId: 'shop-a' }).map((row) => row.shopId), ['shop-a']);
    assert.deepEqual(index.list({ shopId: 'shop-b' }).map((row) => row.shopId), ['shop-b']);
    assert.equal(index.snapshot().shops, 2);
    assert.equal(index.snapshot().entries, 2);
    assert.equal(index.getScopeContract({ scopeDigest: HASH_A }, `orders:${HASH_A}`).shopId, 'shop-a');
    assert.equal(index.getScopeContract({ scopeDigest: HASH_A }, `orders:${HASH_B}`), null);
    assert.equal('payload' in index.list()[0], false);
    assert.equal('payloadJson' in index.list()[0], false);
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('aggregate index rejects stale revisions and removes only the exact shop scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-aggregate-revision-'));
  const index = createShopAggregateIndex({
    databasePath: path.join(root, 'shop-aggregate-index.sqlite'),
    profileId: 'profile-a',
  });
  try {
    const newer = contract({
      shopId: 'shop-a', incarnation: 'inc-a', scopeDigest: HASH_A, revision: 2, payloadHash: HASH_B,
    });
    assert.equal(index.record(newer).accepted, true);
    assert.equal(index.record({ ...newer, revision: 1, payloadHash: HASH_C }).accepted, false);
    assert.equal(index.list({ shopId: 'shop-a' })[0].payloadHash, HASH_B);
    index.record({
      ...newer,
      domain: 'products',
      contractKey: `products:${HASH_A}`,
    });
    assert.equal(index.removeDomain({ scopeDigest: HASH_A }, 'orders').removed, 1);
    assert.equal(index.getScopeContract({ scopeDigest: HASH_A }, `orders:${HASH_A}`), null);
    assert.equal(index.getScopeContract({ scopeDigest: HASH_A }, `products:${HASH_A}`).domain, 'products');
    index.record(contract({ shopId: 'shop-b', incarnation: 'inc-b', scopeDigest: HASH_B }));
    assert.equal(index.removeScope({ scopeDigest: HASH_A }).removed, 1);
    assert.deepEqual(index.list().map((row) => row.shopId), ['shop-b']);
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('aggregate index fails closed when a file belongs to another profile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-aggregate-profile-'));
  const databasePath = path.join(root, 'shop-aggregate-index.sqlite');
  const first = createShopAggregateIndex({ databasePath, profileId: 'profile-a' });
  first.close();
  try {
    assert.throws(
      () => createShopAggregateIndex({ databasePath, profileId: 'profile-b' }),
      { code: 'SHOP_AGGREGATE_INDEX_SCOPE_MISMATCH' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
