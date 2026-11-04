import { requestLocalApi } from '../../../api/localApiClient.js';
import { parseSmartToolExternalOzonInsightReport } from './smartToolExternalOzonInsightService.js';

const REPORT_ANALYSIS_TIMEOUT_MS = 300_000;
const REPORT_EVIDENCE_MAX_CHARS = 108_000;

function text(value) {
  return String(value ?? '').trim();
}

export function createOperationalReportInsightRequest(tool = {}, context = {}, modelSelection = {}) {
  if (!modelSelection?.ready || !text(modelSelection.accountId) || !text(modelSelection.model)) {
    throw new Error('没有可用的分析模型，请先选择已配置的文本模型。');
  }
  const sections = (Array.isArray(context.sections) ? context.sections : [])
    .map((item) => ({ title: text(item?.title), rows: (Array.isArray(item?.rows) ? item.rows : []).map(text).filter(Boolean).slice(0, 60) }))
    .filter((item) => item.rows.length);
  if (!sections.length) throw new Error('当前没有可供模型分析的报表数据。');
  return {
    accountId: text(modelSelection.accountId),
    model: text(modelSelection.model),
    templateId: 'operational-report.v1',
    templateInput: {
      shop: text(context.shopName || context.shopId),
      range: { startDate: text(context.range?.startDate), endDate: text(context.range?.endDate) },
      reportType: text(context.reportTypeLabel),
      sections,
    },
    customRules: JSON.stringify({
      workflowSteps: tool?.skillProfile?.workflowSteps || [],
      safetyNotes: tool?.skillProfile?.safetyNotes || [],
      outputFormat: tool?.promptConfig?.outputFormat || '',
      outputRules: tool?.promptConfig?.outputRules || [],
      userRules: tool?.promptConfig?.systemPrompt || '',
    }),
  };
}

export async function runSmartToolOperationalReportInsight(
  tool = {},
  context = {},
  modelSelection = {},
  options = {},
) {
  const request = createOperationalReportInsightRequest(tool, context, modelSelection);
  const requester = options.requester || requestLocalApi;
  const response = await requester('/api/integrations/analyze', {
    method: 'POST',
    body: request,
    timeoutMs: options.timeoutMs || REPORT_ANALYSIS_TIMEOUT_MS,
    signal: options.signal,
  });
  return {
    status: 'ready',
    report: parseSmartToolExternalOzonInsightReport(response?.reportText),
    model: text(response?.model || request.model),
    accountId: text(response?.accountId || request.accountId),
    usage: response?.usage || null,
    generatedAt: new Date().toISOString(),
  };
}
