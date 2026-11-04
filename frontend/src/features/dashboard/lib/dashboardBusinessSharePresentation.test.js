import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_BUSINESS_SHARE_TEXT_COLORS,
  createDashboardBusinessSharePresentation,
  getDashboardBusinessShareContrastRatio,
} from './dashboardBusinessSharePresentation.js';

describe('dashboard business share presentation', () => {
  it('keeps loading and error states distinct from a real zero result', () => {
    const loading = createDashboardBusinessSharePresentation({ status: 'loading', counts: null });
    const failed = createDashboardBusinessSharePresentation({ status: 'error', counts: null });
    const empty = createDashboardBusinessSharePresentation({ status: 'empty', counts: {} });

    expect(loading.status).toBe('loading');
    expect(loading.centerTotal).toBe('—');
    expect(failed.status).toBe('error');
    expect(failed.centerTotal).toBe('—');
    expect(empty.status).toBe('empty');
    expect(empty.centerTotal).toBe('0');
    expect(empty.values).toEqual([0, 0, 0, 0]);
    expect(empty.series).toEqual([]);
  });

  it('renders the four canonical counters and a readable center total', () => {
    const presentation = createDashboardBusinessSharePresentation({
      status: 'data',
      counts: {
        pendingPurchaseCount: 2,
        waitingDeliveryCount: 5,
        afterSalesTodoCount: 1,
        stockWarningCount: 1,
      },
    });

    expect(presentation.status).toBe('data');
    expect(presentation.values).toEqual([2, 5, 1, 1]);
    expect(presentation.series).toEqual([2, 5, 1, 1]);
    expect(presentation.total).toBe(9);
    expect(presentation.centerTotal).toBe('9');
  });

  it('keeps every normal text tone above the 4.5:1 contrast requirement on white', () => {
    Object.values(DASHBOARD_BUSINESS_SHARE_TEXT_COLORS).forEach((color) => {
      expect(getDashboardBusinessShareContrastRatio(color, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    });
  });
});
