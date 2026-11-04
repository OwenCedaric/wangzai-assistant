import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createImageProvenanceFileRepository } from './imageProvenanceFileRepository.js';

const BASE_TIME = Date.parse('2026-08-15T00:00:00.000Z');

function createClock() {
  let tick = 0;
  return () => new Date(BASE_TIME + tick++ * 1_000);
}

async function createJob(repository, {
  scope,
  shopId = scope.shopId,
  sourceAssetId,
  productId = '',
  offerId = '',
  status = 'completed',
  uploadPolicy = 'watermarked-only',
  completedAt = '2026-08-15T00:00:00.000Z',
}) {
  const job = await repository.createOrGet({
    shopId,
    sourceAssetId,
    sourceTaskId: `task-${sourceAssetId}`,
    generation: { productId, offerId },
  }, scope);
  return repository.updateJob(job.id, scope, {
    status,
    completedAt,
    result: { uploadPolicy },
  });
}

test('findLatestCompletedForProduct isolates owner/shop and returns latest completed watermarked product match', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wangzai-image-provenance-repository-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = createImageProvenanceFileRepository({ root, now: createClock() });
  const scope = { tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a' };

  const older = await createJob(repository, {
    scope,
    sourceAssetId: 'asset-product-older',
    productId: 'product-100',
    offerId: 'offer-older',
    completedAt: '2026-08-15T01:00:00.000Z',
  });
  const latest = await createJob(repository, {
    scope,
    sourceAssetId: 'asset-product-latest',
    productId: 'product-100',
    offerId: 'offer-latest',
    completedAt: '2026-08-15T03:00:00.000Z',
  });

  await createJob(repository, {
    scope,
    sourceAssetId: 'asset-product-queued',
    productId: 'product-100',
    status: 'queued',
    completedAt: '2026-08-15T09:00:00.000Z',
  });
  await createJob(repository, {
    scope,
    sourceAssetId: 'asset-product-unprotected',
    productId: 'product-100',
    uploadPolicy: 'original-allowed',
    completedAt: '2026-08-15T08:00:00.000Z',
  });
  await createJob(repository, {
    scope,
    shopId: 'shop-b',
    sourceAssetId: 'asset-other-shop',
    productId: 'product-100',
    completedAt: '2026-08-15T10:00:00.000Z',
  });
  await createJob(repository, {
    scope: { tenantId: 'tenant-b', userId: 'user-a', shopId: 'shop-a' },
    sourceAssetId: 'asset-other-tenant',
    productId: 'product-100',
    completedAt: '2026-08-15T11:00:00.000Z',
  });
  await createJob(repository, {
    scope: { tenantId: 'tenant-a', userId: 'user-b', shopId: 'shop-a' },
    sourceAssetId: 'asset-other-user',
    productId: 'product-100',
    completedAt: '2026-08-15T12:00:00.000Z',
  });

  const found = await repository.findLatestCompletedForProduct({ productId: 'product-100' }, scope);
  assert.equal(found?.id, latest.id);
  assert.notEqual(found?.id, older.id);
  assert.equal(found?.tenantId, scope.tenantId);
  assert.equal(found?.userId, scope.userId);
  assert.equal(found?.shopId, scope.shopId);
  assert.equal(found?.status, 'completed');
  assert.equal(found?.result?.uploadPolicy, 'watermarked-only');

  const crossShopLookup = await repository.findLatestCompletedForProduct({
    shopId: 'shop-b',
    productId: 'product-100',
  }, scope);
  assert.equal(crossShopLookup, null);
  assert.equal(await repository.findLatestCompletedForProduct({ productId: 'product-missing' }, scope), null);
});

test('findLatestCompletedForProduct matches product or offer and keeps latest-match ordering', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wangzai-image-provenance-repository-offer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = createImageProvenanceFileRepository({ root, now: createClock() });
  const scope = { tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a' };

  const productMatch = await createJob(repository, {
    scope,
    sourceAssetId: 'asset-product-match',
    productId: 'product-200',
    offerId: 'offer-other',
    completedAt: '2026-08-15T02:00:00.000Z',
  });
  const offerMatch = await createJob(repository, {
    scope,
    sourceAssetId: 'asset-offer-match',
    productId: 'product-other',
    offerId: 'offer-200',
    completedAt: '2026-08-15T04:00:00.000Z',
  });

  assert.equal((await repository.findLatestCompletedForProduct({
    productId: 'product-200',
  }, scope))?.id, productMatch.id);
  assert.equal((await repository.findLatestCompletedForProduct({
    offerId: 'offer-200',
  }, scope))?.id, offerMatch.id);
  assert.equal((await repository.findLatestCompletedForProduct({
    productId: 'product-200',
    offerId: 'offer-200',
  }, scope))?.id, offerMatch.id);

  assert.equal(await repository.findLatestCompletedForProduct({}, scope), null);
  assert.equal(await repository.findLatestCompletedForProduct({ productId: 'product-200' }, {
    tenantId: 'tenant-a',
    userId: 'user-a',
    shopId: '',
  }), null);
});

test('concurrent job updates serialize source-index writes and leave no temporary files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wangzai-image-provenance-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = createImageProvenanceFileRepository({ root, now: createClock() });
  const scope = { tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a' };
  const created = await repository.createOrGet({
    shopId: scope.shopId,
    sourceAssetId: 'asset-concurrent',
    sourceTaskId: 'task-concurrent',
  }, scope);

  const updates = await Promise.all(Array.from({ length: 64 }, (_, index) => repository.updateJob(
    created.id,
    scope,
    { stage: `stage-${index}`, attemptCount: index + 1 },
  )));
  assert.equal(updates.length, 64);

  const ownerDirectories = (await readdir(repository.jobsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  assert.equal(ownerDirectories.length, 1);
  const sourceIndexDirectory = join(repository.jobsRoot, ownerDirectories[0].name, 'source-index');
  const sourceIndexFiles = await readdir(sourceIndexDirectory);
  assert.equal(sourceIndexFiles.filter((name) => name.endsWith('.tmp')).length, 0);
  assert.equal(sourceIndexFiles.filter((name) => name.endsWith('.json')).length, 1);

  const sourceIndex = JSON.parse(await readFile(
    join(sourceIndexDirectory, sourceIndexFiles.find((name) => name.endsWith('.json'))),
    'utf8',
  ));
  const persistedJob = await repository.getJob(created.id, scope);
  assert.equal(sourceIndex.jobId, created.id);
  assert.equal(sourceIndex.sourceAssetId, created.sourceAssetId);
  assert.equal(sourceIndex.shopId, scope.shopId);
  assert.equal(sourceIndex.algorithmVersion, created.algorithmVersion);
  assert.equal(sourceIndex.updatedAt, persistedJob.updatedAt);
  assert.match(persistedJob.stage, /^stage-\d+$/u);
});
