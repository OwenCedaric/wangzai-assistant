import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  buildMaintenanceObservationCards,
  buildSchedulerRunningCards,
  formatRetryCountdown,
  getFriendlyBackgroundFailure,
  getSchedulerDomainQueueCount,
  getStatusObservationDomainLabel,
  STATUS_OBSERVATION_CATEGORIES,
} from './statusObservation/statusObservationPlainLanguage.js';
import { useStatusObservationRemoteState } from './statusObservation/useStatusObservationRemoteState.js';

const ISSUE_TONE_CLASS = {
  problem: 'problem',
  warning: 'warning',
  running: 'running',
  healthy: 'healthy',
};

function getOzonEndpointStatusLabel(endpoint) {
  const text = String(endpoint || '');
  if (text.includes('posting/fbs/unfulfilled/list')) return '待处理订单列表';
  if (text.includes('posting/fbs/list')) return '销售订单列表';
  if (text.includes('posting/fbo/list')) return 'FBO 订单列表';
  if (text.includes('posting/fbs/get')) return '销售订单详情';
  if (text.includes('product/info/stocks')) return '商品库存信息';
  if (text.includes('product/info/prices')) return '商品价格信息';
  if (text.includes('product/import/stocks')) return '商品库存写入';
  if (text.includes('product/import/prices')) return '商品价格写入';
  if (text.includes('product/info/attributes')) return '商品属性信息';
  if (text.includes('product/info/list')) return '商品详情信息';
  if (text.includes('product/list')) return '商品基础列表';
  return 'Ozon 业务接口';
}

function getLocalApiDomainLabel(domain) {
  return getStatusObservationDomainLabel(domain);
}

function getLocalPathMeta(path = '') {
  const cleanPath = String(path || '').split('?')[0];
  if (cleanPath.startsWith('/api/sync/jobs')) return { category: 'sync', label: '同步进度查询', stage: '读取任务进度' };
  const domainRoute = cleanPath.match(/^\/api\/(cache|sync)\/([^/]+)/u);
  if (domainRoute) {
    const action = domainRoute[1];
    return {
      category: action === 'cache' ? 'cache' : 'sync',
      label: `${getLocalApiDomainLabel(domainRoute[2])}${action === 'cache' ? '缓存读取' : '同步提交'}`,
      stage: action === 'cache' ? '读取缓存' : '提交同步',
    };
  }
  const writeRoute = cleanPath.match(/^\/api\/write\/([^/]+)\/(preview|confirm)/u);
  if (writeRoute) {
    return {
      category: 'write',
      label: `${getLocalApiDomainLabel(writeRoute[1])}${writeRoute[2] === 'preview' ? '写入预览' : '写入确认'}`,
      stage: writeRoute[2] === 'preview' ? '写入前预览' : '提交写入',
    };
  }
  if (cleanPath.startsWith('/api/ozon/notifications'))
    return { category: 'local', label: '消息中心', stage: '读取消息' };
  if (cleanPath.startsWith('/api/ozon/notification-settings')) {
    return { category: 'local', label: '消息提醒设置', stage: '读取设置' };
  }
  if (cleanPath.startsWith('/api/ozon/') && cleanPath.endsWith('/request')) {
    return { category: 'ozon', label: 'Ozon 本地转发', stage: '访问 Ozon' };
  }
  if (cleanPath === '/health') return { category: 'local', label: '后台健康检查', stage: '检查后台' };
  return { category: 'local', label: '本地后台请求', stage: '后台处理' };
}

function getShortTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function getTimeoutText(message = '') {
  const ms = Number(String(message).match(/(\d+)\s*ms/i)?.[1]) || 0;
  if (!ms) return '等待软件后台返回超时';
  const seconds = Math.round((ms / 1000) * 10) / 10;
  return `等待软件后台超过 ${seconds} 秒`;
}

function getLocalProblemText(issue = {}) {
  const message = String(issue.message || '');
  if (issue.code === 'LOCAL_API_TIMEOUT' || /超时|timeout/i.test(message)) return getTimeoutText(message);
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return '网络连接不稳定，后台没有返回数据';
  if (Number(issue.status) >= 500) return '软件后台返回异常';
  if (Number(issue.status) >= 400) return '软件后台拒绝了这次请求';
  return '软件后台这次没有处理成功';
}

