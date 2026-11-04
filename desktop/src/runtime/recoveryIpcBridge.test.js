import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryIpcBridge } from './recoveryIpcBridge.js';

test('recovery IPC keeps the staging path in the main process until confirmed activation', async () => {
  const requests = [];
  const activations = [];
  const bridge = createRecoveryIpcBridge({
    requestRecovery: async (input) => {
      requests.push(input);
      return {
        ok: true,
        status: 200,
        data: {
          restoreId: 'restore-1',
          generationId: 'generation-1',
          generationIds: ['generation-1', 'generation-2'],
          mode: 'staging-ready',
          profile: { restored: true },
          shops: [{ shopId: 'shop-a' }, { shopId: 'shop-b' }],
          stagingDatabasePath: 'C:/private/restore-staging/restore-1/restore.sqlite',
          keyEnvelope: { ciphertext: 'must-not-reach-renderer' },
        },
      };
    },
    activateRecovery: async (descriptor) => {
      activations.push(descriptor);
      return { restoreId: descriptor.restoreId, active: true };
    },
  });

  const staged = await bridge({ command: 'stage-restore', generationIds: ['generation-1', 'generation-2'] });
  assert.deepEqual(requests, [{ command: 'stage-restore', generationIds: ['generation-1', 'generation-2'] }]);
  assert.deepEqual(staged, {
    ok: true,
    status: 200,
    data: {
      ok: true,
      restoreId: 'restore-1',
      generationId: 'generation-1',
      generationIds: ['generation-1', 'generation-2'],
      mode: 'staging-ready',
      profile: { restored: true },
      shopCount: 2,
    },
  });

  const activated = await bridge({ command: 'activate-restore', restoreId: 'restore-1' });
  assert.equal(activations.length, 1);
  assert.equal(activations[0].stagingDatabasePath, 'C:/private/restore-staging/restore-1/restore.sqlite');
  assert.deepEqual(activated, { ok: true, status: 200, data: { restoreId: 'restore-1', active: true } });
  assert.deepEqual(await bridge({ command: 'activate-restore', restoreId: 'restore-1' }), {
    ok: false,
    status: 404,
    error: '恢复暂存不存在或已失效。',
  });
});

test('recovery IPC retains a staged restore when activation fails so the user can retry', async () => {
  let attempts = 0;
  const bridge = createRecoveryIpcBridge({
    requestRecovery: async () => ({
      ok: true,
      data: { restoreId: 'restore-retry', generationId: 'generation-retry', shops: [{ shopId: 'shop-a' }] },
    }),
    activateRecovery: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('RECOVERY_ACTIVATION_RESTART_FAILED');
      return { active: true };
    },
  });

  await bridge({ command: 'stage-restore' });
  await assert.rejects(() => bridge({ command: 'activate-restore', restoreId: 'restore-retry' }), /RESTART_FAILED/u);
  assert.deepEqual(await bridge({ command: 'activate-restore', restoreId: 'restore-retry' }), {
    ok: true,
    status: 200,
    data: { active: true },
  });
});

test('recovery IPC does not create an activation capability when staging fails or lacks a restore id', async () => {
  const bridge = createRecoveryIpcBridge({
    requestRecovery: async () => ({ ok: false, status: 400, error: 'RECOVERY_STAGING_FAILED' }),
    activateRecovery: async () => ({ active: true }),
  });

  assert.deepEqual(await bridge({ command: 'stage-restore' }), {
    ok: false,
    status: 400,
    error: 'RECOVERY_STAGING_FAILED',
  });
  assert.deepEqual(await bridge({ command: 'activate-restore', restoreId: 'missing' }), {
    ok: false,
    status: 404,
    error: '恢复暂存不存在或已失效。',
  });
});

test('account removal barrier blocks backup, staging, and activation while allowing its two purge commands', async () => {
  const requests = [];
  const activations = [];
  const bridge = createRecoveryIpcBridge({
    requestRecovery: async (input) => {
      requests.push(input);
      return { ok: true, status: 200, data: { ok: true, verified: true } };
    },
    activateRecovery: async (descriptor) => {
      activations.push(descriptor);
      return { ok: true };
    },
  });
  const previewFingerprint = 'a'.repeat(64);
  assert.equal((await bridge({ command: 'begin-account-removal-barrier', previewFingerprint })).data.fenced, true);
  for (const command of ['backup-shop', 'backup-all-shops', 'stage-restore', 'activate-restore']) {
    assert.deepEqual(await bridge({ command, restoreId: 'restore-fenced' }), {
      ok: false,
      status: 409,
      error: 'ACCOUNT_REMOVAL_RECOVERY_FENCED',
    });
  }
  for (const command of ['purge-account-owner', 'purge-account-owner-protection']) {
    assert.equal((await bridge({ command, operationId: 'operation-1' })).data.verified, true);
  }
  assert.deepEqual(requests.map((request) => request.command), [
    'purge-account-owner',
    'purge-account-owner-protection',
  ]);
  assert.deepEqual(activations, []);
  assert.deepEqual(await bridge({ command: 'end-account-removal-barrier', previewFingerprint }), {
    ok: true,
    status: 200,
    data: { ok: true, released: true, fenced: false },
  });
  assert.equal((await bridge({ command: 'backup-shop' })).ok, true);
});

