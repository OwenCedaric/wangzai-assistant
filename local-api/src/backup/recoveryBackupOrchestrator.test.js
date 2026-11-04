import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryBackupOrchestrator } from './recoveryBackupOrchestrator.js';
import { openRecoveryGeneration } from './recoveryGeneration.js';
import { createRecoveryKeysetStore } from './recoveryKeysetStore.js';
import { listRecoveryProfileOwners } from './recoveryProfileCore.js';
import { deriveRecoveryOwnerRef } from './recoveryRemoteClient.js';
import { createMigratedTestDb } from '../../test/testDb.js';

const secretCodec = {
  encrypt: (value) => `local:${Buffer.from(value).toString('base64url')}`,
  decrypt: (value) => String(value).startsWith('local:') ? Buffer.from(value.slice(6), 'base64url').toString('utf8') : null,
};

test('recovery orchestrator enrolls once, reuses only encrypted local key material, and uploads opaque generations', async () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`
      INSERT INTO shops (id, name, client_id, api_key_encrypted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'client-a', 'source:api-key-a', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`
      INSERT INTO cross_border_accounts (
        id, name, status, company_secret_encrypted, access_token_encrypted, app_uid_encrypted,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'cross-border-a', 'Cross Border Source', 'active', 'source:company-secret', 'source:access-token', 'source:app-uid',
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO performance_accounts (
        id, name, status, client_id, client_secret_encrypted, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'performance-a', 'Performance Source', 'active', 'performance-client', 'source:performance-secret',
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
    );
    const store = createRecoveryKeysetStore({ db, ...secretCodec, randomUuid: () => '00000000-0000-4000-8000-000000000001' });
    const transports = [];
    const remoteClient = {
      uploadGeneration: async ({ scopeKey, transport }) => {
        transports.push({ scopeKey, transport });
        return { generation_id: `remote-${transports.length}` };
      },
    };
    const orchestrator = createRecoveryBackupOrchestrator({
      db,
      keysetStore: store,
      decryptShopSecret: (value) => String(value).replace(/^source:/u, ''),
      now: () => new Date('2026-07-11T12:00:00.000Z'),
      createGenerationId: () => `generation-${transports.length + 1}`,
    });
    const first = await orchestrator.uploadShop({
      shopId: 'shop-a', passphrase: 'portable recovery passphrase', remoteClient,
    });
    const second = await orchestrator.uploadShop({ shopId: 'shop-a', remoteClient });
    assert.equal(first.remoteGenerationId, 'remote-1');
    assert.equal(second.remoteGenerationId, 'remote-2');
    assert.equal(first.scopeKey, second.scopeKey);
    assert.equal(store.readState().envelope.aad, 'wangzai-recovery:v1:profile:00000000-0000-4000-8000-000000000001');
    assert.equal(db.prepare('SELECT count(*) AS count FROM recovery_local_state').get().count, 1);
    const outside = JSON.stringify(transports);
    for (const hiddenValue of [
      'shop-a', 'api-key-a', 'cross-border-a', 'company-secret', 'access-token', 'app-uid', 'performance-secret',
    ]) {
      assert.equal(outside.includes(hiddenValue), false, `remote transport leaked ${hiddenValue}`);
    }
  } finally {
    db.close();
  }
});

