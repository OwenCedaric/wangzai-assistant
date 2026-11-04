import React from 'react';
import { runSmartToolDraft } from '../services/smartToolDraftService.js';
import {
  canUseSmartToolOzonBrowserData,
  runSmartToolDraftWithOzonBrowserData,
} from '../services/smartToolOzonBrowserDataService.js';
import { runSmartToolImageGenerationBatch } from '../services/smartToolImageGenerationService.js';
import { assertCompleteSmartToolImagePromptPlan } from '../services/smartToolImagePromptPlanService.js';
import {
  createSmartToolImagePipelineInput,
  prepareSmartToolImageGenerationPipeline,
} from '../services/smartToolImagePipelineService.js';
import { runSmartToolProductDescriptionGeneration } from '../services/smartToolProductDescriptionService.js';
import {
  loadSmartToolImageGenerationHistory,
  saveSmartToolImageGenerationHistory,
  normalizeSmartToolImageHistoryEntry,
} from '../services/smartToolImageHistoryService.js';
import { getSmartToolUsageInputSpec, getSmartToolUsageInputs } from '../lib/smartToolUsage.js';
import { usesActiveOzonProductQueryProfile } from '../lib/smartToolOzonBrowserDataProfiles.js';
import { ensureSmartToolProductLinkUsageInputs } from '../services/smartToolProductLinkService.js';
import {
  canUseSmartToolExternalOzonData,
  runSmartToolDraftWithExternalOzonData,
} from '../services/smartToolExternalOzonDataService.js';
import { runSmartToolExternalOzonInsight } from '../services/smartToolExternalOzonInsightService.js';
import {
  canUseSmartToolPerformanceAdData,
  runSmartToolDraftWithPerformanceAdData,
} from '../services/smartToolPerformanceAdDataService.js';
import {
  canUseSmartToolOperationalWorkflow,
  requiresSmartToolOperationalAnalysis,
  runSmartToolOperationalWorkflow,
} from '../services/smartToolOperationalWorkflowService.js';
import {
  canUseSmartToolProductSelection,
  runSmartToolProductSelection,
} from '../services/smartToolProductSelectionService.js';
import {
  canUseSmartToolGenericRuntime,
  runSmartToolGenericRuntime,
} from '../services/smartToolGenericRuntimeService.js';

function createEmptyUsageValues(tool = {}, usageInputs = []) {
  return usageInputs.reduce((draft, label) => {
    draft[label] = getSmartToolUsageInputSpec(tool, label)?.defaultValue || '';
    return draft;
  }, {});
}

function mergeImageGenerationItems(previousItems = [], nextItems = []) {
  const itemsBySourceIndex = new Map();
  [...previousItems, ...nextItems].forEach((item, fallbackIndex) => {
    const sourceIndex = Number.isInteger(item?.sourceIndex) ? item.sourceIndex : fallbackIndex;
    itemsBySourceIndex.set(sourceIndex, { ...item, sourceIndex });
  });
  return [...itemsBySourceIndex.values()].sort((left, right) => left.sourceIndex - right.sourceIndex);
}

function countSuccessfulImageItems(items = []) {
  return items.filter((item) => item.status === 'success' && item.imageUrl).length;
}

function getExternalDataFailureMessage(error) {
  const payloadMessage = error?.payload?.error?.message || error?.payload?.message || error?.payload?.error;
  const message = String(payloadMessage || (error instanceof Error ? error.message : error) || '数据查询失败');
  if (/fetch failed|network error|ECONN|ENOTFOUND|EAI_AGAIN|TLS|socket/iu.test(message)) {
    return '所选模型接口当前无法连接，请检查中转站服务状态、网络或代理设置后重试。';
  }
  return message;
}

