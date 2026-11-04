# Reports domain

`reports` 已接入 Ozon 官方分析接口和本地日粒度缓存，用于数据分析页的流量、浏览、加购、下单件数及销售额指标。

## 当前接口

```text
GET  /api/cache/reports
POST /api/sync/reports
```

## 当前口径

- 同步必须携带单个内部 `shops.id`；“全部店铺”由前端按可用店铺逐家提交，不能向本域传空 `shopId`。
- 请求 Ozon 的 `date_to` 以 `Europe/Moscow` 当天为上限。中国时区已进入次日而莫斯科尚未跨日时，会自动截断，避免 Ozon `date_to must not be greater than current date`。
- 指标固定为 `revenue, ordered_units, hits_view, hits_tocart, session_view`，维度固定为 `day`。
- 同步任务写入 `ozon_request_jobs`，成功后写入 `ozon_analytics_daily`；任务提交不等于数据同步成功。
- SQLite 只保存平台真实返回的数据。空响应和失败响应不会伪造成零值快照。

## 调用链

```text
数据分析页同步流量
  -> 每个可用店铺 POST /api/sync/reports
  -> 等待各店铺 job 到终态
  -> POST /api/sync/data-analysis 重建当前店铺或全部店铺聚合
  -> GET /api/cache/data-analysis 回读
```

部分店铺同步失败时，成功店铺仍参与聚合并回读；失败店铺保留已有缓存和错误状态。