test('recovery orchestrator fences new backup publication and drains an in-flight upload for account removal', async () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`
      INSERT INTO shops (id, name, client_id, api_key_encrypted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('shop-fence', 'Fence Shop', 'client-fence', 'source:api-key', 'active', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    const store = createRecoveryKeysetStore({ db, ...secretCodec, randomUuid: () => '00000000-0000-4000-8000-000000000002' });
    let releaseUpload;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const remoteClient = {
      uploadGeneration: async () => {
        markStarted();
        await new Promise((resolve) => { releaseUpload = resolve; });
        return { generation_id: 'remote-fenced-upload' };
      },
    };
    let durablePending = false;
    const orchestrator = createRecoveryBackupOrchestrator({
      db,
      keysetStore: store,
      decryptShopSecret: (value) => String(value).replace(/^source:/u, ''),
      hasPendingAccountRemoval: () => durablePending,
      now: () => new Date('2026-07-15T00:00:00.000Z'),
      createGenerationId: () => 'generation-fenced-upload',
    });

    const upload = orchestrator.uploadShop({
      shopId: 'shop-fence',
      passphrase: 'portable recovery passphrase',
      remoteClient,
    });
    await started;
    const quiesce = orchestrator.quiesceAccountRemoval(
      { ownerType: 'ozon_shop', ownerId: 'shop-fence' },
      { timeoutMs: 1000 },
    );
    assert.deepEqual(orchestrator.getAccountRemovalStatus(), { fenced: true, active: 1 });
    await assert.rejects(
      () => orchestrator.uploadShop({ shopId: 'shop-fence', remoteClient }),
      /RECOVERY_BACKUP_ACCOUNT_REMOVAL_QUIESCED/u,
    );

    releaseUpload();
    await upload;
    assert.deepEqual(await quiesce, { ok: true, fenced: true, active: 0 });
    assert.equal(orchestrator.releaseAccountRemovalFence().released, true);

    durablePending = true;
    await assert.rejects(
      () => orchestrator.uploadShop({ shopId: 'shop-fence', remoteClient }),
      /RECOVERY_BACKUP_ACCOUNT_REMOVAL_QUIESCED/u,
    );
    durablePending = false;
    assert.deepEqual(orchestrator.getAccountRemovalStatus(), { fenced: false, active: 0 });
  } finally {
    db.close();
  }
});

test('account removal rewrites every shared remote generation, tombstones the owner, and preserves other owners', async () => {
  const db = createMigratedTestDb();
  try {
    const store = createRecoveryKeysetStore({
      db,
      encrypt: (value) => `enc:${value}`,
      decrypt: (value) => value.slice(4),
      randomUuid: () => '00000000-0000-4000-8000-000000000002',
    });
    for (const [id, name, createdAt] of [
      ['shop-a', 'Shop A', '2026-07-10T00:00:00.000Z'],
      ['shop-b', 'Shop B', '2026-07-11T00:00:00.000Z'],
    ]) {
      db.prepare(`INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
        .run(id, name, createdAt, createdAt);
    }
    for (const [id, name, createdAt] of [
      ['purchase-delete', 'Delete Purchase', '2026-07-12T00:00:00.000Z'],
      ['purchase-keep', 'Keep Purchase', '2026-07-13T00:00:00.000Z'],
    ]) {
      db.prepare(`
        INSERT INTO purchase_accounts (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(id, name, createdAt, createdAt);
    }
    const generations = new Map();
    const tombstones = new Set();
    let sequence = 0;
    const remoteClient = {
      async uploadGeneration({ scopeKey, ownerRefs, transport }) {
        if (ownerRefs.some((ownerRef) => tombstones.has(ownerRef))) {
          throw new Error('RECOVERY_REMOTE_OWNER_TOMBSTONED');
        }
        const generationId = `remote-generation-${String(++sequence).padStart(3, '0')}`;
        generations.set(scopeKey, { generation_id: generationId, scope_key: scopeKey, owner_refs: [...ownerRefs], transport });
        return {
          generation_id: generationId,
          scope_key: scopeKey,
          owner_refs: [...ownerRefs],
        };
      },
      async listGenerations() {
        return [...generations.values()].map(({ transport, ...generation }) => ({ ...generation }));
      },
      async downloadGeneration({ generationId }) {
        const generation = [...generations.values()].find((entry) => entry.generation_id === generationId);
        if (!generation) throw new Error('missing generation');
        return generation.transport;
      },
      async purgeOwner({ ownerRef, expectedGenerationIds }) {
        assert.deepEqual(
          [...generations.values()].map((entry) => entry.generation_id).sort(),
          [...expectedGenerationIds].sort(),
        );
        const deletedGenerationIds = [];
        for (const [scopeKey, generation] of generations) {
          if (!generation.owner_refs.length || generation.owner_refs.includes(ownerRef)) {
            deletedGenerationIds.push(generation.generation_id);
            generations.delete(scopeKey);
          }
        }
        tombstones.add(ownerRef);
        return { ownerRef, tombstoned: true, deletedGenerationIds, remainingGenerationCount: generations.size };
      },
      async getOwnerPurgeStatus({ ownerRef }) {
        return { ownerRef, tombstoned: tombstones.has(ownerRef) };
      },
    };
    const orchestrator = createRecoveryBackupOrchestrator({
      db,
      keysetStore: store,
      decryptShopSecret: () => null,
      createGenerationId: () => `local-generation-${String(++sequence).padStart(3, '0')}`,
      now: () => new Date('2026-07-15T00:00:00.000Z'),
    });
    await orchestrator.uploadShop({
      shopId: 'shop-a',
      passphrase: 'portable recovery passphrase',
      remoteClient,
    });
    await orchestrator.uploadShop({ shopId: 'shop-b', remoteClient });
    const oldGenerationIds = (await remoteClient.listGenerations()).map((entry) => entry.generation_id);
    db.prepare('DELETE FROM purchase_accounts WHERE id = ?').run('purchase-delete');
    const result = await orchestrator.purgeAccountOwner({
      owner: { ownerType: 'purchase_account', ownerId: 'purchase-delete' },
      ownerIncarnation: '2026-07-12T00:00:00.000Z',
      remoteClient,
    });
    assert.equal(result.verified, true);
    assert.equal(result.remoteGenerationCount, 2);
    assert.equal(result.rewrittenGenerationCount, 2);
    assert.equal(result.deletedGenerationCount, 0);
    assert.equal(result.tombstoneCount, 1);
    assert.equal(generations.size, 2);
    assert.equal(tombstones.size, 1);
    const { keyset, recoveryAad } = store.readState();
    for (const generationId of oldGenerationIds) {
      await assert.rejects(
        () => remoteClient.downloadGeneration({ generationId }),
        /missing generation/u,
        'an old generation id and the old recovery passphrase must not recover the deleted owner',
      );
    }
    const [deletedOwnerRef] = tombstones;
    const reboundOwnerRef = deriveRecoveryOwnerRef({
      dedupeKey: keyset.dedupeKey,
      ownerType: 'purchase_account',
      ownerId: 'purchase-delete',
      ownerIncarnation: '2026-07-16T00:00:00.000Z',
    });
    assert.notEqual(reboundOwnerRef, deletedOwnerRef);
    assert.equal(tombstones.has(reboundOwnerRef), false);
    await assert.rejects(
      () => remoteClient.uploadGeneration({
        scopeKey: 'stale-device-scope',
        ownerRefs: [deletedOwnerRef],
        transport: {},
      }),
      /RECOVERY_REMOTE_OWNER_TOMBSTONED/u,
    );
    for (const generation of generations.values()) {
      const opened = openRecoveryGeneration({
        transport: generation.transport,
        encryptionKey: keyset.chunkEncryptionKey,
        aad: recoveryAad,
      });
      assert.deepEqual(
        listRecoveryProfileOwners({
          candidate: opened.profileCandidate,
          encryptionKey: keyset.chunkEncryptionKey,
          aad: recoveryAad,
        }).filter((owner) => owner.ownerType === 'purchase_account').map((owner) => owner.ownerId),
        ['purchase-keep'],
      );
    }
  } finally {
    db.close();
  }
});
