import { OZON_BROWSER_SESSION_TYPE } from "../db/repositories/integrationProfileRepository.js";
import { paidCapabilityContextFromRequest } from "../domain/paidCapabilities/paidCapabilityAccess.js";
import { callExternalDataApi, createExternalDataApiDiagnostic, createExternalDataApiErrorPayload, normalizeExternalIntegrationBaseUrl, preparePaidSeerfarRead, testExternalDataApiConnection } from "../integrations/externalDataApiClient.js";
import { createPlatformIntegrationTestErrorPayload, executePerformanceWriteAction, readPerformanceAdvancedReport, readPerformanceProductCandidates, readPerformanceRealtimeOverview, testPlatformIntegrationConnection } from "../integrations/performanceApiClient.js";
import { testWecomGroupBotWebhook } from "../integrations/wecomGroupBotClient.js";
import { createShopConnectionTestFailedPayload, createShopCredentialsRequiredPayload, createShopNotFoundPayload } from "../routes/shops.js";
import { createRequestContext } from "../security/requestContext.js";
import { createJsonResponse, readJsonRequestBody } from "../utils/http.js";
import { createBadJsonPayload, createModelApiDiscoveryFailureUpdates, createPerformanceAccountSavedPayload, isAccountRemovalError, matchSingleParamRoute, normalizeText } from "./createAppRouteHelpers.js";