function getLocalSolution(issue = {}) {
  const message = String(issue.message || '');
  if (issue.code === 'LOCAL_API_TIMEOUT' || /超时|timeout/i.test(message)) {
    return '先等待几秒再重新获取；如果一直不恢复，退出旺崽助手后重新打开。';
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return '检查网络或代理后重新获取；如果网络正常，退出旺崽助手后重新打开。';
  }
  if (Number(issue.status) >= 500) return '先重新获取；如果连续失败，退出旺崽助手后重新打开。';
  return '稍后重新获取；如果连续失败，退出旺崽助手后重新打开。';
}

function getOzonProblemText(issue = {}) {
  if (issue.type === 'rate-limit') return 'Ozon 暂时限制继续读取';
  if (issue.type === 'timeout') return '等待 Ozon 返回超时';
  if (issue.type === 'network') return '访问 Ozon 时网络不稳定';
  if (issue.type === 'server') return 'Ozon 服务暂时不稳定';
  return 'Ozon 这次没有返回成功';
}

function getOzonSolution(issue = {}) {
  if (issue.type === 'rate-limit') return '系统会自动排队重试，请先不要连续点击刷新。';
  if (issue.type === 'timeout') return '系统会自动重试；如果一直不恢复，检查网络后重新获取。';
  if (issue.type === 'network') return '检查网络或代理后重新获取。';
  return '稍后重新获取；如果连续失败，先检查网络。';
}

