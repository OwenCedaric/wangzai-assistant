import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { createRecoveryExportWorkspace, reclaimExpiredRecoveryExportWorkspaces, RECOVERY_EXPORT_WORKSPACE_POLICY } from './recoveryExportWorkspace.js';

const key = Buffer.alloc(32, 71);
const createdAt = Date.parse('2026-09-01T00:00:00.000Z');
const later = createdAt + 2 * RECOVERY_EXPORT_WORKSPACE_POLICY.minimumAgeMs;
const moduleUrl = new URL('./recoveryExportWorkspace.js', import.meta.url).href;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wangzai-export-workspace-test-'));
  const root = join(directory, 'restore-staging');
  mkdirSync(root);
  t.after(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.ok(basename(directory).startsWith('wangzai-export-workspace-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, root };
}
function detached(root, count = 1) {
  const script = `
    import { writeFileSync } from 'node:fs';
    import { createRecoveryExportWorkspace } from ${JSON.stringify(moduleUrl)};
    const paths = [];
    for (let i = 0; i < ${count}; i++) {
      const workspace = createRecoveryExportWorkspace({ root: process.argv[1], authenticationKey: Buffer.alloc(32, 71), now: () => ${createdAt} });
      writeFileSync(workspace.snapshotPath, 'synthetic disposable export');
      paths.push(workspace.directory);
    }
    console.log(JSON.stringify(paths));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], {
    encoding: 'utf8', env: { ...process.env, LOCAL_API_SECRET: 'synthetic-workspace-test-only' },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
}
const reclaim = (root, options = {}) => reclaimExpiredRecoveryExportWorkspaces({
  root, authenticationKey: key, now: () => later, ...options,
});

test('live producer leases and in-process active exports are never reclaimed even after TTL', (t) => {
  const f = fixture(t);
  const workspace = createRecoveryExportWorkspace({ root: f.root, authenticationKey: key, now: () => createdAt });
  assert.equal(basename(workspace.directory).length, 58, 'the signed name must not exceed the prior 59-character UUID workspace');
  writeFileSync(workspace.snapshotPath, 'active export');
  assert.equal(reclaim(f.root).removedWorkspaces, 0);
  // Even an incorrect external liveness probe cannot override an in-process lease.
  assert.equal(reclaim(f.root, { isOwnerAlive: () => false }).removedWorkspaces, 0);
  assert.equal(readFileSync(workspace.snapshotPath, 'utf8'), 'active export');
  assert.equal(workspace.finish('completed').ok, true);
  assert.equal(existsSync(workspace.directory), false);
});

test('only expired authenticated dead-process workspaces are reclaimed, with bounded removals', (t) => {
  const f = fixture(t);
  const paths = detached(f.root, 3);
  assert.equal(reclaim(f.root, { now: () => createdAt + 1 }).removedWorkspaces, 0);
  assert.equal(reclaim(f.root, { isOwnerAlive: () => null }).removedWorkspaces, 0);
  assert.equal(reclaim(f.root, { isOwnerAlive: () => { throw new Error('fixture unknown'); } }).removedWorkspaces, 0);
  const first = reclaim(f.root, { maximumRemovals: 1 });
  assert.equal(first.removedWorkspaces, 1);
  assert.equal(first.scanComplete, false);
  assert.equal(paths.filter(path => existsSync(path)).length, 2);
  assert.equal(reclaim(f.root).removedWorkspaces, 2);
  assert.deepEqual(readdirSync(f.root), []);
});

test('legacy exports, active restores, manual partials, unknown files, and copied signatures stay protected', (t) => {
  const f = fixture(t);
  for (const name of ['recovery-export-old-unknown', 'active-restore-fixture', 'profit-repair.partial']) {
    mkdirSync(join(f.root, name));
    writeFileSync(join(f.root, name, 'restore.sqlite'), 'protected legacy or restore fact');
  }
  const [withManualFile, copied] = detached(f.root, 2);
  writeFileSync(join(withManualFile, 'manual-recovery-proof.txt'), 'do not remove');
  const otherRoot = join(f.directory, 'other-profile', 'restore-staging');
  mkdirSync(otherRoot, { recursive: true });
  const moved = join(otherRoot, basename(copied));
  renameSync(copied, moved);
  assert.equal(reclaim(otherRoot).removedWorkspaces, 0, 'root binding rejects a copied authenticated name');
  const result = reclaim(f.root);
  assert.equal(result.removedWorkspaces, 0);
  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(withManualFile, 'restore.sqlite'), 'utf8'), 'synthetic disposable export');
  assert.equal(readFileSync(join(withManualFile, 'manual-recovery-proof.txt'), 'utf8'), 'do not remove');
  for (const name of ['recovery-export-old-unknown', 'active-restore-fixture', 'profit-repair.partial']) {
    assert.equal(readFileSync(join(f.root, name, 'restore.sqlite'), 'utf8'), 'protected legacy or restore fact');
  }
});

test('a wrong profile key or changed signed directory name cannot authorize cleanup', (t) => {
  const f = fixture(t);
  const [path] = detached(f.root);
  assert.equal(reclaim(f.root, { authenticationKey: Buffer.alloc(32, 72) }).removedWorkspaces, 0);
  const name = basename(path);
  const changed = join(f.root, name.slice(0, -1) + (name.endsWith('A') ? 'B' : 'A'));
  renameSync(path, changed);
  assert.equal(reclaim(f.root).removedWorkspaces, 0);
  assert.equal(existsSync(join(changed, 'restore.sqlite')), true);
});

test('hard links and junction ancestors cannot redirect workspace deletion or creation', (t) => {
  const f = fixture(t);
  const [path] = detached(f.root);
  const protectedPath = join(f.directory, 'business-facts.sqlite');
  writeFileSync(protectedPath, 'protected business facts');
  unlinkSync(join(path, 'restore.sqlite'));
  linkSync(protectedPath, join(path, 'restore.sqlite'));
  assert.equal(reclaim(f.root).removedWorkspaces, 0);
  assert.equal(readFileSync(protectedPath, 'utf8'), 'protected business facts');
  const target = join(f.directory, 'junction-target');
  mkdirSync(target);
  const junction = join(f.directory, 'junction-ancestor');
  symlinkSync(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const redirectedRoot = join(junction, 'must-not-be-created', 'restore-staging');
  assert.throws(() => createRecoveryExportWorkspace({ root: redirectedRoot, authenticationKey: key }),
    { code: 'RECOVERY_EXPORT_WORKSPACE_ROOT_INVALID' });
  assert.equal(existsSync(join(target, 'must-not-be-created')), false);
  assert.equal(reclaim(redirectedRoot).ok, false);
});

test('ancestor replacement after creation and unknown directory contents defer exact disposal', (t) => {
  const f = fixture(t);
  const parent = join(f.directory, 'profile-parent');
  const root = join(parent, 'restore-staging');
  const workspace = createRecoveryExportWorkspace({ root, authenticationKey: key });
  writeFileSync(workspace.snapshotPath, 'known disposable snapshot');
  const movedParent = join(f.directory, 'moved-original-parent');
  renameSync(parent, movedParent);
  symlinkSync(movedParent, parent, process.platform === 'win32' ? 'junction' : 'dir');
  const result = workspace.finish('completed');
  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  assert.equal(workspace.finish('completed').ok, false, 'retry does not turn deferred cleanup into success');
  assert.equal(readFileSync(join(movedParent, 'restore-staging', basename(workspace.directory), 'restore.sqlite'), 'utf8'), 'known disposable snapshot');
});

test('an unknown file added to an active workspace is neither moved nor deleted by disposal', (t) => {
  const f = fixture(t);
  const workspace = createRecoveryExportWorkspace({ root: f.root, authenticationKey: key });
  const original = workspace.directory;
  writeFileSync(workspace.snapshotPath, 'known disposable snapshot');
  const unknown = join(original, 'manual-proof.wzb');
  writeFileSync(unknown, 'keep exact unknown path');
  assert.equal(workspace.finish('completed').ok, false);
  assert.equal(workspace.directory, original);
  assert.equal(readFileSync(unknown, 'utf8'), 'keep exact unknown path');
  assert.equal(readFileSync(workspace.snapshotPath, 'utf8'), 'known disposable snapshot');
});

test('a scan cap reports incomplete coverage rather than claiming all workspaces were handled', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 4; index += 1) mkdirSync(join(f.root, `legacy-${index}`));
  const result = reclaim(f.root, { maximumScanEntries: 2 });
  assert.equal(result.scanned, 2);
  assert.equal(result.scanComplete, false);
  assert.equal(result.removedWorkspaces, 0);
  assert.equal(readdirSync(f.root).length, 4);
});

test('successive bounded checks advance beyond more than 128 preserved legacy directories', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 200; index += 1) mkdirSync(join(f.root, `000-legacy-${String(index).padStart(4, '0')}`));
  const [expired] = detached(f.root);
  const results = [];
  for (let round = 0; round < 4 && existsSync(expired); round += 1) results.push(reclaim(f.root));
  assert.equal(existsSync(expired), false, 'a preserved prefix must not starve a later authenticated expired workspace');
  assert.ok(results.every(result => result.scanned <= 128));
  assert.ok(results.some(result => result.replayedEntries > 0), 'metadata-only bookmark seeking is reported separately');
  assert.ok(results.every(result => result.discoveredEntries >= result.scanned));
  assert.equal(readdirSync(f.root).filter(name => name.startsWith('000-legacy-')).length, 200);
});

test('controlled reset clears only the active owned family and preserves its lease and directory', (t) => {
  const f = fixture(t);
  const workspace = createRecoveryExportWorkspace({ root: f.root, authenticationKey: key, now: () => createdAt });
  const original = workspace.directory;
  writeFileSync(workspace.snapshotPath, 'partial snapshot');
  writeFileSync(`${workspace.snapshotPath}-journal`, 'partial journal');
  assert.equal(workspace.reset().ok, true);
  assert.equal(workspace.directory, original);
  assert.deepEqual(readdirSync(original), []);
  assert.equal(reclaim(f.root, { isOwnerAlive: () => false }).removedWorkspaces, 0);
  writeFileSync(workspace.snapshotPath, 'fallback snapshot');
  assert.equal(workspace.finish('completed').ok, true);
  assert.throws(() => workspace.reset(), { code: 'RECOVERY_EXPORT_WORKSPACE_RELEASED' });
});

test('controlled reset rejects an ordinary replacement directory or root with the same signed pathname', (t) => {
  const f = fixture(t);
  const workspace = createRecoveryExportWorkspace({ root: f.root, authenticationKey: key });
  const path = workspace.directory;
  renameSync(path, join(f.directory, 'original-workspace'));
  mkdirSync(path);
  writeFileSync(join(path, 'restore.sqlite'), 'replacement must survive');
  assert.throws(() => workspace.reset(), { code: 'RECOVERY_EXPORT_WORKSPACE_PATH_CHANGED' });
  assert.equal(readFileSync(join(path, 'restore.sqlite'), 'utf8'), 'replacement must survive');
  assert.equal(workspace.finish('failed').ok, false);
  const second = createRecoveryExportWorkspace({ root: f.root, authenticationKey: key });
  const originalRoot = join(f.directory, 'original-staging');
  renameSync(f.root, originalRoot);
  mkdirSync(f.root);
  mkdirSync(second.directory);
  writeFileSync(second.snapshotPath, 'replacement root fact');
  assert.throws(() => second.reset(), { code: 'RECOVERY_EXPORT_WORKSPACE_ROOT_CHANGED' });
  assert.equal(readFileSync(second.snapshotPath, 'utf8'), 'replacement root fact');
  assert.equal(second.finish('failed').ok, false);
});

test('scan bookmarks have a 32-root bound, release at completion, and reset when root identity changes', (t) => {
  const f = fixture(t);
  const roots = Array.from({ length: 33 }, (_unused, index) => join(f.directory, `bookmarked-root-${index}`));
  for (const root of roots) {
    mkdirSync(root);
    for (let index = 0; index < 3; index += 1) mkdirSync(join(root, `legacy-${index}`));
    assert.equal(reclaim(root, { maximumScanEntries: 1 }).replayedEntries, 0);
  }
  const first = reclaim(roots[0], { maximumScanEntries: 1 });
  assert.equal(first.replayedEntries, 0, 'the least-recent root was evicted at the fixed 32-bookmark bound');
  const complete = reclaim(roots[0]);
  assert.equal(complete.scanComplete, true);
  assert.ok(complete.replayedEntries > 0);
  assert.equal(reclaim(roots[0], { maximumScanEntries: 1 }).replayedEntries, 0, 'completed scans release their bookmark');
  renameSync(roots[0], join(f.directory, 'old-root-identity'));
  mkdirSync(roots[0]);
  mkdirSync(join(roots[0], 'legacy-0'));
  mkdirSync(join(roots[0], 'legacy-1'));
  const replacement = reclaim(roots[0], { maximumScanEntries: 1 });
  assert.equal(replacement.replayedEntries, 0, 'same pathname and bookmark name must not reuse a former root inode');
  assert.equal(replacement.scanned, 1);
});