export function createIntegrationAccountRoute({
  assertProfileSettingOwnersWritable,
  config,
  crossBorderChargeService,
  db,
  externalIntegrationFetchImpl,
  finishAccountOwnerSave,
  getVerifiedOzonSellerIdentityIds,
  integrationCredentialRepository,
  integrationProfileRepository,
  modelApiAccountRepository,
  modelApiDiscoveryService,
  ozonScheduler,
  paidCapabilityAccess,
  performanceAccountRepository,
  performanceCredentialResolver,
  prepareAccountOwnerSave,
  profileAssetRepository,
  profileSettingsRepository,
  readOwnerWritableJsonRequestBody,
  runShopConnectionCheck,
  seerfarCategoryTreeService,
  shopRepository,
  syncSnapshotService,
}) {
  return function handleIntegrationAccountRoute({ corsHeaders, query, req, requestUrl, res }) {
    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/model-api/accounts"
    ) {
      const accounts = modelApiAccountRepository.listAccounts();
      createJsonResponse(
        res,
        200,
        { ok: true, accounts, rows: accounts, total: accounts.length },
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/model-api/accounts"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then(async (body) => {
          try {
            const requestedId = String(
              body?.id || body?.accountId || "",
            ).trim();
            const existing = requestedId
              ? modelApiAccountRepository
                  .listAccounts()
                  .find((item) => item.id === requestedId)
              : null;
            const existingCredentials = requestedId
              ? modelApiAccountRepository.getCredentialsForInternalUse(
                  requestedId,
                )
              : null;
            const inputHasApiKey =
              Object.prototype.hasOwnProperty.call(body || {}, "apiKey") ||
              Object.prototype.hasOwnProperty.call(body || {}, "api_key");
            let discoveryUpdates = {};
            if (String(body?.websiteUrl || body?.website_url || "").trim()) {
              try {
                const discovery = await modelApiDiscoveryService.discover({
                  ...body,
                  apiKey: inputHasApiKey
                    ? body.apiKey || body.api_key
                    : existingCredentials?.apiKey || "",
                });
                discoveryUpdates =
                  discovery?.updates && typeof discovery.updates === "object"
                    ? discovery.updates
                    : {};
              } catch (error) {
                // Discovery is best-effort. Keep the endpoint and encrypted
                // API key even when a provider is temporarily unreachable or
                // the entered endpoint needs correction.
                discoveryUpdates = createModelApiDiscoveryFailureUpdates(error);
              }
            }
            const saveInput = { ...body, ...discoveryUpdates };
            if (!saveInput.apiAlias) {
              saveInput.apiAlias = existing?.apiAlias || "模型中转站";
            }
            const admission = prepareAccountOwnerSave(
              "model_api_account",
              saveInput.id,
              saveInput,
            );
            const payload = modelApiAccountRepository.saveAccount(saveInput);
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

    const profileSettingNamespace = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/profile-settings\/([^/]+)$/u,
    );
    if (req.method === "GET" && profileSettingNamespace) {
      try {
        createJsonResponse(
          res,
          200,
          {
            ok: true,
            setting: profileSettingsRepository.getSetting(
              profileSettingNamespace,
            ),
          },
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(res, 400, createBadJsonPayload(error), corsHeaders);
      }
      return true;
    }

    if (req.method === "PUT" && profileSettingNamespace) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 1024 * 1024 })
        .then((body) => {
          let transactionOpen = false;
          try {
            assertProfileSettingOwnersWritable(
              profileSettingNamespace,
              body?.value,
            );
            const shouldRevalueCrossBorderCharges =
              profileSettingNamespace === "fee-settings" &&
              typeof crossBorderChargeService?.revalueStoredCharges ===
                "function";
            if (shouldRevalueCrossBorderCharges) {
              db.exec("BEGIN IMMEDIATE");
              transactionOpen = true;
            }
            const saved = profileSettingsRepository.saveSetting({
              ...body,
              namespace: profileSettingNamespace,
            });
            let crossBorderChargeRevaluation = null;
            if (shouldRevalueCrossBorderCharges) {
              const requestContext = createRequestContext({
                req,
                query,
                body,
                defaultTenantId:
                  config?.runtime?.tenantId || config?.runtime?.appId,
                defaultUserId: config?.runtime?.userId,
              });
              crossBorderChargeRevaluation =
                crossBorderChargeService.revalueStoredCharges(requestContext, {
                  manageTransaction: false,
                });
              db.exec("COMMIT");
              transactionOpen = false;
            }
            createJsonResponse(
              res,
              200,
              {
                ...saved,
                ...(crossBorderChargeRevaluation
                  ? { crossBorderChargeRevaluation }
                  : {}),
              },
              corsHeaders,
            );
          } catch (error) {
            if (transactionOpen) db.exec("ROLLBACK");
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

    if (req.method === "DELETE" && profileSettingNamespace) {
      try {
        createJsonResponse(
          res,
          200,
          profileSettingsRepository.deleteSetting(profileSettingNamespace),
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(res, 400, createBadJsonPayload(error), corsHeaders);
      }
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/profile-assets"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 2 * 1024 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              profileAssetRepository.saveAsset(body),
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

    const profileAssetId = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/profile-assets\/([^/]+)$/u,
    );
    if (req.method === "GET" && profileAssetId) {
      const asset = profileAssetRepository.getAsset(profileAssetId, {
        includeData: true,
      });
      createJsonResponse(res, 200, { ok: true, asset }, corsHeaders);
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/integrations/profiles"
    ) {
      try {
        const profiles = integrationProfileRepository
          .listProfiles()
          .map((profile) => ({
            ...profile,
            ...(integrationCredentialRepository.getCredential(profile.id) ||
              {}),
          }));
        const payload = {
          ok: true,
          profiles,
          rows: profiles,
          total: profiles.length,
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
      requestUrl.pathname === "/api/integrations/profiles"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          let transactionStarted = false;
          try {
            const admission = prepareAccountOwnerSave(
              "integration_profile",
              body?.id,
              body,
            );
            db.exec("BEGIN IMMEDIATE");
            transactionStarted = true;
            const saved = integrationProfileRepository.saveProfile(body);
            let credential = null;
            if (
              body?.credentials &&
              typeof body.credentials === "object" &&
              !Array.isArray(body.credentials)
            ) {
              const baseUrl = saved.profile.integrationType === "wecom-group-bot"
                ? "https://qyapi.weixin.qq.com"
                : normalizeExternalIntegrationBaseUrl(
                  saved.profile.integrationType,
                  body.credentials.baseUrl,
                );
              credential = integrationCredentialRepository.saveCredential(
                saved.profile.id,
                {
                  ...body.credentials,
                  baseUrl,
                },
              ).credential;
            }
            db.exec("COMMIT");
            transactionStarted = false;
            finishAccountOwnerSave(admission);
            createJsonResponse(
              res,
              200,
              {
                ...saved,
                profile: { ...saved.profile, ...(credential || {}) },
              },
              corsHeaders,
            );
          } catch (error) {
            if (transactionStarted) {
              try {
                db.exec("ROLLBACK");
              } catch {
                // Preserve the original validation/persistence error.
              }
            }
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

    const ozonShopIdentityVerificationMatch = requestUrl.pathname.match(
      /^\/api\/integrations\/profiles\/([^/]+)\/verify-ozon-shop-identity$/u,
    );
    if (req.method === "POST" && ozonShopIdentityVerificationMatch) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then(async (body) => {
          const profileId = decodeURIComponent(
            ozonShopIdentityVerificationMatch[1],
          );
          const shopId = normalizeText(body?.shopId);
          const profile = integrationProfileRepository.getProfile(profileId);
          if (
            !profile ||
            profile.integrationType !== OZON_BROWSER_SESSION_TYPE
          ) {
            createJsonResponse(
              res,
              404,
              {
                ok: false,
                error: {
                  code: "OZON_BROWSER_PROFILE_NOT_FOUND",
                  message: "找不到当前店铺的 Ozon 卖家后台登录。",
                },
              },
              corsHeaders,
            );
            return;
          }
          if (!shopId || profile.shopId !== shopId) {
            createJsonResponse(
              res,
              409,
              {
                ok: false,
                error: {
                  code: "OZON_BROWSER_SHOP_IDENTITY_SCOPE_MISMATCH",
                  message: "卖家后台登录与当前 Ozon 店铺不一致，已停止核对。",
                },
                profile,
              },
              corsHeaders,
            );
            return;
          }
          if (
            !profile.browserCompanyId ||
            profile.tokenStatus !== "Cookie 已保存"
          ) {
            createJsonResponse(
              res,
              409,
              {
                ok: false,
                error: {
                  code: "OZON_BROWSER_COMPANY_ID_REQUIRED",
                  message:
                    "Ozon 卖家后台已登录，但还没有识别到当前公司 ID，请刷新后再保存一次。",
                },
                profile,
              },
              corsHeaders,
            );
            return;
          }
          const shop = shopRepository.getPublicShopById(shopId);
          if (!shop) {
            createJsonResponse(
              res,
              404,
              createShopNotFoundPayload(shopId),
              corsHeaders,
            );
            return;
          }
          if (!shop.hasClientId || !shop.hasApiKey) {
            createJsonResponse(
              res,
              400,
              createShopCredentialsRequiredPayload(shop),
              corsHeaders,
            );
            return;
          }
          try {
            const result = await runShopConnectionCheck({
              shop,
              ozonScheduler,
            });
            if (!result.ok) {
              createJsonResponse(
                res,
                502,
                {
                  ...createShopConnectionTestFailedPayload({
                    shop,
                    step: result.step,
                    result: result.result,
                  }),
                  profile: integrationProfileRepository.getProfile(profileId),
                },
                corsHeaders,
              );
              return;
            }
            const verified =
              integrationProfileRepository.confirmBrowserApiIdentity(
                profileId,
                {
                  shopId,
                  acceptedIdentityIds: getVerifiedOzonSellerIdentityIds(
                    shop,
                    result,
                  ),
                  source: "roles+seller-info",
                },
              );
            if (!verified.connected) {
              createJsonResponse(
                res,
                409,
                {
                  ok: false,
                  connected: false,
                  identityMatched: false,
                  profile: verified.profile,
                  error: {
                    code: "OZON_BROWSER_API_IDENTITY_MISMATCH",
                    message: `网页登录账号 ${verified.profile.browserCompanyId || "未识别"} 与当前店铺 API 账号 ${verified.profile.apiIdentityId || shop.clientId || "未配置"} 不一致。`,
                  },
                },
                corsHeaders,
              );
              return;
            }
            createJsonResponse(
              res,
              200,
              {
                ok: true,
                connected: true,
                identityMatched: true,
                profile: verified.profile,
                sellerInfo: result.sellerInfo,
              },
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              502,
              {
                ...createShopConnectionTestFailedPayload({
                  shop,
                  step: "Ozon",
                  error,
                }),
                profile: integrationProfileRepository.getProfile(profileId),
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
      requestUrl.pathname === "/api/performance/accounts"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            const admission = prepareAccountOwnerSave(
              "promotion_account",
              body?.id,
              body,
            );
            const savedAccount = performanceAccountRepository.saveAccount(body);
            finishAccountOwnerSave(admission);
            createJsonResponse(
              res,
              200,
              createPerformanceAccountSavedPayload(savedAccount),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              isAccountRemovalError(error)
                ? createBadJsonPayload(error)
                : createPlatformIntegrationTestErrorPayload(error),
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

    const performanceAccountTestId = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/performance\/accounts\/([^/]+)\/test$/u,
    );
    if (req.method === "POST" && performanceAccountTestId) {
      testPlatformIntegrationConnection(
        { type: "ozon-performance", accountId: performanceAccountTestId },
        { credentialResolver: performanceCredentialResolver },
      )
        .then((payload) => {
          const campaignCount = payload.summary?.campaignCount ?? 0;
          const statisticsTaskCount = payload.summary?.statisticsTaskCount ?? 0;
          const account = performanceAccountRepository.updateTestResult(
            performanceAccountTestId,
            {
              ok: true,
              campaignCount,
              statisticsTaskCount,
              message: `只读测试通过：广告计划 ${campaignCount} 个，统计任务 ${statisticsTaskCount} 个。`,
            },
          );
          createJsonResponse(res, 200, { ...payload, account }, corsHeaders);
        })
        .catch((error) => {
          performanceAccountRepository.updateTestResult(
            performanceAccountTestId,
            {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            },
          );
          createJsonResponse(
            res,
            error?.statusCode || 502,
            createPlatformIntegrationTestErrorPayload(error),
            corsHeaders,
          );
        });
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/integrations/seerfar/category-tree"
    ) {
      seerfarCategoryTreeService
        .readOptions({
          query: requestUrl.searchParams.get("query") || "",
          parentId: requestUrl.searchParams.get("parentId") || "0",
          limit: requestUrl.searchParams.get("limit") || 80,
          forceRefresh: requestUrl.searchParams.get("refresh") === "1",
        })
        .then((payload) => createJsonResponse(res, 200, payload, corsHeaders))
        .catch((error) =>
          createJsonResponse(
            res,
            502,
            {
              ok: false,
              code: "SEERFAR_CATEGORY_TREE_UNAVAILABLE",
              message: error instanceof Error ? error.message : String(error),
            },
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/integrations/test"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then(async (body) => {
          try {
            const integrationType = String(
              body?.type || body?.integrationType || "",
            ).trim();
            const profileId = String(
              body?.profileId || body?.accountId || "",
            ).trim();
            if (integrationType === "ozon-performance") {
              const payload = await testPlatformIntegrationConnection(body, {
                credentialResolver: performanceCredentialResolver,
              });
              createJsonResponse(res, 200, payload, corsHeaders);
              return;
            }
            if (integrationType === "wecom-group-bot") {
              const profile = integrationProfileRepository.getProfile(profileId);
              const credentials = integrationCredentialRepository.getCredentialsForInternalUse(profileId);
              if (!profile || !credentials?.apiKey) {
                throw new Error("请先保存企业微信机器人 Webhook 地址。");
              }
              const result = await testWecomGroupBotWebhook(credentials.apiKey, {
                fetchImpl: externalIntegrationFetchImpl,
              });
              const credential = integrationCredentialRepository.updateTestResult(profileId, {
                status: "connected",
                message: result.message,
                metadata: { provider: "wecom-group-bot" },
              });
              createJsonResponse(res, 200, {
                ...result,
                status: "connected",
                profile: { ...profile, ...credential },
              }, corsHeaders);
              return;
            }
            const profile = integrationProfileRepository.getProfile(profileId);
            const credentials =
              integrationCredentialRepository.getCredentialsForInternalUse(
                profileId,
              );
            if (!profile) throw new Error("找不到当前外部接口配置。");
            if (!credentials)
              throw new Error("请先保存接口网址和 API Key / Token。");
            const result = await testExternalDataApiConnection(
              profile,
              credentials,
              {
                fetchImpl: externalIntegrationFetchImpl,
              },
            );
            const credential = integrationCredentialRepository.updateTestResult(
              profileId,
              result,
            );
            const payload = {
              ...result,
              profile: { ...profile, ...credential },
            };
            createJsonResponse(res, 200, payload, corsHeaders);
          } catch (error) {
            const profileId = String(
              body?.profileId || body?.accountId || "",
            ).trim();
            if (
              profileId &&
              integrationCredentialRepository.getCredential(profileId)
            ) {
              integrationCredentialRepository.updateTestResult(profileId, {
                status: "error",
                message: error instanceof Error ? error.message : String(error),
              });
            }
            createJsonResponse(
              res,
              error?.statusCode || 502,
              createExternalDataApiErrorPayload(error),
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
      requestUrl.pathname === "/api/integrations/read"
    ) {
      readJsonRequestBody(req, { maxBytes: 256 * 1024 })
        .then(async (body) => {
          try {
            const profileId = String(body?.profileId || "").trim();
            const profile = integrationProfileRepository.getProfile(profileId);
            const credentials =
              integrationCredentialRepository.getCredentialsForInternalUse(
                profileId,
              );
            let payload;
            const testedAt = new Date(credentials?.lastTestAt || "").getTime();
            const connectionIsFresh =
              Number.isFinite(testedAt) &&
              testedAt <= Date.now() &&
              Date.now() - testedAt <= 10 * 60 * 1000;
            if (
              profile &&
              credentials?.apiKey &&
              credentials.lastTestStatus === "connected" &&
              connectionIsFresh
            ) {
              payload = await callExternalDataApi(profile, credentials, body, {
                fetchImpl: externalIntegrationFetchImpl,
              });
            } else {
              const prepared = preparePaidSeerfarRead(body);
              const paid = await paidCapabilityAccess.execute({
                capability: prepared.capability,
                input: { requestBody: prepared.requestBody },
                context: paidCapabilityContextFromRequest(req),
              });
              payload = {
                ok: true,
                provider: "seerfar-open-api",
                operation: prepared.operation,
                data: paid.result.data,
                billing: {
                  chargedPoints: paid.chargedPoints,
                  source: "paid-cloud",
                },
              };
            }
            createJsonResponse(res, 200, payload, corsHeaders);
          } catch (error) {
            console.warn(
              "[local-api][external-integration] read request error",
              JSON.stringify(createExternalDataApiDiagnostic(error, body)),
            );
            createJsonResponse(
              res,
              error?.statusCode || 502,
              createExternalDataApiErrorPayload(error),
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
      requestUrl.pathname === "/api/performance/overview"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then(async (body) => {
          try {
            const payload = await readPerformanceRealtimeOverview(body, {
              notificationService: syncSnapshotService,
              credentialResolver: performanceCredentialResolver,
            });
            createJsonResponse(res, 200, payload, corsHeaders);
          } catch (error) {
            createJsonResponse(
              res,
              error?.statusCode || 502,
              createPlatformIntegrationTestErrorPayload(error),
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
      requestUrl.pathname === "/api/performance/products"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then(async (body) => {
          try {
            const payload = await readPerformanceProductCandidates(body, {
              credentialResolver: performanceCredentialResolver,
            });
            createJsonResponse(res, 200, payload, corsHeaders);
          } catch (error) {
            createJsonResponse(
              res,
              error?.statusCode || 502,
              createPlatformIntegrationTestErrorPayload(error),
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
      requestUrl.pathname === "/api/performance/reports"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 128 * 1024 })
        .then(async (body) => {
          try {
            const payload = await readPerformanceAdvancedReport(body, {
              credentialResolver: performanceCredentialResolver,
            });
            createJsonResponse(res, 200, payload, corsHeaders);
          } catch (error) {
            createJsonResponse(
              res,
              error?.statusCode || 502,
              createPlatformIntegrationTestErrorPayload(error),
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
      requestUrl.pathname === "/api/performance/action"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 128 * 1024 })
        .then(async (body) => {
          try {
            const payload = await executePerformanceWriteAction(body, {
              credentialResolver: performanceCredentialResolver,
            });
            createJsonResponse(res, 200, payload, corsHeaders);
          } catch (error) {
            createJsonResponse(
              res,
              error?.statusCode || 502,
              createPlatformIntegrationTestErrorPayload(error),
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