function getLocalIssueCategory(issue = {}) {
  const meta = getLocalPathMeta(issue.path);
  const message = String(issue.message || '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'network';
  return meta.category;
}

function buildLocalIssueCard(issue = {}) {
  const meta = getLocalPathMeta(issue.path);
  const category = getLocalIssueCategory(issue);
  return {
    id: issue.id || `local:${issue.path}`,
    source: 'local',
    category,
    tone: 'problem',
    title: meta.label,
    state: getLocalProblemText(issue),
    stage: meta.stage,
    progress: `连续失败 ${issue.failureCount || 1} 次${issue.lastFailedAt ? ` · 最近 ${getShortTime(issue.lastFailedAt)}` : ''}`,
    solution: getLocalSolution(issue),
    attention: true,
    userActionRequired: true,
  };
}

function buildOzonIssueCard(issue = {}) {
  const retryText = issue.willRetry === true || issue.nextRetryAt
    ? formatRetryCountdown(issue.nextRetryAt)
    : '';
  return {
    id: issue.id || `ozon:${issue.endpoint}:${issue.shopKey}`,
    source: 'ozon',
    category: issue.type === 'network' ? 'network' : 'ozon',
    tone: issue.type === 'rate-limit' ? 'warning' : 'problem',
    title: getOzonEndpointStatusLabel(issue.endpoint),
    state: getOzonProblemText(issue),
    stage: issue.type === 'rate-limit' ? '排队重试' : '访问 Ozon',
    progress: [
      `失败 ${issue.failureCount || 1} 次`,
      retryText,
      issue.lastFailedAt ? `最近 ${getShortTime(issue.lastFailedAt)}` : '',
    ].filter(Boolean).join(' · '),
    solution: retryText ? '系统会自动重试，现有本地数据仍可正常查看。' : getOzonSolution(issue),
    attention: true,
    userActionRequired: !retryText,
  };
}

function buildRunningCards(localStats = {}) {
  const cards = [];
  if (Number(localStats.active) || 0) {
    cards.push({
      id: 'local-running',
      source: 'local',
      category: 'local',
      tone: 'running',
      title: '软件后台正在处理',
      state: '本地后台正在返回数据',
      stage: '后台处理',
      progress: `进行中 ${localStats.active || 0}`,
      solution: '通常会自动完成，请稍等几秒。',
      userActionRequired: false,
    });
  }
  return cards;
}

function getSyncJobStatusLabel(status = '') {
  const text = String(status || '').toLowerCase();
  if (['success', 'succeeded', 'completed', 'done', 'merged'].includes(text)) return '已完成';
  if (['running', 'processing', 'in_progress'].includes(text)) return '进行中';
  if (['queued', 'pending', 'created'].includes(text)) return '等待中';
  if (['failed', 'error'].includes(text)) return '失败';
  if (['cancelled', 'canceled'].includes(text)) return '已取消';
  if (['rate_limited', 'circuit_open'].includes(text)) return '等待重试';
  if (text === 'blocked') return '已阻止';
  return status || '同步中';
}

function getSyncJobTone(status = '', failedCount = 0) {
  const text = String(status || '').toLowerCase();
  if (failedCount > 0 || ['failed', 'error'].includes(text)) return 'problem';
  if (['rate_limited', 'circuit_open', 'blocked', 'cancelled', 'canceled'].includes(text)) return 'warning';
  if (['running', 'processing', 'in_progress', 'queued', 'pending', 'created'].includes(text)) return 'running';
  return 'healthy';
}

function getSyncJobProgressText(job = {}) {
  const done = Number(job.progressDone) || Number(job.itemsDone) || 0;
  const total = Number(job.progressTotal) || Number(job.itemsTotal) || 0;
  const itemDone = Number(job.itemsDone) || 0;
  const itemTotal = Number(job.itemsTotal) || 0;
  if (itemTotal > 0) return `已处理 ${Math.min(itemDone, itemTotal)} / ${itemTotal}`;
  if (total > 0) return `已完成 ${Math.min(done, total)} / ${total}`;
  return '等待任务进度返回';
}

function buildSyncJobCard(job = {}) {
  const tone = getSyncJobTone(job.status, job.failedCount);
  return {
    id: `sync-job:${job.jobId || job.id}`,
    source: 'local',
    category: 'sync',
    tone,
    title: `${getLocalApiDomainLabel(job.domain)}数据更新`,
    state: getSyncJobStatusLabel(job.status),
    stage: tone === 'problem'
      ? '等待重新尝试'
      : tone === 'warning'
        ? '等待自动恢复'
        : tone === 'running'
          ? '正在更新'
          : '更新完成',
    progress: getSyncJobProgressText(job),
    solution:
      tone === 'problem'
        ? '重新获取一次；如果连续失败，退出旺崽助手后重新打开。'
        : tone === 'running'
          ? '请等待当前同步任务完成。'
          : '当前任务已经完成，不需要处理。',
    attention: tone === 'problem' || tone === 'warning',
    userActionRequired: tone === 'problem',
  };
}

function getProfitProgressText(progress = {}) {
  const total = Number(progress.total) || 0;
  const done = Number(progress.done) || 0;
  const cached = Number(progress.cached) || 0;
  const missing = Number(progress.missing) || 0;
  const failed = Number(progress.failed) || 0;
  if (missing > 0) {
    return `已补读 ${Math.min(done, missing)} / ${missing}，本地命中 ${cached}${failed ? `，失败 ${failed}` : ''}`;
  }
  if (total > 0) return `已处理 ${Math.min(done, total)} / ${total}`;
  return progress.active ? '正在处理' : '已完成';
}

function buildProfitProgressCards(progress = {}) {
  if (!progress?.updatedAt || progress.stage === 'idle') return [];
  const active = progress.active !== false;
  const failed = Number(progress.failed) || 0;
  return [
    {
      id: 'profit-refresh-progress',
      source: 'local',
      category: 'local',
      tone: failed ? 'warning' : active ? 'running' : 'healthy',
      title: progress.label || '利润核算刷新',
      state: progress.message || (active ? '利润核算正在处理' : '利润核算已完成'),
      stage: progress.stage || '利润刷新',
      progress: getProfitProgressText(progress),
      solution: failed
        ? '利润页会保留已有缓存；如果汇率仍缺失，可稍后再刷新利润页。'
        : active
          ? '利润页已先显示本地缓存，后台完成后会自动合并。'
          : '当前利润页刷新阶段已完成。',
      attention: failed > 0,
      userActionRequired: false,
    },
  ];
}

function buildContinuousSyncCards(status = {}, schedulerStatus = {}) {
  if (!status?.ok) return [];
  const targets = Array.isArray(status.targets) ? status.targets : [];
  const attentionTargets = targets
    .filter((target) => {
      const result = target?.lastResult || {};
      const jobStatus = String(result.jobStatus || result.status || '').toLowerCase();
      return result.accepted === false || ['failed', 'error', 'rate_limited', 'circuit_open', 'blocked', 'cancelled', 'canceled'].includes(jobStatus);
    })
    .slice(0, 4);
  return attentionTargets.map((target) => {
    const result = target.lastResult || {};
    const jobStatus = result.jobStatus || result.status || '';
    const tone = result.accepted === false ? 'warning' : getSyncJobTone(jobStatus);
    const domainLabel = getLocalApiDomainLabel(target.domain);
    const retryText = formatRetryCountdown(result.jobRetryAt);
    const domainQueued = getSchedulerDomainQueueCount(schedulerStatus, target.domain);
    const progressParts = [];
    if (domainQueued) progressParts.push(`${domainLabel}缓存排队 ${domainQueued} 个`);
    if (retryText) progressParts.push(retryText);
    else if (result.jobFinishedAt) progressParts.push(`最近失败 ${getShortTime(result.jobFinishedAt)}`);
    if (!progressParts.length) progressParts.push('等待系统安排下一轮更新');
    return {
      id: `continuous-sync:${target.shopId}:${target.policyId}`,
      source: 'local',
      category: 'sync',
      tone,
      title: `${domainLabel}缓存更新${tone === 'problem' ? '失败' : '等待重试'}`,
      state: `${getFriendlyBackgroundFailure(result.jobLastError || result.reason)}，现有${domainLabel}仍可正常查看`,
      stage: retryText ? '等待自动重试' : '等待下一轮更新',
      progress: progressParts.join(' · '),
      solution: retryText
        ? '系统会自动重试；连续失败时再检查店铺授权或网络。'
        : '现有数据不会丢失；连续失败时检查店铺授权或网络。',
      attention: true,
      userActionRequired: !retryText,
    };
  });
}

function collectHotCacheLayers(status = {}) {
  return Object.values(status?.hotCache || {}).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    return [entry.readThrough || entry, entry.nested].filter((layer) => layer?.metrics);
  });
}

