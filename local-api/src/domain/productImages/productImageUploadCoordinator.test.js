import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductImageUploadCoordinator } from './productImageUploadCoordinator.js';

test('limits each owner independently while allowing multiple tenants to progress', async () => {
  let active = 0;
  let maximum = 0;
  const coordinator = createProductImageUploadCoordinator({
    repository: { getUsageSummary: () => ({ day: {}, retained: {} }) },
    config: { maxConcurrent: 3, maxConcurrentPerOwner: 1 },
  });
  const tenants = ['a', 'a', 'a', 'b', 'b', 'c'];
  await Promise.all(tenants.map((tenantId, index) => coordinator.run({
    scope: { tenantId, userId: `user-${tenantId}` },
    bytes: 10,
    execute: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5 + (index % 2)));
      active -= 1;
    },
  })));
  assert.equal(maximum, 3);
  assert.equal(coordinator.getStatus().active, 0);
});

test('checks daily count and bytes before queueing', async () => {
  const coordinator = createProductImageUploadCoordinator({
    repository: { getUsageSummary: () => ({ day: { uploads: 2, upload_bytes: 100 }, retained: { bytes: 100 } }) },
    config: { maxDailyUploads: 2, maxDailyBytes: 200, maxRetainedBytes: 200 },
  });
  await assert.rejects(coordinator.run({
    scope: { tenantId: 'tenant-a', userId: 'user-a' }, bytes: 1, execute: async () => undefined,
  }), (error) => error.code === 'PRODUCT_IMAGE_DAILY_COUNT_LIMIT');
});

test('retries transient failures and returns the successful attempt count', async () => {
  let calls = 0;
  const coordinator = createProductImageUploadCoordinator({
    repository: { getUsageSummary: () => ({ day: {}, retained: {} }) },
    config: { maxAttempts: 3, retryBaseMs: 1 },
    sleep: async () => undefined,
  });
  const result = await coordinator.withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('temporary');
    return 'ok';
  });
  assert.deepEqual(result, { value: 'ok', attempts: 3 });
});
