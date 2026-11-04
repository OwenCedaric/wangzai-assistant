import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runImageProvenanceWorker } from './imageProvenanceWorkerRunner.js';

function text(value) {
  return String(value ?? '').trim();
}

function publicJob(job = {}) {
  return {
    id: job.id,
    shopId: job.shopId,
    sourceAssetId: job.sourceAssetId,
    sourceTaskId: job.sourceTaskId,
    algorithm: job.algorithm,
    algorithmVersion: job.algorithmVersion,
    mode: job.mode,
    status: job.status,
    stage: job.stage,
    attemptCount: job.attemptCount,
    assetToken: job.assetToken,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

function scopeOf(context = {}, input = {}) {
  const scope = {
    tenantId: text(context.tenantId),
    userId: text(context.userId),
    shopId: text(input.shopId || context.shopId),
  };
  if (!scope.tenantId || !scope.userId || !scope.shopId) {
    const error = new Error('图片证据任务缺少用户或店铺作用域。');
    error.code = 'IMAGE_PROVENANCE_SCOPE_REQUIRED';
    throw error;
  }
  return scope;
}

function extensionForMimeType(mimeType) {
  const normalized = text(mimeType).toLowerCase();
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  return '.png';
}

function createShadowPayload(assetToken, originalSha256) {
  const token = Buffer.from(assetToken, 'hex');
  if (token.byteLength !== 15) throw new Error('Image provenance asset token must be 120 bits.');
  const signature = createHash('sha256')
    .update('wangzai-image-provenance-shadow-v1\0')
    .update(token)
    .update(originalSha256)
    .digest()
    .subarray(0, 16);
  return Buffer.concat([Buffer.from([0x10]), token, signature]);
}

export function createImageProvenanceService({
  repository,
  productImageAssetService,
  config = {},
  workerRunner = runImageProvenanceWorker,
  now = () => new Date(),
} = {}) {
  const enabled = config.enabled === true;
  const maximumConcurrency = Math.max(1, Math.min(2, Number(config.maxConcurrency) || 1));
  const maximumAttempts = Math.max(1, Math.min(5, Number(config.maxAttempts) || 3));
  const sourceWaitMs = Math.max(5_000, Number(config.sourceWaitMs) || 150_000);
  const protectionWaitMs = Math.max(15_000, Number(config.protectionWaitMs) || 180_000);
  const activeJobs = new Set();
  const pendingJobs = [];
  let activeCount = 0;
  let stopped = false;

  async function resolveSource(job, scope) {
    let sourceAssetId = text(job.sourceAssetId);
    if (!sourceAssetId && job.sourceTaskId) {
      const startedAt = Date.now();
      while (Date.now() - startedAt <= sourceWaitMs) {
        const taskPayload = await productImageAssetService.readPersistenceTask(job.sourceTaskId, scope);
        // productImageAssetService intentionally returns the same public
        // envelope as the HTTP route: { ok, task }.  Accept the unwrapped
        // shape as well so tests/adapters can still provide a task directly.
        const task = taskPayload?.task || taskPayload;
        if (task?.status === 'failed') {
          const error = new Error(task?.error?.message || '生成图片后台保存失败。');
          error.code = task?.error?.code || 'IMAGE_PROVENANCE_SOURCE_FAILED';
          throw error;
        }
        if (task?.status === 'completed') {
          sourceAssetId = text(task?.result?.asset?.id || task?.result?.asset?.assetId);
          if (sourceAssetId) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    if (!sourceAssetId) {
      const error = new Error('生成图片尚未完成本地保存，图片证据任务暂时无法开始。');
      error.code = 'IMAGE_PROVENANCE_SOURCE_TIMEOUT';
      throw error;
    }
    const asset = await productImageAssetService.readLocalAsset(sourceAssetId, scope);
    if (!asset?.dataBase64) {
      const error = new Error('生成图片资产不存在或不属于当前店铺。');
      error.code = 'IMAGE_PROVENANCE_SOURCE_NOT_FOUND';
      throw error;
    }
    return { sourceAssetId, asset, bytes: Buffer.from(asset.dataBase64, 'base64') };
  }

  async function processJob(job) {
    const scope = scopeOf(job, job);
    const attemptCount = Number(job.attemptCount || 0) + 1;
    job = await repository.updateJob(job.id, scope, {
      status: 'processing',
      stage: 'reading_source',
      attemptCount,
      error: null,
    });
    try {
      const source = await resolveSource(job, scope);
      const originalSha256 = createHash('sha256').update(source.bytes).digest('hex');
      const assetToken = text(job.assetToken) || randomBytes(15).toString('hex');
      const payload = createShadowPayload(assetToken, originalSha256);
      const outputDirectory = repository.evidenceDirectory(assetToken, scope);
      await mkdir(outputDirectory, { recursive: true });
      const originalExtension = extensionForMimeType(source.asset.mimeType);
      const originalPath = join(outputDirectory, `original${originalExtension}`);
      const watermarkedPath = join(outputDirectory, 'watermarked.png');
      const psdPath = join(outputDirectory, 'evidence.psd');
      const pdfPath = join(outputDirectory, 'evidence.pdf');
      const evidencePath = join(outputDirectory, 'evidence.json');
      await writeFile(originalPath, source.bytes);
      job = await repository.updateJob(job.id, scope, {
        sourceAssetId: source.sourceAssetId,
        assetToken,
        payloadHex: payload.toString('hex'),
        stage: 'embedding_watermark',
      });
      const result = await workerRunner({
        originalPath,
        watermarkedPath,
        psdPath,
        pdfPath,
        evidencePath,
        payloadHex: payload.toString('hex'),
        assetToken,
        signatureStatus: 'pending_server_claim',
        mode: 'upload-enforced',
        algorithmVersion: job.algorithmVersion,
        strength: config.strength,
        metadata: {
          tenantId: scope.tenantId,
          userId: scope.userId,
          shopId: scope.shopId,
          rightsOwner: job.rightsOwner,
          sourceAssetId: source.sourceAssetId,
          sourceType: job.sourceType,
          mimeType: source.asset.mimeType,
          productId: text(job.generation?.productId),
          offerId: text(job.generation?.offerId),
          generationJobId: text(job.sourceTaskId),
          model: text(job.generation?.model),
          accountId: text(job.generation?.accountId),
          prompt: text(job.generation?.prompt),
          generationMode: text(job.generation?.generationMode),
          createdAt: job.createdAt,
          originalSha256,
        },
      }, { timeoutMs: config.workerTimeoutMs });
      job = await repository.updateJob(job.id, scope, {
        stage: 'uploading_watermarked_asset',
      });
      const watermarkedBytes = await readFile(result.files.watermarked);
      const protectedAsset = await productImageAssetService.importImage({
        dataBase64: watermarkedBytes.toString('base64'),
        mimeType: 'image/png',
        storageScope: 'temporary',
        variant: 'provenance-watermarked',
        sourceType: 'image-provenance-watermarked',
        productId: text(job.generation?.productId),
        offerId: text(job.generation?.offerId),
      }, scope);
      const publicationAsset = protectedAsset?.asset || protectedAsset?.result?.asset;
      if (!text(publicationAsset?.id || publicationAsset?.assetId)) {
        const error = new Error('暗水印图片没有完成私有图片资产保存。');
        error.code = 'IMAGE_PROVENANCE_PROTECTED_ASSET_MISSING';
        throw error;
      }
      const completedAt = now().toISOString();
      await repository.updateJob(job.id, scope, {
        status: 'completed',
        stage: 'protected_asset_ready',
        result: {
          trustLevel: result.trustLevel,
          claimStatus: result.claimStatus,
          hashes: result.hashes,
          watermark: result.watermark,
          files: result.files,
          publicationAsset,
          uploadPolicy: 'watermarked-only',
        },
        error: null,
        completedAt,
      });
    } catch (error) {
      await repository.updateJob(job.id, scope, {
        status: 'failed',
        stage: 'failed',
        error: {
          code: error?.code || 'IMAGE_PROVENANCE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  function pump() {
    if (stopped) return;
    while (activeCount < maximumConcurrency && pendingJobs.length) {
      const job = pendingJobs.shift();
      if (!job || activeJobs.has(job.id)) continue;
      activeJobs.add(job.id);
      activeCount += 1;
      void processJob(job).finally(() => {
        activeJobs.delete(job.id);
        activeCount = Math.max(0, activeCount - 1);
        pump();
      });
    }
  }

  function enqueue(job) {
    if (!job || activeJobs.has(job.id) || pendingJobs.some((item) => item.id === job.id)) return;
    pendingJobs.push(job);
    pump();
  }

  async function schedule(input = {}, context = {}) {
    if (!enabled) {
      return {
        ok: true,
        accepted: false,
        status: 'disabled',
        mode: 'upload-enforced',
        message: '图片暗水印上传保护当前未启用。',
      };
    }
    const scope = scopeOf(context, input);
    if (!text(input.sourceAssetId) && !text(input.sourceTaskId)) {
      const error = new Error('图片证据任务缺少生成图片资产或后台保存任务。');
      error.code = 'IMAGE_PROVENANCE_SOURCE_REQUIRED';
      throw error;
    }
    let job = await repository.createOrGet({
      ...input,
      shopId: scope.shopId,
      assetToken: randomBytes(15).toString('hex'),
      algorithmVersion: text(config.algorithmVersion) || '1.1.0-upload',
    }, scope);
    if (job.status === 'failed' && Number(job.attemptCount || 0) < maximumAttempts) {
      job = await repository.updateJob(job.id, scope, {
        status: 'queued',
        stage: 'waiting_source',
        error: null,
      });
    }
    if (['queued', 'processing'].includes(job.status)) enqueue(job);
    return { ok: true, accepted: true, status: job.status, mode: 'upload-enforced', job: publicJob(job) };
  }

  async function protectAsset(input = {}, context = {}) {
    if (!enabled) {
      const error = new Error('图片暗水印上传保护未启用，已阻止原图进入 Ozon。');
      error.code = 'IMAGE_PROVENANCE_ENFORCEMENT_DISABLED';
      throw error;
    }
    const scope = scopeOf(context, input);
    const algorithmVersion = text(config.algorithmVersion) || '1.1.0-upload';
    let existing = text(input.sourceAssetId) && repository.findLatestBySourceAssetId
      ? await repository.findLatestBySourceAssetId(input.sourceAssetId, scope, algorithmVersion)
      : null;
    if (existing?.status === 'completed') {
      const existingProtectedAssetId = text(
        existing?.result?.publicationAsset?.id || existing?.result?.publicationAsset?.assetId,
      );
      const existingAsset = existingProtectedAssetId && productImageAssetService.readAssetPreview
        ? await productImageAssetService.readAssetPreview(existingProtectedAssetId, scope)
        : existingProtectedAssetId ? existing.result.publicationAsset : null;
      if (existingAsset) {
        return { ok: true, job: publicJob(existing), publicationAsset: existing.result.publicationAsset, reused: true };
      }
      existing = await repository.updateJob(existing.id, scope, {
        status: 'queued',
        stage: 'waiting_source',
        result: null,
        error: null,
        completedAt: null,
      });
    }
    let scheduled;
    if (existing && ['queued', 'processing'].includes(existing.status)) {
      enqueue(existing);
      scheduled = { job: publicJob(existing) };
    } else {
      scheduled = await schedule({ ...input, algorithmVersion }, context);
    }
    const jobId = text(scheduled?.job?.id);
    const startedAt = Date.now();
    while (Date.now() - startedAt <= protectionWaitMs) {
      const job = await repository.getJob(jobId, scope);
      if (job?.status === 'completed') {
        const publicationAsset = job?.result?.publicationAsset;
        if (!text(publicationAsset?.id || publicationAsset?.assetId)) {
          const error = new Error('图片证据已生成，但暗水印上传资产缺失。');
          error.code = 'IMAGE_PROVENANCE_PROTECTED_ASSET_MISSING';
          throw error;
        }
        return { ok: true, job: publicJob(job), publicationAsset };
      }
      if (job?.status === 'failed') {
        const error = new Error(job.error?.message || '图片暗水印上传保护失败。');
        error.code = job.error?.code || 'IMAGE_PROVENANCE_FAILED';
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const error = new Error('图片暗水印处理尚未完成，已阻止未加暗水印的图片进入 Ozon。');
    error.code = 'IMAGE_PROVENANCE_PROTECTION_TIMEOUT';
    throw error;
  }

  async function readJob(jobId, context = {}) {
    const scope = scopeOf(context, context);
    const job = await repository.getJob(jobId, scope);
    return job ? { ok: true, job: publicJob(job) } : null;
  }

  async function start() {
    stopped = false;
    if (!enabled) return { ok: true, enabled: false, recovered: 0 };
    const jobs = await repository.listRecoverableJobs();
    jobs.forEach(enqueue);
    return { ok: true, enabled: true, recovered: jobs.length };
  }

  function stop() {
    stopped = true;
    pendingJobs.splice(0, pendingJobs.length);
  }

  function getStatus() {
    return {
      ok: true,
      enabled,
      mode: 'upload-enforced',
      enforcement: true,
      uploadsCurrentImage: false,
      uploadsWatermarkedImage: true,
      active: activeCount,
      queued: pendingJobs.length,
      maximumConcurrency,
      evidenceRoot: repository.root,
      signatureAuthority: 'pending-management-system-claim-api',
    };
  }

  return { schedule, protectAsset, readJob, start, stop, getStatus };
}
