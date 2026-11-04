import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(desktopRoot, '..');
const testResultsRoot = path.join(desktopRoot, 'test-results');
const runRoot = path.join(testResultsRoot, `settings-layout-${Date.now()}`);
const reportPath = path.join(testResultsRoot, 'settings-layout-stability-report.json');
const screenshotPath = path.join(testResultsRoot, 'settings-layout-stability-final.png');
const rounds = Math.max(1, Number(process.argv[2] || 10));
const electronExecutable = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!runRoot.startsWith(`${testResultsRoot}${path.sep}`)) {
  throw new Error(`测试目录越界：${runRoot}`);
}

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

async function waitForPageTarget(port, child, timeoutMs = 45_000) {
  const url = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`Electron 提前退出：${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((item) => (
          item.type === 'page'
          && String(item.url || '').startsWith('app://')
          && item.webSocketDebuggerUrl
        ));
        if (target) return target;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待 Electron CDP 超时：${lastError || url}`);
}

async function connectCdp(port, child) {
  const target = await waitForPageTarget(port, child);
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 请求超时：${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  };
  const waitFor = async (expression, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(`等待页面状态超时：${expression}`);
  };
  return { socket, send, evaluate, waitFor };
}

function stopProcessTree(child) {
  if (!child?.pid) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 15_000);
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const finish = () => {
      clearTimeout(timeout);
      resolve();
    };
    killer.once('exit', finish);
    killer.once('error', finish);
  });
}

