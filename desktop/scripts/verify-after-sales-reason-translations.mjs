import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || 9223);
const endpoint = `http://127.0.0.1:${port}/json`;
const targets = await fetch(endpoint).then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('app://')) || targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error(`没有找到 Electron CDP 页面：${endpoint}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let requestId = 0;
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
};

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 请求超时：${method}`));
    }, 60_000);
    pending.set(id, { resolve, reject, timer });
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
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面执行失败');
  }
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 45_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待页面状态超时：${expression}`);
}

await waitFor(`document.body?.innerText?.includes('旺崽助手')`, 60_000);
await new Promise((resolve) => setTimeout(resolve, 2_000));
const loginVisible = await evaluate(`Boolean(Array.from(document.querySelectorAll('button'))
  .find((element) => element.innerText?.trim() === '登录'))`);
if (loginVisible) {
  await evaluate(`(() => {
    const login = Array.from(document.querySelectorAll('button'))
      .find((element) => element.innerText?.trim() === '登录');
    login?.click();
    return Boolean(login);
  })()`);
}
await waitFor(`Boolean(document.querySelector('.nav-item'))`, 60_000);
await new Promise((resolve) => setTimeout(resolve, 5_000));
await evaluate(`document.querySelector('[aria-label="关闭店铺管理弹窗"]')?.click()`);
let afterSalesNavReady = await evaluate(`Boolean(Array.from(document.querySelectorAll('.subnav-item'))
  .find((element) => element.innerText?.trim() === '售后订单'))`);
if (!afterSalesNavReady) {
  await evaluate(`(() => {
    const parent = Array.from(document.querySelectorAll('.nav-item'))
      .find((element) => element.innerText?.trim().startsWith('订单管理'));
    parent?.click();
    return Boolean(parent);
  })()`);
  afterSalesNavReady = await waitFor(`Boolean(Array.from(document.querySelectorAll('.subnav-item'))
    .find((element) => element.innerText?.trim() === '售后订单'))`);
}
if (!afterSalesNavReady) throw new Error('没有找到“售后订单”导航');
await evaluate(`(() => {
  const tab = Array.from(document.querySelectorAll('.workspace-tab-main'))
    .find((element) => element.innerText?.trim() === '售后订单');
  const nav = Array.from(document.querySelectorAll('.subnav-item'))
    .find((element) => element.innerText?.trim() === '售后订单');
  (tab || nav)?.click();
  return Boolean(tab || nav);
})()`);

await waitFor(`Boolean(document.querySelector('.after-sales-orders-table tbody tr'))`);
await waitFor(`(() => {
  const activeTab = Array.from(document.querySelectorAll('.workspace-tab'))
    .find((element) => element.classList.contains('active'));
  if (activeTab?.innerText?.trim() !== '售后订单') {
    const tab = Array.from(document.querySelectorAll('.workspace-tab-main'))
      .find((element) => element.innerText?.trim() === '售后订单');
    const nav = Array.from(document.querySelectorAll('.subnav-item'))
      .find((element) => element.innerText?.trim() === '售后订单');
    (tab || nav)?.click();
    return false;
  }
  const reasons = Array.from(document.querySelectorAll('.after-sales-orders-table tbody tr'))
    .map((row) => row.innerText.split('\\n').find((line) => line.startsWith('售后原因:')) || '')
    .filter(Boolean);
  return reasons.length > 0 && reasons.every((text) =>
    !/[\u0400-\u04FF]/u.test(text) &&
    !text.includes('翻译中') &&
    !text.includes('翻译暂不可用')
  );
})()`, 60_000);

const report = await evaluate(`(() => {
  const rows = Array.from(document.querySelectorAll('.after-sales-orders-table tbody tr'));
  const reasons = rows
    .map((row) => row.innerText.split('\\n').find((line) => line.startsWith('售后原因:')) || '')
    .filter(Boolean);
  const rawCyrillicCount = reasons.filter((text) => /[\u0400-\u04FF]/u.test(text)).length;
  const pendingCount = reasons.filter((text) => text.includes('翻译中')).length;
  const failedCount = reasons.filter((text) => text.includes('翻译暂不可用')).length;
  return {
    checkedAt: new Date().toISOString(),
    visibleRows: rows.length,
    reasons,
    rawCyrillicCount,
    pendingCount,
    failedCount,
    passed: reasons.length > 0 && rawCyrillicCount === 0 && pendingCount === 0 && failedCount === 0,
  };
})()`);

const outputDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
await mkdir(outputDirectory, { recursive: true });
const reportPath = path.join(outputDirectory, 'after-sales-reason-translations.json');
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
const screenshot = await send('Page.captureScreenshot', {
  format: 'png',
  fromSurface: true,
  captureBeyondViewport: false,
});
await writeFile(path.join(outputDirectory, 'after-sales-reason-translations.png'), Buffer.from(screenshot.data, 'base64'));
socket.close();

console.log(JSON.stringify({ ...report, reportPath }, null, 2));
if (!report.passed) process.exitCode = 1;
