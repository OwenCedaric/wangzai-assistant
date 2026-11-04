import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createImageProvenanceFileRepository } from './imageProvenanceFileRepository.js';
import { createImageProvenanceService } from './imageProvenanceService.js';

async function waitForCompleted(service, jobId, context) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const payload = await service.readJob(jobId, context);
    if (payload?.job?.status === 'completed') return payload.job;
    if (payload?.job?.status === 'failed') throw new Error(payload.job.error?.message || 'job failed');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for image provenance test job');
}

test('provenance job creates evidence and a watermarked upload asset', { timeout: 70_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wangzai-image-provenance-'));
  const width = 512;
  const height = 512;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < rgba.length; index += 4) {
    const pixel = index / 4;
    rgba[index] = (pixel * 3) & 255;
    rgba[index + 1] = (pixel * 7) & 255;
    rgba[index + 2] = (pixel * 13) & 255;
    rgba[index + 3] = 255;
  }
  const image = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const productImageAssetService = {
    async readLocalAsset(assetId) {
      assert.equal(assetId, 'pimg-source');
      return { id: assetId, mimeType: 'image/png', dataBase64: image.toString('base64') };
    },
    async importImage(input, scope) {
      assert.equal(input.variant, 'provenance-watermarked');
      assert.equal(input.storageScope, 'temporary');
      assert.equal(input.mimeType, 'image/png');
      assert.ok(Buffer.from(input.dataBase64, 'base64').byteLength > 0);
      assert.deepEqual(scope, { tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a' });
      return { asset: { id: 'pimg-watermarked', variant: input.variant, storageScope: input.storageScope } };
    },
  };
  const repository = createImageProvenanceFileRepository({ root });
  const service = createImageProvenanceService({
    repository,
    productImageAssetService,
    config: { enabled: true, strength: 20, maxConcurrency: 1, workerTimeoutMs: 60_000 },
  });
  const context = { tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a' };
  const scheduled = await service.schedule({
    shopId: 'shop-a',
    sourceAssetId: 'pimg-source',
    sourceType: 'unit-test',
    generation: { model: 'fixture-model', prompt: 'fixture prompt', productId: 'product-a' },
  }, context);
  assert.equal(scheduled.accepted, true);
  const completed = await waitForCompleted(service, scheduled.job.id, context);
  assert.equal(completed.mode, 'upload-enforced');
  assert.equal(completed.result.trustLevel, 'local-shadow-only');
  assert.equal(completed.result.claimStatus, 'pending_server_claim');
  assert.equal(completed.result.watermark.localVerification.exact, true);
  assert.equal(completed.result.publicationAsset.id, 'pimg-watermarked');
  assert.equal(completed.result.uploadPolicy, 'watermarked-only');
  for (const path of Object.values(completed.result.files)) {
    assert.ok((await readFile(path)).byteLength > 0, path);
  }
  const evidence = JSON.parse(await readFile(completed.result.files.evidence, 'utf8'));
  assert.equal(evidence.generation.prompt, 'fixture prompt');
  assert.equal(evidence.source.shopId, 'shop-a');
  assert.equal(evidence.mode, 'upload-enforced');
  assert.equal(evidence.claimStatus, 'pending_server_claim');
  assert.equal((await readFile(completed.result.files.pdf)).subarray(0, 8).toString('ascii'), '%PDF-1.4');
  assert.equal(evidence.hashes.pdfSha256.length, 64);
  const protectedResult = await service.protectAsset({
    shopId: 'shop-a',
    sourceAssetId: 'pimg-source',
    sourceType: 'unit-test',
  }, context);
  assert.equal(protectedResult.publicationAsset.id, 'pimg-watermarked');
  assert.equal(protectedResult.job.status, 'completed');
  service.stop();
});

test('disabled provenance processing returns immediately and performs no image work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wangzai-image-provenance-disabled-'));
  const service = createImageProvenanceService({
    repository: createImageProvenanceFileRepository({ root }),
    productImageAssetService: {},
    config: { enabled: false },
  });
  const result = await service.schedule({ sourceAssetId: 'pimg-source', shopId: 'shop-a' }, {
    tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a',
  });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 'disabled');
});

test('source persistence task accepts the product image service response envelope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wangzai-image-provenance-task-envelope-'));
  const image = await sharp({
    create: { width: 256, height: 256, channels: 4, background: '#5f7f9f' },
  }).png().toBuffer();
  const context = { tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a' };
  let readAssetId = '';
  let importCount = 0;
  const productImageAssetService = {
    async readPersistenceTask(taskId, scope) {
      assert.equal(taskId, 'pimg-task');
      assert.deepEqual(scope, context);
      return {
        ok: true,
        task: {
          id: taskId,
          status: 'completed',
          result: { asset: { id: 'pimg-source-from-task' } },
        },
      };
    },
    async readLocalAsset(assetId) {
      readAssetId = assetId;
      return { id: assetId, mimeType: 'image/png', dataBase64: image.toString('base64') };
    },
    async importImage(input) {
      importCount += 1;
      assert.equal(input.variant, 'provenance-watermarked');
      return { asset: { id: 'pimg-watermarked-from-task', variant: input.variant } };
    },
  };
  const service = createImageProvenanceService({
    repository: createImageProvenanceFileRepository({ root }),
    productImageAssetService,
    config: { enabled: true, sourceWaitMs: 5_000 },
    workerRunner: async (input) => {
      await writeFile(input.watermarkedPath, image);
      return {
        trustLevel: 'local-shadow-only',
        claimStatus: 'pending_server_claim',
        hashes: {},
        watermark: { localVerification: { exact: true } },
        files: {
          original: input.originalPath,
          watermarked: input.watermarkedPath,
          psd: input.psdPath,
          pdf: input.pdfPath,
          evidence: input.evidencePath,
        },
      };
    },
  });
  const scheduled = await service.schedule({
    shopId: 'shop-a',
    sourceTaskId: 'pimg-task',
  }, context);
  const completed = await waitForCompleted(service, scheduled.job.id, context);
  assert.equal(completed.sourceAssetId, 'pimg-source-from-task');
  assert.equal(readAssetId, 'pimg-source-from-task');
  assert.equal(completed.result.publicationAsset.id, 'pimg-watermarked-from-task');
  const reused = await service.protectAsset({
    shopId: 'shop-a',
    sourceAssetId: 'pimg-source-from-task',
  }, context);
  assert.equal(reused.reused, true);
  assert.equal(reused.job.id, completed.id);
  assert.equal(importCount, 1);
  service.stop();
});
