# 冻结业务契约

从 2026-09-05 重建的根 AGENTS.md 原样迁入；不是历史原文恢复，也不是全部验收通过的声明。
修改相关链路前核验对应章节。下列 npm 命令均在 `frontend/` 目录执行，或在项目根使用 `npm --prefix frontend run <脚本名>`。
冻结清单仍逐字检查这些要求；实现哈希、版本、required/forbidden 与发布标准不因文档迁移而放宽。

## 已冻结模块：店铺经营分析报告

以下条目来自现存冻结契约，修改相关链路时须逐项核验：

- data-analysis-insight-v2-server-template-20260828
- npm run check:data-analysis-insight-freeze

## 已冻结模块：data-analysis-market-capture

以下条目来自现存冻结契约，修改相关链路时须逐项核验：

- data-analysis-market-capture-v2-cef150-bounded-complete-20260828
- npm run check:data-analysis-market-capture-freeze
- market-collector

## 已冻结模块：Ozon 商品图 OSS 闭环

以下条目来自现存冻结契约，修改相关链路时须逐项核验：

- 内置积分图生图必须优先把当前店铺临时私有 OSS 签名图交给付费网关
- 采集商品图片生成历史必须按精确来源商品与当前 `shopId`
- npm run check:product-image-oss-freeze
- 重新应用本批
- 采集商品必须在 SKU/价格步骤、库存按钮旁多选目标店铺
- 采集商品仓库和库存必须按精确 `shopId` 与 SKU 分开保存
- “保存修改”必须保持页面打开并等待采集草稿真实落盘
- 最多 29 张不含主图的 `images`
- `Company is blocked` 必须终止
- 当前勾选的上传店铺作为库存与仓库的唯一展示和提交来源
- 字符串 `"true"/"false"`
- 禁止向属性 `value` 写入原生 JSON 布尔值
- 按精确 `shopId + offer_id/product_id` 聚合
- 禁止把缺失值转成 `0`
- 只有当前分片全部 SKU 回读一致才能继续价格和库存
- 同一 Ozon 商品卡的型号属性 `9048` 必须作为不可拆分的原子组一次写入
- `products.infoList` 为当前批次每个货号返回正数 Ozon `sku`
- 已成功货号不得重复写入
- 320px 高质量 WebP 缩略图
- 可视区延迟加载
- Chromium 私有 HTTP 缓存
- 桌面主进程精确代理到本地 API
- 二进制 WebP 回传
- 禁止落入 SPA 静态页
- 单个生成图预览固定为 112px 高
- 禁止缩略图自然尺寸撑大卡片
- 一次短退避重试
- product-image-oss-v94-server-template-current-flow-20260828
- 店铺选择器必须优先显示用户配置的内部店铺简称
- 内联 `inset: 0`
- `position: relative`
- 私有图片资产所属店铺 `assetShopId` 是三个独立作用域
- 生成图历史签名、预览和持久化必须按图片实际 `assetShopId` 执行
- 必须自动回退到第一个有效店铺
- 鼠标悬浮大图预览
- `document.body` portal 使用完整签名图
- 悬浮不得改变网格尺寸
- 取消全选只控制下一次生图的来源图片
- 历史类目快照已经证明为变体字段的属性
- `10096/10097/8414/8416`
- 两次拦截重复变体组合
- `double_without_merger_offer` 必须去重翻译为中文
- Rich Content 只能保留文字布局
- 同一个 `normalizeOzonProductName`
- 非终态回读不一致只能按原 `task_id` 继续回读
- 禁止重复调用 `products.import`
- 原始生成图只作为本地证据底稿
- 禁止暴露未加暗水印的永久 Ozon URL
- 可视化操作页面
- 点击必须立即显示当前自动流程正在使用的同一个 CEF 窗口
- 用户关闭观察窗口只能把它移回后台
- 继续入口找到可信工单号和客服地址后必须自动续接并保留原断点
- 新工单建立后必须锁死本次工单号
- 连续两次发送字符完全相同的索要信息
- 第三次相同索要必须停止

## 已冻结模块：follow-seller-scheme1

以下条目来自现存冻结契约，修改相关链路时须逐项核验：

- follow-seller-scheme1-v27-cef150-visible-session-20260828
- npm run check:follow-seller-scheme1-freeze
- 提交取得工单后不轮询、不读取 Ozon 客服审核状态
- 店铺选择器必须优先显示用户配置的内部店铺简称
- legacyReplayPrompt
- legacyScheme1Ready
- 从未开始发送则复用原证据并创建新工单
