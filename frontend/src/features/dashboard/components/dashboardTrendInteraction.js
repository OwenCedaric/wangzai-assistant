function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function resolveDashboardTrendHover({ clientX, rect, pointCount }) {
  const safePointCount = Math.max(0, Number(pointCount) || 0);
  const width = Number(rect?.width) || 0;
  if (!width || safePointCount < 1) return null;

  const relativeX = clamp((Number(clientX) - (Number(rect?.left) || 0)) / width, 0, 1);
  const lastIndex = Math.max(0, safePointCount - 1);
  const index = Math.round(relativeX * lastIndex);

  return {
    index,
    ratio: lastIndex ? index / lastIndex : 0,
  };
}
