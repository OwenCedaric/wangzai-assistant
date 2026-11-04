import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  readDataBackupStagingFile,
  removeDataBackupStagingFile,
  writeDataBackupStagingFile,
} from './dataBackupStagingFile.js';

const EXPORT_FILE = `data-backup-export-${'ab'.repeat(32)}.wzb`;
const IMPORT_FILE = `data-backup-import-${'cd'.repeat(32)}.wzb`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('data backup staging writes, verifies, reads, and removes one opaque package', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-staging-'));
  try {
    const bytes = Buffer.from('opaque-encrypted-data-backup');
    const written = writeDataBackupStagingFile({
      stagingDirectory: root,
      stagingFileName: EXPORT_FILE,
      bytes,
    });
    assert.deepEqual(written, {
      stagingFileName: EXPORT_FILE,
      packageSha256: sha256(bytes),
      packageBytes: bytes.byteLength,
    });

    const readback = readDataBackupStagingFile({
      stagingDirectory: root,
      stagingFileName: EXPORT_FILE,
      expectedSha256: written.packageSha256,
      expectedBytes: written.packageBytes,
    });
    assert.deepEqual(readback.bytes, bytes);
    assert.equal(readback.packageSha256, written.packageSha256);
    assert.equal(readback.packageBytes, written.packageBytes);

    assert.equal(removeDataBackupStagingFile({
      stagingDirectory: root,
      stagingFileName: EXPORT_FILE,
    }), true);
    assert.equal(existsSync(path.join(root, EXPORT_FILE)), false);
    assert.equal(removeDataBackupStagingFile({
      stagingDirectory: root,
      stagingFileName: EXPORT_FILE,
    }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('data backup staging rejects traversal, malformed names, empty directories, and duplicate writes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-staging-invalid-'));
  try {
    const bytes = Buffer.from('opaque');
    assert.throws(() => writeDataBackupStagingFile({
      stagingDirectory: root,
      stagingFileName: `..\\${EXPORT_FILE}`,
      bytes,
    }), /DATA_BACKUP_STAGING_FILE_INVALID/u);
    assert.throws(() => writeDataBackupStagingFile({
      stagingDirectory: '',
      stagingFileName: EXPORT_FILE,
      bytes,
    }), /DATA_BACKUP_STAGING_FILE_INVALID/u);
    assert.throws(() => writeDataBackupStagingFile({
      stagingDirectory: root,
      stagingFileName: 'backup.wzb',
      bytes,
    }), /DATA_BACKUP_STAGING_FILE_INVALID/u);

    writeDataBackupStagingFile({ stagingDirectory: root, stagingFileName: EXPORT_FILE, bytes });
    assert.throws(() => writeDataBackupStagingFile({
      stagingDirectory: root,
      stagingFileName: EXPORT_FILE,
      bytes,
    }), /DATA_BACKUP_STAGING_FILE_EXISTS/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('data backup staging detects hash and byte-count mismatches', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-staging-mismatch-'));
  try {
    const bytes = Buffer.from('opaque-import-package');
    writeFileSync(path.join(root, IMPORT_FILE), bytes, { mode: 0o600 });
    assert.throws(() => readDataBackupStagingFile({
      stagingDirectory: root,
      stagingFileName: IMPORT_FILE,
      expectedSha256: '0'.repeat(64),
      expectedBytes: bytes.byteLength,
    }), /DATA_BACKUP_PACKAGE_HASH_MISMATCH/u);
    assert.throws(() => readDataBackupStagingFile({
      stagingDirectory: root,
      stagingFileName: IMPORT_FILE,
      expectedSha256: sha256(bytes),
      expectedBytes: bytes.byteLength + 1,
    }), /DATA_BACKUP_PACKAGE_SIZE_MISMATCH/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
