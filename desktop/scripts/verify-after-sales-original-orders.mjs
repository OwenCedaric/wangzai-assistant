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
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面执行失败');
  }
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error(`等待页面状态超时：${expression}`);
}

await send('Page.reload', { ignoreCache: true });
await waitFor(`document.body?.innerText?.includes('旺崽助手')`);
const loginVisible = await evaluate(`Boolean(Array.from(document.querySelectorAll('button'))
  .find((element) => element.innerText?.trim() === '登录'))`);
if (loginVisible) {
  await evaluate(`(() => {
    const login = Array.from(document.querySelectorAll('button')).find((element) => element.innerText?.trim() === '登录');
    login?.click();
    return Boolean(login);
  })()`);
}
await waitFor(`Boolean(document.querySelector('.nav-item'))`);
await new Promise((resolve) => setTimeout(resolve, 2_000));
await evaluate(`document.querySelector('[aria-label="关闭店铺管理弹窗"]')?.click()`);
await evaluate(`(() => {
  const parent = Array.from(document.querySelectorAll('.nav-item'))
    .find((element) => element.innerText?.trim().startsWith('订单管理'));
  if (!Array.from(document.querySelectorAll('.subnav-item')).some((element) => element.innerText?.trim() === '售后订单')) {
    parent?.click();
  }
  const tab = Array.from(document.querySelectorAll('.workspace-tab-main'))
    .find((element) => element.innerText?.trim() === '售后订单');
  const nav = Array.from(document.querySelectorAll('.subnav-item'))
    .find((element) => element.innerText?.trim() === '售后订单');
  (tab || nav)?.click();
  return Boolean(tab || nav);
})()`);
await waitFor(`Boolean(document.querySelector('.after-sales-orders-table tbody tr'))`);
await evaluate(`(() => {
  const firstPage = document.querySelector('.MuiPagination-root button[aria-label="Go to page 1"]');
  firstPage?.click();
  return true;
})()`);
await waitFor(`Boolean(document.querySelector('.MuiPagination-root button[aria-current="page"][aria-label="page 1"]'))`);

const expectedTotal = await evaluate(`(() => {
  const text = document.body?.innerText || '';
  return Number(text.match(/共 +([0-9]+) +条/u)?.[1] || 0);
})()`);
const rows = [];
let sample = null;
let sampleWorkbench = null;
let sampleScreenshot = null;

while (true) {
  const page = await evaluate(`Number(document.querySelector('.MuiPagination-root button[aria-current="page"]')?.innerText || 1)`);
  const visibleRowCount = await evaluate(`document.querySelectorAll('.after-sales-orders-table tbody tr').length`);
  for (let index = 0; index < visibleRowCount; index += 1) {
    const selected = await evaluate(`(() => {
      const row = document.querySelectorAll('.after-sales-orders-table tbody tr')[${index}];
      row?.click();
      return {
        posting: row?.innerText.match(/[0-9]{8,10}-[0-9]{4}-[0-9]/u)?.[0] || '',
        rowText: row?.innerText || '',
      };
    })()`);
    if (selected.posting) {
      await waitFor(`document.querySelector('.after-sales-detail-card')?.innerText.includes(${JSON.stringify(selected.posting)})`, 5_000);
    }
    const buttonState = await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((element) => element.innerText?.trim() === '查看原单' && element.offsetParent !== null);
      return {
        hasButton: Boolean(button),
        disabled: Boolean(button?.disabled || button?.getAttribute('aria-disabled') === 'true'),
      };
    })()`);
    rows.push({ page, index, posting: selected.posting, ...buttonState });

    if (!sample && selected.rowText.includes('售后单: 未返回')) {
      sample = { page, index, posting: selected.posting, rowText: selected.rowText };
      sample.clicked = await evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('button'))
          .find((element) => element.innerText?.trim() === '查看原单' && element.offsetParent !== null);
        button?.click();
        return Boolean(button);
      })()`);
      await waitFor(`Boolean(document.querySelector('.purchase-order-workbench-dialog'))`);
      sampleWorkbench = await evaluate(`(() => {
        const root = document.querySelector('.purchase-order-workbench-dialog');
        const text = root?.innerText || '';
        const url = root?.querySelector('.purchase-order-workbench-address')?.innerText?.trim() || '';
        return {
          visible: Boolean(root),
          hasTitle: text.includes('售后订单操作台'),
          hasPosting: text.includes(${JSON.stringify(selected.posting)}),
          hasFallbackOrderArea: url.includes('/app/postings/fbs'),
          url,
          text,
        };
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      sampleScreenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      await evaluate(`document.querySelector('[aria-label="关闭订单操作台"]')?.click()`);
      await waitFor(`!document.querySelector('.purchase-order-workbench-dialog')`, 30_000);
    }
  }

  const nextState = await evaluate(`(() => {
    const next = document.querySelector('.MuiPagination-root button[aria-label="Go to next page"]');
    return { exists: Boolean(next), disabled: Boolean(next?.disabled), page: Number(document.querySelector('.MuiPagination-root button[aria-current="page"]')?.innerText || 1) };
  })()`);
  if (!nextState.exists || nextState.disabled) break;
  await evaluate(`document.querySelector('.MuiPagination-root button[aria-label="Go to next page"]')?.click()`);
  await waitFor(`Number(document.querySelector('.MuiPagination-root button[aria-current="page"]')?.innerText || 0) === ${nextState.page + 1}`);
}

if (!sample) {
  throw new Error('未找到售后单号缺失的真实记录，无法验证历史售后记录的原单查看能力');
}
const workbench = sampleWorkbench || {
  visible: false,
  hasTitle: false,
  hasPosting: false,
  hasFallbackOrderArea: false,
  url: '',
};

const report = {
  checkedAt: new Date().toISOString(),
  expectedTotal,
  checkedRows: rows.length,
  enabledRows: rows.filter((row) => row.hasButton && !row.disabled).length,
  missingPostingRows: rows.filter((row) => !row.posting),
  missingButtons: rows.filter((row) => !row.hasButton),
  disabledButtons: rows.filter((row) => row.disabled),
  sample,
  workbench: {
    visible: workbench.visible,
    hasTitle: workbench.hasTitle,
    hasPosting: workbench.hasPosting,
    hasFallbackOrderArea: workbench.hasFallbackOrderArea,
    url: workbench.url,
  },
};
report.passed = report.expectedTotal > 0
  && report.checkedRows === report.expectedTotal
  && report.enabledRows === report.checkedRows
  && report.missingPostingRows.length === 0
  && report.missingButtons.length === 0
  && report.disabledButtons.length === 0
  && workbench.visible
  && workbench.hasTitle
  && workbench.hasPosting
  && workbench.hasFallbackOrderArea;

const outputDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
await mkdir(outputDirectory, { recursive: true });
const reportPath = path.join(outputDirectory, 'after-sales-original-orders.json');
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
if (sampleScreenshot?.data) {
  await writeFile(path.join(outputDirectory, 'after-sales-original-orders.png'), Buffer.from(sampleScreenshot.data, 'base64'));
}
socket.close();

console.log(JSON.stringify({ ...report, reportPath }, null, 2));
if (!report.passed) process.exitCode = 1;
