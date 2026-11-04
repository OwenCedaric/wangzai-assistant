import { describe, expect, it } from 'vitest';
import {
  formatCnyAmount,
  formatMetric,
  formatMoney,
  formatPercent,
  formatPlainNumber,
  getStatusTone,
  isMissingMetricValue,
  normalizeText,
} from './paidPromotionFormatters.js';

describe('paid promotion presentation formatters', () => {
  it('preserves the existing numeric and status display values after component extraction', () => {
    expect(normalizeText('  Ozon  ')).toBe('Ozon');
    expect(isMissingMetricValue('')).toBe(true);
    expect(formatCnyAmount(null)).toBe('未返回');
    expect(formatMoney(0, null)).toBe('¥ 0.00');
    expect(formatMoney(100, null)).toBe('100.00 卢布');
    expect(formatMoney(100, 0.08)).toBe('¥ 8.00');
    expect(formatPlainNumber(12345)).toBe('12,345');
    expect(formatMetric(1234, ' 次')).toBe('1,234 次');
    expect(formatPercent(12.345)).toBe('12.35%');
    expect(getStatusTone({ statusLabel: '运行中' })).toBe('success');
    expect(getStatusTone({ alerts: { moderationRejected: true } })).toBe('error');
  });
});
