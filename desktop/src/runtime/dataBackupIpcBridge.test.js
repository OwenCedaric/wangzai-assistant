import assert from 'node:assert/strict';
import test from 'node:test';
import { createDataBackupIpcBridge } from './dataBackupIpcBridge.js';

const COMMIT_CAPABILITY = Buffer.alloc(32, 9).toString('base64url');

test('data backup IPC prepares, publishes, commits, and cleans a multi-owner batch', async () => {
  const calls = [];
  const removed = [];
  let preparedIndex = 0;
  const handle = createDataBackupIpcBridge({
    requestRecovery: async (input) => {
      calls.push(input);
      if (input.command === 'prepare-user-data-export') {
        preparedIndex += 1;
        return {
          ok: true,
          data: {
            backupId: `batch-backup-${preparedIndex}`,
            stagingFileName: input.stagingFileName,
            packageSha256: String(preparedIndex).repeat(64),
            packageBytes: preparedIndex * 10,
            suggestedFileName: `batch-${preparedIndex}.wzb`,
            dataFingerprint: 'f'.repeat(64),
          },
        };
      }
      return {
        ok: true,
        data: {
          verified: true,
          backupId: input.backupId,
          packageSha256: input.packageSha256,
          packageBytes: input.packageBytes,
        },
      };
    },
    saveVerifiedDataBackup: async () => ({ ok: false }),
    saveVerifiedDataBackupBatch: async ({ items }) => ({
      ok: true,
      verified: true,
      files: items.map((item) => ({
        fileName: item.suggestedFileName,
        packageSha256: item.expectedSha256,
        packageBytes: item.expectedBytes,
      })),
    }),
    createCommitCapability: () => COMMIT_CAPABILITY,
    createExportStagingFileName: (() => {
      let index = 0;
      return () => `data-backup-export-${String(index += 1).padStart(64, '0')}.wzb`;
    })(),
    removeStagedDataBackup: async ({ stagingFileName }) => removed.push(stagingFileName),
  });
  const result = await handle({
    command: 'export-batch',
    items: [
      { owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' }, expectedDataFingerprint: 'a'.repeat(64) },
      { owner: { ownerType: 'purchase_account', ownerId: 'purchase-a' }, expectedDataFingerprint: 'b'.repeat(64) },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.verified, true);
  assert.equal(result.data.backups.length, 2);
  assert.deepEqual(calls.map((call) => call.command), [
    'prepare-user-data-export',
    'prepare-user-data-export',
    'commit-user-data-export',
    'commit-user-data-export',
  ]);
  assert.equal(removed.length, 2);
  assert.equal(JSON.stringify(result).includes('stagingFileName'), false);
});

test('data backup IPC marks every prepared batch export failed when disk publication runs out of space', async () => {
  const calls = [];
  const removed = [];
  let preparedIndex = 0;
  const handle = createDataBackupIpcBridge({
    requestRecovery: async (input) => {
      calls.push(input);
      if (input.command === 'prepare-user-data-export') {
        preparedIndex += 1;
        return {
          ok: true,
          data: {
            backupId: `disk-full-backup-${preparedIndex}`,
            stagingFileName: input.stagingFileName,
            packageSha256: String(preparedIndex).repeat(64),
            packageBytes: preparedIndex * 10,
            suggestedFileName: `disk-full-${preparedIndex}.wzb`,
            dataFingerprint: 'f'.repeat(64),
          },
        };
      }
      return { ok: true, data: { failed: true } };
    },
    saveVerifiedDataBackup: async () => ({ ok: false }),
    saveVerifiedDataBackupBatch: async () => {
      throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    },
    createCommitCapability: () => COMMIT_CAPABILITY,
    createExportStagingFileName: (() => {
      let index = 0;
      return () => `data-backup-export-${String(index += 1).padStart(64, '0')}.wzb`;
    })(),
    removeStagedDataBackup: async ({ stagingFileName }) => removed.push(stagingFileName),
  });

  const result = await handle({
    command: 'export-batch',
    items: [
      { owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' }, expectedDataFingerprint: 'a'.repeat(64) },
      { owner: { ownerType: 'purchase_account', ownerId: 'purchase-a' }, expectedDataFingerprint: 'b'.repeat(64) },
    ],
  });
  assert.deepEqual(result, { ok: false, status: 500, error: 'DATA_BACKUP_DISK_FULL' });
  assert.deepEqual(calls.map((call) => call.command), [
    'prepare-user-data-export',
    'prepare-user-data-export',
    'fail-user-data-export',
    'fail-user-data-export',
  ]);
  assert.equal(calls.some((call) => call.command === 'commit-user-data-export'), false);
  assert.equal(calls.filter((call) => call.command === 'fail-user-data-export')
    .every((call) => call.failureCode === 'DATA_BACKUP_DISK_FULL'), true);
  assert.equal(removed.length, 2);
});

test('data backup IPC keeps package bytes in Main and returns only a verified summary', async () => {
  const calls = [];
  const handle = createDataBackupIpcBridge({
    requestRecovery: async (input) => {
      calls.push(input);
      if (input.command === 'prepare-user-data-export') {
        return {
          ok: true,
          status: 200,
          data: {
            backupId: 'data_backup_test',
            contentB64u: 'b3BhcXVl',
            packageSha256: 'a'.repeat(64),
            packageBytes: 6,
            suggestedFileName: 'backup.wzb',
            commitCapability: COMMIT_CAPABILITY,
            snapshot: { databasePath: 'C:/private/restore.sqlite' },
            dataFingerprint: 'b'.repeat(64),
            totalRecords: 5,
          },
        };
      }
      if (input.command === 'commit-user-data-export') {
        return { ok: true, status: 200, data: { verified: true, verifiedAt: '2026-07-17T00:00:00.000Z' } };
      }
      return { ok: true, status: 200, data: { ok: true } };
    },
    saveVerifiedDataBackup: async (input) => {
      assert.equal(input.contentB64u, 'b3BhcXVl');
      return {
        ok: true,
        verified: true,
        fileName: 'user-selected.wzb',
        packageSha256: 'a'.repeat(64),
        packageBytes: 6,
      };
    },
    createCommitCapability: () => COMMIT_CAPABILITY,
  });
  const result = await handle({
    command: 'export',
    shopId: 'shop-a',
    expectedDataFingerprint: 'b'.repeat(64),
    selectedDomains: ['shops', 'shop-credentials', 'purchase-overrides'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.verified, true);
  assert.equal(result.data.fileName, 'backup.wzb');
  assert.equal(JSON.stringify(result).includes('user-selected.wzb'), false);
  assert.equal(JSON.stringify(result).includes('contentB64u'), false);
  assert.equal(JSON.stringify(result).includes(COMMIT_CAPABILITY), false);
  assert.equal(JSON.stringify(result).includes('restore.sqlite'), false);
  assert.equal(calls.every((call) => call.commitCapability === COMMIT_CAPABILITY), true);
  assert.deepEqual(calls.map((call) => call.command), [
    'prepare-user-data-export',
    'commit-user-data-export',
  ]);
  assert.deepEqual(calls[0].owner, { ownerType: 'ozon_shop', ownerId: 'shop-a' });
  assert.deepEqual(calls[0].selectedDomains, ['shops', 'shop-credentials', 'purchase-overrides']);
});

test('data backup IPC uses an opaque staging file for unbounded local export and removes it after publish', async () => {
  const calls = [];
  const removed = [];
  const stagingFileName = `data-backup-export-${'ab'.repeat(32)}.wzb`;
  const handle = createDataBackupIpcBridge({
    requestRecovery: async (input) => {
      calls.push(input);
      if (input.command === 'prepare-user-data-export') {
        assert.equal(input.stagingFileName, stagingFileName);
        return {
          ok: true,
          data: {
            backupId: 'data_backup_staged',
            stagingFileName,
            packageSha256: 'a'.repeat(64),
            packageBytes: 50 * 1024 * 1024,
            suggestedFileName: 'backup.wzb',
          },
        };
      }
      return { ok: true, data: { verified: true, backupId: 'data_backup_staged' } };
    },
    saveVerifiedDataBackup: async (input) => {
      assert.equal(input.stagingFileName, stagingFileName);
      assert.equal(input.contentB64u, undefined);
      return {
        ok: true,
        verified: true,
        packageSha256: 'a'.repeat(64),
        packageBytes: 50 * 1024 * 1024,
      };
    },
    createCommitCapability: () => COMMIT_CAPABILITY,
    createExportStagingFileName: () => stagingFileName,
    removeStagedDataBackup: async (input) => removed.push(input.stagingFileName),
  });

  const result = await handle({ command: 'export', shopId: 'shop-a' });
  assert.equal(result.ok, true);
  assert.deepEqual(removed, [stagingFileName]);
  assert.equal(JSON.stringify(result).includes(stagingFileName), false);
  assert.deepEqual(calls.map((call) => call.command), [
    'prepare-user-data-export',
    'commit-user-data-export',
  ]);
});

test('data backup IPC forwards an explicit non-Ozon owner without renderer-visible bytes', async () => {
  const calls = [];
  const handle = createDataBackupIpcBridge({
    requestRecovery: async (input) => {
      calls.push(input);
      if (input.command === 'prepare-user-data-export') {
        return {
          ok: true,
          data: {
            backupId: 'data_backup_purchase',
            contentB64u: 'b3BhcXVl',
            packageSha256: 'a'.repeat(64),
            packageBytes: 6,
            suggestedFileName: 'backup.wzb',
          },
        };
      }
      return { ok: true, data: { verified: true, backupId: 'data_backup_purchase' } };
    },
    saveVerifiedDataBackup: async () => ({
      ok: true,
      verified: true,
      fileName: 'backup.wzb',
      packageSha256: 'a'.repeat(64),
      packageBytes: 6,
    }),
    createCommitCapability: () => COMMIT_CAPABILITY,
  });
  const owner = { ownerType: 'purchase_account', ownerId: 'purchase-a' };
  const result = await handle({ command: 'export', owner });
  assert.equal(result.data.verified, true);
  assert.deepEqual(calls[0].owner, owner);
  assert.equal(JSON.stringify(result).includes('contentB64u'), false);
});

test('data backup IPC cancellation marks the prepared export failed and never reports verified', async () => {
  const calls = [];
  const handle = createDataBackupIpcBridge({
    requestRecovery: async (input) => {
      calls.push(input);
      if (input.command === 'prepare-user-data-export') {
        return {
          ok: true,
          data: {
            backupId: 'data_backup_cancel',
            contentB64u: 'b3BhcXVl',
            packageSha256: 'a'.repeat(64),
            packageBytes: 6,
            suggestedFileName: 'backup.wzb',
          },
        };
      }
      return { ok: true, data: { ok: true } };
    },
    saveVerifiedDataBackup: async () => ({ ok: true, canceled: true, verified: false }),
    createCommitCapability: () => COMMIT_CAPABILITY,
  });
  const result = await handle({ command: 'export', shopId: 'shop-a' });
  assert.equal(result.data.canceled, true);
  assert.equal(result.data.verified, false);
  assert.equal(calls.every((call) => call.commitCapability === COMMIT_CAPABILITY), true);
  assert.equal(JSON.stringify(result).includes(COMMIT_CAPABILITY), false);
  assert.deepEqual(calls.map((call) => call.command), [
    'prepare-user-data-export',
    'fail-user-data-export',
  ]);
});

test('data backup IPC never commits when the trusted writer does not prove verified readback', async () => {
  const calls = [];
  const handle = createDataBackupIpcBridge({
    requestRecovery: async (input) => {
      calls.push(input);
      if (input.command === 'prepare-user-data-export') {
        return {
          ok: true,
          data: {
            backupId: 'data_backup_unverified',
            contentB64u: 'b3BhcXVl',
            packageSha256: 'a'.repeat(64),
            packageBytes: 6,
            suggestedFileName: 'backup.wzb',
          },
        };
      }
      return { ok: true, data: { ok: true } };
    },
    saveVerifiedDataBackup: async () => ({
      ok: false,
      canceled: false,
      verified: false,
      packageSha256: 'a'.repeat(64),
      packageBytes: 6,
    }),
    createCommitCapability: () => COMMIT_CAPABILITY,
  });

  const result = await handle({ command: 'export', shopId: 'shop-a' });
  assert.equal(result.ok, false);
  assert.deepEqual(calls.map((call) => call.command), [
    'prepare-user-data-export',
    'fail-user-data-export',
  ]);
});

test('data backup IPC keeps imported package bytes in Main across passwordless preflight and one-shot confirm', async () => {
  const calls = [];
  const SESSION_ID = Buffer.alloc(32, 4).toString('base64url');
  const previewFingerprint = 'd'.repeat(64);
  const handle = createDataBackupIpcBridge({
    requestRecovery: async () => ({ ok: false }),
    requestDataBackupImport: async (input) => {
      calls.push(input);
      if (input.command === 'preflight') {
        return {
          ok: true,
          status: 200,
          data: {
            importId: 'private-preflight-import',
            previewFingerprint,
            totalRecords: 3,
            summary: { incoming: 3, added: 2, conflicts: 1 },
            sourceShop: { shopId: 'old-private-id', displayName: '原店铺' },
            targetShop: { shopId: 'shop-current', displayName: '当前店铺' },
            domains: [
              { domain: 'purchase-overrides', label: '采购补录', recordCount: 3 },
              { domain: 'future-private-domain', recordCount: 0 },
            ],
          },
        };
      }
      return {
        ok: true,
        status: 200,
        data: {
          importId: 'restore-1',
          verified: true,
          restored: true,
          totalRecords: 3,
          summary: { added: 2, preserved: 1 },
        },
      };
    },
    saveVerifiedDataBackup: async () => ({ ok: false }),
    selectVerifiedDataBackup: async () => ({
      ok: true,
      canceled: false,
      fileName: 'private-name.wzb',
      contentB64u: 'c2VjcmV0LWJ5dGVz',
      packageSha256: 'a'.repeat(64),
      packageBytes: 12,
    }),
    createImportSessionId: () => SESSION_ID,
  });

  const preflight = await handle({
    command: 'preflight-import',
    targetShopId: 'shop-current',
  });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.data.sessionId, SESSION_ID);
  assert.equal(preflight.data.previewFingerprint, previewFingerprint);
  assert.equal(preflight.data.domains[1].label, '其他用户数据');
  assert.equal(JSON.stringify(preflight.data.domains).includes('future-private-domain"'), true);
  assert.equal(JSON.stringify(preflight).includes('contentB64u'), false);
  assert.equal(JSON.stringify(preflight).includes('secret-bytes'), false);
  assert.equal(calls.some((call) => Object.hasOwn(call, 'passphrase')), false);
  assert.equal(JSON.stringify(preflight).includes('private-name.wzb'), false);
  assert.equal(JSON.stringify(preflight).includes('private-preflight-import'), false);

  const committed = await handle({
    command: 'commit-import',
    sessionId: SESSION_ID,
    previewFingerprint,
    // A renderer cannot change the merge policy after preview.
    conflictMode: 'overwrite',
  });
  assert.equal(committed.ok, true);
  assert.equal(committed.data.verified, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].contentB64u, 'c2VjcmV0LWJ5dGVz');
  assert.equal(calls[1].passphrase, undefined);
  assert.equal(calls[1].importId, 'private-preflight-import');
  assert.equal(calls[1].conflictMode, 'preserve');
  assert.equal(JSON.stringify(committed).includes('contentB64u'), false);

  const replay = await handle({
    command: 'commit-import',
    sessionId: SESSION_ID,
    previewFingerprint,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.error, 'DATA_BACKUP_IMPORT_SESSION_EXPIRED');
});

test('data backup IPC keeps only an opaque local staging reference across import preflight and confirm', async () => {
  const calls = [];
  let cleanupCount = 0;
  const SESSION_ID = Buffer.alloc(32, 5).toString('base64url');
  const previewFingerprint = 'e'.repeat(64);
  const stagingFileName = `data-backup-import-${'cd'.repeat(32)}.wzb`;
  const handle = createDataBackupIpcBridge({
    requestRecovery: async () => ({ ok: false }),
    requestDataBackupImport: async (input) => {
      calls.push(input);
      assert.equal(input.stagingFileName, stagingFileName);
      assert.equal(input.contentB64u, undefined);
      return input.command === 'preflight'
        ? { ok: true, data: { previewFingerprint, totalRecords: 1 } }
        : { ok: true, data: { importId: 'restore-staged', verified: true } };
    },
    saveVerifiedDataBackup: async () => ({ ok: false }),
    selectVerifiedDataBackup: async () => ({
      ok: true,
      canceled: false,
      stagingFileName,
      packageSha256: 'a'.repeat(64),
      packageBytes: 70 * 1024 * 1024,
      cleanup: async () => { cleanupCount += 1; },
    }),
    createImportSessionId: () => SESSION_ID,
  });
  const preflight = await handle({
    command: 'preflight-import',
    targetShopId: 'shop-current',
  });
  assert.equal(preflight.ok, true);
  assert.equal(cleanupCount, 0);
  const confirmed = await handle({
    command: 'commit-import',
    sessionId: SESSION_ID,
    previewFingerprint,
  });
  assert.equal(confirmed.ok, true);
  assert.equal(cleanupCount, 1);
  assert.equal(calls.length, 2);
});

test('data backup IPC import cancel and preview mismatch never call confirm', async () => {
  let calls = 0;
  const SESSION_ID = Buffer.alloc(32, 5).toString('base64url');
  const canceled = createDataBackupIpcBridge({
    requestRecovery: async () => ({ ok: false }),
    requestDataBackupImport: async () => { calls += 1; return { ok: false }; },
    saveVerifiedDataBackup: async () => ({ ok: false }),
    selectVerifiedDataBackup: async () => ({ ok: true, canceled: true }),
  });
  const canceledResult = await canceled({
    command: 'preflight-import',
    targetShopId: 'shop-current',
  });
  assert.equal(canceledResult.data.canceled, true);
  assert.equal(calls, 0);

  const mismatch = createDataBackupIpcBridge({
    requestRecovery: async () => ({ ok: false }),
    requestDataBackupImport: async (input) => {
      calls += 1;
      return input.command === 'preflight'
        ? { ok: true, data: { previewFingerprint: 'e'.repeat(64) } }
        : { ok: true, data: { verified: true } };
    },
    saveVerifiedDataBackup: async () => ({ ok: false }),
    selectVerifiedDataBackup: async () => ({
      contentB64u: 'b3BhcXVl', packageSha256: 'a'.repeat(64), packageBytes: 6,
    }),
    createImportSessionId: () => SESSION_ID,
  });
  await mismatch({
    command: 'preflight-import',
    targetShopId: 'shop-current',
  });
  const result = await mismatch({
    command: 'commit-import',
    sessionId: SESSION_ID,
    previewFingerprint: 'f'.repeat(64),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'DATA_BACKUP_IMPORT_PREVIEW_MISMATCH');
  assert.equal(calls, 1);
});

test('data backup IPC keeps a legacy passphrase in Main until one-shot confirm and never returns it', async () => {
  const calls = [];
  const SESSION_ID = Buffer.alloc(32, 6).toString('base64url');
  const previewFingerprint = 'e'.repeat(64);
  const handle = createDataBackupIpcBridge({
    requestRecovery: async () => ({ ok: false }),
    requestDataBackupImport: async (input) => {
      calls.push(input);
      if (input.command === 'preflight') {
        return {
          ok: true,
          data: {
            importId: 'legacy-import',
            previewFingerprint,
            targetOwner: {
              ownerType: 'purchase_account',
              ownerId: 'purchase-a',
              displayName: '采购账号',
            },
            summary: { total: 1 },
          },
        };
      }
      return {
        ok: true,
        data: { importId: 'legacy-import', verified: true, summary: { total: 1 } },
      };
    },
    saveVerifiedDataBackup: async () => ({ ok: false }),
    saveVerifiedDataBackupBatch: async () => ({ ok: false }),
    selectVerifiedDataBackup: async () => ({
      ok: true,
      contentB64u: 'bGVnYWN5LXBhY2thZ2U',
      packageSha256: 'a'.repeat(64),
      packageBytes: 14,
    }),
    createImportSessionId: () => SESSION_ID,
  });
  const preflight = await handle({
    command: 'preflight-import',
    targetShopId: '',
    conflictMode: 'preserve',
    passphrase: 'legacy-backup-passphrase',
  });
  assert.equal(preflight.ok, true);
  assert.equal(JSON.stringify(preflight).includes('legacy-backup-passphrase'), false);
  const committed = await handle({
    command: 'commit-import',
    sessionId: SESSION_ID,
    previewFingerprint,
  });
  assert.equal(committed.data.verified, true);
  assert.deepEqual(calls.map((call) => [call.command, call.passphrase]), [
    ['preflight', 'legacy-backup-passphrase'],
    ['confirm', 'legacy-backup-passphrase'],
  ]);
  assert.equal(JSON.stringify(committed).includes('legacy-backup-passphrase'), false);
  const replay = await handle({
    command: 'commit-import',
    sessionId: SESSION_ID,
    previewFingerprint,
  });
  assert.equal(replay.error, 'DATA_BACKUP_IMPORT_SESSION_EXPIRED');
});
