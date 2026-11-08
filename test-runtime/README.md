# 独立测试后端工具（Windows）

原独立测试服务的七个脚本均在本目录公开。它们使用仓库内 `server/`，默认服务地址为 `http://127.0.0.1:18000`。可以在统一管理后台选择“测试版数据”；公开源码不包含任何已生成的测试账号或数据库。

## 空白自部署与来源库克隆

不需要原有数据库时，优先使用 [self_host.py 隔离初始化](../docs/SELF_HOSTING.md)。本目录的 `prepare_test_database.py` 保留的是**从明确指定来源库创建测试库**的功能，不是脱敏后可公开分发的样例生成器：它会保留提供方配置，并复制当前管理员密码哈希。

```powershell
server/.venv/Scripts/python.exe test-runtime/scripts/prepare_test_database.py --source '<你明确选择的本地来源库>' --acknowledge-sensitive-copy
```

必须理解并显式确认复制行为；不要上传生成的库或凭据。默认输出在 `test-runtime/data/` 和 `test-runtime/private/`，已有输出会拒绝覆盖，来源与目标相同也会拒绝。原始来源只读，不对其迁移或清空。本次验证只用隔离夹具，没有复制真实库。

单独同步管理员也要求明确来源与确认，会在修改目标前备份：

```powershell
server/.venv/Scripts/python.exe test-runtime/scripts/sync_primary_admin_to_test.py --source '<本地来源库>' --confirm-admin-sync
```

## 启停

准备好测试库和属于自己的后端配置后运行：

```powershell
./test-runtime/start-test-server.ps1
./test-runtime/status-test-server.ps1
./test-runtime/stop-test-server.ps1
```

启动器设置独立 SQLite 地址，只监听回环地址。第三方服务密钥必须由部署者配置；复制来的提供方密文需要同一加密配置才能读取。避免用不配套的密钥运行克隆数据。

进程记录验证 PID、启动时间与程序路径，避免停止无关进程。`install-autostart.ps1` / `uninstall-autostart.ps1` 提供手动启停自启动项。可选健康检查地址通过 `WANGZAI_TEST_PUBLIC_HEALTH_URL` 配置，没有内置作者公网地址。

`private/`、`data/`、`backups/`、`logs/`、`public-bundle/` 及 PID 文件均被忽略；只发布实现它们的脚本。
