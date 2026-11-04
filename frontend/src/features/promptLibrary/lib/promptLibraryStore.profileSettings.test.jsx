import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfileSetting: vi.fn(),
  saveProfileSetting: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProfileSetting: mocks.getProfileSetting,
  saveProfileSetting: mocks.saveProfileSetting,
}));

import {
  loadPromptLibraryStore,
  normalizePromptLibraryStore,
  PROFILE_PROMPT_LIBRARY_NAMESPACE,
  readPromptLibraryCategories,
  readPromptLibraryItems,
  savePromptLibraryStore,
} from './promptLibraryStore.jsx';

const canonicalStore = {
  categories: [{ value: 'custom', label: '自定义工具' }],
  items: [
    {
      id: 'custom-tool',
      scene: 'custom',
      title: '自定义工具',
      body: '只保存工具配置，不运行工具。',
      variables: ['订单号'],
    },
  ],
};
const RETIRED_CATEGORY_KEY = 'wangzai-prompt-library-categories';
const RETIRED_ITEMS_KEY = 'wangzai-prompt-library-items';

function profileSetting(value = canonicalStore) {
  return { setting: { namespace: PROFILE_PROMPT_LIBRARY_NAMESPACE, value } };
}

afterEach(() => {
  globalThis.localStorage.clear();
  vi.clearAllMocks();
});

