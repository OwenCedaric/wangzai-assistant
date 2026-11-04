# 旺崽助手 Windows 桌面端

桌面端只负责封装和运行现有项目，不在 Electron 主进程中复制业务逻辑。React 页面、规则、核算口径、Ozon 读写流程和本地 API 均继续使用原项目代码，后续仍可直接修改原模块并重新打包。

## 支持范围

- Windows 10 / Windows 11 x64
- 安装版与便携版
- 窗口会按系统可用工作区自动确定初始尺寸
- 最小窗口尺寸为 `760 × 560`；业务表格在小窗口内使用自身滚动区，不拉宽整个页面
- 已覆盖的桌面布局检查尺寸：`800×600`、`1024×640`、`1180×760`、`1280×720`、`1366×768`、`1440×900`、`1600×900`、`1920×1080`、`2560×1440`

## 目录职责

```text
desktop/
  src/main.js                    Electron 主进程、窗口和本地服务生命周期
  src/preload.cjs                只暴露桌面运行信息和动态本机服务地址
  src/protocol/appProtocol.js    加载 frontend/dist 并承接本地 JSON 文件接口
  resources/icon.png             Windows 应用图标
  scripts/verify-package.mjs     校验打包资源是否完整
  scripts/smoke-package.mjs      启动打包后的 exe 做真实渲染烟测
```

## 日常修改

业务页面仍在原目录修改：

```text
C:\WORKSPACE\frontend\src
C:\WORKSPACE\local-api\src
```

修改完成后快速查看桌面版：

```powershell
cd C:\WORKSPACE\desktop
npm run dev
```

如果 `frontend/dist` 已经是最新版本，可以省略前端构建：

```powershell
npm run dev:fast
```

## 构建命令

先安装一次桌面端依赖：

```powershell
cd C:\WORKSPACE\desktop
npm install
```

生成可直接运行的解包目录，并自动执行资源校验和桌面烟测：

```powershell
npm run pack:win
```

生成安装版和便携版，并自动执行校验：

```powershell
npm run dist:win
```

仅生成某一种交付物：

```powershell
npm run dist:win:installer
npm run dist:win:portable
```

默认输出：

```text
desktop\dist\win-unpacked\旺崽助手.exe
desktop\dist\旺崽助手-1.0.0-安装版-x64.exe
desktop\dist\旺崽助手-1.0.0-便携版-x64.exe
```

## 桌面数据

桌面端数据默认独立存放，不写进安装目录：

```text
%APPDATA%\旺崽助手\
  local-api-data\wangzai-local-api.sqlite
  本地数据\...
  logs\...
```

安装版、便携版和后续升级默认复用这份数据。卸载程序不会删除业务数据。

临时指定独立数据目录：

```powershell
$env:WANGZAI_DESKTOP_DATA_DIR='D:\wangzai-desktop-data'
.\dist\win-unpacked\旺崽助手.exe
```

## 启动稳定性

- 单实例运行，重复打开会聚焦已有窗口。
- local-api 使用桌面端自己的数据库；默认端口被占用时自动选择新的本机端口。
- 采购 bridge 使用固定 `3788` 端口兼容浏览器插件。开发观察模式可复用独立 bridge；
  `enforce`/正式安装包必须独占该端口并启用授权状态与随机 capability 双重保护。
- 主窗口在 local-api 与 bridge 就绪后加载，避免启动阶段的连续失败请求。
- 页面按功能模块懒加载，减少首次启动需要解析的 JavaScript。
- 静态资源使用长期缓存；`index.html` 不缓存，重新打包后能立即读取新版本。

## License Center 登录与授权

启动入口由独立 `DesktopAccessGate` 承载。每次创建桌面主进程都会先清除上一次运行留下的
Access/Refresh/License Token，登录页也会再次执行 `beginLogin`，因此旧会话不能自动进入
工作台。用户提交邮箱和密码后必须依次通过账户登录与 `/api/license/check`，授权到期、账号
禁用、设备撤销或权限失效都会停留在登录页。

登录页可选择“记住账号和密码”。凭证单独保存在 `license-remembered-login.bin`，由 Electron
主进程通过系统 `safeStorage` 加密；渲染层只能读取邮箱和是否已保存，不读取真实密码。取消
勾选或登录密码被服务端拒绝时会立即删除该文件。即使已记住凭证，每次启动仍需用户点击
“登录”并重新联网验证授权。

底层仍支持三种运行模式：

- `observe`：开发默认，不拦截既有功能。
- `enforce`：正式发行验证，并在本地业务 API 边界强制模块权限。
- `off`：完全关闭授权运行时。

正式安装包校验固定要求 `enforce`。

项目和渠道配置位于：

```text
desktop/resources/project.json
desktop/resources/distribution.json
desktop/resources/distribution.example.json
```

`distribution.json` 会包含代理渠道凭证，已从 Git 排除；仓库只保存空凭证示例。

为代理商生成分发包前，使用后台签发的渠道凭证，并锁定服务端 Ed25519
公钥指纹：

```powershell
cd C:\WORKSPACE\desktop
$tokenPath = Join-Path $env:TEMP 'wangzai-channel-token.txt'
Set-Content -LiteralPath $tokenPath -Value '<后台渠道凭证>' -NoNewline -Encoding utf8
npm run configure:distribution -- `
  --channel=AGT-00018 "--token-file=$tokenPath" `
  --server=https://license.example.com --mode=enforce `
  --key-sha256=<后台离线公钥SHA-256指纹>
Remove-Item -LiteralPath $tokenPath
```

`pack:win` / `dist:win` 会在打包前把 `project.json + distribution.json` 的摘要编译进
`app.asar`；运行时资源被单独改写会直接拒绝启动。

开发阶段保持 `observe` 与本机 `http://127.0.0.1:8000`。非本机服务地址强制使用
HTTPS。Access Token 和 Refresh Token 只保存在 Electron 主进程，并使用操作系统
`safeStorage` 加密；渠道 Token、Access Token、Refresh Token、License Token 和离线 Token
均不暴露给渲染页。离线权限必须通过 Ed25519 签名、项目、设备、公钥指纹、有效期和时钟回拨
检查。

源码桌面端启动时会先探测本机 License Center 的 `/health`。如果配置仍是 loopback、
服务尚未运行且相邻的 `管理系统/backend/.venv` 可用，主进程会隐藏启动授权后端并等待
健康后再打开登录页。可用 `WANGZAI_LICENSE_BACKEND_ROOT` 指定另一份授权后端目录；正式
安装包或 HTTPS 远程授权地址不会走这条本机源码联动。

业务 local-api 在桌面进程内使用随机能力 Token，React 只能通过受限 IPC 代理访问；
`enforce` 模式下每次请求都会复核当前授权和服务端下发的模块权限。直接访问本机端口不能绕过
账号授权。采购 bridge 同样由主进程 IPC 代理，健康接口不返回订单上下文。主进程会定时心跳，
授权到期、设备禁用或服务端撤销后会关闭对应页面、本地 API 和采购 bridge。
