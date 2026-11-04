import { describe, expect, it } from 'vitest';
import { ozonRuntimeProfiles, ozonSkillIds, ozonSkillItems, ozonSkillProfiles } from './ozonSkillCatalog.js';
import { normalizePromptLibraryStore } from './promptLibraryStore.jsx';

describe('ozonSkillCatalog', () => {
  it('registers all Ozon-related skills as smart tools', () => {
    expect(ozonSkillIds).toEqual(
      expect.arrayContaining([
        'ozon-skill-1688-channel-shopdata-get',
        'ozon-skill-1688-channel-shopdata-analyzer',
        'ozon-skill-1688-product-detail-query',
      ])
    );
    expect(ozonSkillItems).toHaveLength(3);
    expect(normalizePromptLibraryStore().items).toHaveLength(15);
  });

  it('keeps original skill metadata and runtime profile without exposing vendor naming', () => {
    const detailSkill = ozonSkillProfiles['ozon-skill-1688-product-detail-query'];
    const detailRuntime = ozonRuntimeProfiles['ozon-skill-1688-product-detail-query'];

    expect(detailSkill.originalSkillName).toBe('1688-product-detail-query');
    expect(detailSkill.sourceRef).toContain('local-ozon-skill:');
    expect(detailSkill.safetyNotes.join('\n')).toContain('只读商品详情');
    expect(detailRuntime.riskTone).toBe('success');
    expect(detailRuntime.actionMode).toContain('读取商品详情');
  });

  it('keeps the three remaining tools on completed paths with editable workflows', () => {
    const ids = [
      'ozon-skill-1688-product-detail-query',
      'ozon-skill-1688-channel-shopdata-get',
      'ozon-skill-1688-channel-shopdata-analyzer',
    ];

    ids.forEach((id) => {
      const item = ozonSkillItems.find((candidate) => candidate.id === id);
      expect(item?.status).toBe('可用');
      expect(item?.skillProfile.implementationVersion).toBe(
        id === 'ozon-skill-1688-channel-shopdata-get' ? 4 : 2,
      );
      expect(item?.skillProfile.workflowSteps.length).toBeGreaterThanOrEqual(5);
      expect(item?.skillProfile.safetyNotes.length).toBeGreaterThanOrEqual(3);
      expect(item?.outputFormat).toBeTruthy();
    });

    expect(ozonSkillProfiles['ozon-skill-1688-product-detail-query'].runType).toBe('isolated-product-browser-read-v2');
    expect(ozonSkillProfiles['ozon-skill-1688-channel-shopdata-get'].runType).toBe('ozon-synced-report-read-and-analyze-v4');
  });

  it('merges Ozon skills into existing local smart tool stores and hides old prefixed records', () => {
    const legacyPrefix = ['new', 'ton'].join('');
    const legacyId = `${legacyPrefix}-1688-pricing-sku-calculator`;
    const store = normalizePromptLibraryStore({
      categories: [{ value: 'ozon', label: 'Ozon 工具' }],
      items: [
        {
          id: legacyId,
          scene: 'profit',
          title: '旧命名工具',
          goal: '应该被隐藏',
        },
        {
          id: 'ozon-skill-1688-product-keyword-research',
          scene: 'selection',
          title: 'Ozon 蓝海词',
          goal: '已经下线的重复功能',
        },
        {
          id: 'ozon-image-translator',
          scene: 'image',
          title: 'Ozon 图片俄文化处理',
          goal: '已经删除的重复功能',
        },
        {
          id: 'ozon-write-guard',
          scene: 'system',
          title: 'Ozon 写入安全确认',
          goal: '已经删除的重复功能',
        },
        {
          id: 'ozon-skill-1688-distribution-ozon-list',
          scene: 'system',
          title: 'Ozon 上架草稿',
          goal: '已经删除的重复功能',
        },
        {
          id: 'product-title-optimization',
          scene: 'product',
          title: '商品标题优化',
          goal: '本次明确删除',
        },
        {
          id: 'ozon-skill-1688-pricing-sku-calculator',
          scene: 'profit',
          title: 'Ozon 核价',
          goal: '本次明确删除',
        },
        {
          id: 'ozon-skill-1688-channel-profit-estimate',
          scene: 'profit',
          title: 'Ozon 利润预估',
          goal: '本次明确删除',
        },
        {
          id: 'custom-tool',
          scene: 'ozon',
          title: '自定义工具',
          goal: '保留用户自己的工具',
        },
      ],
    });

    expect(store.items.some((item) => item.id === legacyId)).toBe(false);
    expect(store.items.some((item) => item.id === 'ozon-skill-1688-product-keyword-research')).toBe(false);
    expect(store.items.some((item) => item.id === 'ozon-image-translator')).toBe(false);
    expect(store.items.some((item) => item.id === 'ozon-write-guard')).toBe(false);
    expect(store.items.some((item) => item.id === 'ozon-skill-1688-distribution-ozon-list')).toBe(false);
    expect(store.items.some((item) => item.id === 'product-title-optimization')).toBe(false);
    expect(store.items.some((item) => item.id === 'ozon-skill-1688-pricing-sku-calculator')).toBe(false);
    expect(store.items.some((item) => item.id === 'ozon-skill-1688-channel-profit-estimate')).toBe(false);
    expect(store.items.some((item) => item.id === 'custom-tool')).toBe(true);
    expect(store.categories.some((item) => item.value === 'profit')).toBe(true);
    expect(store.categories.some((item) => item.value === 'system')).toBe(false);
  });
});
