import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] || 9223);
const rounds = Math.max(1, Number(process.argv[3] || 2));
const endpoint = `http://127.0.0.1:${port}/json`;
const retiredToolTitles = ['商品场景图说明', 'Ozon 图搜', 'Ozon 搜品', 'Ozon 榜单', 'Ozon 补货'];
const targets = await fetch(endpoint).then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('app://')) || targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error(`没有找到可用的 Electron CDP 页面：${endpoint}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let requestId = 0;

await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(request.timeoutId);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
};

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 请求超时：${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timeoutId });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败');
  }
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 20_000, intervalMs = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return Date.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待页面状态超时：${expression}`);
}

async function clickVisibleText(label) {
  const clicked = await evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const visible = (element) => {
      if (element.closest('[hidden]')) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const candidates = Array.from(document.querySelectorAll('button,[role="button"],a,[tabindex]'))
      .filter((element) => visible(element) && element.innerText?.trim().includes(label))
      .sort((left, right) => left.innerText.trim().length - right.innerText.trim().length);
    const target = candidates.find((element) => element.innerText.trim() === label) || candidates[0];
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`没有找到可点击入口：${label}`);
}

async function closeBlockingDialog() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const closed = await evaluate(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const settingsClose = document.querySelector(
        '.shop-settings-backdrop[data-settings-open="true"] [aria-label="关闭店铺管理弹窗"]'
      );
      if (settingsClose && visible(settingsClose)) {
        settingsClose.click();
        return true;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible).reverse();
      const dialog = dialogs[0];
      if (!dialog) return false;
      const buttons = Array.from(dialog.querySelectorAll('button')).filter(visible);
      const close = buttons.find((button) => String(button.getAttribute('aria-label') || '').includes('关闭'))
        || buttons.find((button) => button.innerText.trim() === '关闭');
      if (!close) return false;
      close.click();
      return true;
    })()`);
    if (!closed) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const pageExpression = `Array.from(document.querySelectorAll('.prompt-library-page')).find((element) => {
  if (element.closest('[hidden]')) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
})`;

async function openShopOptions() {
  const opened = await evaluate(`(() => {
    const page = ${pageExpression};
    const select = page?.querySelector('[role="combobox"][aria-label="智能工具当前店铺"]');
    if (!select) return false;
    select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    return true;
  })()`);
  if (!opened) throw new Error('智能工具店铺切换下拉框不存在');
  await waitFor(`document.querySelectorAll('[role="option"]').length > 0`);
}

async function readShopOptions() {
  await openShopOptions();
  const options = await evaluate(`Array.from(document.querySelectorAll('[role="option"]'))
    .filter((option) => option.getAttribute('aria-disabled') !== 'true')
    .map((option) => ({
      value: option.getAttribute('data-value') || '',
      text: option.innerText.trim(),
      name: option.innerText.trim().split(/\\r?\\n/u)[0] || '',
    }))`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(`document.querySelectorAll('[role="option"]').length === 0`);
  return options;
}

async function selectShop(option) {
  await openShopOptions();
  const clicked = await evaluate(`(() => {
    const value = ${JSON.stringify(option.value)};
    const target = Array.from(document.querySelectorAll('[role="option"]'))
      .find((item) => (item.getAttribute('data-value') || '') === value);
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`智能工具店铺选项不存在：${option.text}`);
  await waitFor(`document.querySelectorAll('[role="option"]').length === 0`);
  const durationMs = await waitFor(`(() => {
    const page = ${pageExpression};
    const select = page?.querySelector('[role="combobox"][aria-label="智能工具当前店铺"]');
    return Boolean(select && select.innerText.includes(${JSON.stringify(option.name)}));
  })()`);
  return evaluate(`(() => {
    const page = ${pageExpression};
    const select = page?.querySelector('[role="combobox"][aria-label="智能工具当前店铺"]');
    return { selectedText: select?.innerText.trim() || '', durationMs: ${durationMs} };
  })()`);
}

await send('Page.enable');
await send('Runtime.enable');
await closeBlockingDialog();
await clickVisibleText('智能工具');
await waitFor(`Boolean(${pageExpression})`, 60_000);

const catalogState = await evaluate(`(() => {
  const page = ${pageExpression};
  const titles = Array.from(page?.querySelectorAll('.prompt-library-tool-card-heading') || [])
    .map((heading) => heading.innerText.trim().split(/\\r?\\n/u)[0])
    .filter(Boolean);
  const retiredTitles = ${JSON.stringify(retiredToolTitles)};
  return {
    titles,
    retiredVisible: retiredTitles.filter((title) => titles.includes(title)),
  };
})()`);
if (catalogState.retiredVisible.length) {
  throw new Error(`废弃智能工具仍然可见：${JSON.stringify(catalogState.retiredVisible)}`);
}

