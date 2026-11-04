import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const STAGING_FILE_PATTERN = /^data-backup-(?:export|import)-[a-f0-9]{64}\.wzb$/u;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function stagingPath(stagingDirectory, stagingFileName) {
  const rawRoot = String(stagingDirectory || '').trim();
  const fileName = String(stagingFileName || '').trim();
  if (!rawRoot || !STAGING_FILE_PATTERN.test(fileName) || path.basename(fileName) !== fileName) {
    fail('DATA_BACKUP_STAGING_FILE_INVALID');
  }
  const root = path.resolve(rawRoot);
  const resolved = path.resolve(root, fileName);
  if (path.dirname(resolved) !== root) fail('DATA_BACKUP_STAGING_FILE_INVALID');
  return { root, fileName, resolved };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function writeDataBackupStagingFile({
  stagingDirectory,
  stagingFileName,
  bytes,
} = {}) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  if (!source.length) fail('DATA_BACKUP_STAGING_CONTENT_REQUIRED');
  const target = stagingPath(stagingDirectory, stagingFileName);
  mkdirSync(target.root, { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(target.resolved, 'wx', 0o600);
    writeFileSync(descriptor, source);
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error?.code === 'EEXIST') fail('DATA_BACKUP_STAGING_FILE_EXISTS');
    throw error;
  }
  closeSync(descriptor);
  const stat = lstatSync(target.resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== source.byteLength) {
    rmSync(target.resolved, { force: true });
    fail('DATA_BACKUP_STAGING_WRITE_MISMATCH');
  }
  const readback = readFileSync(target.resolved);
  if (readback.byteLength !== source.byteLength || sha256(readback) !== sha256(source)) {
    rmSync(target.resolved, { force: true });
    fail('DATA_BACKUP_STAGING_WRITE_MISMATCH');
  }
  return {
    stagingFileName: target.fileName,
    packageSha256: sha256(source),
    packageBytes: source.byteLength,
  };
}

export function readDataBackupStagingFile({
  stagingDirectory,
  stagingFileName,
  expectedSha256 = '',
  expectedBytes,
} = {}) {
  const target = stagingPath(stagingDirectory, stagingFileName);
  const before = lstatSync(target.resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0) {
    fail('DATA_BACKUP_STAGING_FILE_INVALID');
  }
  const bytes = readFileSync(target.resolved);
  const after = lstatSync(target.resolved);
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || bytes.byteLength !== before.size
  ) fail('DATA_BACKUP_STAGING_FILE_CHANGED');
  const packageSha256 = sha256(bytes);
  const normalizedExpectedSha256 = String(expectedSha256 || '').trim();
  if (normalizedExpectedSha256 && packageSha256 !== normalizedExpectedSha256) {
    fail('DATA_BACKUP_PACKAGE_HASH_MISMATCH');
  }
  if (expectedBytes !== undefined && Number(expectedBytes) !== bytes.byteLength) {
    fail('DATA_BACKUP_PACKAGE_SIZE_MISMATCH');
  }
  return { bytes, packageSha256, packageBytes: bytes.byteLength };
}

export function removeDataBackupStagingFile({ stagingDirectory, stagingFileName } = {}) {
  const target = stagingPath(stagingDirectory, stagingFileName);
  if (!existsSync(target.resolved)) return false;
  const stat = lstatSync(target.resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('DATA_BACKUP_STAGING_FILE_INVALID');
  rmSync(target.resolved, { force: true });
  return !existsSync(target.resolved);
}
