# Returns domain

`returns` 已接入 SQLite cache、Ozon sync 和 Ozon write。

## 接口

```text
GET  /api/cache/returns
POST /api/sync/returns
POST /api/write/returns/preview
POST /api/write/returns/confirm
```

## 当前能力

- 售后、退货、rFBS return、取消申请等 Ozon 返回数据缓存。
- 默认读取 90 天范围；显式时间范围优先。
- 售后原因、物流状态和退款证据以 Ozon 原始返回为准，并保留中文化展示规则。
- rFBS 退货处理写入走 preview / confirm，写后等待 readback 合并。

## 写入规则

- preview 只生成预览和风险提示。
- confirm 才提交 Ozon。
- 未回读不能显示完成。
- readback 成功合并 SQLite 后，才能提示 SQLite 已合并。
- Ozon 拒绝必须展示真实拒绝原因。