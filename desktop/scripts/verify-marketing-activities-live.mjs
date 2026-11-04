import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] || 9223);
const shopName = String(process.argv[3] || 'Ozon 2店').trim();
const repairMode = process.argv.includes('--repair');
const endpoint = `http://127.0.0.1:${port}/json`;
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
    }, 30000);
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

async function waitFor(expression, timeoutMs = 20000, intervalMs = 100) {
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

async function readState() {
  return evaluate(`(() => {
    const page = document.querySelector('.marketing-page');
    const bodyText = page?.innerText || '';
    const firstShopSelect = page?.querySelector('.marketing-filter-controls [role="combobox"]');
    const activityItems = Array.from(page?.querySelectorAll('.marketing-activity-item') || []);
    const productRows = Array.from(page?.querySelectorAll('.marketing-products-card tbody tr') || [])
      .filter((row) => !row.innerText.includes('暂无'));
    const stats = Array.from(page?.querySelectorAll('.marketing-stat-card') || []).map((card) => card.innerText.trim());
    const notices = Array.from(document.querySelectorAll('.marketing-read-alert'))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((node) => node.innerText.trim());
    const errorTerms = [
      '读取失败',
      'Ozon 暂未返回可用活动数据',
      '本地 API 请求超时',
      '无法连接本地 API',
      'MARKETING_LEGACY_UNKNOWN_FIELD',
    ].filter((term) => bodyText.includes(term) || notices.some((notice) => notice.includes(term)));
    return {
      selectedShop: firstShopSelect?.innerText.trim() || '',
      activityCount: activityItems.length,
      productRowCount: productRows.length,
      stats,
      notices,
      errorTerms,
      readButtonText: Array.from(page?.querySelectorAll('button') || [])
        .find((button) => button.innerText.includes('读取'))?.innerText.trim() || '',
    };
  })()`);
}

await send('Page.enable');
await send('Runtime.enable');
const loginSubmitted = await evaluate(`(() => {
  const submit = document.querySelector('button[type="submit"]');
  if (!submit || submit.innerText.trim() !== '登录') return false;
  const email = document.querySelector('input[type="email"]');
  const password = document.querySelector('input[type="password"]');
  if (!email?.value || !password?.value || submit.disabled) return false;
  submit.click();
  return true;
})()`);
if (loginSubmitted) {
  await waitFor(`Array.from(document.querySelectorAll('button,a,[role="button"]'))
    .some((node) => node.innerText?.trim() === '营销活动')`, 30000, 250);
}
await waitFor(`document.body.innerText.includes(${JSON.stringify(shopName)})`, 30000, 250);
await evaluate(`(() => {
  const close = document.querySelector('.shop-settings-backdrop[data-settings-open="true"] [aria-label="关闭店铺管理弹窗"]');
  if (close) close.click();
})()`);
await clickVisibleText('营销活动');
await waitFor(`Boolean(document.querySelector('.marketing-page'))`);

const opened = await evaluate(`(() => {
  const select = document.querySelector('.marketing-page .marketing-filter-controls [role="combobox"]');
  if (!select) return false;
  select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  return true;
})()`);
if (!opened) throw new Error('营销活动店铺下拉框不存在');
await waitFor(`document.querySelectorAll('[role="option"]').length > 0`);
const options = await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.innerText.trim())`);
const selected = await evaluate(`(() => {
  const name = ${JSON.stringify(shopName)};
  const target = Array.from(document.querySelectorAll('[role="option"]') || [])
    .find((option) => option.innerText.trim() === name);
  if (!target) return false;
  target.click();
  return true;
})()`);
if (!selected) throw new Error(`店铺选项不存在：${shopName}；实际选项：${options.join(' / ')}`);

await waitFor(`document.querySelector('.marketing-page .marketing-filter-controls [role="combobox"]')?.innerText.includes(${JSON.stringify(shopName)})`);
await waitFor(`document.querySelectorAll('.marketing-activity-item').length > 0`, 30000);
if (!repairMode) {
  await waitFor(`Array.from(document.querySelectorAll('.marketing-products-card tbody tr'))
    .some((row) => !row.innerText.includes('暂无'))`, 30000, 250);
}

const initial = await readState();
if (initial.selectedShop !== shopName) throw new Error(`店铺回显错误：${JSON.stringify(initial)}`);
if (initial.activityCount === 0 || (!repairMode && initial.productRowCount === 0) || initial.errorTerms.length) {
  throw new Error(`营销冷启动快照不完整：${JSON.stringify(initial)}`);
}

await clickVisibleText('读取活动');
if (repairMode && initial.productRowCount === 0) {
  await waitFor(`Array.from(document.querySelectorAll('.marketing-products-card tbody tr'))
    .some((row) => !row.innerText.includes('暂无'))`, 120000, 500);
}
const sampleDelays = [0, 250, 750, 1500, 3000, 5000, 8000];
const samples = [];
let elapsedMs = 0;
for (const delayMs of sampleDelays) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs - elapsedMs)));
  elapsedMs = delayMs;
  const state = await readState();
  samples.push({ elapsedMs, ...state });
  if (state.selectedShop !== shopName || state.activityCount === 0 || state.productRowCount === 0 || state.errorTerms.length) {
    throw new Error(`营销刷新期间数据消失或报错：${JSON.stringify(samples.at(-1))}`);
  }
}

const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const outputDir = path.resolve('test-results');
await mkdir(outputDir, { recursive: true });
const report = {
  verifiedAt: new Date().toISOString(),
  port,
  shopName,
  repairMode,
  availableShopOptions: options,
  initial,
  samples,
};
await writeFile(path.join(outputDir, 'marketing-activities-live-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(path.join(outputDir, 'marketing-activities-live.png'), Buffer.from(screenshot.data, 'base64'));
socket.close();
console.log(JSON.stringify(report, null, 2));
