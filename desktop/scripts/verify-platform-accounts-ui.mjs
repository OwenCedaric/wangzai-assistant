const port = Number(process.argv[2] || 9223);
const rounds = Math.max(1, Number(process.argv[3] || 5));
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

async function waitFor(expression, timeoutMs = 15000, intervalMs = 80) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return Date.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待页面状态超时：${expression}`);
}

async function closeSettings() {
  await evaluate(`(() => {
    const button = document.querySelector('[aria-label="关闭店铺管理弹窗"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await waitFor(`!document.querySelector('.shop-settings-backdrop[data-settings-open="true"]')`, 10000);
}

async function openPlatformSettings() {
  const startedAt = Date.now();
  await evaluate(`(() => {
    window.dispatchEvent(new CustomEvent('wangzai-settings-open', { detail: { moduleId: 'platformApi' } }));
    return true;
  })()`);
  await waitFor(`Boolean(document.querySelector('.shop-settings-backdrop[data-settings-open="true"] .platform-api-layout'))`, 15000);
  await waitFor(`(() => {
    const layout = document.querySelector('.shop-settings-backdrop[data-settings-open="true"] .platform-api-layout');
    const cards = layout?.querySelectorAll('.shop-list-item') || [];
    return cards.length > 0 && !layout.innerText.includes('正在准备设置内容');
  })()`, 15000);
  return Date.now() - startedAt;
}

async function readPlatformAccounts() {
  return evaluate(`(() => {
    const layout = document.querySelector('.shop-settings-backdrop[data-settings-open="true"] .platform-api-layout');
    const cards = Array.from(layout?.querySelectorAll('.shop-list-item') || []).map((card) => ({
      title: card.querySelector('h6')?.innerText.trim() || '',
      status: card.querySelector('.MuiChip-label')?.innerText.trim() || '',
    })).filter((card) => card.title);
    return {
      countLabel: layout?.querySelector('.shop-list-card p')?.innerText.trim() || '',
      cards,
      statusText: Array.from(layout?.querySelectorAll('p') || [])
        .map((node) => node.innerText.trim())
        .find((text) => text.includes('读取失败')) || '',
      hasErrorBoundary: document.body.innerText.includes('页面显示异常'),
    };
  })()`);
}

await send('Runtime.enable');
await closeSettings();

const observations = [];
let canonicalTitles = null;
for (let round = 1; round <= rounds; round += 1) {
  const durationMs = await openPlatformSettings();
  const state = await readPlatformAccounts();
  if (state.hasErrorBoundary || state.statusText) {
    throw new Error(`平台账号页面异常：${JSON.stringify({ round, durationMs, state })}`);
  }
  if (!state.cards.length) {
    throw new Error(`平台账号没有显示：${JSON.stringify({ round, durationMs, state })}`);
  }
  const titles = state.cards.map((card) => card.title).sort();
  canonicalTitles ||= titles;
  if (JSON.stringify(titles) !== JSON.stringify(canonicalTitles)) {
    throw new Error(`反复打开后账号列表不稳定：${JSON.stringify({ round, canonicalTitles, titles })}`);
  }
  observations.push({ round, durationMs, ...state });
  await closeSettings();
}

const durations = observations.map((item) => item.durationMs).sort((left, right) => left - right);
const report = {
  ok: true,
  rounds,
  accountCount: canonicalTitles.length,
  accountTitles: canonicalTitles,
  latencyMs: {
    min: durations[0],
    median: durations[Math.floor(durations.length / 2)],
    max: durations.at(-1),
  },
  observations,
};

console.log(JSON.stringify(report, null, 2));
socket.close();
