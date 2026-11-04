import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase, runMigrations } from '../db/database.js';
import { createAccountRemovalOwnerRef } from '../db/repositories/accountRemovalOperationRepository.js';
import {
  createAccountRemovalProtectionService,
  discoverAccountRemovalProtectionFamilies,
  scrubAccountRemovalDiagnosticLogs,
} from './accountRemovalProtectionService.js';

const TARGET_SECRET = 'protection-target-secret-do-not-retain-7f91d8';

function seedDatabase(databasePath) {
  const db = openDatabase({ database: { path: databasePath, enableWal: true, busyTimeoutMs: 5000 } });
  runMigrations(db);
  const timestamp = '2026-07-15T00:00:00.000Z';
  for (const [id, name, clientId, secret] of [
    ['shop-a', 'Shop A', 'client-a', TARGET_SECRET],
    ['shop-b', 'Shop B', 'client-b', 'preserved-shop-b-secret'],
  ]) {
    db.prepare(`
      INSERT INTO shops (id, name, client_id, api_key_encrypted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(id, name, clientId, secret, timestamp, timestamp);
  }
  db.prepare(`
    INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
    VALUES ('ozon-shop-preferences', ?, ?, ?)
  `).run(JSON.stringify({
    shops: [{ id: 'shop-a', label: 'A' }, { id: 'shop-b', label: 'B' }],
    activeShopId: 'shop-a',
    defaultWarehouseIds: { 'shop-a': 'warehouse-a', 'shop-b': 'warehouse-b' },
    globalDensity: 'compact',
  }), timestamp, timestamp);
  db.prepare(`
    INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
    VALUES ('fixture-system-setting', '{"preserved":true}', ?, ?)
  `).run(timestamp, timestamp);
  db.prepare(`
    INSERT INTO account_removal_operations (
      operation_id, idempotency_key_hash, request_digest, owner_type, owner_ref,
      payload_encrypted, phase, status, preview_fingerprint, catalog_fingerprint,
      snapshot_fingerprint, client_cleanup_nonce, client_resource_ids_json,
      deletion_summary_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'ozon_shop', ?, ?, 'external-delete-pending', 'pending', ?, ?, ?, ?, '[]', '{}', ?, ?)
  `).run(
    'old-copy-operation',
    'idempotency-hash',
    'request-digest',
    createAccountRemovalOwnerRef({ ownerType: 'ozon_shop', ownerId: 'shop-a' }),
    TARGET_SECRET,
    'p'.repeat(64),
    'c'.repeat(64),
    's'.repeat(64),
    'old-copy-cleanup-nonce',
    timestamp,
    timestamp,
  );
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
  db.close();
}

function copyToProtectionFamily(activeDatabasePath, rootName, childName, databaseName) {
  const directory = join(dirname(activeDatabasePath), rootName, childName);
  mkdirSync(directory, { recursive: true });
  const databasePath = join(directory, databaseName);
  copyFileSync(activeDatabasePath, databasePath);
  return databasePath;
}

function readPreservedState(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    return {
      shopB: { ...db.prepare('SELECT * FROM shops WHERE id = ?').get('shop-b') },
      system: { ...db.prepare("SELECT * FROM profile_settings WHERE namespace = 'fixture-system-setting'").get() },
    };
  } finally {
    db.close();
  }
}

test('account removal rewrites every recognized recovery copy, preserves owner B/system data, and physically erases target secrets', () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'account-removal-protection-service-test-key';
  const root = mkdtempSync(join(tmpdir(), 'wangzai-account-protection-'));
  const activeDatabasePath = join(root, 'local-api-data', 'wangzai-local-api.sqlite');
  mkdirSync(dirname(activeDatabasePath), { recursive: true });
  try {
    seedDatabase(activeDatabasePath);
    const copies = [
      copyToProtectionFamily(activeDatabasePath, 'restore-staging', 'restore-a', 'restore.sqlite'),
      copyToProtectionFamily(activeDatabasePath, 'restore-rollback', 'rollback-a', basename(activeDatabasePath)),
      copyToProtectionFamily(activeDatabasePath, 'restore-failed', 'failed-a', basename(activeDatabasePath)),
    ];
    const preservedBefore = copies.map(readPreservedState);

    const result = createAccountRemovalProtectionService({
      activeDatabasePath,
      now: () => '2026-07-15T01:00:00.000Z',
    }).purgeOwner({ owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' } });

    assert.deepEqual(result, {
      ok: true,
      verified: true,
      familyCount: 3,
      familyKinds: { staging: 1, rollback: 1, failed: 1 },
      totalDeletedRows: 12,
      sanitizedOperationCount: 3,
      diagnosticLogs: { verified: true, fileCount: 0, replacementCount: 0 },
    });
    for (const [index, databasePath] of copies.entries()) {
      const db = new DatabaseSync(databasePath);
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?').get('shop-a').count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?').get('shop-b').count, 1);
        const preferences = JSON.parse(db.prepare("SELECT value_json FROM profile_settings WHERE namespace = 'ozon-shop-preferences'").get().value_json);
        assert.deepEqual(preferences, {
          shops: [{ id: 'shop-b', label: 'B' }],
          activeShopId: 'shop-b',
          defaultWarehouseIds: { 'shop-b': 'warehouse-b' },
          globalDensity: 'compact',
        });
        assert.deepEqual(readPreservedState(databasePath), preservedBefore[index]);
        assert.deepEqual(
          { ...db.prepare('SELECT payload_encrypted, client_cleanup_nonce FROM account_removal_operations WHERE operation_id = ?').get('old-copy-operation') },
          { payload_encrypted: null, client_cleanup_nonce: null },
        );
        assert.equal(db.prepare('PRAGMA integrity_check;').get().integrity_check, 'ok');
      } finally {
        db.close();
      }
      assert.equal(readFileSync(databasePath).includes(Buffer.from(TARGET_SECRET, 'utf8')), false);
      for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
        if (existsSync(sidecar)) assert.equal(statSync(sidecar).size, 0);
      }
    }

    const activeDb = new DatabaseSync(activeDatabasePath);
    try {
      assert.equal(activeDb.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?').get('shop-a').count, 1);
    } finally {
      activeDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});

test('protection discovery fails closed on unknown files and never scans outside the three fixed roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-account-protection-layout-'));
  const activeDatabasePath = join(root, 'local-api-data', 'active.sqlite');
  const unexpectedDirectory = join(dirname(activeDatabasePath), 'restore-staging', 'restore-unknown');
  mkdirSync(unexpectedDirectory, { recursive: true });
  writeFileSync(join(unexpectedDirectory, 'unexpected-owner-package.bin'), 'fixture-only', 'utf8');
  try {
    assert.throws(
      () => discoverAccountRemovalProtectionFamilies(activeDatabasePath),
      /ACCOUNT_REMOVAL_PROTECTION_LAYOUT_UNRECOGNIZED/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no recovery copy is a verified zero-family result without creating or touching the active database', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-account-protection-empty-'));
  const activeDatabasePath = join(root, 'local-api-data', 'active.sqlite');
  try {
    const result = createAccountRemovalProtectionService({ activeDatabasePath }).purgeOwner({
      owner: { ownerType: 'purchase_account', ownerId: 'purchase-a' },
    });
    assert.deepEqual(result, {
      ok: true,
      verified: true,
      familyCount: 0,
      familyKinds: { staging: 0, rollback: 0, failed: 0 },
      totalDeletedRows: 0,
      sanitizedOperationCount: 0,
      diagnosticLogs: { verified: true, fileCount: 0, replacementCount: 0 },
    });
    assert.equal(existsSync(activeDatabasePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic log scrub overwrites exact raw and URL-encoded owner ids while preserving other owners', () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'account-removal-diagnostic-log-test-key';
  const root = mkdtempSync(join(tmpdir(), 'wangzai-account-log-scrub-'));
  const logDirectory = join(root, 'logs');
  const owner = { ownerType: 'purchase_account', ownerId: 'purchase:account-a' };
  mkdirSync(logDirectory, { recursive: true });
  writeFileSync(
    join(logDirectory, 'desktop-main.log'),
    'owner=purchase:account-a url=/purchase/purchase%3Aaccount-a keep=purchase:account-ab\n',
    'utf8',
  );
  writeFileSync(
    join(logDirectory, 'desktop-renderer.log'),
    'renderer owner=purchase:account-a keep=purchase:account-ab\n',
    'utf8',
  );
  writeFileSync(join(logDirectory, 'local-api.log'), 'unrelated owner=purchase:account-b\n', 'utf8');
  writeFileSync(join(logDirectory, 'purchase-search-bridge.log'), '', 'utf8');
  try {
    const result = scrubAccountRemovalDiagnosticLogs({ logDirectory, owner });
    assert.deepEqual(result, { verified: true, fileCount: 4, replacementCount: 3 });
    const scrubbed = readFileSync(join(logDirectory, 'desktop-main.log'), 'utf8');
    assert.equal(scrubbed.includes('owner=purchase:account-a '), false);
    assert.equal(scrubbed.includes('/purchase/purchase%3Aaccount-a '), false);
    assert.equal(scrubbed.includes('purchase:account-ab'), true);
    assert.match(scrubbed, /【账号已销毁：[０-９ａ-ｆ]{24}】/u);
    assert.equal(readFileSync(join(logDirectory, 'local-api.log'), 'utf8'), 'unrelated owner=purchase:account-b\n');
    const rendererScrubbed = readFileSync(join(logDirectory, 'desktop-renderer.log'), 'utf8');
    assert.equal(rendererScrubbed.includes('owner=purchase:account-a '), false);
    assert.equal(rendererScrubbed.includes('purchase:account-ab'), true);

    const repeated = scrubAccountRemovalDiagnosticLogs({ logDirectory, owner });
    assert.deepEqual(repeated, { verified: true, fileCount: 4, replacementCount: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});

test('diagnostic replacement markers cannot recreate a valid target owner token', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-account-log-marker-'));
  const logDirectory = join(root, 'logs');
  mkdirSync(logDirectory, { recursive: true });
  const logPath = join(logDirectory, 'local-api.log');
  try {
    writeFileSync(logPath, 'owner=ACCOUNT_REMOVED owner=a other=account-ab\n', 'utf8');

    scrubAccountRemovalDiagnosticLogs({
      logDirectory,
      owner: { ownerType: 'purchase_account', ownerId: 'ACCOUNT_REMOVED' },
    });
    let scrubbed = readFileSync(logPath, 'utf8');
    assert.doesNotMatch(scrubbed, /(^|[^A-Za-z0-9._:-])ACCOUNT_REMOVED(?=$|[^A-Za-z0-9._:-])/u);
    assert.match(scrubbed, /owner=a other=account-ab/u);

    scrubAccountRemovalDiagnosticLogs({
      logDirectory,
      owner: { ownerType: 'purchase_account', ownerId: 'a' },
    });
    scrubbed = readFileSync(logPath, 'utf8');
    assert.doesNotMatch(scrubbed, /(^|[^A-Za-z0-9._:-])a(?=$|[^A-Za-z0-9._:-])/u);
    assert.match(scrubbed, /other=account-ab/u);
    assert.equal((scrubbed.match(/【账号已销毁：[０-９ａ-ｆ]{24}】/gu) || []).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic log scrub includes newly added top-level process logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-account-log-layout-'));
  const logDirectory = join(root, 'logs');
  mkdirSync(logDirectory, { recursive: true });
  const extraLogs = [
    'codex-dev-fast-v44-final.err.log',
    'codex-dev-fast-v44-final.out.log',
    'codex-promotion-realtime.err.log',
    'codex-promotion-realtime.out.log',
  ];
  for (const fileName of extraLogs) {
    writeFileSync(join(logDirectory, fileName), 'owner=owner-a keep=owner-ab\n', 'utf8');
  }
  try {
    const result = scrubAccountRemovalDiagnosticLogs({
      logDirectory,
      owner: { ownerType: 'purchase_account', ownerId: 'owner-a' },
    });
    assert.deepEqual(result, { verified: true, fileCount: extraLogs.length, replacementCount: extraLogs.length });
    for (const fileName of extraLogs) {
      const readback = readFileSync(join(logDirectory, fileName), 'utf8');
      assert.doesNotMatch(readback, /(^|[^A-Za-z0-9._:-])owner-a(?=$|[^A-Za-z0-9._:-])/u);
      assert.match(readback, /keep=owner-ab/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic log scrub still fails closed for non-log entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-account-log-invalid-layout-'));
  const logDirectory = join(root, 'logs');
  mkdirSync(logDirectory, { recursive: true });
  writeFileSync(join(logDirectory, 'unexpected.txt'), 'owner-a', 'utf8');
  try {
    assert.throws(
      () => scrubAccountRemovalDiagnosticLogs({
        logDirectory,
        owner: { ownerType: 'purchase_account', ownerId: 'owner-a' },
      }),
      /ACCOUNT_REMOVAL_LOG_LAYOUT_UNRECOGNIZED/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a later protection-copy failure stays retryable and an idempotent retry finishes every copy', () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'account-removal-protection-retry-test-key';
  const root = mkdtempSync(join(tmpdir(), 'wangzai-account-protection-retry-'));
  const activeDatabasePath = join(root, 'local-api-data', 'wangzai-local-api.sqlite');
  mkdirSync(dirname(activeDatabasePath), { recursive: true });
  try {
    seedDatabase(activeDatabasePath);
    const firstPath = copyToProtectionFamily(
      activeDatabasePath,
      'restore-staging',
      'a-first-valid',
      'restore.sqlite',
    );
    const secondDirectory = join(dirname(activeDatabasePath), 'restore-failed', 'z-second-invalid');
    mkdirSync(secondDirectory, { recursive: true });
    const secondPath = join(secondDirectory, basename(activeDatabasePath));
    writeFileSync(secondPath, 'not-a-sqlite-database', 'utf8');
    const families = [
      { kind: 'staging', databasePath: firstPath },
      { kind: 'failed', databasePath: secondPath },
    ];
    const service = createAccountRemovalProtectionService({
      activeDatabasePath,
      discoverFamilies: () => families,
    });
    assert.throws(
      () => service.purgeOwner({ owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' } }),
      /database|SQLITE|file is not a database/iu,
    );
    const firstDb = new DatabaseSync(firstPath);
    try {
      assert.equal(firstDb.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?').get('shop-a').count, 0);
      assert.equal(firstDb.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?').get('shop-b').count, 1);
    } finally {
      firstDb.close();
    }

    copyFileSync(activeDatabasePath, secondPath);
    const retried = service.purgeOwner({ owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' } });
    assert.deepEqual(retried, {
      ok: true,
      verified: true,
      familyCount: 2,
      familyKinds: { staging: 1, rollback: 0, failed: 1 },
      totalDeletedRows: 4,
      sanitizedOperationCount: 1,
      diagnosticLogs: { verified: true, fileCount: 0, replacementCount: 0 },
    });
    for (const databasePath of [firstPath, secondPath]) {
      const copy = new DatabaseSync(databasePath);
      try {
        assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?').get('shop-a').count, 0);
        assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?').get('shop-b').count, 1);
      } finally {
        copy.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});
