import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectExpiredManagedDevScratch, withManagedDevScratch } from './managed-dev-scratch.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const cliPath = fileURLToPath(new URL('./managed-dev-scratch-cli.mjs', import.meta.url));
function cleanupProcess(workspaceRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'cleanup', '--apply', '--workspace', workspaceRoot], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(stderr || stdout));
      else resolve(JSON.parse(stdout.trim()));
    });
  });
}
function fixture(t) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-managed-scratch-'));
  t.after(() => {
    assert.ok(path.resolve(workspaceRoot).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(workspaceRoot).startsWith('wangzai-managed-scratch-'));
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
  let timestamp = 1_000_000;
  return { workspaceRoot, options: { workspaceRoot, purpose: 'native-build', ttlMs: 60_000 },
    dependencies: { now: () => timestamp }, advance(ms) { timestamp += ms; } };
}

test('preview of an absent managed root creates nothing and never scans legacy directories', t => {
  const f = fixture(t);
  for (const name of ['.tmp', '.codex-temp', 'artifacts', '.runtime-profile', '.runtime-update-backups', '安装包', 'desktop/dist-current-5.0', 'desktop/native/Wangzai.CefBrowserHost/publish']) {
    const target = path.join(f.workspaceRoot, name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'keep'), 'protected original fixture');
  }
  const before = fs.readdirSync(f.workspaceRoot).sort();
  const report = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true });
  assert.equal(report.removedRuns, 0);
  assert.deepEqual(fs.readdirSync(f.workspaceRoot).sort(), before);
});

test('existing unowned root is never adopted or marked disposable', async t => {
  const f = fixture(t);
  const root = path.join(f.workspaceRoot, '.managed-dev-scratch');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'old-evidence.txt'), 'keep');
  await assert.rejects(withManagedDevScratch(f.options, async () => {}, f.dependencies), /ROOT_UNRECOGNIZED/u);
  assert.throws(() => collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true }), /ROOT_UNRECOGNIZED/u);
  assert.deepEqual(fs.readdirSync(root), ['old-evidence.txt']);
});

test('active scope remains protected past its TTL; expiry starts only after all work finishes', async t => {
  const f = fixture(t), entered = deferred(), finish = deferred();
  let directory;
  const work = withManagedDevScratch(f.options, async scope => {
    directory = scope.directory;
    fs.writeFileSync(path.join(directory, 'compiler.tmp'), 'rebuildable');
    entered.resolve();
    await finish.promise;
  }, f.dependencies);
  await entered.promise;
  f.advance(120_000);
  assert.equal(collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true }, f.dependencies).removedRuns, 0);
  assert.equal(fs.existsSync(directory), true);
  finish.resolve(); await work;
  f.advance(59_999);
  assert.equal(collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true }, f.dependencies).removedRuns, 0);
  f.advance(2);
  const preview = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot }, f.dependencies);
  assert.equal(preview.eligibleRuns, 1);
  assert.equal(fs.existsSync(directory), true);
  const applied = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true }, f.dependencies);
  assert.equal(applied.removedRuns, 1);
  assert.equal(applied.removedLogicalBytes, Buffer.byteLength('rebuildable'));
  assert.equal(fs.existsSync(directory), false);
});

test('tracked child exit is part of the producer lease even when work callback has returned', async t => {
  const f = fixture(t), entered = deferred();
  const child = new EventEmitter();
  Object.assign(child, { pid: process.pid, exitCode: null, signalCode: null });
  let settled = false, directory;
  const work = withManagedDevScratch(f.options, async scope => {
    directory = scope.directory;
    scope.trackChild(child);
    entered.resolve();
  }, f.dependencies).then(() => { settled = true; });
  await entered.promise;
  f.advance(360_000);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true }, f.dependencies).removedRuns, 0);
  child.exitCode = 0; child.emit('exit', 0, null);
  await work;
  assert.equal(fs.existsSync(directory), true);
});

test('failed producer and explicit evidence retention cannot become expired cleanup candidates', async t => {
  const f = fixture(t);
  let failed, retained;
  await assert.rejects(withManagedDevScratch(f.options, async scope => {
    failed = scope.directory;
    fs.writeFileSync(path.join(failed, 'failure-evidence.txt'), 'preserve');
    throw new Error('fixture compilation failed');
  }, f.dependencies), /fixture compilation failed/u);
  await withManagedDevScratch(f.options, async scope => { retained = scope.directory; scope.retain(); }, f.dependencies);
  f.advance(1_000_000);
  assert.equal(collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true }, f.dependencies).removedRuns, 0);
  assert.equal(fs.existsSync(failed), true);
  assert.equal(fs.existsSync(retained), true);
});

