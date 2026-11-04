import assert from 'node:assert/strict';
import test from 'node:test';

import { createShopLicenseGrantRegistry } from './shopLicenseGrantRegistry.js';

test('accepts only exact active Client IDs and expires grants without a refresh', () => {
  let now = Date.parse('2026-08-05T00:00:00.000Z');
  const registry = createShopLicenseGrantRegistry({ now: () => now });
  registry.replace([
    { clientId: 'ozon-client-active', expireAt: '2026-08-05T00:01:00.000Z' },
  ]);

  assert.equal(registry.assertActive('ozon-client-active').authorized, true);
  assert.throws(
    () => registry.assertActive('ozon-client-active-suffix'),
    (error) => error?.code === 'SHOP_LICENSE_REQUIRED',
  );

  now = Date.parse('2026-08-05T00:01:00.000Z');
  assert.throws(
    () => registry.assertActive('ozon-client-active'),
    (error) => error?.code === 'SHOP_LICENSE_REQUIRED',
  );
});

test('replaces grants atomically and rejects malformed records', () => {
  const registry = createShopLicenseGrantRegistry({
    now: () => Date.parse('2026-08-05T00:00:00.000Z'),
  });
  registry.replace([
    { clientId: 'preserved-client', expireAt: '2026-08-06T00:00:00.000Z' },
  ]);

  assert.throws(
    () => registry.replace([{ clientId: '', expireAt: 'not-a-date' }]),
    (error) => error?.code === 'SHOP_LICENSE_GRANT_INVALID',
  );
  assert.equal(registry.assertActive('preserved-client').authorized, true);
});

test('keeps more than one hundred shop grants isolated by exact Client ID', () => {
  const registry = createShopLicenseGrantRegistry({
    now: () => Date.parse('2026-08-05T00:00:00.000Z'),
  });
  const grants = Array.from({ length: 120 }, (_, index) => ({
    clientId: `ozon-client-${index}`,
    expireAt: '2026-08-06T00:00:00.000Z',
  }));
  assert.equal(registry.replace(grants).activeGrantCount, 120);

  for (let index = 0; index < 120; index += 1) {
    assert.equal(registry.assertActive(`ozon-client-${index}`).authorized, true);
    assert.throws(
      () => registry.assertActive(`ozon-client-${index}-forged`),
      (error) => error?.code === 'SHOP_LICENSE_REQUIRED',
    );
  }
});