export function usePromptLibraryExecution(selectedPrompt, { shop = null, availableTools = [] } = {}) {
  const usageInputs = React.useMemo(
    () => ensureSmartToolProductLinkUsageInputs(selectedPrompt, getSmartToolUsageInputs(selectedPrompt)),
    [selectedPrompt]
  );
  const [valuesByToolId, setValuesByToolId] = React.useState({});
  const [draftByToolId, setDraftByToolId] = React.useState({});
  const [imageGenerationByToolId, setImageGenerationByToolId] = React.useState({});
  const [imagePromptPlanByToolId, setImagePromptPlanByToolId] = React.useState({});
  const [productDescriptionByToolId, setProductDescriptionByToolId] = React.useState({});
  const [externalInsightByToolId, setExternalInsightByToolId] = React.useState({});
  const [imageGenerationHistoryByToolId, setImageGenerationHistoryByToolId] = React.useState({});
  const historyLoadVersionRef = React.useRef(0);
  const historyHydratedRef = React.useRef(false);
  const historySaveQueueRef = React.useRef(Promise.resolve());
  const autoImageExecutionRef = React.useRef(new Set());
  const imageRunsRef = React.useRef(new Map());
  const lastSuccessfulBrowserDraftRef = React.useRef(new Map());
  const externalDataRunRef = React.useRef(new Map());
  const externalInsightRunRef = React.useRef(new Map());
  const shopScope = React.useMemo(
    () => ({
      shopId: String(shop?.id || shop?.shopId || '').trim(),
      shopName: String(shop?.shopAlias || shop?.alias || shop?.name || shop?.sellerName || '').trim(),
    }),
    [shop?.alias, shop?.id, shop?.name, shop?.sellerName, shop?.shopAlias, shop?.shopId]
  );
  const shopScopeKey = shopScope.shopId || 'no-shop';

  const toolId = selectedPrompt?.id || '';
  React.useEffect(() => () => {
    imageRunsRef.current.forEach(run => run.controller.abort());
    imageRunsRef.current.clear();
  }, [shopScopeKey, toolId]);
  const values = React.useMemo(() => {
    if (!toolId) return {};
    return {
      ...createEmptyUsageValues(selectedPrompt, usageInputs),
      ...(valuesByToolId[toolId] || {}),
    };
  }, [selectedPrompt, toolId, usageInputs, valuesByToolId]);

  const draft = toolId ? draftByToolId[toolId] || null : null;
  const imageGeneration = toolId ? imageGenerationByToolId[toolId] || null : null;
  const imagePromptPlan = toolId ? imagePromptPlanByToolId[toolId] || null : null;
  const productDescription = toolId ? productDescriptionByToolId[toolId] || null : null;
  const externalInsight = toolId ? externalInsightByToolId[toolId] || null : null;
  const imageGenerationHistory = toolId ? imageGenerationHistoryByToolId[toolId] || [] : [];
  const externalDataEnabled = canUseSmartToolExternalOzonData(selectedPrompt);
  const performanceAdEnabled = canUseSmartToolPerformanceAdData(selectedPrompt);
  const operationalWorkflowEnabled = canUseSmartToolOperationalWorkflow(selectedPrompt);
  const operationalAnalysisRequired = requiresSmartToolOperationalAnalysis(selectedPrompt);
  const productSelectionEnabled = canUseSmartToolProductSelection(selectedPrompt);
  const genericRuntimeEnabled = canUseSmartToolGenericRuntime(selectedPrompt);
  const browserCaptureEnabled = canUseSmartToolOzonBrowserData(selectedPrompt);
  const browserDataEnabled =
    externalDataEnabled ||
    performanceAdEnabled ||
    operationalWorkflowEnabled ||
    productSelectionEnabled ||
    browserCaptureEnabled;

  React.useEffect(() => {
    const loadVersion = ++historyLoadVersionRef.current;
    loadSmartToolImageGenerationHistory()
      .then((historyMap) => {
        if (loadVersion !== historyLoadVersionRef.current) return;
        setImageGenerationHistoryByToolId((current) => {
          const merged = { ...historyMap };
          Object.entries(current).forEach(([id, entries]) => {
            const loadedEntries = Array.isArray(merged[id]) ? merged[id] : [];
            const loadedIds = new Set(loadedEntries.map((entry) => entry.id));
            merged[id] = [
              ...(Array.isArray(entries) ? entries : []).filter((entry) => !loadedIds.has(entry.id)),
              ...loadedEntries,
            ].slice(0, 50);
          });
          return merged;
        });
        historyHydratedRef.current = true;
      })
      .catch(() => {
        // The quick-run workspace remains usable when the local service is
        // temporarily unavailable. Mark hydration complete so the next
        // successful generation can retry persistence; the save service first
        // merges the existing SQLite value and therefore cannot clear it.
        historyHydratedRef.current = true;
      });
    return () => {
      historyLoadVersionRef.current += 1;
    };
  }, []);

  React.useEffect(() => {
    if (!historyHydratedRef.current) return undefined;
    historySaveQueueRef.current = historySaveQueueRef.current
      .catch(() => undefined)
      .then(() => saveSmartToolImageGenerationHistory(imageGenerationHistoryByToolId))
      .catch(() => undefined);
    return undefined;
  }, [imageGenerationHistoryByToolId]);

  React.useEffect(
    () => () => {
      externalDataRunRef.current.forEach((run) => run?.controller?.abort());
      externalDataRunRef.current.clear();
      externalInsightRunRef.current.forEach((run) => run?.controller?.abort());
      externalInsightRunRef.current.clear();
    },
    []
  );

  const changeValue = React.useCallback(
    (label, value) => {
      if (!toolId) return;
      externalInsightRunRef.current.get(toolId)?.controller?.abort();
      externalInsightRunRef.current.delete(toolId);
      setExternalInsightByToolId((current) => {
        const next = { ...current };
        delete next[toolId];
        return next;
      });
      const activeRun = externalDataRunRef.current.get(toolId);
      if (activeRun) {
        activeRun.controller?.abort();
        externalDataRunRef.current.delete(toolId);
        setDraftByToolId((current) => {
          const next = { ...current };
          delete next[toolId];
          return next;
        });
      }
      setValuesByToolId((current) => ({
        ...current,
        [toolId]: {
          ...(current[toolId] || {}),
          [label]: value,
        },
      }));
    },
    [toolId]
  );

  const runDraft = React.useCallback(
    (modelSelection = null) => {
      if (!selectedPrompt || !toolId) return null;
      if (operationalWorkflowEnabled) {
        const runKey = `${shopScopeKey}:${toolId}:${JSON.stringify(values)}:${modelSelection?.accountId || ''}:${modelSelection?.model || ''}`;
        const currentRun = externalDataRunRef.current.get(toolId);
        if (currentRun?.key === runKey) return currentRun.promise;
        currentRun?.controller?.abort();
        const controller = new AbortController();
        const loadingDraft = {
          toolId,
          toolTitle: selectedPrompt.title || '智能工具',
          createdAt: new Date().toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
          result: {
            status: 'loading',
            statusLabel:
              selectedPrompt.id === 'ozon-skill-1688-channel-shopdata-get'
                ? '正在读取并分析店铺经营数据'
                : '正在读取 1688 商品资料',
            summary:
              selectedPrompt.id === 'ozon-skill-1688-channel-shopdata-get'
                ? '正在读取真实报表；数据完成后会直接调用当前文本模型生成经营分析。'
                : '正在按当前 Skill 流程读取真实数据，请稍候…',
            sections: [],
            nextActions: [],
          },
        };
        setDraftByToolId((current) => ({ ...current, [toolId]: loadingDraft }));
        const runPromise = runSmartToolOperationalWorkflow(selectedPrompt, values, {
          shopScope,
          signal: controller.signal,
          modelSelection,
          onStage: ({ statusLabel, summary } = {}) => {
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return;
            setDraftByToolId((current) => ({
              ...current,
              [toolId]: {
                ...(current[toolId] || loadingDraft),
                result: {
                  ...(current[toolId]?.result || loadingDraft.result),
                  status: 'loading',
                  statusLabel: statusLabel || '正在执行报表 Skill',
                  summary: summary || '真实报表已读取，正在生成经营分析…',
                },
              },
            }));
          },
        })
          .then((nextDraft) => {
            if (externalDataRunRef.current.get(toolId)?.key === runKey) {
              setDraftByToolId((current) => ({ ...current, [toolId]: nextDraft }));
            }
            return nextDraft;
          })
          .catch((error) => {
            if (error?.name === 'AbortError') return null;
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return null;
            const failedDraft = {
              ...loadingDraft,
              result: {
                status: 'operational_data_error',
                statusLabel: '运行失败',
                summary: getExternalDataFailureMessage(error),
                sections: [],
                nextActions: [],
              },
            };
            setDraftByToolId((current) => ({ ...current, [toolId]: failedDraft }));
            return failedDraft;
          })
          .finally(() => {
            if (externalDataRunRef.current.get(toolId)?.promise === runPromise) {
              externalDataRunRef.current.delete(toolId);
            }
          });
        externalDataRunRef.current.set(toolId, { key: runKey, promise: runPromise, controller });
        return runPromise;
      }
      if (externalDataEnabled) {
        externalInsightRunRef.current.get(toolId)?.controller?.abort();
        externalInsightRunRef.current.delete(toolId);
        setExternalInsightByToolId((current) => {
          const next = { ...current };
          delete next[toolId];
          return next;
        });
        const runKey = `${shopScopeKey}:${toolId}:${JSON.stringify(values)}`;
        const currentRun = externalDataRunRef.current.get(toolId);
        if (currentRun?.key === runKey) return currentRun.promise;
        currentRun?.controller?.abort();
        const controller = new AbortController();
        const loadingDraft = {
          toolId,
          toolTitle: selectedPrompt.title || '数据查询',
          createdAt: new Date().toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
          result: {
            status: 'loading',
            statusLabel: '正在查询真实数据',
            summary: '正在按当前条件执行一次只读查询…',
            sections: [],
            nextActions: [],
          },
        };
        setDraftByToolId((current) => ({ ...current, [toolId]: loadingDraft }));
        let lastPartialDraft = null;
        const runPromise = runSmartToolDraftWithExternalOzonData(selectedPrompt, values, {
          shopScope,
          signal: controller.signal,
          onPartialDraft: (partialDraft) => {
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return;
            lastPartialDraft = partialDraft;
            setDraftByToolId((current) => ({ ...current, [toolId]: partialDraft }));
          },
          onRetry: ({ page = 1, retry = 1, retryLimit = 1, delayMs = 0, reason = '' } = {}) => {
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return;
            setDraftByToolId((current) => {
              const currentDraft = current[toolId] || loadingDraft;
              const waitSeconds = Math.max(1, Math.ceil(Number(delayMs) / 1000));
              const reasonLabel = reason === 'rate-limit' ? '接口繁忙' : '网络连接波动';
              return {
                ...current,
                [toolId]: {
                  ...currentDraft,
                  result: {
                    ...currentDraft.result,
                    status: 'loading',
                    statusLabel: '连接波动，正在自动重试',
                    summary: `第 ${page} 页${reasonLabel}，${waitSeconds} 秒后自动重试（${retry}/${retryLimit}）。已返回的数据会继续保留。`,
                  },
                },
              };
            });
          },
          onProgress: ({ loaded = 0, total = 0, page = 0, totalPages = 0 } = {}) => {
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return;
            setDraftByToolId((current) => {
              const currentDraft = current[toolId] || loadingDraft;
              const hasVisibleRows = currentDraft.result?.sections?.some((section) => section?.rows?.length);
              return {
                ...current,
                [toolId]: {
                  ...currentDraft,
                  result: {
                    ...currentDraft.result,
                    status: 'loading',
                    statusLabel: hasVisibleRows ? '首批数据已返回，正在继续读取' : '正在查询真实数据',
                    summary:
                      total > 0
                        ? `已读取 ${loaded} / ${total} 条（${page}/${totalPages} 页）；已返回的结果可以先查看。`
                        : `已读取 ${loaded} 条；已返回的结果可以先查看。`,
                  },
                },
              };
            });
          },
        })
          .then((nextDraft) => {
            if (externalDataRunRef.current.get(toolId)?.key === runKey) {
              setDraftByToolId((current) => ({ ...current, [toolId]: nextDraft }));
            }
            return nextDraft;
          })
          .catch((error) => {
            if (error?.name === 'AbortError') return null;
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return null;
            if (lastPartialDraft?.result) {
              const partialDraft = {
                ...lastPartialDraft,
                result: {
                  ...lastPartialDraft.result,
                  status: 'partial_ready',
                  statusLabel: '已保留已返回数据',
                  summary: `后台继续读取时中断：${getExternalDataFailureMessage(error)}。已返回的真实数据不会消失，可点击重试继续查询。`,
                  partialFailure: true,
                },
              };
              setDraftByToolId((current) => ({ ...current, [toolId]: partialDraft }));
              return partialDraft;
            }
            const failedDraft = {
              ...loadingDraft,
              result: {
                status: 'external_data_error',
                statusLabel: '查询失败',
                summary: getExternalDataFailureMessage(error),
                sections: [],
                nextActions: [],
              },
            };
            setDraftByToolId((current) => ({ ...current, [toolId]: failedDraft }));
            return failedDraft;
          })
          .finally(() => {
            if (externalDataRunRef.current.get(toolId)?.promise === runPromise) {
              externalDataRunRef.current.delete(toolId);
            }
          });
        externalDataRunRef.current.set(toolId, { key: runKey, promise: runPromise, controller });
        return runPromise;
      }
      if (performanceAdEnabled) {
        const runKey = `${shopScopeKey}:${toolId}:${JSON.stringify(values)}:${modelSelection?.accountId || ''}:${modelSelection?.model || ''}`;
        const currentRun = externalDataRunRef.current.get(toolId);
        if (currentRun?.key === runKey) return currentRun.promise;
        currentRun?.controller?.abort();
        const controller = new AbortController();
        const loadingDraft = {
          toolId,
          toolTitle: selectedPrompt.title || 'Ozon 广告分析',
          createdAt: new Date().toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
          result: {
            status: 'loading',
            statusLabel: '正在读取 Ozon Performance API',
            summary: '正在读取所选计划的真实统计和每日趋势，完成后将自动执行 Skill 分析…',
            sections: [],
            nextActions: [],
          },
        };
        setDraftByToolId((current) => ({ ...current, [toolId]: loadingDraft }));
        const runPromise = runSmartToolDraftWithPerformanceAdData(selectedPrompt, values, {
          shopId: shopScope.shopId,
          shopScope,
          signal: controller.signal,
          modelSelection,
          onStage: ({ statusLabel, summary } = {}) => {
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return;
            setDraftByToolId((current) => ({
              ...current,
              [toolId]: {
                ...(current[toolId] || loadingDraft),
                result: {
                  ...(current[toolId]?.result || loadingDraft.result),
                  status: 'loading',
                  statusLabel: statusLabel || '正在执行广告 Skill',
                  summary: summary || '正在调用分析模型生成最终报告…',
                },
              },
            }));
          },
        })
          .then((nextDraft) => {
            if (externalDataRunRef.current.get(toolId)?.key === runKey) {
              setDraftByToolId((current) => ({ ...current, [toolId]: nextDraft }));
            }
            return nextDraft;
          })
          .catch((error) => {
            if (error?.name === 'AbortError') return null;
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return null;
            const failedDraft = {
              ...loadingDraft,
              result: {
                status: 'performance_data_error',
                statusLabel: '广告 Skill 运行失败',
                summary: getExternalDataFailureMessage(error),
                sections: [],
                nextActions: [],
              },
            };
            setDraftByToolId((current) => ({ ...current, [toolId]: failedDraft }));
            return failedDraft;
          })
          .finally(() => {
            if (externalDataRunRef.current.get(toolId)?.promise === runPromise) {
              externalDataRunRef.current.delete(toolId);
            }
          });
        externalDataRunRef.current.set(toolId, { key: runKey, promise: runPromise, controller });
        return runPromise;
      }
      if (productSelectionEnabled) {
        const runKey = `${shopScopeKey}:${toolId}:${JSON.stringify(values)}:${modelSelection?.accountId || ''}:${modelSelection?.model || ''}`;
        const currentRun = externalDataRunRef.current.get(toolId);
        if (currentRun?.key === runKey) return currentRun.promise;
        currentRun?.controller?.abort();
        const controller = new AbortController();
        const loadingDraft = {
          toolId,
          toolTitle: selectedPrompt.title || 'Ozon 选品助手',
          createdAt: new Date().toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
          result: {
            status: 'loading',
            statusLabel: '正在读取 Ozon 市场数据',
            summary: '正在查询真实商品数据并计算固定七维评分…',
            viewType: 'product-selection',
            sections: [],
            nextActions: [],
          },
        };
        setDraftByToolId((current) => ({ ...current, [toolId]: loadingDraft }));
        const runPromise = runSmartToolProductSelection(selectedPrompt, values, {
          shopScope,
          signal: controller.signal,
          modelSelection,
          onStage: ({ statusLabel, summary } = {}) => {
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return;
            setDraftByToolId((current) => ({
              ...current,
              [toolId]: {
                ...(current[toolId] || loadingDraft),
                result: {
                  ...(current[toolId]?.result || loadingDraft.result),
                  status: 'loading',
                  statusLabel: statusLabel || '正在执行选品 Skill',
                  summary: summary || '正在整理真实数据并生成选品报告…',
                },
              },
            }));
          },
        })
          .then((nextDraft) => {
            if (externalDataRunRef.current.get(toolId)?.key === runKey) {
              setDraftByToolId((current) => ({ ...current, [toolId]: nextDraft }));
            }
            return nextDraft;
          })
          .catch((error) => {
            if (error?.name === 'AbortError') return null;
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return null;
            const failedDraft = {
              ...loadingDraft,
              result: {
                ...loadingDraft.result,
                status: 'browser_data_error',
                statusLabel: '选品 Skill 运行失败',
                summary: getExternalDataFailureMessage(error),
              },
            };
            setDraftByToolId((current) => ({ ...current, [toolId]: failedDraft }));
            return failedDraft;
          })
          .finally(() => {
            if (externalDataRunRef.current.get(toolId)?.promise === runPromise) {
              externalDataRunRef.current.delete(toolId);
            }
          });
        externalDataRunRef.current.set(toolId, { key: runKey, promise: runPromise, controller });
        return runPromise;
      }
      if (genericRuntimeEnabled) {
        const runtimeContext = modelSelection?.runtimeContext || {};
        const runKey = `${shopScopeKey}:${toolId}:${JSON.stringify(values)}:${modelSelection?.accountId || ''}:${modelSelection?.model || ''}:${runtimeContext?.selectedProduct?.id || ''}:${runtimeContext?.selectedSku?.id || ''}`;
        const currentRun = externalDataRunRef.current.get(toolId);
        if (currentRun?.key === runKey) return currentRun.promise;
        currentRun?.controller?.abort();
        const controller = new AbortController();
        const loadingDraft = {
          toolId,
          toolTitle: selectedPrompt.title || '智能工具',
          createdAt: new Date().toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
          result: {
            status: 'loading',
            statusLabel: '正在准备真实数据',
            summary: '正在按 Skill 自动绑定店铺、商品、只读接口和模型…',
            sections: [],
            nextActions: [],
          },
        };
        setDraftByToolId((current) => ({ ...current, [toolId]: loadingDraft }));
        const runPromise = runSmartToolGenericRuntime(selectedPrompt, values, {
          shopScope,
          modelSelection,
          imageModelSelection: modelSelection?.imageModelSelection,
          operation: modelSelection?.operation,
          availableTools,
          runtimeContext,
          signal: controller.signal,
          onStage: ({ statusLabel, summary } = {}) => {
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return;
            setDraftByToolId((current) => ({
              ...current,
              [toolId]: {
                ...(current[toolId] || loadingDraft),
                result: {
                  ...(current[toolId]?.result || loadingDraft.result),
                  status: 'loading',
                  statusLabel: statusLabel || '正在运行 Skill',
                  summary: summary || '正在生成最终结果…',
                },
              },
            }));
          },
        })
          .then((nextDraft) => {
            if (externalDataRunRef.current.get(toolId)?.key === runKey) {
              setDraftByToolId((current) => ({ ...current, [toolId]: nextDraft }));
            }
            return nextDraft;
          })
          .catch((error) => {
            if (error?.name === 'AbortError') return null;
            if (externalDataRunRef.current.get(toolId)?.key !== runKey) return null;
            const failedDraft = {
              ...loadingDraft,
              result: {
                status: 'generic_runtime_error',
                statusLabel: 'Skill 运行失败',
                summary: getExternalDataFailureMessage(error),
                sections: [],
                nextActions: ['检查模型或接口配置后重试'],
              },
            };
            setDraftByToolId((current) => ({ ...current, [toolId]: failedDraft }));
            return failedDraft;
          })
          .finally(() => {
            if (externalDataRunRef.current.get(toolId)?.promise === runPromise) {
              externalDataRunRef.current.delete(toolId);
            }
          });
        externalDataRunRef.current.set(toolId, { key: runKey, promise: runPromise, controller });
        return runPromise;
      }
      if (browserCaptureEnabled) {
        const activeProductQuery = usesActiveOzonProductQueryProfile(selectedPrompt);
        const browserRunKey = `${shopScopeKey}:${toolId}:${JSON.stringify(values)}`;
        const loadingDraft = {
          toolId,
          toolTitle: selectedPrompt.title || '智能工具',
          createdAt: new Date().toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
          result: {
            status: 'loading',
            statusLabel: activeProductQuery ? '正在后台搜索 Ozon 商品' : '正在读取浏览器插件数据',
            summary: activeProductQuery ? '正在分析商品与市场数据…' : '正在读取当前 Ozon 内置浏览器已经捕获的真实响应…',
            sections: [],
            nextActions: [],
          },
        };
        setDraftByToolId((current) => ({ ...current, [toolId]: loadingDraft }));
        const browserDraftPromise = shopScope.shopId
          ? runSmartToolDraftWithOzonBrowserData(selectedPrompt, values, { shopScope })
          : runSmartToolDraftWithOzonBrowserData(selectedPrompt, values);
        return browserDraftPromise.then((nextDraft) => {
          const previousSuccessfulDraft = lastSuccessfulBrowserDraftRef.current.get(browserRunKey);
          const resolvedDraft =
            nextDraft?.result?.status === 'browser_data_error' && previousSuccessfulDraft?.result?.productAnalysis
              ? {
                  ...previousSuccessfulDraft,
                  result: {
                    ...previousSuccessfulDraft.result,
                    status: 'browser_data_ready',
                    statusLabel: '已保留上次真实数据',
                    refreshWarning: nextDraft.result.summary || '本次刷新失败，已保留上次真实返回结果。',
                    refreshErrorCode: nextDraft.result.errorCode || '',
                    refreshFailedAt: new Date().toISOString(),
                  },
                }
              : nextDraft;
          if (resolvedDraft?.result?.status === 'browser_data_ready' && resolvedDraft.result.productAnalysis) {
            lastSuccessfulBrowserDraftRef.current.set(browserRunKey, resolvedDraft);
          }
          setDraftByToolId((current) => ({ ...current, [toolId]: resolvedDraft }));
          return resolvedDraft;
        });
      }
      const nextDraft = shopScope.shopId
        ? runSmartToolDraft(selectedPrompt, values, { shopScope })
        : runSmartToolDraft(selectedPrompt, values);
      setDraftByToolId((current) => ({
        ...current,
        [toolId]: nextDraft,
      }));
      return nextDraft;
    },
    [
      availableTools,
      browserCaptureEnabled,
      externalDataEnabled,
      genericRuntimeEnabled,
      operationalWorkflowEnabled,
      performanceAdEnabled,
      productSelectionEnabled,
      selectedPrompt,
      shopScope,
      shopScopeKey,
      toolId,
      values,
    ]
  );

  const clearDraft = React.useCallback(() => {
    if (!toolId) return;
    const activeRun = externalDataRunRef.current.get(toolId);
    activeRun?.controller?.abort();
    externalDataRunRef.current.delete(toolId);
    for (const key of lastSuccessfulBrowserDraftRef.current.keys()) {
      if (key.startsWith(`${shopScopeKey}:${toolId}:`)) lastSuccessfulBrowserDraftRef.current.delete(key);
    }
    setDraftByToolId((current) => {
      const next = { ...current };
      delete next[toolId];
      return next;
    });
    setImageGenerationByToolId((current) => {
      const next = { ...current };
      delete next[toolId];
      return next;
    });
    setImagePromptPlanByToolId((current) => {
      const next = { ...current };
      delete next[toolId];
      return next;
    });
    setProductDescriptionByToolId((current) => {
      const next = { ...current };
      delete next[toolId];
      return next;
    });
    externalInsightRunRef.current.get(toolId)?.controller?.abort();
    externalInsightRunRef.current.delete(toolId);
    setExternalInsightByToolId((current) => {
      const next = { ...current };
      delete next[toolId];
      return next;
    });
  }, [shopScopeKey, toolId]);

  const generateExternalInsight = React.useCallback(
    async (modelSelection = {}) => {
      if (!selectedPrompt || !toolId || !externalDataEnabled || !draft?.result) return null;
      externalInsightRunRef.current.get(toolId)?.controller?.abort();
      const controller = new AbortController();
      const runKey = `${toolId}:${draft.createdAt || ''}:${modelSelection.id || modelSelection.model || ''}`;
      externalInsightRunRef.current.set(toolId, { key: runKey, controller });
      setExternalInsightByToolId((current) => ({
        ...current,
        [toolId]: {
          status: 'loading',
          model: modelSelection.model || '',
          message: '正在分析完整查询结果…',
        },
      }));
      try {
        const insight = await runSmartToolExternalOzonInsight(selectedPrompt, draft, modelSelection, {
          signal: controller.signal,
        });
        if (externalInsightRunRef.current.get(toolId)?.key !== runKey) return null;
        setExternalInsightByToolId((current) => ({ ...current, [toolId]: insight }));
        return insight;
      } catch (error) {
        if (error?.name === 'AbortError') return null;
        if (externalInsightRunRef.current.get(toolId)?.key !== runKey) return null;
        const failure = {
          status: 'error',
          model: modelSelection.model || '',
          message: getExternalDataFailureMessage(error),
        };
        setExternalInsightByToolId((current) => ({ ...current, [toolId]: failure }));
        return failure;
      } finally {
        if (externalInsightRunRef.current.get(toolId)?.key === runKey) {
          externalInsightRunRef.current.delete(toolId);
        }
      }
    },
    [draft, externalDataEnabled, selectedPrompt, toolId]
  );

  const generateDescription = React.useCallback(
    async (input = {}) => {
      if (!selectedPrompt || !toolId) return null;
      setProductDescriptionByToolId((current) => ({
        ...current,
        [toolId]: {
          status: 'loading',
          description: '',
          message: `正在调用 ${input.modelSelection?.model || '文本模型'} 生成俄语商品描述…`,
        },
      }));
      try {
        const response = await runSmartToolProductDescriptionGeneration(input);
        const next = {
          status: 'success',
          fields: Array.isArray(response?.fields) ? response.fields : [],
          rawText: String(response?.rawText || response?.description || '').trim(),
          model: String(response?.model || '').trim(),
          accountId: String(response?.accountId || '').trim(),
          message: '商品资料已按 Ozon 字段生成，请逐项检查后再替换。',
        };
        setProductDescriptionByToolId((current) => ({ ...current, [toolId]: next }));
        return next;
      } catch (error) {
        const next = {
          status: 'error',
          description: '',
          message: error instanceof Error ? error.message : String(error || '商品描述生成失败'),
        };
        setProductDescriptionByToolId((current) => ({ ...current, [toolId]: next }));
        return next;
      }
    },
    [selectedPrompt, toolId]
  );

  const prepareImagePlan = React.useCallback(
    async (input = {}) => {
      if (!selectedPrompt || !toolId) return null;
      const group = input.group === 'detail' ? 'detail' : 'main';
      const groupLabel = group === 'detail' ? '详情图' : '主图';
      const sourceImageIndexes = Array.isArray(input.sourceImageIndexes) ? input.sourceImageIndexes : [];
      const fallbackCount = sourceImageIndexes.length
        ? sourceImageIndexes.length
        : Array.isArray(input.productImageUrls) && input.productImageUrls.length
          ? input.productImageUrls.length
          : 1;
      const requestedCount = Number.isFinite(Number(input.count)) ? Number(input.count) : fallbackCount;
      const boundedCount = Math.min(30, Math.max(1, Math.round(requestedCount)));
      const count = sourceImageIndexes.length ? Math.min(boundedCount, sourceImageIndexes.length) : boundedCount;
      const requestId = `${toolId}-${group}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const inputShopId = String(input.shopId || '').trim();
      const selectedShopId = String(shopScope.shopId || '').trim();
      const shopId = selectedShopId || inputShopId;
      if (!shopId || (selectedShopId && inputShopId && selectedShopId !== inputShopId)) {
        const errorState = {
          status: 'error',
          requestId,
          group,
          groupLabel,
          count,
          input: { ...input, group, imageGroup: group, count },
          message: shopId ? '当前商品所属店铺与已选店铺不一致，请重新选择商品。' : '请先选择店铺，再生成商品图。',
        };
        setImagePromptPlanByToolId((current) => ({
          ...current,
          [toolId]: { ...(current[toolId] || {}), [group]: errorState },
        }));
        return errorState;
      }
      const stagedInput = createSmartToolImagePipelineInput({
        ...input,
        shopId,
        group,
        imageGroup: group,
        count,
      }, selectedPrompt);
      const runKey = JSON.stringify([toolId, group]);
      imageRunsRef.current.get(runKey)?.controller.abort();
      const run = { controller: new AbortController(), requestId };
      imageRunsRef.current.set(runKey, run);
      const isCurrent = () => imageRunsRef.current.get(runKey) === run && !run.controller.signal.aborted;
      const planningState = {
        status: 'planning',
        requestId,
        group,
        groupLabel,
        count,
        // Keep the exact source positions on the plan from the first render.
        // The analysis request can take a while; without this field the
        // preview falls back to every selected image and makes a one-position
        // retry look like a full-batch retry during the planning phase.
        input: stagedInput,
        message: `正在调用 ${input.plannerModelSelection?.model || '分析模型'}，整理 ${count} 张${groupLabel}的逐图方案…`,
      };
      setImagePromptPlanByToolId((current) => ({
        ...current,
        [toolId]: {
          ...(current[toolId] || {}),
          [group]: planningState,
        },
      }));
      try {
        const bufferedGenerationItems = [];
        let generationItemListener = null;
        const prepared = await prepareSmartToolImageGenerationPipeline(stagedInput, count, {
          planStrategy: 'compiled',
          signal: run.controller.signal,
          onItemSettled: (item) => {
            if (!isCurrent()) return;
            if (generationItemListener) generationItemListener(item);
            else bufferedGenerationItems.push(item);
          },
        });
        if (!isCurrent()) return null;
        const plan = prepared.promptPlan;
        const plannerFallbackCount = Number(plan.plannerFallbackCount) || 0;
        assertCompleteSmartToolImagePromptPlan(plan, sourceImageIndexes);
        const readyState = {
          status: 'ready',
          requestId,
          signal: run.controller.signal,
          isCurrent,
          group,
          groupLabel,
          count,
          plan,
          input: stagedInput,
          generationPromise: prepared.generationPromise,
          attachGenerationItemListener: (listener) => {
            if (!isCurrent()) return;
            generationItemListener = typeof listener === 'function' ? listener : null;
            if (generationItemListener && bufferedGenerationItems.length) {
              bufferedGenerationItems.splice(0).forEach((item) => generationItemListener(item));
            }
          },
          message: plannerFallbackCount
            ? `已匹配 ${plan.items.length} 个位置规则；另有 ${plannerFallbackCount} 个位置分析未返回，已使用 Skill 固定规则继续调用图片模型。`
            : prepared.planStrategy === 'compiled'
              ? `已直接读取并完整编译 ${plan.items.length} 个 Skill 位置规则，图片模型已开始执行。`
              : prepared.pipelined
                ? `分析完成：已匹配 ${plan.items.length} 个位置规则；图片模型已与分析并行执行。`
                : `分析完成：已匹配 ${plan.items.length} 个位置规则，正在自动调用图片模型。`,
        };
        setImagePromptPlanByToolId((current) => ({
          ...current,
          [toolId]: {
            ...(current[toolId] || {}),
            [group]: readyState,
          },
        }));
        return readyState;
      } catch (error) {
        if (!isCurrent() || error?.name === 'AbortError') return null;
        const errorState = {
          status: 'error',
          requestId,
          group,
          groupLabel,
          count,
          input: stagedInput,
          message: error instanceof Error ? error.message : String(error || '图片方案分析失败'),
        };
        setImagePromptPlanByToolId((current) => ({
          ...current,
          [toolId]: {
            ...(current[toolId] || {}),
            [group]: errorState,
          },
        }));
        return errorState;
      }
    },
    [selectedPrompt, shopScope.shopId, toolId]
  );

  const executeImageGeneration = React.useCallback(
    async (staged = {}) => {
      if (!selectedPrompt || !toolId || !staged?.plan || !staged?.input) return null;
      const input = staged.input;
      const group = input.group === 'detail' ? 'detail' : 'main';
      const isCurrent = () => staged.isCurrent?.() !== false && !staged.signal?.aborted;
      if (!isCurrent()) return null;
      const groupLabel = group === 'detail' ? '详情图' : '主图';
      const sourceImageIndexes = Array.isArray(input.sourceImageIndexes) ? input.sourceImageIndexes : [];
      const fallbackCount = sourceImageIndexes.length
        ? sourceImageIndexes.length
        : Array.isArray(input.productImageUrls) && input.productImageUrls.length
          ? input.productImageUrls.length
          : 1;
      const requestedCount = Number.isFinite(Number(input.count)) ? Number(input.count) : fallbackCount;
      const boundedCount = Math.min(30, Math.max(1, Math.round(requestedCount)));
      const count = sourceImageIndexes.length ? Math.min(boundedCount, sourceImageIndexes.length) : boundedCount;
      const plannerFallbackCount = Number(staged.plan?.plannerFallbackCount) || 0;
      const historyEntryId = `${group}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const historyCreatedAt = new Date().toISOString();
      const upsertGeneratedHistory = (generatedItems = []) => {
        if (!isCurrent()) return;
        const successfulItems = generatedItems.filter((item) => item.status === 'success' && item.imageUrl);
        if (!successfulItems.length) return;
        setImageGenerationHistoryByToolId((current) => {
          if (!isCurrent()) return current;
          const currentEntries = current[toolId] || [];
          const existingEntry = currentEntries.find((entry) => entry.id === historyEntryId);
          const itemsBySourceIndex = new Map((existingEntry?.items || []).map((item) => [item.sourceIndex, item]));
          successfulItems.forEach((item) => {
            itemsBySourceIndex.set(item.sourceIndex, {
              sourceIndex: item.sourceIndex,
              assetId: item.assetId || item.result?.asset?.id || item.result?.asset?.assetId,
              imageUrl: item.imageUrl,
              previewUrl: item.previewUrl || item.result?.asset?.previewUrl || item.result?.asset?.localUrl,
            });
          });
          const historyEntry = normalizeSmartToolImageHistoryEntry({
            id: historyEntryId,
            accountId: input.accountId || input.profileId,
            shopId: input.shopId,
            productKey: input.productKey || input.offerId || input.productId || input.productTitle,
            offerId: input.offerId,
            productId: input.productId,
            sku: input.sku,
            group,
            groupLabel,
            createdAt: historyCreatedAt,
            productTitle: String(input.productTitle || '').trim(),
            skuFacts: String(input.skuFacts || '').trim(),
            plannerModel: String(input.plannerModelSelection?.model || '').trim(),
            model: String(input.modelSelection?.model || '').trim(),
            items: [...itemsBySourceIndex.values()],
          });
          return {
            ...current,
            [toolId]: [historyEntry, ...currentEntries.filter((entry) => entry.id !== historyEntryId)].slice(0, 50),
          };
        });
      };
      const loadingState = {
        status: 'loading',
        requestId: staged.requestId,
        count,
        message: plannerFallbackCount
          ? `正在调用图片中转站，同时生成 ${count} 张${groupLabel}；其中 ${plannerFallbackCount} 张使用 Skill 固定规则。`
          : `正在调用图片中转站，同时生成 ${count} 张${groupLabel}…`,
        result: {
          count,
          items: Array.from({ length: count }, (_, index) => ({
            index,
            sourceIndex: Number.isInteger(sourceImageIndexes[index]) ? sourceImageIndexes[index] : index,
            status: 'loading',
          })),
        },
      };
      setImageGenerationByToolId((current) => {
        const currentTool = current[toolId] || {};
        const previousItems = Array.isArray(currentTool[group]?.result?.items) ? currentTool[group].result.items : [];
        const requestedSourceIndexes = new Set(loadingState.result.items.map((item) => item.sourceIndex));
        const retainedItems = previousItems.filter((item) => !requestedSourceIndexes.has(item.sourceIndex));
        const items = mergeImageGenerationItems(retainedItems, loadingState.result.items);
        return {
          ...current,
          [toolId]: {
            ...currentTool,
            [group]: {
              ...loadingState,
              result: {
                ...loadingState.result,
                items,
                successCount: countSuccessfulImageItems(items),
                failedCount: items.filter((item) => item.status === 'error').length,
              },
            },
          },
        };
      });
      setImagePromptPlanByToolId((current) => ({
        ...current,
        [toolId]: {
          ...(current[toolId] || {}),
          [group]: {
            ...staged,
            status: 'generating',
            message: plannerFallbackCount
              ? `${plannerFallbackCount} 个位置分析未返回，已使用 Skill 固定规则调用图片中转站生成 ${count} 张${groupLabel}。`
              : `位置规则已匹配，正在调用图片中转站生成 ${count} 张${groupLabel}…`,
          },
        },
      }));
      try {
        const handleItemSettled = (item) => {
          if (!isCurrent()) return;
          setImageGenerationByToolId((current) => {
            if (!isCurrent()) return current;
            const currentTool = current[toolId];
            const currentGroup = currentTool?.[group];
            if (!currentGroup || currentGroup.status !== 'loading' || currentGroup.requestId !== staged.requestId)
              return current;
            const currentItems = Array.isArray(currentGroup.result?.items) ? currentGroup.result.items : [];
            const nextItems = mergeImageGenerationItems(currentItems, [item]);
            const successCount = countSuccessfulImageItems(nextItems);
            const failedCount = nextItems.filter((candidate) => candidate.status === 'error').length;
            return {
              ...current,
              [toolId]: {
                ...currentTool,
                [group]: {
                  ...currentGroup,
                  result: {
                    ...currentGroup.result,
                    items: nextItems,
                    successCount,
                    failedCount,
                  },
                },
              },
            };
          });
          upsertGeneratedHistory([item]);
        };
        staged.attachGenerationItemListener?.(handleItemSettled);
        const result = staged.generationPromise
          ? await staged.generationPromise
          : await runSmartToolImageGenerationBatch(
              {
                ...input,
                promptConfig: input.promptConfig || selectedPrompt.promptConfig,
                promptPlan: staged.plan,
              },
              count,
              { onItemSettled: handleItemSettled, signal: staged.signal }
            );
        if (!isCurrent()) return null;
        const successCount = result.successCount || 0;
        const status = successCount === count ? 'success' : successCount > 0 ? 'partial' : 'error';
        const nextResult = {
          status,
          count,
          message:
            successCount === count
              ? `${groupLabel}测试已完成，共生成 ${successCount} 张${plannerFallbackCount ? `；其中 ${plannerFallbackCount} 张使用 Skill 固定规则` : ''}`
              : successCount > 0
                ? `${groupLabel}已生成 ${successCount}/${count} 张，失败图片可以稍后重试`
                : `${groupLabel}生成失败，请检查中转站配置后重试`,
          result,
        };
        const successfulItems = result.items.filter((item) => item.status === 'success' && item.imageUrl);
        upsertGeneratedHistory(successfulItems);
        setImageGenerationByToolId((current) => {
          const currentTool = current[toolId] || {};
          const currentGroup = currentTool[group] || {};
          if (currentGroup.requestId && currentGroup.requestId !== staged.requestId) return current;
          const currentItems = Array.isArray(currentGroup.result?.items) ? currentGroup.result.items : [];
          const items = mergeImageGenerationItems(currentItems, result.items);
          return {
            ...current,
            [toolId]: {
              ...currentTool,
              [group]: {
                ...nextResult,
                requestId: staged.requestId,
                result: {
                  ...result,
                  items,
                  successCount: countSuccessfulImageItems(items),
                },
              },
            },
          };
        });
        setImagePromptPlanByToolId((current) => {
          const toolPlans = { ...(current[toolId] || {}) };
          delete toolPlans[group];
          return { ...current, [toolId]: toolPlans };
        });
        return nextResult;
      } catch (error) {
        if (!isCurrent() || error?.name === 'AbortError') return null;
        const nextError = {
          status: 'error',
          count,
          message: error instanceof Error ? error.message : String(error || '图片生成失败'),
          result: { count, items: [] },
        };
        setImageGenerationByToolId((current) => {
          const currentTool = current[toolId] || {};
          const currentGroup = currentTool[group] || {};
          if (currentGroup.requestId && currentGroup.requestId !== staged.requestId) return current;
          const requestedSourceIndexes = new Set(sourceImageIndexes);
          const retainedItems = (Array.isArray(currentGroup.result?.items) ? currentGroup.result.items : []).filter(
            (item) => !requestedSourceIndexes.has(item.sourceIndex)
          );
          return {
            ...current,
            [toolId]: {
              ...currentTool,
              [group]: {
                ...nextError,
                requestId: staged.requestId,
                result: {
                  count,
                  items: retainedItems,
                  successCount: countSuccessfulImageItems(retainedItems),
                  failedCount: count,
                },
              },
            },
          };
        });
        setImagePromptPlanByToolId((current) => {
          const toolPlans = { ...(current[toolId] || {}) };
          delete toolPlans[group];
          return { ...current, [toolId]: toolPlans };
        });
        return nextError;
      }
    },
    [selectedPrompt, toolId]
  );

  React.useEffect(() => {
    if (!toolId || !imagePromptPlan) return;
    ['main', 'detail'].forEach((group) => {
      const staged = imagePromptPlan[group];
      if (staged?.status !== 'ready' || !staged.plan || !staged.input) return;
      const executionKey = staged.requestId || `${toolId}-${group}-${staged.plan.version || 'plan'}`;
      if (autoImageExecutionRef.current.has(executionKey)) return;
      autoImageExecutionRef.current.add(executionKey);
      Promise.resolve(executeImageGeneration(staged)).finally(() => {
        autoImageExecutionRef.current.delete(executionKey);
      });
    });
  }, [executeImageGeneration, imagePromptPlan, toolId]);

  const confirmImagePlan = React.useCallback(
    (group = 'main') => {
      const safeGroup = group === 'detail' ? 'detail' : 'main';
      const staged = imagePromptPlanByToolId[toolId]?.[safeGroup];
      return executeImageGeneration(staged);
    },
    [executeImageGeneration, imagePromptPlanByToolId, toolId]
  );

  const cancelImagePlan = React.useCallback(
    (group = 'main') => {
      if (!toolId) return;
      const safeGroup = group === 'detail' ? 'detail' : 'main';
      const runKey = JSON.stringify([toolId, safeGroup]);
      imageRunsRef.current.get(runKey)?.controller.abort();
      imageRunsRef.current.delete(runKey);
      setImageGenerationByToolId(current => {
        const existing = current[toolId]?.[safeGroup];
        return existing ? { ...current, [toolId]: { ...current[toolId], [safeGroup]: { ...existing, status: 'cancelled', message: '图片任务已取消。' } } } : current;
      });
      setImagePromptPlanByToolId((current) => {
        const toolPlans = { ...(current[toolId] || {}) };
        delete toolPlans[safeGroup];
        return { ...current, [toolId]: toolPlans };
      });
    },
    [toolId]
  );

  return {
    usageInputs,
    values,
    draft,
    imageGeneration,
    imagePromptPlan,
    productDescription,
    externalInsight,
    imageGenerationHistory,
    browserDataEnabled,
    externalDataEnabled,
    performanceAdEnabled,
    operationalWorkflowEnabled,
    operationalAnalysisRequired,
    productSelectionEnabled,
    genericRuntimeEnabled,
    onChangeValue: changeValue,
    onRunDraft: runDraft,
    onClearDraft: clearDraft,
    onGenerateImage: prepareImagePlan,
    onConfirmImagePlan: confirmImagePlan,
    onCancelImagePlan: cancelImagePlan,
    onGenerateDescription: generateDescription,
    onGenerateExternalInsight: generateExternalInsight,
  };
}
