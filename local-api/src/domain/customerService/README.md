# Customer service domain

客服咨询域的读取能力通过只读探测接入：

```text
POST /api/customer-service/probe
```

默认试验 endpoint：`chat.list`。允许读取：

- `chat.list`
- `chat.history`
- `review.list` / `review.info` / `review.commentList` / `review.count`
- `question.list` / `question.info` / `question.answerList` / `question.count` / `question.topSku`

写入类 endpoint 只登记在 `ozonEndpointRegistry`，不能通过 probe 执行。后续发送、已读、回复、删除、改状态必须接 `/api/write/customerService/preview -> confirm -> readback -> audit`。

当前已经实际实现的写入包括文字回复和批量标记已读：

- `chat.sendMessage` 经过客服写入执行器，并在提交后回读 `chat.history`。
- `chat.read` 按会话逐个调用 Ozon `/v2/chat/read`，`from_message_id` 固定为用户实际看到的最新消息；直接以 Ozon 返回的 `unread_count` 判定结果，不再轮询整店 `chat.list`。返回 0 才完成，返回大于 0 时保留真实未读，部分失败会列出具体会话。

Ozon 单会话请求体固定为 `{ chat_id, from_message_id }`；消息 ID 全程按字符串传递，避免超出 JavaScript 安全整数范围。

只读 Ozon 自动消息/信息推送不调用 Ozon `chat.read`。客服页会把用户查看到的最后一条推送消息 ID 写入本机 SQLite：

- `POST /api/customer-service/push-view-markers/list` 读取当前店铺/账号的已查看标记。
- `PUT /api/customer-service/push-view-markers` 保存当前会话最后一条已查看消息。

这只是软件内的已查看缓存，不伪装成 Ozon 服务端已读；Ozon 返回新消息 ID 后，客服页会重新显示未读。

消息翻译使用小批量请求和单条独立超时；MyMemory 限流时会进入短暂冷却并切换 Google。切换会话或重试会调用 `POST /api/customer-service/translate/cancel`，按请求 ID 中止旧任务，避免重复翻译任务互相拥堵。
