# Catalog domain

`catalog` 已接入 Profile SQLite 共享事实库和 Ozon 只读同步，不提供 Ozon 写入。

## 接口

```text
GET  /api/catalog/shared/catalogs
GET  /api/catalog/shared/tree
GET  /api/catalog/shared/path
GET  /api/catalog/shared/categories
GET  /api/catalog/shared/types
GET  /api/catalog/shared/attributes
GET  /api/catalog/shared/values
POST /api/sync/catalog
```

## 当前能力

- Ozon 类目、属性、属性值等资料缓存。
- 同步任务通过 scheduler 执行。
- repository 层保存标准化节点、属性、映射和 cache key。
- 共享 catalog 以 `platform + marketplace + locale + contract_version` 唯一，不以店铺分割。
- 打包 JSON 只能由 `sharedCatalogService.seedFromPackagedJson()` 作为离线 seed 导入 SQLite。
- 旧 per-shop 字典由 `migrateLegacyShopCatalogs()` 按稳定 key/hash 去重，内容冲突进入 `shared_catalog_quarantine`。
- `catalog_category_mappings` 仍是 shop-scoped 用户映射；删除店铺会删映射，不会级联删除 `shared_catalog_*`。

## 约束

- 当前作为只读资料库使用。
- 不提供 catalog 写入能力。
- 未覆盖的 catalog 子能力必须明确返回未接入状态，不能返回假成功。
- `source_shop_id` 只是无密钥的来源摘要，不建立 `shops` 外键，不得保存 Client ID/API Key/Cookie。
- Renderer 不直接 import 离线 JSON；前端只保留 local-api DTO 生成的可清理 L0 内存投影。
- local-api 启动时仅执行幂等的离线 seed/旧店铺字典 backfill；上述 GET 全部只查 SQLite，不触发 seed、同步或 Ozon 请求。
