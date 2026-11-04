function notConnected() {
  return {
    ok: false,
    error: {
      code: "PRODUCT_SUPPORT_NOT_CONNECTED",
      message: "商品支撑数据服务尚未连接。",
    },
  };
}

export function createProductSupportService({ repository, clearProductReadCache } = {}) {
  function readSupport(query = {}) {
    if (!repository) return notConnected();
    return {
      ok: true,
      domain: "products",
      materialProfiles: repository.listProductMaterialProfiles(query),
      sourceLinks: repository.listProductSourceLinks(query),
    };
  }

  function listMaterialProfiles(query = {}) {
    if (!repository) return notConnected();
    return { ok: true, rows: repository.listProductMaterialProfiles(query) };
  }

  function saveMaterialProfile(payload = {}) {
    if (!repository) return notConnected();
    const result = repository.upsertProductMaterialProfile(payload);
    clearProductReadCache(payload.shopId || payload.shop_id);
    return { ok: true, domain: "products", ...result };
  }

  function saveSourceLinks(payload = {}) {
    if (!repository) return notConnected();
    const result = repository.upsertProductSourceLinks(payload);
    clearProductReadCache(payload.shopId || payload.shop_id);
    return { ok: true, domain: "products", ...result };
  }

  function listSourceLinks(query = {}) {
    if (!repository) return notConnected();
    return repository.listProductSourceLinks(query);
  }

  function saveImageHealth(payload = {}) {
    if (!repository) return notConnected();
    const result = repository.upsertProductImageHealth(payload);
    clearProductReadCache(payload.shopId || payload.shop_id);
    return { ok: true, domain: "products", ...result };
  }

  return {
    readSupport,
    listMaterialProfiles,
    saveMaterialProfile,
    saveSourceLinks,
    listSourceLinks,
    saveImageHealth,
  };
}
