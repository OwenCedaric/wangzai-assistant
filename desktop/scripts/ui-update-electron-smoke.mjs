import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { createUiUpdateRuntime, registerUiUpdateIpc } from '../src/updates/uiUpdateRuntime.js';
import { registerAppProtocol } from '../src/protocol/appProtocol.js';

const root = path.resolve(process.argv[2] || ''), phase = process.argv[3];
assert.match(path.basename(root), /^wangzai-ui-native-[a-f0-9-]+$/u);
assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
assert.equal(fixture.contract, 'wangzai-ui-native-fixture/v1');
assert.ok(['healthy-v1', 'trial-v2', 'rollback-v1'].includes(phase));
app.setPath('userData', path.join(root, `electron-${phase}`));
let window;
const runtime = createUiUpdateRuntime({ config: fixture.config, dataRoot: root,
  bundledDirectory: path.join(root, 'bundled'), healthDelayMs: 100,
  getSession: async () => ({ authorized: true, user: { id: 'synthetic-user' } }),
  getToken: async () => 'synthetic-only',
});
try {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'] }, (_details, done) => done({ cancel: true }));
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, done) => done(false));
  const boot = runtime.prepareBoot();
  registerAppProtocol({ protocol, appHost: 'wangzai', frontendDist: boot.directory,
    localDataRoot: path.join(root, 'unused-local-data'), purchaseBridge: null,
    readVerifiedStatic: url => runtime.readStatic(url) });
  registerUiUpdateIpc({ ipcMain, getWindow: () => window, runtime });
  window = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, nodeIntegration: false,
      preload: path.resolve(import.meta.dirname, '../src/preload.cjs') } });
  runtime.bindWindow(window);
  await window.loadURL('app://wangzai/');
  const observed = await window.webContents.executeJavaScript(`({ text: document.querySelector('main')?.textContent,
    focused: document.hasFocus(), platform: window.wangzaiDesktop?.platform })`);
  assert.equal(window.isVisible(), false); assert.equal(window.isFocused(), false); assert.equal(observed.focused, false);
  assert.equal(observed.text, phase === 'trial-v2' ? 'signed-version-2' : 'signed-version-1');
  if (phase === 'healthy-v1') {
    const receipt = await window.webContents.executeJavaScript('window.wangzaiDesktop.uiUpdates.ready()');
    assert.equal(receipt.accepted, true);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(runtime.status().trial, false);
  } else if (phase === 'trial-v2') {
    // Real renderer failure before the health handshake; next fresh process
    // must select the previous signed version, never restart any business job.
    await window.webContents.executeJavaScript('window.wangzaiDesktop.uiUpdates.failed()');
    assert.equal(runtime.status().trial, true);
  } else {
    assert.equal(boot.rolledBack, true); assert.equal(runtime.status().trial, false);
  }
  const missing = await window.webContents.executeJavaScript(`fetch('app://wangzai/assets/not-present.js').then(r => r.status)`);
  assert.equal(missing, 404);
  fs.writeFileSync(path.join(root, `${phase}.json`), JSON.stringify({ ok: true, phase, bootId: boot.id,
    rolledBack: boot.rolledBack === true, isVisible: window.isVisible(), isFocused: window.isFocused(),
    documentHasFocus: observed.focused, text: observed.text, pid: process.pid }));
} catch (error) {
  fs.writeFileSync(path.join(root, `${phase}.json`), JSON.stringify({ ok: false, phase, error: error.message }));
  process.exitCode = 1;
} finally {
  runtime.dispose(); window?.destroy(); app.exit(process.exitCode || 0);
}
