import { describe, expect, it } from 'vitest';
import { getSmartToolSkillProfile, smartToolSkillCatalog } from './smartToolSkillCatalog.js';

describe('smartToolSkillCatalog', () => {
  it('keeps Ozon product search as a source-neutral browser runtime skill', () => {
    const profile = smartToolSkillCatalog['ozon-product-search'];
    const normalized = getSmartToolSkillProfile({ id: 'ozon-product-search', title: 'Ozon 商品搜索' });

    expect(profile.runType).toBe('browser-capture-readonly');
    expect(profile.analysisRulesVersion).toBe('ozon-product-decision-v1');
    expect(profile).not.toHaveProperty('sourceName');
    expect(profile).not.toHaveProperty('sourceUrl');
    expect(profile).not.toHaveProperty('installType');
    expect(normalized).not.toHaveProperty('sourceName');
    expect(normalized).not.toHaveProperty('sourceUrl');
    expect(normalized.analysisRulesVersion).toBe('ozon-product-decision-v1');
    expect(normalized.capabilities.length).toBeGreaterThan(0);
    expect(normalized.workflowSteps.join('\n')).toContain('product-performance');
    expect(normalized.workflowSteps.join('\n')).toContain('七个维度');
  });

  it('广告分析固定使用 Ozon Performance API 只读运行时', () => {
    const profile = getSmartToolSkillProfile({ id: 'ozon-ad-analyzer' });

    expect(profile).toMatchObject({
      runType: 'ozon-performance-readonly',
      usageInputs: ['推广账号（可选）', '广告计划名称或 ID（可选）', '统计范围'],
    });
    expect(profile.workflowSteps.join('\n')).toContain('full');
    expect(profile.workflowSteps.join('\n')).toContain('不使用浏览器快照');
  });
});
