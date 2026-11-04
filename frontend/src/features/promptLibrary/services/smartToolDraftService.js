import { runSmartToolSkillAdapter } from '../lib/smartToolSkillAdapters.js';
import { createSmartToolUsageInputText, getSmartToolUsageInputs } from '../lib/smartToolUsage.js';
import { getSmartToolSkillExecutionState } from '../lib/smartToolAdapterRegistry.js';

export function createSmartToolDraftInput(tool = {}, values = {}) {
  const usageInputs = getSmartToolUsageInputs(tool);
  return createSmartToolUsageInputText(usageInputs, values);
}

export function runSmartToolDraft(tool = {}, values = {}, options = {}) {
  const usageInputs = getSmartToolUsageInputs(tool);
  const inputText = createSmartToolUsageInputText(usageInputs, values);
  const adapterState = getSmartToolSkillExecutionState(tool);
  const result = runSmartToolSkillAdapter(tool, inputText, options);
  const shopScope = options.shopScope?.shopId
    ? {
        shopId: String(options.shopScope.shopId),
        shopName: String(options.shopScope.shopName || ''),
      }
    : null;

  return {
    toolId: tool.id || '',
    toolTitle: tool.title || '智能工具',
    inputText,
    usageInputs,
    ...(shopScope ? { shopScope } : {}),
    adapter: {
      key: adapterState.adapterKey || '',
      version: adapterState.adapterVersion,
      status: adapterState.status,
      statusLabel: adapterState.statusLabel,
    },
    createdAt: new Date().toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
    result,
  };
}
