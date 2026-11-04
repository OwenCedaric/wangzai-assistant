import { describe, expect, it } from 'vitest';
import {
  getPurchaseAccountPresetByAlias,
  getPurchaseAccountPresetByPlatform,
  PURCHASE_ACCOUNT_PRESETS,
  resolvePurchaseAccountPreset,
} from './purchaseAccountPresets.js';

describe('purchase account presets', () => {
  it('keeps the supported collection platforms, account aliases, and entry URLs fixed', () => {
    expect(PURCHASE_ACCOUNT_PRESETS).toEqual([
      {
        platformCode: 'pdd',
        platformName: '拼多多',
        accountAlias: '拼多多采购号',
        platformUrl: 'https://mobile.yangkeduo.com/',
      },
      {
        platformCode: 'tmall',
        platformName: '天猫',
        accountAlias: '天猫采购号',
        platformUrl: 'https://www.tmall.com/',
      },
      {
        platformCode: 'taobao',
        platformName: '淘宝',
        accountAlias: '淘宝采购号',
        platformUrl: 'https://www.taobao.com/',
      },
      {
        platformCode: '1688',
        platformName: '1688',
        accountAlias: '1688采购号',
        platformUrl: 'https://www.1688.com/',
      },
      {
        platformCode: 'ozon-buyer',
        platformName: 'Ozon买家',
        accountAlias: 'Ozon买家采购号',
        platformUrl: 'https://www.ozon.ru/',
      },
      {
        platformCode: 'jd',
        platformName: '京东',
        accountAlias: '京东采购号',
        platformUrl: 'https://www.jd.com/',
      },
      {
        platformCode: 'wildberries',
        platformName: 'Wildberries',
        accountAlias: 'Wildberries采购号',
        platformUrl: 'https://www.wildberries.ru/',
      },
      {
        platformCode: 'amazon',
        platformName: 'Amazon',
        accountAlias: 'Amazon采购号',
        platformUrl: 'https://www.amazon.com/',
      },
      {
        platformCode: 'temu',
        platformName: 'Temu',
        accountAlias: 'Temu采购号',
        platformUrl: 'https://www.temu.com/',
      },
      {
        platformCode: 'aliexpress',
        platformName: 'AliExpress',
        accountAlias: 'AliExpress采购号',
        platformUrl: 'https://www.aliexpress.com/',
      },
    ]);
  });

  it('resolves a preset from either side of the linked selector', () => {
    expect(getPurchaseAccountPresetByPlatform('拼多多')?.accountAlias).toBe('拼多多采购号');
    expect(getPurchaseAccountPresetByAlias('1688 采购号')?.platformName).toBe('1688');
    expect(resolvePurchaseAccountPreset({ accountAlias: '天猫采购号' })?.platformUrl).toBe(
      'https://www.tmall.com/'
    );
    expect(getPurchaseAccountPresetByPlatform('Ozon买家')?.platformUrl).toBe('https://www.ozon.ru/');
  });
});
