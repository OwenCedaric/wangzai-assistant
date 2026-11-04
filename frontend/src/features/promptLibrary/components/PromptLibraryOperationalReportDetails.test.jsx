import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  arrangeOperationalReportSections,
  normalizeOperationalReportSections,
  PromptLibraryOperationalReportDetails,
} from './PromptLibraryOperationalReportDetails.jsx';

describe('PromptLibraryOperationalReportDetails', () => {
  const sections = [
    {
      title: '经营概览',
      rows: ['访问次数：65,093', '活动带来销售额：官方未返回'],
    },
    {
      title: '商品销售排行',
      rows: [
        '第 1 名｜测试商品｜商家货号 SKU-1｜销量 9件｜订单 8单｜销售额 ￥2,367.00',
        '只有项目名称',
      ],
    },
    {
      title: '营销指标',
      rows: ['当前参与商品：1,830'],
    },
    {
      title: '活动类型',
      rows: ['库存折扣｜活动 3个', '弹性促销｜活动 1个'],
    },
  ];

  it('过滤没有有效值的项目，并把字段和值拆开', () => {
    expect(normalizeOperationalReportSections(sections)).toEqual([
      {
        title: '经营概览',
        mode: 'metrics',
        rows: [{ label: '访问次数', value: '65,093' }],
      },
      {
        title: '商品销售排行',
        mode: 'details',
        rows: [{
          primary: '第 1 名 · 测试商品',
          fields: [
            { label: '商家货号', value: 'SKU-1' },
            { label: '销量', value: '9件' },
            { label: '订单', value: '8单' },
            { label: '销售额', value: '￥2,367.00' },
          ],
        }],
      },
      {
        title: '营销指标',
        mode: 'metrics',
        rows: [{ label: '当前参与商品', value: '1,830' }],
      },
      {
        title: '活动类型',
        mode: 'details',
        rows: [
          { primary: '库存折扣', fields: [{ label: '活动', value: '3个' }] },
          { primary: '弹性促销', fields: [{ label: '活动', value: '1个' }] },
        ],
      },
    ]);
  });

  it('只在同一经营分组内把两个短模块配成一行', () => {
    const arranged = arrangeOperationalReportSections(normalizeOperationalReportSections(sections));
    expect(arranged.find((section) => section.title === '营销指标')?.layout).toBe('compact');
    expect(arranged.find((section) => section.title === '活动类型')?.layout).toBe('compact');
    expect(arranged.find((section) => section.title === '经营概览')?.layout).toBe('wide');
    expect(arranged.find((section) => section.title === '商品销售排行')?.layout).toBe('wide');
  });

  it('按指标卡和结构化明细行完整展示', () => {
    render(<PromptLibraryOperationalReportDetails sections={sections} />);

    expect(screen.getByRole('heading', { name: '报表明细依据' })).toBeVisible();
    expect(screen.getByText('4 组 · 5 条')).toBeVisible();
    expect(screen.getByText('访问次数')).toBeVisible();
    expect(screen.getByText('65,093')).toBeVisible();
    expect(screen.getByText('第 1 名 · 测试商品')).toBeVisible();
    expect(screen.getByText('商家货号')).toBeVisible();
    expect(screen.getByText('SKU-1')).toBeVisible();
    expect(screen.queryByText('活动带来销售额')).not.toBeInTheDocument();
    expect(screen.queryByText('只有项目名称')).not.toBeInTheDocument();
    expect(screen.getByText('活动类型').closest('.prompt-library-operational-detail-section'))
      .toHaveClass('is-compact');
  });

  it('类目分布使用独立的多列网格', () => {
    render(<PromptLibraryOperationalReportDetails sections={[{
      title: '类目分布',
      rows: [
        '汽车用品 > 汽车外部部件｜商品 795个',
        '儿童用品 > 玩具 > 积木｜商品 234个',
      ],
    }]} />);

    expect(screen.getByText('类目分布').closest('.prompt-library-operational-detail-section'))
      .toHaveClass('is-category-grid');
    expect(screen.getByText('汽车用品 > 汽车外部部件')).toBeVisible();
    expect(screen.getByText('795个')).toBeVisible();
    expect(screen.getByText('儿童用品 > 玩具 > 积木')).toBeVisible();
    expect(screen.getByText('234个')).toBeVisible();
  });
});
