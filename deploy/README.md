# License Center 生产部署

本目录提供单机服务器部署基线：PostgreSQL、Redis、FastAPI、Vue 管理端和 Caddy HTTPS
网关。后端不对公网直接暴露，所有公网请求都经过 `https://<LICENSE_DOMAIN>`。

后端镜像必须从仓库根目录构建：`docker build -f server/Dockerfile .`。镜像内包含从公开源码编译的完整利润执行器和 Node 24，启动时验证摘要；无需取得作者的私有编译产物。运维脚本与断网检查命令见 [运维公开说明](../docs/OPERATIONS_PUBLICATION.md)。

## 1. 准备服务器

- 安装 Docker Engine 和 Compose v2。
- 为授权中心准备独立域名，将 A/AAAA 记录指向服务器。
- 放行 TCP 80/443 和 UDP 443（HTTP/3）；PostgreSQL、Redis 和 8000 端口不对公网开放。
- Compose 中 PostgreSQL/Redis 只连接 `private` 内网；backend 额外连接不发布端口的
  `egress` 网络，用于访问短信及支付官方网关，不能把 backend 端口映射到宿主机。
- 单机正式环境建议从 4 vCPU / 8 GiB RAM / 80 GiB NVMe / 10 Mbps 优质线路起步；
  `deploy/.env.production` 中的 worker、PostgreSQL 和 Redis 参数按此规格给出保守默认值。
  2 vCPU / 4 GiB 只适合试运营，支付、恢复上传和付费能力并发时余量较小。

## 2. 生成基础密钥

在 `仓库根目录` 目录执行：

```bash
python deploy/generate_secrets.py --domain "$LICENSE_CENTER_PUBLIC_HOST"
```

脚本会生成：

- `deploy/.env.production`
- JWT、卡密 HMAC、手机号加密、OTP、Refresh Token 和渠道 Token 密钥
- Ed25519 离线签名密钥对
- `offline_public_key.sha256`，用于桌面安装包公钥指纹锁定
- `deploy/secrets/protected_compute_ed25519_*`：后端受保护计算结果签名密钥对，只有私钥挂载到后端
- `deploy/secrets/ozon_notification_callback_token`：Ozon 消息推送与智能回复回调令牌
- `.secrets/protected_compute_configuration_*`：离线发布配置根密钥对，私钥不挂载任何服务、也不进入桌面包

这些文件已被 Git 忽略。应另行加密备份；正式上线后不要使用 `--force`
重生，否则既有卡密、加密身份数据和离线授权会失效。
密钥在宿主机保持 `0600`；容器入口仅以 root 复制到容器的 tmpfs，随后立即降权为
`license` 用户运行迁移和 API，不会将密钥放宽为宿主机全员可读。

## 3. 配置短信

编辑 `deploy/.env.production`，填写已审核的阿里云短信签名与模板，并将短信
Secret 写入 `deploy/secrets/sms_secret_key`。生产环境会拒绝 development 短信通道。

```text
SMS_PROVIDER=aliyun
SMS_ACCESS_KEY=<AccessKey ID>
SMS_SECRET_KEY_FILE=/run/secrets/sms_secret_key
SMS_SIGN_NAME=<已审核签名>
SMS_TEMPLATE_CODE=<已审核模板编号>
```

模板参数使用 `code`。

## 4. 配置支付

开发支付在生产环境强制禁用。至少配置一个真实通道：

- 微信支付 Native：商户号、AppID、商户证书序列号、API v3 密钥、商户私钥、
  平台证书及 HTTPS 通知地址。
- 支付宝 AI 网页应用收款：应用 ID、卖家 ID（建议）、官方非 Java 应用私钥
  （兼容页面下发的原始 PKCS#1/PKCS#8 或 PEM）、
  支付宝公钥及 HTTPS 通知地址。不要把“应用公钥”当作“支付宝公钥”。

私钥、证书和 API v3 密钥放入 `deploy/secrets/`，然后在环境文件中使用
`*_FILE=/run/secrets/<file>` 引用，不要将内容直接写入 Compose 或源码。

支付宝推荐配置名为 `ALIPAY_PRIVATE_PKCS_KEY_FILE` 和
`ALIPAY_ALIPAY_PUBLIC_KEY_FILE`。沙箱阶段使用
`https://openapi-sandbox.dl.alipaydev.com/gateway.do`；正式发布时必须切回
`https://openapi.alipay.com/gateway.do`，生产门禁会拒绝沙箱或非官方网关。

## 5. 首次启动

首次部署时，`deploy/generate_secrets.py` 会生成 API 池专用的哈希密钥和加密密钥：