await mkdir(runRoot, { recursive: true });
const [cdpPort, localApiPort, bridgePort] = await Promise.all([reservePort(), reservePort(), reservePort()]);
const child = spawn(electronExecutable, [
  '--disable-background-networking',
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${cdpPort}`,
  '.',
  '--dashboard-visual-test',
  '--settings-layout-stability-ui-test',
], {
  cwd: desktopRoot,
  env: {
    ...process.env,
    WANGZAI_DESKTOP_DATA_DIR: runRoot,
    WANGZAI_LICENSE_MODE: 'off',
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
try {
  console.error(`[settings-layout] Electron PID=${child.pid}, CDP=${cdpPort}`);
  cdp = await connectCdp(cdpPort, child);
  console.error('[settings-layout] CDP connected');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.waitFor(`document.readyState === 'complete' && Boolean(document.querySelector('.app-root'))`, 30_000);
  await cdp.evaluate(`window.dispatchEvent(new CustomEvent('wangzai-settings-open', { detail: { moduleId: 'ozon' } }))`);
  await cdp.waitFor(`document.querySelector('.shop-settings-backdrop')?.dataset.settingsOpen === 'true'`);
  await cdp.waitFor(`document.querySelector('.shop-settings-dialog-paper')?.dataset.settingsRenderReady === 'true'`);
  console.error('[settings-layout] settings dialog ready');

  const renewalObservations = [];
  for (let round = 1; round <= 5; round += 1) {
    const before = await cdp.evaluate(`(() => {
      const paper = document.querySelector('.shop-settings-dialog-paper').getBoundingClientRect();
      const button = Array.from(document.querySelectorAll('.shop-settings-main-header button'))
        .find((node) => node.innerText.trim() === '续费卡密');
      if (!button) throw new Error('Ozon 店铺资料卡没有续费卡密按钮');
      if (document.body.innerText.includes('当前店铺续费卡密（仅到期时填写）')) {
        throw new Error('旧的顶部续费卡密输入框仍然存在');
      }
      button.click();
      return { width: paper.width, height: paper.height, left: paper.left, top: paper.top };
    })()`);
    await cdp.waitFor(`Boolean(document.querySelector('.shop-license-renewal-panel input[aria-label="续费卡密"]'))`);
    if (round === 1) {
      await cdp.evaluate(`(() => {
        const panel = document.querySelector('.shop-license-renewal-panel');
        const submit = Array.from(panel.querySelectorAll('button'))
          .find((node) => node.innerText.trim() === '验证并续费');
        submit.click();
      })()`);
      await cdp.waitFor(`document.querySelector('.shop-license-renewal-panel')?.innerText.includes('请输入管理系统发放的 16 位月卡或年卡卡密。')`);
    }
    const opened = await cdp.evaluate(`(() => {
      const panel = document.querySelector('.shop-license-renewal-panel');
      const rect = panel.getBoundingClientRect();
      const paper = document.querySelector('.shop-settings-dialog-paper').getBoundingClientRect();
      const text = panel.innerText;
      return {
        panelRect: { width: rect.width, height: rect.height, left: rect.left, top: rect.top },
        paperRect: { width: paper.width, height: paper.height, left: paper.left, top: paper.top },
        hasShopSummary: text.includes('当前店铺') && text.includes('Ozon Client ID'),
        hasExpiration: text.includes('当前到期时间'),
        withinViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      };
    })()`);
    await cdp.evaluate(`(() => {
      const panel = document.querySelector('.shop-license-renewal-panel');
      const cancel = Array.from(panel.querySelectorAll('button'))
        .find((node) => node.innerText.trim() === '取消');
      cancel.click();
    })()`);
    await cdp.waitFor(`!document.querySelector('.shop-license-renewal-panel')`);
    renewalObservations.push({ round, before, ...opened });
  }
  const renewalFailures = renewalObservations.filter((item) => (
    !item.hasShopSummary
    || !item.hasExpiration
    || !item.withinViewport
    || Math.abs(item.paperRect.width - item.before.width) > 0.5
    || Math.abs(item.paperRect.height - item.before.height) > 0.5
    || Math.abs(item.paperRect.left - item.before.left) > 0.5
    || Math.abs(item.paperRect.top - item.before.top) > 0.5
  ));
  if (renewalFailures.length) {
    throw new Error(`续费卡密弹窗实机验收失败：${JSON.stringify(renewalFailures)}`);
  }

  const tabLabels = ['跨境巴士', '拍单账号', '模型接口', '外部接口', 'Ozon 店铺', '费用设定'];
  const observations = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const label of tabLabels) {
      const observation = await cdp.evaluate(`(async () => {
        const label = ${JSON.stringify(label)};
        const tab = Array.from(document.querySelectorAll('[role="tab"]'))
          .find((node) => node.innerText.includes(label));
        if (!tab) throw new Error('找不到设置标签：' + label);
        const content = document.querySelector('.shop-settings-content');
        content.scrollTop = 240;
        tab.click();
        const samples = [];
        for (let index = 0; index < 2; index += 1) {
          if (index > 0) await new Promise((resolve) => requestAnimationFrame(resolve));
          const paper = document.querySelector('.shop-settings-dialog-paper').getBoundingClientRect();
          samples.push({ width: paper.width, height: paper.height, left: paper.left, top: paper.top });
        }
        return {
          label,
          samples,
          scrollTop: content.scrollTop,
          explanationCardCount: document.querySelectorAll('.shop-settings-content .api-check-card').length,
          activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.innerText || '',
        };
      })()`);
      observations.push({ round, ...observation });
    }
    console.error(`[settings-layout] round ${round}/${rounds} complete`);
  }

  const first = observations[0].samples[0];
  const deltas = observations.flatMap((item) => item.samples.map((sample) => ({
    width: Math.abs(sample.width - first.width),
    height: Math.abs(sample.height - first.height),
    left: Math.abs(sample.left - first.left),
    top: Math.abs(sample.top - first.top),
  })));
  const maximumDelta = deltas.reduce((current, delta) => ({
    width: Math.max(current.width, delta.width),
    height: Math.max(current.height, delta.height),
    left: Math.max(current.left, delta.left),
    top: Math.max(current.top, delta.top),
  }), { width: 0, height: 0, left: 0, top: 0 });
  const failures = observations.filter((item) => (
    (item.label !== '费用设定' && item.explanationCardCount !== 0)
    || item.scrollTop !== 0
    || !item.activeTab.includes(item.label)
  ));
  if (failures.length || Object.values(maximumDelta).some((value) => value > 0.5)) {
    throw new Error(`设置页切换不稳定：${JSON.stringify({ failures, maximumDelta })}`);
  }

  await cdp.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]'))
      .find((node) => node.innerText.includes('费用设定'));
    tab?.click();
    return Boolean(tab);
  })()`);
  await cdp.waitFor(`document.querySelectorAll('.logistics-pricing-fields > .structured-field').length === 4`, 15_000);
  const feeLayout = await cdp.evaluate(`(async () => {
    const fields = Array.from(document.querySelectorAll('.logistics-pricing-fields > .structured-field'));
    const content = document.querySelector('.shop-settings-content');
    const section = document.querySelector('.logistics-pricing-fields')?.closest('.structured-form-section');
    if (content && section) {
      const nextTop = content.scrollTop
        + section.getBoundingClientRect().top
        - content.getBoundingClientRect().top
        - 20;
      content.scrollTop = Math.max(0, nextTop);
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const fieldTops = fields.map((field) => Math.round(field.getBoundingClientRect().top));
    const fieldsRect = document.querySelector('.logistics-pricing-fields')?.getBoundingClientRect();
    const rightMostField = fields.length
      ? Math.max(...fields.map((field) => field.getBoundingClientRect().right))
      : 0;
    return {
      activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.innerText || '',
      fieldCount: fields.length,
      fieldRowCount: new Set(fieldTops).size,
      fieldOverflow: fieldsRect ? Math.max(0, rightMostField - fieldsRect.right) : null,
      scopedActionCount: document.querySelectorAll('.logistics-pricing-actions button').length,
      globalActionCount: document.querySelectorAll('.fee-settings-global-actions button').length,
    };
  })()`);
  if (
    !feeLayout.activeTab.includes('费用设定')
    || feeLayout.fieldCount !== 4
    || feeLayout.fieldRowCount !== 2
    || feeLayout.fieldOverflow > 1
    || feeLayout.scopedActionCount !== 2
    || feeLayout.globalActionCount !== 2
  ) throw new Error(`费用设定排版验收失败：${JSON.stringify(feeLayout)}`);

  await cdp.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]'))
      .find((node) => node.innerText.includes('微信助理'));
    tab?.click();
    return Boolean(tab);
  })()`);
  await cdp.waitFor(`Boolean(document.querySelector('[data-testid="wechat-assistant-settings-panel"]'))`, 15_000);
  const wechatAssistantLayout = await cdp.evaluate(`(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const content = document.querySelector('.shop-settings-content');
    const panel = document.querySelector('[data-testid="wechat-assistant-settings-panel"]');
    const paper = document.querySelector('.shop-settings-dialog-paper');
    const sourceLabel = Array.from(panel.querySelectorAll('label')).find((node) => node.innerText.trim() === '模型来源');
    const source = sourceLabel?.parentElement?.querySelector('[role="combobox"]');
    const sourceValue = () => source?.parentElement?.querySelector('input.MuiSelect-nativeInput')?.value || '';
    const initialSource = sourceValue();
    let sourceOptionCount = 0;
    if (source) {
      source.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      let options = Array.from(document.querySelectorAll('[role="option"]'));
      sourceOptionCount = options.length;
      options.find((option) => option.getAttribute('data-value') === 'saved-api')?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      source.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      options = Array.from(document.querySelectorAll('[role="option"]'));
      options.find((option) => option.getAttribute('data-value') === 'builtin-points')?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const contentRect = content.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const paperRect = paper.getBoundingClientRect();
    return {
      activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.innerText || '',
      initialSource,
      restoredSource: sourceValue(),
      sourceOptionCount,
      contentScrollTop: content.scrollTop,
      contentScrollHeight: content.scrollHeight,
      contentClientHeight: content.clientHeight,
      panelScrollHeight: panel.scrollHeight,
      panelClientHeight: panel.clientHeight,
      withinViewport: paperRect.left >= 0 && paperRect.top >= 0 && paperRect.right <= innerWidth && paperRect.bottom <= innerHeight,
      panelWithinContent: panelRect.top >= contentRect.top - 1 && panelRect.bottom <= contentRect.bottom + 1,
      rawApiFieldCount: Array.from(panel.querySelectorAll('label')).filter((node) => ['API 地址', 'API Key'].includes(node.innerText.trim())).length,
      primaryActionCount: Array.from(panel.querySelectorAll('button')).filter((node) => node.innerText.includes('启用内置版') || node.innerText.includes('重启内置版')).length,
      billingCopyVisible: panel.innerText.includes('按模型实际用量预留并结算积分'),
    };
  })()`);
  if (
    !wechatAssistantLayout.activeTab.includes('微信助理')
    || wechatAssistantLayout.initialSource !== 'builtin-points'
    || wechatAssistantLayout.restoredSource !== 'builtin-points'
    || wechatAssistantLayout.sourceOptionCount !== 2
    || wechatAssistantLayout.contentScrollTop !== 0
    || wechatAssistantLayout.contentScrollHeight > wechatAssistantLayout.contentClientHeight + 1
    || wechatAssistantLayout.panelScrollHeight > wechatAssistantLayout.panelClientHeight + 1
    || !wechatAssistantLayout.withinViewport
    || !wechatAssistantLayout.panelWithinContent
    || wechatAssistantLayout.rawApiFieldCount !== 0
    || wechatAssistantLayout.primaryActionCount !== 1
    || !wechatAssistantLayout.billingCopyVisible
  ) throw new Error(`微信助理一屏排版验收失败：${JSON.stringify(wechatAssistantLayout)}`);

  const capture = await cdp.evaluate(`window.wangzaiDesktop.captureDashboardVisual({ rect: null })`);
  if (!capture?.ok || !capture.pngBase64) throw new Error('隐藏 Electron capturePage 没有返回 PNG');
  await writeFile(screenshotPath, Buffer.from(capture.pngBase64, 'base64'));
  const report = {
    ok: true,
    rounds,
    tabCount: tabLabels.length,
    switchCount: observations.length,
    animationFrameSamples: observations.reduce((sum, item) => sum + item.samples.length, 0),
    baselineRect: first,
    maximumDelta,
    removedExplanationCards: true,
    scrollResetPassed: true,
    feeLayout,
    wechatAssistantLayout,
    renewalUi: {
      openCloseRounds: renewalObservations.length,
      oldTopInputRemoved: true,
      exactShopSummary: true,
      expirationVisible: true,
      parentDialogStable: true,
      panelsWithinViewport: true,
    },
    screenshotPath,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  throw new Error(`${error.message}\nElectron stdout:\n${stdout}\nElectron stderr:\n${stderr}`);
} finally {
  cdp?.socket?.close();
  await stopProcessTree(child);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
}
