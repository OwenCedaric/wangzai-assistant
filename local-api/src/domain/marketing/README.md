# Marketing domain

`marketing` 已接入 SQLite cache、Ozon sync 和 Ozon write。

## 接口

```text
GET  /api/cache/marketing
POST /api/sync/marketing
POST /api/write/marketing/preview
POST /api/write/marketing/confirm
```

## 当前能力

- 营销活动列表、活动商品池、本地摘要缓存读取。
- Ozon 营销活动相关只读数据通过 scheduler 同步。
- 活动商品操作和活动写入通过 preview / confirm 安全门。
- 写入后必须等待 Ozon 返回和 readback 证据，才能合并 SQLite。

## 前端口径

营销活动页应 local-first 读取 SQLite。刷新时提交 sync job，不在页面层直接访问 Ozon。写入提示必须区分 preview、已提交 Ozon、等待回读、SQLite 已合并和 Ozon 拒绝。