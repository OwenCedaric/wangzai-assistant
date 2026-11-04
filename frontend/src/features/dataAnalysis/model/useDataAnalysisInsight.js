import React from 'react';
import {
  listSmartToolModelOptions,
  loadSmartToolModelState,
  resolveSmartToolModelSelection,
} from '../../promptLibrary/services/smartToolModelService.js';
import { generateDataAnalysisInsight } from '../services/dataAnalysisInsightClient.js';

function compactSnapshot(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => compactSnapshot(item, depth + 1));
  if (typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compactSnapshot(child, depth + 1)]));
}

export function useDataAnalysisInsight({ filters = {}, dashboard = null, promptConfig = {}, enabled = true } = {}) {
  const safeFilters = filters && typeof filters === 'object' ? filters : {};
  const safePromptConfig = promptConfig && typeof promptConfig === 'object' ? promptConfig : {};
  const shopId = String(safeFilters.shopId || '').trim();
  const startDate = String(safeFilters.startDate || '').trim();
  const endDate = String(safeFilters.endDate || '').trim();
  const templateInput = React.useMemo(() => ({
    query: { shopId, startDate, endDate },
    dashboard: compactSnapshot(dashboard),
  }), [dashboard, endDate, shopId, startDate]);
  const customRules = React.useMemo(() => JSON.stringify({
    userRules: safePromptConfig.systemPrompt || '',
    workflowSteps: safePromptConfig.workflowSteps || [],
    outputFormat: safePromptConfig.outputFormat || '',
    outputRules: safePromptConfig.outputRules || [],
    safetyRules: safePromptConfig.safetyRules || [],
  }), [safePromptConfig]);
  const [modelOptions, setModelOptions] = React.useState(() => listSmartToolModelOptions());
  const [selectedModelId, setSelectedModelId] = React.useState('auto');
  const [state, setState] = React.useState({ status: 'idle', insight: '', error: null, meta: null });
  const modelSelection = React.useMemo(
    () => resolveSmartToolModelSelection(selectedModelId, modelOptions),
    [modelOptions, selectedModelId]
  );

  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    loadSmartToolModelState()
      .then((modelState) => {
        if (cancelled) return;
        const nextOptions = listSmartToolModelOptions(modelState);
        setModelOptions(nextOptions);
        setSelectedModelId((current) => nextOptions.some((item) => item.id === current) ? current : 'auto');
      })
      .catch(() => {
        // The initial public model metadata remains usable when the local
        // account list is temporarily unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const analyze = React.useCallback(async (options = {}) => {
    if (!enabled) return null;
    if (!modelSelection.ready || !modelSelection.accountId || !modelSelection.model) {
      const error = new Error('请先在模型接口中配置可用的文本模型。');
      setState({ status: 'error', insight: '', error, meta: null });
      return null;
    }
    if (!dashboard) {
      const error = new Error('当前经营报表尚未读取完成。');
      setState({ status: 'error', insight: '', error, meta: null });
      return null;
    }
    const requestedUserPrompt = String(options && typeof options === 'object' ? options.userPromptOverride || '' : '').trim();
    setState((current) => ({ ...current, status: 'loading', error: null }));
    try {
      const result = await generateDataAnalysisInsight({
        accountId: modelSelection.accountId,
        model: modelSelection.model,
        shopId,
        startDate,
        endDate,
        templateId: 'data-analysis.v1',
        templateInput,
        customRules,
        userInstruction: requestedUserPrompt || String(safePromptConfig.userPrompt || '').trim(),
        dashboardMeta: dashboard?.meta || null,
        query: { shopId, startDate, endDate },
      });
      const next = {
        status: 'success',
        insight: String(result?.insight || '').trim(),
        error: null,
        meta: result?.dashboardMeta || null,
        model: result?.model || modelSelection.model,
        query: result?.query || { shopId, startDate, endDate },
      };
      setState(next);
      return next;
    } catch (error) {
      const next = { status: 'error', insight: '', error, meta: null };
      setState(next);
      return null;
    }
  }, [customRules, dashboard, enabled, endDate, modelSelection, safePromptConfig.userPrompt, shopId, startDate, templateInput]);

  return {
    ...state,
    modelOptions,
    selectedModelId,
    setSelectedModelId,
    modelSelection,
    analyze,
  };
}
