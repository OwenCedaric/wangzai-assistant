import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  saveVerifiedDataBackup,
  saveVerifiedDataBackupBatch,
} from './dataBackupAtomicWriter.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('data backup writer fsyncs an opaque package and returns no absolute path', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-writer-'));
  try {
    const bytes = Buffer.from('opaque-encrypted-backup-package');
    const target = path.join(root, 'export.wzb');
    const result = await saveVerifiedDataBackup({
      contentB64u: bytes.toString('base64url'),
      expectedSha256: sha256(bytes),
      expectedBytes: bytes.byteLength,
      suggestedFileName: 'suggested.wzb',
      backupDirectory: root,
      showSaveDialog: async () => ({ canceled: false, filePath: target }),
      createId: () => 'writer-test',
    });
    assert.deepEqual(result, {
      ok: true,
      canceled: false,
      verified: true,
      fileName: 'export.wzb',
      packageSha256: sha256(bytes),
      packageBytes: bytes.byteLength,
    });
    assert.deepEqual(readFileSync(target), bytes);
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('data backup writer publishes a trusted staging file without a base64 renderer payload', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-writer-staged-'));
  try {
    const bytes = Buffer.from('opaque-staged-backup-package');
    const stagingDirectory = path.join(root, 'staging');
    const stagingFileName = `data-backup-export-${'ab'.repeat(32)}.wzb`;
    const stagingPath = path.join(stagingDirectory, stagingFileName);
    const target = path.join(root, 'published.wzb');
    mkdirSync(stagingDirectory, { recursive: true });
    writeFileSync(stagingPath, bytes);
    const result = await saveVerifiedDataBackup({
      stagingFileName,
      stagingDirectory,
      expectedSha256: sha256(bytes),
      expectedBytes: bytes.byteLength,
      suggestedFileName: 'suggested.wzb',
      backupDirectory: root,
      showSaveDialog: async () => ({ canceled: false, filePath: target }),
      createId: () => 'staged-writer-test',
    });
    assert.equal(result.verified, true);
    assert.deepEqual(readFileSync(target), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('data backup writer never overwrites an existing user file and treats cancel as non-success', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-writer-'));
  try {
    const bytes = Buffer.from('opaque-package');
    const existing = path.join(root, 'existing.wzb');
    writeFileSync(existing, 'keep-existing');
    await assert.rejects(() => saveVerifiedDataBackup({
      contentB64u: bytes.toString('base64url'),
      expectedSha256: sha256(bytes),
      expectedBytes: bytes.byteLength,
      suggestedFileName: 'suggested.wzb',
      backupDirectory: root,
      showSaveDialog: async () => ({ canceled: false, filePath: existing }),
    }), /DATA_BACKUP_TARGET_EXISTS/u);
    assert.equal(readFileSync(existing, 'utf8'), 'keep-existing');
    const canceled = await saveVerifiedDataBackup({
      contentB64u: bytes.toString('base64url'),
      expectedSha256: sha256(bytes),
      expectedBytes: bytes.byteLength,
      suggestedFileName: 'suggested.wzb',
      backupDirectory: root,
      showSaveDialog: async () => ({ canceled: true }),
    });
    assert.equal(canceled.canceled, true);
    assert.equal(canceled.verified, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('data backup writer atomically rejects a target created after its preflight check', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-writer-race-'));
  try {
    const bytes = Buffer.from('opaque-package');
    const target = path.join(root, 'racing-user-file.wzb');
    await assert.rejects(() => saveVerifiedDataBackup({
      contentB64u: bytes.toString('base64url'),
      expectedSha256: sha256(bytes),
      expectedBytes: bytes.byteLength,
      suggestedFileName: 'suggested.wzb',
      backupDirectory: root,
      showSaveDialog: async () => ({ canceled: false, filePath: target }),
      createId: () => {
        writeFileSync(target, 'keep-racing-user-file');
        return 'race-test';
      },
    }), /DATA_BACKUP_TARGET_EXISTS/u);
    assert.equal(readFileSync(target, 'utf8'), 'keep-racing-user-file');
    assert.deepEqual(readdirSync(root), ['racing-user-file.wzb']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('data backup writer fails closed when its managed default directory is missing', async () => {
  const bytes = Buffer.from('opaque-package');
  await assert.rejects(() => saveVerifiedDataBackup({
    contentB64u: bytes.toString('base64url'),
    expectedSha256: sha256(bytes),
    expectedBytes: bytes.byteLength,
    suggestedFileName: 'suggested.wzb',
    showSaveDialog: async () => ({ canceled: true }),
  }), /DATA_BACKUP_DIRECTORY_REQUIRED/u);
});

test('batch backup writer publishes every ordinary wzb file or none', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-batch-'));
  const output = path.join(root, 'output');
  try {
    mkdirSync(output);
    const left = Buffer.from('opaque-batch-left');
    const right = Buffer.from('opaque-batch-right');
    const items = [
      {
        contentB64u: left.toString('base64url'),
        expectedSha256: sha256(left),
        expectedBytes: left.byteLength,
        suggestedFileName: 'left.wzb',
      },
      {
        contentB64u: right.toString('base64url'),
        expectedSha256: sha256(right),
        expectedBytes: right.byteLength,
        suggestedFileName: 'right.wzb',
      },
    ];
    const result = await saveVerifiedDataBackupBatch({
      items,
      backupDirectory: root,
      showDirectoryDialog: async () => ({ canceled: false, filePaths: [output] }),
      createId: (() => { let index = 0; return () => `batch-${index += 1}`; })(),
    });
    assert.equal(result.verified, true);
    assert.equal(result.files.length, 2);
    assert.deepEqual(readFileSync(path.join(output, 'left.wzb')), left);
    assert.deepEqual(readFileSync(path.join(output, 'right.wzb')), right);
    assert.equal(JSON.stringify(result).includes(root), false);

    rmSync(path.join(output, 'left.wzb'));
    rmSync(path.join(output, 'right.wzb'));
    writeFileSync(path.join(output, 'right.wzb'), 'user-owned');
    await assert.rejects(() => saveVerifiedDataBackupBatch({
      items,
      backupDirectory: root,
      showDirectoryDialog: async () => ({ canceled: false, filePaths: [output] }),
    }), /DATA_BACKUP_TARGET_EXISTS/u);
    assert.equal(readFileSync(path.join(output, 'right.wzb'), 'utf8'), 'user-owned');
    assert.equal(readdirSync(output).includes('left.wzb'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('batch backup writer removes every temp and final file when disk publication is interrupted', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-batch-enospc-'));
  const output = path.join(root, 'output');
  try {
    mkdirSync(output);
    const left = Buffer.from('opaque-disk-full-left');
    const right = Buffer.from('opaque-disk-full-right');
    const items = [
      {
        contentB64u: left.toString('base64url'),
        expectedSha256: sha256(left),
        expectedBytes: left.byteLength,
        suggestedFileName: 'disk-left.wzb',
      },
      {
        contentB64u: right.toString('base64url'),
        expectedSha256: sha256(right),
        expectedBytes: right.byteLength,
        suggestedFileName: 'disk-right.wzb',
      },
    ];
    const diskFull = Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    await assert.rejects(() => saveVerifiedDataBackupBatch({
      items,
      backupDirectory: root,
      showDirectoryDialog: async () => ({ canceled: false, filePaths: [output] }),
      createId: (() => { let index = 0; return () => `enospc-${index += 1}`; })(),
      beforePublish: async ({ index }) => {
        if (index === 1) throw diskFull;
      },
    }), (error) => error === diskFull);
    assert.deepEqual(readdirSync(output), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
