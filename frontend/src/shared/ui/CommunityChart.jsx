import React from 'react';
import { init, use } from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { createCommunityChartOptions } from './communityChartOptions.js';

use([BarChart, LineChart, PieChart, AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent, SVGRenderer]);

export default function CommunityChart({ type, options, series, height = 280 }) {
  const element = React.useRef(null);
  const chart = React.useRef(null);
  const chartOptions = React.useMemo(() => createCommunityChartOptions({ type, options, series }), [type, options, series]);
  React.useEffect(() => {
    const instance = init(element.current, null, { renderer: 'svg' });
    chart.current = instance;
    const resize = () => instance.resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(element.current);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      chart.current = null;
      instance.dispose();
    };
  }, []);
  React.useEffect(() => {
    chart.current?.setOption(chartOptions, { notMerge: true });
    chart.current?.resize();
  }, [chartOptions, height]);
  return <div ref={element} className="community-chart" style={{ width: '100%', height }} data-testid="community-chart" />;
}
