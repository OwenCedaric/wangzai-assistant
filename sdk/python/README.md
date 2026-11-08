# License Center Python SDK 1.1

通用 Python 授权客户端，适用于不同桌面软件或 SaaS Worker。SDK 不包含任何单一软件、
套餐或权限的硬编码；`app` 使用 License Center 中的项目 `code`。

## 安装

```powershell
cd sdk/python
python -m pip install .
```

开发与测试：

```powershell
python -m pip install -e ".[test]"
python -m pytest
```

运行环境为 Python 3.10+。HTTP 使用标准库，`cryptography` 用于验证服务端 Ed25519
离线授权签名。

## 手机号注册、购买与激活（v1.1）

手机号接口同时完成“注册或登录”：新手机号自动建立账号，已有手机号直接登录。渠道归属由
短信挑战创建时的 `channel_code + distribution_token` 决定，服务端按“用户 + 项目”首次
归因锁定，客户端不能覆盖已经锁定的归属。

```python
from license_sdk import License

client = License(
    app="your_project_code",
    version="1.0.0",
    base_url="https://license.example.com",
    device_code="your-stable-device-code",
    channel_code="agent-a-douyin",
    distribution_token="token-issued-by-license-center",
)

challenge = client.send_sms_code("13800000000")
# 本地 development/test 环境可读取 challenge.development_code；生产环境由用户填写短信。
session = client.verify_sms_code("13800000000", input("验证码："))

plans = client.list_store_plans()
order = client.create_order(plans.items[0].id, idempotency_key="desktop-attempt-0001")
checkout = client.start_payment(order.id, provider="wechat")  # 或 alipay
show_qr(checkout.qr_code_url or checkout.code_url)

# 用户扫码支付后通过 owner 查询接口主动向支付平台对账；即使回调丢失也能履约。
order = client.query_order_payment(order.id)
# 持续查询，拿到账号绑定卡密后立即在当前设备激活。
result = client.wait_for_fulfillment_and_activate(order.id, timeout=300)
assert result.license_status.valid
```

本地/测试环境可一次跑通开发支付；生产环境会拒绝开发支付接口：

```python
result = client.purchase_development_and_activate(
    plans.items[0].id,
    idempotency_key="local-purchase-0001",
)
```

刷新令牌采用 rotation。每次成功刷新后旧令牌立即失效，SDK 会原子替换内存中的令牌；
同一个 `License` 实例上的并发刷新会合并为一次请求，所有调用者共享同一结果或异常，避免
并发重放旧 refresh token：

```python
rotated = client.refresh_session()
client.logout()  # 服务端撤销 refresh session，并清空本地 access/refresh token
```

SDK 不把 access token、refresh token、手机号、卡密或支付链接写入离线授权缓存，也不提供
明文文件存储。默认只在当前进程内存持有令牌。需要跨进程恢复会话时，由宿主应用使用
DPAPI、Keychain、Secret Service 等系统安全存储，并通过 `user_access_token=`、
`refresh_token=` 恢复；不要写入 localStorage、普通 JSON、日志或命令行参数。

## 原有卡密接入（v1.0 兼容）

```python
from license_sdk import License

client = License(
    app="your_project_code",
    version="1.0.0",
    base_url="https://license.example.com",
    # 生产环境应把服务端公钥随可信安装包发布：
    offline_public_key="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    offline_key_id="production-2026-01",
    # 默认分别为 license-center / license-center-clients；仅在后端同步改过时覆盖：
    offline_token_issuer="license-center",
    offline_token_audience="license-center-clients",
)

# 密码只用于本次请求；SDK 不保存密码。
client.login(username, password)

# 首次购卡后激活。激活接口会把内存中的 user token 换成 license token。
client.activate(card_key)

result = client.check()
if result.has_permission("order_sync"):
    open_order_module()
```

不要把 `if vip`、套餐名称或价格放进客户端。客户端只依据服务端返回并签名的权限码。

## 生命周期

1. `login(username, password)` 或 `verify_sms_code(phone, code)` 获取 user-scope token，仅保存在
   当前进程内存。
2. `activate(card_key)` 绑定项目与设备，响应中的 license-scope token 替换 user token。
3. `check()` 获取有效期、权限、设备/店铺上限和离线授权。
4. `heartbeat()` 默认由业务在适当时机调用；也可使用六小时后台调度器。
5. 退出账号时调用 `clear_session(clear_offline_cache=True)`。

应用进程重启后，在线模式需重新调用 `login()`。服务端会根据用户、项目和已经绑定的
设备恢复 License 会话，不要求客户端持久化 `license_key`。若登录请求因网络不可达而
失败，可继续调用 `check()` 尝试已签名的离线 grant；401/403 等明确拒绝不会回退。

