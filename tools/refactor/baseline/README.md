# 重构基线（2026-10-11，提交 6d2be0c）

重构过程中，每一步都要跟这里对比。只要出现这里没有列出的新失败，就说明这一步改出了问题，必须修正或回退。

| 套件 | 命令 | 基线结果 |
| --- | --- | --- |
| local-api 全量 | `cd local-api && node --test` | 1686 通过 / 12 失败，失败清单见 `local-api-failures.txt` |
| 前端全量 | `cd frontend && npm test`（分批，失败后继续跑完） | 3729 项中 5 项失败：globalDialogMinimizationRules、orderSplitRelationIntegration、ozonSyncClient(912)、purchaseCrossBorderReadRules、retiredPaidAnalyticsRules |
| desktop 授权/协议/运行时 | `cd desktop && node --test src/licensing/*.test.js src/protocol/*.test.js src/runtime/*.test.js` | 399/399 |
| desktop 采购浏览器 | `cd desktop && npm run test:purchase-browser` | 523/524（CEF 语言测试仍在找旧文件） |
| 冻结检查 | `frontend` 下 8 个 `check:*-freeze` | 利润复核/选品/拼多多路由/经营洞察通过；利润核心 12、市场采集 5、图片OSS 27、跟卖 9 处违规 |
| lint | `cd frontend && npm run lint` | 1 error（purchaseBrowserLoginClient.test.js 重复导入） |
| 结构检查 | `node tools/structure-audit.mjs` | 20 处超大文件（local-api 5 处）。`accountOwnershipCatalog.js` 受 `accountOwnershipCertificate.js` 的整文件 SHA256 冻结，不能拆 |

## 迁移或重新克隆工作区（2026-10-11 建立「旺崽助手-新版本」时的经验）

- 仓库必须设置 `git config core.autocrlf false`（本机系统级为 true）。否则检出时换行符被改写，
  冻结清单和 `accountOwnershipCertificate.js` 的整文件哈希会全部漂移。
- 以下文件被 `.gitignore` 排除，但测试、冻结检查或运行依赖它们，克隆后需从旧工作区复制：
  - `local-api/evidence/`（真实 SKU 与采集核价证据样本，发布门禁使用）
  - `local-api/.env.example`、`frontend/.env.example`（冻结清单点名）、`local-api/.env.local`
  - `.codex-temp/account-removal-20260905/profit-*.json`（利润冻结清单引用的 3 个回归证据）
  - `安装包/`（内测安装包；其中 `ozon-card-optimizer-旺崽Skill安装包.json` 被智能工具测试读取）
  - `frontend/node_modules`、`desktop/node_modules`、`local-api/node_modules`、
    `desktop/openclaw-runtime/node_modules`、`desktop/native/Wangzai.CefBrowserHost/publish`
- `desktop/current-version.json` 的 `workspaceFolderName` 必须等于工作区文件夹名，否则启动器拒绝启动。
- 复制后用 `tools/refactor/verify-local-api.sh`、`verify-gates.sh`、`verify-frontend.sh` 核对与上表基线一致。
