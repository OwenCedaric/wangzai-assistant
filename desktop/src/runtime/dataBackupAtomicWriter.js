import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  rm,
} from 'node:fs/promises';
import { constants as fsConstants, createReadStream } from 'node:fs';
import path from 'node:path';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function inspectFile(filePath) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { packageSha256: hash.digest('hex'), packageBytes: bytes };
}

function stagedSourcePath(stagingDirectory, stagingFileName) {
  const rawRoot = String(stagingDirectory || '').trim();
  const fileName = String(stagingFileName || '').trim();
  if (
    !rawRoot
    || !/^data-backup-export-[a-f0-9]{64}\.wzb$/u.test(fileName)
    || path.basename(fileName) !== fileName
  ) fail('DATA_BACKUP_STAGING_FILE_INVALID');
  const root = path.resolve(rawRoot);
  const filePath = path.resolve(root, fileName);
  if (path.dirname(filePath) !== root) fail('DATA_BACKUP_STAGING_FILE_INVALID');
  return filePath;
}

function decodeBase64Url(value) {
  const encoded = String(value || '').trim();
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) fail('DATA_BACKUP_CONTENT_INVALID');
  const bytes = Buffer.from(encoded, 'base64url');
  if (!bytes.length || bytes.toString('base64url') !== encoded) fail('DATA_BACKUP_CONTENT_INVALID');
  return bytes;
}

function safeSuggestedFileName(value) {
  const fileName = path.basename(String(value || '').trim());
  if (!fileName || fileName !== String(value || '').trim() || !fileName.toLowerCase().endsWith('.wzb')) {
    fail('DATA_BACKUP_FILE_NAME_INVALID');
  }
  return fileName;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sameFileIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino,
  );
}

async function removePublishedTargetIfOwned(targetPath, publishedIdentity) {
  if (!publishedIdentity) return;
  try {
    const currentIdentity = await lstat(targetPath, { bigint: true });
    if (sameFileIdentity(currentIdentity, publishedIdentity)) {
      await rm(targetPath, { force: true });
    }
  } catch {
    // Never remove a path unless it is still the exact file this writer published.
  }
}

