export function createImagesService({ ozonScheduler, productsService } = {}) {
  return {
    domain: 'images',
    readCache(query = {}) {
      if (productsService?.readCache) {
        return productsService.readCache(query);
      }
      if (!ozonScheduler?.readCache) {
        return {
          ok: false,
          error: {
            code: 'DOMAIN_CACHE_NOT_CONNECTED',
            message: 'images cache reader is not connected.',
          },
        };
      }
      return ozonScheduler.readCache('products', query);
    },
    startSync(payload = {}) {
      if (productsService?.startSync) {
        const result = productsService.startSync({
          ...payload,
          hydrate: true,
          hydrationMode: 'pictures',
          requestedBy: payload.requestedBy || 'images-domain-sync',
        });
        return {
          ...result,
          requestedDomain: 'images',
          canonicalDomain: 'products',
        };
      }
      return {
        ok: false,
        domain: 'images',
        error: {
          code: 'IMAGES_PRODUCT_SERVICE_NOT_CONNECTED',
          message: '商品图片同步服务未连接。',
        },
      };
    },
  };
}
