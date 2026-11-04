export const DASHBOARD_BUSINESS_SHARE_ITEMS = Object.freeze([
  { key: 'pendingPurchaseCount', label: '待拍单', color: '#5d87ff' },
  { key: 'waitingDeliveryCount', label: '待备货/发货', color: '#49beff' },
  { key: 'afterSalesTodoCount', label: '售后处理中', color: '#13deb9' },
  { key: 'stockWarningCount', label: '库存预警', color: '#ffae1f' },
]);

export const DASHBOARD_BUSINESS_SHARE_TEXT_COLORS = Object.freeze({
  primary: '#172554',
  secondary: '#334155',
  success: '#065f46',
  error: '#b91c1c',
  loading: '#475569',
});

function toCount(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function normalizeCounts(counts = {}) {
  const source = counts && typeof counts === 'object' && !Array.isArray(counts) ? counts : {};
  return Object.fromEntries(DASHBOARD_BUSINESS_SHARE_ITEMS.map(({ key }) => [key, toCount(source[key])]));
}

function toRgb(color = '') {
  const hex = String(color).replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/u.test(hex)) return null;
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
}

function relativeLuminance(color = '') {
  const rgb = toRgb(color);
  if (!rgb) return 0;
  const linear = rgb.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function getDashboardBusinessShareContrastRatio(foreground, background = '#ffffff') {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function getStatusPresentation(status, total) {
  if (status === 'error') {
    return {
      centerLabel: '读取失败',
      centerTotal: '—',
      statusText: '本地 SQLite 读取失败，请刷新重试',
      textColor: DASHBOARD_BUSINESS_SHARE_TEXT_COLORS.error,
      stateLabel: '读取失败',
    };
  }
  if (status === 'loading') {
    return {
      centerLabel: '读取中',
      centerTotal: '—',
      statusText: '正在读取本地 SQLite 数据',
      textColor: DASHBOARD_BUSINESS_SHARE_TEXT_COLORS.loading,
      stateLabel: '正在读取',
    };
  }
  if (total === 0) {
    return {
      centerLabel: '数据',
      centerTotal: '0',
      statusText: '本地 SQLite 暂无该店铺数据',
      textColor: DASHBOARD_BUSINESS_SHARE_TEXT_COLORS.secondary,
      stateLabel: '暂无数据',
    };
  }
  return {
    centerLabel: '待办',
    centerTotal: total.toLocaleString('zh-CN'),
    statusText: '已读取本地 SQLite 数据',
    textColor: DASHBOARD_BUSINESS_SHARE_TEXT_COLORS.success,
    stateLabel: '',
  };
}

/** Creates the donut view model without treating loading/errors as real zero data. */
export function createDashboardBusinessSharePresentation({ status = 'loading', counts = {} } = {}) {
  const normalizedCounts = normalizeCounts(counts);
  const values = DASHBOARD_BUSINESS_SHARE_ITEMS.map(({ key }) => normalizedCounts[key]);
  const total = values.reduce((sum, value) => sum + value, 0);
  const resolvedStatus = status === 'data' && total === 0 ? 'empty' : status;
  const hasData = resolvedStatus === 'data' && total > 0;
  const statusPresentation = getStatusPresentation(resolvedStatus, total);
  const chartLabels = hasData ? DASHBOARD_BUSINESS_SHARE_ITEMS.map(({ label }) => label) : [];
  const chartColors = hasData ? DASHBOARD_BUSINESS_SHARE_ITEMS.map(({ color }) => color) : [];

  return {
    status: resolvedStatus,
    hasData,
    counts: normalizedCounts,
    total,
    items: DASHBOARD_BUSINESS_SHARE_ITEMS.map((item) => ({ ...item, value: normalizedCounts[item.key] })),
    values,
    centerLabel: statusPresentation.centerLabel,
    centerTotal: statusPresentation.centerTotal,
    statusText: statusPresentation.statusText,
    statusColor: statusPresentation.textColor,
    stateLabel: statusPresentation.stateLabel,
    series: hasData ? values : [],
    options: {
      chart: { animations: { enabled: false }, fontFamily: 'inherit' },
      labels: chartLabels,
      colors: chartColors,
      dataLabels: { enabled: false },
      legend: { show: false },
      stroke: { width: 0 },
      tooltip: hasData
        ? { y: { formatter: (value) => `${toCount(value).toLocaleString('zh-CN')} 项` } }
        : { enabled: false },
      plotOptions: {
        pie: {
          donut: {
            size: '72%',
            labels: {
              show: true,
              name: {
                show: true,
                color: DASHBOARD_BUSINESS_SHARE_TEXT_COLORS.secondary,
                fontSize: '16px',
                fontWeight: 700,
              },
              value: {
                show: true,
                color: DASHBOARD_BUSINESS_SHARE_TEXT_COLORS.primary,
                fontSize: '28px',
                fontWeight: 800,
                formatter: () => statusPresentation.centerTotal,
              },
              total: {
                show: true,
                showAlways: true,
                label: statusPresentation.centerLabel,
                color: DASHBOARD_BUSINESS_SHARE_TEXT_COLORS.secondary,
                fontSize: '16px',
                fontWeight: 700,
                formatter: () => statusPresentation.centerTotal,
              },
            },
          },
        },
      },
    },
  };
}
