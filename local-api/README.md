# 旺崽助手 local-api

`local-api` 是旺崽助手的本地数据和 Ozon 接口中转层。当前已经承担 SQLite 本地缓存、Ozon 读同步、Ozon 写入 preview / confirm、安全调度、readback 回读合并、audit 审计和前端 local-first 秒开支撑。

前端页面不直接访问 Ozon Seller API。页面优先读取 SQLite 缓存，手动刷新或后台任务再通过 scheduler 访问 Ozon，并把真实返回结果合并回 SQLite。这样可以做到页面先秒开、数据以 Ozon 为准、失败原因可追踪。

## 通用接口

所有已接入业务域优先使用统一域接口：

```text
GET  /api/cache/:domain
POST /api/sync/:domain
POST /api/write/:domain/preview
POST /api/write/:domain/confirm
```

接口含义：

- `GET /api/cache/:domain`：只读 SQLite 本地缓存，前端页面 local-first 使用。
- `POST /api/sync/:domain`：提交 Ozon 读同步任务，由 scheduler 后台执行，成功后写入 SQLite。
- `POST /api/write/:domain/preview`：只生成写入预览和风险审计，不提交 Ozon。
- `POST /api/write/:domain/confirm`：二次确认后提交 Ozon 写入；写入后必须等待真实 readback 合并，不能把受理当完成。

## 模块状态

| domain | 当前状态 | 写入能力 | 说明 |
| --- | --- | --- | --- |
| `products` | 已接入 cache / sync / write | 有 | 商品列表、商品详情、价格、库存、上下架写入，写后按 Ozon 回读合并。 |
| `orders` | 已接入 cache / sync / write | 有 | 销售订单读取、取消、发货、拆单等写入，拆单母子单按 Ozon 回读关系展示。 |
| `returns` | 已接入 cache / sync / write | 有 | 售后/退货读取和 rFBS 退货处理写入，写后回读确认。 |
| `marketing` | 已接入 cache / sync / write | 有 | 营销活动与活动商品池读取，活动写入走 preview / confirm。 |
| `finance` | 已接入读同步 | 无 | 财务流水、费用、佣金等只读同步，不提供写入。 |
| `profit` | 已接入读同步 | 无 | 利润核算依赖订单、商品、财务、罚款等缓存，只读同步，不提供写入。 |
| `logistics` | 已接入读同步 | 无 | 仓库、配送方式等基础物流数据只读同步。 |
| `catalog` | 部分接入 | 无 | 类目和属性缓存已接入，仍按只读资料库使用。 |
| `images` | 规划占位 | 无 | 当前不声明已接入，不返回假成功。 |
| `reports` | 规划占位 | 无 | 当前不声明已接入，不返回假成功。 |

## 写入文案规则

写入状态必须按真实阶段显示：

- `preview` 只表示“预览已生成”，不能写成已提交或已完成。
- `confirm` 只表示“已提交 Ozon”，不能写成已完成。
- Ozon 已受理但未回读时，只能提示“等待回读确认”。
- readback 成功并写入 SQLite 后，才能写“SQLite 已合并”。
- Ozon 拒绝、限流、超时或返回业务错误时，必须显示真实拒绝原因，不能吞掉错误或显示成功。

## 本地缓存和秒开

页面默认读取 SQLite 缓存：

- 有缓存时先展示本地数据。
- 刷新时提交后台 sync job。
- job 成功后再读取 SQLite 最新结果。
- 刷新失败时保留旧缓存，并显示真实错误。
- 任何页面统计、列表、分页 total 都应来自同一份 SQLite 查询结果，不能用当前页数量冒充总数。

## 启动

```powershell
cd C:\WORKSPACE\local-api
npm run migrate
npm run port:check
npm start
```

默认地址：

```text
http://127.0.0.1:3790/health
http://127.0.0.1:3790/api/app/status
```

## 避免重复启动

如果 `3790` 已被占用，先执行：

```powershell
cd C:\WORKSPACE\local-api
npm run port:check
```

结果为 `local-api 已经在运行` 时，不要重复启动，直接复用当前服务。

如果是其他进程占用，可以：

```powershell
$env:LOCAL_API_PORT='3791'
npm start
```

## CORS

默认允许本机 Vite 常用端口：

```text
5173
5188
5191
```

也可以用环境变量覆盖：

```powershell
$env:LOCAL_API_ALLOWED_ORIGINS='http://127.0.0.1:5191,http://localhost:5191'
$env:LOCAL_API_ALLOWED_VITE_PORTS='5173,5188,5191'
```

## 配置

默认配置文件：

```text
config/local-api.config.json
```

可用环境变量覆盖：

```text
LOCAL_API_HOST
LOCAL_API_PORT
LOCAL_API_DB_PATH
LOCAL_API_ALLOWED_ORIGINS
LOCAL_API_ALLOWED_VITE_PORTS
LOCAL_API_PROTECTED_COMPUTE_SIGNED_CONFIG_PATH
LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_PATH
LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_ID
LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_SHA256
```

受保护计算的四个配置值必须同时提供。`CONFIG_KEY_SHA256` 是 Ed25519
配置公钥 SPKI DER 的 SHA-256；本地只信任该指纹签发的公开配置，Renderer
不能覆盖服务器地址、公钥、撤销版本或离线策略。默认未安装持久化签名结果
存储，因此离线复用保持关闭。

### 商品图片 OSS

商品图片由 `local-api` 统一写入私有阿里云 OSS，Renderer 不接触 AccessKey。
本地开发可复制 `.env.example` 为 `.env.local`；该文件已被 Git 忽略，正式部署
时必须把两个 AccessKey 值迁移到服务器 Secret/KMS，不写进源码、SQLite 或日志。

```text
ALIYUN_OSS_REGION
ALIYUN_OSS_BUCKET
ALIYUN_OSS_ENDPOINT
ALIYUN_OSS_PREFIX
ALIYUN_OSS_SIGNED_URL_TTL_SECONDS
ALIYUN_OSS_ACCESS_KEY_ID
ALIYUN_OSS_ACCESS_KEY_SECRET
```

连通性检查会上传一张 1px 测试图、使用私有签名地址回读并立即删除：

```powershell
cd C:\WORKSPACE\local-api
npm run oss:check
```

## SQLite

直接运行 local-api 时使用显式开发库：

```text
local-api/data/wangzai-local-api.development.sqlite
local-api/data/local-api.development-secret.key
```

桌面端运行时不使用该开发库或开发密钥。桌面主进程始终通过
`LOCAL_API_DB_PATH` 和 `LOCAL_API_SECRET_FILE` 指向当前 profile 下的
`local-api-data/wangzai-local-api.sqlite` 与 `local-api-data/local-api-secret.key`，
避免开发环境与真实桌面数据再次形成两套来源。旧的
`local-api/data/local-api-secret.key` 仅作为迁移输入识别，不再由开发运行时创建。

运行 `npm run db:inspect` 可查看基础表和 WAL 状态。

## 体积预警

本地体积检查用于避免缓存文件和数据库异常膨胀：

```powershell
npm run storage:check
```

`/api/app/status` 也会返回 `storage` 字段。默认预警线是 `64MB`，可通过 `LOCAL_API_STORAGE_WARNING_BYTES` 调整。
