# 本地部署

支持 Windows x64 源码部署。先阅读根 README 的实验版本说明。本流程创建全新的部署目录，不迁移或覆盖旧版真实数据，不要求购买官方卡密。

## 安装依赖

在仓库根目录（目录名 `旺崽助手-新版本`）运行：

```powershell
npm ci --prefix frontend --ignore-scripts
npm ci --prefix local-api --ignore-scripts
npm ci --prefix desktop
python -m venv server/.venv
server/.venv/Scripts/python.exe -m pip install -r server/requirements-lock.txt
npm run build --prefix frontend
npm run build:cef --prefix desktop
```

原生浏览器构建需要 .NET 8 SDK。微信助手是可选组件，需要使用时另行执行 `npm run prepare:openclaw-runtime --prefix desktop`；这不提供微信账号或模型额度。

## 初始化自己的后端

```powershell
server/.venv/Scripts/python.exe server/scripts/self_host.py init
node desktop/scripts/build-private-profit-core.mjs --full-pipeline --output=.selfhost/profit-core
```

初始化会创建 `.selfhost/`、自己的 SQLite 授权库和随机密钥，写入被 Git 忽略的客户端运行配置。重复执行会拒绝覆盖；如果命令中途失败，应保留现场检查，不能对现有部署删库重试。

登录邮箱、随机密码、管理员凭据和本地签发的激活码保存在 `.selfhost/private/credentials.json`。该文件只能由部署者本地读取，不能上传、截图或粘贴到 issue。首次用本地邮箱/密码登录后，用其中的激活码激活；每张卡按既有规则绑定一个店铺，可自行管理和续期。

初始化保留既有年卡数据模型及参考标价，但本地管理员签发卡不产生付款。它不连接支付网关，也不要求向作者付费。不要把本地参考价格界面误认为支付要求或对外收费授权。

## 启动

终端一：

```powershell
server/.venv/Scripts/python.exe server/scripts/self_host.py serve
```

终端二：

```powershell
node tools/start-self-hosted.mjs
```

后端默认只监听 `https://127.0.0.1:18443`。启动器验证部署自己的 CA；桌面端及其子进程经文件指纹检查后在进程内加载该 CA，以支持 Windows 中文路径，不修改系统或浏览器信任库。不要关闭 TLS 校验，也不要在浏览器忽略证书警告。客户端继续执行登录、账号归属、店铺授权及签名验证。Node.js 至少需要 24.5，建议使用当前 Node 24 LTS。

源码路径和数据绑定由 `.selfhost/deployment.json` 记录。移动部署时应保留完整备份并另行设计迁移，不直接改数据库路径；该文件不是跨机器恢复方案。

## 管理后台与 SDK

管理后台源码位于 `admin/`，安装和本地 HTTPS 代理步骤见 [管理端说明](../admin/README.md)。管理员使用初始化生成的本地凭据。Python 授权 SDK 和全部测试位于 `sdk/python/`，接入示例位于 `examples/`。

公开源码检查与真实证据验收的命令见 [测试说明](TESTING.md)。

## 可选图片服务

默认图片服务是不可访问的保留域名。使用自己获授权的 OpenAI-compatible HTTPS `/v1` 图片服务时，在构建和启动前为所有组件设置相同地址：

```powershell
$env:WANGZAI_IMAGE_API_URL='https://你的图片服务域名/v1'
$env:VITE_WANGZAI_IMAGE_API_URL=$env:WANGZAI_IMAGE_API_URL
npm run build --prefix frontend
```

启动后端和桌面端的两个终端都需要保留 `WANGZAI_IMAGE_API_URL`。地址不能嵌入账号、密码、查询令牌或 fragment。模型 API Key 通过应用自身账号设置录入，不放进 `VITE_*`、源码或命令行参数。当前图片流程仍固定模型 ID `gpt-image-2`，接口必须支持该契约。

官方积分网关、企业跨境接口、短信、支付和 OSS 都不因源码公开而自动可用。根据需要配置自己的服务和密钥；默认未配置时明确失败，不伪装成功。

## 维护与备份

- 私钥、授权库和桌面 profile 均保存在 `.selfhost/`，不要上传 GitHub；同时保留应用自己的业务备份。
- 本地签名配置和 TLS 服务证书有有效期，当前初始化有效窗口约一年。到期前需用本部署保留的密钥重新签发并验证，不能把重新初始化或覆盖数据当作续期。自动续期尚未实现。
- 本地管理员接口可以通过信任该 CA 的 API 客户端管理自己的用户和卡；不要开放到公网。公网部署需独立 HTTPS 域名、生产密钥、数据库、备份和服务验收。
- `compose.production.yaml` 的后端与管理前端构建目录已分别指向公开的 `server/` 和 `admin/`。生产上线仍需按 `deploy/README.md` 配置域名、独立密钥和第三方服务，并完成验收；不能把模板当作已验收的一键部署。
- 该版本未完成安装包、升级、完整恢复及所有平台实测，发布门禁仍可能拒绝生产发布。
