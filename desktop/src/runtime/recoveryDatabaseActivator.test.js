import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activateRecoveryDatabase } from './recoveryDatabaseActivator.js';
import { resolveDataLayout } from './dataLayout.js';
import {
  clearProfileDatabaseRecoveryRequired,
  ensureProfileMetadata,
  markProfileDatabaseInitialized,
  markProfileDatabaseRecoveryRequired,
} from './profileMetadata.js';

function setupFiles() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-recovery-activate-'));
  const activeDatabasePath = path.join(root, 'local-api', 'data', 'ozon-cache.sqlite');
  const stagingDatabasePath = path.join(root, 'local-api', 'data', 'restore-staging', 'restore-1', 'restore.sqlite');
  fs.mkdirSync(path.dirname(activeDatabasePath), { recursive: true });
  fs.mkdirSync(path.dirname(stagingDatabasePath), { recursive: true });
  fs.writeFileSync(activeDatabasePath, 'old-active');
  fs.writeFileSync(`${activeDatabasePath}-wal`, 'old-wal');
  fs.writeFileSync(stagingDatabasePath, 'new-restored');
  return { root, activeDatabasePath, stagingDatabasePath };
}

test('recovery database activator switches only a validated staging path and preserves active family as rollback', async () => {
  const fixture = setupFiles();
  try {
    const result = await activateRecoveryDatabase({
      descriptor: { restoreId: 'restore-1', stagingDatabasePath: fixture.stagingDatabasePath },
      activeDatabasePath: fixture.activeDatabasePath,
      stopServices: async () => undefined,
      startServices: async () => undefined,
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });
    assert.equal(result.mode, 'activated');
    assert.equal(fs.readFileSync(fixture.activeDatabasePath, 'utf8'), 'new-restored');
    assert.equal(fs.readFileSync(path.join(result.rollbackDirectory, 'ozon-cache.sqlite'), 'utf8'), 'old-active');
    assert.equal(fs.readFileSync(path.join(result.rollbackDirectory, 'ozon-cache.sqlite-wal'), 'utf8'), 'old-wal');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('recovery database activator restores the old database when restart fails', async () => {
  const fixture = setupFiles();
  let starts = 0;
  try {
    await assert.rejects(
      activateRecoveryDatabase({
        descriptor: { restoreId: 'restore-1', stagingDatabasePath: fixture.stagingDatabasePath },
        activeDatabasePath: fixture.activeDatabasePath,
        stopServices: async () => undefined,
        startServices: async () => {
          starts += 1;
          if (starts === 1) throw new Error('new local-api failed');
        },
      }),
      /RECOVERY_ACTIVATION_FAILED:new local-api failed/,
    );
    assert.equal(fs.readFileSync(fixture.activeDatabasePath, 'utf8'), 'old-active');
    assert.equal(starts, 2);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('recovery database activator prepares normal startup after switch and recovery startup after rollback', async () => {
  const fixture = setupFiles();
  const calls = [];
  let starts = 0;
  try {
    await assert.rejects(
      activateRecoveryDatabase({
        descriptor: { restoreId: 'restore-1', stagingDatabasePath: fixture.stagingDatabasePath },
        activeDatabasePath: fixture.activeDatabasePath,
        stopServices: async () => calls.push('stop'),
        prepareActivatedServices: async () => calls.push('prepare-activated'),
        prepareRollbackServices: async () => calls.push('prepare-rollback'),
        startServices: async () => {
          calls.push('start');
          starts += 1;
          if (starts === 1) throw new Error('new local-api failed');
        },
      }),
      /RECOVERY_ACTIVATION_FAILED:new local-api failed/,
    );
    assert.deepEqual(calls, [
      'stop',
      'prepare-activated',
      'start',
      'stop',
      'prepare-rollback',
      'start',
    ]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('recovery shell marker clears only for a successfully activated canonical database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-recovery-profile-'));
  try {
    const layout = resolveDataLayout({ dataRoot: root });
    const fresh = ensureProfileMetadata(layout, { createId: () => 'profile-restore' });
    const initialized = markProfileDatabaseInitialized(layout, fresh);
    const recovery = markProfileDatabaseRecoveryRequired(layout, initialized);
    const stagingPath = path.join(
      path.dirname(layout.databasePath),
      'restore-staging',
      'restore-profile',
      'restore.sqlite',
    );
    fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
    fs.writeFileSync(stagingPath, 'restored-canonical-data', 'utf8');
    let activeProfile = recovery;

    const result = await activateRecoveryDatabase({
      descriptor: { restoreId: 'restore-profile', stagingDatabasePath: stagingPath },
      activeDatabasePath: layout.databasePath,
      stopServices: async () => undefined,
      prepareActivatedServices: async () => {
        activeProfile = clearProfileDatabaseRecoveryRequired(layout, activeProfile);
      },
      startServices: async () => {
        assert.equal(activeProfile.databaseLifecycle, 'initialized');
        assert.equal(fs.readFileSync(layout.databasePath, 'utf8'), 'restored-canonical-data');
      },
    });

    assert.equal(result.mode, 'activated');
    assert.equal(activeProfile.databaseRecoveryRequiredAt, '');
    assert.equal(fs.readFileSync(layout.databasePath, 'utf8'), 'restored-canonical-data');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed activation restores the recovery shell marker before fallback startup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-recovery-profile-'));
  try {
    const layout = resolveDataLayout({ dataRoot: root });
    const fresh = ensureProfileMetadata(layout, { createId: () => 'profile-restore' });
    const initialized = markProfileDatabaseInitialized(layout, fresh);
    let activeProfile = markProfileDatabaseRecoveryRequired(layout, initialized);
    const stagingPath = path.join(
      path.dirname(layout.databasePath),
      'restore-staging',
      'restore-profile',
      'restore.sqlite',
    );
    fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
    fs.writeFileSync(stagingPath, 'broken-restored-canonical-data', 'utf8');
    let starts = 0;

    await assert.rejects(
      activateRecoveryDatabase({
        descriptor: { restoreId: 'restore-profile', stagingDatabasePath: stagingPath },
        activeDatabasePath: layout.databasePath,
        stopServices: async () => undefined,
        prepareActivatedServices: async () => {
          activeProfile = clearProfileDatabaseRecoveryRequired(layout, activeProfile);
        },
        prepareRollbackServices: async () => {
          activeProfile = markProfileDatabaseRecoveryRequired(layout, activeProfile);
        },
        startServices: async () => {
          starts += 1;
          if (starts === 1) {
            assert.equal(activeProfile.databaseLifecycle, 'initialized');
            throw new Error('restored service failed');
          }
          assert.equal(activeProfile.databaseLifecycle, 'recovery-required');
          assert.equal(fs.existsSync(layout.databasePath), false);
        },
      }),
      /RECOVERY_ACTIVATION_FAILED:restored service failed/,
    );
    assert.equal(activeProfile.databaseLifecycle, 'recovery-required');
    assert.equal(fs.existsSync(layout.databasePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
