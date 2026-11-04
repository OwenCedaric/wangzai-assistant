import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto';
import { createSignedUiUpdate } from './create-signed-ui-update.mjs';
import { createSignedUiUpdateStore } from '../src/updates/signedUiUpdateStore.js';

const workspace = path.resolve(import.meta.dirname, '../..');
const id = randomUUID(), root = path.join(os.tmpdir(), `wangzai-ui-native-${id}`);
fs.mkdirSync(root);
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const config = { enabled: true, appId: 'isolated-native-pilot', channel: 'pilot', shellApi: 1, publicKey,
  baseUrl: 'https://unused.example.test/api/client-updates' };
fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ contract: 'wangzai-ui-native-fixture/v1', config }));
fs.mkdirSync(path.join(root, 'bundled'));
fs.writeFileSync(path.join(root, 'business-fixture.txt'), 'synthetic data must remain unchanged');
const businessHash = createHash('sha256').update(fs.readFileSync(path.join(root, 'business-fixture.txt'))).digest('hex');
const store = createSignedUiUpdateStore({ ...config, directory: path.join(root, 'signed-ui-updates') });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/iu.test(key)));
const phases = [];
let success = false;
async function run(phase) {
  const child = spawn(path.join(workspace, 'desktop/node_modules/electron/dist/electron.exe'),
    [path.join(import.meta.dirname, 'ui-update-electron-smoke.cjs'), root, phase],
    { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-5000); });
  const timer = setTimeout(() => child.kill(), 30_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer);
  fs.writeFileSync(path.join(root, `${phase}-process.log`), output);
  assert.ok(fs.existsSync(path.join(root, `${phase}.json`)), `UI native fixture produced no receipt (exit ${code}): ${output}`);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, `${phase}.json`), 'utf8'));
  phases.push({ ...receipt, exitCode: code });
  assert.equal(code, 0, output); assert.equal(receipt.ok, true, JSON.stringify(receipt));
}
function stage(sequence) {
  const input = path.join(root, `source-${sequence}`); fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, 'index.html'), `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'"></head><body><main>signed-version-${sequence}</main></body></html>`);
  const bundle = createSignedUiUpdate({ ...config, inputDirectory: input, privateKey, sequence,
    expiresAt: new Date(Date.now() + 600_000).toISOString() });
  return store.stage(bundle);
}
try {
  stage(1); await run('healthy-v1');
  stage(2); await run('trial-v2');
  await run('rollback-v1');
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, 'business-fixture.txt'))).digest('hex'), businessHash);
  success = true;
} finally {
  const output = path.join(workspace, '.codex-temp/thin-pilot-20260907'); fs.mkdirSync(output, { recursive: true });
  const reportPath = path.join(output, `ui-native-${id}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ success, phases, freshElectronProcessPerPhase: true,
    businessFixtureUnchanged: success, networkBlocked: true, noRealCredentials: true, fixtureRetained: !success,
    ...(success ? {} : { fixtureDirectory: root }) }, null, 2));
  if (success) {
    assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^wangzai-ui-native-[a-f0-9-]+$/u);
    fs.rmSync(root, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
  }
  console.log(JSON.stringify({ success, reportPath }));
}
