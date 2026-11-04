import { OZON_BROWSER_SESSION_TYPE, OZON_FOLLOW_SELLER_SESSION_TYPE } from "../db/repositories/integrationProfileRepository.js";
import { getAccountRemovalClientResourceIds } from "../domain/accountRemoval/accountRemovalClientResources.js";
import { assertBrowserRemovalReceiptBinding, createBrowserRemovalReceiptBinding } from "../domain/accountRemoval/browserRemovalReceiptBinding.js";
import { createJsonResponse, readJsonRequestBody } from "../utils/http.js";
import { createBadJsonPayload, createPurchaseBrowserErrorPayload, matchSingleParamRoute, purchaseBrowserErrorStatus } from "./createAppRouteHelpers.js";

export function createPurchaseBrowserRoute({
  accountRemovalOperationRepository,
  assertAccountOwnerWritable,
  config,
  constantTimeTokenMatches,
  finishAccountOwnerSave,
  integrationProfileRepository,
  prepareAccountOwnerSave,
  purchaseAccountRepository,
  purchaseBrowserCaptureService,
  purchaseBrowserTaskService,
  readOwnerWritableJsonRequestBody,
  shopLicenseGrantRegistry,
  shopRepository,
}) {
  return function handlePurchaseBrowserRoute({ corsHeaders, query, req, requestUrl, res }) {
    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/purchase/accounts"
    ) {
      try {
        const accounts = purchaseAccountRepository.listAccounts();
        const payload = {
          ok: true,
          accounts,
          rows: accounts,
          total: accounts.length,
          hasMore: false,
          nextCursor: "",
        };
        createJsonResponse(res, 200, payload, corsHeaders);
      } catch (error) {
        createJsonResponse(res, 400, createBadJsonPayload(error), corsHeaders);
      }
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/purchase/accounts"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            const admission = prepareAccountOwnerSave(
              "purchase_account",
              body?.id,
              body,
            );
            const payload = purchaseAccountRepository.saveAccount(body);
            finishAccountOwnerSave(admission);
            createJsonResponse(res, 200, payload, corsHeaders);
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

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/purchase/browser-capture/preview"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              purchaseBrowserCaptureService.preview(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              purchaseBrowserErrorStatus(error),
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createPurchaseBrowserErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/purchase/browser-capture/confirm"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              purchaseBrowserCaptureService.confirm(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              purchaseBrowserErrorStatus(error),
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createPurchaseBrowserErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/purchase/browser-capture/refund/preview"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              purchaseBrowserCaptureService.previewRefund(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              purchaseBrowserErrorStatus(error),
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            requestBodyErrorStatus(error),
            { ok: false, error: error.message },
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/purchase/browser-capture/refund/confirm"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              purchaseBrowserCaptureService.confirmRefund(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              purchaseBrowserErrorStatus(error),
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            requestBodyErrorStatus(error),
            { ok: false, error: error.message },
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/purchase/browser-capture/readback"
    ) {
      try {
        createJsonResponse(
          res,
          200,
          purchaseBrowserCaptureService.readback({
            targetId: query.targetId,
            shopId: query.shopId,
            orderKey: query.orderKey,
            ozonOrderId: query.ozonOrderId,
            sku: query.sku,
            offerId: query.offerId,
            purchaseRecordId: query.purchaseRecordId,
          }),
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(
          res,
          purchaseBrowserErrorStatus(error),
          createPurchaseBrowserErrorPayload(error),
          corsHeaders,
        );
      }
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/purchase/browser/tasks"
    ) {
      try {
        const ownerId = String(query.ownerId || "");
        assertAccountOwnerWritable("purchase_account", ownerId, {
          requireExisting: true,
        });
        const tasks = purchaseBrowserTaskService.listTasks(ownerId, {
          limit: query.limit,
        });
        createJsonResponse(
          res,
          200,
          { ok: true, tasks, rows: tasks, total: tasks.length },
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(
          res,
          purchaseBrowserErrorStatus(error),
          createPurchaseBrowserErrorPayload(error),
          corsHeaders,
        );
      }
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/purchase/browser/tasks/preview"
    ) {
      readJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            assertAccountOwnerWritable("purchase_account", body?.ownerId, {
              requireExisting: true,
            });
            createJsonResponse(
              res,
              200,
              purchaseBrowserTaskService.previewTask(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              purchaseBrowserErrorStatus(error),
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createPurchaseBrowserErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    const purchaseBrowserTaskId = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/purchase\/browser\/tasks\/([^/]+)$/u,
    );
    if (req.method === "GET" && purchaseBrowserTaskId) {
      try {
        const task = purchaseBrowserTaskService.getTask(purchaseBrowserTaskId);
        assertAccountOwnerWritable("purchase_account", task.ownerId, {
          requireExisting: true,
        });
        createJsonResponse(res, 200, { ok: true, task }, corsHeaders);
      } catch (error) {
        createJsonResponse(
          res,
          purchaseBrowserErrorStatus(error),
          createPurchaseBrowserErrorPayload(error),
          corsHeaders,
        );
      }
      return true;
    }

    const purchaseBrowserConfirmTaskId = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/purchase\/browser\/tasks\/([^/]+)\/confirm$/u,
    );
    if (req.method === "POST" && purchaseBrowserConfirmTaskId) {
      readJsonRequestBody(req, { maxBytes: 32 * 1024 })
        .then((body) => {
          try {
            const task = purchaseBrowserTaskService.getTask(
              purchaseBrowserConfirmTaskId,
            );
            assertAccountOwnerWritable("purchase_account", task.ownerId, {
              requireExisting: true,
            });
            createJsonResponse(
              res,
              200,
              purchaseBrowserTaskService.confirmTask(
                purchaseBrowserConfirmTaskId,
                body,
              ),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              purchaseBrowserErrorStatus(error),
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createPurchaseBrowserErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    const purchaseBrowserInternalMatch = requestUrl.pathname.match(
      /^\/api\/internal\/purchase-browser\/tasks\/([^/]+)\/(claim|receipt|fail)$/u,
    );
    if (req.method === "POST" && purchaseBrowserInternalMatch) {
      if (
        !constantTimeTokenMatches(
          config.security?.purchaseBrowserToken,
          req.headers["x-wangzai-purchase-browser-token"],
        )
      ) {
        createJsonResponse(
          res,
          403,
          {
            ok: false,
            error: {
              code: "PURCHASE_BROWSER_INTERNAL_CAPABILITY_INVALID",
              message: "内置拍单浏览器能力无效。",
            },
          },
          corsHeaders,
        );
        return true;
      }
      readJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            const [, taskId, action] = purchaseBrowserInternalMatch;
            const handler =
              action === "claim"
                ? purchaseBrowserTaskService.claimTask
                : action === "receipt"
                  ? purchaseBrowserTaskService.completeTask
                  : purchaseBrowserTaskService.failTask;
            createJsonResponse(res, 200, handler(taskId, body), corsHeaders);
          } catch (error) {
            createJsonResponse(
              res,
              purchaseBrowserErrorStatus(error),
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createPurchaseBrowserErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/internal/purchase-browser/plugin-state"
    ) {
      if (
        !constantTimeTokenMatches(
          config.security?.purchaseBrowserToken,
          req.headers["x-wangzai-purchase-browser-token"],
        )
      ) {
        createJsonResponse(
          res,
          403,
          {
            ok: false,
            error: {
              code: "PURCHASE_BROWSER_INTERNAL_CAPABILITY_INVALID",
              message: "内置拍单浏览器能力无效。",
            },
          },
          corsHeaders,
        );
        return true;
      }
      readJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              purchaseBrowserTaskService.recordPluginState(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              purchaseBrowserErrorStatus(error),
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createPurchaseBrowserErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    const purchaseBrowserLoginStatusMatch = requestUrl.pathname.match(
      /^\/api\/internal\/purchase-browser\/accounts\/([^/]+)\/login-status$/u,
    );
    if (req.method === "POST" && purchaseBrowserLoginStatusMatch) {
      if (
        !constantTimeTokenMatches(
          config.security?.purchaseBrowserToken,
          req.headers["x-wangzai-purchase-browser-token"],
        )
      ) {
        createJsonResponse(
          res,
          403,
          {
            ok: false,
            error: {
              code: "PURCHASE_BROWSER_INTERNAL_CAPABILITY_INVALID",
              message: "内置拍单浏览器能力无效。",
            },
          },
          corsHeaders,
        );
        return true;
      }
      readJsonRequestBody(req, { maxBytes: 8 * 1024 })
        .then((body) => {
          try {
            const accountId = decodeURIComponent(
              purchaseBrowserLoginStatusMatch[1],
            );
            const payload = purchaseAccountRepository.saveLoginState(
              accountId,
              body,
            );
            createJsonResponse(res, 200, payload, corsHeaders);
          } catch (error) {
            createJsonResponse(
              res,
              purchaseBrowserErrorStatus(error),
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createPurchaseBrowserErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    const ozonBrowserLoginStatusMatch = requestUrl.pathname.match(
      /^\/api\/internal\/purchase-browser\/integration-profiles\/([^/]+)\/login-status$/u,
    );
    if (req.method === "POST" && ozonBrowserLoginStatusMatch) {
      if (
        !constantTimeTokenMatches(
          config.security?.purchaseBrowserToken,
          req.headers["x-wangzai-purchase-browser-token"],
        )
      ) {
        createJsonResponse(
          res,
          403,
          {
            ok: false,
            error: {
              code: "PURCHASE_BROWSER_INTERNAL_CAPABILITY_INVALID",
              message: "内置浏览器能力无效。",
            },
          },
          corsHeaders,
        );
        return true;
      }
      readJsonRequestBody(req, { maxBytes: 8 * 1024 })
        .then((body) => {
          try {
            const profileId = decodeURIComponent(
              ozonBrowserLoginStatusMatch[1],
            );
            const payload = integrationProfileRepository.saveBrowserLoginState(
              profileId,
              body,
            );
            createJsonResponse(res, 200, payload, corsHeaders);
          } catch (error) {
            createJsonResponse(
              res,
              purchaseBrowserErrorStatus(error),
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createPurchaseBrowserErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/internal/purchase-browser/account-binding"
    ) {
      if (
        !constantTimeTokenMatches(
          config.security?.purchaseBrowserToken,
          req.headers["x-wangzai-purchase-browser-token"],
        )
      ) {
        createJsonResponse(
          res,
          403,
          {
            ok: false,
            error: {
              code: "PURCHASE_BROWSER_INTERNAL_CAPABILITY_INVALID",
              message: "内置拍单浏览器能力无效。",
            },
          },
          corsHeaders,
        );
        return true;
      }
      readJsonRequestBody(req, { maxBytes: 8 * 1024 })
        .then((body) => {
          try {
            let binding;
            if (body?.ownerType === "integration_profile") {
              const profile = integrationProfileRepository.getProfile(
                body?.accountId,
              );
              if (
                !profile ||
                ![
                  OZON_BROWSER_SESSION_TYPE,
                  OZON_FOLLOW_SELLER_SESSION_TYPE,
                ].includes(profile.integrationType)
              ) {
                const error = new Error(
                  "PURCHASE_BROWSER_INTEGRATION_PROFILE_NOT_FOUND",
                );
                error.code = "PURCHASE_BROWSER_INTEGRATION_PROFILE_NOT_FOUND";
                throw error;
              }
              const isFollowSellerFrontProfile =
                profile.integrationType === OZON_FOLLOW_SELLER_SESSION_TYPE;
              let exactShop = null;
              if (!isFollowSellerFrontProfile) {
                exactShop = profile.shopId
                  ? shopRepository.getPublicShopById(profile.shopId)
                  : null;
                if (!exactShop?.clientId) {
                  const error = new Error(
                    "当前卖家后台登录没有对应到已保存的 Ozon 店铺。",
                  );
                  error.code = "SHOP_LICENSE_CLIENT_ID_REQUIRED";
                  throw error;
                }
                // The native browser is another Ozon access path, not a way
                // around the API gate. Resolve profile -> exact local shop ->
                // exact Client ID inside the main-only route and reuse the
                // same in-memory grant registry that protects Ozon API calls.
                shopLicenseGrantRegistry?.assertActive(exactShop.clientId);
              }
              binding = Object.freeze({
                accountId: profile.id,
                accountIncarnation: profile.createdAt,
                platformName: isFollowSellerFrontProfile ? "Ozon买家" : "Ozon",
                ownerType: "integration_profile",
                integrationType: profile.integrationType,
                ...(!isFollowSellerFrontProfile
                  ? {
                      shopId: exactShop.id,
                      clientId: exactShop.clientId,
                    }
                  : {}),
              });
            } else {
              binding = purchaseBrowserTaskService.getOwnerBinding(
                body?.accountId,
              );
            }
            createJsonResponse(res, 200, { ok: true, binding }, corsHeaders);
          } catch (error) {
            createJsonResponse(
              res,
              purchaseBrowserErrorStatus(error),
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createPurchaseBrowserErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname ===
        "/api/internal/purchase-browser/account-removal/prepare"
    ) {
      if (
        !constantTimeTokenMatches(
          config.security?.purchaseBrowserToken,
          req.headers["x-wangzai-purchase-browser-token"],
        )
      ) {
        createJsonResponse(
          res,
          403,
          {
            ok: false,
            error: {
              code: "PURCHASE_BROWSER_INTERNAL_CAPABILITY_INVALID",
              message: "内置拍单浏览器能力无效。",
            },
          },
          corsHeaders,
        );
        return true;
      }
      readJsonRequestBody(req, { maxBytes: 8 * 1024 })
        .then((body) => {
          try {
            const operationId = String(body?.operationId || "").trim();
            const operation =
              accountRemovalOperationRepository.getOperation(operationId);
            const owner = operation?.payload?.confirm?.owner;
            const allowedPhase =
              operation?.phase === "external-delete-pending" ||
              operation?.status === "retryable-failed";
            if (
              !operation ||
              operation.completedAt ||
              !allowedPhase ||
              !["purchase_account", "integration_profile"].includes(
                owner?.ownerType,
              ) ||
              !operation.payload?.ownerIncarnation
            ) {
              throw new Error(
                "PURCHASE_BROWSER_ACCOUNT_REMOVAL_OPERATION_INVALID",
              );
            }
            const resourceIds = getAccountRemovalClientResourceIds(
              owner.ownerType,
            )
              .filter((resourceId) => resourceId.startsWith("browser:"))
              .sort();
            createJsonResponse(
              res,
              200,
              {
                ok: true,
                operationId,
                binding: {
                  accountId: owner.ownerId,
                  accountIncarnation: operation.payload.ownerIncarnation,
                  ownerType: owner.ownerType,
                },
                resourceIds,
                receiptBinding: createBrowserRemovalReceiptBinding(operation),
              },
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              409,
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createPurchaseBrowserErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname ===
        "/api/internal/purchase-browser/account-removal/receipt"
    ) {
      if (
        !constantTimeTokenMatches(
          config.security?.purchaseBrowserToken,
          req.headers["x-wangzai-purchase-browser-token"],
        )
      ) {
        createJsonResponse(
          res,
          403,
          {
            ok: false,
            error: {
              code: "PURCHASE_BROWSER_INTERNAL_CAPABILITY_INVALID",
              message: "内置拍单浏览器能力无效。",
            },
          },
          corsHeaders,
        );
        return true;
      }
      readJsonRequestBody(req, { maxBytes: 32 * 1024 })
        .then((body) => {
          try {
            const operationId = String(body?.operationId || "").trim();
            const operation =
              accountRemovalOperationRepository.getOperation(operationId);
            const owner = operation?.payload?.confirm?.owner;
            const allowedPhase =
              operation?.phase === "external-delete-pending" ||
              operation?.status === "retryable-failed";
            const expectedResourceIds = getAccountRemovalClientResourceIds(
              owner?.ownerType,
            )
              .filter((resourceId) => resourceId.startsWith("browser:"))
              .sort();
            const proof =
              body?.proof &&
              typeof body.proof === "object" &&
              !Array.isArray(body.proof)
                ? body.proof
                : {};
            const actualResourceIds = Array.isArray(proof.resourceIds)
              ? [...proof.resourceIds].map((value) => String(value)).sort()
              : [];
            if (
              !operation ||
              operation.completedAt ||
              !allowedPhase ||
              !["purchase_account", "integration_profile"].includes(
                owner?.ownerType,
              ) ||
              proof.verified !== true ||
              proof.partitionUnavailable !== true ||
              proof.profileAbsent !== true ||
              proof.artifactsAbsent !== true ||
              !/^[a-f0-9]{40}$/u.test(String(proof.ownerRef || "")) ||
              JSON.stringify(actualResourceIds) !==
                JSON.stringify(expectedResourceIds)
            ) {
              throw new Error("PURCHASE_BROWSER_ACCOUNT_REMOVAL_PROOF_INVALID");
            }
            assertBrowserRemovalReceiptBinding(operation, proof);
            for (const resourceId of expectedResourceIds) {
              accountRemovalOperationRepository.recordTrustedClientResourceReceipt(
                operationId,
                resourceId,
              );
            }
            createJsonResponse(
              res,
              200,
              {
                ok: true,
                verified: true,
                resourceCount: expectedResourceIds.length,
              },
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              409,
              createPurchaseBrowserErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createPurchaseBrowserErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }
    return false;
  };
}
