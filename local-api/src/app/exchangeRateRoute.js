import { createJsonResponse } from "../utils/http.js";
import { createBadJsonPayload } from "./createAppRouteHelpers.js";

export function createExchangeRateRoute({
  exchangeRateCacheRepository,
  exchangeRateService,
  readOwnerWritableJsonRequestBody,
}) {
  return function handleExchangeRateRoute({ corsHeaders, query, req, requestUrl, res }) {
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/exchange-rate/rub-cny/cache"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 256 * 1024 })
        .then((body) => {
          try {
            createJsonResponse(
              res,
              200,
              exchangeRateCacheRepository.saveRecords(body),
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: error?.message || "EXCHANGE_RATE_CACHE_SAVE_FAILED",
                  message: error?.message || String(error),
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
      requestUrl.pathname === "/api/exchange-rate/rub-cny/realtime"
    ) {
      exchangeRateService
        .readRealtimeRubCnyRate()
        .then((payload) => {
          createJsonResponse(res, payload.ok ? 200 : 502, payload, corsHeaders);
        })
        .catch((error) => {
          createJsonResponse(
            res,
            502,
            {
              ok: false,
              mode: "realtime",
              base: "RUB",
              quote: "CNY",
              error: {
                code: "EXCHANGE_RATE_UNAVAILABLE",
                message: error instanceof Error ? error.message : String(error),
              },
            },
            corsHeaders,
          );
        });
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/exchange-rate/rub-cny/daily-batch"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then(async (body) => {
          try {
            const payload = await exchangeRateService.readDailyRubCnyRates({
              dates: body?.dates,
              allowNearest: body?.allowNearest !== false,
              maxLookbackDays: body?.maxLookbackDays,
            });
            const status = payload.ok
              ? 200
              : payload.error?.code === "EXCHANGE_RATE_DATES_REQUIRED"
                ? 400
                : 502;
            createJsonResponse(res, status, payload, corsHeaders);
          } catch (error) {
            createJsonResponse(
              res,
              502,
              {
                ok: false,
                mode: "daily-batch",
                base: "RUB",
                quote: "CNY",
                error: {
                  code: "EXCHANGE_RATE_UNAVAILABLE",
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
      requestUrl.pathname === "/api/exchange-rate/rub-cny/daily"
    ) {
      exchangeRateService
        .readDailyRubCnyRate({
          date: query.date,
          allowNearest: query.allowNearest !== "false",
          maxLookbackDays: query.maxLookbackDays,
        })
        .then((payload) => {
          const status = payload.ok
            ? 200
            : payload.error?.code === "EXCHANGE_RATE_DATE_REQUIRED"
              ? 400
              : 502;
          createJsonResponse(res, status, payload, corsHeaders);
        })
        .catch((error) => {
          createJsonResponse(
            res,
            502,
            {
              ok: false,
              mode: "daily",
              base: "RUB",
              quote: "CNY",
              error: {
                code: "EXCHANGE_RATE_UNAVAILABLE",
                message: error instanceof Error ? error.message : String(error),
              },
            },
            corsHeaders,
          );
        });
      return true;
    }
    return false;
  };
}