test('unknown children, forged ownership manifests and keep markers all fail closed', async t => {
  const f = fixture(t);
  let first, second;
  await withManagedDevScratch(f.options, async scope => { first = scope.directory; }, f.dependencies);
  await withManagedDevScratch(f.options, async scope => { second = scope.directory; fs.writeFileSync(path.join(second, '.keep'), ''); }, f.dependencies);
  const run = path.dirname(first);
  const manifestPath = path.join(run, 'ownership.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.ownerToken = 'forged'; fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const unknown = path.join(f.workspaceRoot, '.managed-dev-scratch', 'old-build');
  fs.mkdirSync(unknown); fs.writeFileSync(path.join(unknown, 'keep'), 'unregistered');
  f.advance(100_000);
  const report = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true }, f.dependencies);
  assert.equal(report.removedRuns, 0);
  assert.equal(fs.existsSync(first), true);
  assert.equal(fs.existsSync(second), true);
  assert.equal(fs.readFileSync(path.join(unknown, 'keep'), 'utf8'), 'unregistered');
});

test('linked payload directories and hardlinked files never direct deletion into protected neighbors', async t => {
  const f = fixture(t);
  const neighbor = path.join(f.workspaceRoot, 'backup'); fs.mkdirSync(neighbor);
  const original = path.join(neighbor, 'keep.txt'); fs.writeFileSync(original, 'never delete');
  let directory;
  await withManagedDevScratch(f.options, async scope => {
    directory = scope.directory;
    fs.symlinkSync(neighbor, path.join(directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.linkSync(original, path.join(directory, 'hardlink'));
  }, f.dependencies);
  f.advance(100_000);
  const result = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true }, f.dependencies);
  assert.equal(result.removedRuns, 0);
  assert.equal(fs.readFileSync(original, 'utf8'), 'never delete');
  assert.equal(fs.existsSync(directory), true);
});

test('budget and shape validation do not turn arbitrary paths into scratch targets', async t => {
  const f = fixture(t);
  await assert.rejects(withManagedDevScratch({ ...f.options, purpose: 'backup' }, async () => {}), /PURPOSE_INVALID/u);
  await assert.rejects(withManagedDevScratch({ ...f.options, ttlMs: 0 }, async () => {}), /TTL_INVALID/u);
  assert.throws(() => collectExpiredManagedDevScratch({ workspaceRoot: path.parse(f.workspaceRoot).root, apply: true }), /WORKSPACE_INVALID/u);
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, '.managed-dev-scratch')), false);
});

test('completed-only pressure can reclaim the oldest disposable run before TTL without touching retained data', async t => {
  const f = fixture(t);
  let first, second, retained;
  await withManagedDevScratch(f.options, async scope => {
    first = scope.directory; fs.writeFileSync(path.join(first, 'build.bin'), 'a'.repeat(40));
  }, f.dependencies);
  f.advance(1);
  await withManagedDevScratch(f.options, async scope => {
    second = scope.directory; fs.writeFileSync(path.join(second, 'build.bin'), 'b'.repeat(40));
  }, f.dependencies);
  await withManagedDevScratch(f.options, async scope => {
    retained = scope.directory; scope.retain(); fs.writeFileSync(path.join(retained, 'keep.bin'), 'c'.repeat(400));
  }, f.dependencies);
  const report = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true, maxCompletedBytes: 50 }, f.dependencies);
  assert.equal(report.capacityTriggered, true);
  assert.equal(report.removedRuns, 1);
  assert.equal(report.completedDisposableBytesAfter, 40);
  assert.equal(report.completedMeasurementComplete, true);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), true);
  assert.equal(fs.existsSync(retained), true);
});

test('another cleanup process cannot reclaim an active producer even when its initial TTL has passed', async t => {
  const f = fixture(t), entered = deferred(), finish = deferred();
  let directory;
  const work = withManagedDevScratch(f.options, async scope => {
    directory = scope.directory; entered.resolve(); await finish.promise;
  }, f.dependencies);
  await entered.promise;
  try {
    const report = await cleanupProcess(f.workspaceRoot);
    assert.equal(report.activeRuns, 1);
    assert.equal(report.removedRuns, 0);
    assert.equal(fs.existsSync(directory), true);
  } finally { finish.resolve(); await work; }
});

