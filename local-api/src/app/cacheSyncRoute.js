import { createCatalogCacheValidationErrorPayload } from "../routes/catalogCache.js";
import { createJsonResponse } from "../utils/http.js";
import { createBadJsonPayload, createControlledMarketingCacheErrorPayload, listLightSyncJobs, matchSingleParamRoute, normalizeMarketingLegacyImportEntries } from "./createAppRouteHelpers.js";

export function createCacheSyncRoute({
  catalogCacheService,
  db,
  domainServices,
  ozonScheduler,
  readOwnerWritableJsonRequestBody,
}) {
  return function handleCacheSyncRoute({ corsHeaders, query, req, requestUrl, res }) {
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/cache/marketing/legacy-import"
    ) {
      // This is deliberately a SQLite-only one-time migration endpoint. It
      // must not enqueue a marketing sync or contact Ozon while deciding
      // whether the browser source can be retired.
      readOwnerWritableJsonRequestBody(req, { maxBytes: 8 * 1024 * 1024 })
        .then((body) => {
          try {
            const marketingService = domainServices.get("marketing");
            const payload = marketingService?.importLegacySnapshots?.({
              entries: normalizeMarketingLegacyImportEntries(body),
            }) || {
              ok: false,
              error: {
                code: "MARKETING_CACHE_NOT_CONNECTED",
                message: "营销活动 SQLite 缓存尚未连接。",
              },
            };
            createJsonResponse(
              res,
              payload.ok ? 200 : 503,
              payload,
              corsHeaders,
            );
          } catch (error) {
            const errorPayload =
              createControlledMarketingCacheErrorPayload(error);
            createJsonResponse(
              res,
              errorPayload.error.code === "MARKETING_LEGACY_CANONICAL_EXISTS"
                ? 409
                : 400,
              errorPayload,
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createControlledMarketingCacheErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "PUT" &&
      requestUrl.pathname === "/api/cache/marketing/view-state"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 2 * 1024 * 1024 })
        .then((body) => {
          try {
            const marketingService = domainServices.get("marketing");
            const payload = marketingService?.saveViewState?.(body) || {
              ok: false,
              error: {
                code: "MARKETING_CACHE_NOT_CONNECTED",
                message: "营销活动 SQLite 缓存尚未连接。",
              },
            };
            createJsonResponse(
              res,
              payload.ok ? 200 : 503,
              payload,
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              createControlledMarketingCacheErrorPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createControlledMarketingCacheErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/cache/data-analysis/snapshot"
    ) {
      // A complete normalized market snapshot can contain ten thousand real
      // keyword rows. Keep the larger allowance scoped to this exact typed
      // cache route; ordinary local-api writes retain their smaller limits.
      readOwnerWritableJsonRequestBody(req, { maxBytes: 32 * 1024 * 1024 })
        .then((body) => {
          try {
            const payload = domainServices
              .get("data-analysis")
              ?.saveSnapshot?.(body) || {
              ok: false,
              error: {
                code: "DATA_ANALYSIS_CACHE_NOT_CONNECTED",
                message: "数据分析 SQLite 缓存仓库未接入。",
              },
            };
            createJsonResponse(
              res,
              payload.ok ? 200 : 503,
              payload,
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

    if (
      req.method === "DELETE" &&
      requestUrl.pathname === "/api/cache/data-analysis/snapshot"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 32 * 1024 })
        .then((body) => {
          try {
            const payload = domainServices
              .get("data-analysis")
              ?.deleteSnapshot?.(body) || {
              ok: false,
              error: {
                code: "DATA_ANALYSIS_CACHE_NOT_CONNECTED",
                message: "数据分析 SQLite 缓存仓库未接入。",
              },
            };
            createJsonResponse(
              res,
              payload.ok ? 200 : 503,
              payload,
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

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/cache/data-analysis/sync-state"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            const payload = domainServices
              .get("data-analysis")
              ?.recordSyncState?.(body) || {
              ok: false,
              error: {
                code: "DATA_ANALYSIS_CACHE_NOT_CONNECTED",
                message: "数据分析 SQLite 缓存仓库未接入。",
              },
            };
            createJsonResponse(
              res,
              payload.ok ? 200 : 503,
              payload,
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

    const genericCacheDomain = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/cache\/([^/]+)$/u,
    );
    if (req.method === "GET" && genericCacheDomain) {
      const domainService = domainServices.get(genericCacheDomain);
      if (domainService?.readCache) {
        createJsonResponse(
          res,
          200,
          domainService.readCache(query),
          corsHeaders,
        );
        return true;
      }
      createJsonResponse(
        res,
        200,
        ozonScheduler.readCache(genericCacheDomain, query),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/cache/catalog/sync"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              202,
              catalogCacheService.startCatalogSync(body),
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

    const syncDomain = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/sync\/([^/]+)$/u,
    );
    if (req.method === "POST" && syncDomain) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            if (syncDomain === "catalog") {
              createJsonResponse(
                res,
                202,
                catalogCacheService.startCatalogSync(body),
                corsHeaders,
              );
              return;
            }
            const domainService = domainServices.get(syncDomain);
            if (domainService) {
              const payload = domainService.startSync(body);
              createJsonResponse(
                res,
                payload?.accepted || payload?.ok ? 202 : 501,
                payload,
                corsHeaders,
              );
              return;
            }

            createJsonResponse(
              res,
              501,
              {
                ok: false,
                error: {
                  code: "DOMAIN_SYNC_NOT_CONNECTED",
                  message: `Domain sync for ${syncDomain} is not connected in this foundation stage.`,
                },
                domain: syncDomain,
              },
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
      requestUrl.pathname === "/api/sync/jobs/status"
    ) {
      const ids = String(query.ids || query.jobIds || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 50);
      const lightJobs = listLightSyncJobs(db, ids);
      const lightJobIds = new Set(lightJobs.map((job) => job.jobId));
      const catalogJobs = ids
        .filter((jobId) => !lightJobIds.has(jobId))
        .map((jobId) => catalogCacheService.getCatalogSyncJob(jobId))
        .filter(Boolean);
      const jobs = [...lightJobs, ...catalogJobs];
      const returnedIds = new Set(
        jobs.map((job) => job.jobId || job.id).filter(Boolean),
      );
      createJsonResponse(
        res,
        200,
        {
          ok: true,
          jobs,
          jobIds: [...returnedIds],
          missingIds: ids.filter((jobId) => !returnedIds.has(jobId)),
        },
        corsHeaders,
      );
      return true;
    }

    const syncJobId = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/sync\/jobs\/([^/]+)$/u,
    );
    if (req.method === "GET" && syncJobId) {
      const job =
        ozonScheduler.getJob(syncJobId) ||
        catalogCacheService.getCatalogSyncJob(syncJobId);
      createJsonResponse(
        res,
        job ? 200 : 404,
        job
          ? { ok: true, job }
          : {
              ok: false,
              error: {
                code: "SYNC_JOB_NOT_FOUND",
                message: `Sync job not found: ${syncJobId}`,
              },
            },
        corsHeaders,
      );
      return true;
    }

    const syncJobCancelId = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/sync\/jobs\/([^/]+)\/cancel$/u,
    );
    if (req.method === "POST" && syncJobCancelId) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) => {
          createJsonResponse(
            res,
            200,
            ozonScheduler.cancelJob(
              syncJobCancelId,
              body.reason || "canceled_by_api",
            ),
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

    const syncStateDomain = matchSingleParamRoute(
      requestUrl.pathname,
      /^\/api\/sync\/state\/([^/]+)$/u,
    );
    if (req.method === "GET" && syncStateDomain) {
      createJsonResponse(
        res,
        200,
        {
          ok: true,
          domain: syncStateDomain,
          states: ozonScheduler.listSyncState(syncStateDomain, query),
        },
        corsHeaders,
      );
      return true;
    }
    return false;
  };
}
