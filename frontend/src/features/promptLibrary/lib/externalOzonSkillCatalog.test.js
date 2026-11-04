import { describe, expect, it } from 'vitest';
import {
  externalOzonPromptTemplates,
  externalOzonRuntimeProfiles,
  externalOzonSkillIds,
  externalOzonSkillItems,
  externalOzonSkillProfiles,
  externalOzonSkillSetupRules,
} from './externalOzonSkillCatalog.js';
import { normalizePromptLibraryStore, promptLibraryItems } from './promptLibraryStore.jsx';
import { createSmartToolMeta } from './smartToolRuntime.js';

describe('externalOzonSkillCatalog', () => {
  it('只保留 7 个 Seerfar Ozon Skill', () => {
    expect(externalOzonSkillItems).toHaveLength(7);
    expect(externalOzonSkillIds.filter((id) => id.includes('-seerfar-'))).toHaveLength(7);
    expect(new Set(externalOzonSkillIds).size).toBe(7);
  });

  it('每个 Skill 都带有普通输入、流程、输出、安全和运行配置', () => {
    externalOzonSkillItems.forEach((item) => {
      expect(item.status).toBe('待配置');
      expect(item.skillProfile.runType).toBe('external-readonly');
      expect(item.skillProfile.usageInputs.length).toBeGreaterThan(0);
      expect(item.skillProfile.workflowSteps.length).toBeGreaterThanOrEqual(5);
      expect(item.skillProfile.outputs.length).toBeGreaterThan(0);
      expect(item.skillProfile.safetyNotes.join('\n')).toContain('串行退避重试');
      expect(item.runtimeProfile.riskLabel).toBe('只看不改');
      expect(externalOzonSkillProfiles[item.id]).toBe(item.skillProfile);
      expect(externalOzonRuntimeProfiles[item.id]).toBe(item.runtimeProfile);
      expect(externalOzonPromptTemplates[item.id].outputFormat).toBeTruthy();
      expect(externalOzonSkillSetupRules[item.id].needed).toBe('thirdParty');
    });
  });

  it('把所有外部 Ozon Skill 合并进默认工具库', () => {
    const libraryIds = promptLibraryItems.map((item) => item.id);
    expect(libraryIds).toEqual(expect.arrayContaining(externalOzonSkillIds));
    expect(new Set(libraryIds).size).toBe(libraryIds.length);
  });

  it('旧的本地工具库加载时也会自动补齐新卡片', () => {
    const store = normalizePromptLibraryStore({
      categories: [{ value: 'ozon', label: 'Ozon 工具' }],
      items: [{ id: 'custom-tool', scene: 'ozon', title: '自定义工具' }],
    });
    const storeIds = store.items.map((item) => item.id);

    expect(storeIds).toEqual(expect.arrayContaining(externalOzonSkillIds));
    expect(storeIds).toContain('custom-tool');
  });

  it('加载旧工具库时会清除已停用的高成本数据工具', () => {
    const retiredProvider = ['mp', 'stats'].join('');
    const retiredId = ['linkfox', retiredProvider, 'ozon-product-detail'].join('-');
    const store = normalizePromptLibraryStore({
      categories: [{ value: 'ozon', label: 'Ozon 工具' }],
      items: [
        { id: retiredId, scene: 'ozon', title: '旧付费商品详情' },
        { id: 'custom-tool', scene: 'ozon', title: '自定义工具' },
      ],
    });

    expect(store.items.some((item) => item.id === retiredId)).toBe(false);
    expect(store.items.some((item) => item.id === 'custom-tool')).toBe(true);
  });

  it('按已保存的 Seerfar 接口配置标记为可查', () => {
    const seerfarItem = externalOzonSkillItems.find((item) => item.providerType === 'seerfar-open-api');
    const environment = {
      integrationTypes: ['seerfar-open-api'],
      hasThirdPartyToolAccount: true,
    };

    expect(createSmartToolMeta(seerfarItem, environment).availabilityLabel).toBe('能查');
  });
});
