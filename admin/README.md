# 旺崽助手管理后台

此目录是完整 Vue 管理后台源码，使用本仓库 `server/` 的管理 API。自部署者使用自己生成的管理员账号，不需要作者的后台账号。

## 连接本地自部署后端

先按照 [自部署说明](../docs/SELF_HOSTING.md) 初始化并启动本地 HTTPS 后端。随后从仓库根目录执行：

```powershell
npm ci --prefix admin --ignore-scripts
$env:WANGZAI_ADMIN_BACKEND_URL='https://127.0.0.1:18443'
$env:WANGZAI_ADMIN_CA_FILE=(Resolve-Path '.selfhost/ca.pem').Path
npm run dev --prefix admin
```

在浏览器打开 `http://127.0.0.1:5174`，选择“开发版数据”，用 `.selfhost/private/credentials.json` 中的 `adminUsername` 和 `adminPassword` 登录。请只在本机读取该文件，不将其截图、上传或贴到 issue。

浏览器通过同源 `/api` 访问 Vite 代理，代理验证本部署 CA；没有关闭 TLS 校验或修改系统证书库。不要为该流程把 `VITE_API_BASE_URL` 设成 HTTPS 后端直连地址。可复制 `.env.example` 为 `.env.local`，其中默认地址为空，使用同源代理。

“测试版数据”是第二个独立环境入口，默认指向本机 18000 端口；未启动第二套服务时不可用。需要时分别设置 `WANGZAI_ADMIN_TEST_BACKEND_URL` 和 `WANGZAI_ADMIN_TEST_CA_FILE`。这些代理变量供构建工具使用，不含浏览器端密钥。

```powershell
npm run lint --prefix admin
npm test --prefix admin
npm run build --prefix admin
```

构建结果为 `admin/dist/`，生产部署模板的 `admin` 服务已使用本目录。模型、支付、短信、OSS 等功能仍需自行配置对应服务；存在页面不等于服务已开通。

---

# License Center 管理后台 v1.1

通用软件授权中心的 Vue 3 管理后台。项目不包含任何单一软件的业务判断，管理模型遵循：

`Project → Product → Plan → Permission → User → License`

## 已实现功能

- 管理员登录、内存 Token 会话与路由守卫
- 工作台：用户、授权、活跃、在线、到期、店铺及软件使用指标
- 项目与产品版本 CRUD、标准 `project.json` 文件/文本导入及本地预校验
- 套餐价格、周期、设备/店铺配额及权限集合管理
- 权限字典维护
- 用户管理、人工授予 License、撤销 License
- 卡密批量生成、批次/明细启停控制、CSV/Excel 导出入口
- 设备、店铺、使用日志分页筛选与基础查看
- 代理新增、编辑、启停和项目销售范围管理
- 渠道码生成、一次性分发 Token 展示/轮换及渠道启停
- 代理归属用户与代理订单查询
- 在线订单筛选、详情、主动查单、履约状态和退款操作
- 代理全局/项目/套餐三级佣金规则，以及快照账本、冻结/可结算/已结算/冲销汇总
- 支付与短信配置只读健康检查（不接收、不展示密钥）
- 统一 API 客户端、错误净化、分页响应兼容和按路由拆包
- 桌面端、平板和手机端响应式后台布局

## 技术栈

- Vue 3 + Vue Router
- Vite
- Element Plus
- Axios
- Vitest + Vue Test Utils
- ESLint

## 本地启动

```powershell
cd admin
Copy-Item .env.example .env.local
npm ci --ignore-scripts
npm run dev
```

默认开发地址：`http://127.0.0.1:5174`。

`.env.local`：

```dotenv
VITE_API_BASE_URL=
VITE_TEST_API_BASE_URL=/test-runtime
VITE_API_TIMEOUT=12000
```

登录页可选择“开发版数据”或“测试版数据”。两个入口共用同一套管理界面，开发版默认经代理进入 `8000`（可按上文配置本地 HTTPS 后端），测试版请求由 `/test-runtime` 代理进入 `18000`；Token 和数据库互不复用，切换环境时必须重新登录。

