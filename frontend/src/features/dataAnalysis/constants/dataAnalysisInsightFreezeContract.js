export const DATA_ANALYSIS_INSIGHT_FREEZE_VERSION = 'data-analysis-insight-v2-server-template-20260828';

export const DATA_ANALYSIS_INSIGHT_FREEZE_CONTRACT = Object.freeze({
  featureId: 'data-analysis-insight',
  version: DATA_ANALYSIS_INSIGHT_FREEZE_VERSION,
  dataSource: 'data-analysis-read-model',
  modelRole: '只根据当前店铺真实报表生成经营判断，不修改经营数据',
  reportLayout: '全宽经营报告、核心指标、总体结论、双栏章节、行动清单和数据更新时间',
  requestPolicy: '只读、单次分析、瞬时故障有限重试、禁止与报表刷新并发争抢',
});
