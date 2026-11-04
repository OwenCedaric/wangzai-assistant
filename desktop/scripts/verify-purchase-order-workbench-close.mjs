import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || 9225);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(desktopRoot, '..', '.codex-tmp', 'embedded-cef');
fs.mkdirSync(outputRoot, { recursive: true });

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('app://')) || targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error(`没有找到 Electron CDP 页面：${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let requestId = 0;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
};
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 请求超时：${method}`));
    }, 45_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'CDP_EVALUATE_FAILED');
  }
  return response.result?.value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(read, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error(`WORKBENCH_VERIFY_TIMEOUT ${JSON.stringify(value)}`);
}

function captureDesktop(fileName) {
  const filePath = path.join(outputRoot, fileName);
  const quoted = filePath.replaceAll("'", "''");
  const command = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    `$bitmap.Save('${quoted}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$graphics.Dispose()',
    '$bitmap.Dispose()',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'ignore' });
  return filePath;
}

const purchasePageReadyExpression = `document.body.innerText.includes('拍单列表')
  && !![...document.querySelectorAll('button')].find((button) => (button.innerText || '').trim() === '打开操作台')`;
if (!await evaluate(purchasePageReadyExpression)) {
  await waitFor(
    () => evaluate(`!![...document.querySelectorAll('button')]
      .find((item) => (item.innerText || '').trim() === '拍单管理')`),
    Boolean,
  );
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => (item.innerText || '').trim() === '拍单管理');
    button?.click();
    return Boolean(button);
  })()`);
}
await waitFor(
  () => evaluate(purchasePageReadyExpression),
  Boolean,
);

// A freshly synchronized order may not have a saved source URL yet. Populate
// the controlled field in-memory only; the verification never clicks save and
// therefore does not modify order/business persistence.
await evaluate(`(() => {
  const input = [...document.querySelectorAll('input')]
    .find((item) => item.placeholder === '粘贴拼多多 / 1688 / 淘宝 / 天猫链接');
  if (!input || String(input.value || '').startsWith('http')) return Boolean(input);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'https://mobile.yangkeduo.com/');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await waitFor(
  () => evaluate(`(() => {
    const input = [...document.querySelectorAll('input')]
      .find((item) => item.placeholder === '粘贴拼多多 / 1688 / 淘宝 / 天猫链接');
    return String(input?.value || '').startsWith('http');
  })()`),
  Boolean,
);

async function clickOpen() {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => (item.innerText || '').trim() === '打开操作台');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, '拍单页必须提供可点击的打开操作台按钮');
}

async function clickClose() {
  const clicked = await evaluate(`(() => {
    const button = document.querySelector('[aria-label="关闭订单操作台"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, '订单操作台必须提供可点击的关闭按钮');
}

async function readState() {
  return evaluate(`(async () => {
    const browser = await window.wangzaiDesktop.purchaseBrowser.command({ command: 'state' });
    const active = browser.tabs?.find((tab) => tab.tabId === browser.activeTabId) || null;
    const close = document.querySelector('[aria-label="关闭订单操作台"]');
    const rect = document.querySelector('[data-testid="purchase-order-browser-viewport"]')?.getBoundingClientRect();
    return {
      dialogOpen: Boolean(close),
      closeDisabled: Boolean(close?.disabled),
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      browser: {
        visible: browser.visible === true,
        boundsVersion: browser.boundsVersion,
        activeTabId: browser.activeTabId,
        tabCount: browser.tabs?.length || 0,
      },
      active: active ? {
        tabId: active.tabId,
        sessionId: active.sessionId,
        generation: active.generation,
        phase: active.phase,
        url: active.url,
        embedding: active.embedding,
      } : null,
    };
  })()`);
}

function isVisibleEmbedded(state) {
	const embedding = state?.active?.embedding;
	const chromiumWindows = Array.isArray(embedding?.chromiumWindows) ? embedding.chromiumWindows : [];
  return Boolean(
    state?.dialogOpen
    && state?.browser?.visible
	&& embedding?.embedded
	&& embedding?.childStyle
	&& embedding?.windowVisible === true
	&& embedding?.browserPanelVisible === true
	&& embedding?.browserPresentationVisible === true
	&& (chromiumWindows.length === 0 || embedding?.browserSurfaceVisible === true),
  );
}

function isClosedOffCard(state) {
	const embedding = state?.active?.embedding;
	const bounds = embedding?.bounds;
	const chromiumWindows = Array.isArray(embedding?.chromiumWindows) ? embedding.chromiumWindows : [];
  return Boolean(
    !state?.dialogOpen
    && state?.browser?.visible === false
	&& embedding?.windowVisible === false
	&& embedding?.browserPanelVisible === false
	&& embedding?.browserPresentationVisible === false
	&& embedding?.browserSurfaceVisible === false
	&& chromiumWindows.every((window) => window?.visible !== true && window?.onScreen !== true)
    && bounds
    && Number(bounds.x) <= -30_000
    && Number(bounds.y) <= -30_000,
  );
}

await clickOpen();
const firstOpenedAt = Date.now();
const firstOpen = await waitFor(readState, isVisibleEmbedded);
const openScreenshot = captureDesktop('close-fix-open.png');

await clickClose();
const closeStartedAt = Date.now();
const closed = await waitFor(readState, isClosedOffCard, 10_000);
const closeDurationMs = Date.now() - closeStartedAt;
await sleep(800);
const closedStable = await readState();
assert.equal(isClosedOffCard(closedStable), true, '旧 ResizeObserver 不得把已关闭的 CEF 子窗口重新显示');
await sleep(2200);
const closedAfterThreeSeconds = await readState();
assert.equal(isClosedOffCard(closedAfterThreeSeconds), true, 'CEF 子窗口关闭后三秒内不得异步复活');
const closedScreenshot = captureDesktop('close-fix-closed.png');

await clickOpen();
const reopenStartedAt = Date.now();
const reopened = await waitFor(readState, isVisibleEmbedded);
const reopenDurationMs = Date.now() - reopenStartedAt;
assert.equal(reopened.active.tabId, firstOpen.active.tabId, '重开必须复用原交互标签页');
assert.equal(reopened.active.sessionId, firstOpen.active.sessionId, '重开必须保留同一热 CEF Session');
assert.equal(reopened.active.generation, firstOpen.active.generation, '普通关闭不得重建账号代次');

await clickClose();
const finalClosed = await waitFor(readState, isClosedOffCard, 10_000);

console.log(JSON.stringify({
  ok: true,
  firstOpenDurationMs: Date.now() - firstOpenedAt,
  closeDurationMs,
  reopenDurationMs,
  sessionPreserved: true,
  tabCount: finalClosed.browser.tabCount,
  hiddenBounds: finalClosed.active.embedding.bounds,
	hiddenNativeWindow: {
	  windowVisible: finalClosed.active.embedding.windowVisible,
	  browserPanelVisible: finalClosed.active.embedding.browserPanelVisible,
	  browserSurfaceVisible: finalClosed.active.embedding.browserSurfaceVisible,
	  chromiumWindows: finalClosed.active.embedding.chromiumWindows,
	},
  openScreenshot,
  closedScreenshot,
}, null, 2));
socket.close();
setTimeout(() => process.exit(0), 50);
