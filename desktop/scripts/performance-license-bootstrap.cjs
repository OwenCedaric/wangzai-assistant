'use strict';
// Test-only environment adapter: real login UI, IPC, issuer and verification.
// It replaces no token checks, permissions, application source or real files.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { syncBuiltinESMExports } = require('node:module');

if (process.versions.electron && process.type === 'browser') {
  const { app } = require('electron');
  assert.equal(app.isPackaged, false, 'TEST_AUTH_FORBIDS_PACKAGED');
  assert.ok(process.argv.includes('--performance-test') && process.argv.includes('--dashboard-visual-test'));
  const directory = path.resolve(process.env.WANGZAI_PERFORMANCE_LICENSE_DIRECTORY || '');
  assert.match(directory, /[\\/]\.managed-dev-scratch[\\/]run-[a-f0-9-]+[\\/]work[\\/]authorization$/i);
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
  const distribution = JSON.parse(fs.readFileSync(path.join(directory, 'client/resources/distribution.json'), 'utf8'));
  assert.equal(distribution.license_mode, 'enforce');
  assert.equal(distribution.campaign_code, 'test-fixture');
  assert.equal(new URL(distribution.license_center_url).hostname, '127.0.0.1');
  const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'credentials.private.json'), 'utf8'));
  assert.equal(credentials.email, 'isolated-customer@fixture.invalid');
  const originalRead = fs.readFileSync;
  const actualResources = path.resolve(__dirname, '../resources');
  const replacements = new Map(['project.json', 'distribution.json'].map(name => [
    path.join(actualResources, name).toLowerCase(), path.join(directory, 'client/resources', name),
  ]));
  fs.readFileSync = function (file, ...args) {
    const replacement = typeof file === 'string' ? replacements.get(path.resolve(file).toLowerCase()) : null;
    return originalRead.call(this, replacement || file, ...args);
  };
  syncBuiltinESMExports();
  const mark = phase => fs.appendFileSync(process.env.WANGZAI_PERFORMANCE_NETWORK_LOG,
    JSON.stringify({ event: 'auth-adapter', phase, pid: process.pid }) + '\n');
  mark('installed');
  app.on('browser-window-created', (_event, window) => {
    const contents = window.webContents;
    mark('window-created');
    const execute = contents.executeJavaScript.bind(contents);
    let login;
    const ensureLogin = () => login ||= (async () => {
      mark('login-start');
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const ready = await execute("Boolean(document.querySelector('.desktop-access-form input[type=email]:not(:disabled)'))").catch(() => false);
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const fields = JSON.stringify({ email: credentials.email, password: credentials.password });
      const entered = await execute(`(() => {
        const values=${fields};
        const email=document.querySelector('.desktop-access-form input[type=email]');
        const password=document.querySelector('.desktop-access-form input[type=password]');
        if(!email||!password)return false;
        const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
        set.call(email,values.email); email.dispatchEvent(new Event('input',{bubbles:true}));
        set.call(password,values.password); password.dispatchEvent(new Event('input',{bubbles:true}));
        return true;
      })()`);
      assert.equal(entered, true, 'TEST_LOGIN_FORM_UNAVAILABLE');
      await new Promise(resolve => setTimeout(resolve, 50));
      await execute("document.querySelector('.desktop-access-form button[type=submit]').click()");
      while (Date.now() < deadline) {
        const state = await execute("({workspace:Boolean(document.querySelector('.content-shell')),error:document.querySelector('.desktop-access-alert')?.textContent||''})");
        if (state.workspace) {
          const session = await execute('window.wangzaiDesktop.license.getSession()');
          assert.equal(session.authorized, true, 'TEST_LOGIN_NOT_AUTHORIZED');
          // Login's real autoFocus affects the hidden webview. Relinquish that
          // focus through Electron, never by replacing document.hasFocus().
          window.blurWebView();
          window.blur();
          assert.equal(await execute('document.hasFocus()'), false, 'TEST_WEBVIEW_STILL_FOCUSED');
          console.log('[performance-license] real-login-and-entitlement-ready');
          return;
        }
        if (state.error) throw new Error(`TEST_LOGIN_FAILED:${state.error}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('TEST_LOGIN_TIMEOUT');
    })();
    // The application smoke/navigation code waits for the actual login form's
    // normal completion instead of timing the login screen or injecting state.
    contents.executeJavaScript = async (...args) => {
      await ensureLogin();
      if (process.env.WANGZAI_PERFORMANCE_CPU_PROFILE !== '1' || !String(args[0]).includes('const expectedProductCount =')) return execute(...args);
      const debug = contents.debugger;
      assert.equal(debug.isAttached(), false, 'TEST_CPU_DEBUGGER_ALREADY_ATTACHED');
      debug.attach('1.3');
      try {
        await debug.sendCommand('Profiler.enable');
        await debug.sendCommand('Profiler.start');
        try { return await execute(...args); } finally {
          const { profile } = await debug.sendCommand('Profiler.stop');
          fs.writeFileSync(path.join(process.env.WANGZAI_DESKTOP_DATA_DIR, 'purchase.cpuprofile'), JSON.stringify(profile));
        }
      } finally { debug.detach(); }
    };
  });
}
