import { describe, expect, it } from 'vitest';
import { stabilizeChartOptions } from './ChartSupport.jsx';

describe('stabilizeChartOptions', () => {
  it('disables delayed ApexCharts animation callbacks without losing chart options', () => {
    const source = {
      chart: { id: 'sales', toolbar: { show: false }, animations: { speed: 240 } },
      colors: ['#123456'],
    };
    const result = stabilizeChartOptions(source);
    expect(result).toMatchObject({
      chart: {
        id: 'sales',
        toolbar: { show: false },
        animations: { enabled: false, speed: 240, dynamicAnimation: { enabled: false } },
      },
      colors: ['#123456'],
    });
    expect(source.chart.animations).toEqual({ speed: 240 });
  });

  it('accepts an absent or malformed options object', () => {
    expect(stabilizeChartOptions(null)).toMatchObject({
      chart: { animations: { enabled: false, dynamicAnimation: { enabled: false } } },
    });
  });
});
