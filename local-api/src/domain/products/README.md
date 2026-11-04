# Products domain

`products` 已接入 SQLite cache、Ozon sync 和 Ozon write。

## 接口

```text
GET  /api/cache/products
GET  /api/products/support
GET  /api/products/summary
GET  /api/products/material
POST /api/products/material
POST /api/products/material/legacy-import
GET  /api/products/source-links
POST /api/products/source-links
POST /api/products/source-links/legacy-import
POST /api/products/image-health
POST /api/sync/products
POST /api/write/products/preview
POST /api/write/products/confirm
```

上述商品 HTTP 契约统一由 `productsRoutes.js` 持有；`createApp.js` 只注入
SQLite 商品服务、写入安全门、账号销毁写入围栏和请求体上限，然后调用领域
handler。Query 不会降级成 Ozon 请求，Sync 不在网络阶段持有查询事务，Write
返回安全门提供的 Ozon readback，不能把“已提交”改写成“已回读合并”。

## 当前能力

- 商品列表本地缓存读取，支持店铺、状态、关键词、分页、排序。
- Ozon 商品列表、详情、图片、价格、库存、属性同步。
- 商品上下架、库存、价格、商品资料等写入走 preview / confirm。
- 写入后按 Ozon readback 合并 SQLite，不把提交受理当作完成。
- `stock_value` 和 `stock_json.present` 必须以 Ozon 仓库库存合计为准持久化。
- 商品状态以 Ozon 返回的真实 visibility / archived 证据为准，不用库存推断上下架。

## 内部边界

`productsService.js` 与 `productRepository.js` 都只是组合 facade：

```text
productsService
  ├─ productCanonicalReadService       SQLite query/cache/summary
  ├─ productSyncService                list/hydration/proof/atomic activation
  ├─ productSupportService             material/source/image
  ├─ productLegacyMigrationService     explicit migration only
  └─ productWriteReadbackService       preview-confirm-submit-readback port

productRepository
  ├─ productCanonicalQueryRepository   canonical DTO/filter/sort/page/count
  ├─ productSyncStagingRepository      staging/hydration/facet proof
  ├─ productSupportRepository          material/source/image persistence
  ├─ productLegacyMigrationRepository  explicit legacy adapters
  └─ productWriteReadbackRepository    canonical merge/readback port
```

正常商品读取不会导入或调用 legacy migration adapter，也不会从 JSON、浏览器
镜像或 Ozon 回退。

商品列表 query 支持 `shopId` 或 `shopIds`，以及 `materialSources`、
`warehouseFilters`、`defaultWarehouseId`、`warehouseIds`、`stockFilters`、
`productStatuses`、`sourceStatuses`。所有筛选、跨店统一排序、分页、`total` 和
`counts` 都在同一 SQLite canonical query 中完成。

## 前端口径

商品列表优先读 SQLite，手动刷新时提交后台 sync job。刷新完成后再读 SQLite 最新结果，页面统计和列表必须来自同一份本地查询。

写入提示规则：

- preview：只提示预览。
- confirm：只提示已提交 Ozon。
- readback 成功：才能提示 SQLite 已合并、列表已按 Ozon 最新数据刷新。
- Ozon 拒绝：展示真实拒绝原因。
