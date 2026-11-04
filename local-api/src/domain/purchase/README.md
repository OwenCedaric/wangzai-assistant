# Purchase domain

`purchase` 当前承接拍单管理相关本地资料，不直接声明为 Ozon 独立写入域。

## 当前能力

- 拍单页使用销售订单、商品、货源链接、跨境巴士和本地 override 等缓存资料组合展示。
- 采购手工字段、货源链接和本地拍单状态保存在 SQLite 对应 repository 中。
- 与 Ozon 有关的订单读取和写入仍走 `orders` domain。
- 与跨境巴士有关的读取和写入走 cross-border 相关接口和安全门。

## 接口口径

如后续需要独立 `purchase` domain，必须沿用统一接口：

```text
GET  /api/cache/purchase
POST /api/sync/purchase
POST /api/write/purchase/preview
POST /api/write/purchase/confirm
```

当前不能把本地拍单资料写入说成 Ozon 已完成。任何 Ozon 状态变化都必须从 `orders` readback 或真实 Ozon 返回中取得证据。