test('two cleanup processes serialize one completed deletion without double-counting reclaimed bytes', async t => {
  const f = fixture(t);
  await withManagedDevScratch(f.options, async scope => { fs.writeFileSync(path.join(scope.directory, 'work.bin'), 'fixture'); }, f.dependencies);
  const reports = await Promise.all([cleanupProcess(f.workspaceRoot), cleanupProcess(f.workspaceRoot)]);
  assert.equal(reports.reduce((sum, report) => sum + report.removedRuns, 0), 1);
  assert.equal(reports.reduce((sum, report) => sum + report.removedLogicalBytes, 0), 7);
});

test('run CLI holds its producer lease and retains a failed child instead of silently making its output disposable', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [cliPath, 'run', '--workspace', f.workspaceRoot, '--purpose', 'test-scratch', '--',
    process.execPath, '-e', "require('node:fs').writeFileSync(require('node:path').join(process.env.WANGZAI_MANAGED_DEV_SCRATCH,'result.txt'),'failure evidence');process.exit(7)"],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  const report = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true, maxCompletedBytes: 0 }, { now: () => Date.now() + 40 * 86400_000 });
  assert.equal(report.activeRuns, 0);
  assert.equal(report.retainedRuns, 1);
  assert.equal(report.removedRuns, 0);
});

test('bounded partial measurement never reports that the complete disposable budget was verified', async t => {
  const f = fixture(t);
  await withManagedDevScratch(f.options, async scope => { fs.writeFileSync(path.join(scope.directory, 'one'), 'x'); }, f.dependencies);
  await withManagedDevScratch(f.options, async scope => { fs.writeFileSync(path.join(scope.directory, 'two'), 'y'); }, f.dependencies);
  const report = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, maxRuns: 1 }, f.dependencies);
  assert.equal(report.completedMeasurementComplete, false);
  assert.equal(report.removedRuns, 0);
});

function mutateAfterPayloadScan(t, directory, mutate) {
  const runRoot = path.dirname(directory);
  const originalRead = fs.readdirSync.bind(fs), originalStat = fs.lstatSync.bind(fs);
  let armed = false, changed = false;
  t.mock.method(fs, 'readdirSync', (target, ...args) => {
    const result = originalRead(target, ...args);
    if (path.resolve(String(target)) === directory && !changed) armed = true;
    return result;
  });
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    if (armed && !changed && path.resolve(String(target)) === runRoot) {
      changed = true; armed = false; mutate(runRoot);
    }
    return originalStat(target, ...args);
  });
  return () => changed;
}

for (const mutation of ['keep-marker', 'ownership', 'new-payload', 'replacement-run']) {
  test(`last deletion admission preserves ${mutation} added after the initial scan`, async t => {
    const f = fixture(t);
    let directory;
    await withManagedDevScratch(f.options, async scope => {
      directory = scope.directory; fs.writeFileSync(path.join(directory, 'original.bin'), 'original');
    }, f.dependencies);
    f.advance(100_000);
    const changed = mutateAfterPayloadScan(t, directory, runRoot => {
      if (mutation === 'keep-marker') fs.writeFileSync(path.join(directory, '.keep'), 'new protection');
      if (mutation === 'ownership') {
        const manifestPath = path.join(runRoot, 'ownership.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.ownerToken = 'changed-after-scan';
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      if (mutation === 'new-payload') fs.writeFileSync(path.join(directory, 'new-evidence.bin'), 'new');
      if (mutation === 'replacement-run') {
        const stashed = path.join(f.workspaceRoot, 'stashed-original-fixture');
        assert.equal(path.dirname(runRoot), path.join(f.workspaceRoot, '.managed-dev-scratch'));
        assert.equal(path.dirname(stashed), f.workspaceRoot);
        fs.renameSync(runRoot, stashed);
        fs.cpSync(stashed, runRoot, { recursive: true });
      }
    });
    try {
      const report = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true }, f.dependencies);
      assert.equal(changed(), true);
      assert.equal(report.removedRuns, 0);
      assert.equal(report.removedLogicalBytes, 0);
      assert.equal(report.completedBudgetStatus, 'unknown');
      assert.equal(fs.existsSync(directory), true);
    } finally { t.mock.restoreAll(); }
  });
}

