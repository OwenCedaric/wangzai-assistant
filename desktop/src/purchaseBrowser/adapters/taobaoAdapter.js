import { createPurchasePlatformAdapter } from './basePurchasePlatformAdapter.js';

export const taobaoAdapter = createPurchasePlatformAdapter({
  id: 'taobao',
  label: '淘宝',
  hosts: ['taobao.com'],
  aliases: ['淘宝', 'taobao'],
});

