import { createCatalogCacheKeyRulePayload, createCatalogCacheKeySavedPayload, createCatalogCacheKeysPayload, createCatalogCacheStatusPayload, createCatalogCacheValidationErrorPayload, createCatalogCategoryNodesPayload } from "../routes/catalogCache.js";
import { createJsonResponse } from "../utils/http.js";
import { createBadJsonPayload } from "./createAppRouteHelpers.js";

export function createCatalogCacheRoute({
  catalogCacheService,
  readOwnerWritableJsonRequestBody,
}) {
  return function handleCatalogCacheRoute({ corsHeaders, query, req, requestUrl, res }) {
    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/cache/catalog/key-rule"
    ) {
      createJsonResponse(
        res,
        200,
        createCatalogCacheKeyRulePayload(catalogCacheService.getCacheKeyRule()),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/cache/catalog/status"
    ) {
      createJsonResponse(
        res,
        200,
        createCatalogCacheStatusPayload(
          catalogCacheService.listSyncState(query),
          catalogCacheService.getCacheKeyRule(),
        ),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/cache/catalog/keys"
    ) {
      createJsonResponse(
        res,
        200,
        createCatalogCacheKeysPayload(catalogCacheService.listCacheKeys(query)),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/cache/catalog/keys"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              201,
              createCatalogCacheKeySavedPayload(
                catalogCacheService.ensureCacheKey(body),
              ),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              createCatalogCacheValidationErrorPayload(
                error instanceof Error ? error.message : String(error),
              ),
              corsHeaders,
            );
          }
        })
        .catch((error) => {
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          );
        });
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/cache/catalog/nodes"
    ) {
      createJsonResponse(
        res,
        200,
        createCatalogCategoryNodesPayload(
          catalogCacheService.listCategoryNodes(query),
        ),
        corsHeaders,
      );
      return true;
    }
    return false;
  };
}
