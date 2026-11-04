import React from 'react';
import {
  changeSmartReplyExecutionMode,
  connectSmartReplyShop,
  loadSmartReplyAutomation,
  persistSmartReplyRule,
  readSmartReplyExecutionMode,
  retryFailedSmartReplyTask,
  SMART_REPLY_EXECUTION_MODES,
  toggleSmartReplyRule,
} from '../services/smartReplyAutomationService.js';

const EMPTY_RUNTIME = Object.freeze({
  mode: 'server',
  workerRunning: false,
  callbackConfigured: false,
  pollingActive: false,
  configuredShopCount: 0,
  enabledRuleCount: 0,
  pendingTaskCount: 0,
  lastScanAt: '',
  lastSuccessAt: '',
  lastErrorCode: '',
  lastErrorMessage: '',
});

function text(value) {
  return String(value || '').trim();
}

function shopClientId(shop = {}) {
  return text(shop.clientId || shop.client_id);
}

export function useSmartReplyAutomation({
  activeShopId = '',
  enabled = false,
  scene = '',
  selectedTemplate = null,
  shops = [],
} = {}) {
  const [state, setState] = React.useState({
    status: 'idle',
    runtime: EMPTY_RUNTIME,
    credentials: [],
    rules: [],
    tasks: [],
    taskTotal: 0,
    error: '',
    notice: '',
  });
  const [form, setForm] = React.useState({
    shopClientIds: [],
    sendTimeType: 'immediate',
    delayHours: 1,
  });
  const [busyAction, setBusyAction] = React.useState('');
  const [executionMode, setExecutionModeState] = React.useState(SMART_REPLY_EXECUTION_MODES.cloud);
  const executionModeRef = React.useRef(SMART_REPLY_EXECUTION_MODES.cloud);

  const shopOptions = React.useMemo(
    () =>
      (Array.isArray(shops) ? shops : [])
        .map((shop) => ({
          id: text(shop.id),
          clientId: shopClientId(shop),
          name: text(shop.shopAlias || shop.alias || shop.sellerName || shop.name || shopClientId(shop)),
        }))
        .filter((shop) => shop.clientId),
    [shops]
  );
  const activeClientId = React.useMemo(
    () => shopOptions.find((shop) => shop.id === activeShopId)?.clientId || shopOptions[0]?.clientId || '',
    [activeShopId, shopOptions]
  );
  const currentRule = React.useMemo(
    () => state.rules.find((rule) => rule.scene === scene) || null,
    [scene, state.rules]
  );

  const loadAutomation = React.useCallback(async (requestedMode) => {
    if (!enabled) return null;
    const mode = requestedMode === SMART_REPLY_EXECUTION_MODES.local
      ? SMART_REPLY_EXECUTION_MODES.local
      : SMART_REPLY_EXECUTION_MODES.cloud;
    setState((current) => ({ ...current, status: 'loading', error: '' }));
    try {
      const payload = await loadSmartReplyAutomation(mode);
      setState((current) => ({ ...current, ...payload, status: 'ready', error: '' }));
      return payload;
    } catch (error) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : '智能回复服务暂时无法连接。',
      }));
      return null;
    }
  }, [enabled]);

  const refresh = React.useCallback(
    () => loadAutomation(executionModeRef.current),
    [loadAutomation]
  );

  React.useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    void (async () => {
      try {
        const mode = await readSmartReplyExecutionMode();
        if (!active) return;
        executionModeRef.current = mode;
        setExecutionModeState(mode);
        await loadAutomation(mode);
      } catch (error) {
        if (!active) return;
        setState((current) => ({
          ...current,
          status: 'error',
          error: error instanceof Error ? error.message : '无法读取智能回复执行模式。',
        }));
      }
    })();
    return () => {
      active = false;
    };
  }, [enabled, loadAutomation]);

  React.useEffect(() => {
    setForm({
      shopClientIds: currentRule?.shopClientIds?.length
        ? currentRule.shopClientIds
        : activeClientId
          ? [activeClientId]
          : [],
      sendTimeType: currentRule?.sendTimeType || 'immediate',
      delayHours: currentRule?.delayHours || 1,
    });
  }, [activeClientId, currentRule, scene]);

  const updateForm = React.useCallback((patch) => {
    setForm((current) => ({ ...current, ...patch }));
  }, []);

  const saveRule = React.useCallback(
    async ({ enableRule = currentRule?.enabled === true } = {}) => {
      if (!scene || !selectedTemplate?.id) throw new Error('请先选择模板。');
      if (!form.shopClientIds.length) throw new Error('请至少选择一个店铺。');
      setBusyAction('save');
      try {
        const saved = await persistSmartReplyRule({
          ruleId: currentRule?.ruleId,
          scene,
          shopClientIds: form.shopClientIds,
          sendTimeType: form.sendTimeType,
          delayHours: form.delayHours,
          templateId: selectedTemplate.id,
          messageTemplate: selectedTemplate.messageRu,
          messageTemplateZh: selectedTemplate.messageZh,
          enabled: enableRule,
        }, executionModeRef.current);
        setState((current) => ({
          ...current,
          rules: [...current.rules.filter((rule) => rule.ruleId !== saved.ruleId && rule.scene !== saved.scene), saved],
          notice: enableRule ? '规则已保存并开始生效。' : '规则已保存，当前没有开启自动发送。',
          error: '',
        }));
        await refresh();
        return saved;
      } catch (error) {
        const message = error instanceof Error ? error.message : '保存规则失败。';
        setState((current) => ({ ...current, error: message, notice: '' }));
        throw error;
      } finally {
        setBusyAction('');
      }
    }, [currentRule, form, refresh, scene, selectedTemplate]
  );

  const setRuleEnabled = React.useCallback(
    async (nextEnabled) => {
      setBusyAction('toggle');
      try {
        const saved = currentRule?.ruleId
          ? await toggleSmartReplyRule(currentRule.ruleId, nextEnabled, executionModeRef.current)
          : await saveRule({ enableRule: nextEnabled });
        if (currentRule?.ruleId) {
          setState((current) => ({
            ...current,
            rules: current.rules.map((rule) => (rule.ruleId === saved.ruleId ? saved : rule)),
            notice: nextEnabled ? '自动发送已开启。' : '自动发送已关闭，后续不会再触发。',
            error: '',
          }));
          await refresh();
        }
        return saved;
      } catch (error) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : '切换任务状态失败。',
          notice: '',
        }));
        return null;
      } finally {
        setBusyAction('');
      }
    }, [currentRule, refresh, saveRule]
  );

  const configureCredential = React.useCallback(
    async (clientId) => {
      if (executionModeRef.current === SMART_REPLY_EXECUTION_MODES.local) {
        throw new Error('本地模式会直接使用此电脑已绑定的店铺授权，无需再次接入。');
      }
      const shop = shopOptions.find((item) => item.clientId === clientId);
      if (!shop?.id) throw new Error('没有找到已绑定的本地 Ozon 店铺。');
      setBusyAction('credential');
      try {
        const saved = await connectSmartReplyShop({ shopId: shop.id, clientId: shop.clientId });
        setState((current) => ({
          ...current,
          credentials: [...current.credentials.filter((item) => item.clientId !== saved.clientId), saved],
          notice: '店铺已接入云端自动发送。',
          error: '',
        }));
        await refresh();
        return saved;
      } catch (error) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : '店铺接入失败。',
          notice: '',
        }));
        return null;
      } finally {
        setBusyAction('');
      }
    },
    [refresh, shopOptions]
  );

  const retryTask = React.useCallback(
    async (taskId) => {
      setBusyAction(`retry:${taskId}`);
      try {
        await retryFailedSmartReplyTask(taskId, executionModeRef.current);
        await refresh();
      } catch (error) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : '重试失败。',
          notice: '',
        }));
      } finally {
        setBusyAction('');
      }
    },
    [refresh]
  );

  const credentialsByClientId = React.useMemo(
    () => Object.fromEntries(state.credentials.map((credential) => [credential.clientId, credential])),
    [state.credentials]
  );

  const setExecutionMode = React.useCallback(
    async (nextMode) => {
      const normalized = nextMode === SMART_REPLY_EXECUTION_MODES.local
        ? SMART_REPLY_EXECUTION_MODES.local
        : SMART_REPLY_EXECUTION_MODES.cloud;
      if (normalized === executionModeRef.current) return normalized;
      setBusyAction('mode');
      setState((current) => ({ ...current, error: '', notice: '' }));
      try {
        const switchResult = await changeSmartReplyExecutionMode(normalized, executionModeRef.current);
        const saved = switchResult?.mode === SMART_REPLY_EXECUTION_MODES.local
          ? SMART_REPLY_EXECUTION_MODES.local
          : SMART_REPLY_EXECUTION_MODES.cloud;
        executionModeRef.current = saved;
        setExecutionModeState(saved);
        setState((current) => ({
          ...current,
          rules: [],
          tasks: [],
          credentials: [],
          taskTotal: 0,
          notice: text(switchResult?.warning) || (
            saved === SMART_REPLY_EXECUTION_MODES.local
              ? '已切换到本地模式；软件正在本机监听订单并按已开启规则自动发送。'
              : '已切换到云端模式；原本地任务开关已关闭，避免重复发送。'
          ),
        }));
        await loadAutomation(saved);
        return saved;
      } catch (error) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : '切换执行模式失败。',
          notice: '',
        }));
        return executionModeRef.current;
      } finally {
        setBusyAction('');
      }
    },
    [loadAutomation]
  );

  return {
    ...state,
    busyAction,
    configureCredential,
    credentialsByClientId,
    currentRule,
    executionMode,
    form,
    refresh,
    retryTask,
    saveRule,
    setExecutionMode,
    setRuleEnabled,
    shopOptions,
    updateForm,
  };
}
