function finiteValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function createCommunityChartOptions({ type = 'line', options = {}, series = [] } = {}) {
  const valueFormatter = options.tooltip?.y?.formatter;
  const formatValue = (value) => value === null ? '—' : String(valueFormatter ? valueFormatter(value) : value);
  const accessibilityDescription = type === 'donut'
    ? series.map((value, index) => `${options.labels?.[index] ?? index + 1}：${finiteValue(value) ?? '未返回'}`).join('，')
    : series.map(item => `${item.name || '数据'}：${(item.data || []).map((value, index) => `${options.xaxis?.categories?.[index] ?? index + 1} ${finiteValue(value) ?? '未返回'}`).join('，')}`).join('；');
  const common = {
    animation: false,
    color: options.colors,
    textStyle: { fontFamily: options.chart?.fontFamily || 'sans-serif', fontSize: 13 },
    aria: { enabled: true, label: { description: accessibilityDescription } },
    legend: { show: options.legend?.show !== false },
  };
  if (type === 'donut') {
    const labels = options.plotOptions?.pie?.donut?.labels || {};
    const total = labels.total || {};
    const centerValue = total.formatter?.() ?? series.reduce((sum, value) => sum + (finiteValue(value) ?? 0), 0);
    const innerPercent = Math.max(0, Math.min(95, Number.parseFloat(options.plotOptions?.pie?.donut?.size || '70')));
    return {
      ...common,
      title: labels.show ? {
        text: String(total.label || ''), subtext: String(centerValue), left: 'center', top: '38%',
        textStyle: { color: total.color || '#334155', fontSize: 16, fontWeight: 700 },
        subtextStyle: { color: labels.value?.color || '#172554', fontSize: 28, fontWeight: 800 },
      } : undefined,
      tooltip: {
        show: options.tooltip?.enabled !== false, trigger: 'item', renderMode: 'richText',
        formatter: (item) => `${item.name}\n${formatValue(item.value)}`,
      },
      series: [{
        type: 'pie', radius: [`${innerPercent * 0.85}%`, '85%'],
        label: { show: false }, emphasis: { scale: false },
        data: series.map((value, index) => ({ value: finiteValue(value), name: String(options.labels?.[index] ?? '') })),
      }],
    };
  }
  const horizontal = type === 'bar' && options.plotOptions?.bar?.horizontal === true;
  const categoryAxis = {
    type: 'category', data: options.xaxis?.categories || [],
    axisLine: { show: false }, axisTick: { show: false },
    axisLabel: { hideOverlap: true, fontSize: 13 },
    ...(horizontal ? { inverse: true } : { boundaryGap: type === 'bar' }),
  };
  const valueAxis = {
    type: 'value', min: options.yaxis?.min,
    axisLabel: { fontSize: 13, formatter: options.yaxis?.labels?.formatter },
    splitLine: { show: options.grid?.show !== false },
  };
  return {
    ...common,
    grid: { left: horizontal ? 12 : 8, right: 16, top: 20, bottom: 12, containLabel: true },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    tooltip: {
      show: options.tooltip?.enabled !== false, trigger: 'axis', renderMode: 'richText',
      formatter: (items) => [String(items[0]?.axisValueLabel ?? ''), ...items.map((item) => `${item.seriesName}: ${formatValue(item.value)}`)].join('\n'),
    },
    series: series.map((item) => ({
      name: String(item.name ?? ''), type: type === 'bar' ? 'bar' : 'line',
      data: (item.data || []).map(finiteValue), connectNulls: false,
      smooth: options.stroke?.curve === 'smooth', showSymbol: false,
      lineStyle: { width: options.stroke?.width || 3 },
      ...(type === 'area' ? { areaStyle: { opacity: options.fill?.gradient?.opacityFrom ?? 0.2 } } : {}),
      ...(type === 'bar' ? { barMaxWidth: 24, itemStyle: { borderRadius: options.plotOptions?.bar?.borderRadius || 0 } } : {}),
    })),
  };
}
