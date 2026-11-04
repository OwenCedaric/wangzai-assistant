import { describe, expect, it } from 'vitest';
import { structuredSettingsLayouts } from './appConfigRuntime.jsx';

describe('settings explanation-card visibility', () => {
  it('keeps the cross-border and purchase-account helper cards removed', () => {
    expect(structuredSettingsLayouts.crossBorderBus.showNote).toBe(false);
    expect(structuredSettingsLayouts.purchaseAccount.showNote).toBe(false);
    expect(structuredSettingsLayouts.crossBorderBus.note).toBeUndefined();
    expect(structuredSettingsLayouts.purchaseAccount.note).toBeUndefined();
  });
});