test('account removal barrier release is never queued behind a slow recovery request', async () => {
  let resolveSlowRequest;
  const slowRequest = new Promise((resolve) => {
    resolveSlowRequest = resolve;
  });
  const bridge = createRecoveryIpcBridge({
    requestRecovery: async () => slowRequest,
    activateRecovery: async () => ({ ok: true }),
  });
  const previewFingerprint = 'b'.repeat(64);
  await bridge({ command: 'begin-account-removal-barrier', previewFingerprint });
  const pendingPurge = bridge({ command: 'purge-account-owner', operationId: 'operation-slow' });

  assert.deepEqual(await bridge({ command: 'end-account-removal-barrier', previewFingerprint }), {
    ok: true,
    status: 200,
    data: { ok: true, released: true, fenced: false },
  });

  resolveSlowRequest({ ok: true, status: 200, data: { ok: true, verified: true } });
  assert.equal((await pendingPurge).data.verified, true);
});

test('barrier acquisition is not blocked by a pending read-only generation listing', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const bridge = createRecoveryIpcBridge({
    requestRecovery: async input => input.command === 'list-generations' ? pending : { ok: true },
    activateRecovery: async () => ({ ok: true }),
  });
  const listing = bridge({ command: 'list-generations' });
  const acquired = await bridge({ command: 'begin-account-removal-barrier', previewFingerprint: 'c'.repeat(64) });
  assert.equal(acquired.data.fenced, true);
  assert.equal((await bridge({ command: 'backup-shop' })).error, 'ACCOUNT_REMOVAL_RECOVERY_FENCED');
  release({ ok: true, data: { generations: [] } });
  await listing;
});

test('barrier acquisition still drains an in-flight backup mutation before acknowledging deletion', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const bridge = createRecoveryIpcBridge({
    requestRecovery: async () => pending,
    activateRecovery: async () => ({ ok: true }),
  });
  const backup = bridge({ command: 'backup-shop' });
  let acknowledged = false;
  const barrier = bridge({ command: 'begin-account-removal-barrier', previewFingerprint: 'd'.repeat(64) })
    .then(result => { acknowledged = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false);
  release({ ok: true });
  await backup;
  assert.equal((await barrier).data.fenced, true);
});

test('recovery activation fails closed when local-api reports a pending account removal after restart', async () => {
  let statusChecks = 0;
  const bridge = createRecoveryIpcBridge({
    requestRecovery: async () => ({ ok: true }),
    activateRecovery: async () => ({ ok: true }),
    hasPendingAccountRemoval: async () => {
      statusChecks += 1;
      return true;
    },
  });
  assert.deepEqual(await bridge({ command: 'activate-restore', restoreId: 'restore-1' }), {
    ok: false,
    status: 409,
    error: 'ACCOUNT_REMOVAL_RECOVERY_FENCED',
  });
  assert.equal(statusChecks, 1);
});

test('generic renderer recovery IPC rejects data-backup capabilities and unknown commands', async () => {
  const forwarded = [];
  const bridge = createRecoveryIpcBridge({
    requestRecovery: async (input) => {
      forwarded.push(input);
      return { ok: true, status: 200, data: { contentB64u: 'must-not-reach-renderer' } };
    },
    activateRecovery: async () => ({ ok: true }),
  });

  for (const command of [
    'prepare-user-data-export',
    'commit-user-data-export',
    'fail-user-data-export',
    'future-unreviewed-command',
  ]) {
    assert.deepEqual(await bridge({
      command,
      passphrase: 'renderer-chosen-passphrase',
      commitCapability: Buffer.alloc(32, 1).toString('base64url'),
    }), {
      ok: false,
      status: 403,
      error: 'RECOVERY_RENDERER_COMMAND_NOT_ALLOWED',
    });
  }
  assert.deepEqual(forwarded, []);
});
