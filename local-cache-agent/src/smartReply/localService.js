import crypto from 'node:crypto';
import {
  SMART_REPLY_SCENE_VALUES,
  detectTriggerScene,
  missingTemplateVariables,
  postingNumber,
  postingObservedAt,
  postingVariables,
  renderTemplate,
  text,
} from './contract.js';
import {
  historyConfirmsMessage,
  SmartReplyOzonClient,
  SmartReplyOzonError,
} from './ozonClient.js';

const MODE_NAMESPACE = 'smart-reply-runtime';
const MODE_KEY = 'execution-mode';
const RULE_NAMESPACE = 'smart-reply-local-rules';
const TASK_NAMESPACE = 'smart-reply-local-tasks';
const OBSERVATION_NAMESPACE = 'smart-reply-local-observations';
const HINT_NAMESPACE = 'smart-reply-local-hints';
const ENTITLEMENT_NAMESPACE = 'smart-reply-shop-entitlements';
const ENTITLEMENT_KEY = 'current';
const LOCAL_MODE = 'local';
const CLOUD_MODE = 'cloud';
const TASK_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const READBACK_DELAY_MS = 5 * 60_000;
const OBSERVATION_DAYS = 30;
const FALLBACK_FULL_SCAN_INTERVAL_MS = 5 * 60_000;

