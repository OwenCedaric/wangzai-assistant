import { describe, expect, it } from 'vitest';
import {
  getSmartToolPromptTemplate,
  listSmartToolPromptTemplateIds,
  resolveSmartToolSystemPrompt,
} from './smartToolServerTemplates.js';

describe('smartToolPromptTemplates', () => {
  it('keeps prompt templates for every default smart tool skill', () => {
    expect(listSmartToolPromptTemplateIds()).toEqual(
      expect.arrayContaining([
        'ozon-product-search',
        'ozon-product-selection',
        'ozon-ad-analyzer',
        'ozon-product-image-generation',
        'profit-risk-review',
        'linkfox-seerfar-ozon-shop-search',
        'linkfox-seerfar-ozon-keyword-back-search',
      ])
    );
  });

  it('keeps only server template metadata in the client package', () => {
    const tool = {
      id: 'ozon-skill-1688-channel-shopdata-get',
      title: 'Ozon 报表读取',
      body: '整理经营报表',
      skillProfile: {
        workflowSteps: ['读取经营数据', '生成报表摘要'],
      },
    };
    const template = getSmartToolPromptTemplate(tool);

    expect(template).not.toHaveProperty('source');
    expect(template).not.toHaveProperty('sourceLabel');
    expect(template.templateId).toBe('operational-report.v1');
    expect(template.capability).toBe('text.external-insight');
    expect(template.systemPrompt).toBe('');
    expect(template.userPrompt).toBe('');
    expect(template.outputFormat).toContain('经营');
  });

  it('does not embed a fallback model prompt for custom installed tools', () => {
    const template = getSmartToolPromptTemplate({ id: 'custom-installed-tool' });

    expect(template.templateId).toBe('');
    expect(template.systemPrompt).toBe('');
    expect(template.outputRules.length).toBeGreaterThan(0);
  });

  it('routes the image planner to its server-owned template', () => {
    const template = getSmartToolPromptTemplate({ id: 'ozon-product-image-generation' });

    expect(template.modelPurpose).toContain('商品图方案');
    expect(template.outputFormat).toContain('逐图方案');
    expect(template.outputFormat).toContain('负向约束');
    expect(template.templateId).toBe('image-plan.v1');
    expect(template.capability).toBe('text.image-plan');
    expect(template.systemPrompt).toBe('');
  });

  it('keeps a user-edited image prompt instead of overwriting it during normalization', () => {
    const customPrompt = '这是运营组自己确认过的图片规则。';

    expect(
      resolveSmartToolSystemPrompt({ id: 'ozon-product-image-generation' }, customPrompt)
    ).toBe(customPrompt);
  });

  it('routes advertising analysis to its server-owned template', () => {
    const tool = {
      id: 'ozon-ad-analyzer',
      title: 'Ozon 广告分析',
      goal: '诊断广告计划',
      body: '读取真实广告数据',
      skillProfile: { runType: 'ozon-performance-readonly', workflowSteps: ['读取真实统计'] },
    };
    const template = getSmartToolPromptTemplate(tool);

    expect(template.templateId).toBe('performance-ad-insight.v1');
    expect(template.capability).toBe('text.external-insight');
    expect(template.systemPrompt).toBe('');
  });

  it('preserves user-saved additional rules as data', () => {
    const tool = {
      id: 'ozon-ad-analyzer',
      title: 'Ozon 广告分析',
      goal: '诊断广告计划',
      body: '旧说明',
      skillProfile: { runType: 'ozon-performance-readonly', workflowSteps: ['读取真实统计'] },
    };
    expect(resolveSmartToolSystemPrompt(tool, '运营组自定义广告规则')).toBe('运营组自定义广告规则');
  });
});

