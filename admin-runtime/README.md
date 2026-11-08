# 管理后台常驻与自启动（Windows）

本目录提供原管理后台的启动、状态、停止和登录 Windows 后自启动脚本。源码使用本仓库 `admin/`，不依赖作者的管理系统目录。

先按 [管理端说明](../admin/README.md) 安装依赖、启动自己创建的后端。可通过当前用户环境设置 `WANGZAI_ADMIN_BACKEND_URL`、`WANGZAI_ADMIN_CA_FILE` 连接本地 HTTPS；需要登录后自启动时，这些变量需在新登录会话中仍有效。

```powershell
./admin-runtime/start-admin-frontend.ps1
./admin-runtime/status-admin-frontend.ps1
./admin-runtime/stop-admin-frontend.ps1
```

`install-autostart.ps1` 和 `uninstall-autostart.ps1` 分别安装、移除当前用户的启动快捷方式；只在你主动运行时操作 Windows 启动项。本次发布没有执行它们。

进程记录保存在本目录被忽略的 `admin-frontend.pid`（JSON 内容），记录 PID、启动时间及可执行文件。停止前验证记录归属，拒绝操作被复用的 PID；旧版纯数字 PID 文件需要人工核对，不能直接沿用。日志也不会进入源码仓库。

这是本机开发/维护工具，默认仅监听 `127.0.0.1`，生产网站部署使用 `compose.production.yaml` 的管理端容器。
