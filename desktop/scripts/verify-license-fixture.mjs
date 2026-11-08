import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withManagedDevScratch } from '../../tools/managed-dev-scratch.mjs';
import { parsePerformanceOptions, runPerformanceNavigation } from './perf-electron-navigation.mjs';
import { resolveServerSourceRoot } from './server-source-root.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const backendOverride = process.argv.find(arg => arg.startsWith('--backend-root='))?.slice('--backend-root='.length);
const backend = resolveServerSourceRoot({ workspaceRoot: root,
  env: backendOverride ? { ...process.env, WANGZAI_LICENSE_BACKEND_ROOT: backendOverride } : process.env });
const python = path.join(backend, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const output = path.join(root, '.codex-temp/license-integration-20260907');
fs.mkdirSync(output, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const portServer = net.createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP'].includes(key.toUpperCase())));
env.PYTHONUTF8 = '1'; env.PYTHONDONTWRITEBYTECODE = '1';
const unchangedFiles = [path.join(root, 'desktop/resources/project.json'), path.join(root, 'desktop/resources/distribution.json'),
  path.join(root, 'desktop/src/licensing/licenseRuntime.js'), path.join(backend, 'app/main.py'), path.join(backend, 'app/config.py')];
const sourceHashes = () => Object.fromEntries(unchangedFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const beforeHashes = sourceHashes();
await withManagedDevScratch({ workspaceRoot: root, purpose: 'test-scratch' }, async lease => {
  lease.retain();
  const directory = path.join(lease.directory, 'authorization'); fs.mkdirSync(directory);
  let backendLog = '', clientLog = '';
  const server = spawn(python, [path.join(root, 'desktop/scripts/license-fixture-server.py'),
    '--directory', directory, '--backend-root', backend, '--project-file', path.join(root, 'desktop/resources/project.json'), '--port', String(port)],
  { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const serverDone = lease.trackChild(server);
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { backendLog += chunk; });
  let success = false, clientResult = null, navigation = [];
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (server.exitCode !== null) throw new Error('ISOLATED_LICENSE_BACKEND_EXITED');
      try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }); if (response.ok) break; } catch { /* bounded startup */ }
      await sleep(200);
    }
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    assert.equal(health.ok, true);
    const childEnv = { ...env, WANGZAI_ALLOW_TEST_FIXTURE_URLS: '1', WANGZAI_LICENSE_MODE: 'enforce' };
    const client = spawn(path.join(root, 'desktop/node_modules/electron/dist/electron.exe'),
      [path.join(root, 'desktop/scripts/license-fixture-client.mjs'), directory],
      { cwd: directory, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [client.stdout, client.stderr]) stream.on('data', chunk => { clientLog += chunk; });
    await lease.trackChild(client);
    assert.equal(client.exitCode, 0, clientLog.slice(-1000));
    clientResult = JSON.parse(fs.readFileSync(path.join(directory, 'client-result.json'), 'utf8'));
    if (process.argv.includes('--navigation')) {
      const parameter = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`)) || `--${name}=${fallback}`;
      const requestedTarget = process.argv.find(value => value.startsWith('--target='))?.slice('--target='.length) || 'products';
      const targets = process.argv.includes('--both-pages') ? ['products', 'sales-orders'] : [requestedTarget];
      for (const target of targets) {
        const options = parsePerformanceOptions([parameter('products', 80), parameter('orders', 24), parameter('shops', 1),
          '--timeout-ms=45000', `--target=${target}`, `--output-dir=${path.join(output, 'navigation')}`]);
        const measured = await runPerformanceNavigation({ ...options, testAuthorization: { directory },
          diagnostics: process.argv.includes('--diagnostics'), cpuProfile: process.argv.includes('--cpu-profile'),
          batchSetup: process.argv.includes('--batch-setup'), diagnosticCompletion: process.argv.includes('--diagnostic-completion'),
          disposeCompletedFixtures: true });
        const result = { target, reportPath: measured.reportPath, targetsMet: measured.report.targetsMet,
          hardFailures: measured.report.hardFailures, coldP95Ms: measured.report.coldP95Ms,
          warmP95Ms: measured.report.warmP95Ms, scrollP5Fps: measured.report.scrollP5Fps };
        navigation.push(result);
        assert.equal(result.hardFailures.length, 0, result.hardFailures.join('; '));
      }
    }
    success = true;
  } finally {
    if (server.exitCode === null) server.stdin.end('stop\n');
    await serverDone;
    const stopped = fs.existsSync(path.join(directory, 'stopped.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'stopped.json'), 'utf8')) : null;
    const afterHashes = sourceHashes();
    const configurationAndAuthorizationUnchanged = JSON.stringify(beforeHashes) === JSON.stringify(afterHashes);
    success = success && configurationAndAuthorizationUnchanged && server.exitCode === 0 && stopped?.stopped === true;
    const report = { success, backendExitCode: server.exitCode, stopped, clientResult, navigation,
      configurationAndAuthorizationUnchanged, sourceHashes: { before: beforeHashes, after: afterHashes },
      realBackendCode: backend, isolatedDatabase: true, liveProductionAuthorizationAccepted: false, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(output, `${lease.runId}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(output, `${lease.runId}.backend.log`), backendLog);
    fs.writeFileSync(path.join(output, `${lease.runId}.client.log`), clientLog);
    console.log(JSON.stringify({ success, evidence: path.join(output, `${lease.runId}.json`), backendExited: server.exitCode }));
    if (!success) console.log(backendLog.slice(-2000), clientLog.slice(-1000));
    if (!success) process.exitCode = 1;
  }
});
