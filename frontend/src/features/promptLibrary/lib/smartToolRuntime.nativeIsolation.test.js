import { describe, expect, it } from 'vitest';
import { promptLibraryItems } from './promptLibraryStore.jsx';
import { isUserInstalledSmartTool } from './smartToolInstalledSkill.js';
import { createSmartToolMeta } from './smartToolRuntime.js';

describe('smartToolRuntime native Skill isolation', () => {
  it('keeps every native catalog Skill outside the installed-Skill framework', () => {
    const nativeItems = promptLibraryItems.filter((item) => !isUserInstalledSmartTool(item));

    expect(nativeItems.length).toBeGreaterThan(10);
    nativeItems.forEach((item) => {
      const meta = createSmartToolMeta(item);
      expect(meta, item.id).not.toHaveProperty('apiCapabilityMatch');
      expect(meta, item.id).not.toHaveProperty('adapterStatus');
      expect(meta, item.id).not.toHaveProperty('adapterKey');
      expect(meta.primaryActionLabel, item.id).not.toBe('查看缺少能力');
      expect(meta.primaryActionLabel, item.id).not.toBe('查看适配要求');
    });
  });

  it('keeps a native Skill on its original status contract without generic metadata', () => {
    const meta = createSmartToolMeta({
      id: 'ozon-skill-1688-channel-shopdata-get',
      title: 'Ozon 报表读取与分析',
      goal: '读取经营报表',
      scene: 'report',
      status: '可用',
      skillProfile: {
        runType: 'local-readonly',
        apiBindings: [{ id: 'model.text.generate', label: '文本模型', access: 'read' }],
      },
    });

    expect(meta.availabilityLabel).toBe('能用');
    expect(meta.primaryActionLabel).toBe('使用功能');
    expect(meta).not.toHaveProperty('apiCapabilityMatch');
    expect(meta).not.toHaveProperty('adapterStatus');
    expect(meta).not.toHaveProperty('adapterKey');
  });

  it('keeps API matching and execution plans for a user-installed Skill', () => {
    const meta = createSmartToolMeta({
      id: 'installed-report-skill',
      title: '安装的报表 Skill',
      goal: '整理经营数据',
      body: 'Read business data and generate an analysis report.',
      scene: 'report',
      status: '可用',
      skillProfile: {
        installType: 'skill-md',
        sourceHash: 'hash-installed-report',
        runType: 'api-assisted-readonly',
        apiBindings: [{ id: 'model.text.generate', label: '文本模型', access: 'read' }],
      },
    });

    expect(meta.apiCapabilityMatch).toBeTruthy();
    expect(meta.apiCapabilityMatch.executionPlan.totalCount).toBeGreaterThan(0);
    expect(meta.adapterKey).toBe('builtin.generic-skill-runtime');
  });
});
