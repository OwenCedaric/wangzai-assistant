import { createPurchasePlatformAdapter } from './basePurchasePlatformAdapter.js';

export const pinduoduoAdapter = createPurchasePlatformAdapter({
  id: 'pinduoduo',
  label: '拼多多',
  hosts: ['yangkeduo.com', 'pinduoduo.com'],
  aliases: ['拼多多', 'pinduoduo'],
});

