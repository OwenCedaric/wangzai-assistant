import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, rm } from 'node:fs/promises';
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

function createStagingFileName(createToken = randomBytes) {
  return `data-backup-import-${createToken(32).toString('hex')}.wzb`;
}

function stagingTarget(stagingDirectory, stagingFileName) {
  const rawRoot = String(stagingDirectory || '').trim();
  if (!rawRoot) fail('DATA_BACKUP_STAGING_DIRECTORY_REQUIRED');
  const root = path.resolve(rawRoot);
  return { root, filePath: path.join(root, stagingFileName) };
}

function sameFileIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs,
  );
}

/**
 * Reads a user-selected encrypted backup in Electron Main. The absolute path
 * and package bytes are intentionally returned only to the trusted Main
 * caller; the IPC bridge must expose a redacted preflight summary to Renderer.
 */
export async function selectVerifiedDataBackup({
  showOpenDialog,
  stagingDirectory = '',
  createToken = randomBytes,
} = {}) {
  if (typeof showOpenDialog !== 'function') fail('DATA_BACKUP_OPEN_DIALOG_REQUIRED');
  const selection = await showOpenDialog({
    title: '选择旺崽数据备份',
    buttonLabel: '验证备份',
    filters: [{ name: '旺崽数据备份', extensions: ['wzb'] }],
    properties: ['openFile'],
  });
  const selectedPaths = Array.isArray(selection?.filePaths) ? selection.filePaths : [];
  if (selection?.canceled || selectedPaths.length === 0) {
    return { ok: true, canceled: true };
  }
  if (selectedPaths.length !== 1) fail('DATA_BACKUP_IMPORT_FILE_COUNT_INVALID');
  const filePath = path.resolve(String(selectedPaths[0] || ''));
  if (!filePath || path.extname(filePath).toLowerCase() !== '.wzb') {
    fail('DATA_BACKUP_IMPORT_EXTENSION_INVALID');
  }
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) fail('DATA_BACKUP_IMPORT_FILE_INVALID');
  if (before.size <= 0) fail('DATA_BACKUP_IMPORT_FILE_SIZE_INVALID');

  const handle = await open(filePath, 'r');
  let bytes;
  try {
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened)) fail('DATA_BACKUP_IMPORT_FILE_CHANGED');
    bytes = String(stagingDirectory || '').trim() ? null : await handle.readFile();
    const readback = await handle.stat();
    if (!sameFileIdentity(opened, readback) || (bytes && bytes.byteLength !== opened.size)) {
      fail('DATA_BACKUP_IMPORT_FILE_CHANGED');
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(filePath);
  if (!sameFileIdentity(before, after)) fail('DATA_BACKUP_IMPORT_FILE_CHANGED');
  if (String(stagingDirectory || '').trim()) {
    const stagingFileName = createStagingFileName(createToken);
    const target = stagingTarget(stagingDirectory, stagingFileName);
    await mkdir(target.root, { recursive: true });
    try {
      await copyFile(filePath, target.filePath, fsConstants.COPYFILE_EXCL);
      const [sourceEvidence, stagedEvidence, finalSource] = await Promise.all([
        inspectFile(filePath),
        inspectFile(target.filePath),
        lstat(filePath),
      ]);
      const stagedStat = await lstat(target.filePath);
      if (
        !sameFileIdentity(before, finalSource)
        || !stagedStat.isFile()
        || stagedStat.isSymbolicLink()
        || stagedEvidence.packageBytes !== stagedStat.size
        || sourceEvidence.packageBytes !== before.size
        || sourceEvidence.packageSha256 !== stagedEvidence.packageSha256
      ) fail('DATA_BACKUP_IMPORT_FILE_CHANGED');
      return {
        ok: true,
        canceled: false,
        fileName: path.basename(filePath),
        stagingFileName,
        ...stagedEvidence,
        cleanup: () => rm(target.filePath, { force: true }),
      };
    } catch (error) {
      await rm(target.filePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return {
    ok: true,
    canceled: false,
    fileName: path.basename(filePath),
    contentB64u: bytes.toString('base64url'),
    packageSha256: sha256(bytes),
    packageBytes: bytes.byteLength,
  };
}

export async function removeStagedDataBackup({ stagingDirectory, stagingFileName } = {}) {
  const fileName = String(stagingFileName || '').trim();
  if (!/^data-backup-(?:export|import)-[a-f0-9]{64}\.wzb$/u.test(fileName)) {
    fail('DATA_BACKUP_STAGING_FILE_INVALID');
  }
  const target = stagingTarget(stagingDirectory, fileName);
  await rm(target.filePath, { force: true });
  return true;
}
