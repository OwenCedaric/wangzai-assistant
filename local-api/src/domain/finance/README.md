# Finance domain

`finance` 已接入 SQLite cache 和 Ozon 读同步，不提供写入。

## 接口

```text
GET  /api/cache/finance
POST /api/sync/finance
```

## 当前能力

- Ozon 财务流水读取和 SQLite 缓存。
- 支持按店铺、时间、订单号等条件读取缓存。
- 同步通过 scheduler 后台任务执行，成功后合并到 SQLite。
- 为利润核算提供佣金、服务费、物流费、退款、罚款等真实财务证据。

## 约束

- 不提供 `POST /api/write/finance/preview` 或 `POST /api/write/finance/confirm` 的业务写入能力。
- 财务数据只能以 Ozon 返回和 SQLite 缓存证据展示，不能用前端估算覆盖真实流水。