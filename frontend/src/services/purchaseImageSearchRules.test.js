import { describe, expect, it } from 'vitest';
import {
  buildPurchaseDirectImageSearchPayload,
  getPurchaseDirectImageSearchUrl,
  getPurchaseSearchHomeUrl,
  getPurchaseSourceProductPreviewImageUrl,
  isPurchaseDirectImageSearchPlatform,
  normalizeSourcePreviewImageUrl,
} from '../features/orders/purchase/lib/purchaseImageRules.jsx';

describe('purchase image search rules', () => {
  const testImageUrl = 'https://img.example.com/ozon/test-product.jpg?size=800&token=abc';

  it('builds the current Taobao official image-search url with the selected order image', () => {
    const payload = buildPurchaseDirectImageSearchPayload('淘宝', testImageUrl);
    const url = new URL(payload.searchUrl);

    expect(payload.externalOnly).toBe(true);
    expect(payload.searchUrl).not.toBe(getPurchaseSearchHomeUrl('淘宝'));
    expect(url.origin + url.pathname).toBe('https://s.taobao.com/search');
    expect(url.searchParams.get('imgSearchUrl')).toBe(testImageUrl);
    expect(url.searchParams.get('imgfile')).toBeNull();
    expect(url.searchParams.get('tab')).toBe('all');
    expect(url.searchParams.get('search_type')).toBe('item');
    expect(payload.message).toContain('自动识图页面');
  });

  it('opens Tmall direct platform through Taobao image search with mall filtering kept', () => {
    const searchUrl = getPurchaseDirectImageSearchUrl('天猫', testImageUrl);
    const url = new URL(searchUrl);

    expect(searchUrl).not.toBe(getPurchaseSearchHomeUrl('天猫'));
    expect(url.origin + url.pathname).toBe('https://s.taobao.com/search');
    expect(url.searchParams.get('imgSearchUrl')).toBe(testImageUrl);
    expect(url.searchParams.get('tab')).toBe('mall');
  });

  it('routes Taobao and Tmall through the local bridge before opening the official page', () => {
    expect(isPurchaseDirectImageSearchPlatform('淘宝')).toBe(false);
    expect(isPurchaseDirectImageSearchPlatform('天猫')).toBe(false);
  });

  it('uses original source images for hover preview before small thumbnails', () => {
    const sourceEntry = {
      imageUrl: 'https://img.example.com/source.jpg_100x100.jpg',
      previewImageUrl: 'https://img.example.com/source.jpg_320x320.jpg',
      originalImageUrl: 'https://img.example.com/source.jpg',
    };

    expect(getPurchaseSourceProductPreviewImageUrl(sourceEntry)).toBe('https://img.example.com/source.jpg');
  });

  it('tries to restore common platform thumbnail urls to a clearer preview url', () => {
    expect(normalizeSourcePreviewImageUrl('https://img.alicdn.com/img/test.jpg_100x100.jpg')).toBe(
      'https://img.alicdn.com/img/test.jpg'
    );
    expect(
      normalizeSourcePreviewImageUrl('https://img.example.com/test.jpg?imageMogr2/thumbnail/100x/quality/80')
    ).toBe('https://img.example.com/test.jpg');
  });
});
