import { describe, expect, it } from 'vitest';
import { createCommunityChartOptions } from './communityChartOptions.js';

describe('community charts preserve the business values', () => {
  it('keeps zeroes and missing days distinct and preserves currency formatters', () => {
    const chart = createCommunityChartOptions({
      type: 'area', series: [{ name: '销售额', data: [12.5, null, 0, undefined, 8] }],
      options: { xaxis: { categories: ['一', '二', '三', '四', '五'] }, tooltip: { y: { formatter: value => `￥${value.toFixed(2)}` } } },
    });
    expect(chart.series[0].data).toEqual([12.5, null, 0, null, 8]);
    expect(chart.series[0].connectNulls).toBe(false);
    expect(chart.tooltip.formatter([{ axisValueLabel: '一', seriesName: '销售额', value: 12.5 }])).toContain('￥12.50');
    expect(chart.xAxis.data).toEqual(['一', '二', '三', '四', '五']);
  });

  it('retains actual donut slices and the displayed total without synthetic data', () => {
    const chart = createCommunityChartOptions({ type: 'donut', series: [2, 5, 1, 1], options: {
      labels: ['待拍单', '待发货', '售后', '库存'], plotOptions: { pie: { donut: { labels: { show: true, total: { label: '待办', formatter: () => '9' } } } } },
    } });
    expect(chart.series[0].data.map(item => item.value)).toEqual([2, 5, 1, 1]);
    expect(chart.title.subtext).toBe('9');
    expect(createCommunityChartOptions({ type: 'donut', series: [] }).series[0].data).toEqual([]);
  });

  it('keeps horizontal categories in supplied order and avoids HTML tooltips', () => {
    const chart = createCommunityChartOptions({ type: 'bar', series: [{ name: '数量', data: [8, 2] }], options: {
      plotOptions: { bar: { horizontal: true } }, xaxis: { categories: ['<img src=x>', '第二类'] },
    } });
    expect(chart.yAxis).toMatchObject({ type: 'category', inverse: true, data: ['<img src=x>', '第二类'] });
    expect(chart.xAxis.type).toBe('value');
    expect(chart.tooltip.renderMode).toBe('richText');
  });
});
