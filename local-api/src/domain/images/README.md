# Images domain

`images` 当前为规划占位模块，尚未接入统一 cache / sync / write 业务能力。

## 当前口径

- 不声明已接入 Ozon 图片同步。
- 不声明已接入图片写入。
- 不返回假成功。
- 后续如接入，必须沿用统一域接口：

```text
GET  /api/cache/images
POST /api/sync/images
POST /api/write/images/preview
POST /api/write/images/confirm
```

## 接入要求

- 图片读取必须通过 scheduler 控制 Ozon 请求。
- 写入必须先 preview，再 confirm。
- confirm 后必须等待 Ozon readback 或可验证的 Ozon 返回证据，才能写入 SQLite 并提示完成。