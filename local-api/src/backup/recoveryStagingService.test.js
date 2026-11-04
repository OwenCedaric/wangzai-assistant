import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createRecoveryExporter } from './recoveryExporter.js';
import { createRecoveryGeneration } from './recoveryGeneration.js';
import { createRecoveryKeyEnvelope, generateRecoveryKeyset } from './recoveryKeyEnvelope.js';
import { createRecoveryProfileCore } from './recoveryProfileCore.js';
import { createRecoveryStagingService } from './recoveryStagingService.js';
import { createMigratedTestDb } from '../../test/testDb.js';

test('durable pending account removal keeps restore staging fenced across runtime release or restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-recovery-stage-fence-'));
  let pending = true;
  try {
    const stagingService = createRecoveryStagingService({
      config: { database: { path: join(root, 'active.sqlite') } },
      hasPendingAccountRemoval: () => pending,
    });
    assert.deepEqual(stagingService.getAccountRemovalStatus(), { fenced: true, active: 0 });
    await assert.rejects(
      () => stagingService.stageRemoteGeneration({}),
      /RECOVERY_STAGING_ACCOUNT_REMOVAL_QUIESCED/u,
    );
    assert.deepEqual(stagingService.releaseAccountRemovalFence(), {
      ok: true,
      released: false,
      fenced: true,
      active: 0,
    });
    pending = false;
    assert.deepEqual(stagingService.getAccountRemovalStatus(), { fenced: false, active: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery staging service creates and validates a closed new database without touching the active database path', async () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'recovery-staging-service-test-secret-123456';
  const source = createMigratedTestDb();
  const root = mkdtempSync(join(tmpdir(), 'wangzai-recovery-stage-'));
  try {
    source.prepare(`
      INSERT INTO shops (id, name, client_id, api_key_encrypted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'client-a', 'source:api-key-a', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    source.prepare(`
      INSERT INTO purchase_order_overrides (shop_id, order_key, source_cost_cny, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'order-1', 12.5, '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const keyset = generateRecoveryKeyset((size) => Buffer.alloc(size, size + 20));
    const aad = 'wangzai-recovery:v1:profile:00000000-0000-4000-8000-000000000003';
    const envelope = createRecoveryKeyEnvelope({ keyset, passphrase: 'portable recovery passphrase', aad });
    const profileCandidate = createRecoveryProfileCore({
      db: source,
      decryptShopSecret: (value) => String(value).replace(/^source:/u, ''),
    }).buildCandidate({ encryptionKey: keyset.chunkEncryptionKey, dedupeKey: keyset.dedupeKey, aad });
    const shopCandidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey: keyset.chunkEncryptionKey, dedupeKey: keyset.dedupeKey, aad,
    });
    const transport = createRecoveryGeneration({
      profileCandidate,
      shopCandidate,
      keyEnvelope: envelope,
      encryptionKey: keyset.chunkEncryptionKey,
      dedupeKey: keyset.dedupeKey,
      aad,
      generationId: 'stage-generation-1',
      createdAt: '2026-07-11T12:00:00.000Z',
    });
    const activePath = join(root, 'active.sqlite');
    const restoreIds = [
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
    ];
    const stagingService = createRecoveryStagingService({
      config: { database: { path: activePath, enableWal: true, busyTimeoutMs: 5000 } },
      randomUuid: () => restoreIds.shift(),
    });
    const staged = await stagingService.stageRemoteGeneration({
      remoteClient: { downloadGeneration: async () => transport },
      generationId: 'remote-generation-id',
      passphrase: 'portable recovery passphrase',
    });
    assert.equal(staged.mode, 'staging-ready');
    assert.equal(staged.stagingDatabasePath.endsWith('restore.sqlite'), true);
    assert.equal(existsSync(activePath), false);
    const stagedDb = new DatabaseSync(staged.stagingDatabasePath);
    try {
      assert.equal(stagedDb.prepare('SELECT count(*) AS count FROM purchase_order_overrides').get().count, 1);
      const reconcile = stagedDb.prepare(`
        SELECT restore_id, generation_id, shop_id, status, overlap_minutes
        FROM recovery_reconcile_state
      `).get();
      assert.deepEqual({ ...reconcile }, {
        restore_id: '00000000-0000-4000-8000-000000000004',
        generation_id: 'stage-generation-1',
        shop_id: 'shop-a',
        status: 'pending',
        overlap_minutes: 30,
      });
    } finally {
      stagedDb.close();
    }
    let releaseDownload;
    let markDownloadStarted;
    const downloadStarted = new Promise((resolve) => { markDownloadStarted = resolve; });
    const downloadGate = new Promise((resolve) => { releaseDownload = resolve; });
    const inFlightStage = stagingService.stageRemoteGeneration({
      remoteClient: {
        async downloadGeneration() {
          markDownloadStarted();
          await downloadGate;
          return transport;
        },
      },
      generationId: 'remote-generation-in-flight',
      passphrase: 'portable recovery passphrase',
    });
    await downloadStarted;
    let quiesceResolved = false;
    const quiesce = stagingService
      .quiesceAccountRemoval({ ownerType: 'ozon_shop', ownerId: 'shop-a' })
      .then((result) => {
        quiesceResolved = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(quiesceResolved, false);
    assert.deepEqual(stagingService.getAccountRemovalStatus(), { fenced: true, active: 1 });
    await assert.rejects(
      () => stagingService.stageRemoteGeneration({}),
      /RECOVERY_STAGING_ACCOUNT_REMOVAL_QUIESCED/u,
    );
    releaseDownload();
    await inFlightStage;
    assert.deepEqual(await quiesce, {
      ok: true,
      fenced: true,
      active: 0,
    });
    await assert.rejects(
      () => stagingService.stageRemoteGeneration({}),
      /RECOVERY_STAGING_ACCOUNT_REMOVAL_QUIESCED/u,
    );
    assert.deepEqual(stagingService.releaseAccountRemovalFence(), {
      ok: true,
      released: true,
      fenced: false,
      active: 0,
    });
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});
