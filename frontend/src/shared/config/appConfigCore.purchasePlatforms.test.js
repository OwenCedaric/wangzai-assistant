import { describe, expect, it } from 'vitest';
import { PURCHASE_SOURCE_PLATFORMS } from './appConfigCore.jsx';

describe('purchase source platform shortcuts', () => {
  it('only exposes the supported purchase shortcuts', () => {
    expect(PURCHASE_SOURCE_PLATFORMS).toEqual([
      'PDD',
      '1688',
      '淘宝',
      '天猫',
      'Ozon买家',
    ]);
  });

  it.each(['京东', 'Wildberries', 'Amazon', 'Temu', 'AliExpress'])(
    'does not expose the retired %s shortcut',
    (platform) => {
      expect(PURCHASE_SOURCE_PLATFORMS).not.toContain(platform);
    }
  );
});
