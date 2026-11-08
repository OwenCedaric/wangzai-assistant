# Jeepay 本地安全部署与支付通道预留

本目录部署官方 Jeepay，源码固定为以下已审核版本：

- 后端：`jeequan/jeepay@ba37111934c9c04183cc6cbdbdafc7f38941fa4b`
- 前端：`jeequan/jeepay-ui@17d057db22ae45babc15bd7cb43e5f73756dd080`

`prepare.py` 还会应用 `patches/0001-do-not-log-signing-secrets.patch`，删除官方签名工具中
会把商户 API 密钥拼进 INFO 日志的两行输出；容器同时关闭该工具包日志，形成双层保护。

所有端口只绑定 `127.0.0.1`，默认不能从局域网或公网访问。MySQL、Redis 和
RocketMQ 不开放宿主机端口；MySQL、Redis、JWT 密钥由 `prepare.py` 随机生成到
被 Git 忽略的 `.env`。支付渠道在录入真实商户资料前保持关闭。

## 启动

在 `仓库根目录` 执行：

```powershell
.\server\.venv\Scripts\python.exe .\deploy\jeepay\prepare.py
$sourcePath = (Resolve-Path '.runtime/jeepay-source').Path
$linuxSource = (wsl.exe -d Debian -- wslpath -a $sourcePath).Trim()
wsl.exe -d Debian -u root --cd $linuxSource -- mvn clean package -DskipTests
$deployPath = (Resolve-Path 'deploy/jeepay').Path
$linuxDeploy = (wsl.exe -d Debian -- wslpath -a $deployPath).Trim()
wsl.exe -d Debian -u root --cd $linuxDeploy -- docker compose up -d --build
.\server\.venv\Scripts\python.exe .\deploy\jeepay\harden_admin.py
```

首次完整构建后，日常启动、查看和停止分别使用：

```powershell
.\deploy\jeepay\start.ps1
.\deploy\jeepay\status.ps1
.\deploy\jeepay\stop.ps1
```

`start.ps1` 会启动一个隐藏的 WSL 保活进程，防止 Windows 在空闲时关闭 WSL 虚拟机并
连带停止支付容器；PID 只写入被 Git 忽略的 `.keepalive.pid`。

完整安全自检：

```powershell
.\server\.venv\Scripts\python.exe .\deploy\jeepay\verify_deployment.py
```

该命令会实际检查 10 个容器、三个页面、管理员登录、关闭的 API 文档、回环端口、空支付
通道和容器日志密钥泄漏；不会输出任何密码或 API 密钥。

录入商户和通道资料后，先运行只读就绪检查。它只返回商户应用、接口配置和支付通道是否
启用，不读取或打印支付宝、微信证书和密钥：

```powershell
.\server\.venv\Scripts\python.exe .\deploy\jeepay\check_channel_readiness.py `
  --mch-no M... --app-id ... --require-ready
```

返回成功后仍需完成真实小额支付、回调、重复回调和退款验收，最后才能开启管理系统对应
通道开关。就绪检查不会替代真实收款测试，也不会自动修改任何开关。

本机入口：

- 运营后台：http://127.0.0.1:9227
- 商户后台：http://127.0.0.1:9228
- 收银台：http://127.0.0.1:9226
- 支付 API：http://127.0.0.1:9216

`harden_admin.py` 会把官方初始化运营密码改成随机密码并再次登录验证。新密码仅保存在
被 Git 忽略的 `deploy/jeepay/.env` 的 `JEEPAY_MANAGER_ADMIN_PASSWORD` 中，不会在命令
输出或日志中打印。在执行加固脚本前不得将运营后台暴露到公网。

运营账号用户名和密码分别保存在同一私密文件的 `JEEPAY_MANAGER_ADMIN_USERNAME` 与
`JEEPAY_MANAGER_ADMIN_PASSWORD`。需要再次修改时，使用 `change_admin_credentials.py`，
通过临时环境变量传入新值；脚本会调用后台接口修改并用新账号实际登录验证。

## 支付宝与微信接入预留

1. 在 Jeepay 运营后台创建内部商户，再创建一个商户应用，保存 `mchNo`、`appId`
   和应用 API 密钥。
2. 在 Jeepay 商户后台分别添加通道：
   - 支付宝使用 `ALI_QR`；准备支付宝应用 ID、应用私钥和支付宝公钥。
   - 微信使用 `WX_NATIVE`；准备微信支付商户号、公众号/小程序 AppID、商户证书序列号、
     API v3 密钥和商户私钥证书。
3. 通道配置完成并通过 Jeepay 自测前，保持通道停用。
4. 管理系统生产环境设置以下变量。API 密钥应使用 Docker Secret 文件，不能写入前端：

```dotenv
PAYMENT_GATEWAY_MODE=jeepay
PAYMENT_DEFAULT_PROVIDER=wechat
PAYMENT_DEVELOPMENT_ENABLED=false
JEEPAY_ENABLED=true
JEEPAY_ALIPAY_ENABLED=false
JEEPAY_WECHAT_ENABLED=false
JEEPAY_API_BASE_URL=https://pay-api.example.com
JEEPAY_MCH_NO=M...
JEEPAY_APP_ID=...
JEEPAY_API_KEY_FILE=/run/secrets/jeepay_api_key
JEEPAY_NOTIFY_URL=https://license.example.com/api/payments/jeepay/notify
JEEPAY_REFUND_NOTIFY_URL=https://license.example.com/api/payments/jeepay/refund-notify
JEEPAY_ALIPAY_WAY_CODE=ALI_QR
JEEPAY_WECHAT_WAY_CODE=WX_NATIVE
```

`JEEPAY_ALIPAY_ENABLED` 和 `JEEPAY_WECHAT_ENABLED` 必须分开开启。完成某个通道的真实
小额支付、异步回调、重复回调和退款验收后，只开启该通道；未验收的另一个通道继续保持
`false`。`PAYMENT_DEFAULT_PROVIDER` 必须指向已经开启的通道，否则生产启动会直接失败。

5. 对公网启用前，给 Jeepay 支付 API 和三个后台配置独立 HTTPS 域名；运营后台和商户
   后台还应增加防火墙/IP 白名单。管理系统只访问支付 API，不直接访问 Jeepay 数据库。

## 边界

- 桌面端永远只向管理系统下单，不持有 Jeepay、支付宝或微信密钥。
- 管理系统订单、积分到账、卡密发放是最终账本；Jeepay 只负责路由支付。
- 只有通过签名、商户、应用、通道、金额、币种和时间窗口全部校验的回调才能发货。
- 本地部署成功不等于支付宝/微信真实支付已开通；真实支付必须等商户资料审核通过后做
  1 分钱测试、回调测试、重复回调测试和退款测试。
