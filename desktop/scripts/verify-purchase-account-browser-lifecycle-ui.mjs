import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const testResultsRoot = path.join(desktopRoot, 'test-results');
const runRoot = path.join(testResultsRoot, `purchase-account-browser-lifecycle-${Date.now()}`);
const reportPath = path.join(testResultsRoot, 'purchase-account-browser-lifecycle-report.json');
const screenshotPath = path.join(testResultsRoot, 'purchase-account-browser-lifecycle-final.png');
const electronExecutable = path.join(
  desktopRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const accountId = 'purchase-account-lifecycle-ui';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTarget(cdpPort, child, timeoutMs = 45_000) {
  const endpoint = `http://127.0.0.1:${cdpPort}/json/list`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron 提前退出：${child.exitCode}`);
    try {
      const targets = await fetch(endpoint).then((response) => response.json());
      const target = targets.find((item) => (
        item.type === 'page'
        && String(item.url || '').startsWith('app://')
        && item.webSocketDebuggerUrl
      ));
      if (target) return target;
    } catch {}
    await delay(150);
  }
  throw new Error(`等待 Electron CDP 超时：${endpoint}`);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.consoleErrors = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.consoleErrors.push((message.params.args || [])
          .map((item) => item.value || item.description || '')
          .filter(Boolean)
          .join(' '));
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 请求超时：${method}`));
      }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面执行失败');
    }
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs = 45_000, intervalMs = 100) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.evaluate(expression)) return Date.now() - startedAt;
      await delay(intervalMs);
    }
    const body = await this.evaluate(`document.body?.innerText?.slice(0, 5000) || ''`).catch(() => '');
    throw new Error(`等待页面状态超时：${expression}\n${body}`);
  }

  close() {
    this.socket?.close();
  }
}

async function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }
  await new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(resolve, 15_000);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    killer.once('exit', finish);
    killer.once('error', finish);
  });
}

function buttonExpression(text) {
  return `Array.from(document.querySelectorAll('button'))
    .find((element) => element.innerText?.trim() === ${JSON.stringify(text)} && element.offsetParent !== null)`;
}