test('blocked oldest runs cannot permanently hide later expired disposable work', async t => {
  const f = fixture(t), directories = [];
  for (let index = 0; index < 10; index++) {
    f.advance(1);
    await withManagedDevScratch(f.options, async scope => {
      directories.push(scope.directory); fs.writeFileSync(path.join(scope.directory, 'work.bin'), 'x');
    }, f.dependencies);
  }
  for (const directory of directories.slice(0, 8)) fs.writeFileSync(path.join(directory, '.keep'), 'retain');
  f.advance(100_000);
  let removed = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    removed += collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true, maxRuns: 4 }, f.dependencies).removedRuns;
  }
  assert.equal(removed, 2);
  for (const directory of directories.slice(0, 8)) assert.equal(fs.existsSync(directory), true);
});

test('scan-budget failures also advance the persistent cursor without relabeling partial bytes as the total', async t => {
  const f = fixture(t), directories = [];
  for (let index = 0; index < 3; index++) {
    f.advance(1);
    await withManagedDevScratch(f.options, async scope => {
      directories.push(scope.directory);
      fs.writeFileSync(path.join(scope.directory, 'a'), 'a');
      if (index < 2) fs.writeFileSync(path.join(scope.directory, 'b'), 'b');
    }, f.dependencies);
  }
  f.advance(100_000);
  let removed = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true, maxRuns: 1, maxScanEntries: 1 }, f.dependencies);
    removed += result.removedRuns;
    assert.equal(result.completedMeasurementComplete, false);
    assert.equal(result.completedBudgetStatus, 'unknown');
  }
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(directories[0]), true);
  assert.equal(fs.existsSync(directories[1]), true);
  assert.equal(fs.existsSync(directories[2]), false);
});

test('legacy registry gains only a technical cursor on apply and preserves retained runs and root identity exactly', async t => {
  const f = fixture(t);
  let retained;
  await withManagedDevScratch(f.options, async scope => { retained = scope.directory; scope.retain(); }, f.dependencies);
  const registry = path.join(f.workspaceRoot, '.managed-dev-scratch', 'registry.sqlite');
  const inspect = () => {
    const db = new DatabaseSync(registry, { readOnly: true });
    try { return {
      identity: db.prepare('SELECT identity FROM metadata').get().identity,
      rows: db.prepare('SELECT * FROM runs').all(),
      hasCursor: Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name='cleanup_scan_cursor'").get()),
    }; } finally { db.close(); }
  };
  const original = inspect();
  assert.equal(original.hasCursor, false);
  collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot }, f.dependencies);
  assert.deepEqual(inspect(), original, 'preview must not migrate or mutate even technical metadata');
  const report = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true }, f.dependencies);
  const after = inspect();
  assert.equal(after.hasCursor, true);
  assert.equal(after.identity, original.identity);
  assert.deepEqual(after.rows, original.rows);
  assert.equal(report.retainedRuns, 1);
  assert.equal(fs.existsSync(retained), true);
});

test('a new cleanup process resumes after a budget-blocked oldest run using only persisted cursor metadata', async t => {
  const f = fixture(t), directories = [];
  for (let index = 0; index < 2; index++) {
    f.advance(1);
    await withManagedDevScratch(f.options, async scope => {
      directories.push(scope.directory); fs.writeFileSync(path.join(scope.directory, 'a'), 'a');
      if (index === 0) fs.writeFileSync(path.join(scope.directory, 'b'), 'b');
    }, f.dependencies);
  }
  const registry = new DatabaseSync(path.join(f.workspaceRoot, '.managed-dev-scratch', 'registry.sqlite'));
  try { registry.exec('DELETE FROM cleanup_scan_cursor'); } finally { registry.close(); }
  f.advance(100_000);
  const first = collectExpiredManagedDevScratch({ workspaceRoot: f.workspaceRoot, apply: true, maxRuns: 1, maxScanEntries: 1 }, f.dependencies);
  assert.equal(first.removedRuns, 0);
  assert.equal(first.scanAdvanced, true);
  const moduleUrl = pathToFileURL(path.join(path.dirname(cliPath), 'managed-dev-scratch.mjs')).href;
  const command = `import {collectExpiredManagedDevScratch as collect} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(collect({workspaceRoot:${JSON.stringify(f.workspaceRoot)},apply:true,maxRuns:1,maxScanEntries:1})));`;
  const second = spawnSync(process.execPath, ['--input-type=module', '-e', command], { encoding: 'utf8', windowsHide: true });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const report = JSON.parse(second.stdout);
  assert.equal(report.removedRuns, 1);
  assert.equal(report.completedBudgetStatus, 'unknown');
  assert.equal(fs.existsSync(directories[0]), true);
  assert.equal(fs.existsSync(directories[1]), false);
});
