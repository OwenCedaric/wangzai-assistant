# repositories

repository 层是 local-api 读写 SQLite 的唯一入口。业务 domain 不直接拼接 SQL，前端更不能绕过 local-api 直接访问数据库。

当前 repository 职责：

- 负责 SQLite 表的 upsert、分页、筛选、排序和 total 统计。
- 保存 Ozon 原始返回、标准化字段、remote hash、更新时间和 stale 状态。
- 支撑 `GET /api/cache/:domain` 的 local-first 查询。
- 支撑 `POST /api/sync/:domain` 完成后的 readback 合并。
- 支撑 `POST /api/write/:domain/preview` 和 `POST /api/write/:domain/confirm` 的 audit 证据落库。

约束：

- 写入 SQLite 前必须保留 Ozon 原始证据。
- 真实 0 值、空数组、Ozon 明确返回的状态不能被旧缓存兜底覆盖。
- 分页 total 必须由 SQLite 查询总数得出，不能使用当前页行数冒充。
- 写入确认后，未完成 Ozon 回读前不能把本地缓存改成“已完成”。