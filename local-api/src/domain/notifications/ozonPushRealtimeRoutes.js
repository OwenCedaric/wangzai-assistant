import { createJsonResponse } from "../../utils/http.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

export function createOzonPushRealtimeRoutes({ hub } = {}) {
  return {
    handleRequest({ req, res, requestUrl, corsHeaders = {} } = {}) {
      if (req?.method !== "GET" || requestUrl?.pathname !== "/api/ozon/push-realtime/wait") {
        return false;
      }
      const shopId = normalizeText(requestUrl.searchParams.get("shopId"));
      if (!shopId) {
        createJsonResponse(res, 400, {
          ok: false,
          error: { code: "OZON_PUSH_REALTIME_SHOP_REQUIRED", message: "请选择 Ozon 店铺。" },
        }, corsHeaders);
        return true;
      }
      if (!requestUrl.searchParams.has("afterSequence")) {
        createJsonResponse(res, 200, hub.getCursor(shopId), corsHeaders);
        return true;
      }
      const controller = new AbortController();
      const abortDisconnectedRequest = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once("aborted", abortDisconnectedRequest);
      res.once("close", abortDisconnectedRequest);
      void hub.waitForEvent({
        shopId,
        afterSequence: requestUrl.searchParams.get("afterSequence"),
        timeoutMs: requestUrl.searchParams.get("timeoutMs"),
        signal: controller.signal,
      }).then((payload) => {
        if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
        createJsonResponse(res, 200, payload, corsHeaders);
      }).catch((error) => {
        if (controller.signal.aborted || error?.name === "AbortError" || res.destroyed || res.writableEnded) return;
        createJsonResponse(res, 400, {
          ok: false,
          error: {
            code: error?.code || "OZON_PUSH_REALTIME_WAIT_FAILED",
            message: error instanceof Error ? error.message : "Ozon 推送实时等待失败。",
          },
        }, corsHeaders);
      }).finally(() => {
        req.removeListener("aborted", abortDisconnectedRequest);
        res.removeListener("close", abortDisconnectedRequest);
      });
      return true;
    },
  };
}

