import { createJsonResponse } from "../utils/http.js";
import { createBadJsonPayload, getLegacyOzonPublicError, matchSingleParamRoute } from "./createAppRouteHelpers.js";

export function createOzonOperationsRoute({
  executeLegacyOzonRequest,
  ozonScheduler,
  readOwnerWritableJsonRequestBody,
  shopRepository,
  syncSnapshotService,
  writeGuardService,
}) {
  return function handleOzonOperationsRoute({ corsHeaders, query, req, requestUrl, res }) {
    if (req.method === "GET" && requestUrl.pathname === "/api/ozon/endpoints") {
      createJsonResponse(
        res,
        200,
        { ok: true, endpoints: ozonScheduler.listEndpoints() },
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/ozon/scheduler/status"
    ) {
      createJsonResponse(
        res,
        200,
        ozonScheduler.getSchedulerStatus(),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/ozon/notifications"
    ) {
      createJsonResponse(
        res,
        200,
        syncSnapshotService.listNotifications(query),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/ozon/push-bindings"
    ) {
      createJsonResponse(
        res,
        200,
        syncSnapshotService.listObservedPushBindings(query),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/ozon/notifications/read"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) =>
          createJsonResponse(
            res,
            200,
            syncSnapshotService.markNotificationsRead(body),
            corsHeaders,
          ),
        )
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
      requestUrl.pathname === "/api/ozon/notifications/clear"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) =>
          createJsonResponse(
            res,
            200,
            syncSnapshotService.clearNotifications(body),
            corsHeaders,
          ),
        )
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
      requestUrl.pathname === "/api/ozon/notification-settings"
    ) {
      createJsonResponse(
        res,
        200,
        syncSnapshotService.listNotificationSettings(query),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/ozon/notification-settings"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) =>
          createJsonResponse(
            res,
            200,
            syncSnapshotService.saveNotificationSetting(body),
            corsHeaders,
          ),
        )
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
      requestUrl.pathname === "/api/ozon/scheduler/pause-shop"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) =>
          createJsonResponse(
            res,
            200,
            ozonScheduler.pauseShop(body.shopId || body.shop_id),
            corsHeaders,
          ),
        )
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
      requestUrl.pathname === "/api/ozon/scheduler/resume-shop"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) =>
          createJsonResponse(
            res,
            200,
            ozonScheduler.resumeShop(body.shopId || body.shop_id),
            corsHeaders,
          ),
        )
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
      requestUrl.pathname === "/api/ozon/scheduler/pause-endpoint"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) =>
          createJsonResponse(
            res,
            200,
            ozonScheduler.pauseEndpoint(body.endpointKey || body.endpoint_key),
            corsHeaders,
          ),
        )
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
      requestUrl.pathname === "/api/ozon/scheduler/resume-endpoint"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) =>
          createJsonResponse(
            res,
            200,
            ozonScheduler.resumeEndpoint(body.endpointKey || body.endpoint_key),
            corsHeaders,
          ),
        )
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
      requestUrl.pathname === "/api/ozon/rate-limit/status"
    ) {
      createJsonResponse(
        res,
        200,
        ozonScheduler.getRateLimitStatus(query),
        corsHeaders,
      );
      return true;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/ozon/errors") {
      createJsonResponse(
        res,
        200,
        { ok: true, errors: ozonScheduler.listErrors(query) },
        corsHeaders,
      );
      return true;
    }

    const writePreviewDomain = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/write\/([^/]+)\/preview$/u,
    );
    if (req.method === "POST" && writePreviewDomain) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          createJsonResponse(
            res,
            200,
            writeGuardService.previewWrite(writePreviewDomain, body),
            corsHeaders,
          );
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

    const writeConfirmDomain = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/write\/([^/]+)\/confirm$/u,
    );
    if (req.method === "POST" && writeConfirmDomain) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then(async (body) => {
          createJsonResponse(
            res,
            200,
            await writeGuardService.confirmWrite(writeConfirmDomain, body),
            corsHeaders,
          );
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

    if (req.method === "POST" && requestUrl.pathname === "/api/ozon/request") {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 1024 * 1024 })
        .then(async (body) => {
          try {
            const result = await executeLegacyOzonRequest({
              body,
              shopRepository,
              ozonScheduler,
            });
            const statusCode = result.ok ? 200 : 502;
            createJsonResponse(res, statusCode, result, corsHeaders);
          } catch (error) {
            const statusCode =
              error?.code === "OZON_ENDPOINT_NOT_REGISTERED" ||
              error?.code === "OZON_SHOP_ID_REQUIRED" ||
              error?.code === "OZON_WRITE_CONFIRMATION_REQUIRED" ||
              error?.code === "OZON_ENDPOINT_ACCESS_MISMATCH" ||
              error?.code === "LEGACY_OZON_WRITE_FORBIDDEN" ||
              error?.code === "FINANCE_POSTING_BATCH_INVALID"
                ? 400
                : 502;
            createJsonResponse(
              res,
              statusCode,
              {
                ok: false,
                error: getLegacyOzonPublicError(error),
                request: {
                  provider: "ozon",
                  endpoint:
                    body?.endpoint ||
                    body?.endpointKey ||
                    body?.endpoint_key ||
                    "",
                  method: body?.method || "POST",
                  via: "local-api",
                  connected: true,
                },
              },
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
    return false;
  };
}
