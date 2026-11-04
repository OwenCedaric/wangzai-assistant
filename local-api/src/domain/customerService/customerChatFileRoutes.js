import { createJsonResponse, readJsonRequestBody } from "../../utils/http.js";

function statusForError(error) {
  if (Number(error?.statusCode) >= 400) return Number(error.statusCode);
  if (error?.code === "OZON_HTTP_ERROR" && Number(error?.status) >= 400)
    return Number(error.status);
  if (error?.code === "OZON_FILE_TOO_LARGE") return 413;
  if (error?.code === "OZON_FILE_TYPE_INVALID") return 415;
  if (
    ["OZON_FILE_URL_INVALID", "OZON_FILE_URL_FORBIDDEN"].includes(error?.code)
  )
    return 400;
  return 502;
}

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error?.code || "CUSTOMER_CHAT_FILE_READ_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function createCustomerChatFileRoutes({ service } = {}) {
  return {
    handleRequest({ req, res, requestUrl, corsHeaders = {} }) {
      if (
        req.method === "POST" &&
        requestUrl.pathname === "/api/customer-service/outbound-file/stage"
      ) {
        readJsonRequestBody(req, { maxBytes: 8 * 1024 * 1024 })
          .then((body) => service?.stageOutboundFile?.(body))
          .then((file) =>
            createJsonResponse(res, 200, { ok: true, file }, corsHeaders),
          )
          .catch((error) =>
            createJsonResponse(
              res,
              statusForError(error),
              errorPayload(error),
              corsHeaders,
            ),
          );
        return true;
      }
      if (
        req.method !== "GET" ||
        requestUrl.pathname !== "/api/customer-service/chat-file"
      ) {
        return false;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      const abortOnClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once("aborted", abort);
      res.once("close", abortOnClose);

      Promise.resolve(
        service?.readChatFile?.({
          shopId: requestUrl.searchParams.get("shopId"),
          fileUrl: requestUrl.searchParams.get("url"),
          signal: controller.signal,
        }),
      )
        .then((asset) => {
          if (!asset?.data || !asset?.mimeType) {
            const error = new Error("Ozon 未返回可显示的聊天图片。");
            error.code = "CUSTOMER_CHAT_FILE_EMPTY";
            throw error;
          }
          res.writeHead(200, {
            "content-type": asset.mimeType,
            "content-length": String(asset.data.byteLength),
            "cache-control": "private, max-age=300",
            "x-content-type-options": "nosniff",
            ...corsHeaders,
          });
          res.end(asset.data);
        })
        .catch((error) => {
          if (res.destroyed || res.writableEnded) return;
          createJsonResponse(
            res,
            statusForError(error),
            errorPayload(error),
            corsHeaders,
          );
        })
        .finally(() => {
          req.removeListener("aborted", abort);
          res.removeListener("close", abortOnClose);
        });
      return true;
    },
  };
}
