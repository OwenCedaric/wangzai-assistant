import { describe, expect, it } from 'vitest';

import { collectionSourcePlatformOptions } from './collectionPricingRules.js';

describe('collection source platform options', () => {
  it('only exposes the five collection platforms kept in the workbench', () => {
    expect(collectionSourcePlatformOptions).toEqual([
      { value: 'ozon-buyer', label: 'Ozon 竞品' },
      { value: '1688', label: '1688' },
      { value: 'pdd', label: '拼多多' },
      { value: 'taobao', label: '淘宝' },
      { value: 'tmall', label: '天猫' },
    ]);
  });
});
