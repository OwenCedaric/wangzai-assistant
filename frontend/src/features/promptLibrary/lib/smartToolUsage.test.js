import { describe, expect, it } from 'vitest';
import {
  getSmartToolUsageInputHelperText,
  getSmartToolUsageInputPlaceholder,
  getSmartToolUsageInputSpec,
  getSmartToolUsageInputs,
  validateSmartToolUsageInput,
} from './smartToolUsage.js';

describe('smartToolUsage', () => {
  it('returns an empty input list before a tool has been selected', () => {
    expect(getSmartToolUsageInputs(null)).toEqual([]);
  });

  it('prefers the ordinary usage inputs declared by the skill profile', () => {
    expect(
      getSmartToolUsageInputs({
        variables: ['高级字段'],
        skillProfile: { usageInputs: ['商品名称或 SKU'] },
      })
    ).toEqual(['商品名称或 SKU']);
  });

  it('upgrades persisted Seerfar tools to the canonical user-facing input label', () => {
    const tool = {
      id: 'linkfox-seerfar-ozon-keyword-back-search',
      skillProfile: { usageInputs: ['旧的 Ozon SKU 输入'] },
    };
    expect(getSmartToolUsageInputs(tool)).toEqual(['商品 SKU 或链接（最多20个）']);
    expect(getSmartToolUsageInputSpec(tool, '商品 SKU 或链接（最多20个）')).toMatchObject({
      multiple: true,
      maxItems: 20,
      minRows: 2,
    });
    expect(getSmartToolUsageInputPlaceholder('商品 SKU 或链接（最多20个）', tool))
      .toContain('4380710124');
  });

  it('广告分析普通使用层只保留账号、计划和统计范围', () => {
    const tool = {
      id: 'ozon-ad-analyzer',
      skillProfile: { usageInputs: ['旧广告活动字段'] },
    };
    expect(getSmartToolUsageInputs(tool)).toEqual([
      '推广账号（可选）',
      '广告计划名称或 ID（可选）',
      '统计范围',
    ]);
    expect(getSmartToolUsageInputSpec(tool, '统计范围')).toMatchObject({
      control: 'select',
      defaultValue: '7',
    });
    expect(validateSmartToolUsageInput(tool, '推广账号（可选）', '')).toBe('');
    expect(validateSmartToolUsageInput(tool, '广告计划名称或 ID（可选）', '')).toBe('');
    expect(validateSmartToolUsageInput(tool, '统计范围', '14')).toBe('');
    expect(validateSmartToolUsageInput(tool, '统计范围', '90')).toContain('有效的统计范围');
  });

  it('adds a dedicated competitor-or-own analysis choice to product detail', () => {
    const tool = { id: 'linkfox-seerfar-ozon-product-detail-search' };
    expect(getSmartToolUsageInputs(tool)).toEqual([
      '分析对象',
      '商品 SKU 或链接',
      '商品成本（₽）',
      '平台佣金率（%）',
      '履约费用（₽/单）',
      '税费率（%）',
      '退货取消率（%）',
    ]);
    expect(getSmartToolUsageInputSpec(tool, '分析对象')).toMatchObject({
      control: 'select',
      defaultValue: 'competitor',
      options: [
        { value: 'competitor', label: '竞对商品分析' },
        { value: 'own', label: '自己商品分析' },
      ],
    });
    expect(validateSmartToolUsageInput(tool, '分析对象', 'competitor')).toBe('');
    expect(validateSmartToolUsageInput(tool, '分析对象', 'unknown')).toContain('有效的分析对象');
    expect(validateSmartToolUsageInput(tool, '商品成本（₽）', '')).toBe('');
    expect(validateSmartToolUsageInput(tool, '平台佣金率（%）', '120')).toContain('0 到 100');
  });

  it('counts batch input and rejects malformed or oversized reverse-search values', () => {
    const toolId = 'linkfox-seerfar-ozon-keyword-back-search';
    const label = '商品 SKU 或链接（最多20个）';
    expect(getSmartToolUsageInputHelperText(toolId, label, '4380710124, 175924376'))
      .toContain('已输入 2/20');
    expect(validateSmartToolUsageInput(toolId, label, '4380710124 bad-sku'))
      .toContain('数字 SKU');
    expect(validateSmartToolUsageInput(
      toolId,
      label,
      Array.from({ length: 21 }, (_, index) => String(1000 + index)).join('\n')
    )).toContain('最多填写 20 项');
  });

  it('keeps the market keyword input optional and validates exact category ids', () => {
    const marketLabel = '关键词或筛选条件（可多个）';
    expect(getSmartToolUsageInputSpec('linkfox-seerfar-ozon-market-keyword-search', marketLabel))
      .toMatchObject({ multiple: true, maxItems: 1000, validator: 'market-keyword-filters' });
    expect(validateSmartToolUsageInput(
      'linkfox-seerfar-ozon-market-keyword-search',
      marketLabel,
      ''
    )).toBe('');
    expect(validateSmartToolUsageInput(
      'linkfox-seerfar-ozon-market-keyword-search',
      marketLabel,
      '搜索量>=10000\n卖家数<=50\n排序：月搜增长降序'
    )).toBe('');
    expect(validateSmartToolUsageInput(
      'linkfox-seerfar-ozon-market-keyword-search',
      marketLabel,
      '日期：2026-99'
    )).toContain('YYYY-MM-DD');
    expect(validateSmartToolUsageInput(
      'linkfox-seerfar-ozon-category-search',
      'Seerfar 类目 ID',
      '15621032_15621049_115951147'
    )).toBe('');
    expect(validateSmartToolUsageInput(
      'linkfox-seerfar-ozon-category-search',
      'Seerfar 类目 ID',
      '连衣裙'
    )).toContain('数字和下划线');
  });

  it('limits product-filter SKU references and rejects links without a SKU', () => {
    const toolId = 'linkfox-seerfar-ozon-product-report-search';
    const label = '商品关键词、SKU 或链接（可多个）';
    expect(validateSmartToolUsageInput(
      toolId,
      label,
      Array.from({ length: 11 }, (_, index) => String(175924376 + index)).join('\n')
    )).toContain('最多填写 10 个');
    expect(validateSmartToolUsageInput(toolId, label, 'https://www.ozon.ru/product/no-sku/'))
      .toContain('没有识别到 SKU');
    expect(validateSmartToolUsageInput(toolId, label, 'https://example.com/product/demo-175924376/'))
      .toContain('没有识别到 SKU');
  });

  it('accepts Ozon self-operated negative shop ids but rejects unrelated numeric links', () => {
    const toolId = 'linkfox-seerfar-ozon-shop-search';
    const label = '店铺 ID 或链接';
    expect(validateSmartToolUsageInput(toolId, label, '-2')).toBe('');
    expect(validateSmartToolUsageInput(toolId, label, 'https://example.com/seller/demo-1275208/'))
      .toContain('Ozon 店铺链接');
  });
});
