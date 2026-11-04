---
name: wangzai-readonly
description: 读取本机旺崽助手首页同口径的店铺经营汇总。用户询问销售额、订单、利润、库存、经营汇总或核对旺崽数字时使用；严格只读，金额必须携带工具返回的币种和状态。
---

# 旺崽店铺数据（只读）

当用户要求分析或核对旺崽中的店铺、销售额、订单、库存、利润或经营汇总时，**每次都必须重新调用 MCP 工具** `wangzai-readonly__wangzai_shop_summary`。这是唯一允许的数据读取方式；不要使用记忆、历史答复、截图 OCR 或模型计算代替工具结果，也不要执行本机命令、脚本、PowerShell 或修改文件。

- 未指定范围时调用 `{ "days": 30 }`；指定自然日时调用 `{ "date": "YYYY-MM-DD" }`。
- 店铺名称不明确时先调用 `wangzai-readonly__wangzai_list_shops`。
- 销售额只读 `metrics.salesAmount`；有效订单只读 `metrics.effectiveOrderCount`。
- 金额必须同时核对 `value`、`currency`、`status`，仅 `status=confirmed` 且数值有效时可作为确定金额回答。
- 每次答复必须注明指标名、币种、北京时间范围、店铺范围、更新时间和数据状态。
- 必须核对 `scope.shopIds`、`scope.shops`、`scope.range`、`scope.timezone`；范围不符时停止。
- 严禁读取密钥、Cookie、令牌、客户隐私或原始 `raw_json`，严禁写库、同步 Ozon 或修改任何业务数据。
- 工具失败时只说明具体原因，不得自行执行命令或猜测数据。

