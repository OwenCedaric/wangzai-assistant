const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const [directory, ordersText, mode] = process.argv.slice(2);
assert.ok(directory && /[\\/]\.managed-dev-scratch[\\/]run-[a-f0-9-]+[\\/]work[\\/]profit-browser$/i.test(directory));
assert.equal(fs.existsSync(path.join(directory, 'index.html')), true);
const orders = Number(ordersText);
assert.ok(Number.isSafeInteger(orders) && orders >= 10 && orders <= 200000);
assert.ok(['baseline', 'candidate'].includes(mode));
app.setPath('userData', path.join(directory, `user-data-${mode}`));
app.setPath('logs', path.join(directory, 'logs'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
let window, finished = false, blockedRequests = 0;
const timer = setTimeout(() => finish({ complete: false, error: 'FIXTURE_TIMEOUT' }), 180000);
function finish(result) {
  if (finished) return;
  finished = true; clearTimeout(timer);
  const report = { ...result, electron: process.versions.electron, chromium: process.versions.chrome,
    hidden: window ? !window.isVisible() : true, focused: window ? window.isFocused() : false, blockedRequests };
  fs.writeFileSync(path.join(directory, `result-${mode}.json`), JSON.stringify(report, null, 2));
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(result.complete && !report.focused && report.hidden && blockedRequests === 0 ? 0 : 1);
}
ipcMain.on('profit-fixture-progress', (_, value) => console.log(JSON.stringify(value)));
ipcMain.on('profit-fixture-finished', (_, result) => finish(result));
app.whenReady().then(async () => {
  const isolated = session.fromPartition(`profit-fixture-${process.pid}`);
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const allowed = ['file:', 'data:', 'blob:', 'devtools:'].includes(new URL(details.url).protocol);
    if (!allowed) blockedRequests++;
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: {
    session: isolated, offscreen: true, backgroundThrottling: false, contextIsolation: true,
    nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'profit-lanes-browser-preload.cjs'),
  } });
  window.webContents.on('render-process-gone', (_, details) => finish({ complete: false, error: details.reason }));
  window.webContents.on('console-message', event => { if (/Error|FIXTURE_/.test(event.message)) console.log(event.message); });
  const url = pathToFileURL(path.join(directory, 'index.html')); url.searchParams.set('orders', String(orders)); url.searchParams.set('mode', mode);
  await window.loadURL(url.href);
}).catch(error => finish({ complete: false, error: error.message }));
