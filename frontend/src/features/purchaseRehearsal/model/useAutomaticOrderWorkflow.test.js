import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPurchaseAutoPayScheduleActive } from './useAutomaticOrderWorkflow.js';

describe('automatic payment schedule', () => {
  it('keeps the global switch authoritative and honors a daytime window', () => {
    const settings = {
      enabled: true,
      needAutoStart: true,
      autoStartTime: '08:00:00',
      needAutoEnd: true,
      autoEndTime: '23:00:00',
    };
    expect(isPurchaseAutoPayScheduleActive(settings, new Date(2026, 7, 26, 12, 0, 0))).toBe(true);
    expect(isPurchaseAutoPayScheduleActive(settings, new Date(2026, 7, 26, 7, 59, 59))).toBe(false);
    expect(isPurchaseAutoPayScheduleActive({ ...settings, enabled: false }, new Date(2026, 7, 26, 12, 0, 0))).toBe(false);
  });

  it('supports an overnight automatic-payment window', () => {
    const settings = {
      enabled: true,
      needAutoStart: true,
      autoStartTime: '22:00:00',
      needAutoEnd: true,
      autoEndTime: '06:00:00',
    };
    expect(isPurchaseAutoPayScheduleActive(settings, new Date(2026, 7, 26, 23, 0, 0))).toBe(true);
    expect(isPurchaseAutoPayScheduleActive(settings, new Date(2026, 7, 27, 5, 59, 0))).toBe(true);
    expect(isPurchaseAutoPayScheduleActive(settings, new Date(2026, 7, 27, 12, 0, 0))).toBe(false);
  });

  it('reloads the automatic-order workspace immediately after a source binding is saved', () => {
    const source = fs.readFileSync(path.join(
      process.cwd(),
      'src/features/purchaseRehearsal/model/useAutomaticOrderWorkflow.js',
    ), 'utf8');
    expect(source).toContain("addEventListener?.('wangzai:auto-order-binding-saved', handleBindingSaved)");
    expect(source).toContain('const handleBindingSaved = () => { void refresh(); };');
    expect(source).toContain("addEventListener?.('wangzai:purchase-order-overrides-updated', handlePurchaseOverrideUpdated)");
    const purchaseDatasetSource = fs.readFileSync(path.join(
      process.cwd(),
      'src/features/orders/purchase/model/usePurchaseOrdersDatasetState.jsx',
    ), 'utf8');
    expect(purchaseDatasetSource).toContain("addEventListener?.('wangzai:purchase-order-overrides-updated', handlePurchaseOverrideUpdated)");
  });
});
