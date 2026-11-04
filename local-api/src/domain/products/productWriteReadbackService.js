export function createProductWriteReadbackService({ productWriteService } = {}) {
  function executeConfirmedWrite(context = {}) {
    if (!productWriteService) {
      return {
        ok: false,
        error: {
          code: "PRODUCT_WRITE_NOT_CONNECTED",
          message: "商品写入安全门尚未连接商品缓存。",
        },
      };
    }
    return productWriteService.executeConfirmedWrite(context);
  }

  return { executeConfirmedWrite };
}
