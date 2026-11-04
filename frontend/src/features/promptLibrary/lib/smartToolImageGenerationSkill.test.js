import { describe, expect, it } from 'vitest';
import { getDefaultPromptLibraryItems } from './promptLibraryStore.jsx';

describe('image-generation skill', () => {
  it('ships as a preset auto-generation skill with upload safety rules', () => {
    const tool = getDefaultPromptLibraryItems().find((item) => item.id === 'ozon-product-image-generation');

    expect(tool).toBeTruthy();
    expect(tool.scene).toBe('image');
    expect(tool.skillProfile).toMatchObject({
      runType: 'preset-auto-image-generation',
      modelCapability: 'image-generation',
      usageInputs: ['商品图片或商品 SKU', 'SKU 信息', '目标场景（可选）'],
    });
    expect(tool.promptConfig.workflowSteps).toHaveLength(6);
    expect(tool.promptConfig.workflowSteps.join('\n')).toContain('预设位置规则');
    expect(tool.promptConfig.workflowSteps.join('\n')).toContain('无需中间确认');
    expect(tool.promptConfig.safetyRules.join('\n')).toContain('上传前必须人工选择');
  });
});
