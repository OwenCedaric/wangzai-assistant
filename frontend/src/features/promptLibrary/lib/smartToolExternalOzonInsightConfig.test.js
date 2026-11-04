import { describe, expect, it } from 'vitest';
import {
  externalOzonInsightToolIds,
  getDefaultExternalOzonInsightConfig,
  isExternalOzonInsightToolId,
  normalizeExternalOzonInsightConfig,
} from './smartToolExternalOzonInsightConfig.js';

describe('smartToolExternalOzonInsightConfig', () => {
  it('keeps presentation and sampling locally while server owns default model instructions', () => {
    expect(externalOzonInsightToolIds).toHaveLength(7);

    externalOzonInsightToolIds.forEach((toolId) => {
      const config = getDefaultExternalOzonInsightConfig(toolId);
      expect(isExternalOzonInsightToolId(toolId)).toBe(true);
      expect(config.analysisGoals).toEqual([]);
      expect(config.workflowSteps).toEqual([]);
      expect(config.analysisRules).toEqual([]);
      expect(config.reportStyleRules).toEqual([]);
      expect(config.reportPresentation).toMatchObject({
        preset: 'editorial',
        logo: 'insights',
        accent: 'violet',
        density: 'comfortable',
      });
      expect(config.reportPresentation.sections.map((item) => item.id)).toEqual([
        'marketAssessment',
        'keyFindings',
        'opportunities',
        'risks',
        'actionPlan',
      ]);
      expect(config.systemPrompt).toBe('');
      expect(config.userPrompt).toBe('');
      expect(config.outputSections).toEqual([]);
      expect(config.outputRules).toEqual([]);
      expect(config.sampleMaxRecords).toBe(40);
      expect(config.sampleMaxChars).toBe(42000);
    });
  });

  it('keeps saved edits while filling missing fields and clamping unsafe sampling values', () => {
    const config = normalizeExternalOzonInsightConfig({
      analysisGoals: ['只看新品机会'],
      analysisRules: '规则一\n规则二',
      systemPrompt: '自定义系统提示词 {{analysisRules}}',
      reportPresentation: {
        eyebrow: '我的报告',
        logo: 'store',
        accent: 'green',
        sections: [{ id: 'actionPlan', title: '马上执行', icon: 'action', visible: true }],
      },
      sampleMaxRecords: 999,
      sampleMaxChars: 100,
    }, { toolId: 'linkfox-seerfar-ozon-product-report-search' });

    expect(config.analysisGoals).toEqual(['只看新品机会']);
    expect(config.analysisRules).toEqual(['规则一', '规则二']);
    expect(config.systemPrompt).toBe('自定义系统提示词 {{analysisRules}}');
    expect(config.reportPresentation).toMatchObject({
      eyebrow: '我的报告',
      logo: 'store',
      accent: 'green',
    });
    expect(config.reportPresentation.sections.find((item) => item.id === 'actionPlan'))
      .toMatchObject({ id: 'actionPlan', title: '马上执行' });
    expect(config.workflowSteps).toEqual([]);
    expect(config.sampleMaxRecords).toBe(100);
    expect(config.sampleMaxChars).toBe(5000);
  });
});
