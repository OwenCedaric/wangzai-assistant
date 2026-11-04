import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ATOMIC_RENAME_MAX_ATTEMPTS = 6;
const ATOMIC_RENAME_RETRYABLE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function text(value) {
  return String(value ?? '').trim();
}

function ownerKey(scope = {}) {
  return createHash('sha256')
    .update(`${text(scope.tenantId)}\n${text(scope.userId)}`)
    .digest('hex');
}

function jobIdFor(input = {}, scope = {}) {
  return `ipj_${createHash('sha256').update([
    text(scope.tenantId),
    text(scope.userId),
    text(input.shopId || scope.shopId),
    text(input.sourceAssetId),
    text(input.sourceTaskId),
    text(input.algorithmVersion || '1.1.0-upload'),
  ].join('\n')).digest('hex')}`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function atomicJsonWriteNow(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
    for (let attempt = 1; attempt <= ATOMIC_RENAME_MAX_ATTEMPTS; attempt += 1) {
      try {
        await rename(temporaryPath, path);
        break;
      } catch (error) {
        const retryable = ATOMIC_RENAME_RETRYABLE_CODES.has(error?.code);
        if (!retryable || attempt === ATOMIC_RENAME_MAX_ATTEMPTS) throw error;
        await sleep(20 * (2 ** (attempt - 1)));
      }
    }
    const persisted = await readFile(path, 'utf8');
    if (persisted !== serialized) {
      const error = new Error('Image provenance atomic write readback mismatch.');
      error.code = 'IMAGE_PROVENANCE_ATOMIC_WRITE_READBACK_MISMATCH';
      throw error;
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function createImageProvenanceFileRepository({ root, now = () => new Date() } = {}) {
  if (!text(root)) throw new Error('Image provenance evidence root is required.');
  const jobsRoot = join(root, 'jobs');
  const evidenceRoot = join(root, 'evidence');
  let atomicWriteTail = Promise.resolve();

  function atomicJsonWrite(path, value) {
    const currentWrite = atomicWriteTail
      .catch(() => undefined)
      .then(() => atomicJsonWriteNow(path, value));
    atomicWriteTail = currentWrite.catch(() => undefined);
    return currentWrite;
  }

  function jobPath(jobId, scope) {
    return join(jobsRoot, ownerKey(scope), `${text(jobId)}.json`);
  }

  function sourceIndexPath(sourceAssetId, scope, algorithmVersion) {
    const sourceKey = createHash('sha256').update([
      text(scope.shopId),
      text(sourceAssetId),
      text(algorithmVersion),
    ].join('\n')).digest('hex');
    return join(jobsRoot, ownerKey(scope), 'source-index', `${sourceKey}.json`);
  }

  async function writeSourceIndex(job, scope) {
    if (!text(job?.sourceAssetId)) return;
    await atomicJsonWrite(sourceIndexPath(job.sourceAssetId, scope, job.algorithmVersion), {
      jobId: job.id,
      sourceAssetId: job.sourceAssetId,
      shopId: job.shopId,
      algorithmVersion: job.algorithmVersion,
      updatedAt: job.updatedAt,
    });
  }

  function evidenceDirectory(assetToken, scope) {
    return join(evidenceRoot, ownerKey(scope), text(assetToken));
  }

  async function getJob(jobId, scope) {
    const job = await readJson(jobPath(jobId, scope));
    if (!job) return null;
    if (job.tenantId !== text(scope.tenantId) || job.userId !== text(scope.userId)) {
      const error = new Error('当前用户无权读取该图片证据任务。');
      error.code = 'IMAGE_PROVENANCE_SCOPE_FORBIDDEN';
      throw error;
    }
    return job;
  }

  async function createOrGet(input, scope) {
    const id = jobIdFor(input, scope);
    const existing = await getJob(id, scope);
    if (existing) return existing;
    const timestamp = now().toISOString();
    const job = {
      id,
      tenantId: text(scope.tenantId),
      userId: text(scope.userId),
      shopId: text(input.shopId || scope.shopId),
      sourceAssetId: text(input.sourceAssetId),
      sourceTaskId: text(input.sourceTaskId),
      sourceType: text(input.sourceType),
      generation: input.generation && typeof input.generation === 'object' ? input.generation : {},
      rightsOwner: text(input.rightsOwner || scope.userId),
      algorithm: 'wangzai-dct-pair-v1',
      algorithmVersion: text(input.algorithmVersion) || '1.1.0-upload',
      mode: 'upload-enforced',
      status: 'queued',
      stage: 'waiting_source',
      attemptCount: 0,
      assetToken: text(input.assetToken),
      payloadHex: '',
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    await atomicJsonWrite(jobPath(id, scope), job);
    await writeSourceIndex(job, scope);
    return job;
  }

  async function updateJob(jobId, scope, patch = {}) {
    const current = await getJob(jobId, scope);
    if (!current) return null;
    const job = {
      ...current,
      ...patch,
      tenantId: current.tenantId,
      userId: current.userId,
      id: current.id,
      updatedAt: now().toISOString(),
    };
    await atomicJsonWrite(jobPath(jobId, scope), job);
    await writeSourceIndex(job, scope);
    return job;
  }

  async function listRecoverableJobs() {
    const results = [];
    let ownerDirectories = [];
    try {
      ownerDirectories = await readdir(jobsRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const ownerDirectory of ownerDirectories) {
      if (!ownerDirectory.isDirectory()) continue;
      const directory = join(jobsRoot, ownerDirectory.name);
      const files = await readdir(directory, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const job = await readJson(join(directory, file.name));
        if (job && ['queued', 'processing'].includes(job.status)) results.push(job);
      }
    }
    return results;
  }

  async function findLatestBySourceAssetId(sourceAssetId, scope, algorithmVersion = '') {
    const normalizedSourceAssetId = text(sourceAssetId);
    if (!normalizedSourceAssetId) return null;
    if (text(algorithmVersion)) {
      const indexed = await readJson(sourceIndexPath(normalizedSourceAssetId, scope, algorithmVersion));
      if (text(indexed?.jobId)) {
        const indexedJob = await getJob(indexed.jobId, scope);
        if (indexedJob
          && indexedJob.shopId === text(scope.shopId)
          && indexedJob.sourceAssetId === normalizedSourceAssetId
          && indexedJob.algorithmVersion === text(algorithmVersion)) return indexedJob;
      }
    }
    const directory = join(jobsRoot, ownerKey(scope));
    let files = [];
    try {
      files = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const matches = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const job = await readJson(join(directory, file.name));
      if (!job
        || job.tenantId !== text(scope.tenantId)
        || job.userId !== text(scope.userId)
        || job.shopId !== text(scope.shopId)
        || job.sourceAssetId !== normalizedSourceAssetId
        || (text(algorithmVersion) && job.algorithmVersion !== text(algorithmVersion))) continue;
      matches.push(job);
    }
    const latest = matches.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
    if (latest) await writeSourceIndex(latest, scope);
    return latest;
  }

  async function findLatestCompletedForProduct(input = {}, scope = {}) {
    const productId = text(input.productId);
    const offerId = text(input.offerId);
    const shopId = text(scope.shopId);
    if (text(input.shopId) && text(input.shopId) !== shopId) return null;
    if (!shopId || (!productId && !offerId)) return null;
    const directory = join(jobsRoot, ownerKey(scope));
    let files = [];
    try {
      files = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const matches = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const job = await readJson(join(directory, file.name));
      if (!job
        || job.tenantId !== text(scope.tenantId)
        || job.userId !== text(scope.userId)
        || job.shopId !== shopId
        || job.status !== 'completed'
        || job.result?.uploadPolicy !== 'watermarked-only') continue;
      const generation = job.generation && typeof job.generation === 'object' ? job.generation : {};
      const productMatches = productId && text(generation.productId) === productId;
      const offerMatches = offerId && text(generation.offerId) === offerId;
      if (!productMatches && !offerMatches) continue;
      matches.push(job);
    }
    return matches.sort((left, right) => String(right.completedAt || right.updatedAt || '')
      .localeCompare(String(left.completedAt || left.updatedAt || '')))[0] || null;
  }

  return {
    root,
    jobsRoot,
    evidenceRoot,
    jobIdFor,
    evidenceDirectory,
    getJob,
    createOrGet,
    updateJob,
    listRecoverableJobs,
    findLatestBySourceAssetId,
    findLatestCompletedForProduct,
  };
}
