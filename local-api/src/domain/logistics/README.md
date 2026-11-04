# Logistics domain

`logistics` 已接入 SQLite cache 和 Ozon 读同步，不提供写入。

## 接口

```text
GET  /api/cache/logistics
POST /api/sync/logistics
```

## 当前能力

- Ozon 仓库、配送方式等基础物流资料读取。
- 同步通过 scheduler 后台任务执行。
- 缓存结果供订单、商品、拍单和利润相关页面复用。

## 约束

- 不提供物流写入安全门。
- 物流资料以 Ozon 返回为准，不能用前端静态字典覆盖真实数据。