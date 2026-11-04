import { createCatalogCacheValidationErrorPayload } from "../routes/catalogCache.js";
import { createJsonResponse } from "../utils/http.js";
import { createBadJsonPayload } from "./createAppRouteHelpers.js";

export function createCustomerServiceRoute({
  domainServices,
  readOwnerWritableJsonRequestBody,
}) {
  return function handleCustomerServiceRoute({ corsHeaders, query, req, requestUrl, res }) {
    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/customer-service/order-route-context"
    ) {
      try {
        const customerService = domainServices.get("customerService");
        createJsonResponse(
          res,
          200,
          customerService.readOrderRouteContext(query),
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(
          res,
          400,
          {
            ok: false,
            error: {
              code: error.code || "CUSTOMER_ORDER_ROUTE_CONTEXT_FAILED",
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
      requestUrl.pathname === "/api/customer-service/push-view-markers/list"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 32 * 1024 })
        .then((body) => {
          try {
            const customerService = domainServices.get("customerService");
            const payload = customerService.readPushViewMarkers(body);
            createJsonResponse(
              res,
              payload?.ok ? 200 : 503,
              payload,
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "CUSTOMER_PUSH_VIEW_MARKER_INVALID",
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
      req.method === "PUT" &&
      requestUrl.pathname === "/api/customer-service/push-view-markers"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 32 * 1024 })
        .then((body) => {
          try {
            const customerService = domainServices.get("customerService");
            const payload = customerService.savePushViewMarker(body);
            createJsonResponse(
              res,
              payload?.ok ? 200 : 503,
              payload,
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "CUSTOMER_PUSH_VIEW_MARKER_INVALID",
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
      requestUrl.pathname === "/api/customer-service/probe"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 32 * 1024 })
        .then(async (body) => {
          try {
            const customerService = domainServices.get("customerService");
            const payload = await customerService.probeRead(body);
            createJsonResponse(
              res,
              payload?.ok ? 200 : 400,
              payload,
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
      req.method === "POST" &&
      requestUrl.pathname === "/api/returns/reasons/translate"
    ) {
      const translationController = new AbortController();
      const abortTranslation = () => translationController.abort();
      const abortTranslationOnClosedResponse = () => {
        if (!res.writableEnded) translationController.abort();
      };
      const canWriteTranslationResponse = () =>
        !res.destroyed && !res.writableEnded;
      req.once("aborted", abortTranslation);
      res.once("close", abortTranslationOnClosedResponse);
      readOwnerWritableJsonRequestBody(req, { maxBytes: 256 * 1024 })
        .then(async (body) => {
          try {
            const returnsService = domainServices.get("returns");
            const payload = await returnsService.translateReasons({
              ...body,
              signal: translationController.signal,
            });
            if (!canWriteTranslationResponse()) return;
            createJsonResponse(
              res,
              payload?.ok ? 200 : 503,
              payload,
              corsHeaders,
            );
          } catch (error) {
            if (!canWriteTranslationResponse()) return;
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "RETURN_REASON_TRANSLATION_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) => {
          if (!canWriteTranslationResponse()) return;
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          );
        })
        .finally(() => {
          req.removeListener("aborted", abortTranslation);
          res.removeListener("close", abortTranslationOnClosedResponse);
        });
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/customer-service/translate/cancel"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 4 * 1024 })
        .then((body) => {
          try {
            const customerService = domainServices.get("customerService");
            createJsonResponse(
              res,
              200,
              customerService.cancelMessageTranslation(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "CUSTOMER_TRANSLATION_CANCEL_INVALID",
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
      requestUrl.pathname === "/api/customer-service/translate"
    ) {
      const translationController = new AbortController();
      const abortTranslation = () => translationController.abort();
      const abortTranslationOnClosedResponse = () => {
        if (!res.writableEnded) translationController.abort();
      };
      const canWriteTranslationResponse = () =>
        !res.destroyed && !res.writableEnded;
      req.once("aborted", abortTranslation);
      res.once("close", abortTranslationOnClosedResponse);
      readOwnerWritableJsonRequestBody(req, { maxBytes: 128 * 1024 })
        .then(async (body) => {
          try {
            const customerService = domainServices.get("customerService");
            const payload = await customerService.translateMessages({
              ...body,
              signal: translationController.signal,
            });
            if (!canWriteTranslationResponse()) return;
            createJsonResponse(
              res,
              payload?.ok ? 200 : 400,
              payload,
              corsHeaders,
            );
          } catch (error) {
            if (!canWriteTranslationResponse()) return;
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "CUSTOMER_MESSAGE_TRANSLATION_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) => {
          if (!canWriteTranslationResponse()) return;
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          );
        })
        .finally(() => {
          req.removeListener("aborted", abortTranslation);
          res.removeListener("close", abortTranslationOnClosedResponse);
        });
      return true;
    }
    return false;
  };
}
