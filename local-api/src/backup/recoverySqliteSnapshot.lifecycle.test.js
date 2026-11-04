import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createRecoverySqliteSnapshot } from './recoverySqliteSnapshot.js';
import { reclaimExpiredRecoveryExportWorkspaces } from './recoveryExportWorkspace.js';
import { discoverAccountRemovalProtectionFamilies } from './accountRemovalProtectionService.js';

const authenticationKey = Buffer.alloc(32, 83);
const createdAt = Date.parse('2026-09-01T00:00:00.000Z');
const later = Date.parse('2026-09-04T00:00:00.000Z');
const snapshotModule = new URL('./recoverySqliteSnapshot.js', import.meta.url).href;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-snapshot-lifecycle-test-'));
  const databasePath = join(root, 'business.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE business_facts (id TEXT PRIMARY KEY, value TEXT);');
  db.prepare('INSERT INTO business_facts VALUES (?, ?)').run('order-profit-proof', 'must-survive');
  let closed = false;
  const close = () => { if (!closed) { db.close(); closed = true; } };
  t.after(() => {
    close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert.ok(basename(root).startsWith('wangzai-snapshot-lifecycle-test-'));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, databasePath, stagingRoot: join(root, 'restore-staging'), db, close };
}
function snapshotPath(snapshot) {
  return snapshot.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
}

test('SQLite snapshot remains immutable and active while new export cleanup runs; disposal keeps protection-family compatibility', (t) => {
  const f = fixture(t);
  f.db.exec('PRAGMA journal_mode = WAL');
  const snapshot = createRecoverySqliteSnapshot({ db: f.db, workspaceOptions: { authenticationKey, now: () => createdAt } });
  const path = snapshotPath(snapshot);
  try {
    const families = discoverAccountRemovalProtectionFamilies(f.databasePath);
    assert.equal(families.length, 1);
    assert.equal(families[0].databasePath, path);
    assert.deepEqual(readdirSync(dirname(path)), ['restore.sqlite']);
    f.db.prepare('UPDATE business_facts SET value = ?').run('new authoritative fact');
    assert.equal(reclaimExpiredRecoveryExportWorkspaces({ root: f.stagingRoot, authenticationKey,
      now: () => later }).removedWorkspaces, 0);
    assert.equal(snapshot.db.prepare('SELECT value FROM business_facts').get().value, 'must-survive');
    assert.equal(f.db.prepare('SELECT value FROM business_facts').get().value, 'new authoritative fact');
  } finally {
    const result = snapshot.dispose();
    assert.equal(result.ok, true);
    assert.equal(snapshot.dispose().ok, true);
  }
  assert.equal(existsSync(path), false);
  assert.deepEqual(discoverAccountRemovalProtectionFamilies(f.databasePath), []);
});

test('a failed snapshot build closes and cleans only its new producer workspace, preserving business and real restore candidates', (t) => {
  const f = fixture(t);
  const memory = new DatabaseSync(':memory:');
  t.after(() => memory.close());
  memory.exec("CREATE TABLE business_facts (value TEXT); INSERT INTO business_facts VALUES ('preserve failure-path facts');");
  const restorePath = join(f.stagingRoot, 'active-real-restore-fixture', 'restore.sqlite');
  mkdirSync(dirname(restorePath), { recursive: true });
  writeFileSync(restorePath, 'restore candidate not owned by export producer');
  const throwingDb = {
    prepare: sql => memory.prepare(sql),
    exec(sql) {
      memory.exec(sql);
      if (String(sql).startsWith('VACUUM INTO')) throw new Error('SYNTHETIC_SNAPSHOT_BUILD_FAILURE');
    },
  };
  assert.throws(() => createRecoverySqliteSnapshot({ db: throwingDb, snapshotRoot: f.stagingRoot,
    workspaceOptions: { authenticationKey } }), /SYNTHETIC_SNAPSHOT_BUILD_FAILURE/);
  assert.deepEqual(readdirSync(f.stagingRoot), ['active-real-restore-fixture']);
  assert.equal(existsSync(restorePath), true);
  assert.equal(memory.prepare('SELECT value FROM business_facts').get().value, 'preserve failure-path facts');
  assert.equal(f.db.prepare('SELECT value FROM business_facts').get().value, 'must-survive');
});

