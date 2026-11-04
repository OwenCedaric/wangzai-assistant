import { createPurchasePlatformAdapter } from './basePurchasePlatformAdapter.js';

const baseAdapter = createPurchasePlatformAdapter({
  id: 'ozon-buyer',
  label: 'Ozon买家',
  hosts: ['ozon.ru'],
  aliases: ['Ozon买家', 'Ozon Buyer'],
});

export const ozonBuyerAdapter = Object.freeze({
  ...baseAdapter,
  detect(url, pageTitle = '', pageText = '') {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (hostname === 'seller.ozon.ru' || hostname.endsWith('.seller.ozon.ru')) return 0;
    } catch {
      // Text fallback is still useful for captured fixture pages.
    }
    return baseAdapter.detect(url, pageTitle, pageText);
  },
});