```text
deploy/secrets/api_pool_hash_secret
deploy/secrets/api_pool_encryption_key
```

这两项只用于服务端识别重复 API Key 和加密数据库中的 API Key，禁止下发到前端或桌面端。
已有部署升级时不要重跑 `generate_secrets.py --force`，应单独生成这两个新文件并保持 `0600`
权限；替换 `api_pool_encryption_key` 前必须先完成所有已存 API Key 的重新加密。

已有部署升级智能回复时，不要重跑或覆盖旧密钥，只新增回调令牌：

```bash
umask 077
openssl rand -base64 48 | tr -d '\n' > deploy/secrets/ozon_notification_callback_token
```

Ozon Seller 后台填写的消息推送地址为：

```text
https://<LICENSE_DOMAIN>/api/ozon/notifications/<ozon_notification_callback_token 文件内容>
```

该地址只粘贴到受信任店铺的 Ozon Seller 后台，不写入日志、截图或前端源码。店铺需要勾选
新订单、订单状态变化和取消等订单通知；收到状态推送后，云端才会创建智能回复任务。

如需保留旧版环境变量供应商作为兜底，再把三个旧供应商密钥分别写入仅管理员可读的文件：

```bash
install -m 600 /dev/null deploy/secrets/paid_text_api_key
install -m 600 /dev/null deploy/secrets/paid_image_api_key
install -m 600 /dev/null deploy/secrets/paid_seerfar_api_key
```

填写密钥后，在 `deploy/.env.production` 配置 HTTPS Base URL、精确供应商主机白名单、
图片编辑所用私有 OSS/CDN 主机白名单，并最后设置 `PAID_CAPABILITY_ENABLED=true`。不要把密钥
直接写入环境文件、Compose、前端或桌面安装包。启动后在管理后台“积分管理 → 付费能力价格”
为每项能力创建成本和价格版本；未配置有效价格版本时系统会安全拒绝，且不会调用供应商。

管理后台新增“API 池”：先创建供应商，再维护模型和多个 API Key。Key 仅在提交时进入后端，
列表只返回脱敏尾号；同一供应商的 Key 会按独立并发槽、冷却时间和最近使用情况调度。
新增供应商域名仍必须先加入 `PAID_PROVIDER_ALLOWED_HOSTS`，不在白名单的地址会被后端拒绝。

已有部署升级到 API 池时，先执行 `python deploy/generate_secrets.py --missing-paid-pool`。
该命令只补齐缺失的 API 池哈希和加密密钥，不会轮换已有密钥，也不会覆盖现有部署配置。

运营顺序固定为：先停用旧价格版本，再创建时间不重叠的新版本。目标毛利建议 18%，后端
强制最低 15%；调整积分套餐售价时同时复核“每元对应积分”，避免套餐折扣侵蚀毛利。

1. 在 `deploy/.env.production` 中临时填写 `BOOTSTRAP_ADMIN_USERNAME` 和
   `BOOTSTRAP_ADMIN_PASSWORD`。
2. 执行：

   ```bash
   docker compose --env-file deploy/.env.production -f compose.production.yaml up -d --build
   ```

   启动前先跑只读生产预检；脚本不会打印任何密钥内容：

   ```bash
   python deploy/preflight.py --env-file deploy/.env.production
   ```

3. 查看状态：

   ```bash
   docker compose --env-file deploy/.env.production -f compose.production.yaml ps
   docker compose --env-file deploy/.env.production -f compose.production.yaml logs -f backend backend-heavy worker
   ```

4. 登录 `https://<LICENSE_DOMAIN>` 后，立即从环境文件删除两个
   `BOOTSTRAP_ADMIN_*` 值，并重建 backend、backend-heavy、worker。

数据库结构升级由一次性的 `migrate` 服务执行 `alembic upgrade head`，成功退出后其余后端服务才启动；
接请求的服务设置了 `RUN_MIGRATIONS=false`，不会并发迁移。不使用 `create_all`。

## 6. 接入桌面端

1. 在管理后台导入 `desktop/resources/project.json`。
2. 创建套餐，填写在线售价，选择权限并开启在线销售。
3. 创建代理和渠道，保存只显示一次的分发 Token。
4. 取得公钥指纹：

   ```bash
   cat deploy/secrets/offline_public_key.sha256
   ```