function buildHotCacheCards(status = {}) {
  if (!status?.ok) return [];
  const layers = collectHotCacheLayers(status);
  if (!layers.length) return [];
  const totals = layers.reduce((result, layer) => {
    result.entries += Number(layer.entries) || 0;
    result.hits += Number(layer.metrics?.hits) || 0;
    result.misses += Number(layer.metrics?.misses) || 0;
    return result;
  }, { entries: 0, hits: 0, misses: 0 });
  const requests = totals.hits + totals.misses;
  const hitRate = requests ? Math.round((totals.hits / requests) * 100) : 0;
  return [{
    id: 'domain-hot-cache',
    source: 'local',
    category: 'performance',
    tone: 'healthy',
    title: '页面热缓存',
    state: totals.entries > 0 ? '页面正在复用已读取的数据' : '页面热缓存已启用，等待首次读取',
    stage: '店铺和板块独立缓存',
    progress: `当前 ${totals.entries} 份 · 命中 ${totals.hits} 次${requests ? ` · 命中率 ${hitRate}%` : ''}`,
    solution: '切换页面或切回店铺时优先显示缓存，后台更新不会清空当前数据。',
    attention: false,
    userActionRequired: false,
  }];
}

function buildWorkspacePerformanceCards(stats = {}) {
  const navigation = stats?.navigation || {};
  const longTasks = stats?.longTasks || {};
  const navigationCount = Number(navigation.count) || 0;
  const longTaskCount = Number(longTasks.count) || 0;
  if (!navigationCount && !longTaskCount) return [];
  const maxLongTaskMs = Number(longTasks.maxMs) || 0;
  const longOver100ms = Number(longTasks.over100ms) || 0;
  const tone = longOver100ms > 0 ? 'warning' : 'healthy';
  const lastPage = navigation.last?.pageId || '暂无';
  return [{
    id: 'workspace-performance',
    source: 'system',
    category: 'performance',
    tone,
    title: '页面打开速度',
    state: tone === 'warning' ? '最近有页面操作出现明显卡顿' : '最近页面打开速度正常',
    stage: `最近查看 ${lastPage}`,
    progress: `已记录 ${navigationCount} 次 · 明显卡顿 ${longOver100ms} 次${maxLongTaskMs ? ` · 最长约 ${(maxLongTaskMs / 1000).toFixed(1)} 秒` : ''}`,
    solution: tone === 'warning'
      ? '先关闭暂时不用的页面；如果持续卡顿，重新打开软件。'
      : '继续正常使用即可。',
    attention: tone === 'warning',
    userActionRequired: false,
  }];
}

