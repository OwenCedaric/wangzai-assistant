import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Agent } from 'node:https';
import https from 'node:https';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = path.resolve(process.argv.find(arg => arg.startsWith('--state-dir='))?.slice(12) || path.join(root, '.selfhost'));
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'deployment.json'), 'utf8'));
if (!manifest.ready || path.resolve(manifest.clientRoot) !== root) throw new Error('SELF_HOST_CLIENT_ROOT_MISMATCH');
const url = new URL(manifest.serverUrl);
if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw new Error('SELF_HOST_REQUIRES_LOCAL_HTTPS');
}
const caPath = path.join(state, 'ca.pem');
const agent = new Agent({ ca: fs.readFileSync(caPath), rejectUnauthorized: true });
await new Promise((resolve, reject) => {
  const request = https.get(new URL('/health', url), { agent, timeout: 5000 }, response => {
    let body = '';
    response.on('data', part => { body += part; if (body.length > 4096) request.destroy(new Error('SELF_HOST_HEALTH_TOO_LARGE')); });
    response.on('end', () => {
      try { if (response.statusCode !== 200 || JSON.parse(body).database !== 'ok') throw new Error('SELF_HOST_NOT_HEALTHY'); resolve(); }
      catch (error) { reject(error); }
    });
  });
  request.on('timeout', () => request.destroy(new Error('SELF_HOST_UNAVAILABLE_START_SERVER_FIRST')));
  request.on('error', reject);
});
agent.destroy();
const require = createRequire(path.join(root, 'desktop/package.json'));
const electron = require('electron');
const identity = JSON.parse(fs.readFileSync(path.join(root, 'desktop/current-version.json'), 'utf8'));
const env = { ...process.env, WANGZAI_SELFHOST_CA_FILE: caPath,
  WANGZAI_DESKTOP_DATA_DIR: path.join(state, 'desktop-profile'),
  PURCHASE_SEARCH_BRIDGE_PORT: String(identity.ports.purchaseBridge),
  LOCAL_API_PORT: String(identity.ports.localApi), WANGZAI_CACHE_AGENT_PORT: String(identity.ports.cacheAgent),
  WANGZAI_OZON_PUSH_GATEWAY_PORT: String(identity.ports.ozonPushGateway),
  WANGZAI_BROWSER_PREWARM_DISABLED: '1', WANGZAI_LICENSE_MODE: 'enforce',
};
delete env.LICENSE_CENTER_URL;
delete env.WANGZAI_ALLOW_TEST_FIXTURE_URLS;
const child = spawn(electron, [path.join(root, 'desktop')], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
