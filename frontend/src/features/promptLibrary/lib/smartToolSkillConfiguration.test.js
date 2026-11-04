import { describe, expect, it } from 'vitest';
import {
  createDefaultAttributeRules,
  createEmptyImagePositionRules,
  createDefaultImagePositionRules,
  formatAttributeRulesForPrompt,
  formatGlobalSkillRulesForAttributePrompt,
  getImagePositionRule,
  joinSkillSystemPromptSections,
  mergeImagePositionRuleDefaults,
  normalizeImagePositionRules,
  normalizeAttributeRules,
  splitSkillSystemPromptSections,
} from './smartToolSkillConfiguration.js';

describe('smartToolSkillConfiguration', () => {
  it('splits a numbered Skill prompt into editable areas without losing content', () => {
    const prompt = [
      '你是商品图片规划师。',
      '先核对商品事实。',
      '',
      '一、商品身份锁定',
      '保持颜色和结构。',
      '',
      '二、禁止内容',
      '不要虚构配件。',
    ].join('\n');

    const sections = splitSkillSystemPromptSections(prompt);

    expect(sections.map((item) => item.title)).toEqual(['角色与任务', '一、商品身份锁定', '二、禁止内容']);
    expect(sections[1].label).toBe('商品不能改变的内容');
    expect(joinSkillSystemPromptSections(sections)).toBe(prompt);
  });

  it('creates the original hero and seven gallery position presets without fixing runtime count', () => {
    const rules = createDefaultImagePositionRules('ozon-product-image-generation');

    expect(rules.main).toHaveLength(8);
    expect(rules.detail).toHaveLength(7);
    expect(rules.main[0]).toMatchObject({ sourceIndex: 0, position: 1 });
    expect(rules.main[0].purpose).toBe('SKU 专属主卖点图');
    expect(rules.detail.map((item) => item.purpose)).toEqual([
      '核心卖点总览图',
      '材质与细节特写图',
      '真实使用场景图',
      '尺寸、容量或结构说明图',
      '功能与使用方式演示图',
      '适用人群与多场景图',
      '包装、配件与组合展示图',
    ]);
    expect(createEmptyImagePositionRules()).toEqual({ main: [], detail: [] });
  });

  it('fills missing legacy positions while preserving existing customized rules', () => {
    const rules = mergeImagePositionRuleDefaults({
      main: [{ sourceIndex: 0, purpose: '我的主图规则' }],
      detail: [{ sourceIndex: 1, purpose: '我的细节规则' }],
    }, 'ozon-product-image-generation');

    expect(rules.main).toHaveLength(8);
    expect(rules.detail).toHaveLength(7);
    expect(rules.main[0].purpose).toBe('我的主图规则');
    expect(rules.detail[1].purpose).toBe('我的细节规则');
    expect(rules.detail[6].purpose).toBe('包装、配件与组合展示图');
  });

  it('replaces the previous built-in five-slot defaults with the full original gallery mapping', () => {
    const rules = mergeImagePositionRuleDefaults({
      main: [{
        sourceIndex: 0,
        purpose: 'SKU 专属主卖点图',
        instructions: '商品保持清晰完整并位于视觉中心，使用符合商品用途的真实场景。',
        visibleText: '一个简短自然的俄语主标题，最多搭配 3 个有证据的短信息。',
        mustAvoid: '不要使用普通纯白空背景，不要显示测量线、尺寸箭头或未经确认的数字。',
      }],
      detail: [
        { purpose: '真实使用、安装或场景展示' },
        { purpose: '材质、边缘、纹理、接口或做工特写' },
        { purpose: '解释一个有证据的核心功能利益点' },
        { purpose: '适配、安装或使用关系' },
        { purpose: '规格、结构、材质、功能或包含物信息板' },
      ],
    }, 'ozon-product-image-generation');

    expect(rules.detail.map((item) => item.purpose)).toEqual([
      '核心卖点总览图',
      '材质与细节特写图',
      '真实使用场景图',
      '尺寸、容量或结构说明图',
      '功能与使用方式演示图',
      '适用人群与多场景图',
      '包装、配件与组合展示图',
    ]);
  });

  it('restores presets for blank legacy main slots without overwriting real custom rules', () => {
    const rules = mergeImagePositionRuleDefaults({
      main: [
        { sourceIndex: 0, purpose: '我的第一张主图' },
        { sourceIndex: 1 },
        { sourceIndex: 2, purpose: '', instructions: '', visibleText: '', mustAvoid: '' },
        { sourceIndex: 3 },
        { sourceIndex: 4 },
      ],
      detail: [],
    }, 'ozon-product-image-generation');

    expect(rules.main.map((item) => item.purpose)).toEqual([
      '我的第一张主图',
      '核心卖点总览图',
      '材质与细节特写图',
      '真实使用场景图',
      '尺寸、容量或结构说明图',
      '功能与使用方式演示图',
      '适用人群与多场景图',
      '包装、配件与组合展示图',
    ]);
  });

  it('keeps deliberately blank saved positions blank instead of restoring defaults', () => {
    const rules = normalizeImagePositionRules({ main: [{}], detail: [{}] });

    expect(rules.main[0].purpose).toBe('');
    expect(rules.detail[0].purpose).toBe('');
  });

  it('keeps arbitrary image bindings and reads a rule by its actual product image position', () => {
    const rules = normalizeImagePositionRules({
      main: [
        { sourceIndex: 7, purpose: '第八张展示包装内容' },
        { position: 2, purpose: '第二张使用场景' },
      ],
      detail: [],
    });

    expect(rules.main.map((item) => item.sourceIndex)).toEqual([1, 7]);
    expect(getImagePositionRule(rules, 'main', 7).purpose).toBe('第八张展示包装内容');
    expect(getImagePositionRule(rules, 'main', 3).purpose).toBe('');
    expect(getImagePositionRule(rules, 'main', 8, { useSkillFallback: true }).purpose).toBe('补充主图卖点图');
  });

  it('provides editable existing-product attribute rules and formats only filled sections for the model', () => {
    const defaults = createDefaultAttributeRules('ozon-product-image-generation');
    expect(defaults.optimizationGoal).toContain('当前已存在的 Ozon 商品资料');
    expect(defaults.protectedScope).toContain('Offer ID');

    const rules = normalizeAttributeRules({
      optimizationGoal: '只优化当前商品。',
      titleRules: '标题使用自然俄语。',
    });
    expect(formatAttributeRulesForPrompt(rules)).toContain('优化目标：\n只优化当前商品。');
    expect(formatAttributeRulesForPrompt(rules)).toContain('商品标题规则：\n标题使用自然俄语。');
    expect(formatAttributeRulesForPrompt(rules)).not.toContain('商品简介规则：');
  });

  it('reuses only attribute-safe common sections from the global image Skill', () => {
    const prompt = [
      '你是图片规划师。',
      '',
      '一、商品身份锁定',
      '不得改变当前 SKU。',
      '',
      '二、SKU 专属主图规则',
      '使用 3:4 画幅。',
      '',
      '三、全局禁止清单',
      '不得虚构参数。',
    ].join('\n');
    const formatted = formatGlobalSkillRulesForAttributePrompt(prompt);
    expect(formatted).toContain('商品不能改变的内容');
    expect(formatted).toContain('不得虚构参数');
    expect(formatted).not.toContain('3:4 画幅');
    expect(formatted).not.toContain('图片规划师');
  });
});
