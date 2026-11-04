import { createRequestContext } from "../security/requestContext.js";
import { createJsonResponse } from "../utils/http.js";
import { createBadJsonPayload, crossBorderChargeErrorPayload, crossBorderChargeErrorStatus, isAccountRemovalError, matchSingleParamRoute } from "./createAppRouteHelpers.js";

export function createCrossBorderLogisticsRoute({
  config,
  crossBorderAccountService,
  crossBorderChargeService,
  crossBorderOrderService,
  crossBorderReadService,
  crossBorderWriteGuardService,
  finishAccountOwnerSave,
  prepareAccountOwnerSave,
  readOwnerWritableJsonRequestBody,
}) {
  return function handleCrossBorderLogisticsRoute({ corsHeaders, query, req, requestUrl, res }) {
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/logistics/cross-border/charges/preview"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 * 1024 })
        .then((body) => {
          try {
            const requestContext = createRequestContext({
              req,
              query,
              body,
              defaultTenantId:
                config?.runtime?.tenantId || config?.runtime?.appId,
              defaultUserId: config?.runtime?.userId,
            });
            createJsonResponse(
              res,
              200,
              crossBorderChargeService.buildPreview(body, requestContext),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              crossBorderChargeErrorStatus(error),
              crossBorderChargeErrorPayload(error),
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
      requestUrl.pathname === "/api/logistics/cross-border/charges/confirm"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 256 * 1024 })
        .then((body) => {
          try {
            const requestContext = createRequestContext({
              req,
              query,
              body,
              defaultTenantId:
                config?.runtime?.tenantId || config?.runtime?.appId,
              defaultUserId: config?.runtime?.userId,
            });
            const payload = crossBorderChargeService.confirmImport(
              body,
              requestContext,
            );
            createJsonResponse(
              res,
              payload.ok === false ? 409 : 200,
              payload,
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              crossBorderChargeErrorStatus(error),
              crossBorderChargeErrorPayload(error),
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
      requestUrl.pathname === "/api/logistics/cross-border/charges"
    ) {
      try {
        const requestContext = createRequestContext({
          req,
          query,
          defaultTenantId: config?.runtime?.tenantId || config?.runtime?.appId,
          defaultUserId: config?.runtime?.userId,
        });
        const payload = crossBorderChargeService.listLinks(
          query,
          requestContext,
        );
        if (
          String(
            query.includeRecords || query.include_records || "",
          ).toLowerCase() === "true"
        ) {
          payload.records = crossBorderChargeService.listRecords(
            query,
            requestContext,
          ).rows;
        }
        createJsonResponse(res, 200, payload, corsHeaders);
      } catch (error) {
        createJsonResponse(
          res,
          crossBorderChargeErrorStatus(error),
          crossBorderChargeErrorPayload(error),
          corsHeaders,
        );
      }
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/logistics/cross-border/accounts"
    ) {
      try {
        createJsonResponse(
          res,
          200,
          crossBorderAccountService.listAccounts(),
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(
          res,
          501,
          {
            ok: false,
            error: {
              code: error.code || "CROSS_BORDER_ACCOUNTS_NOT_CONNECTED",
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
      requestUrl.pathname === "/api/logistics/cross-border/accounts"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            const admission = prepareAccountOwnerSave(
              "cross_border_bus",
              body?.id,
              body,
            );
            const payload = crossBorderAccountService.saveAccount(body);
            finishAccountOwnerSave(admission);
            createJsonResponse(res, 200, payload, corsHeaders);
          } catch (error) {
            createJsonResponse(
              res,
              400,
              isAccountRemovalError(error)
                ? createBadJsonPayload(error)
                : {
                    ok: false,
                    error: {
                      code: "CROSS_BORDER_ACCOUNT_SAVE_FAILED",
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

    const crossBorderAccountTestId = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/logistics\/cross-border\/accounts\/([^/]+)\/test$/u,
    );
    if (req.method === "POST" && crossBorderAccountTestId) {
      crossBorderAccountService
        .testAccount(crossBorderAccountTestId)
        .then((payload) => {
          createJsonResponse(
            res,
            payload.ok
              ? 200
              : payload.error?.code === "CROSS_BORDER_ACCOUNT_NOT_FOUND"
                ? 404
                : 501,
            payload,
            corsHeaders,
          );
        })
        .catch((error) => {
          createJsonResponse(
            res,
            501,
            {
              ok: false,
              error: {
                code: error.code || "CROSS_BORDER_ACCOUNT_TEST_FAILED",
                message: error instanceof Error ? error.message : String(error),
              },
            },
            corsHeaders,
          );
        });
      return true;
    }

    const crossBorderAccountAuthorizeId = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/logistics\/cross-border\/accounts\/([^/]+)\/authorize$/u,
    );
    if (req.method === "POST" && crossBorderAccountAuthorizeId) {
      crossBorderAccountService
        .authorizeAccount(crossBorderAccountAuthorizeId)
        .then((payload) => {
          const code = payload.error?.code || "";
          createJsonResponse(
            res,
            payload.ok
              ? 200
              : code === "CROSS_BORDER_ACCOUNT_NOT_FOUND"
                ? 404
                : code === "CROSS_BORDER_AUTHORIZATION_CREDENTIALS_REQUIRED"
                  ? 400
                  : code === "CROSS_BORDER_AUTHORIZATION_NOT_CONNECTED"
                    ? 501
                    : 502,
            payload,
            corsHeaders,
          );
        })
        .catch((error) => {
          createJsonResponse(
            res,
            502,
            {
              ok: false,
              error: {
                code: error.code || "CROSS_BORDER_AUTHORIZATION_FAILED",
                message: error instanceof Error ? error.message : String(error),
              },
            },
            corsHeaders,
          );
        });
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/logistics/cross-border/endpoints"
    ) {
      try {
        createJsonResponse(
          res,
          200,
          crossBorderReadService.listEndpoints(),
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(
          res,
          501,
          {
            ok: false,
            error: {
              code: error.code || "CROSS_BORDER_READ_NOT_CONNECTED",
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
      requestUrl.pathname === "/api/logistics/cross-border/read"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then(async (body) => {
          try {
            createJsonResponse(
              res,
              200,
              await crossBorderReadService.requestReadOnly(body),
              corsHeaders,
            );
          } catch (error) {
            const status =
              error.code === "CROSS_BORDER_ACCOUNT_NOT_FOUND"
                ? 404
                : error.code === "CROSS_BORDER_WRITE_ENDPOINT_BLOCKED"
                  ? 403
                  : 400;
            createJsonResponse(
              res,
              status,
              {
                ok: false,
                error: {
                  code: error.code || "CROSS_BORDER_READ_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                  response: error.response,
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
      requestUrl.pathname === "/api/logistics/cross-border/write/preview"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 128 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              crossBorderWriteGuardService.previewWrite(body),
              corsHeaders,
            );
          } catch (error) {
            const status =
              error.code === "CROSS_BORDER_WRITE_ENDPOINT_REQUIRED" ? 403 : 400;
            createJsonResponse(
              res,
              status,
              {
                ok: false,
                error: {
                  code: error.code || "CROSS_BORDER_WRITE_PREVIEW_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
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

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/logistics/cross-border/write/confirm"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 128 * 1024 })
        .then(async (body) => {
          try {
            createJsonResponse(
              res,
              200,
              await crossBorderWriteGuardService.confirmWrite(body),
              corsHeaders,
            );
          } catch (error) {
            const status =
              error.code === "CROSS_BORDER_WRITE_ENDPOINT_REQUIRED" ? 403 : 400;
            createJsonResponse(
              res,
              status,
              {
                ok: false,
                error: {
                  code: error.code || "CROSS_BORDER_WRITE_CONFIRM_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
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

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/logistics/cross-border/orders"
    ) {
      try {
        createJsonResponse(
          res,
          200,
          crossBorderOrderService.listOrderRecords(query),
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(
          res,
          501,
          {
            ok: false,
            error: {
              code: error.code || "CROSS_BORDER_ORDER_RECORDS_NOT_CONNECTED",
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
      requestUrl.pathname === "/api/logistics/cross-border/orders"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 256 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              crossBorderOrderService.saveOrderRecord(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "CROSS_BORDER_ORDER_SAVE_FAILED",
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
      requestUrl.pathname === "/api/logistics/cross-border/orders"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              crossBorderOrderService.deleteOrderRecord({ ...query, ...body }),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: "CROSS_BORDER_ORDER_DELETE_FAILED",
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
