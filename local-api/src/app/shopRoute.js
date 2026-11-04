import { createShopConnectionTestFailedPayload, createShopConnectionTestSuccessPayload, createShopCredentialsRequiredPayload, createShopNotFoundPayload, createShopSavedPayload, createShopsListPayload, createShopValidationErrorPayload } from "../routes/shops.js";
import { createJsonResponse } from "../utils/http.js";
import { createBadJsonPayload, isAccountRemovalError, matchShopTestRoute } from "./createAppRouteHelpers.js";
import { LEGACY_BULK_IMPORT_MAX_BODY_BYTES } from "./legacyBulkImportLimits.js";

export function createShopRoute({
  assertAccountOwnerWritable,
  config,
  finishAccountOwnerSave,
  ozonScheduler,
  prepareAccountOwnerSave,
  readOwnerWritableJsonRequestBody,
  runShopConnectionCheck,
  shopBootstrap,
  shopRepository,
}) {
  return function handleShopRoute({ corsHeaders, query, req, requestUrl, res }) {
    if (req.method === "GET" && requestUrl.pathname === "/api/shops") {
      if (query.cursorMode === "legacy-migration") {
        try {
          createJsonResponse(
            res,
            200,
            shopRepository.listShopsPage(query),
            corsHeaders,
          );
        } catch (error) {
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          );
        }
        return true;
      }
      createJsonResponse(
        res,
        200,
        createShopsListPayload(shopRepository.listShops()),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/shops/legacy-import"
    ) {
      readOwnerWritableJsonRequestBody(req, {
        maxBytes: LEGACY_BULK_IMPORT_MAX_BODY_BYTES,
      })
        .then((body) => {
          try {
            const importedShopIds = new Set(
              (Array.isArray(body?.shops) ? body.shops : [])
                .map((shop) => String(shop?.id ?? "").trim())
                .filter(Boolean),
            );
            importedShopIds.forEach((shopId) =>
              prepareAccountOwnerSave("ozon_shop", shopId, {}),
            );
            const preferenceShopIds = new Set(
              [
                ...(Array.isArray(body?.preferences?.shops)
                  ? body.preferences.shops.map((shop) => shop?.id)
                  : []),
                ...Object.keys(
                  body?.preferences?.defaultWarehouseIds &&
                    typeof body.preferences.defaultWarehouseIds === "object"
                    ? body.preferences.defaultWarehouseIds
                    : {},
                ),
                body?.preferences?.activeShopId,
              ]
                .map((shopId) => String(shopId ?? "").trim())
                .filter(Boolean),
            );
            preferenceShopIds.forEach((shopId) => {
              if (!importedShopIds.has(shopId)) {
                assertAccountOwnerWritable("ozon_shop", shopId, {
                  requireExisting: true,
                });
              }
            });
            // The aggregate repository writes shop credentials and the matching
            // non-secret preference map in one SQLite transaction. This route
            // deliberately does not bootstrap Ozon continuous sync.
            createJsonResponse(
              res,
              200,
              shopRepository.importLegacyOzonShopSettings(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              createBadJsonPayload(error),
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

    if (req.method === "POST" && requestUrl.pathname === "/api/shops") {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then(async (body) => {
          try {
            const admission = prepareAccountOwnerSave(
              "ozon_shop",
              body?.id,
              body,
            );
            const result = await shopBootstrap.saveBinding(body, {
              enqueue: config.sync?.continuousEnabled === true,
              deletedRebind: admission?.rebind === true,
              // A completed account deletion keeps the old owner fenced until
              // the new binding is durably saved. Release it before enqueueing
              // the new incarnation, otherwise every bootstrap queue rejects
              // the same-id rebind as still paused.
              onBindingSaved: () => finishAccountOwnerSave(admission),
            });
            createJsonResponse(
              res,
              result.created ? 201 : 200,
              createShopSavedPayload(result),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              isAccountRemovalError(error)
                ? createBadJsonPayload(error)
                : createShopValidationErrorPayload(
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

    const shopIdForConnectionTest = matchShopTestRoute(requestUrl.pathname);
    if (req.method === "POST" && shopIdForConnectionTest) {
      const shop = shopRepository.getPublicShopById(shopIdForConnectionTest);
      if (!shop) {
        createJsonResponse(
          res,
          404,
          createShopNotFoundPayload(shopIdForConnectionTest),
          corsHeaders,
        );
        return true;
      }

      if (!shop.hasClientId || !shop.hasApiKey) {
        createJsonResponse(
          res,
          400,
          createShopCredentialsRequiredPayload(shop),
          corsHeaders,
        );
        return true;
      }

      runShopConnectionCheck({ shop, ozonScheduler })
        .then((result) => {
          if (result.ok) {
            createJsonResponse(
              res,
              200,
              createShopConnectionTestSuccessPayload({
                shop,
                roles: result.roles,
                sellerInfo: result.sellerInfo,
                jobs: result.jobs,
              }),
              corsHeaders,
            );
            return;
          }

          createJsonResponse(
            res,
            502,
            createShopConnectionTestFailedPayload({
              shop,
              step: result.step,
              result: result.result,
            }),
            corsHeaders,
          );
        })
        .catch((error) => {
          createJsonResponse(
            res,
            502,
            createShopConnectionTestFailedPayload({
              shop,
              step: "Ozon",
              error,
            }),
            corsHeaders,
          );
        });
      return true;
    }
    return false;
  };
}
