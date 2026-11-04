import {
  createJsonResponse,
  readJsonRequestBody,
} from "../utils/http.js";

function createBadJsonPayload(error) {
  return {
    ok: false,
    error: {
      code: "BAD_JSON_BODY",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function isTestSplitSimulationRouteEnabled(env = process.env) {
  return env?.NODE_ENV === "test" || env?.ALLOW_TEST_ROUTES === "true";
}

export function handleTestSplitSimulationRoute({
  req,
  res,
  domainServices,
  corsHeaders,
  env = process.env,
}) {
  if (!isTestSplitSimulationRouteEnabled(env)) {
    createJsonResponse(
      res,
      404,
      {
        ok: false,
        error: {
          code: "ORDER_TEST_SPLIT_ROUTE_DISABLED",
          message:
            "本地测试单，不写入 Ozon；TEST-SPLIT 模拟入口仅在 NODE_ENV=test 或 ALLOW_TEST_ROUTES=true 时启用。",
        },
      },
      corsHeaders,
    );
    return;
  }

  readJsonRequestBody(req, { maxBytes: 64 * 1024 })
    .then((body) => {
      const ordersService = domainServices.get("orders");
      if (!ordersService?.simulateTestSplit) {
        createJsonResponse(
          res,
          501,
          {
            ok: false,
            error: {
              code: "ORDERS_TEST_SPLIT_NOT_CONNECTED",
              message: "订单测试拆单模拟服务尚未连接。",
            },
          },
          corsHeaders,
        );
        return;
      }
      try {
        const payload = ordersService.simulateTestSplit(body);
        const statusCode = payload.ok
          ? 200
          : payload.error?.code === "ORDER_TEST_SPLIT_PARENT_NOT_FOUND"
            ? 404
            : 400;
        createJsonResponse(res, statusCode, payload, corsHeaders);
      } catch (error) {
        createJsonResponse(
          res,
          400,
          {
            ok: false,
            error: {
              code: "ORDER_TEST_SPLIT_SIMULATION_FAILED",
              message: error instanceof Error ? error.message : String(error),
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
}
