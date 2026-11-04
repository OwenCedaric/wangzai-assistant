import { createJsonResponse, readJsonRequestBody } from "../../utils/http.js";

const PRODUCT_DOMAIN = "products";
const ROUTES = Object.freeze({
  query: "/api/cache/products",
  support: "/api/products/support",
  summary: "/api/products/summary",
  skuFamily: "/api/products/sku-family",
  summaryHydrate: "/api/products/summary/hydrate",
  material: "/api/products/material",
  materialLegacyImport: "/api/products/material/legacy-import",
  sourceLinks: "/api/products/source-links",
  sourceLinksLegacyImport: "/api/products/source-links/legacy-import",
  imageHealth: "/api/products/image-health",
  sync: "/api/sync/products",
  writePreview: "/api/write/products/preview",
  writePreviewRelease: "/api/write/products/preview/release",
  writeConfirm: "/api/write/products/confirm",
  historicalDimensionPreview: "/api/products/historical-dimension-sync/preview",
  historicalDimensionConfirm: "/api/products/historical-dimension-sync/confirm",
});

const BODY_LIMITS = Object.freeze({
  default: 64 * 1024,
  sourceLinks: 128 * 1024,
  // This is a per-chunk safety ceiling, not a total listing capacity. The
  // frontend splits arbitrarily large multi-SKU previews by actual UTF-8
  // bytes and keeps each request well below the desktop proxy boundary.
  write: 2 * 1024 * 1024,
});

function createBadJsonPayload(error) {
  const accountRemovalCode =
    typeof error?.code === "string" && error.code.startsWith("ACCOUNT_REMOVAL_")
      ? error.code
      : null;
  return {
    ok: false,
    error: {
      code: accountRemovalCode || (error?.code === "REQUEST_BODY_TOO_LARGE" ? error.code : "BAD_JSON_BODY"),
      message: error instanceof Error ? error.message : String(error),
      ...(error?.code === "REQUEST_BODY_TOO_LARGE"
        ? { maxBytes: Number(error.maxBytes) || null, receivedBytes: Number(error.receivedBytes) || null }
        : {}),
    },
  };
}

function createUnavailablePayload(code, message) {
  return { ok: false, error: { code, message } };
}