const headerState = await evaluate(`(() => {
  const page = ${pageExpression};
  const select = page?.querySelector('[role="combobox"][aria-label="智能工具当前店铺"]');
  const actions = select?.closest('.hero-actions');
  return {
    hasSelector: Boolean(select),
    selectorText: select?.innerText.trim() || '',
    actionText: actions?.innerText || '',
    hasSafetyButton: Array.from(actions?.querySelectorAll('button') || [])
      .some((button) => button.innerText.trim() === '安全规则'),
  };
})()`);
if (!headerState.hasSelector) throw new Error(`智能工具页没有店铺切换器：${JSON.stringify(headerState)}`);
if (headerState.hasSafetyButton || headerState.actionText.includes('安全规则')) {
  throw new Error(`废弃的安全规则入口仍然可见：${JSON.stringify(headerState)}`);
}

const options = await readShopOptions();
if (!options.length) throw new Error('智能工具店铺切换器没有可用店铺');
if (options.some((option) => !option.value || !option.name)) {
  throw new Error(`智能工具店铺选项存在空值：${JSON.stringify(options)}`);
}
if (new Set(options.map((option) => option.value)).size !== options.length) {
  throw new Error(`智能工具店铺选项存在重复 shopId：${JSON.stringify(options)}`);
}

const observations = [];
for (let round = 1; round <= rounds; round += 1) {
  for (const option of options) {
    const state = await selectShop(option);
    if (!state.selectedText.includes(option.name)) {
      throw new Error(`智能工具店铺切换回显错误：${JSON.stringify({ round, option, state })}`);
    }
    observations.push({ round, option, ...state });
  }
}

const selectedOption = options.at(-1);
const openedRun = await evaluate(`(() => {
  const page = ${pageExpression};
  const button = Array.from(page?.querySelectorAll('.prompt-library-tool-card button') || [])
    .find((item) => item.innerText.trim() === '使用功能' && !item.disabled);
  if (!button) return false;
  button.scrollIntoView({ block: 'center', inline: 'center' });
  button.click();
  return true;
})()`);
if (!openedRun) throw new Error('没有找到可运行的智能工具卡片');
await waitFor(`Array.from(document.querySelectorAll('.prompt-library-run-dialog'))
  .some((dialog) => dialog.innerText.includes('当前店铺：${String(selectedOption.name).replaceAll("'", "\\'")}'))`);

const runScope = await evaluate(`(() => {
  const dialog = Array.from(document.querySelectorAll('.prompt-library-run-dialog'))
    .find((item) => item.innerText.includes('当前店铺：'));
  return {
    title: dialog?.querySelector('.MuiDialogTitle-root')?.innerText.trim() || '',
    text: dialog?.innerText || '',
  };
})()`);
if (!runScope.text.includes(`当前店铺：${selectedOption.name}`)) {
  throw new Error(`运行弹窗没有继承当前店铺：${JSON.stringify(runScope)}`);
}

const outputDirectory = path.resolve('test-results');
await mkdir(outputDirectory, { recursive: true });
const runScreenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const runScreenshotPath = path.join(outputDirectory, 'prompt-library-shop-run-scope-ui.png');
await writeFile(runScreenshotPath, Buffer.from(runScreenshot.data, 'base64'));

const closedRun = await evaluate(`(() => {
  const button = document.querySelector('.prompt-library-run-dialog [aria-label="关闭使用功能"]');
  if (!button) return false;
  button.click();
  return true;
})()`);
if (!closedRun) throw new Error('智能工具运行弹窗缺少关闭按钮');
await waitFor(`!Array.from(document.querySelectorAll('.prompt-library-run-dialog')).some((dialog) => {
  const rect = dialog.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
})`);
await closeBlockingDialog();
await evaluate(`(() => {
  const page = ${pageExpression};
  page?.scrollIntoView({ block: 'start', inline: 'nearest' });
  window.scrollTo(0, 0);
  return true;
})()`);
await new Promise((resolve) => setTimeout(resolve, 150));
const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const screenshotPath = path.join(outputDirectory, 'prompt-library-shop-ui.png');
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));

const report = {
  generatedAt: new Date().toISOString(),
  port,
  rounds,
  headerState,
  catalogState,
  shops: options,
  switches: observations.length,
  observations,
  runScopeTitle: runScope.title,
  screenshotPath,
  runScreenshotPath,
};
const reportPath = path.join(outputDirectory, 'prompt-library-shop-ui-report.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(JSON.stringify(report, null, 2));
socket.close();
