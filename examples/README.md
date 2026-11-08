# 测试软件接入示例

`project.json` 是可直接提交到 License Center 项目导入接口的 v1 标准清单，
`project.schema.json` 是配套 JSON Schema。示例使用 Ozon 助手名称展示真实场景，但 SDK
和 Python 脚本都从清单读取项目，不依赖或写死 Ozon 业务。

## 1. 导入项目

管理员登录后，把 `project.json` 的 JSON 内容提交到项目导入 API；服务端会创建/更新项目、
默认产品和模块权限。随后在后台建立套餐，把权限加入套餐，再生成卡密。

## 2. 安装 SDK

```powershell
cd sdk/python
python -m pip install -e .
```

## 3. 运行

凭据只通过当前进程的环境变量传入，示例源码中没有密码、卡密或 token：

```powershell
$env:LICENSE_CENTER_URL = 'http://127.0.0.1:8000'
$env:LICENSE_USERNAME = 'demo-user'
$env:LICENSE_PASSWORD = '<本地测试密码>'
$env:LICENSE_CARD_KEY = 'AAAA-BBBB-CCCC-DDDD'  # 仅首次激活
$env:LICENSE_FETCH_PUBLIC_KEY = '1'             # 仅本地开发
python examples/python_client.py
```

激活完成后不要把 license token 写入源码。生产应用应使用安全的系统凭据存储承接会话；
当前 SDK v1 只在内存保存 access token，应用重启时重新登录/换取 token。离线启动只读取
服务端签名且未超过 72 小时的 offline grant。示例仅在登录请求无法连接服务端或返回
暂时性 5xx 时继续执行离线 `check()`；密码错误、账号/设备禁用等明确拒绝不会进入离线模式。

生产环境将 `GET /api/license/public-key` 返回的 Ed25519 公钥通过可信发布流程固定到安装包：

```powershell
$env:LICENSE_OFFLINE_PUBLIC_KEY_FILE = 'C:\Program Files\YourApp\license-offline-public.pem'
$env:LICENSE_OFFLINE_KEY_ID = 'production-2026-01'
```

复制示例接入其他软件时，只需替换 `project.json` 与环境配置，不修改 SDK 核心代码。