5. 每次发布先生成 public-only 受保护计算配置包。`--config-version` 必须严格递增，
   `--revocation-epoch` 不能下降：

   ```powershell
   $licenseCenterRoot = (Get-Location).Path
   & "$licenseCenterRoot\server\.venv\Scripts\python.exe" `
     "$licenseCenterRoot\server\scripts\build_protected_compute_public_config.py" `
     --configuration-private-key "$licenseCenterRoot\.secrets\protected_compute_configuration_private.pem" `
     --configuration-key-id protected-compute-config-v1 `
     --compute-public-key "$licenseCenterRoot\deploy\secrets\protected_compute_ed25519_public.pem" `
     --compute-key-id protected-compute-v1 `
     --server-base-url $env:LICENSE_CENTER_PUBLIC_URL `
     --config-version 1 --revocation-epoch 0 `
     --desktop-bundle-dir "$licenseCenterRoot\deploy\generated\desktop-protected-compute"
   ```

6. 在项目根目录打包前写入渠道配置并让桌面发布脚本重新校验、固定 public bundle：

   ```powershell
   $licenseCenterRoot = (Get-Location).Path
   $tokenPath = Join-Path $env:TEMP 'wangzai-channel-token.txt'
   Set-Content -LiteralPath $tokenPath -Value '<一次性分发Token>' -NoNewline -Encoding utf8
   npm --prefix desktop run configure:distribution -- `
     --channel=AGENT_A "--token-file=$tokenPath" `
     "--server=$env:LICENSE_CENTER_PUBLIC_URL" --mode=enforce `
     --key-sha256=<offline_public_key.sha256> `
     --protected-config-key-id=protected-compute-config-v1 `
     "--protected-bundle=$licenseCenterRoot\deploy\generated\desktop-protected-compute"
   Remove-Item -LiteralPath $tokenPath
   ```

   `LICENSE_CENTER_PUBLIC_URL` 必须填写已部署的真实 HTTPS 公网地址。生产门禁拒绝
   `.invalid`、`.test`、`.example`、`example.com/.net/.org`、localhost 和 loopback。
   测试夹具只能显式追加 `--allow-test-fixture-urls`；该参数只允许生成/暂存夹具，
   正式 `seal:distribution` 与 `verify:package` 不提供绕过入口。

用户首次在该安装包中通过手机号验证码注册时，用户与项目的渠道归属会锁定；后续从
其他渠道登录不会改写既有归属。

## 7. 备份与升级

- 每日使用 `pg_dump` 备份 PostgreSQL，并将备份复制到异机/对象存储。
- 同时分别加密备份 `deploy/secrets/` 和离线保存的 `.secrets/`。
  数据库备份、服务密钥备份和配置根密钥备份缺一不可。
- 升级前先备份，然后运行同一条 Compose `up -d --build`命令（`migrate` 会先完成升级）。
- 迁移已是独立的 `migrate` 服务；不要给 backend/backend-heavy/worker 打开 `RUN_MIGRATIONS`。

## 8. 多人同时在线：服务分工、扩容与回退

同一个后端镜像按角色跑成四个服务：

| 服务 | 负责 | 主要参数 |
| --- | --- | --- |
| `migrate` | 部署时升级一次数据库结构后退出 | — |
| `backend` | 登录、心跳、积分、管理后台等快速请求 | `BACKEND_WORKERS`（默认 4） |
| `backend-heavy` | 模型调用、跨境物流、受保护计算、付费能力、恢复文件上传 | `HEAVY_BACKEND_WORKERS`、`HEAVY_THREADPOOL_TOKENS` |
| `worker` | 智能回复与定时清理（不接请求） | `SMART_REPLY_WORKER_INTERVAL_SECONDS` |

网关 `deploy/Caddyfile` 的 `@heavy` 规则把慢请求转给 `backend-heavy`（超时 330 秒），其余 `/api/*`
仍到 `backend`。这样慢请求挤满时，登录和心跳不受影响。

- **扩容**：哪个服务忙就调大对应 workers；保持所有服务
  `workers × (DB_POOL_SIZE + DB_MAX_OVERFLOW)` 之和小于 PostgreSQL `max_connections`（默认 100）。
- **回退到单后端**：删除 Caddyfile 中的 `@heavy` 整段并重载网关，所有请求回到 `backend`；
  如还需在 backend 内跑后台任务，把它的 `BACKGROUND_LOOPS_ENABLED` 改为 `true` 并停掉 `worker`。
- **压测验收**（只调用登录和 `/api/auth/me`，不扣积分、不调模型）：

  ```bash
  python server/scripts/load_check.py --base-url https://<LICENSE_DOMAIN> \
    --username <压测账号> --password '<密码>' --clients 300 --duration 60 --interval 10
  ```

  默认各客户端随机错开开始；加 `--burst` 测"全部同时重连"的最坏情况。失败率超过 1% 时退出码为 1。
