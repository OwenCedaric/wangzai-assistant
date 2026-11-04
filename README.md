# 旺崽助手

面向 Ozon 卖家的 Windows 桌面经营助手，包含商品、订单、采购、利润、数据分析及本地存储等模块。本仓库提供客户端和必需的自部署后端源码。

**源码可见，允许免费本地经营自用；未经书面授权，禁止对外销售、收费部署、托管及 SaaS。** 详见 [LICENSE](LICENSE)。这不是 OSI 定义的开源许可。参与维护请阅读 [贡献指南](CONTRIBUTING.md) 和 [贡献授权协议](CONTRIBUTOR_AGREEMENT.md)。

当前为实验性源码首发，仍有已知回归失败和未完成的产品验收，不提供稳定安装包或生产可用承诺。请先阅读 [验证状态与已知限制](docs/PUBLICATION_STATUS.md)。

## 环境与部署

- Windows 10/11 x64，Node.js 24，Python 3.12，.NET 8 SDK（仅 .NET Runtime 不够）。
- 仓库所在目录名应为 `旺崽助手-新版本`，当前版本隔离检查依赖该名称。
- 每个部署生成自己的账号、密钥、TLS 证书和数据库，不连接作者的原发行系统。

完整步骤见 [本地部署](docs/SELF_HOSTING.md)。从源码克隆时可以指定目录名：

```powershell
git clone https://github.com/superbaiss/wangzai-assistant.git 旺崽助手-新版本
cd 旺崽助手-新版本
```

首次运行建议使用空 profile，先熟悉只读流程。初始化配置关闭真实平台写入和连续同步；只有在自己的部署中明确配置并理解对应操作后再启用。

## 本轮准备内容

- 从跟踪源码导出，不携带原 Git 历史、真实 profile、数据库、凭据、依赖目录或安装包。
- 发行配置、签名公钥包及本地业务配置改为单独准备；仓库仅提供示例。
- 移除私人知识库链接，部署及模型中转地址改为 `.invalid` 示例，店铺与订单标识改为样例。
- 保留本机回环地址、平台公共接口、协议域名和第三方许可证原文。
- 冻结账号归属账本及其校验器保留原文，其中历史通用路径是验证夹具，不含当前个人用户目录；不能为了替换路径改写冻结证据。
- 内部评审、历史安全网、文档截图及再分发许可未确认的来源材料不纳入本次副本。

## 校验

要求 Node.js 24 或更高版本，在根目录执行：

```powershell
node tools/audit-public-source.mjs --tracked
node --test tools/audit-public-source.test.mjs
node frontend/scripts/scan-secrets.mjs --all
```

新增检查不替代 Gitleaks、图片隐私复核、第三方许可审查或产品发布门禁。冻结清单的哈希未刷新，原有及脱敏新增的差异仍需复核。

## 服务与验证边界

- 示例配置不包含任何可用的官方发行凭据。`server/scripts/self_host.py init` 创建自己的本地配置、账号和签名密钥，拒绝覆盖已有安装。
- 授权、签名与产品发布校验完整保留；缺少有效配置时失败是预期行为，不能通过关闭校验来冒充部署成功。
- 图片服务默认地址不提供服务。可使用同一个明确配置的 HTTPS 图片接口，设置方式见部署文档；第三方 API、OSS 和模型服务的用量费用由使用者自行承担。
- 两个采购预报测试已改为自建 SQLite 夹具；外部 Skill 安装包测试已使用原创合成夹具。
- 图表已改用 Apache ECharts。第三方许可证、素材授权及二进制分发义务见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

正式安装、隔离集成、全量测试、真实环境验收均不能由本次脱敏检查代替。
