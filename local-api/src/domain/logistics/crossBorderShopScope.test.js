import assert from 'node:assert/strict';
import test from 'node:test';
import { createCrossBorderAccountRepository } from '../../db/repositories/crossBorderAccountRepository.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';
import { createCrossBorderReadService } from './crossBorderReadService.js';
import { createCrossBorderConfirmedWriteExecutor } from './crossBorderWriteGuardService.js';

function createFixture() {
  const db = createMigratedTestDb();
  const scope = { tenantId: 'tenant-multi', userId: 'user-multi', profileId: 'profile-multi' };
  const shops = createShopRepository(db, scope);
  const shopA = saveUnitShop(shops, 'shop-a');
  const shopB = saveUnitShop(shops, 'shop-b');
  const accounts = createCrossBorderAccountRepository(db, scope);
  accounts.saveAccount({
    id: 'bus-a',
    name: '巴士 A',
    status: 'active',
    accessToken: 'token-a',
    appUid: 'uid-a',
    companySecret: 'secret-a',
    shopIds: [shopA],
  });
  accounts.saveAccount({
    id: 'bus-both',
    name: '巴士双店',
    status: 'active',
    accessToken: 'token-both',
    appUid: 'uid-both',
    companySecret: 'secret-both',
    shopIds: [shopA, shopB],
  });
  return { db, scope, shopA, shopB };
}

test('cross-border reads persist only under the account-bound internal shop id', async () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'cross-border-scope-test-secret';
  const fixture = createFixture();
  const calls = [];
  try {
    const service = createCrossBorderReadService({
      db: fixture.db,
      ...fixture.scope,
      crossBorderClient: {
        async requestReadOnly(input) {
          calls.push(input);
          return { data: { list: [{ id: 'bus-order-a', platform_order: 'posting-a' }] } };
        },
      },
    });
    const result = await service.requestReadOnly({
      endpointKey: 'order.search',
      accountId: 'bus-a',
      shopId: fixture.shopA,
      body: { platform_order: 'posting-a' },
    });
    assert.equal(result.shopId, fixture.shopA);
    assert.equal(result.cachedRecordCount, 1);
    assert.equal(calls.length, 1);
    const stored = fixture.db.prepare(`
      SELECT shop_id, platform_order FROM cross_border_order_records WHERE shop_id = ?
    `).get(fixture.shopA);
    assert.deepEqual({ ...stored }, { shop_id: fixture.shopA, platform_order: 'posting-a' });

    await assert.rejects(
      service.requestReadOnly({
        endpointKey: 'order.search',
        accountId: 'bus-a',
        shopId: fixture.shopB,
        body: { platform_order: 'posting-b' },
      }),
      (error) => error?.code === 'CROSS_BORDER_ACCOUNT_SHOP_MISMATCH',
    );
    assert.equal(calls.length, 1);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM cross_border_order_records WHERE shop_id = ?')
      .get(fixture.shopB).count, 0);
  } finally {
    fixture.db.close();
    if (previousSecret == null) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});

test('cross-border multi-shop reads require an explicit internal shop id', async () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'cross-border-scope-test-secret';
  const fixture = createFixture();
  try {
    const service = createCrossBorderReadService({
      db: fixture.db,
      ...fixture.scope,
      crossBorderClient: { requestReadOnly: async () => ({ data: { list: [] } }) },
    });
    await assert.rejects(
      service.requestReadOnly({ endpointKey: 'order.search', accountId: 'bus-both', body: {} }),
      (error) => error?.code === 'CROSS_BORDER_SHOP_ID_REQUIRED',
    );
  } finally {
    fixture.db.close();
    if (previousSecret == null) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});

test('cross-border confirmed writes reject account/shop mismatch and preview scope substitution', async () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'cross-border-scope-test-secret';
  const fixture = createFixture();
  const writes = [];
  try {
    const execute = createCrossBorderConfirmedWriteExecutor({
      db: fixture.db,
      ...fixture.scope,
      crossBorderClient: {
        async requestWrite(input) {
          writes.push(input);
          return { data: { accepted: true } };
        },
      },
    });
    await assert.rejects(
      execute({
        preview: { accountId: 'bus-a', shopId: fixture.shopA, endpointKey: 'order.create' },
        input: { accountId: 'bus-a', shopId: fixture.shopB, endpointKey: 'order.create', payload: {} },
      }),
      (error) => error?.code === 'CROSS_BORDER_ACCOUNT_SHOP_MISMATCH',
    );
    await assert.rejects(
      execute({
        preview: { accountId: 'bus-a', shopId: fixture.shopA, endpointKey: 'order.create' },
        input: { accountId: 'bus-both', shopId: fixture.shopA, endpointKey: 'order.create', payload: {} },
      }),
      (error) => error?.code === 'CROSS_BORDER_WRITE_SCOPE_MISMATCH',
    );
    const result = await execute({
      preview: { accountId: 'bus-a', shopId: fixture.shopA, endpointKey: 'order.create' },
      input: { accountId: 'bus-a', shopId: fixture.shopA, endpointKey: 'order.create', payload: { order: 1 } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.shopId, fixture.shopA);
    assert.equal(writes.length, 1);
  } finally {
    fixture.db.close();
    if (previousSecret == null) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});
