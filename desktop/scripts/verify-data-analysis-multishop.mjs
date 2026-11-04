import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] || 9223);
const rounds = Math.max(1, Number(process.argv[3] || 3));
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

async function waitFor(expression, timeoutMs = 15000, intervalMs = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return Date.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待页面状态超时：${expression}`);
}

async function clickSmallestVisibleText(label) {
  const clicked = await evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const visible = (element) => {
      if (element.closest('[hidden]')) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && style.pointerEvents !== 'none';
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
  await evaluate(`(() => {
    const close = document.querySelector(
      '.shop-settings-backdrop[data-settings-open="true"] [aria-label="关闭店铺管理弹窗"], [aria-label="关闭数据说明"]'
    );
    if (!close) return false;
    close.click();
    return true;
  })()`);
}

const visibleMainExpression = `Array.from(document.querySelectorAll('[data-testid="data-analysis-main"]'))
  .find((element) => {
    if (element.closest('[hidden]')) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  })`;

async function openShopOptions() {
  const opened = await evaluate(`(() => {
    const main = ${visibleMainExpression};
    const select = main?.querySelector('[role="combobox"][aria-label="店铺范围"]');
    if (!select) return false;
    select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    return true;
  })()`);
  if (!opened) throw new Error('数据分析店铺范围下拉框不存在');
  await waitFor(`document.querySelectorAll('[role="option"]').length > 0`);
}

async function readShopOptions() {
  await openShopOptions();
  const options = await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).map((option) => ({
    value: option.getAttribute('data-value') || '',
    text: option.innerText.trim(),
    name: option.innerText.trim().split(/\\r?\\n/u)[0] || '全部店铺',
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
    const text = ${JSON.stringify(option.text)};
    const candidates = Array.from(document.querySelectorAll('[role="option"]'));
    const target = candidates.find((item) => (item.getAttribute('data-value') || '') === value)
      || candidates.find((item) => item.innerText.trim() === text);
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`店铺选项不存在：${option.text}`);
  await waitFor(`document.querySelectorAll('[role="option"]').length === 0`);
  await waitFor(`(() => {
    const main = ${visibleMainExpression};
    const select = main?.querySelector('[role="combobox"][aria-label="店铺范围"]');
    const syncButton = Array.from(main?.querySelectorAll('button') || []).find((button) => button.innerText.includes('同步流量'));
    return Boolean(select && syncButton && !syncButton.disabled && select.innerText.includes(${JSON.stringify(option.name)}));
  })()`, 20000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return evaluate(`(() => {
    const main = ${visibleMainExpression};
    const text = main?.innerText || '';
    return {
      selectedText: main?.querySelector('[role="combobox"][aria-label="店铺范围"]')?.innerText.trim() || '',
      updatedAt: Array.from(main?.querySelectorAll('*') || [])
        .map((element) => element.innerText?.trim() || '')
        .find((value) => value.startsWith('数据更新于 ')) || '',
      metrics: Array.from(main?.querySelectorAll('[data-testid="overview-kpi-card"]') || [])
        .map((node) => ({ id: node.dataset.metricId || '', text: node.innerText.trim() })),
      errorTerms: ['页面显示异常', '数据分析读取失败', '本地 API 请求超时', '无法连接本地 API']
        .filter((term) => text.includes(term)),
      hasNaN: /(^|\s)NaN($|\s)/u.test(text),
      hasUndefined: /(^|\s)undefined($|\s)/u.test(text),
    };
  })()`);
}

await send('Page.enable');
await send('Runtime.enable');
await closeBlockingDialog();
await clickSmallestVisibleText('数据分析');
await waitFor(`Boolean(${visibleMainExpression})`, 20000);

const options = await readShopOptions();
if (options.length < 2) throw new Error(`店铺范围选项不足，无法执行多店铺切换：${JSON.stringify(options)}`);

const observations = [];
for (let round = 1; round <= rounds; round += 1) {
  for (const option of options) {
    const startedAt = Date.now();
    const state = await selectShop(option);
    const durationMs = Date.now() - startedAt;
    const observation = { round, option, durationMs, ...state };
    if (state.errorTerms.length || state.hasNaN || state.hasUndefined) {
      throw new Error(`店铺切换后页面异常：${JSON.stringify(observation)}`);
    }
    if (!state.selectedText.includes(option.name)) {
      throw new Error(`店铺选择回显错误：${JSON.stringify(observation)}`);
    }
    if (state.metrics.length !== 6) {
      throw new Error(`店铺切换后核心指标不完整：${JSON.stringify(observation)}`);
    }
    observations.push(observation);
  }
}

const statusOpened = await evaluate(`(() => {
  const button = document.querySelector('[aria-label="运行状态"]');
  if (!button) return false;
  button.click();
  return true;
})()`);
if (!statusOpened) throw new Error('没有找到运行状态入口');
await waitFor(`document.body.innerText.includes('查看哪些数据正在更新、排队、失败或等待重试')`);
const performanceCategoryOpened = await evaluate(`(() => {
  const panel = document.querySelector('[aria-label="状态分类"]');
  const button = Array.from(panel?.querySelectorAll('button') || [])
    .find((item) => item.innerText.includes('软件速度'));
  if (!button) return false;
  button.click();
  return true;
})()`);
if (!performanceCategoryOpened) throw new Error('运行状态缺少“软件速度”分类');
await waitFor(`document.body.innerText.includes('页面热缓存')`);
const hotCacheState = await evaluate(`(() => {
  const cards = Array.from(document.querySelectorAll('.status-observation-card'));
  const card = cards.find((item) => item.innerText.includes('页面热缓存'));
  return card ? { text: card.innerText.trim() } : null;
})()`);
if (!hotCacheState || hotCacheState.text.includes('等待首次读取')) {
  throw new Error(`页面热缓存状态没有生效：${JSON.stringify(hotCacheState)}`);
}

const screenshot = await send('Page.captureScreenshot', {
  format: 'png',
  fromSurface: true,
  captureBeyondViewport: false,
});
const outputDirectory = path.resolve('test-results');
await mkdir(outputDirectory, { recursive: true });
const screenshotPath = path.join(outputDirectory, 'data-analysis-multishop-final.png');
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));

const durations = observations.map((item) => item.durationMs).sort((left, right) => left - right);
const percentile = (ratio) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * ratio) - 1)];
const report = {
  ok: true,
  rounds,
  optionCount: options.length,
  options,
  samples: observations.length,
  latencyMs: {
    min: durations[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    max: durations.at(-1),
  },
  observations,
  hotCacheState,
  screenshot: screenshotPath,
};

console.log(JSON.stringify(report, null, 2));
socket.close();