```python
runner = client.start_heartbeat(on_error=handle_heartbeat_error)
# 应用退出：
client.close()
```

后台线程默认每 `21600` 秒（6 小时）心跳一次。SDK 不擅自退出应用；业务层根据错误和
`LicenseStatus.valid` 决定界面状态。

## 设备与版本信息

- `device_code` 默认由系统标识做 SHA-256 摘要，并按 `app` 隔离；原始机器标识不发送。
- 可注入企业自己的稳定 `device_code`，格式必须是 8–128 位安全字符。
- 每个请求携带 `project_code`、`version`、`device_code`。
- 可传 `version_hash="sha256:..."`，供服务端版本策略使用。

## 72 小时离线授权

离线不是对上次 JSON 响应的盲目信任。在线 `check/heartbeat` 返回的 `offline_token` 必须
是服务端 Ed25519 compact JWS，且至少签名以下 claims：

- `project_code`、`device_code`、`license_id`
- `permissions`、`shop_limit`、`device_limit`
- `iss`、`aud`、`iat`、`exp`、`offline_until`

SDK 每次读取缓存都会重新验签，严格检查签名内 `iss/aud`、项目/设备绑定和时间，客户端再
把时长限制为最多 72 小时。`iss/aud` 默认必须分别等于后端默认值 `license-center` 和
`license-center-clients`；自建部署只有在后端也同步修改时，才通过 License 构造参数显式
覆盖。缓存原子写入，并尽量设置为仅当前用户可读写。缓存中不会写入密码、
`access_token`、卡密或 license key。

没有可信公钥、服务端没有返回签名、签名错误、设备不匹配或时间过期时，离线默认
fail-closed，抛出 `OfflineUnavailableError`。生产包应固定公钥；本地开发可在服务在线时
显式调用 `fetch_offline_public_key()`，但这属于 TLS 上的首次信任，不等同于随安装包固定。

离线回退只发生在网络错误或服务端 5xx。401、403、404、409、410、422，以及服务端
明确返回 `valid=false` 时绝不回退并删除旧缓存。429 当前请求也不回退，但它仅表示
频率限制，不会被误判成授权撤销或删除仍有效的签名 grant。

## 常用对象

| 对象 | 用途 |
| --- | --- |
| `License` | 统一注册/登录、购买、激活、检查、心跳客户端 |
| `LicenseStatus` | `valid/expire/permissions/shop_limit/device_limit/source` |
| `PhoneAuthSession` | 手机登录结果、刷新会话和渠道归因（token 的 `repr` 已脱敏） |
| `StorePlan` / `PageResult` | 在线售卖套餐和分页结果 |
| `Order` / `PaymentCheckout` | 用户订单及微信/支付宝支付信息 |
| `PurchaseActivation` | 履约订单与激活后的授权状态 |

客户订单响应只要求订单号、项目、套餐快照、金额、状态、支付渠道、履约和时间字段。
`Order.user_id/project_id/plan_id/agent_id/channel_id/commission_*` 等旧版商业内部字段仅为
向后兼容保留，服务端未返回时为 `None`；渠道归因中的内部代理/渠道编号同样不作为客户端
必需字段。
| `PermissionSet` | `has/has_all/has_any/require` |
| `DeviceIdentity` | 哈希设备码与展示名称 |
| `HeartbeatRunner` | 可选后台心跳调度器 |

主要异常均继承 `LicenseSDKError`：

- `AuthenticationError`：401/403；
- `APIError`：服务端拒绝；
- `TransportError`：网络或响应格式故障；
- `OperationTimeoutError`：等待支付履约超过调用方设置的总时限；
- `OrderStateError`：订单已关闭、支付失败或已退款，无法继续自动激活；
- `OfflineUnavailableError`：没有可验证离线授权；
- `PermissionDeniedError`：缺少业务权限；
- `ConfigurationError`：客户端配置不完整或不安全。

SDK 不输出请求日志，因此不会记录密码或完整 token。若业务自行添加 HTTP 日志，必须对
`Authorization/password/card_key/license_key/offline_token` 做脱敏。

## 配置

`base_url` 未传时读取 `LICENSE_CENTER_URL`，再回退到本地开发地址
`http://127.0.0.1:8000`。非本机明文 HTTP 默认拒绝；生产环境使用 HTTPS。

手机号购买示例见 `examples/phone_purchase.py`，v1.0 示例见
`../../examples/python_client.py`；服务端合同见 `../../docs/api.md`，安全边界见
`../../docs/security.md`。