function createOperationErrorPayload(code, error) {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function createHistoricalDimensionErrorPayload(error) {
  const explicit = typeof error?.code === "string" ? error.code.trim() : "";
  const message = error instanceof Error ? error.message : String(error || "");
  const code = explicit.startsWith("HISTORICAL_DIMENSION_SYNC_")
    ? explicit
    : message.match(/^(HISTORICAL_DIMENSION_SYNC_[A-Z0-9_]+)/u)?.[1]
      || "HISTORICAL_DIMENSION_SYNC_REQUEST_FAILED";
  return {
    ok: false,
    error: {
      code,
      message,
      ...(error?.details === undefined ? {} : { details: error.details }),
    },
  };
}

function createSyncValidationErrorPayload(error) {
  // Keep the existing public error contract while the generic sync route is
  // being split by domain. Changing this code requires a separate API change.
  return createOperationErrorPayload(
    "CATALOG_CACHE_VALIDATION_ERROR",
    error,
  );
}

function sendJson(res, status, payload, corsHeaders) {
  createJsonResponse(res, status, payload, corsHeaders);
}

const WAREHOUSE_PICKER_PROJECTION = "warehouse-picker";

function compactWarehouseStock(row = {}) {
  return {
    warehouseId: row.warehouseId ?? row.warehouse_id ?? "",
    warehouseName: row.warehouseName ?? row.warehouse_name ?? "",
    warehouseKey: row.warehouseKey ?? row.warehouse_key ?? "",
    sku: row.sku ?? "",
    fulfillmentType: row.fulfillmentType ?? row.fulfillment_type ?? "",
    presentQuantity: row.presentQuantity ?? row.present_quantity ?? null,
    reservedQuantity: row.reservedQuantity ?? row.reserved_quantity ?? null,
    freeQuantity: row.freeQuantity ?? row.free_quantity ?? null,
  };
}

function compactWarehousePickerProduct(row = {}) {
  const primaryImageUrl = row.primaryImageUrl || row.primary_image || row.images?.[0] || "";
  return {
    id: row.id,
    shopId: row.shopId,
    productId: row.productId,
    offerId: row.offerId,
    sku: row.sku,
    name: row.name,
    visibility: row.visibility,
    statusLabel: row.statusLabel,
    productSnapshotVisibility: row.productSnapshotVisibility,
    productSnapshotVisibilities: row.productSnapshotVisibilities,
    snapshotVisibilities: row.snapshotVisibilities,
    typeId: row.typeId,
    primaryImageUrl,
    images: primaryImageUrl ? [primaryImageUrl] : [],
    stockValue: row.stockValue,
    warehouseStocks: (Array.isArray(row.warehouseStocks) ? row.warehouseStocks : [])
      .map(compactWarehouseStock),
    sellerWarehouseStockTotal: row.sellerWarehouseStockTotal,
    warehouseStockTotal: row.warehouseStockTotal,
    warehouseStockCount: row.warehouseStockCount,
    warehouseStockComplete: row.warehouseStockComplete === true,
  };
}

export function projectProductCachePayload(payload = {}, query = {}) {
  if (String(query?.projection || "").trim() !== WAREHOUSE_PICKER_PROJECTION) return payload;
  return {
    ...payload,
    projection: WAREHOUSE_PICKER_PROJECTION,
    rows: (Array.isArray(payload?.rows) ? payload.rows : []).map(compactWarehousePickerProduct),
  };
}

function runJsonCommand({
  req,
  res,
  corsHeaders,
  readRequestBody,
  maxBytes,
  execute,
  successStatus = 200,
  mapSuccessStatus,
  operationErrorCode,
  mapOperationError,
}) {
  readRequestBody(req, { maxBytes })
    .then(async (body) => {
      try {
        const payload = await execute(body);
        const status = mapSuccessStatus
          ? mapSuccessStatus(payload)
          : successStatus;
        sendJson(res, status, payload, corsHeaders);
      } catch (error) {
        const payload = mapOperationError
          ? mapOperationError(error)
          : createOperationErrorPayload(operationErrorCode, error);
        sendJson(res, 400, payload, corsHeaders);
      }
    })
    .catch((error) => {
      sendJson(res, error?.code === "REQUEST_BODY_TOO_LARGE" ? 413 : 400, createBadJsonPayload(error), corsHeaders);
    });
}

/**
 * Owns the complete HTTP boundary for the products domain.
 *
 * Query, Sync and Ozon Write are deliberately separate routes even though
 * they share one handler. Query only calls the SQLite-backed service; Sync
 * only creates a sync run; Write always goes through the write guard and
 * returns its Ozon readback result unchanged.
 */
export function createProductsRoutes({
  service,
  writeGuardService,
  historicalDimensionSyncService,
  readRequestBody = readJsonRequestBody,
  legacyBulkImportMaxBodyBytes = 8 * 1024 * 1024,
} = {}) {
  if (typeof readRequestBody !== "function") {
    throw new Error("PRODUCT_ROUTES_BODY_READER_REQUIRED");
  }
  if (
    !writeGuardService?.previewWrite ||
    !writeGuardService?.confirmWrite ||
    !writeGuardService?.releasePreview
  ) {
    throw new Error("PRODUCT_ROUTES_WRITE_GUARD_REQUIRED");
  }

  function handleGet({ res, pathname, query, corsHeaders }) {
    if (pathname === ROUTES.query) {
      const fullPayload = service?.readCache
        ? service.readCache(query)
        : createUnavailablePayload(
            "PRODUCT_QUERY_NOT_CONNECTED",
            "商品 SQLite 查询服务尚未连接。",
          );
      const payload = projectProductCachePayload(fullPayload, query);
      sendJson(res, 200, payload, corsHeaders);
      return true;
    }

    if (pathname === ROUTES.support) {
      const payload = service?.readSupport
        ? service.readSupport(query)
        : createUnavailablePayload(
            "PRODUCT_SUPPORT_NOT_CONNECTED",
            "商品支撑数据服务尚未连接。",
          );
      sendJson(res, 200, payload, corsHeaders);
      return true;
    }

    if (pathname === ROUTES.summary) {
      const payload = service?.readSummary
        ? service.readSummary(query)
        : createUnavailablePayload(
            "PRODUCT_SUMMARY_NOT_CONNECTED",
            "商品摘要只读服务尚未连接。",
          );
      sendJson(res, 200, payload, corsHeaders);
      return true;
    }

    if (pathname === ROUTES.skuFamily) {
      const payload = service?.readSkuFamily
        ? service.readSkuFamily(query)
        : createUnavailablePayload(
            "PRODUCT_SKU_FAMILY_NOT_CONNECTED",
            "商品SKU家族读取服务尚未连接。",
          );
      sendJson(res, 200, payload, corsHeaders);
      return true;
    }

    if (pathname === ROUTES.material) {
      if (!service?.listMaterialProfiles) {
        sendJson(
          res,
          501,
          createUnavailablePayload(
            "PRODUCT_SUPPORT_NOT_CONNECTED",
            "商品支撑数据服务尚未连接。",
          ),
          corsHeaders,
        );
        return true;
      }
      try {
        sendJson(res, 200, service.listMaterialProfiles(query), corsHeaders);
      } catch (error) {
        sendJson(
          res,
          400,
          createOperationErrorPayload("PRODUCT_MATERIAL_READ_FAILED", error),
          corsHeaders,
        );
      }
      return true;
    }

    if (pathname === ROUTES.sourceLinks) {
      if (!service?.listSourceLinks) {
        sendJson(
          res,
          501,
          createUnavailablePayload(
            "PRODUCT_SUPPORT_NOT_CONNECTED",
            "商品支撑数据服务尚未连接。",
          ),
          corsHeaders,
        );
        return true;
      }
      try {
        sendJson(res, 200, service.listSourceLinks(query), corsHeaders);
      } catch (error) {
        sendJson(
          res,
          400,
          createOperationErrorPayload("PRODUCT_SOURCE_LINK_READ_FAILED", error),
          corsHeaders,
        );
      }
      return true;
    }

    return false;
  }

  function handlePost({ req, res, pathname, corsHeaders }) {
    if (pathname === ROUTES.summaryHydrate) {
      if (!service?.hydrateSummary) {
        sendJson(
          res,
          501,
          createUnavailablePayload(
            "PRODUCT_SUMMARY_HYDRATE_NOT_CONNECTED",
            "商品摘要补查服务尚未连接。",
          ),
          corsHeaders,
        );
        return true;
      }
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: BODY_LIMITS.default,
        execute: (body) => service.hydrateSummary(body),
        operationErrorCode: "PRODUCT_SUMMARY_HYDRATE_FAILED",
      });
      return true;
    }

    if (pathname === ROUTES.historicalDimensionPreview) {
      if (!historicalDimensionSyncService?.preview) {
        sendJson(
          res,
          501,
          createUnavailablePayload(
            "HISTORICAL_DIMENSION_SYNC_NOT_CONNECTED",
            "历史订单尺寸回传服务尚未连接。",
          ),
          corsHeaders,
        );
        return true;
      }
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: BODY_LIMITS.default,
        execute: (body) => historicalDimensionSyncService.preview(body),
        operationErrorCode: "HISTORICAL_DIMENSION_SYNC_REQUEST_FAILED",
        mapOperationError: createHistoricalDimensionErrorPayload,
      });
      return true;
    }

    if (pathname === ROUTES.historicalDimensionConfirm) {
      if (!historicalDimensionSyncService?.confirm) {
        sendJson(
          res,
          501,
          createUnavailablePayload(
            "HISTORICAL_DIMENSION_SYNC_NOT_CONNECTED",
            "历史订单尺寸回传服务尚未连接。",
          ),
          corsHeaders,
        );
        return true;
      }
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: BODY_LIMITS.default,
        execute: (body) => historicalDimensionSyncService.confirm(body),
        operationErrorCode: "HISTORICAL_DIMENSION_SYNC_REQUEST_FAILED",
        mapOperationError: createHistoricalDimensionErrorPayload,
      });
      return true;
    }

    if (pathname === ROUTES.materialLegacyImport) {
      if (!service?.importLegacyMaterialProfiles) {
        sendJson(
          res,
          501,
          createUnavailablePayload(
            "PRODUCT_SUPPORT_NOT_CONNECTED",
            "商品支撑数据服务尚未连接。",
          ),
          corsHeaders,
        );
        return true;
      }
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: legacyBulkImportMaxBodyBytes,
        execute: (body) => service.importLegacyMaterialProfiles(body),
        operationErrorCode: "PRODUCT_MATERIAL_LEGACY_IMPORT_FAILED",
      });
      return true;
    }

    if (pathname === ROUTES.material) {
      if (!service?.saveMaterialProfile) {
        sendJson(
          res,
          501,
          createUnavailablePayload(
            "PRODUCT_SUPPORT_NOT_CONNECTED",
            "商品支撑数据服务尚未连接。",
          ),
          corsHeaders,
        );
        return true;
      }
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: BODY_LIMITS.default,
        execute: (body) => service.saveMaterialProfile(body),
        operationErrorCode: "PRODUCT_MATERIAL_SAVE_FAILED",
      });
      return true;
    }

    if (pathname === ROUTES.sourceLinksLegacyImport) {
      if (!service?.importLegacySourceLinks) {
        sendJson(
          res,
          501,
          createUnavailablePayload(
            "PRODUCT_SUPPORT_NOT_CONNECTED",
            "商品支撑数据服务尚未连接。",
          ),
          corsHeaders,
        );
        return true;
      }
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: legacyBulkImportMaxBodyBytes,
        execute: (body) => service.importLegacySourceLinks(body),
        operationErrorCode: "PRODUCT_SOURCE_LINK_LEGACY_IMPORT_FAILED",
      });
      return true;
    }

    if (pathname === ROUTES.sourceLinks) {
      if (!service?.saveSourceLinks) {
        sendJson(
          res,
          501,
          createUnavailablePayload(
            "PRODUCT_SUPPORT_NOT_CONNECTED",
            "商品支撑数据服务尚未连接。",
          ),
          corsHeaders,
        );
        return true;
      }
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: BODY_LIMITS.sourceLinks,
        execute: (body) => service.saveSourceLinks(body),
        operationErrorCode: "PRODUCT_SOURCE_LINK_SAVE_FAILED",
      });
      return true;
    }

    if (pathname === ROUTES.imageHealth) {
      if (!service?.saveImageHealth) {
        sendJson(
          res,
          501,
          createUnavailablePayload(
            "PRODUCT_SUPPORT_NOT_CONNECTED",
            "商品图片健康数据服务尚未连接。",
          ),
          corsHeaders,
        );
        return true;
      }
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: BODY_LIMITS.default,
        execute: (body) => service.saveImageHealth(body),
        operationErrorCode: "PRODUCT_IMAGE_HEALTH_SAVE_FAILED",
      });
      return true;
    }

    if (pathname === ROUTES.sync) {
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: BODY_LIMITS.default,
        execute: (body) => {
          if (service?.startSync) return service.startSync(body);
          return {
            ok: false,
            error: {
              code: "DOMAIN_SYNC_NOT_CONNECTED",
              message:
                "Domain sync for products is not connected in this foundation stage.",
            },
            domain: PRODUCT_DOMAIN,
          };
        },
        mapSuccessStatus: (payload) =>
          payload?.accepted || payload?.ok ? 202 : 501,
        operationErrorCode: "PRODUCT_SYNC_FAILED",
        mapOperationError: createSyncValidationErrorPayload,
      });
      return true;
    }

    if (pathname === ROUTES.writePreview) {
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: BODY_LIMITS.write,
        execute: (body) => writeGuardService.previewWrite(PRODUCT_DOMAIN, body),
        operationErrorCode: "BAD_JSON_BODY",
        mapOperationError: createBadJsonPayload,
      });
      return true;
    }

    if (pathname === ROUTES.writePreviewRelease) {
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: BODY_LIMITS.default,
        execute: (body) => writeGuardService.releasePreview(PRODUCT_DOMAIN, body),
        mapSuccessStatus: (payload) => payload?.ok === false ? 400 : 200,
        operationErrorCode: "PRODUCT_WRITE_PREVIEW_RELEASE_FAILED",
      });
      return true;
    }

    if (pathname === ROUTES.writeConfirm) {
      runJsonCommand({
        req,
        res,
        corsHeaders,
        readRequestBody,
        maxBytes: BODY_LIMITS.write,
        execute: (body) => writeGuardService.confirmWrite(PRODUCT_DOMAIN, body),
        operationErrorCode: "BAD_JSON_BODY",
        mapOperationError: createBadJsonPayload,
      });
      return true;
    }

    return false;
  }

  function handleRequest({ req, res, requestUrl, query = {}, corsHeaders = {} }) {
    const pathname = requestUrl.pathname;
    if (req.method === "GET") {
      return handleGet({ res, pathname, query, corsHeaders });
    }
    if (req.method === "POST") {
      return handlePost({ req, res, pathname, corsHeaders });
    }
    return false;
  }

  return {
    domain: PRODUCT_DOMAIN,
    service,
    connected: Boolean(service?.readCache && service?.startSync),
    handleRequest,
  };
}

export const productsRouteContract = Object.freeze({
  domain: PRODUCT_DOMAIN,
  routes: ROUTES,
  bodyLimits: BODY_LIMITS,
});