function getCategoryCounts(cards = []) {
  return cards.reduce(
    (result, card) => {
      result.all += 1;
      if (card.category !== 'all') {
        result[card.category] = (result[card.category] || 0) + 1;
      }
      return result;
    },
    { all: 0 }
  );
}

function buildOverviewCard({ active = 0, queued = 0, issueCount = 0 } = {}) {
  const hasRunning = Boolean(Number(active) || Number(queued));
  return {
    id: 'overview',
    source: 'system',
    category: 'all',
    tone: issueCount ? 'problem' : hasRunning ? 'running' : 'healthy',
    title: issueCount ? `有 ${issueCount} 项需要关注` : hasRunning ? '后台正在更新数据' : '当前运行正常',
    state: hasRunning ? `正在处理 ${active} 个，当前排队 ${queued} 个` : '没有失败或排队中的任务',
    stage: issueCount ? '查看下方说明' : hasRunning ? '自动处理中' : '运行正常',
    progress: issueCount ? '已有本地数据会继续保留' : '所有状态会自动更新',
    solution: issueCount ? '查看下面每一项的“需要你操作”或“无需操作”说明。' : '当前不需要处理。',
    userActionRequired: issueCount > 0,
  };
}

export function StatusObservationPopover({
  open,
  anchorEl,
  onClose,
  ozonRequestStats = {},
  localApiRequestStats = {},
  workspacePerformanceStats = {},
  profitRefreshProgress = {},
  continuousSyncStatus: providedContinuousSyncStatus,
  schedulerStatus: providedSchedulerStatus,
  maintenanceStatus: providedMaintenanceStatus,
}) {
  const [selectedCategory, setSelectedCategory] = React.useState('all');
  const shouldLoadRemoteState = providedContinuousSyncStatus === undefined
    && providedSchedulerStatus === undefined
    && providedMaintenanceStatus === undefined;
  const remoteState = useStatusObservationRemoteState({ enabled: open && shouldLoadRemoteState });
  const continuousSyncStatus = providedContinuousSyncStatus ?? remoteState.continuousSyncStatus;
  const schedulerStatus = providedSchedulerStatus ?? remoteState.schedulerStatus;
  const maintenanceStatus = providedMaintenanceStatus ?? remoteState.maintenanceStatus;
  const issueCards = React.useMemo(
    () => [
      ...(ozonRequestStats.currentIssues || []).map(buildOzonIssueCard),
      ...(localApiRequestStats.currentIssues || localApiRequestStats.recentFailures || []).map(buildLocalIssueCard),
    ],
    [localApiRequestStats.currentIssues, localApiRequestStats.recentFailures, ozonRequestStats.currentIssues]
  );
  const runningCards = React.useMemo(
    () => [
      ...buildSchedulerRunningCards(schedulerStatus, ozonRequestStats),
      ...buildRunningCards(localApiRequestStats),
    ],
    [localApiRequestStats, ozonRequestStats, schedulerStatus]
  );
  const syncJobCards = React.useMemo(
    () => (localApiRequestStats.syncJobs || []).slice(0, 4).map(buildSyncJobCard),
    [localApiRequestStats.syncJobs]
  );
  const profitProgressCards = React.useMemo(
    () => buildProfitProgressCards(profitRefreshProgress),
    [profitRefreshProgress]
  );
  const continuousSyncCards = React.useMemo(
    () => buildContinuousSyncCards(continuousSyncStatus, schedulerStatus),
    [continuousSyncStatus, schedulerStatus]
  );
  const hotCacheCards = React.useMemo(
    () => buildHotCacheCards(continuousSyncStatus),
    [continuousSyncStatus]
  );
  const maintenanceCards = React.useMemo(
    () => buildMaintenanceObservationCards(maintenanceStatus),
    [maintenanceStatus]
  );
  const workspacePerformanceCards = React.useMemo(
    () => buildWorkspacePerformanceCards(workspacePerformanceStats),
    [workspacePerformanceStats]
  );
  const detailCards = React.useMemo(
    () => [...issueCards, ...runningCards, ...continuousSyncCards, ...hotCacheCards, ...maintenanceCards, ...workspacePerformanceCards, ...profitProgressCards, ...syncJobCards],
    [continuousSyncCards, hotCacheCards, issueCards, maintenanceCards, profitProgressCards, runningCards, syncJobCards, workspacePerformanceCards]
  );
  const issueCount = detailCards.filter((card) => card.attention === true).length;
  const hasRunning = runningCards.length > 0 || profitProgressCards.some((card) => card.tone === 'running') || continuousSyncCards.some((card) => card.tone === 'running');
  const schedulerQueue = schedulerStatus?.queue || {};
  const activeCount = Number(schedulerQueue.running) || Number(ozonRequestStats.active) || Number(localApiRequestStats.active) || 0;
  const queuedCount = Number(schedulerQueue.queued) || Number(ozonRequestStats.queued) || 0;
  const overviewCard = React.useMemo(
    () => buildOverviewCard({ active: activeCount, queued: queuedCount, issueCount }),
    [activeCount, issueCount, queuedCount]
  );
  const cards = React.useMemo(
    () => [overviewCard, ...detailCards],
    [detailCards, overviewCard]
  );
  const categoryCounts = React.useMemo(() => getCategoryCounts(cards), [cards]);
  const visibleCards = selectedCategory === 'all' ? cards : cards.filter((card) => card.category === selectedCategory);
  const statusLabel = issueCount ? `有 ${issueCount} 项需要关注` : hasRunning ? '后台正在处理' : '运行正常';

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      PaperProps={{ className: 'status-observation-popover-paper' }}
    >
      <Box className="status-observation-shell">
        <Stack direction="row" alignItems="center" justifyContent="space-between" className="status-observation-head">
          <Box>
            <Typography variant="subtitle1">运行状态</Typography>
            <Typography variant="caption" color="text.secondary">
              查看哪些数据正在更新、排队、失败或等待重试
            </Typography>
          </Box>
          <Chip
            size="small"
            label={statusLabel}
            className={`status-observation-summary ${issueCount ? 'problem' : hasRunning ? 'running' : 'healthy'}`}
          />
        </Stack>

        <Box className="status-observation-body">
          <Box className="status-observation-category-list" aria-label="状态分类">
            {STATUS_OBSERVATION_CATEGORIES.map((category) => (
              <Box
                key={category.id}
                component="button"
                type="button"
                className={`status-observation-category-item${selectedCategory === category.id ? ' active' : ''}`}
                onClick={() => setSelectedCategory(category.id)}
              >
                <span>{category.title}</span>
                <strong>{categoryCounts[category.id] || 0}</strong>
              </Box>
            ))}
          </Box>

          <Box className="status-observation-panel">
            <Box className="status-observation-card-list">
              {visibleCards.length ? (
                visibleCards.map((card) => (
                  <Box key={card.id} className={`status-observation-card ${ISSUE_TONE_CLASS[card.tone] || 'problem'}`}>
                    <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
                      <Box minWidth={0}>
                        <Typography variant="body2" className="status-observation-card-title">
                          {card.title}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" className="status-observation-card-state">
                          {card.state}
                        </Typography>
                      </Box>
                      <Chip
                        size="small"
                        label={card.source === 'ozon' ? 'Ozon' : card.source === 'local' ? '本地' : '概览'}
                        variant="outlined"
                      />
                    </Stack>
                    <Stack direction="row" spacing={0.75} flexWrap="wrap" mt={0.75}>
                      <Chip size="small" label={`当前：${card.stage}`} />
                      <Chip size="small" label={card.progress} variant="outlined" />
                    </Stack>
                    <Typography variant="caption" className="status-observation-solution">
                      {card.userActionRequired ? '需要你操作：' : '无需操作：'}{card.solution}
                    </Typography>
                  </Box>
                ))
              ) : (
                <Box className="status-observation-empty">
                  <Typography variant="body2">当前没有需要处理的问题</Typography>
                  <Typography variant="caption" color="text.secondary">
                    如果刚才失败的任务已经重新获取成功，会自动从这里消失。
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>
        </Box>
      </Box>
    </Popover>
  );
}
