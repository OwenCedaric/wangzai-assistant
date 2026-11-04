# data-analysis domain

数据分析中心的 local-first 只读聚合域。

## 请求链路

```text
DataAnalysisPage
  -> frontend services/model
  -> local-api /api/cache/data-analysis
  -> dataAnalysisService
  -> dataAnalysisReadModel
  -> calculators
  -> 既有业务 SQLite 表
```

- `GET /api/cache/data-analysis`：按店铺和日期读取实时聚合结果及来源台账；空 `shopId` 聚合全部店铺，非空值按内部 `shops.id` 解析并兼容该店的 Client ID 历史数据。
- `POST /api/sync/data-analysis`：基于当前 SQLite 真实数据重建 6 类紧凑分析快照。
- 官方流量由 `reports` 域按店铺同步到 `ozon_analytics_daily`，全部店铺同步必须逐店提交，完成后再重建聚合。
- 广告分析单独通过 local-api 实时读取 Ozon Performance API，不落业务缓存。

## 分层

```text
dataAnalysis/
  calculators/                  # 销售、商品、财务、售后、营销纯计算
  lib/                          # 通用归一化、币种、诊断规则
  dataAnalysisReadModel.js      # 查询、店铺范围、来源台账、聚合编排
  dataAnalysisService.js        # HTTP domain service 与快照重建流程
```

## 数据与口径红线

- 只读取 Ozon 官方缓存、Performance API 实时结果、人工确认采购成本和跨境物流回查。
- 缺失数据返回 `null + status + source`，不造 0、不造估算值。
- 混合币种和未确认币种绝不合并。
- 利润账本从 `profit_ledger_snapshots` 自动按店铺和日期读取；没有匹配账本时，实际净利润保持 `insufficient_sources`。
- 分析响应不读取或返回订单 `raw_json`，不暴露买家姓名、电话、邮箱和地址。
- 分析快照不覆盖商品、订单、售后、营销、采购和利润业务表。

## 已接来源

- `ozon_orders`
- `ozon_products`
- `ozon_finance_transactions`
- `ozon_returns`
- `ozon_marketing_activities`
- `ozon_marketing_activity_products`
- `ozon_analytics_daily`
- `profit_ledger_snapshots`
- `purchase_order_overrides`
- 跨境物流 SQLite 记录
- Ozon Performance API 授权状态与实时读取

市场全站数据不属于 Seller API 聚合来源；促销归因销售额在官方活动接口未返回前保持 `not_returned`，不得用本地推算冒充。
