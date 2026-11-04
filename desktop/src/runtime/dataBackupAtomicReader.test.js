import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selectVerifiedDataBackup } from './dataBackupAtomicReader.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('data backup reader verifies one opaque .wzb file for Main without changing it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-reader-'));
  try {
    const bytes = Buffer.from('opaque-encrypted-package');
    const filePath = path.join(root, 'portable.wzb');
    writeFileSync(filePath, bytes);
    const result = await selectVerifiedDataBackup({
      showOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }),
    });
    assert.equal(result.canceled, false);
    assert.equal(result.fileName, 'portable.wzb');
    assert.equal(result.contentB64u, bytes.toString('base64url'));
    assert.equal(result.packageSha256, sha256(bytes));
    assert.equal(result.packageBytes, bytes.byteLength);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('data backup reader treats cancel as non-success and rejects extensions, directories, and empty files', async () => {
  const canceled = await selectVerifiedDataBackup({
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  });
  assert.deepEqual(canceled, { ok: true, canceled: true });

  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-reader-invalid-'));
  try {
    const textPath = path.join(root, 'not-a-backup.txt');
    writeFileSync(textPath, 'no');
    await assert.rejects(() => selectVerifiedDataBackup({
      showOpenDialog: async () => ({ canceled: false, filePaths: [textPath] }),
    }), /DATA_BACKUP_IMPORT_EXTENSION_INVALID/u);

    const backupPath = path.join(root, 'source.wzb');
    const directoryPath = path.join(root, 'directory.wzb');
    writeFileSync(backupPath, 'opaque');
    mkdirSync(directoryPath);
    await assert.rejects(() => selectVerifiedDataBackup({
      showOpenDialog: async () => ({ canceled: false, filePaths: [directoryPath] }),
    }), /DATA_BACKUP_IMPORT_FILE_INVALID/u);

    const emptyPath = path.join(root, 'empty.wzb');
    writeFileSync(emptyPath, '');
    await assert.rejects(() => selectVerifiedDataBackup({
      showOpenDialog: async () => ({ canceled: false, filePaths: [emptyPath] }),
    }), /DATA_BACKUP_IMPORT_FILE_SIZE_INVALID/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('data backup reader stages a package larger than the retired 32 MiB ceiling without loading it into IPC', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-reader-unbounded-'));
  try {
    const filePath = path.join(root, 'large-portable.wzb');
    const stagingDirectory = path.join(root, 'staging');
    writeFileSync(filePath, Buffer.alloc(1));
    truncateSync(filePath, 33 * 1024 * 1024);
    const result = await selectVerifiedDataBackup({
      showOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }),
      stagingDirectory,
      createToken: () => Buffer.alloc(32, 7),
    });
    assert.equal(result.packageBytes, 33 * 1024 * 1024);
    assert.equal(result.contentB64u, undefined);
    assert.equal(result.stagingFileName, `data-backup-import-${'07'.repeat(32)}.wzb`);
    const stagedPath = path.join(stagingDirectory, result.stagingFileName);
    assert.equal(existsSync(stagedPath), true);
    await result.cleanup();
    assert.equal(existsSync(stagedPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