test('the next export reclaims a crashed predecessor using the same isolated private profile key across processes', (t) => {
  const f = fixture(t);
  f.close();
  const secretPath = join(f.root, 'fixture-profile-private.key');
  writeFileSync(secretPath, 'synthetic-profile-master-key-for-lifecycle-test-only', { flag: 'wx', mode: 0o600 });
  const childEnvironment = { ...process.env, LOCAL_API_SECRET: '', LOCAL_API_SECRET_FILE: secretPath };
  const child = (body, args = []) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { existsSync } from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      import { createRecoverySqliteSnapshot } from ${JSON.stringify(snapshotModule)};
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      ${body}
    `, f.databasePath, ...args], { encoding: 'utf8', env: childEnvironment });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };
  const abandoned = child(`
    const snapshot = createRecoverySqliteSnapshot({ db, workspaceOptions: { now: () => ${createdAt} } });
    const path = snapshot.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
    console.log(JSON.stringify({ path }));
    // Simulated process termination: no workspace dispose or application hook runs.
  `);
  assert.equal(existsSync(abandoned.path), true);
  const resumed = child(`
    const snapshot = createRecoverySqliteSnapshot({ db, workspaceOptions: { now: () => ${later} } });
    const path = snapshot.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
    const originalExists = existsSync(process.argv[2]);
    const value = snapshot.db.prepare('SELECT value FROM business_facts').get().value;
    const cleanup = snapshot.dispose();
    db.close();
    console.log(JSON.stringify({ originalExists, newPathExistsAfterDispose: existsSync(path), value, cleanup }));
  `, [abandoned.path]);
  assert.equal(resumed.originalExists, false);
  assert.equal(resumed.newPathExistsAfterDispose, false);
  assert.equal(resumed.cleanup.ok, true);
  assert.equal(resumed.value, 'must-survive');
  const readback = new DatabaseSync(f.databasePath, { readOnly: true });
  try { assert.equal(readback.prepare('SELECT value FROM business_facts').get().value, 'must-survive'); }
  finally { readback.close(); }
});

test('long Unicode Windows-style workspace paths either work end-to-end or fail closed without moving the authoritative database', (t) => {
  const f = fixture(t);
  let sourceRoot = join(f.root, '中文路径预算');
  while (sourceRoot.length < 220) sourceRoot = join(sourceRoot, 'fixture-nested-path-budget-段');
  mkdirSync(sourceRoot, { recursive: true });
  const sourcePath = join(sourceRoot, 'authoritative.sqlite');
  const db = new DatabaseSync(sourcePath);
  db.exec("CREATE TABLE business_facts (value TEXT); INSERT INTO business_facts VALUES ('long-path authority survives');");
  const stagingRoot = join(sourceRoot, 'restore-staging');
  try {
    let snapshot;
    try { snapshot = createRecoverySqliteSnapshot({ db, workspaceOptions: { authenticationKey } }); }
    catch (error) {
      assert.equal(db.prepare('SELECT value FROM business_facts').get().value, 'long-path authority survives');
      assert.equal(existsSync(sourcePath), true);
      assert.deepEqual(readdirSync(stagingRoot), []);
      const intendedLength = join(stagingRoot, 'x'.repeat(58), 'restore.sqlite').length;
      t.diagnostic(`long-path fixture unsupported, failed closed: sourceLength=${sourcePath.length}; targetLength=${intendedLength}; code=${error.code || 'SQLITE_ERROR'}`);
      return;
    }
    const path = snapshotPath(snapshot);
    assert.ok(path.length > 260);
    assert.equal(snapshot.db.prepare('SELECT value FROM business_facts').get().value, 'long-path authority survives');
    const cleanup = snapshot.dispose();
    assert.equal(cleanup.ok, true);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(sourcePath), true);
    t.diagnostic(`long-path fixture verified: sourceLength=${sourcePath.length}; snapshotLength=${path.length}; workspaceNameLength=${basename(dirname(path)).length}; platform=${process.platform}`);
  } finally { db.close(); }
});

test('the compact signed workspace keeps a 248-character Windows SQLite target within the existing path budget', (t) => {
  const f = fixture(t);
  const suffixLength = '/restore-staging/'.length + 58 + '/restore.sqlite'.length;
  const sourceRootLength = 248 - suffixLength;
  const fillerLength = sourceRootLength - f.root.length - 1;
  assert.ok(fillerLength > 4, 'fixture base itself must fit inside the tested SQLite path budget');
  const sourceRoot = join(f.root, `中文${'x'.repeat(fillerLength - 2)}`);
  mkdirSync(sourceRoot);
  const db = new DatabaseSync(join(sourceRoot, 'business.sqlite'));
  db.exec("CREATE TABLE business_facts (value TEXT); INSERT INTO business_facts VALUES ('boundary path fact');");
  let snapshot;
  try {
    snapshot = createRecoverySqliteSnapshot({ db, workspaceOptions: { authenticationKey } });
    const path = snapshotPath(snapshot);
    assert.equal(path.length, 248);
    assert.equal(snapshot.db.prepare('SELECT value FROM business_facts').get().value, 'boundary path fact');
    assert.equal(snapshot.dispose().ok, true);
    assert.equal(existsSync(path), false);
    assert.equal(db.prepare('SELECT value FROM business_facts').get().value, 'boundary path fact');
    t.diagnostic(`SQLite snapshot path verified=${path.length}; signed directory=58; prior UUID directory=59; platform=${process.platform}`);
  } finally { snapshot?.dispose(); db.close(); }
});

test('a fallback snapshot cannot clear or overwrite a root redirected after its first VACUUM failed', (t) => {
  const f = fixture(t);
  const protectedRoot = join(f.root, 'protected-unrelated-target');
  mkdirSync(protectedRoot);
  let protectedPath;
  const redirectingDb = {
    prepare: sql => f.db.prepare(sql),
    exec(sql) {
      if (!String(sql).startsWith('VACUUM INTO')) return f.db.exec(sql);
      const target = /^VACUUM INTO '(.+)';$/u.exec(sql)[1].replaceAll("''", "'");
      renameSync(f.stagingRoot, join(f.root, 'original-staging'));
      protectedPath = join(protectedRoot, basename(dirname(target)), 'restore.sqlite');
      mkdirSync(dirname(protectedPath));
      writeFileSync(protectedPath, 'protected data must not be cleared by fallback');
      symlinkSync(protectedRoot, f.stagingRoot, process.platform === 'win32' ? 'junction' : 'dir');
      throw new Error('SYNTHETIC_FIRST_VACUUM_FAILED');
    },
  };
  let snapshot;
  let failure;
  try { snapshot = createRecoverySqliteSnapshot({ db: redirectingDb, workspaceOptions: { authenticationKey } }); }
  catch (error) { failure = error; }
  finally { snapshot?.dispose(); }
  assert.equal(failure?.code, 'RECOVERY_EXPORT_WORKSPACE_ROOT_INVALID');
  assert.equal(readFileSync(protectedPath, 'utf8'), 'protected data must not be cleared by fallback');
  assert.equal(f.db.prepare('SELECT value FROM business_facts').get().value, 'must-survive');
});

test('controlled reset preserves normal separate-reader fallback and excludes uncommitted authoritative writes', (t) => {
  const f = fixture(t);
  f.db.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;');
  f.db.prepare('UPDATE business_facts SET value = ?').run('uncommitted source edit');
  let snapshot;
  try {
    snapshot = createRecoverySqliteSnapshot({ db: f.db, workspaceOptions: { authenticationKey } });
    assert.equal(snapshot.evidence.vacuumSource, 'separate-read-handle');
    assert.equal(snapshot.db.prepare('SELECT value FROM business_facts').get().value, 'must-survive');
    assert.equal(f.db.prepare('SELECT value FROM business_facts').get().value, 'uncommitted source edit');
  } finally {
    snapshot?.dispose();
    f.db.exec('ROLLBACK');
  }
  assert.equal(f.db.prepare('SELECT value FROM business_facts').get().value, 'must-survive');
  assert.deepEqual(readdirSync(f.stagingRoot), []);
});
