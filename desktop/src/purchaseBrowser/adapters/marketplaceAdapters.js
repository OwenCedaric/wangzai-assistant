import { createPurchasePlatformAdapter } from './basePurchasePlatformAdapter.js';

export const jdAdapter = createPurchasePlatformAdapter({
  id: 'jd', label: '京东', hosts: ['jd.com'], aliases: ['京东', 'jd.com'],
});

export const wildberriesAdapter = createPurchasePlatformAdapter({
  id: 'wildberries', label: 'Wildberries', hosts: ['wildberries.ru'], aliases: ['wildberries'],
});

export const amazonAdapter = createPurchasePlatformAdapter({
  id: 'amazon', label: 'Amazon', hosts: ['amazon.com', 'amazon.de', 'amazon.co.uk'], aliases: ['amazon'],
});

export const temuAdapter = createPurchasePlatformAdapter({
  id: 'temu', label: 'Temu', hosts: ['temu.com'], aliases: ['temu'],
});

export const aliExpressAdapter = createPurchasePlatformAdapter({
  id: 'aliexpress', label: 'AliExpress', hosts: ['aliexpress.com', 'aliexpress.ru'], aliases: ['aliexpress'],
});