describe('prompt library SQLite runtime', () => {
  it('keeps saved external analysis edits while protected defaults remain on the server', () => {
    const store = normalizePromptLibraryStore({
      items: [
        {
          id: 'linkfox-seerfar-ozon-market-keyword-search',
          scene: 'ozon',
          title: 'Seerfar 市场热词',
          body: '读取市场关键词。',
          variables: ['关键词'],
          promptConfig: {
            externalInsightConfig: {
              analysisGoals: ['优先判断增长词'],
              sampleMaxRecords: 25,
            },
          },
        },
      ],
    });

    const tool = store.items.find((item) => item.id === 'linkfox-seerfar-ozon-market-keyword-search');
    expect(tool.promptConfig.externalInsightConfig).toMatchObject({
      analysisGoals: ['优先判断增长词'],
      sampleMaxRecords: 25,
      sampleMaxChars: 42000,
    });
    expect(tool.promptConfig.externalInsightConfig.workflowSteps).toEqual([]);
    expect(tool.promptConfig.externalInsightConfig.systemPrompt).toBe('');
    expect(tool.promptConfig.externalInsightConfig.outputSections).toEqual([]);
  });

  it('migrates the built-in Ozon product search to browser-capture rules and removes saved provenance', () => {
    const store = normalizePromptLibraryStore({
      items: [
        {
          id: 'ozon-product-search',
          scene: 'ozon',
          title: 'Ozon 商品搜索',
          status: '待配置',
          body: '现在还没填查询账号，所以先不能直接查。',
          sourceName: '旧顶层来源',
          sourceUrl: 'https://example.invalid/old-top-level-skill',
          skillProfile: {
            sourceName: '旧来源',
            sourceUrl: 'https://example.invalid/old-skill',
            installType: 'skillhub',
            runType: 'external-readonly',
            workflowSteps: ['调用旧接口'],
          },
          promptConfig: {
            systemPrompt: 'skill 来源：旧来源',
            workflowSteps: ['调用旧接口'],
          },
        },
      ],
    });

    const tool = store.items.find((item) => item.id === 'ozon-product-search');
    expect(tool.status).toBe('可用');
    expect(tool.dependencies).toEqual(['Ozon 内置浏览器插件']);
    expect(tool.body).toContain('后台专用浏览器');
    expect(tool.skillProfile.runType).toBe('browser-capture-readonly');
    expect(tool.skillProfile).not.toHaveProperty('sourceName');
    expect(tool.skillProfile).not.toHaveProperty('sourceUrl');
    expect(tool.skillProfile).not.toHaveProperty('installType');
    expect(tool.promptConfig.systemPrompt).not.toContain('skill 来源');
    expect(tool.promptConfig.workflowSteps.join('\n')).toContain('product-performance');
    expect(tool.promptConfig.workflowSteps.join('\n')).toContain('市场动量、竞争结构、流量转化');
  });

  it('把旧广告分析配置升级为 Performance API 只读运行时', () => {
    const store = normalizePromptLibraryStore({
      items: [
        {
          id: 'ozon-ad-analyzer',
          scene: 'marketing',
          title: 'Ozon 广告分析',
          status: '部分可用',
          body: '读取旧浏览器 traffic-conversion 快照。',
          dependencies: ['浏览器插件'],
          skillProfile: {
            runType: 'local-ai-preview',
            usageInputs: ['广告活动名称或 ID'],
            workflowSteps: ['读取浏览器快照'],
          },
        },
      ],
    });

    const tool = store.items.find((item) => item.id === 'ozon-ad-analyzer');
    expect(tool).toMatchObject({
      status: '可用',
      dependencies: ['Ozon Performance API 账号', '文本模型接口'],
      skillProfile: {
        runType: 'ozon-performance-readonly',
        usageInputs: ['推广账号（可选）', '广告计划名称或 ID（可选）', '统计范围'],
      },
    });
    expect(tool.body).toContain('Ozon Performance API');
    expect(tool.skillProfile.workflowSteps.join('\n')).toContain('full');
    expect(tool.skillProfile.workflowSteps.join('\n')).not.toContain('读取浏览器快照');
  });

  it('upgrades the completed built-in Ozon image skill status from old persisted records', () => {
    const store = normalizePromptLibraryStore({
      items: [
        {
          id: 'ozon-product-image-generation',
          scene: 'image',
          title: 'Ozon 商品图生成',
          status: '部分可用',
        },
      ],
    });

    const imageSkill = store.items.find((item) => item.id === 'ozon-product-image-generation');
    expect(imageSkill.status).toBe('可用');
    expect(imageSkill.tone).toBe('success');
  });

  it('migrates an older installed Skill into parsed image rules without changing native Skills', () => {
    const store = normalizePromptLibraryStore({
      items: [
        {
          id: 'installed-generic-image-flow',
          scene: 'image',
          title: '安装的图片流程',
          body: '# 图片流程\n\n## 执行流程\n1. 读取商品\n2. 生成图片',
          variables: ['商品信息'],
          skillProfile: {
            installType: 'skill-md',
            sourceName: 'generic-image-flow',
            referenceFiles: [
              {
                path: 'rules/images.md',
                content:
                  '# 图片\n\n## 图片位置\n1. **主图**: 展示真实商品，使用俄语短标题。不得出现价格。\n2. **结构图**: 展示真实结构。不得增加配件。',
              },
            ],
          },
          promptConfig: {
            imagePositionRules: { main: [], detail: [] },
            imagePositionRulesVersion: 3,
          },
        },
      ],
    });

    const installed = store.items.find((item) => item.id === 'installed-generic-image-flow');
    expect(installed.skillProfile.parserVersion).toBeGreaterThan(0);
    expect(installed.promptConfig.installedSkillParserVersion).toBe(installed.skillProfile.parserVersion);
    expect(installed.promptConfig.imagePositionRules.main).toHaveLength(2);
    expect(installed.promptConfig.imagePositionRules.main[0]).toMatchObject({
      purpose: '首图 / 点击图',
      visibleText: expect.stringMatching(/俄语短标题/u),
      mustAvoid: expect.stringMatching(/不得出现价格/u),
    });
  });

  it('removes retired tools and persists the cleaned SQLite store once', async () => {
    const retiredIds = [
      'ozon-attribute-autofill',
      'image-scene-prompt',
      'ozon-skill-1688-product-image-search',
      'ozon-skill-1688-product-downstream-search',
      'ozon-skill-1688-product-ranking',
      'ozon-skill-1688-supplychain-smart-replenishment',
    ];
    const source = {
      ...canonicalStore,
      items: [...canonicalStore.items, ...retiredIds.map((id) => ({ id, scene: 'custom', title: id }))],
    };
    mocks.getProfileSetting.mockResolvedValue(profileSetting(source));
    mocks.saveProfileSetting.mockImplementation(async (_namespace, value) => profileSetting(value));

    const store = await loadPromptLibraryStore();

    expect(store.items.some((item) => retiredIds.includes(item.id))).toBe(false);
    expect(store.items.some((item) => item.id === 'custom-tool')).toBe(true);
    expect(mocks.saveProfileSetting).toHaveBeenCalledTimes(1);
    expect(mocks.saveProfileSetting).toHaveBeenCalledWith(
      PROFILE_PROMPT_LIBRARY_NAMESPACE,
      expect.objectContaining({
        items: expect.not.arrayContaining(retiredIds.map((id) => expect.objectContaining({ id }))),
      }),
      { timeoutMs: 30000 }
    );
  });

  it('uses default memory data when SQLite has no record and ignores both retired browser keys', async () => {
    const retiredCategories = [{ value: 'retired-category', label: '不可读取' }];
    const retiredItems = [{ id: 'retired-tool', scene: 'retired-category', title: '不可读取' }];
    globalThis.localStorage.setItem(RETIRED_CATEGORY_KEY, JSON.stringify(retiredCategories));
    globalThis.localStorage.setItem(RETIRED_ITEMS_KEY, JSON.stringify(retiredItems));
    mocks.getProfileSetting.mockResolvedValue({ setting: null });

    const store = await loadPromptLibraryStore();

    expect(store.categories.some((item) => item.value === 'retired-category')).toBe(false);
    expect(store.items.some((item) => item.id === 'retired-tool')).toBe(false);
    expect(readPromptLibraryCategories().some((item) => item.value === 'retired-category')).toBe(false);
    expect(readPromptLibraryItems().some((item) => item.id === 'retired-tool')).toBe(false);
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem(RETIRED_CATEGORY_KEY)).toBe(JSON.stringify(retiredCategories));
    expect(globalThis.localStorage.getItem(RETIRED_ITEMS_KEY)).toBe(JSON.stringify(retiredItems));
  });

  it('loads canonical SQLite data without reading, migrating, or clearing retired browser values', async () => {
    globalThis.localStorage.setItem(RETIRED_CATEGORY_KEY, JSON.stringify([{ value: 'retired-category' }]));
    globalThis.localStorage.setItem(RETIRED_ITEMS_KEY, JSON.stringify([{ id: 'retired-tool' }]));
    mocks.getProfileSetting.mockResolvedValue(profileSetting());

    const store = await loadPromptLibraryStore();

    expect(store.items.some((item) => item.id === 'custom-tool')).toBe(true);
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem(RETIRED_CATEGORY_KEY)).not.toBeNull();
    expect(globalThis.localStorage.getItem(RETIRED_ITEMS_KEY)).not.toBeNull();
  });

  it('fails closed when the canonical SQLite read fails instead of falling back to retired sources', async () => {
    globalThis.localStorage.setItem(RETIRED_ITEMS_KEY, JSON.stringify([{ id: 'retired-tool' }]));
    mocks.getProfileSetting.mockRejectedValue(new Error('profile read unavailable'));

    await expect(loadPromptLibraryStore()).rejects.toThrow('profile read unavailable');

    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem(RETIRED_ITEMS_KEY)).not.toBeNull();
  });

  it('persists later edits through profile-settings and applies the canonical readback', async () => {
    const nextStore = {
      categories: canonicalStore.categories,
      items: [...canonicalStore.items, { ...canonicalStore.items[0], id: 'second-tool', title: '第二个工具' }],
    };
    mocks.saveProfileSetting.mockResolvedValue(profileSetting(nextStore));
    mocks.getProfileSetting.mockResolvedValue(profileSetting(nextStore));

    const stored = await savePromptLibraryStore(nextStore);

    expect(mocks.saveProfileSetting).toHaveBeenCalledWith(
      PROFILE_PROMPT_LIBRARY_NAMESPACE,
      expect.objectContaining({ items: expect.any(Array) }),
      { timeoutMs: 30000 }
    );
    expect(mocks.getProfileSetting).toHaveBeenCalledWith(PROFILE_PROMPT_LIBRARY_NAMESPACE, { timeoutMs: 10000 });
    expect(stored.items.some((item) => item.id === 'second-tool')).toBe(true);
  });

  it('does not let an older queued readback replace a newer optimistic store', async () => {
    const firstStore = { categories: canonicalStore.categories, items: canonicalStore.items };
    const secondStore = {
      categories: canonicalStore.categories,
      items: [...canonicalStore.items, { ...canonicalStore.items[0], id: 'latest-tool', title: '最新工具' }],
    };
    let resolveFirstReadback;
    const firstReadback = new Promise((resolve) => {
      resolveFirstReadback = resolve;
    });
    mocks.saveProfileSetting
      .mockResolvedValueOnce(profileSetting(firstStore))
      .mockResolvedValueOnce(profileSetting(secondStore));
    mocks.getProfileSetting
      .mockImplementationOnce(() => firstReadback)
      .mockResolvedValueOnce(profileSetting(secondStore));

    const firstSave = savePromptLibraryStore(firstStore);
    await vi.waitFor(() => expect(mocks.getProfileSetting).toHaveBeenCalledTimes(1));
    const secondSave = savePromptLibraryStore(secondStore);
    resolveFirstReadback(profileSetting(firstStore));

    await Promise.all([firstSave, secondSave]);

    expect(readPromptLibraryItems().some((item) => item.id === 'latest-tool')).toBe(true);
  });
});