function nowIso(now) {
  return now().toISOString();
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function fail(code, message, status = 400) {
  throw Object.assign(new Error(message || code), { code, status });
}

function taskKey(clientId, postingNumberValue, scene) {
  return `slt_${crypto.createHash('sha256')
    .update(`${clientId}\0${postingNumberValue}\0${scene}`)
    .digest('hex')}`;
}

function observationKey(clientId, postingNumberValue) {
  return `slo_${crypto.createHash('sha256')
    .update(`${clientId}\0${postingNumberValue}`)
    .digest('hex')}`;
}

function publicRule(rule = {}) {
  return {
    rule_id: rule.ruleId,
    scene: rule.scene,
    shop_client_ids: [...(rule.shopClientIds || [])],
    send_time_type: rule.sendTimeType,
    delay_hours: Number(rule.delayHours) || 0,
    content_generate_type: 'template',
    template_id: rule.templateId,
    message_template: rule.messageTemplate,
    message_template_zh: rule.messageTemplateZh,
    enabled: rule.enabled === true,
    created_at: rule.createdAt,
    updated_at: rule.updatedAt,
  };
}

function publicTask(task = {}) {
  return {
    task_id: task.taskId,
    rule_id: task.ruleId,
    client_id: task.clientId,
    shop_name: task.shopName,
    posting_number: task.postingNumber,
    scene: task.scene,
    trigger_status: task.triggerStatus,
    scheduled_for: task.scheduledFor,
    status: task.status,
    attempts: Number(task.attempts) || 0,
    chat_id: task.chatId || '',
    ozon_message_id: task.messageId || '',
    sent_at: task.sentAt || '',
    last_error_code: task.lastErrorCode || '',
    last_error_message: task.lastErrorMessage || '',
    created_at: task.createdAt,
  };
}

function entitlementRows(store, scopeId) {
  const payload = store.getRecord({
    scopeId,
    namespace: ENTITLEMENT_NAMESPACE,
    key: ENTITLEMENT_KEY,
  })?.payload;
  return Array.isArray(payload?.grants) ? payload.grants : [];
}

function clientIsEntitled(store, scopeId, clientId, now) {
  const normalizedClientId = text(clientId);
  const timestamp = now().getTime();
  return entitlementRows(store, scopeId).some((grant) => (
    text(grant?.clientId, grant?.client_id) === normalizedClientId
    && parseTimestamp(grant?.expireAt ?? grant?.expire_at) > timestamp
  ));
}

function publicCredential(shop = {}, entitled = false) {
  const hasCredential = Boolean(shop.clientId && shop.apiKey);
  const locallyActive = shop.status !== 'disabled' && shop.status !== 'error';
  return {
    client_id: text(shop.clientId),
    shop_name: text(shop.alias, shop.name, shop.clientId),
    configured: hasCredential && locallyActive && entitled,
    status: !entitled
      ? 'authorization_expired'
      : locallyActive
        ? 'active'
        : shop.status,
    last_verified_at: text(shop.updatedAt, shop.boundAt),
  };
}

function routeSupported(method, pathname) {
  if (pathname === '/api/smart-reply/mode') return ['GET', 'POST'].includes(method);
  if (pathname === '/api/smart-reply/local/status') return method === 'GET';
  if (pathname === '/api/smart-reply/local/credentials') return method === 'GET';
  if (pathname === '/api/smart-reply/local/rules') return ['GET', 'POST'].includes(method);
  if (/^\/api\/smart-reply\/local\/rules\/[^/]+\/enabled$/u.test(pathname)) return method === 'POST';
  if (pathname === '/api/smart-reply/local/tasks') return method === 'GET';
  if (pathname === '/v1/internal/smart-reply/notification-hints') return method === 'POST';
  if (pathname === '/v1/internal/smart-reply/shop-entitlements') return method === 'POST';
  if (/^\/api\/smart-reply\/local\/tasks\/[^/]+\/retry$/u.test(pathname)) return method === 'POST';
  return false;
}

function shopRows(store, scopeId) {
  return store.listRecords({ scopeId, namespace: 'shops', limit: 1000 }).map((record) => record.payload || {});
}

function ruleRows(store, scopeId) {
  return store.listRecords({ scopeId, namespace: RULE_NAMESPACE, limit: 1000 })
    .map((record) => record.payload || {})
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

function taskRows(store, scopeId) {
  return store.listRecords({ scopeId, namespace: TASK_NAMESPACE, limit: 1000 })
    .map((record) => record.payload || {})
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

function currentMode(store, scopeId) {
  const mode = text(store.getRecord({ scopeId, namespace: MODE_NAMESPACE, key: MODE_KEY })?.payload?.mode);
  return mode === LOCAL_MODE ? LOCAL_MODE : CLOUD_MODE;
}

function saveMode(store, scopeId, mode, now) {
  const normalized = mode === LOCAL_MODE ? LOCAL_MODE : CLOUD_MODE;
  const record = { mode: normalized, updatedAt: nowIso(now) };
  store.putRecord({ scopeId, namespace: MODE_NAMESPACE, key: MODE_KEY, payload: record });
  return record;
}

function saveTask(store, scopeId, task, now) {
  const saved = { ...task, updatedAt: nowIso(now) };
  store.putRecord({ scopeId, namespace: TASK_NAMESPACE, key: saved.taskId, payload: saved });
  return saved;
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail('SMART_REPLY_LOCAL_PATH_INVALID', '智能回复请求地址无效。');
  }
}

export function createLocalSmartReplyService({
  store,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  pollIntervalMs = 30_000,
  ozonClientFactory,
} = {}) {
  if (!store) throw new Error('SMART_REPLY_LOCAL_STORE_REQUIRED');
  const runtimeByScope = new Map();
  let interval = null;
  let startTimer = null;
  let cyclePromise = null;
  let cycleRerunRequested = false;
  let abortController = null;
  let stopping = false;
  const forceFullScanScopes = new Set();

  function queueCycle() {
    if (stopping) return;
    if (cyclePromise) {
      cycleRerunRequested = true;
      return;
    }
    queueMicrotask(() => {
      if (stopping) return;
      if (cyclePromise) {
        cycleRerunRequested = true;
        return;
      }
      void runCycle();
    });
  }

  const createOzonClient = (shop, signal) => (
    ozonClientFactory
      ? ozonClientFactory({ shop, signal })
      : new SmartReplyOzonClient({
          clientId: shop.clientId,
          apiKey: shop.apiKey,
          fetchImpl,
          signal,
        })
  );

  function runtime(scopeId) {
    return runtimeByScope.get(scopeId) || {
      lastScanAt: '',
      lastSuccessAt: '',
      lastErrorCode: '',
      lastErrorMessage: '',
      scanning: false,
      lastFullScanAt: '',
    };
  }

  function setRuntime(scopeId, patch) {
    runtimeByScope.set(scopeId, { ...runtime(scopeId), ...patch });
  }

  function cancelPendingTasks(scopeId, ruleId) {
    for (const task of taskRows(store, scopeId)) {
      if (task.ruleId !== ruleId) continue;
      if (!['pending', 'retry_wait', 'processing'].includes(task.status) || task.sendSubmittedAt) continue;
      saveTask(store, scopeId, {
        ...task,
        status: 'cancelled',
        retryAt: '',
        lastErrorCode: 'SMART_REPLY_RULE_DISABLED',
        lastErrorMessage: '用户已关闭这条规则，任务没有发送。',
      }, now);
    }
  }

  function normalizeRule(scopeId, payload = {}, existing = null) {
    const scene = text(payload.scene, existing?.scene);
    if (!SMART_REPLY_SCENE_VALUES.has(scene)) fail('SMART_REPLY_SCENE_INVALID', '请选择有效的智能回复场景。');
    const selectedClientIds = [...new Set(
      (Array.isArray(payload.shop_client_ids) ? payload.shop_client_ids : payload.shopClientIds || existing?.shopClientIds || [])
        .map((value) => text(value))
        .filter(Boolean),
    )];
    if (!selectedClientIds.length) fail('SMART_REPLY_SHOP_REQUIRED', '请至少选择一个店铺。');
    const shops = shopRows(store, scopeId);
    const byClientId = new Map(shops.filter((shop) => shop.clientId).map((shop) => [text(shop.clientId), shop]));
    const selectedShops = selectedClientIds.map((clientId) => byClientId.get(clientId));
    if (selectedShops.some((shop) => !shop)) fail('SMART_REPLY_SHOP_NOT_FOUND', '所选店铺已不存在，请重新选择。', 404);
    if (selectedShops.some((shop) => !shop.clientId || !shop.apiKey || shop.status === 'disabled')) {
      fail('SMART_REPLY_SHOP_CREDENTIALS_REQUIRED', '所选店铺缺少有效的 Ozon API 授权。', 409);
    }
    if (selectedShops.some((shop) => !clientIsEntitled(store, scopeId, shop.clientId, now))) {
      fail(
        'SMART_REPLY_SHOP_LICENSE_INACTIVE',
        '所选店铺的软件授权无效或已到期，请先续费对应店铺。',
        403,
      );
    }
    const timestamp = nowIso(now);
    const sendTimeType = text(payload.send_time_type, payload.sendTimeType, existing?.sendTimeType) === 'delayed'
      ? 'delayed'
      : 'immediate';
    const delayHours = sendTimeType === 'delayed'
      ? Math.min(72, Math.max(1, Number(payload.delay_hours ?? payload.delayHours ?? existing?.delayHours) || 1))
      : 0;
    const enabled = payload.enabled === true;
    const messageTemplate = text(payload.message_template, payload.messageTemplate, existing?.messageTemplate);
    if (!messageTemplate || messageTemplate.length > 500) {
      fail('SMART_REPLY_TEMPLATE_INVALID', '消息模板为空或超过 500 个字符。', 422);
    }
    const messageTemplateZh = text(
      payload.message_template_zh,
      payload.messageTemplateZh,
      existing?.messageTemplateZh,
    );
    if (messageTemplateZh.length > 500) {
      fail('SMART_REPLY_TEMPLATE_ZH_INVALID', '中文翻译不能超过 500 个字符。', 422);
    }
    return {
      ruleId: text(payload.rule_id, payload.ruleId, existing?.ruleId) || `slr_${crypto.randomUUID()}`,
      scene,
      shopIds: selectedShops.map((shop) => text(shop.id)),
      shopClientIds: selectedClientIds,
      sendTimeType,
      delayHours,
      contentGenerateType: 'template',
      templateId: text(payload.template_id, payload.templateId, existing?.templateId),
      messageTemplate,
      messageTemplateZh,
      enabled,
      enabledAt: enabled && existing?.enabled !== true ? timestamp : existing?.enabledAt || '',
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
  }

  function createTask(scopeId, { rule, shop, posting, scene, triggerStatus }) {
    const number = postingNumber(posting);
    if (!number) return null;
    const key = taskKey(shop.clientId, number, scene);
    if (store.getRecord({ scopeId, namespace: TASK_NAMESPACE, key })) return null;
    const createdAt = nowIso(now);
    const scheduledFor = new Date(
      now().getTime() + (rule.sendTimeType === 'delayed' ? rule.delayHours * 3_600_000 : 0),
    ).toISOString();
    const task = {
      taskId: key,
      idempotencyKey: `${shop.clientId}:${number}:${scene}`,
      ruleId: rule.ruleId,
      shopId: shop.id,
      clientId: shop.clientId,
      shopName: text(shop.alias, shop.name, shop.clientId),
      postingNumber: number,
      scene,
      triggerStatus: triggerStatus || 'unknown',
      scheduledFor,
      status: 'pending',
      attempts: 0,
      readbackAttempts: 0,
      retryAt: '',
      chatId: '',
      messageId: '',
      renderedMessage: '',
      sendSubmittedAt: '',
      sentAt: '',
      lastErrorCode: '',
      lastErrorMessage: '',
      templateSnapshot: {
        templateId: rule.templateId,
        messageTemplate: rule.messageTemplate,
        messageTemplateZh: rule.messageTemplateZh,
      },
      createdAt,
      updatedAt: createdAt,
    };
    store.putRecord({ scopeId, namespace: TASK_NAMESPACE, key, payload: task });
    return task;
  }

  async function scanShop(scopeId, shop, rules, signal) {
    const client = createOzonClient(shop, signal);
    const to = now();
    const since = new Date(to.getTime() - OBSERVATION_DAYS * 86_400_000);
    const postings = await client.listRecentPostings({ since: since.toISOString(), to: to.toISOString(), limit: 300 });
    let created = 0;
    for (const posting of postings) {
      const number = postingNumber(posting);
      if (!number) continue;
      const detected = detectTriggerScene(posting);
      const key = observationKey(shop.clientId, number);
      const previous = store.getRecord({ scopeId, namespace: OBSERVATION_NAMESPACE, key })?.payload || null;
      const observedAt = nowIso(now);
      const observation = {
        clientId: shop.clientId,
        shopId: shop.id,
        postingNumber: number,
        scene: detected.scene,
        triggerStatus: detected.triggerStatus,
        sourceObservedAt: postingObservedAt(posting),
        observedAt,
      };
      store.putRecord({ scopeId, namespace: OBSERVATION_NAMESPACE, key, payload: observation });
      if (!detected.scene) continue;
      const matchingRule = rules.find((rule) => (
        rule.scene === detected.scene
        && rule.enabled === true
        && rule.shopIds.includes(shop.id)
      ));
      if (!matchingRule) continue;
      const changed = Boolean(previous) && (
        previous.scene !== detected.scene || previous.triggerStatus !== detected.triggerStatus
      );
      const sourceTimestamp = parseTimestamp(observation.sourceObservedAt);
      const firstObservedAfterEnable = !previous
        && sourceTimestamp > 0
        && sourceTimestamp >= parseTimestamp(matchingRule.enabledAt);
      if (!changed && !firstObservedAfterEnable) continue;
      if (createTask(scopeId, {
        rule: matchingRule,
        shop,
        posting,
        scene: detected.scene,
        triggerStatus: detected.triggerStatus,
      })) created += 1;
    }
    return { observed: postings.length, created };
  }

  async function scanScope(scopeId, signal) {
    if (currentMode(store, scopeId) !== LOCAL_MODE) return { observed: 0, created: 0 };
    const rules = ruleRows(store, scopeId).filter((rule) => rule.enabled === true);
    if (!rules.length) return { observed: 0, created: 0 };
    const shops = shopRows(store, scopeId);
    const targetShopIds = new Set(rules.flatMap((rule) => rule.shopIds || []));
    const targets = shops.filter((shop) => (
      targetShopIds.has(shop.id)
      && shop.clientId
      && shop.apiKey
      && shop.status !== 'disabled'
      && clientIsEntitled(store, scopeId, shop.clientId, now)
    ));
    let observed = 0;
    let created = 0;
    let failed = 0;
    let lastErrorCode = '';
    let lastErrorMessage = '';
    for (const shop of targets) {
      if (signal.aborted) break;
      try {
        const result = await scanShop(scopeId, shop, rules, signal);
        observed += result.observed;
        created += result.created;
      } catch (error) {
        failed += 1;
        lastErrorCode = text(error?.code) || 'SMART_REPLY_LOCAL_SCAN_FAILED';
        lastErrorMessage = text(error?.message) || '本地订单状态监听失败。';
      }
    }
    return { observed, created, failed, lastErrorCode, lastErrorMessage };
  }

  function notificationHintPostingNumber(row = {}) {
    return text(
      row.postingNumber,
      row.posting_number,
      row.orderNumber,
      row.order_number,
      row.payload?.posting_number,
      row.payload?.postingNumber,
    ).slice(0, 160);
  }

  function notificationHintShop(shops, row = {}) {
    const localShopId = text(row.shopId, row.shop_id);
    const clientId = text(row.clientId, row.client_id, row.sellerId, row.seller_id);
    return shops.find((shop) => (
      (localShopId && (
        text(shop.id) === localShopId
        || text(shop.clientId) === localShopId
      ))
      || (clientId && text(shop.clientId) === clientId)
    )) || null;
  }

  async function drainNotificationHints(scopeId, signal) {
    const hints = store.listRecords({ scopeId, namespace: HINT_NAMESPACE, limit: 200 });
    if (!hints.length) return { processed: 0, failed: 0, lastErrorCode: '', lastErrorMessage: '' };
    const rules = ruleRows(store, scopeId).filter((rule) => rule.enabled === true);
    const shops = shopRows(store, scopeId);
    let processed = 0;
    let failed = 0;
    let lastErrorCode = '';
    let lastErrorMessage = '';
    for (const record of hints) {
      if (signal.aborted) break;
      const hint = record.payload || {};
      const number = notificationHintPostingNumber(hint.notification);
      const shop = notificationHintShop(shops, hint.notification);
      if (
        !number
        || !shop?.clientId
        || !shop?.apiKey
        || !clientIsEntitled(store, scopeId, shop.clientId, now)
        || !rules.some((rule) => rule.shopIds?.includes(shop.id))
      ) {
        store.deleteRecord({ scopeId, namespace: HINT_NAMESPACE, key: record.key });
        continue;
      }
      try {
        const client = createOzonClient(shop, signal);
        const { posting } = await client.readPosting(number);
        const detected = detectTriggerScene(posting);
        const rule = rules.find((row) => row.scene === detected.scene && row.shopIds?.includes(shop.id));
        const notificationAt = parseTimestamp(
          hint.notification?.createdAt
          || hint.notification?.receivedAt
          || hint.notification?.created_at
          || hint.receivedAt,
        );
        if (rule && (!notificationAt || notificationAt >= parseTimestamp(rule.enabledAt))) {
          createTask(scopeId, {
            rule,
            shop,
            posting,
            scene: detected.scene,
            triggerStatus: detected.triggerStatus,
          });
        }
        store.putRecord({
          scopeId,
          namespace: OBSERVATION_NAMESPACE,
          key: observationKey(shop.clientId, number),
          payload: {
            clientId: shop.clientId,
            shopId: shop.id,
            postingNumber: number,
            scene: detected.scene,
            triggerStatus: detected.triggerStatus,
            sourceObservedAt: postingObservedAt(posting),
            observedAt: nowIso(now),
          },
        });
        store.deleteRecord({ scopeId, namespace: HINT_NAMESPACE, key: record.key });
        processed += 1;
      } catch (error) {
        if (signal.aborted) break;
        const attempts = (Number(hint.attempts) || 0) + 1;
        if (attempts >= 3 || error?.retryable !== true) {
          store.deleteRecord({ scopeId, namespace: HINT_NAMESPACE, key: record.key });
        } else {
          store.putRecord({
            scopeId,
            namespace: HINT_NAMESPACE,
            key: record.key,
            payload: {
              ...hint,
              attempts,
              lastErrorCode: text(error?.code),
              lastErrorMessage: text(error?.message),
              updatedAt: nowIso(now),
            },
          });
        }
        failed += 1;
        lastErrorCode = text(error?.code) || 'SMART_REPLY_LOCAL_NOTIFICATION_CHECK_FAILED';
        lastErrorMessage = text(error?.message) || '消息提醒到达后的订单复核失败。';
      }
    }
    return { processed, failed, lastErrorCode, lastErrorMessage };
  }

  function taskError(scopeId, task, error) {
    if (abortController?.signal.aborted) return task;
    const current = store.getRecord({ scopeId, namespace: TASK_NAMESPACE, key: task.taskId })?.payload;
    if (current?.status === 'cancelled') return current;
    const attempts = Number(task.attempts) || 1;
    const retryable = error?.retryable === true && attempts <= TASK_RETRY_DELAYS_MS.length;
    const retryDelay = TASK_RETRY_DELAYS_MS[Math.max(0, attempts - 1)] || 0;
    return saveTask(store, scopeId, {
      ...task,
      status: error?.ambiguousWrite === true ? 'manual_review' : retryable ? 'retry_wait' : 'failed',
      retryAt: retryable ? new Date(now().getTime() + retryDelay).toISOString() : '',
      lastErrorCode: text(error?.code) || 'SMART_REPLY_LOCAL_EXECUTION_FAILED',
      lastErrorMessage: text(error?.message) || '本地自动发送任务失败。',
    }, now);
  }

  async function confirmReadback(scopeId, task, shop, signal) {
    const next = saveTask(store, scopeId, {
      ...task,
      status: 'readback_processing',
      readbackAttempts: (Number(task.readbackAttempts) || 0) + 1,
    }, now);
    try {
      const client = createOzonClient(shop, signal);
      const messages = await client.history(next.chatId);
      const confirmation = historyConfirmsMessage(messages, {
        messageId: next.messageId,
        message: next.renderedMessage,
      });
      if (confirmation.confirmed) {
        return saveTask(store, scopeId, {
          ...next,
          status: 'sent',
          messageId: confirmation.messageId,
          sentAt: nowIso(now),
          retryAt: '',
          lastErrorCode: '',
          lastErrorMessage: '',
        }, now);
      }
      const retry = next.readbackAttempts < 3;
      return saveTask(store, scopeId, {
        ...next,
        status: retry ? 'sent_pending_readback' : 'sent_unconfirmed',
        retryAt: retry ? new Date(now().getTime() + READBACK_DELAY_MS).toISOString() : '',
        lastErrorCode: 'SMART_REPLY_READBACK_NOT_FOUND',
        lastErrorMessage: 'Ozon 尚未在聊天记录中返回这条消息。',
      }, now);
    } catch (error) {
      if (signal.aborted) return next;
      const retry = next.readbackAttempts < 3;
      return saveTask(store, scopeId, {
        ...next,
        status: retry ? 'sent_pending_readback' : 'sent_unconfirmed',
        retryAt: retry ? new Date(now().getTime() + READBACK_DELAY_MS).toISOString() : '',
        lastErrorCode: text(error?.code) || 'SMART_REPLY_READBACK_FAILED',
        lastErrorMessage: text(error?.message) || '消息已提交，但暂时无法读取发送结果。',
      }, now);
    }
  }

  async function executeTask(scopeId, originalTask, signal) {
    if (currentMode(store, scopeId) !== LOCAL_MODE) return;
    const rules = ruleRows(store, scopeId);
    const rule = rules.find((row) => row.ruleId === originalTask.ruleId);
    if (!rule?.enabled || !rule.shopIds?.includes(originalTask.shopId)) {
      saveTask(store, scopeId, {
        ...originalTask,
        status: 'cancelled',
        retryAt: '',
        lastErrorCode: 'SMART_REPLY_RULE_DISABLED',
        lastErrorMessage: '规则已关闭或店铺已移出，任务没有发送。',
      }, now);
      return;
    }
    const shop = shopRows(store, scopeId).find((row) => row.id === originalTask.shopId);
    if (!shop?.clientId || !shop?.apiKey || shop.status === 'disabled') {
      taskError(scopeId, originalTask, new SmartReplyOzonError(
        'SMART_REPLY_SHOP_CREDENTIALS_REQUIRED',
        '当前店铺缺少有效的 Ozon API 授权。',
        { status: 409 },
      ));
      return;
    }
    if (!clientIsEntitled(store, scopeId, shop.clientId, now)) {
      saveTask(store, scopeId, {
        ...originalTask,
        status: 'cancelled',
        retryAt: '',
        lastErrorCode: 'SMART_REPLY_SHOP_LICENSE_INACTIVE',
        lastErrorMessage: '当前店铺的软件授权无效或已到期，任务没有发送。',
      }, now);
      return;
    }
    if (originalTask.status === 'sent_pending_readback') {
      await confirmReadback(scopeId, originalTask, shop, signal);
      return;
    }
    let task = saveTask(store, scopeId, {
      ...originalTask,
      status: 'processing',
      attempts: (Number(originalTask.attempts) || 0) + 1,
      retryAt: '',
    }, now);
    try {
      const client = createOzonClient(shop, signal);
      const { posting } = await client.readPosting(task.postingNumber);
      const current = detectTriggerScene(posting);
      if (current.scene !== task.scene) {
        saveTask(store, scopeId, {
          ...task,
          status: 'skipped',
          lastErrorCode: 'SMART_REPLY_TRIGGER_NO_LONGER_MATCHES',
          lastErrorMessage: '发送前复核发现订单状态已经变化，任务已跳过。',
        }, now);
        return;
      }
      if (task.scene === 'reviewRequest' && await client.hasReturnOrRefund(task.postingNumber)) {
        saveTask(store, scopeId, {
          ...task,
          status: 'skipped',
          lastErrorCode: 'SMART_REPLY_RETURN_OR_REFUND_EXISTS',
          lastErrorMessage: '订单已有退货或退款记录，没有发送索评消息。',
        }, now);
        return;
      }
      const template = text(task.templateSnapshot?.messageTemplate);
      const variables = postingVariables(posting, task.postingNumber);
      const missing = missingTemplateVariables(template, variables);
      if (missing.length) {
        throw new SmartReplyOzonError(
          'SMART_REPLY_ORDER_VARIABLES_NOT_READY',
          `订单数据尚未返回这些模板变量：${missing.join(', ')}。`,
          { retryable: true },
        );
      }
      const message = renderTemplate(template, variables);
      if (!message || message.length > 1000) {
        throw new SmartReplyOzonError('SMART_REPLY_RENDERED_MESSAGE_INVALID', '模板替换后的消息为空或超过 Ozon 长度限制。', { status: 422 });
      }
      const latestRule = ruleRows(store, scopeId).find((row) => row.ruleId === task.ruleId);
      const entitledBeforeChat = clientIsEntitled(store, scopeId, shop.clientId, now);
      if (
        currentMode(store, scopeId) !== LOCAL_MODE
        || !latestRule?.enabled
        || !latestRule.shopIds?.includes(task.shopId)
        || !entitledBeforeChat
      ) {
        saveTask(store, scopeId, {
          ...task,
          status: 'cancelled',
          retryAt: '',
          lastErrorCode: entitledBeforeChat
            ? 'SMART_REPLY_RULE_DISABLED'
            : 'SMART_REPLY_SHOP_LICENSE_INACTIVE',
          lastErrorMessage: entitledBeforeChat
            ? '发送前检查发现规则已关闭，任务没有发送。'
            : '发送前检查发现店铺授权已失效，任务没有发送。',
        }, now);
        return;
      }
      task = saveTask(store, scopeId, { ...task, status: 'opening_chat', renderedMessage: message }, now);
      const chatId = await client.startChat(task.postingNumber);
      const beforeSendRule = ruleRows(store, scopeId).find((row) => row.ruleId === task.ruleId);
      const stillEntitled = clientIsEntitled(store, scopeId, shop.clientId, now);
      if (
        currentMode(store, scopeId) !== LOCAL_MODE
        || !beforeSendRule?.enabled
        || !beforeSendRule.shopIds?.includes(task.shopId)
        || !stillEntitled
      ) {
        saveTask(store, scopeId, {
          ...task,
          status: 'cancelled',
          retryAt: '',
          chatId,
          lastErrorCode: stillEntitled
            ? 'SMART_REPLY_RULE_DISABLED'
            : 'SMART_REPLY_SHOP_LICENSE_INACTIVE',
          lastErrorMessage: stillEntitled
            ? '打开会话后规则已关闭，消息没有发送。'
            : '打开会话后店铺授权已失效，消息没有发送。',
        }, now);
        return;
      }
      task = saveTask(store, scopeId, { ...task, status: 'sending', chatId }, now);
      const messageId = await client.sendMessage(chatId, message);
      task = saveTask(store, scopeId, {
        ...task,
        status: 'sent_pending_readback',
        messageId,
        sendSubmittedAt: nowIso(now),
        retryAt: new Date(now().getTime() + READBACK_DELAY_MS).toISOString(),
      }, now);
      await confirmReadback(scopeId, task, shop, signal);
    } catch (error) {
      if (!signal.aborted) taskError(scopeId, task, error);
    }
  }

  async function drainTasks(scopeId, signal) {
    const timestamp = now().getTime();
    const due = taskRows(store, scopeId)
      .filter((task) => ['pending', 'retry_wait', 'sent_pending_readback'].includes(task.status))
      .filter((task) => parseTimestamp(task.scheduledFor) <= timestamp)
      .filter((task) => !task.retryAt || parseTimestamp(task.retryAt) <= timestamp)
      .sort((left, right) => parseTimestamp(left.scheduledFor) - parseTimestamp(right.scheduledFor))
      .slice(0, 20);
    for (const task of due) {
      if (signal.aborted) break;
      await executeTask(scopeId, task, signal);
    }
    return due.length;
  }

  function recoverInterruptedTasks() {
    for (const scopeId of store.listScopesByNamespace(TASK_NAMESPACE)) {
      for (const task of taskRows(store, scopeId)) {
        if (task.status === 'processing') {
          saveTask(store, scopeId, {
            ...task,
            status: 'retry_wait',
            retryAt: nowIso(now),
            lastErrorCode: 'SMART_REPLY_INTERRUPTED_BEFORE_WRITE',
            lastErrorMessage: '发送前检查被中断，任务已安全恢复。',
          }, now);
        } else if (['opening_chat', 'sending'].includes(task.status)) {
          saveTask(store, scopeId, {
            ...task,
            status: 'manual_review',
            retryAt: '',
            lastErrorCode: 'SMART_REPLY_INTERRUPTED_DURING_WRITE',
            lastErrorMessage: '发送阶段被中断，为避免重复消息，已停止自动重试。',
          }, now);
        } else if (task.status === 'readback_processing') {
          saveTask(store, scopeId, {
            ...task,
            status: 'sent_pending_readback',
            retryAt: nowIso(now),
            lastErrorCode: 'SMART_REPLY_READBACK_INTERRUPTED',
            lastErrorMessage: '消息已提交，发送结果将继续确认。',
          }, now);
        }
      }
    }
  }

  async function runCycle() {
    if (cyclePromise) return cyclePromise;
    abortController = new AbortController();
    cyclePromise = (async () => {
      const scopes = new Set([
        ...store.listScopesByNamespace(RULE_NAMESPACE),
        ...store.listScopesByNamespace(TASK_NAMESPACE),
        ...store.listScopesByNamespace(HINT_NAMESPACE),
      ]);
      for (const scopeId of scopes) {
        if (abortController.signal.aborted || currentMode(store, scopeId) !== LOCAL_MODE) continue;
        const scanStartedAt = nowIso(now);
        setRuntime(scopeId, { scanning: true, lastScanAt: scanStartedAt });
        try {
          const hintResult = await drainNotificationHints(scopeId, abortController.signal);
          const currentRuntime = runtime(scopeId);
          const shouldRunFallbackScan = forceFullScanScopes.has(scopeId)
            || !currentRuntime.lastFullScanAt
            || now().getTime() - parseTimestamp(currentRuntime.lastFullScanAt) >= FALLBACK_FULL_SCAN_INTERVAL_MS;
          let scanResult = { failed: 0, lastErrorCode: '', lastErrorMessage: '' };
          if (shouldRunFallbackScan) {
            scanResult = await scanScope(scopeId, abortController.signal);
            forceFullScanScopes.delete(scopeId);
            setRuntime(scopeId, { lastFullScanAt: nowIso(now) });
          }
          await drainTasks(scopeId, abortController.signal);
          if (!abortController.signal.aborted) {
            const cycleFailure = scanResult.failed
              ? scanResult
              : hintResult.failed
                ? hintResult
                : !shouldRunFallbackScan && currentRuntime.lastErrorCode
                  ? currentRuntime
                  : null;
            setRuntime(scopeId, cycleFailure
              ? {
                  scanning: false,
                  lastErrorCode: cycleFailure.lastErrorCode,
                  lastErrorMessage: cycleFailure.lastErrorMessage,
                }
              : {
                  scanning: false,
                  lastSuccessAt: nowIso(now),
                  lastErrorCode: '',
                  lastErrorMessage: '',
                });
          }
        } catch (error) {
          if (!abortController.signal.aborted) {
            setRuntime(scopeId, {
              scanning: false,
              lastErrorCode: text(error?.code) || 'SMART_REPLY_LOCAL_CYCLE_FAILED',
              lastErrorMessage: text(error?.message) || '本地自动发送轮询失败。',
            });
          }
        }
      }
    })().finally(() => {
      cyclePromise = null;
      abortController = null;
      if (cycleRerunRequested && !stopping) {
        cycleRerunRequested = false;
        queueCycle();
      }
    });
    return cyclePromise;
  }

  async function handle({ method, pathname, searchParams, payload, scopeId }) {
    if (!routeSupported(method, pathname)) return { handled: false };
    if (pathname === '/api/smart-reply/mode') {
      if (method === 'GET') {
        return { handled: true, status: 200, payload: { ok: true, mode: currentMode(store, scopeId) } };
      }
      const mode = text(payload?.mode);
      if (![LOCAL_MODE, CLOUD_MODE].includes(mode)) fail('SMART_REPLY_MODE_INVALID', '请选择本地模式或云端模式。');
      const saved = saveMode(store, scopeId, mode, now);
      if (mode === LOCAL_MODE) {
        // Switching to local mode is the user's explicit instruction to let
        // this computer own monitoring. Start a cycle immediately instead of
        // waiting for the next polling interval.
        forceFullScanScopes.add(scopeId);
        setRuntime(scopeId, { lastFullScanAt: '' });
        queueCycle();
      } else {
        // Every send step rechecks the mode. Aborting also stops slow Ozon
        // reads promptly when the user hands ownership back to the cloud.
        forceFullScanScopes.delete(scopeId);
        cycleRerunRequested = false;
        abortController?.abort();
      }
      return { handled: true, status: 200, payload: { ok: true, ...saved } };
    }
    if (pathname === '/api/smart-reply/local/status') {
      const rules = ruleRows(store, scopeId);
      const tasks = taskRows(store, scopeId);
      const credentials = shopRows(store, scopeId).filter((shop) => (
        shop.clientId
        && shop.apiKey
        && shop.status !== 'disabled'
        && clientIsEntitled(store, scopeId, shop.clientId, now)
      ));
      const current = runtime(scopeId);
      return {
        handled: true,
        status: 200,
        payload: {
          ok: true,
          mode: LOCAL_MODE,
          worker_running: !stopping && Boolean(interval),
          callback_configured: false,
          polling_active: currentMode(store, scopeId) === LOCAL_MODE,
          configured_shop_count: credentials.length,
          enabled_rule_count: rules.filter((rule) => rule.enabled).length,
          pending_task_count: tasks.filter((task) => ['pending', 'retry_wait', 'processing', 'sent_pending_readback'].includes(task.status)).length,
          last_scan_at: current.lastScanAt,
          last_success_at: current.lastSuccessAt,
          last_error_code: current.lastErrorCode,
          last_error_message: current.lastErrorMessage,
        },
      };
    }
    if (pathname === '/api/smart-reply/local/credentials') {
      const rows = shopRows(store, scopeId)
        .filter((shop) => shop.clientId)
        .map((shop) => publicCredential(
          shop,
          clientIsEntitled(store, scopeId, shop.clientId, now),
        ));
      return { handled: true, status: 200, payload: rows };
    }
    if (pathname === '/api/smart-reply/local/rules') {
      if (method === 'GET') {
        return { handled: true, status: 200, payload: ruleRows(store, scopeId).map(publicRule) };
      }
      const requestedId = text(payload?.rule_id, payload?.ruleId);
      const existingRules = ruleRows(store, scopeId);
      const existing = existingRules.find((rule) => rule.ruleId === requestedId)
        || (!requestedId ? existingRules.find((rule) => rule.scene === text(payload?.scene)) : null);
      if (requestedId && !existing) fail('SMART_REPLY_RULE_NOT_FOUND', '没有找到这条本地智能回复规则。', 404);
      const rule = normalizeRule(scopeId, payload, existing);
      if (rule.enabled && currentMode(store, scopeId) !== LOCAL_MODE) {
        fail('SMART_REPLY_LOCAL_MODE_NOT_ACTIVE', '请先切换到本地模式，再开启本地自动发送。', 409);
      }
      store.putRecord({ scopeId, namespace: RULE_NAMESPACE, key: rule.ruleId, payload: rule });
      if (!rule.enabled) cancelPendingTasks(scopeId, rule.ruleId);
      if (rule.enabled) {
        forceFullScanScopes.add(scopeId);
        setRuntime(scopeId, { lastFullScanAt: '' });
        queueCycle();
      }
      return { handled: true, status: 200, payload: publicRule(rule) };
    }
    const enabledMatch = pathname.match(/^\/api\/smart-reply\/local\/rules\/([^/]+)\/enabled$/u);
    if (enabledMatch) {
      const ruleId = decodePathPart(enabledMatch[1]);
      const existing = ruleRows(store, scopeId).find((rule) => rule.ruleId === ruleId);
      if (!existing) fail('SMART_REPLY_RULE_NOT_FOUND', '没有找到这条本地智能回复规则。', 404);
      const enabled = payload?.enabled === true;
      if (enabled && currentMode(store, scopeId) !== LOCAL_MODE) {
        fail('SMART_REPLY_LOCAL_MODE_NOT_ACTIVE', '请先切换到本地模式，再开启本地自动发送。', 409);
      }
      // Enabling must re-run every shop/entitlement/template check. Disabling
      // must always remain available, even after a shop card has expired.
      const rule = enabled
        ? normalizeRule(scopeId, { enabled, rule_id: ruleId }, existing)
        : { ...existing, enabled: false, updatedAt: nowIso(now) };
      store.putRecord({ scopeId, namespace: RULE_NAMESPACE, key: rule.ruleId, payload: rule });
      if (!enabled) cancelPendingTasks(scopeId, rule.ruleId);
      if (enabled) {
        forceFullScanScopes.add(scopeId);
        setRuntime(scopeId, { lastFullScanAt: '' });
        queueCycle();
      }
      return { handled: true, status: 200, payload: publicRule(rule) };
    }
    if (pathname === '/api/smart-reply/local/tasks') {
      const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit')) || 100));
      const rows = taskRows(store, scopeId);
      return {
        handled: true,
        status: 200,
        payload: { items: rows.slice(0, limit).map(publicTask), total: rows.length },
      };
    }
    if (pathname === '/v1/internal/smart-reply/notification-hints') {
      const notifications = Array.isArray(payload?.notifications) ? payload.notifications.slice(0, 100) : [];
      if (currentMode(store, scopeId) !== LOCAL_MODE || !notifications.length) {
        return { handled: true, status: 200, payload: { ok: true, accepted: 0 } };
      }
      let accepted = 0;
      for (const notification of notifications) {
        if (!notification || typeof notification !== 'object') continue;
        const number = notificationHintPostingNumber(notification);
        if (!number) continue;
        const identity = text(notification.id) || crypto.createHash('sha256')
          .update(JSON.stringify(notification))
          .digest('hex');
        const key = `slh_${crypto.createHash('sha256').update(identity).digest('hex')}`;
        if (store.getRecord({ scopeId, namespace: HINT_NAMESPACE, key })) continue;
        store.putRecord({
          scopeId,
          namespace: HINT_NAMESPACE,
          key,
          payload: {
            notification: structuredClone(notification),
            attempts: 0,
            receivedAt: nowIso(now),
            updatedAt: nowIso(now),
          },
        });
        accepted += 1;
      }
      if (accepted) queueCycle();
      return { handled: true, status: 200, payload: { ok: true, accepted } };
    }
    if (pathname === '/v1/internal/smart-reply/shop-entitlements') {
      const grants = (Array.isArray(payload?.grants) ? payload.grants : [])
        .slice(0, 1000)
        .map((grant) => ({
          clientId: text(grant?.clientId, grant?.client_id),
          expireAt: text(grant?.expireAt, grant?.expire_at),
        }))
        .filter((grant) => grant.clientId && parseTimestamp(grant.expireAt) > 0);
      store.putRecord({
        scopeId,
        namespace: ENTITLEMENT_NAMESPACE,
        key: ENTITLEMENT_KEY,
        payload: {
          grants,
          updatedAt: nowIso(now),
        },
      });
      return {
        handled: true,
        status: 200,
        payload: { ok: true, count: grants.length },
      };
    }
    const retryMatch = pathname.match(/^\/api\/smart-reply\/local\/tasks\/([^/]+)\/retry$/u);
    if (retryMatch) {
      const taskId = decodePathPart(retryMatch[1]);
      const task = store.getRecord({ scopeId, namespace: TASK_NAMESPACE, key: taskId })?.payload;
      if (!task) fail('SMART_REPLY_TASK_NOT_FOUND', '没有找到这条本地发送任务。', 404);
      if (task.status !== 'failed') fail('SMART_REPLY_TASK_RETRY_FORBIDDEN', '只有明确失败且未发送的任务才能重试。', 409);
      const saved = saveTask(store, scopeId, {
        ...task,
        status: 'pending',
        attempts: 0,
        retryAt: '',
        scheduledFor: nowIso(now),
        lastErrorCode: '',
        lastErrorMessage: '',
      }, now);
      return { handled: true, status: 200, payload: { ok: true, task: publicTask(saved) } };
    }
    return { handled: false };
  }

  function start() {
    if (interval || startTimer) return;
    stopping = false;
    recoverInterruptedTasks();
    startTimer = setTimeout(() => {
      startTimer = null;
      void runCycle();
    }, 1_500);
    startTimer.unref?.();
    interval = setInterval(() => void runCycle(), Math.max(5_000, Number(pollIntervalMs) || 30_000));
    interval.unref?.();
  }

  async function stop() {
    stopping = true;
    if (startTimer) clearTimeout(startTimer);
    if (interval) clearInterval(interval);
    startTimer = null;
    interval = null;
    abortController?.abort();
    await cyclePromise?.catch(() => undefined);
  }

  return Object.freeze({
    supports(method, pathname) {
      return routeSupported(String(method || '').toUpperCase(), String(pathname || ''));
    },
    handle,
    runCycle,
    start,
    stop,
  });
}

export const localSmartReplyNamespaces = Object.freeze({
  mode: MODE_NAMESPACE,
  rules: RULE_NAMESPACE,
  tasks: TASK_NAMESPACE,
  observations: OBSERVATION_NAMESPACE,
  hints: HINT_NAMESPACE,
});