async function clickNativeButton(text, timeoutMs = 30_000) {
  const source = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WangzaiNativeButton {
  public delegate bool EnumWindowProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maximum);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$target = ${JSON.stringify(text)}
$script:found = [IntPtr]::Zero
$top = [WangzaiNativeButton+EnumWindowProc]{
  param([IntPtr]$window, [IntPtr]$unused)
  $child = [WangzaiNativeButton+EnumWindowProc]{
    param([IntPtr]$handle, [IntPtr]$unusedChild)
    $buffer = New-Object System.Text.StringBuilder 256
    [void][WangzaiNativeButton]::GetWindowText($handle, $buffer, $buffer.Capacity)
    if ($buffer.ToString() -eq $target -and [WangzaiNativeButton]::IsWindowVisible($handle)) {
      $script:found = $handle
      return $false
    }
    return $true
  }
  [void][WangzaiNativeButton]::EnumChildWindows($window, $child, [IntPtr]::Zero)
  return $script:found -eq [IntPtr]::Zero
}
[void][WangzaiNativeButton]::EnumWindows($top, [IntPtr]::Zero)
if ($script:found -eq [IntPtr]::Zero) { exit 2 }
[void][WangzaiNativeButton]::SendMessage($script:found, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
exit 0
`;
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exitCode = await new Promise((resolve) => {
      const clicker = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
      ], { stdio: 'ignore', windowsHide: true });
      clicker.once('error', () => resolve(-1));
      clicker.once('exit', (code) => resolve(code));
    });
    if (exitCode === 0) return true;
    await delay(150);
  }
  throw new Error(`没有找到原生按钮：${text}`);
}

async function purchaseBrowserState(cdp) {
  return cdp.evaluate(`window.wangzaiDesktop.purchaseBrowser.command({ command: 'state' })`);
}

await mkdir(runRoot, { recursive: true });
const [cdpPort, localApiPort, bridgePort] = await Promise.all([reservePort(), reservePort(), reservePort()]);
const child = spawn(electronExecutable, [
  '--disable-background-networking',
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${cdpPort}`,
  '.',
  '--dashboard-visual-test',
  '--purchase-account-browser-lifecycle-ui-test',
], {
  cwd: desktopRoot,
  env: {
    ...process.env,
    WANGZAI_DESKTOP_DATA_DIR: runRoot,
    WANGZAI_LICENSE_MODE: 'off',
    WANGZAI_PURCHASE_BROWSER_LOGIN_FIXTURE: '1',
    LOCAL_API_PORT: String(localApiPort),
    PURCHASE_SEARCH_BRIDGE_PORT: String(bridgePort),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let stdout = '';
let stderr = '';
child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

let cdp;
const report = {
  ok: false,
  runRoot,
  cdpPort,
  localApiPort,
  bridgePort,
  observations: {},
};

try {
  const target = await waitForTarget(cdpPort, child);
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.waitFor(`document.readyState === 'complete' && Boolean(document.querySelector('.app-root'))`, 45_000);

  const seedResult = await cdp.evaluate(`window.wangzaiDesktop.localApiRequest(${JSON.stringify({
    path: '/api/purchase/accounts',
    method: 'POST',
    body: {
      id: accountId,
      name: '浏览器生命周期实机账号',
      platformName: '1688',
      platformUrl: 'https://www.1688.com/',
      loginAccount: 'lifecycle-ui-user',
      loginPassword: 'lifecycle-ui-password',
      recipientNickname: '实机测试仓',
      recipientPhone: '13800000000',
      recipientAddress: '实机测试地址',
      status: 'active',
      isDefault: true,
    },
    timeoutMs: 30_000,
  })})`);
  assert.equal(seedResult?.ok, true, `采购账号种子写入失败：${JSON.stringify(seedResult)}`);

  await cdp.evaluate(`window.dispatchEvent(new CustomEvent('wangzai-settings-open', {
    detail: { moduleId: 'purchaseAccount' }
  })); true`);
  await cdp.waitFor(`document.querySelector('.shop-settings-backdrop')?.dataset.settingsOpen === 'true'`);
  await cdp.waitFor(`document.querySelector('.shop-settings-dialog-paper')?.dataset.settingsRenderReady === 'true'`);
  await cdp.waitFor(`(() => {
    const button = ${buttonExpression('打开登录窗口')};
    return Boolean(button && !button.disabled);
  })()`);

  const openStartedAt = Date.now();
  const clickCount = await cdp.evaluate(`(() => {
    const button = ${buttonExpression('打开登录窗口')};
    if (!button) return 0;
    button.click();
    button.click();
    return 2;
  })()`);
  assert.equal(clickCount, 2);
  const openElapsedMs = await cdp.waitFor(`(async () => {
    const state = await window.wangzaiDesktop.purchaseBrowser.command({ command: 'state' });
    return state.visible === true
      && state.tabs?.filter((tab) => tab.accountId === ${JSON.stringify(accountId)}).length === 1
      && Boolean(${buttonExpression('关闭窗口')})
      && !document.querySelector('.purchase-browser-login-viewport');
  })()`, 60_000);
  const stateAfterDoubleOpen = await purchaseBrowserState(cdp);
  assert.equal(stateAfterDoubleOpen.visible, true);
  assert.equal(stateAfterDoubleOpen.tabs.filter((tab) => tab.accountId === accountId).length, 1);
  const desktopLogPath = path.join(runRoot, 'logs', 'desktop-main.log');
  const logAfterDoubleOpen = await readFile(desktopLogPath, 'utf8').catch(() => '');
  const initialOpenStageCount = (logAfterDoubleOpen.match(/\[purchase-browser\] open stage=complete /gu) || []).length;
  assert.equal(initialOpenStageCount, 1, '连续点击产生了重复原生 open');
  report.observations.doubleOpen = {
    requestedClicks: clickCount,
    openElapsedMs: Date.now() - openStartedAt,
    waitElapsedMs: openElapsedMs,
    nativeOpenCount: initialOpenStageCount,
    matchingTabCount: 1,
  };

  const minimizeStartedAt = Date.now();
  await cdp.evaluate(`document.querySelector('button[aria-label="最小化店铺管理弹窗"]')?.click(); true`);
  await cdp.waitFor(`document.querySelector('.shop-settings-backdrop')?.dataset.settingsOpen === 'false'`);
  await delay(500);
  const stateAfterMinimize = await purchaseBrowserState(cdp);
  assert.equal(stateAfterMinimize.visible, true, '独立登录窗口不应随设置弹窗最小化而关闭');
  report.observations.minimize = {
    totalElapsedMs: Date.now() - minimizeStartedAt,
    visible: stateAfterMinimize.visible,
    independent: true,
  };

  await cdp.waitFor(`Boolean(document.querySelector('button[aria-label="恢复店铺管理"]'))`);
  await cdp.evaluate(`document.querySelector('button[aria-label="恢复店铺管理"]')?.click(); true`);
  await cdp.waitFor(`document.querySelector('.shop-settings-backdrop')?.dataset.settingsOpen === 'true'`);
  await cdp.waitFor(`Boolean(${buttonExpression('恢复登录窗口')})`);
  await delay(300);
  const stateAfterRestore = await purchaseBrowserState(cdp);
  assert.equal(stateAfterRestore.visible, true);
  report.observations.restore = { visible: stateAfterRestore.visible, keptIndependentWindow: true };

  const activeTab = stateAfterRestore.tabs.find((tab) => tab.accountId === accountId);
  assert.ok(activeTab?.tabId, '没有找到当前采购账号的独立 CEF 标签');
  const fixtureSeed = await cdp.evaluate(`window.wangzaiDesktop.purchaseBrowser.command(${JSON.stringify({
    command: 'purchase-login-fixture',
    tabId: activeTab.tabId,
  })})`);
  assert.equal(fixtureSeed?.result?.ok, true, '原生 CEF 登录 Cookie fixture 写入失败');

  const saveStartedAt = Date.now();
  await clickNativeButton('保存登录信息');
  const saveElapsedMs = await cdp.waitFor(`(async () => {
    const state = await window.wangzaiDesktop.purchaseBrowser.command({ command: 'state' });
    return state.visible === false && document.body?.innerText?.includes('Cookie 已保存');
  })()`, 30_000);
  const accountReadback = await cdp.evaluate(`window.wangzaiDesktop.localApiRequest(${JSON.stringify({
    path: '/api/purchase/accounts',
    method: 'GET',
    timeoutMs: 30_000,
  })})`);
  const savedAccounts = Array.isArray(accountReadback?.data?.accounts)
    ? accountReadback.data.accounts
    : Array.isArray(accountReadback?.accounts)
      ? accountReadback.accounts
      : [];
  const savedAccount = savedAccounts.find((account) => account.id === accountId);
  assert.equal(savedAccount?.browserLoginStatus, '已登录');
  assert.equal(savedAccount?.cookieStatus, 'Cookie 已保存');
  assert.ok(savedAccount?.lastLoginVerifiedAt);
  report.observations.saveAndAutoClose = {
    totalElapsedMs: Date.now() - saveStartedAt,
    waitElapsedMs: saveElapsedMs,
    visible: (await purchaseBrowserState(cdp)).visible,
    cookieStatus: savedAccount.cookieStatus,
    lastLoginVerifiedAt: savedAccount.lastLoginVerifiedAt,
  };

  await cdp.evaluate(`document.querySelector('.shop-settings-actions button')?.click(); true`);
  await cdp.evaluate(`window.dispatchEvent(new CustomEvent('wangzai-settings-open', {
    detail: { moduleId: 'purchaseAccount' }
  })); true`);
  await cdp.waitFor(`document.querySelector('.shop-settings-backdrop')?.dataset.settingsOpen === 'true'`);
  await cdp.waitFor(`document.body?.innerText?.includes('Cookie 已保存')`);
  report.observations.reopenReadback = { cookieStatusVisible: true };

  await cdp.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await delay(250);

  const screenshot = await cdp.evaluate(`window.wangzaiDesktop.captureDashboardVisual({ rect: null })`);
  assert.equal(screenshot?.ok, true, '隐藏 Electron capturePage 没有返回截图');
  assert.ok(screenshot?.pngBase64, '隐藏 Electron 截图内容为空');
  await writeFile(screenshotPath, Buffer.from(screenshot.pngBase64, 'base64'));
  const knownConsoleNoise = cdp.consoleErrors.filter((message) => (
    message.includes('Electron sandboxed_renderer.bundle.js script failed to run')
    || message.includes("Cannot destructure property 'preloadScripts' of 'binding.startupData'")
  ));
  const unexpectedConsoleErrors = cdp.consoleErrors.filter((message) => !knownConsoleNoise.includes(message));
  assert.deepEqual(unexpectedConsoleErrors, [], '主 Renderer 出现未预期的 console error');
  report.ok = true;
  report.consoleErrors = unexpectedConsoleErrors;
  report.knownConsoleNoise = knownConsoleNoise;
  report.screenshotPath = screenshotPath;
} catch (error) {
  report.error = String(error?.stack || error);
  report.stdout = stdout.slice(-5000);
  report.stderr = stderr.slice(-5000);
  throw error;
} finally {
  cdp?.close();
  await stopProcessTree(child);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
  ok: report.ok,
  reportPath,
  screenshotPath,
  observations: report.observations,
}, null, 2));
