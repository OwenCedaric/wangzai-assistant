import { describe, expect, it } from 'vitest';
import {
  isWideDataAnalysisReportSection,
  parseDataAnalysisInsightSections,
  parseDataAnalysisReportBody,
  selectDataAnalysisReportMetrics,
} from './dataAnalysisInsightReport.js';

describe('dataAnalysisInsightReport', () => {
  it('parses markdown headings, labeled evidence and action lists into report blocks', () => {
    const sections = parseDataAnalysisInsightSections([
      '**一、总体结论**',
      '结论：当前转化偏低。',
      '## 二、优先行动',
      '- 核对价格',
      '2. 补齐库存',
    ].join('\n'));

    expect(sections.map((section) => section.title)).toEqual(['总体结论', '优先行动']);
    expect(parseDataAnalysisReportBody(sections[0].body)).toEqual([
      { type: 'label', label: '结论', text: '当前转化偏低。' },
    ]);
    expect(parseDataAnalysisReportBody(sections[1].body)).toEqual([
      { type: 'list', items: ['核对价格', '补齐库存'] },
    ]);
  });

  it('selects the frozen metric order and expands an unpaired last section', () => {
    const metrics = selectDataAnalysisReportMetrics({
      overview: {
        metrics: [
          { id: 'outOfStockCount', label: '缺货' },
          { id: 'salesAmount', label: '销售额' },
          { id: 'ignored', label: '不进入报告' },
        ],
      },
    });

    expect(metrics.map((metric) => metric.id)).toEqual(['salesAmount', 'outOfStockCount']);
    expect(isWideDataAnalysisReportSection({ title: '销售与商品', index: 2, count: 3 })).toBe(true);
    expect(isWideDataAnalysisReportSection({ title: '优先行动清单', index: 0, count: 2 })).toBe(true);
    expect(isWideDataAnalysisReportSection({ title: '销售与商品', index: 0, count: 2 })).toBe(false);
  });
});
