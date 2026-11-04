function normalizeText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function notConnected() {
  return {
    ok: false,
    error: {
      code: "PRODUCT_SUPPORT_NOT_CONNECTED",
      message: "商品支撑数据服务尚未连接。",
    },
  };
}

function invalidateImportedShops(rows, clearProductReadCache) {
  const shopIds = [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => normalizeText(row?.shopId || row?.shop_id))
    .filter(Boolean))];
  if (!shopIds.length) {
    clearProductReadCache();
    return;
  }
  shopIds.forEach((shopId) => clearProductReadCache(shopId));
}

export function createProductLegacyMigrationService({
  repository,
  clearProductReadCache,
  normalSupportService,
} = {}) {
  function listMaterialProfiles(query = {}) {
    if (!repository) return notConnected();
    return normalizeText(query.cursorMode) === "legacy-migration"
      ? repository.listProductMaterialProfilesPage(query)
      : normalSupportService.listMaterialProfiles(query);
  }

  function importLegacyMaterialProfiles(payload = {}) {
    if (!repository) return notConnected();
    const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
    const result = repository.importLegacyProductMaterialProfiles(profiles);
    invalidateImportedShops(profiles, clearProductReadCache);
    return { ok: true, domain: "products", ...result };
  }

  function importLegacySourceLinks(payload = {}) {
    if (!repository) return notConnected();
    const records = Array.isArray(payload?.records) ? payload.records : [];
    const result = repository.importLegacyProductSourceLinks(records);
    invalidateImportedShops(records, clearProductReadCache);
    return { ok: true, domain: "products", ...result };
  }

  return {
    listMaterialProfiles,
    importLegacyMaterialProfiles,
    importLegacySourceLinks,
  };
}