当 `VITE_API_BASE_URL` 留空时，请求使用同源 `/api`，适合由 Nginx 或桌面端本地网关代理。环境变量只用于服务地址与超时，不包含账号、密码或 Token。

## 后端接口约定

接口路径集中维护在 [`src/api/endpoints.js`](src/api/endpoints.js)，页面不得直接拼接 URL。

| 模块 | 接口 |
| --- | --- |
| 登录 | `POST /api/auth/login` |
| 工作台 | `GET /api/admin/dashboard` |
| 用户 | `/api/admin/users` |
| 项目 / 导入 | `/api/admin/projects`、`POST /api/admin/projects/import` |
| 产品 | `/api/admin/products` |
| 权限 | `/api/admin/permissions` |
| 套餐 | `/api/admin/plans` |
| License | `/api/admin/licenses` |
| 卡密批次 | `/api/admin/card-batches` |
| 设备 / 店铺 / 日志 | `/api/admin/devices`、`shops`、`usage-logs` |
| 代理 / 概览 / 归属用户 | `/api/admin/agents`、`/api/admin/agents/dashboard`、`/api/admin/agents/{id}/users` |
| 分发渠道 / Token 轮换 | `/api/admin/channels`、`POST /api/admin/channels/{id}/rotate-token` |
| 在线订单 / 查单 / 退款 | `/api/admin/orders`、`POST /api/admin/orders/{id}/query`、`POST /api/admin/orders/{id}/refund` |
| 佣金 / 汇总 | `/api/admin/commissions`、`/api/admin/commissions/dashboard` |
| 佣金覆盖规则 | `/api/admin/commission-rules` |
| 支付短信健康状态 | `GET /api/admin/payment-config/status` |

分页响应统一为：

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "page_size": 20
}
```

登录响应中的 `access_token` **只保存在当前页面 JavaScript 内存中**，不会写入 localStorage、sessionStorage、Cookie 或源码；刷新页面后需重新登录。Axios 请求拦截器统一附加 `Authorization: Bearer <token>`，收到 401 后清理会话并跳转登录页。

## project.json

支持字符串模块和带代码的对象模块：

```json
{
  "name": "通用运营助手",
  "code": "operation_helper",
  "version": "1.0.0",
  "description": "示例项目",
  "modules": [
    "订单管理",
    { "code": "profit_analysis", "name": "利润分析" }
  ]
}
```

导入弹窗只读取用户明确选择的 JSON 文件（最大 1MB），不会扫描源码或请求外部网站。最终的去重、权限代码生成与持久化由服务端负责。

## 目录说明

```text
src/
  api/          # Axios 实例、接口路径、响应适配、领域 API
  auth/         # 仅内存登录会话
  components/   # common/projects/plans/licenses/cards/commerce 模块组件
  config/       # 侧栏导航等静态后台配置
  layouts/      # 管理后台壳层
  router/       # 懒加载路由和鉴权守卫
  styles/       # 全局设计变量与公共布局
  utils/        # project.json 校验和格式化工具
  views/        # 页面级数据流与操作编排
```

所有页面和组件均低于 500 行。新增真实请求时先扩展 `src/api/endpoints.js` 和对应领域 API，不在 View/组件中直接使用 `fetch` 或 Axios。

## 质量检查

```bash
npm run lint
npm run test
npm run build
```

核心测试覆盖：标准项目清单解析、分页响应兼容、错误文本净化、内存 Token 安全约束和状态组件渲染。

## v1.1 边界

- 当前后台只消费 License Center 自身 REST API，不直接请求任何第三方平台。
- 卡密随机生成、密码哈希、权限裁决、设备限额与 License 有效性均由后端负责。
- 支付平台查单、退款、回调验签、自动发卡与代理归属裁决全部由后端负责；浏览器显示的状态不能作为支付成功依据。
- 分发 Token 仅在生成或轮换时展示一次，页面不持久化；支付密钥、短信密钥、私钥和证书内容永不进入前端响应。
