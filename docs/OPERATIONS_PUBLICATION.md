# 运维源码补齐与容器运行时

2026-11-08 对照完整性复核补齐：`admin-runtime/` 五个脚本、`test-runtime/` 七个脚本，根目录与 `server/` 两份 `.env.example`、开发用 `compose.yaml`。源码和公开模板都可查看，真实 `.env`、数据库、凭据及证据仍留在部署者本地。

## 目录适配

开发授权后端优先寻找本仓库 `server/`，显式 `WANGZAI_LICENSE_BACKEND_ROOT` 仍优先，保留旧目录兼容。打包审计和授权夹具默认使用本仓库；`LICENSE_CENTER_ROOT` 可明确指定旧独立项目根目录。找不到服务端核心时仍拒绝验证，不跳过边界检查。

## 后端容器

在仓库根目录构建：

```bash
docker build -f server/Dockerfile -t wangzai-source-check .
docker run --rm --network none --read-only --tmpfs /tmp --entrypoint gosu wangzai-source-check license python scripts/container-profit-smoke.py
```

Node 24 构建阶段直接编译公开的 `desktop/server-core/`、`frontend/src/` 与 `shared/`。最终 Python 镜像包含 Node 可执行程序、完整利润模块及其源码摘要清单；启动前验证模块 SHA-256、完整流水线标记和 Node 版本，再加载运行环境。Python 利润执行器原有每次调用的摘要校验不变。

生产 Compose 的所有后端角色使用仓库根构建上下文和 `server/Dockerfile`。根 `.dockerignore` 只允许明确的源码输入，排除真实配置、密钥、数据库、依赖目录及运行数据。不会将 Windows 机器的 node_modules 带进 Linux 镜像。

运行时使用镜像内 `PRIVATE_PROFIT_CORE_FILE`、`PRIVATE_PROFIT_CORE_MANIFEST`、`PRIVATE_PROFIT_NODE_EXECUTABLE` 默认值；`PRIVATE_PROFIT_CORE_SHA256` 从镜像内清单核验后导出。如果手动指定摘要，必须与模块及清单一致。没有降低既有授权、签名或发布门槛。

断网容器检查验证的是合成订单进入实际 Python→Node 执行器及错误摘要被拒绝，不是生产支付、真实店铺、负载或完整数据恢复验收。

## 完整性核对

```powershell
node tools/verify-source-completeness.mjs
node tools/verify-source-completeness.mjs --client-root='<原客户端目录>' --management-root='<原管理系统目录>'
```

默认扫描仓库实际源文件，发现不在清单中的新目录和未跟踪代码；可选模式额外对照原项目的运行代码、SDK、部署和运维目录。历史备份、内部评审素材、第三方下载依赖和业务数据仍按范围说明排除，不能将该检查理解成发布整个磁盘。

## 本轮验证记录

- 原客户端及管理系统逐路径对照：3,305 个清单文件，无缺失。
- Node 目录适配、完整性、测试边界及授权相关：31 项通过。
- Python 容器校验、部署契约及利润执行器：19 项通过；复制保护：4 项通过。
- PowerShell 语法与进程所有权校验通过，未安装自启动或操作真实服务。
- 公开源码审计与敏感信息扫描通过；四项真实证据验收仍保留。
- 本机 Docker 因 WSL 依赖下载网络受阻，未完成镜像构建；GitHub Linux 容器任务负责实际构建和断网执行，结果以对应提交的 Actions 为准。
- 产品发布门禁仍为 `NOT_READY`，不能据此宣称生产验收通过。
