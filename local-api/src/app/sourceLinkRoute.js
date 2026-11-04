import { createJsonResponse } from "../utils/http.js";
import { createBadJsonPayload } from "./createAppRouteHelpers.js";
import { LEGACY_BULK_IMPORT_MAX_BODY_BYTES } from "./legacyBulkImportLimits.js";

export function createSourceLinkRoute({
  purchaseService,
  readOwnerWritableJsonRequestBody,
  salesSourceLinkRepository,
}) {
  return function handleSourceLinkRoute({ corsHeaders, query, req, requestUrl, res }) {
    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/purchase/source-links"
    ) {
      try {
        createJsonResponse(
          res,
          200,
          purchaseService.listSourceLinks(query),
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(
          res,
          501,
          {
            ok: false,
            error: {
              code: error.code || "PURCHASE_SOURCE_LINKS_NOT_CONNECTED",
              message: error instanceof Error ? error.message : String(error),
            },
          },
          corsHeaders,
        );
      }
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/sales/source-links"
    ) {
      try {
        createJsonResponse(
          res,
          200,
          salesSourceLinkRepository.listLinks(query),
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(
          res,
          501,
          {
            ok: false,
            error: {
              code: "SALES_SOURCE_LINKS_NOT_CONNECTED",
              message: error instanceof Error ? error.message : String(error),
            },
          },
          corsHeaders,
        );
      }
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/sales/source-links/legacy-import"
    ) {
      readOwnerWritableJsonRequestBody(req, {
        maxBytes: LEGACY_BULK_IMPORT_MAX_BODY_BYTES,
      })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              salesSourceLinkRepository.importLegacyLinks(
                Array.isArray(body?.records) ? body.records : [],
              ),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "SALES_SOURCE_LINK_LEGACY_IMPORT_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/sales/source-links"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 128 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              salesSourceLinkRepository.saveLinks(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "SALES_SOURCE_LINK_SAVE_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "DELETE" &&
      requestUrl.pathname === "/api/sales/source-links"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              salesSourceLinkRepository.deleteLinks({ ...query, ...body }),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "SALES_SOURCE_LINK_DELETE_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/purchase/source-links/legacy-import"
    ) {
      readOwnerWritableJsonRequestBody(req, {
        maxBytes: LEGACY_BULK_IMPORT_MAX_BODY_BYTES,
      })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              purchaseService.importLegacySourceLinks(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "PURCHASE_SOURCE_LINK_LEGACY_IMPORT_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/purchase/source-links"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 128 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              purchaseService.saveSourceLinks(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "PURCHASE_SOURCE_LINK_SAVE_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "DELETE" &&
      requestUrl.pathname === "/api/purchase/source-links"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              purchaseService.deleteSourceLinks({ ...query, ...body }),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "PURCHASE_SOURCE_LINK_DELETE_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/purchase/orders/overrides"
    ) {
      try {
        createJsonResponse(
          res,
          200,
          purchaseService.listOrderOverrides(query),
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(
          res,
          501,
          {
            ok: false,
            error: {
              code: error.code || "PURCHASE_OVERRIDES_NOT_CONNECTED",
              message: error instanceof Error ? error.message : String(error),
            },
          },
          corsHeaders,
        );
      }
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/purchase/orders/overrides/legacy-import"
    ) {
      readOwnerWritableJsonRequestBody(req, {
        maxBytes: LEGACY_BULK_IMPORT_MAX_BODY_BYTES,
      })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              purchaseService.importLegacyOrderOverrides(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "PURCHASE_OVERRIDE_LEGACY_IMPORT_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/purchase/orders/overrides"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              purchaseService.saveOrderOverride(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "PURCHASE_OVERRIDE_SAVE_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "DELETE" &&
      requestUrl.pathname === "/api/purchase/orders/overrides"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              purchaseService.deleteOrderOverride({ ...query, ...body }),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "PURCHASE_OVERRIDE_DELETE_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }
    return false;
  };
}
