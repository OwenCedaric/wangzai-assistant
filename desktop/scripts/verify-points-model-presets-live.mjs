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
const networkEvidence = [];
const consoleErrors = [];
let requestId = 0;

await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Network.responseReceived') {
    const response = message.params?.response;
    if (String(response?.url || '').includes('/api/model-presets')) {
      networkEvidence.push({ type: 'response', status: response.status, url: response.url });
    }
  }
  if (message.method === 'Network.loadingFailed') {
    networkEvidence.push({
      type: 'loading-failed',
      errorText: message.params?.errorText || '',
      canceled: message.params?.canceled === true,
    });
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    consoleErrors.push(
      (message.params.args || []).map((item) => item.value || item.description || '').filter(Boolean).join(' '),
    );
  }
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

async function waitFor(expression, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待页面状态超时：${expression}`);
}

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await waitFor(`document.body?.innerText?.includes('旺崽助手')`);
// The static app shell becomes visible before React finishes attaching submit
// handlers. Keep the real startup test from clicking an unhydrated button.
await waitFor(`Boolean(window.wangzaiDesktop?.license?.getRememberedLogin)`, 10_000);
await new Promise((resolve) => setTimeout(resolve, 1_000));

const loginVisible = await evaluate(`Boolean(Array.from(document.querySelectorAll('button'))
  .find((element) => element.innerText?.trim() === '登录' && element.offsetParent !== null))`);
if (loginVisible) {
  await evaluate(`(() => {
    const login = Array.from(document.querySelectorAll('button'))
      .find((element) => element.innerText?.trim() === '登录' && element.offsetParent !== null);
    login?.click();
    return Boolean(login);
  })()`);
}
await waitFor(`Boolean(document.querySelector('.nav-item')) ||
  Boolean(document.querySelector('.desktop-access-error'))`, 30_000);
if (!await evaluate(`Boolean(document.querySelector('.nav-item'))`)) {
  throw new Error(`真实登录失败：${await evaluate(`document.body?.innerText || ''`)}`);
}

const session = await evaluate(`window.wangzaiDesktop.license.getSession()`);
if (!session?.authenticated || !session?.authorized) {
  throw new Error(`桌面授权会话未就绪：${JSON.stringify(session)}`);
}

const runtime = await evaluate(`window.wangzaiDesktop.license.getRuntime()`);
const bridgeRead = await evaluate(`window.wangzaiDesktop.license.request({
  method: 'GET',
  path: '/api/model-presets?project_code=' + encodeURIComponent(${JSON.stringify(runtime.projectCode)})
})`);
if (!bridgeRead?.ok) throw new Error(`主进程真实读取失败：${JSON.stringify(bridgeRead)}`);

const updateGroups = (bridgeRead.data?.groups || []).map((group) => ({
  capability_kind: group.capability_kind,
  enabled_models: group.enabled_models,
  default_model: group.default_model,
}));
if (updateGroups.length !== 2) {
  throw new Error(`模型分组不是 text/image 两组：${JSON.stringify(updateGroups)}`);
}

const bridgeWrite = await evaluate(`window.wangzaiDesktop.license.request({
  method: 'PUT',
  path: '/api/model-presets',
  body: {
    project_code: ${JSON.stringify(runtime.projectCode)},
    groups: ${JSON.stringify(updateGroups)}
  }
})`);
if (!bridgeWrite?.ok) throw new Error(`主进程真实保存失败：${JSON.stringify(bridgeWrite)}`);

await evaluate(`document.querySelector('[aria-label="关闭店铺管理弹窗"]')?.click()`);
const openedPage = await evaluate(`(() => {
  const tab = Array.from(document.querySelectorAll('.workspace-tab-main'))
    .find((element) => element.innerText?.trim() === '积分套餐');
  const nav = Array.from(document.querySelectorAll('.nav-item'))
    .find((element) => element.innerText?.trim().startsWith('积分套餐'));
  (tab || nav)?.click();
  return Boolean(tab || nav);
})()`);
if (!openedPage) throw new Error('没有找到积分套餐入口');
await waitFor(`document.body?.innerText?.includes('选择积分套餐')`);

await evaluate(`(() => {
  const button = Array.from(document.querySelectorAll('button'))
    .find((element) => element.innerText?.trim().startsWith('模型预设'));
  button?.click();
  return Boolean(button);
})()`);
await waitFor(`document.body?.innerText?.includes('模型预设与生效 API')`);
await waitFor(`document.body?.innerText?.includes('文本模型') && document.body?.innerText?.includes('图片模型')`);

const dialogSnapshot = await evaluate(`(() => {
  const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
    .find((element) => element.innerText?.includes('模型预设与生效 API'));
  return {
    text: dialog?.innerText || '',
    checked: dialog?.querySelectorAll('input[type="checkbox"]:checked').length || 0,
    apiChips: Array.from(dialog?.querySelectorAll('.MuiChip-label') || [])
      .map((element) => element.innerText?.trim() || '')
      .filter((text) => text.includes('个 API')),
  };
})()`);
if (dialogSnapshot.text.includes('无法连接授权服务') || dialogSnapshot.text.includes('请求地址不在')) {
  throw new Error(`模型预设弹窗仍有错误：${dialogSnapshot.text}`);
}
if (!dialogSnapshot.checked || dialogSnapshot.apiChips.length < 2) {
  throw new Error(`模型预设弹窗数据不完整：${JSON.stringify(dialogSnapshot)}`);
}

const saveClicked = await evaluate(`(() => {
  const button = Array.from(document.querySelectorAll('button'))
    .find((element) => element.innerText?.trim() === '保存并立即生效' && element.offsetParent !== null);
  button?.click();
  return Boolean(button && !button.disabled);
})()`);
if (!saveClicked) throw new Error('保存并立即生效按钮不可用');
await waitFor(`!Array.from(document.querySelectorAll('[role="dialog"]'))
  .some((element) => element.innerText?.includes('模型预设与生效 API'))`);

await evaluate(`(() => {
  const button = Array.from(document.querySelectorAll('button'))
    .find((element) => element.innerText?.trim().startsWith('模型预设'));
  button?.click();
  return Boolean(button);
})()`);
await waitFor(`Array.from(document.querySelectorAll('[role="dialog"]'))
  .some((element) => element.innerText?.includes('模型预设与生效 API') && element.innerText?.includes('文本模型'))`);
await new Promise((resolve) => setTimeout(resolve, 800));

const persistedSnapshot = await evaluate(`(() => {
  const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
    .find((element) => element.innerText?.includes('模型预设与生效 API'));
  return {
    checked: dialog?.querySelectorAll('input[type="checkbox"]:checked').length || 0,
    defaults: Array.from(dialog?.querySelectorAll('button') || [])
      .map((element) => element.innerText?.trim() || '')
      .filter((text) => text === '当前默认模型').length,
  };
})()`);
if (persistedSnapshot.checked !== dialogSnapshot.checked || persistedSnapshot.defaults !== 2) {
  throw new Error(`保存回读不一致：${JSON.stringify({ dialogSnapshot, persistedSnapshot })}`);
}

const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const outputDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
await mkdir(outputDir, { recursive: true });
const screenshotPath = path.join(outputDir, 'points-model-presets-live.png');
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));

const report = {
  verifiedAt: new Date().toISOString(),
  account: session.user?.email || session.user?.username || String(session.user?.id || ''),
  projectCode: runtime.projectCode,
  bridgeRead: {
    status: bridgeRead.status,
    groups: bridgeRead.data.groups.map((group) => ({
      capabilityKind: group.capability_kind,
      enabledModels: group.enabled_models,
      defaultModel: group.default_model,
      modelCount: group.models.length,
    })),
  },
  bridgeWrite: { status: bridgeWrite.status },
  dialog: dialogSnapshot,
  persisted: persistedSnapshot,
  networkEvidence,
  consoleErrors,
  screenshotPath,
};
const reportPath = path.join(outputDir, 'points-model-presets-live-report.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
socket.close();
console.log(JSON.stringify(report, null, 2));
