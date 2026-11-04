import {
  getSmartReplyRuntimeStatus,
  listSmartReplyCredentials,
  listSmartReplyRules,
  listSmartReplyTasks,
  retrySmartReplyTask,
  saveSmartReplyRule,
  setSmartReplyRuleEnabled,
  syncBoundSmartReplyShopCredential,
} from '../../licensing/services/licenseCenterClient.js';
import { requestLocalApi } from '../../../api/localApiClient.js';

export const SMART_REPLY_EXECUTION_MODES = Object.freeze({
  local: 'local',
  cloud: 'cloud',
});

function text(value) {
  return String(value || '').trim();
}

function normalizeCredential(row = {}) {
  return {
    clientId: text(row.client_id),
    shopName: text(row.shop_name),
    configured: row.configured === true,
    status: text(row.status) || 'unconfigured',
    lastVerifiedAt: text(row.last_verified_at),
  };
}

function normalizeRule(row = {}) {
  return {
    ruleId: text(row.rule_id),
    scene: text(row.scene),
    shopClientIds: Array.isArray(row.shop_client_ids) ? row.shop_client_ids.map(text).filter(Boolean) : [],
    sendTimeType: text(row.send_time_type) || 'immediate',
    delayHours: Number(row.delay_hours) || 0,
    contentGenerateType: text(row.content_generate_type) || 'template',
    templateId: text(row.template_id),
    messageTemplate: text(row.message_template),
    messageTemplateZh: text(row.message_template_zh),
    enabled: row.enabled === true,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function normalizeTask(row = {}) {
  return {
    taskId: text(row.task_id),
    ruleId: text(row.rule_id),
    clientId: text(row.client_id),
    shopName: text(row.shop_name),
    postingNumber: text(row.posting_number),
    scene: text(row.scene),
    triggerStatus: text(row.trigger_status),
    scheduledFor: text(row.scheduled_for),
    status: text(row.status),
    attempts: Number(row.attempts) || 0,
    chatId: text(row.chat_id),
    messageId: text(row.ozon_message_id),
    sentAt: text(row.sent_at),
    errorCode: text(row.last_error_code),
    errorMessage: text(row.last_error_message),
    createdAt: text(row.created_at),
  };
}

async function loadLocalSmartReplyAutomation() {
  const [runtime, credentials, rules, tasks] = await Promise.all([
    requestLocalApi('/api/smart-reply/local/status'),
    requestLocalApi('/api/smart-reply/local/credentials'),
    requestLocalApi('/api/smart-reply/local/rules'),
    requestLocalApi('/api/smart-reply/local/tasks?limit=100'),
  ]);
  return { runtime, credentials, rules, tasks };
}

async function loadCloudSmartReplyAutomation() {
  const [runtime, credentials, rules, tasks] = await Promise.all([
    getSmartReplyRuntimeStatus(),
    listSmartReplyCredentials(),
    listSmartReplyRules(),
    listSmartReplyTasks(100),
  ]);
  return { runtime, credentials, rules, tasks };
}

export async function readSmartReplyExecutionMode() {
  const payload = await requestLocalApi('/api/smart-reply/mode');
  return payload?.mode === SMART_REPLY_EXECUTION_MODES.local
    ? SMART_REPLY_EXECUTION_MODES.local
    : SMART_REPLY_EXECUTION_MODES.cloud;
}

export async function changeSmartReplyExecutionMode(nextMode, previousMode) {
  const next = nextMode === SMART_REPLY_EXECUTION_MODES.local
    ? SMART_REPLY_EXECUTION_MODES.local
    : SMART_REPLY_EXECUTION_MODES.cloud;
  const previous = previousMode === SMART_REPLY_EXECUTION_MODES.local
    ? SMART_REPLY_EXECUTION_MODES.local
    : SMART_REPLY_EXECUTION_MODES.cloud;
  if (next === previous) return { mode: next, warning: '' };
  const disabledRuleIds = [];
  let warning = '';
  try {
    if (previous === SMART_REPLY_EXECUTION_MODES.cloud) {
      try {
        const rules = await listSmartReplyRules();
        for (const rule of rules.filter((row) => row?.enabled === true)) {
          await setSmartReplyRuleEnabled(rule.rule_id, false);
          disabledRuleIds.push(text(rule.rule_id));
        }
      } catch (error) {
        if (next !== SMART_REPLY_EXECUTION_MODES.local) throw error;
        warning = '本地监听已启动，但云端服务当前不可连接，暂时无法确认旧云端规则是否已关闭。';
      }
    } else {
      const rules = await requestLocalApi('/api/smart-reply/local/rules');
      for (const rule of (Array.isArray(rules) ? rules : []).filter((row) => row?.enabled === true)) {
        await requestLocalApi(
          `/api/smart-reply/local/rules/${encodeURIComponent(text(rule.rule_id))}/enabled`,
          { method: 'POST', body: { enabled: false } },
        );
        disabledRuleIds.push(text(rule.rule_id));
      }
    }
    const saved = await requestLocalApi('/api/smart-reply/mode', {
      method: 'POST',
      body: { mode: next },
    });
    const mode = saved?.mode === SMART_REPLY_EXECUTION_MODES.local
      ? SMART_REPLY_EXECUTION_MODES.local
      : SMART_REPLY_EXECUTION_MODES.cloud;
    return { mode, warning: mode === SMART_REPLY_EXECUTION_MODES.local ? warning : '' };
  } catch (error) {
    for (const ruleId of disabledRuleIds) {
      try {
        if (previous === SMART_REPLY_EXECUTION_MODES.cloud) {
          await setSmartReplyRuleEnabled(ruleId, true);
        } else {
          await requestLocalApi(
            `/api/smart-reply/local/rules/${encodeURIComponent(ruleId)}/enabled`,
            { method: 'POST', body: { enabled: true } },
          );
        }
      } catch {
        // Keep the original mode-switch error. Disabled rules are safer than duplicate sending.
      }
    }
    throw error;
  }
}

export async function loadSmartReplyAutomation(mode = SMART_REPLY_EXECUTION_MODES.cloud) {
  const source = mode === SMART_REPLY_EXECUTION_MODES.local
    ? await loadLocalSmartReplyAutomation()
    : await loadCloudSmartReplyAutomation();
  const { runtime, credentials, rules, tasks } = source;
  return {
    runtime: {
      mode: text(runtime?.mode) || mode,
      workerRunning: runtime?.worker_running === true,
      callbackConfigured: runtime?.callback_configured === true,
      pollingActive: runtime?.polling_active === true,
      configuredShopCount: Number(runtime?.configured_shop_count) || 0,
      enabledRuleCount: Number(runtime?.enabled_rule_count) || 0,
      pendingTaskCount: Number(runtime?.pending_task_count) || 0,
      lastScanAt: text(runtime?.last_scan_at),
      lastSuccessAt: text(runtime?.last_success_at),
      lastErrorCode: text(runtime?.last_error_code),
      lastErrorMessage: text(runtime?.last_error_message),
    },
    credentials: (Array.isArray(credentials) ? credentials : []).map(normalizeCredential),
    rules: (Array.isArray(rules) ? rules : []).map(normalizeRule),
    tasks: (Array.isArray(tasks?.items) ? tasks.items : []).map(normalizeTask),
    taskTotal: Number(tasks?.total) || 0,
  };
}

export async function connectSmartReplyShop({ shopId, clientId }) {
  return normalizeCredential(await syncBoundSmartReplyShopCredential({ shopId, clientId }));
}

export async function persistSmartReplyRule(input = {}, mode = SMART_REPLY_EXECUTION_MODES.cloud) {
  const payload = {
      ...(input.ruleId ? { rule_id: text(input.ruleId) } : {}),
      scene: text(input.scene),
      shop_client_ids: Array.isArray(input.shopClientIds)
        ? input.shopClientIds.map(text).filter(Boolean)
        : [],
      send_time_type: input.sendTimeType === 'delayed' ? 'delayed' : 'immediate',
      delay_hours: input.sendTimeType === 'delayed' ? Math.max(1, Number(input.delayHours) || 1) : 0,
      content_generate_type: 'template',
      template_id: text(input.templateId),
      message_template: text(input.messageTemplate),
      message_template_zh: text(input.messageTemplateZh),
      enabled: input.enabled === true,
    };
  const saved = mode === SMART_REPLY_EXECUTION_MODES.local
    ? await requestLocalApi('/api/smart-reply/local/rules', { method: 'POST', body: payload })
    : await saveSmartReplyRule(payload);
  return normalizeRule(saved);
}

export async function toggleSmartReplyRule(ruleId, enabled, mode = SMART_REPLY_EXECUTION_MODES.cloud) {
  const saved = mode === SMART_REPLY_EXECUTION_MODES.local
    ? await requestLocalApi(
        `/api/smart-reply/local/rules/${encodeURIComponent(text(ruleId))}/enabled`,
        { method: 'POST', body: { enabled: enabled === true } },
      )
    : await setSmartReplyRuleEnabled(ruleId, enabled);
  return normalizeRule(saved);
}

export async function retryFailedSmartReplyTask(taskId, mode = SMART_REPLY_EXECUTION_MODES.cloud) {
  if (mode === SMART_REPLY_EXECUTION_MODES.local) {
    return requestLocalApi(
      `/api/smart-reply/local/tasks/${encodeURIComponent(text(taskId))}/retry`,
      { method: 'POST', body: {} },
    );
  }
  return retrySmartReplyTask(taskId);
}

export const smartReplyTaskStatusLabels = Object.freeze({
  pending: '等待执行',
  retry_wait: '等待重试',
  processing: '正在核对订单',
  opening_chat: '正在打开会话',
  sending: '正在发送',
  sent_pending_readback: '已提交，等待回读',
  readback_processing: '正在确认发送结果',
  sent: '发送成功',
  sent_unconfirmed: '已提交，回读未确认',
  failed: '发送失败',
  manual_review: '需要人工确认',
  skipped: '状态变化，已跳过',
  cancelled: '规则关闭，已取消',
});
