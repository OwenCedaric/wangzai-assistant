import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MARKET_STATUS_LINE_PATTERN = /^最近获取\s+(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+·\s+刷新完成\s+(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+·\s+(.+))?$/u;

function normalizedTimestamp(parts) {
  const [year, month, day, hour, minute, second] = parts.map((value) => Number(value));
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const pad = (value) => String(value).padStart(2, '0');
  return {
    display: String(year) + '/' + month + '/' + day + ' ' + pad(hour) + ':' + pad(minute) + ':' + pad(second),
    sortKey: String(year) + pad(month) + pad(day) + pad(hour) + pad(minute) + pad(second),
  };
}

function classifyRefreshOutcome(feedback) {
  const value = String(feedback || '').trim();
  if (/^部分分类未更新，已保留原数据$/u.test(value)) return 'partial';
  if (/^(?:已获取新数据|刷新完成|刷新完成，Ozon 未返回新数据|刷新完成，暂未返回可用数据|实时刷新完成)$/u.test(value)) return 'success';
  return 'unknown';
}

function parseMarketStatusLine(line) {
  const normalizedLine = String(line || '').trim().replace(/\s+/gu, ' ');
  const match = normalizedLine.match(MARKET_STATUS_LINE_PATTERN);
  if (!match) return null;
  const lastCapture = normalizedTimestamp(match.slice(1, 7));
  const lastCompleted = normalizedTimestamp(match.slice(7, 13));
  if (!lastCapture || !lastCompleted) return null;
  const feedback = String(match[13] || '').trim();
  return {
    statusLine: normalizedLine,
    lastCaptureAt: lastCapture.display,
    lastCaptureSortKey: lastCapture.sortKey,
    lastCompletedAt: lastCompleted.display,
    lastCompletedSortKey: lastCompleted.sortKey,
    feedback,
    outcomeClass: classifyRefreshOutcome(feedback),
  };
}

function marketTimesAdvanced(before, after) {
  return {
    captureTimeAdvanced: Boolean(before?.lastCaptureSortKey)
      && Boolean(after?.lastCaptureSortKey)
      && after.lastCaptureSortKey > before.lastCaptureSortKey,
    completionTimeAdvanced: Boolean(before?.lastCompletedSortKey)
      && Boolean(after?.lastCompletedSortKey)
      && after.lastCompletedSortKey > before.lastCompletedSortKey,
  };
}

function selectWangzaiAppTarget(targets = []) {
  return targets.find((item) => (
    item?.type === 'page'
    && typeof item.webSocketDebuggerUrl === 'string'
    && item.webSocketDebuggerUrl.length > 0
    && typeof item.url === 'string'
    && item.url.startsWith('app://wangzai/')
  )) || null;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function marketDatasetEvidence(marketData = {}) {
  const datasetViews = Array.isArray(marketData?.datasetViews) ? marketData.datasetViews : [];
  const datasets = datasetViews.map((dataset) => {
    const id = String(dataset?.id || dataset?.datasetId || '').trim();
    const records = Array.isArray(dataset?.records) ? dataset.records : [];
    return {
      id,
      recordCount: records.length,
      declaredRecordCount: Number(dataset?.recordCount) || 0,
    };
  });
  return {
    datasetCount: datasets.length,
    actualRowCount: datasets.reduce((total, dataset) => total + dataset.recordCount, 0),
    datasets,
  };
}

function isoTimeAdvanced(before, after) {
  const beforeMs = Date.parse(String(before || ''));
  const afterMs = Date.parse(String(after || ''));
  return Number.isFinite(afterMs) && (!Number.isFinite(beforeMs) || afterMs > beforeMs);
}

function isoTimeAtOrAfter(value, floor) {
  const valueMs = Date.parse(String(value || ''));
  const floorMs = Date.parse(String(floor || ''));
  return Number.isFinite(valueMs) && Number.isFinite(floorMs) && valueMs >= floorMs;
}

function runStaticSelfTest() {
  const success = parseMarketStatusLine('最近获取 2026/8/6 17:20:01 · 刷新完成 2026/8/6 17:20:03 · 已获取新数据');
  const partial = parseMarketStatusLine('最近获取 2026/08/06 17:21:01 · 刷新完成 2026/08/06 17:21:03 · 部分分类未更新，已保留原数据');
  assert.equal(success?.lastCaptureSortKey, '20260806172001');
  assert.equal(success?.lastCompletedSortKey, '20260806172003');
  assert.equal(success?.outcomeClass, 'success');
  assert.equal(partial?.outcomeClass, 'partial');
  assert.deepEqual(marketTimesAdvanced(success, partial), {
    captureTimeAdvanced: true,
    completionTimeAdvanced: true,
  });
  assert.deepEqual(marketTimesAdvanced(success, success), {
    captureTimeAdvanced: false,
    completionTimeAdvanced: false,
  });
  assert.equal(parseMarketStatusLine('数据更新于 2026/08/06 17:20'), null);
  assert.equal(parseMarketStatusLine('最近获取 2026/8/6 17:20:01'), null);
  assert.equal(selectWangzaiAppTarget([
    { type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://devtools' },
    { type: 'page', url: 'app://wangzai/index.html', webSocketDebuggerUrl: 'ws://wangzai' },
  ])?.webSocketDebuggerUrl, 'ws://wangzai');
  assert.equal(selectWangzaiAppTarget([
    { type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://browser' },
  ]), null);
  assert.deepEqual(marketDatasetEvidence({
    datasetViews: [
      { id: 'keywords', recordCount: 2, records: [{ id: 1 }, { id: 2 }] },
      { id: 'products', recordCount: 1, records: [{ id: 3 }] },
    ],
  }), {
    datasetCount: 2,
    actualRowCount: 3,
    datasets: [
      { id: 'keywords', recordCount: 2, declaredRecordCount: 2 },
      { id: 'products', recordCount: 1, declaredRecordCount: 1 },
    ],
  });
  assert.equal(isoTimeAdvanced('2026-08-06T12:00:00.000Z', '2026-08-06T12:00:01.000Z'), true);
  assert.equal(isoTimeAdvanced('2026-08-06T12:00:01.000Z', '2026-08-06T12:00:01.000Z'), false);
  console.log(JSON.stringify({ ok: true, selfTest: 'market-status-parser' }));
}

if (process.argv[2] === '--self-test') {
  runStaticSelfTest();
  process.exit(0);
}

const port = Number(process.argv[2] || 9223);
const rounds = Math.max(1, Number(process.argv[3] || 3));
const refreshTimeoutMs = Math.max(30_000, Number(process.argv[4] || 240_000));
const configuredDatabasePath = String(process.argv[5] || process.env.LOCAL_API_DB_PATH || '').trim();
const endpoint = `http://127.0.0.1:${port}/json`;
const targets = await fetch(endpoint).then((response) => response.json());
const target = selectWangzaiAppTarget(targets);
if (!target?.webSocketDebuggerUrl) {
  const targetSummary = targets.map((item) => ({ type: item.type, title: item.title, url: item.url }));
  throw new Error(`没有找到旺崽助手 Electron CDP 页面：${endpoint}；targets=${JSON.stringify(targetSummary)}`);
}

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

function send(method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 请求超时：${method}`));
    }, timeoutMs);
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

function readPersistedMarketSnapshot(databasePath, shopId) {
  if (!existsSync(databasePath)) {
    throw new Error(`SQLite 数据库不存在：${databasePath}`);
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT
        shop_id,
        analysis_type,
        source_type,
        source_key,
        row_count,
        remote_hash,
        source_status,
        source_synced_at,
        last_seen_at,
        created_at,
        updated_at,
        payload_json
      FROM data_analysis_snapshots
      WHERE shop_id = ?
        AND analysis_type = 'ozon-browser-market'
        AND source_type = 'ozon-browser-capture'
      ORDER BY updated_at DESC, id ASC
      LIMIT 1
    `).get(shopId);
    if (!row) return null;
    const payload = parseJsonObject(row.payload_json);
    const marketData = payload.marketData && typeof payload.marketData === 'object'
      ? payload.marketData
      : {};
    const datasetEvidence = marketDatasetEvidence(marketData);
    const legacyGlobalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM data_analysis_snapshots
      WHERE shop_id = ''
        AND analysis_type = 'ozon-browser-market'
        AND source_type = 'ozon-browser-capture'
        AND source_key = ?
    `).get(row.source_key);
    return {
      shopId: row.shop_id,
      analysisType: row.analysis_type,
      sourceType: row.source_type,
      sourceKey: row.source_key,
      rowCount: Number(row.row_count) || 0,
      remoteHash: row.remote_hash || '',
      sourceStatus: row.source_status || '',
      sourceSyncedAt: row.source_synced_at || '',
      lastSeenAt: row.last_seen_at || '',
      createdAt: row.created_at || '',
      updatedAt: row.updated_at || '',
      payloadShopId: String(marketData.shopId || ''),
      payloadProfileId: String(marketData.profileId || ''),
      payloadLastCaptureAt: String(marketData.lastCaptureAt || ''),
      payloadLastCompletedAt: String(marketData.lastCompletedAt || ''),
      payloadRefreshOutcome: String(marketData.refreshOutcome || ''),
      legacyGlobalRowsForSource: Number(legacyGlobalRow?.total) || 0,
      ...datasetEvidence,
    };
  } finally {
    db.close();
  }
}

function readPersistedMarketSyncState(databasePath, shopId) {
  if (!existsSync(databasePath)) {
    throw new Error(`SQLite 数据库不存在：${databasePath}`);
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT
        cache_key,
        shop_id,
        analysis_type,
        status,
        last_success_at,
        last_attempt_at,
        last_error_json,
        updated_at
      FROM data_analysis_sync_state
      WHERE shop_id = ?
        AND analysis_type = 'ozon-browser-market'
      ORDER BY updated_at DESC, cache_key ASC
      LIMIT 1
    `).get(shopId);
    if (!row) return null;
    return {
      cacheKey: String(row.cache_key || ''),
      shopId: String(row.shop_id || ''),
      analysisType: String(row.analysis_type || ''),
      status: String(row.status || ''),
      lastSuccessAt: String(row.last_success_at || ''),
      lastAttemptAt: String(row.last_attempt_at || ''),
      lastError: parseJsonObject(row.last_error_json),
      updatedAt: String(row.updated_at || ''),
    };
  } finally {
    db.close();
  }
}

function persistedSnapshotProof(before, after, expectedShopId) {
  return {
    exactShopPersisted: Boolean(after) && after.shopId === expectedShopId && after.payloadShopId === expectedShopId,
    profileScopePersisted: Boolean(after?.sourceKey) && after.payloadProfileId === after.sourceKey,
    actualRowsMatchStoredCount: Boolean(after) && after.actualRowCount === after.rowCount,
    updatedAtAdvanced: Boolean(after) && isoTimeAdvanced(before?.updatedAt, after.updatedAt),
    captureTimeAdvanced: Boolean(after) && isoTimeAdvanced(before?.payloadLastCaptureAt, after.payloadLastCaptureAt),
    completionTimeAdvanced: Boolean(after) && isoTimeAdvanced(before?.payloadLastCompletedAt, after.payloadLastCompletedAt),
    noLegacyGlobalForSource: Boolean(after) && after.legacyGlobalRowsForSource === 0,
  };
}

function isCompletePersistenceProof(proof = {}) {
  return Object.values(proof).every(Boolean);
}

function persistedSyncStateProof(before, after, expectedShopId, startedAtIso) {
  const errorText = JSON.stringify(after?.lastError || {});
  return {
    exactShopTerminalState: Boolean(after)
      && after.shopId === expectedShopId
      && after.analysisType === 'ozon-browser-market'
      && ['success', 'partial'].includes(after.status),
    stateUpdatedAtAdvanced: Boolean(after) && isoTimeAdvanced(before?.updatedAt, after.updatedAt),
    attemptBelongsToCurrentRound: Boolean(after) && isoTimeAtOrAfter(after.lastAttemptAt, startedAtIso),
    noLocalApiTimeout: !/LOCAL_API_TIMEOUT|local-api 请求超时/u.test(errorText),
  };
}

async function waitForPersistedMarketSnapshot({ databasePath, shopId, before, timeoutMs = 15_000 }) {
  const startedAt = Date.now();
  let latest = null;
  let proof = persistedSnapshotProof(before, latest, shopId);
  while (Date.now() - startedAt < timeoutMs) {
    latest = readPersistedMarketSnapshot(databasePath, shopId);
    proof = persistedSnapshotProof(before, latest, shopId);
    if (isCompletePersistenceProof(proof)) {
      return { latencyMs: Date.now() - startedAt, proof, snapshot: latest };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`刷新完成但 SQLite 精确店铺快照未形成完整持久化证据：${JSON.stringify({
    databasePath,
    shopId,
    before,
    latest,
    proof,
  })}`);
}

async function waitForPersistedMarketSyncState({ databasePath, shopId, before, startedAtIso, timeoutMs = 15_000 }) {
  const startedAt = Date.now();
  let latest = null;
  let proof = persistedSyncStateProof(before, latest, shopId, startedAtIso);
  while (Date.now() - startedAt < timeoutMs) {
    latest = readPersistedMarketSyncState(databasePath, shopId);
    proof = persistedSyncStateProof(before, latest, shopId, startedAtIso);
    if (isCompletePersistenceProof(proof)) {
      return { latencyMs: Date.now() - startedAt, proof, state: latest };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`刷新完成但 SQLite 市场同步终态不正确：${JSON.stringify({
    databasePath,
    shopId,
    startedAtIso,
    before,
    latest,
    proof,
  })}`);
}

async function waitFor(expression, timeoutMs = 15_000, intervalMs = 200) {
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
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && !element.closest('[hidden]');
    };
    const candidates = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"]'))
      .filter((element) => visible(element) && element.innerText?.trim().includes(label))
      .sort((left, right) => left.innerText.trim().length - right.innerText.trim().length);
    const target = candidates.find((element) => element.innerText.trim() === label) || candidates[0];
    if (!target || target.disabled) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`没有找到可点击入口：${label}`);
}

async function openDataAnalysisMarket() {
  const alreadyOnMarket = await evaluate(`(() => {
    const tablist = document.querySelector('[role="tablist"][aria-label="数据分析模块"]');
    const activeTab = tablist?.querySelector('[role="tab"][aria-selected="true"]');
    return activeTab?.innerText?.trim() === '市场'
      && /(?:平台|Ozon) 市场分析/u.test(document.body.innerText || '');
  })()`);
  if (alreadyOnMarket) return;

  const openedDataAnalysis = await evaluate(`(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && !element.closest('[hidden]');
    };
    const target = Array.from(document.querySelectorAll('.nav-item'))
      .find((element) => visible(element) && element.innerText?.trim() === '数据分析');
    if (!target || target.disabled) return false;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  })()`);
  if (!openedDataAnalysis) throw new Error('没有找到左侧导航中的数据分析入口');

  await waitFor(
    `Boolean(document.querySelector('[role="tablist"][aria-label="数据分析模块"]'))`,
    20_000,
  );
  const openedMarket = await evaluate(`(() => {
    const tablist = document.querySelector('[role="tablist"][aria-label="数据分析模块"]');
    const target = Array.from(tablist?.querySelectorAll('[role="tab"]') || [])
      .find((element) => element.innerText?.trim() === '市场');
    if (!target || target.disabled) return false;
    if (target.getAttribute('aria-selected') !== 'true') target.click();
    return true;
  })()`);
  if (!openedMarket) throw new Error('数据分析页面没有找到市场页签');
  await waitFor(
    `(() => {
      const tablist = document.querySelector('[role="tablist"][aria-label="数据分析模块"]');
      const activeTab = tablist?.querySelector('[role="tab"][aria-selected="true"]');
      return activeTab?.innerText?.trim() === '市场'
        && /(?:平台|Ozon) 市场分析/u.test(document.body.innerText || '');
    })()`,
    20_000,
  );
}

async function ensureSpecificDataAnalysisShop() {
  const selectedShopId = await evaluate(`document.querySelector('.data-analysis-toolbar-shop-field input.MuiSelect-nativeInput')?.value || ''`);
  if (selectedShopId) return selectedShopId;
  const opened = await evaluate(`(() => {
    const select = document.querySelector('.data-analysis-toolbar-shop-field [role="combobox"]');
    if (!select) return false;
    select.click();
    return true;
  })()`);
  if (!opened) throw new Error('数据分析页面没有找到店铺范围选择器');
  await waitFor(
    `Array.from(document.querySelectorAll('[role="option"]')).some((option) => String(option.getAttribute('data-value') || '').trim())`,
    10_000,
  );
  const selected = await evaluate(`(() => {
    const option = Array.from(document.querySelectorAll('[role="option"]'))
      .find((item) => String(item.getAttribute('data-value') || '').trim());
    if (!option) return false;
    option.click();
    return true;
  })()`);
  if (!selected) throw new Error('店铺范围下拉框没有可用的精确店铺选项');
  await waitFor(
    `Boolean(document.querySelector('.data-analysis-toolbar-shop-field input.MuiSelect-nativeInput')?.value)`,
    10_000,
  );
  return evaluate(`document.querySelector('.data-analysis-toolbar-shop-field input.MuiSelect-nativeInput')?.value || ''`);
}

async function readMarketState() {
  const raw = await evaluate(`(() => {
    const bodyText = document.body.innerText || '';
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && !element.closest('[hidden]');
    };
    // MUI wrappers can make closest('.MuiCard-root') select a neighbouring
    // data card. Extract the exact visible status row from bodyText instead.
    const statusLineCandidates = bodyText.split(/\\r?\\n/u)
      .map((line) => line.trim().replace(/\\s+/gu, ' '))
      .filter((line) => /^最近获取\\s+\\d{4}\\/\\d{1,2}\\/\\d{1,2}\\s+\\d{1,2}:\\d{2}:\\d{2}\\s+·\\s+刷新完成\\s+/u.test(line));
    const refreshButtons = Array.from(document.querySelectorAll('button'))
      .filter((button) => visible(button) && /^(?:正在刷新|刷新数据)$/u.test(button.innerText.trim()));
    const refreshButton = refreshButtons[0];
    const tabs = Array.from(document.querySelectorAll('[role="tab"][aria-label=""], [role="tab"]'))
      .filter((element) => element.closest('[aria-label="Ozon 市场数据标签"]'))
      .map((element) => element.innerText.trim());
    const visibleAlerts = Array.from(document.querySelectorAll('[role="alert"]'))
      .filter(visible)
      .map((element) => element.innerText.trim())
      .filter(Boolean);
    const hasMarketAlertError = visibleAlerts.some((text) => (
      /市场|Ozon|插件|刷新/u.test(text) && /失败|错误|超时|无法/u.test(text)
    ));
    const bodyWidth = document.documentElement.scrollWidth;
    const viewportWidth = window.innerWidth;
    const moduleTablist = document.querySelector('[role="tablist"][aria-label="数据分析模块"]');
    const selectedModuleTabs = Array.from(moduleTablist?.querySelectorAll('[role="tab"][aria-selected="true"]') || [])
      .map((element) => element.innerText.trim())
      .filter(Boolean);
    return {
      locationHref: window.location.href,
      documentTitle: document.title,
      selectedModuleTabs,
      selectedShopId: document.querySelector('.data-analysis-toolbar-shop-field input.MuiSelect-nativeInput')?.value || '',
      hasMarketPanel: /(?:平台|Ozon) 市场分析/u.test(bodyText),
      statusLineCandidates,
      refreshButtonText: refreshButton?.innerText.trim() || '',
      refreshDisabled: refreshButton?.disabled === true,
      refreshButtonCandidateCount: refreshButtons.length,
      tabs,
      visibleAlerts,
      hasErrorBoundary: /页面显示异常|Something went wrong|Error Boundary/u.test(bodyText),
      hasConnectionError: /无法连接本地 API|本地 API 请求超时/u.test(bodyText),
      hasRefreshFailure: /刷新失败，当前为缓存数据|插件数据读取失败|读取浏览器插件数据失败|Ozon 市场数据刷新超过/u.test(bodyText),
      hasMarketAlertError,
      hasNaN: /\\bNaN\\b/u.test(bodyText),
      hasUndefined: /\\bundefined\\b/u.test(bodyText),
      bodyWidth,
      viewportWidth,
      horizontalOverflowPx: Math.max(0, bodyWidth - viewportWidth),
    };
  })()`);
  const parsedCandidates = raw.statusLineCandidates.map(parseMarketStatusLine).filter(Boolean);
  const parsedStatus = parsedCandidates.length === 1 ? parsedCandidates[0] : null;
  return {
    ...raw,
    parsedStatusCandidateCount: parsedCandidates.length,
    ...(parsedStatus || {
      statusLine: '',
      lastCaptureAt: '',
      lastCaptureSortKey: '',
      lastCompletedAt: '',
      lastCompletedSortKey: '',
      feedback: '',
      outcomeClass: 'unknown',
    }),
  };
}

function assertHealthyMarketState(state, round, phase) {
  if (!String(state.locationHref || '').startsWith('app://wangzai/')) {
    throw new Error(`第 ${round} 轮${phase}CDP 已离开旺崽助手页面：${JSON.stringify(state)}`);
  }
  if (!state.hasMarketPanel || state.selectedModuleTabs.length !== 1 || state.selectedModuleTabs[0] !== '市场') {
    throw new Error(`第 ${round} 轮${phase}已离开数据分析市场页：${JSON.stringify(state)}`);
  }
  if (state.hasErrorBoundary || state.hasConnectionError || state.hasRefreshFailure || state.hasMarketAlertError || state.hasNaN || state.hasUndefined) {
    throw new Error(`第 ${round} 轮${phase}页面异常：${JSON.stringify(state)}`);
  }
  if (state.horizontalOverflowPx > 2) {
    throw new Error(`第 ${round} 轮${phase}页面横向溢出：${JSON.stringify(state)}`);
  }
  if (state.refreshButtonCandidateCount !== 1) {
    throw new Error(`第 ${round} 轮${phase}刷新按钮不唯一：${JSON.stringify(state)}`);
  }
  if (state.parsedStatusCandidateCount !== 1 || !state.statusLine) {
    throw new Error(`第 ${round} 轮${phase}市场状态行缺失或不唯一：${JSON.stringify(state)}`);
  }
}

await send('Page.enable');
await send('Runtime.enable');

// 每次启动强制登录；如果账号密码已记住，只点击登录即可。
if (await evaluate(`document.body.innerText.includes('欢迎回来') && Boolean(Array.from(document.querySelectorAll('button')).find((button) => button.innerText.trim() === '登录'))`)) {
  await clickVisibleText('登录');
  await waitFor(`document.body.innerText.includes('核心工作台')`, 45_000);
}

await openDataAnalysisMarket();
const selectedShopId = await ensureSpecificDataAnalysisShop();
const appInfo = await evaluate(`window.wangzaiDesktop?.getAppInfo?.()`);
const databasePath = path.resolve(
  configuredDatabasePath || path.join(String(appInfo?.userData || ''), 'local-api-data', 'wangzai-local-api.sqlite'),
);
if (!selectedShopId) throw new Error('实机验证必须选择一个精确店铺，不能使用全部店铺聚合范围');
if (!appInfo?.userData && !configuredDatabasePath) {
  throw new Error('无法从 Electron runtime 获取当前 profile 的 userData，且未显式传入 SQLite 路径');
}
if (!existsSync(databasePath)) throw new Error(`当前 Electron profile 的 SQLite 数据库不存在：${databasePath}`);

// 进入页面时可能正在执行一次自动读取。先等它真正释放按钮，再开始
// 统计手动刷新；否则脚本会把“按钮存在但仍被后台任务禁用”误报成找不到。
await waitFor(
  `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && !element.closest('[hidden]');
    };
    return Array.from(document.querySelectorAll('button'))
      .some((button) => visible(button) && button.innerText.trim() === '刷新数据' && !button.disabled);
  })()`,
  refreshTimeoutMs,
  500,
);
await waitFor(
  `document.body.innerText.split(/\\r?\\n/u).some((line) => /^最近获取\\s+\\d{4}\\/\\d{1,2}\\/\\d{1,2}\\s+\\d{1,2}:\\d{2}:\\d{2}\\s+·\\s+刷新完成\\s+/u.test(line.trim()))`,
  refreshTimeoutMs,
  500,
);

const observations = [];
for (let round = 1; round <= rounds; round += 1) {
  const before = await readMarketState();
  assertHealthyMarketState(before, round, '开始前');
  if (before.refreshButtonText !== '刷新数据' || before.refreshDisabled) {
    throw new Error(`第 ${round} 轮开始前刷新按钮状态错误：${JSON.stringify(before)}`);
  }
  if (before.selectedShopId !== selectedShopId) {
    throw new Error(`第 ${round} 轮开始前店铺范围发生变化：${JSON.stringify({ expected: selectedShopId, actual: before.selectedShopId })}`);
  }
  const persistedBefore = readPersistedMarketSnapshot(databasePath, selectedShopId);
  const persistedSyncStateBefore = readPersistedMarketSyncState(databasePath, selectedShopId);
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  await clickVisibleText('刷新数据');
  const startLatencyMs = await waitFor(
    `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && !element.closest('[hidden]');
      };
      return Array.from(document.querySelectorAll('button'))
        .some((button) => visible(button) && button.innerText.trim() === '正在刷新' && button.disabled);
    })()`,
    10_000,
  );
  const running = await readMarketState();
  assertHealthyMarketState(running, round, '刷新中');
  if (running.refreshButtonText !== '正在刷新' || !running.refreshDisabled) {
    throw new Error(`第 ${round} 轮未进入明确刷新状态：${JSON.stringify(running)}`);
  }
  await waitFor(
    `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && !element.closest('[hidden]');
      };
      const tablist = document.querySelector('[role="tablist"][aria-label="数据分析模块"]');
      const activeTab = tablist?.querySelector('[role="tab"][aria-selected="true"]');
      return activeTab?.innerText?.trim() === '市场'
        && Array.from(document.querySelectorAll('button'))
          .some((button) => visible(button) && button.innerText.trim() === '刷新数据' && !button.disabled);
    })()`,
    refreshTimeoutMs,
    500,
  );
  const after = await readMarketState();
  const persistence = await waitForPersistedMarketSnapshot({
    databasePath,
    shopId: selectedShopId,
    before: persistedBefore,
  });
  const syncStatePersistence = await waitForPersistedMarketSyncState({
    databasePath,
    shopId: selectedShopId,
    before: persistedSyncStateBefore,
    startedAtIso,
  });
  const endedAt = Date.now();
  const durationMs = endedAt - startedAt;
  const { captureTimeAdvanced, completionTimeAdvanced } = marketTimesAdvanced(before, after);
  const observation = {
    round,
    startedAt: startedAtIso,
    endedAt: new Date(endedAt).toISOString(),
    startLatencyMs,
    durationMs,
    buttonLifecycle: {
      before: { text: before.refreshButtonText, disabled: before.refreshDisabled },
      running: { text: running.refreshButtonText, disabled: running.refreshDisabled },
      after: { text: after.refreshButtonText, disabled: after.refreshDisabled },
    },
    timeEvidence: {
      beforeLastCaptureAt: before.lastCaptureAt,
      afterLastCaptureAt: after.lastCaptureAt,
      captureTimeAdvanced,
      beforeLastCompletedAt: before.lastCompletedAt,
      afterLastCompletedAt: after.lastCompletedAt,
      completionTimeAdvanced,
    },
    outcome: { class: after.outcomeClass, label: after.feedback },
    persistence: {
      databasePath,
      before: persistedBefore,
      after: persistence.snapshot,
      proof: persistence.proof,
      readbackLatencyMs: persistence.latencyMs,
      syncStateBefore: persistedSyncStateBefore,
      syncStateAfter: syncStatePersistence.state,
      syncStateProof: syncStatePersistence.proof,
      syncStateReadbackLatencyMs: syncStatePersistence.latencyMs,
    },
    health: {
      noErrorBoundary: !after.hasErrorBoundary,
      noConnectionError: !after.hasConnectionError,
      noRefreshFailure: !after.hasRefreshFailure,
      noMarketAlertError: !after.hasMarketAlertError,
      noNaN: !after.hasNaN,
      noUndefined: !after.hasUndefined,
      noHorizontalOverflow: after.horizontalOverflowPx <= 2,
      horizontalOverflowPx: after.horizontalOverflowPx,
    },
    before,
    running,
    after,
  };
  assertHealthyMarketState(after, round, '完成后');
  if (after.refreshButtonText !== '刷新数据' || after.refreshDisabled) {
    throw new Error(`第 ${round} 轮刷新按钮没有恢复：${JSON.stringify(observation)}`);
  }
  if (!captureTimeAdvanced || !completionTimeAdvanced) {
    throw new Error(`第 ${round} 轮刷新结束但市场时间未推进：${JSON.stringify(observation)}`);
  }
  if (!['success', 'partial'].includes(after.outcomeClass)) {
    throw new Error(`第 ${round} 轮没有形成成功或部分成功状态：${JSON.stringify(observation)}`);
  }
  if (!isCompletePersistenceProof(persistence.proof)) {
    throw new Error(`第 ${round} 轮 SQLite 持久化证据不完整：${JSON.stringify(observation)}`);
  }
  if (!isCompletePersistenceProof(syncStatePersistence.proof)) {
    throw new Error(`第 ${round} 轮 SQLite 市场同步终态证据不完整：${JSON.stringify(observation)}`);
  }
  observations.push(observation);
}

const resultDir = path.resolve('test-results');
await mkdir(resultDir, { recursive: true });
const reportPath = path.join(resultDir, 'data-analysis-market-refresh-live.json');
await writeFile(reportPath, `${JSON.stringify({
  ok: true,
  verifiedAt: new Date().toISOString(),
  cdpTarget: { id: target.id, title: target.title, url: target.url },
  sqliteTarget: { databasePath, selectedShopId },
  rounds,
  refreshTimeoutMs,
  successfulRounds: observations.filter((item) => item.outcome.class === 'success').length,
  partialRounds: observations.filter((item) => item.outcome.class === 'partial').length,
  observations,
}, null, 2)}\n`, 'utf8');
const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const screenshotPath = path.join(resultDir, 'data-analysis-market-refresh-live.png');
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
socket.close();

console.log(JSON.stringify({ ok: true, rounds, reportPath, screenshotPath, observations }, null, 2));
