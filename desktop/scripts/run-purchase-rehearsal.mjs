const argumentsMap = new Map(process.argv.slice(2).map((value) => {
  const [key, ...rest] = String(value).replace(/^--/u, '').split('=');
  return [key, rest.join('=') || 'true'];
}));

const platform = String(argumentsMap.get('platform') || 'all').trim().toLowerCase();
const port = Math.max(1, Math.min(65_535, Number(argumentsMap.get('port')) || 9333));
const runs = Math.max(10, Math.min(50, Math.trunc(Number(argumentsMap.get('runs')) || 10)));

async function debugTarget() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error('PURCHASE_REHEARSAL_DESKTOP_DEBUG_UNAVAILABLE');
  const targets = await response.json();
  const target = targets.find((candidate) => candidate.type === 'page' && candidate.url === 'app://wangzai/index.html')
    || targets.find((candidate) => candidate.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('PURCHASE_REHEARSAL_DESKTOP_PAGE_MISSING');
  return target;
}

async function evaluate(expression) {
  const target = await debugTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const id = 1;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PURCHASE_REHEARSAL_CDP_TIMEOUT')), 1_210_000);
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data || '')); } catch { return; }
      if (message.id !== id) return;
      clearTimeout(timer);
      if (message.result?.exceptionDetails) {
        const description = message.result.exceptionDetails.exception?.description
          || message.result.exceptionDetails.text
          || 'PURCHASE_REHEARSAL_CDP_EVALUATION_FAILED';
        reject(new Error(description));
        return;
      }
      resolve(message.result?.result?.value);
    });
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  }).finally(() => socket.close());
  return result;
}

function command(input) {
  const payload = JSON.stringify(input);
  return evaluate(`window.wangzaiDesktop.purchaseBrowser.command(${payload})`);
}

function summary(report) {
  return {
    platformId: report.platformId,
    platformLabel: report.platformLabel,
    passed: report.passed === true,
    passedRuns: Number(report.passedRuns) || 0,
    requiredRuns: Number(report.requiredRuns) || runs,
    failedRuns: Number(report.failedRuns) || 0,
    stopStage: report.stopStage,
    reportId: report.reportId,
    reportPath: report.reportPath,
  };
}

async function main() {
  if (platform === 'state') {
    console.log(JSON.stringify(await command({ command: 'state' }), null, 2));
    return;
  }
  if (platform === 'inspect-pinduoduo') {
    const state = await command({ command: 'state' });
    const tab = state.tabs.find((candidate) => String(candidate.url || candidate.requestedUrl).includes('yangkeduo.com'));
    if (!tab) throw new Error('PURCHASE_REHEARSAL_PINDUODUO_TAB_MISSING');
    console.log(JSON.stringify(await command({ command: 'inspect', tabId: tab.tabId }), null, 2));
    return;
  }
  const inventory = await command({ command: 'purchase-rehearsal-inventory' });
  if (platform === 'inventory') {
    console.log(JSON.stringify(inventory, null, 2));
    return;
  }
  const selected = platform === 'all'
    ? inventory.platforms.filter((candidate) => candidate.ready === true).map((candidate) => candidate.id)
    : [platform];
  if (!selected.length) throw new Error('PURCHASE_REHEARSAL_NO_READY_PLATFORM');
  const reports = [];
  for (const platformId of selected) {
    const report = await command({ command: 'purchase-rehearsal-batch', platform: platformId, runs });
    reports.push(summary(report));
  }
  console.log(JSON.stringify({ ok: reports.every((report) => report.passed), reports }, null, 2));
  if (reports.some((report) => !report.passed)) process.exitCode = 2;
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exitCode = 1;
});
