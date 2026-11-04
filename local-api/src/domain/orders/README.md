# Orders domain

`orders` 已接入 SQLite cache、Ozon sync 和 Ozon write。

## 接口

```text
GET  /api/cache/orders
POST /api/sync/orders
POST /api/write/orders/preview
POST /api/write/orders/confirm
```

## 当前能力

- 销售订单本地缓存读取，支持店铺、履约类型、时间范围、订单号、分页。
- 默认读取 90 天范围；显式时间范围优先。
- FBS、rFBS、FBO 订单读同步通过 scheduler 执行。
- 取消订单、确认发货、拆单等写入通过 preview / confirm 安全门。
- 写入后记录 audit，并等待 Ozon readback 合并 SQLite。
- 拆单母子单关系由 Ozon 回读确认：母单只读锁定，默认业务列表按规则隐藏或揭示，不能凭本地提交结果直接判定完成。

## 前端口径

销售订单页 local-first 秒开。强制刷新时先保留当前列表，再提交 `/api/sync/orders`，轮询 job 到终态，成功后重新读取 `/api/cache/orders`。失败或超时不清空旧列表。

写入提示规则：

- preview：只表示预览。
- confirm：只表示已提交 Ozon。
- 未回读：只能提示等待回读确认。
- readback 成功并合并 SQLite：才能提示 SQLite 已合并。
- Ozon 拒绝：展示真实拒绝原因。