/** Writes only a server-prepared opaque package and never exposes its absolute path to Renderer. */
export async function saveVerifiedDataBackup({
  contentB64u,
  stagingFileName = '',
  stagingDirectory = '',
  expectedSha256,
  expectedBytes,
  suggestedFileName,
  backupDirectory,
  showSaveDialog,
  createId = randomUUID,
} = {}) {
  if (typeof showSaveDialog !== 'function') fail('DATA_BACKUP_SAVE_DIALOG_REQUIRED');
  const stagedFilePath = String(stagingFileName || '').trim()
    ? stagedSourcePath(stagingDirectory, stagingFileName)
    : '';
  const bytes = stagedFilePath ? null : decodeBase64Url(contentB64u);
  const packageSha256 = String(expectedSha256 || '').trim();
  if (!/^[a-f0-9]{64}$/u.test(packageSha256)) fail('DATA_BACKUP_PACKAGE_HASH_MISMATCH');
  if (stagedFilePath) {
    const sourceStat = await lstat(stagedFilePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail('DATA_BACKUP_STAGING_FILE_INVALID');
    const sourceEvidence = await inspectFile(stagedFilePath);
    if (
      sourceEvidence.packageSha256 !== packageSha256
      || sourceEvidence.packageBytes !== Number(expectedBytes)
    ) fail('DATA_BACKUP_PACKAGE_HASH_MISMATCH');
  } else {
    if (sha256(bytes) !== packageSha256) fail('DATA_BACKUP_PACKAGE_HASH_MISMATCH');
    if (bytes.byteLength !== Number(expectedBytes)) fail('DATA_BACKUP_PACKAGE_SIZE_MISMATCH');
  }
  const fileName = safeSuggestedFileName(suggestedFileName);
  const configuredRoot = String(backupDirectory || '').trim();
  if (!configuredRoot) fail('DATA_BACKUP_DIRECTORY_REQUIRED');
  const defaultRoot = path.resolve(configuredRoot);
  await mkdir(defaultRoot, { recursive: true });
  const selection = await showSaveDialog({
    title: '导出旺崽数据备份',
    defaultPath: path.join(defaultRoot, fileName),
    buttonLabel: '导出备份',
    filters: [{ name: '旺崽数据备份', extensions: ['wzb'] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (selection?.canceled || !selection?.filePath) {
    return { ok: true, canceled: true, verified: false };
  }
  const targetPath = path.resolve(String(selection.filePath));
  if (path.extname(targetPath).toLowerCase() !== '.wzb') fail('DATA_BACKUP_TARGET_EXTENSION_INVALID');
  if (await exists(targetPath)) fail('DATA_BACKUP_TARGET_EXISTS');
  const targetDirectory = path.dirname(targetPath);
  await mkdir(targetDirectory, { recursive: true });
  const temporaryPath = path.join(
    targetDirectory,
    `.${path.basename(targetPath)}.${String(createId()).replace(/[^A-Za-z0-9_-]/gu, '')}.tmp`,
  );
  let publishedTargetIdentity = null;
  try {
    if (stagedFilePath) {
      await copyFile(stagedFilePath, temporaryPath, fsConstants.COPYFILE_EXCL);
      const handle = await open(temporaryPath, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
    } else {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const temporaryReadback = await inspectFile(temporaryPath);
    if (temporaryReadback.packageBytes !== Number(expectedBytes) || temporaryReadback.packageSha256 !== packageSha256) {
      fail('DATA_BACKUP_TEMP_READBACK_MISMATCH');
    }
    const temporaryIdentity = await lstat(temporaryPath, { bigint: true });
    // A hard-link publish is atomic and exclusive: unlike rename on Windows, it
    // cannot replace a target another process creates after the preflight check.
    await link(temporaryPath, targetPath);
    publishedTargetIdentity = temporaryIdentity;
    const targetIdentity = await lstat(targetPath, { bigint: true });
    if (!sameFileIdentity(targetIdentity, temporaryIdentity)) {
      fail('DATA_BACKUP_PUBLISH_IDENTITY_MISMATCH');
    }
    const finalReadback = await inspectFile(targetPath);
    if (finalReadback.packageBytes !== Number(expectedBytes) || finalReadback.packageSha256 !== packageSha256) {
      fail('DATA_BACKUP_FINAL_READBACK_MISMATCH');
    }
    await rm(temporaryPath, { force: true });
    publishedTargetIdentity = null;
    return {
      ok: true,
      canceled: false,
      verified: true,
      fileName: path.basename(targetPath),
      packageSha256,
      packageBytes: Number(expectedBytes),
    };
  } catch (error) {
    try { await rm(temporaryPath, { force: true }); } catch { /* cleanup only the generated temp file */ }
    await removePublishedTargetIfOwned(targetPath, publishedTargetIdentity);
    if (error?.code === 'EEXIST') fail('DATA_BACKUP_TARGET_EXISTS');
    if (['EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) {
      fail('DATA_BACKUP_EXCLUSIVE_PUBLISH_UNAVAILABLE');
    }
    throw error;
  }
}

async function verifyBatchInput(input, stagingDirectory) {
  const stagedFilePath = String(input?.stagingFileName || '').trim()
    ? stagedSourcePath(stagingDirectory, input.stagingFileName)
    : '';
  const bytes = stagedFilePath ? null : decodeBase64Url(input?.contentB64u);
  const packageSha256 = String(input?.expectedSha256 || '').trim();
  const packageBytes = Number(input?.expectedBytes);
  if (!/^[a-f0-9]{64}$/u.test(packageSha256)) fail('DATA_BACKUP_PACKAGE_HASH_MISMATCH');
  if (!Number.isSafeInteger(packageBytes) || packageBytes <= 0) {
    fail('DATA_BACKUP_PACKAGE_SIZE_MISMATCH');
  }
  if (stagedFilePath) {
    const sourceStat = await lstat(stagedFilePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail('DATA_BACKUP_STAGING_FILE_INVALID');
    const evidence = await inspectFile(stagedFilePath);
    if (evidence.packageSha256 !== packageSha256 || evidence.packageBytes !== packageBytes) {
      fail('DATA_BACKUP_PACKAGE_HASH_MISMATCH');
    }
  } else if (sha256(bytes) !== packageSha256 || bytes.byteLength !== packageBytes) {
    fail('DATA_BACKUP_PACKAGE_HASH_MISMATCH');
  }
  return {
    stagedFilePath,
    bytes,
    packageSha256,
    packageBytes,
    fileName: safeSuggestedFileName(input?.suggestedFileName),
  };
}

/** Publishes a set of ordinary .wzb files into one chosen directory as one all-or-none filesystem operation. */
export async function saveVerifiedDataBackupBatch({
  items = [],
  stagingDirectory = '',
  backupDirectory = '',
  showDirectoryDialog,
  createId = randomUUID,
  beforePublish,
} = {}) {
  if (typeof showDirectoryDialog !== 'function') fail('DATA_BACKUP_DIRECTORY_DIALOG_REQUIRED');
  if (!Array.isArray(items) || items.length < 2 || items.length > 100) {
    fail('DATA_BACKUP_BATCH_ITEMS_INVALID');
  }
  const prepared = [];
  for (const item of items) prepared.push(await verifyBatchInput(item, stagingDirectory));
  if (new Set(prepared.map((item) => item.fileName.toLowerCase())).size !== prepared.length) {
    fail('DATA_BACKUP_BATCH_FILE_NAME_DUPLICATE');
  }
  const configuredRoot = String(backupDirectory || '').trim();
  if (!configuredRoot) fail('DATA_BACKUP_DIRECTORY_REQUIRED');
  await mkdir(path.resolve(configuredRoot), { recursive: true });
  const selection = await showDirectoryDialog({
    title: '选择批量备份保存文件夹',
    buttonLabel: '保存全部备份',
    defaultPath: path.resolve(configuredRoot),
    properties: ['openDirectory', 'createDirectory'],
  });
  const selectedPath = selection?.filePaths?.[0];
  if (selection?.canceled || !selectedPath) {
    return { ok: true, canceled: true, verified: false, files: [] };
  }
  const targetDirectory = path.resolve(String(selectedPath));
  await mkdir(targetDirectory, { recursive: true });
  const directoryStat = await lstat(targetDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail('DATA_BACKUP_BATCH_DIRECTORY_INVALID');
  }
  const work = prepared.map((item) => ({
    ...item,
    targetPath: path.join(targetDirectory, item.fileName),
    temporaryPath: path.join(
      targetDirectory,
      `.${item.fileName}.${String(createId()).replace(/[^A-Za-z0-9_-]/gu, '')}.tmp`,
    ),
    publishedIdentity: null,
  }));
  if ((await Promise.all(work.map((item) => exists(item.targetPath)))).some(Boolean)) {
    fail('DATA_BACKUP_TARGET_EXISTS');
  }
  try {
    for (const item of work) {
      if (item.stagedFilePath) {
        await copyFile(item.stagedFilePath, item.temporaryPath, fsConstants.COPYFILE_EXCL);
        const handle = await open(item.temporaryPath, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
      } else {
        const handle = await open(item.temporaryPath, 'wx', 0o600);
        try {
          await handle.writeFile(item.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      const evidence = await inspectFile(item.temporaryPath);
      if (evidence.packageSha256 !== item.packageSha256 || evidence.packageBytes !== item.packageBytes) {
        fail('DATA_BACKUP_TEMP_READBACK_MISMATCH');
      }
    }
    if (beforePublish !== undefined && typeof beforePublish !== 'function') {
      fail('DATA_BACKUP_BEFORE_PUBLISH_INVALID');
    }
    for (const [index, item] of work.entries()) {
      await beforePublish?.({ index, fileName: item.fileName });
      const identity = await lstat(item.temporaryPath, { bigint: true });
      await link(item.temporaryPath, item.targetPath);
      item.publishedIdentity = identity;
      const targetIdentity = await lstat(item.targetPath, { bigint: true });
      if (!sameFileIdentity(targetIdentity, identity)) fail('DATA_BACKUP_PUBLISH_IDENTITY_MISMATCH');
      const evidence = await inspectFile(item.targetPath);
      if (evidence.packageSha256 !== item.packageSha256 || evidence.packageBytes !== item.packageBytes) {
        fail('DATA_BACKUP_FINAL_READBACK_MISMATCH');
      }
    }
    await Promise.all(work.map((item) => rm(item.temporaryPath, { force: true })));
    work.forEach((item) => { item.publishedIdentity = null; });
    return {
      ok: true,
      canceled: false,
      verified: true,
      files: work.map((item) => ({
        fileName: item.fileName,
        packageSha256: item.packageSha256,
        packageBytes: item.packageBytes,
      })),
    };
  } catch (error) {
    await Promise.all(work.map(async (item) => {
      try { await rm(item.temporaryPath, { force: true }); } catch { /* generated temp only */ }
      await removePublishedTargetIfOwned(item.targetPath, item.publishedIdentity);
    }));
    if (error?.code === 'EEXIST') fail('DATA_BACKUP_TARGET_EXISTS');
    if (['EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) {
      fail('DATA_BACKUP_EXCLUSIVE_PUBLISH_UNAVAILABLE');
    }
    throw error;
  }
}
