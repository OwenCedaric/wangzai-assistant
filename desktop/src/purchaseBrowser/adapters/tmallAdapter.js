import { createPurchasePlatformAdapter } from './basePurchasePlatformAdapter.js';

export const tmallAdapter = createPurchasePlatformAdapter({
  id: 'tmall',
  label: '天猫',
  hosts: ['tmall.com'],
  aliases: ['天猫', 'tmall'],
});

