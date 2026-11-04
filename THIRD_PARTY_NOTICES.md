# 第三方组件与素材

项目自身采用根目录 LICENSE 的源码可见许可。以下第三方内容始终适用其原许可证，项目的商业化限制不会覆盖或取消其原有权利。

## 随源码保留的声明

- 登录页动画交互参考 CareerCompass（arsh342，MIT），完整声明见 `frontend/src/features/licensing/THIRD_PARTY_NOTICES.md`。
- Ozon 浏览器观察器的来源及改造说明见 `desktop/resources/browser-extensions/ozon-analytics-observer/NOTICE.md`，随附木兰宽松许可证第 2 版。
- 旺崽 Logo、角色和商品示例图：项目持有人已确认具备公开再分发授权。该确认不授予第三方使用官方品牌或声称官方身份的权利。
- `frontend/src/test/fixtures/listingSkillPackage.js` 是为测试原创的合成材料，不分发原外部 Skill 安装包。LinkFox 原版来源包未纳入仓库；相关适配仍需使用者自行获得服务访问权限。

## 依赖

本仓库不提交 node_modules、Python 虚拟环境或浏览器二进制；依赖由各自包管理器按锁文件/版本要求下载。

| 组件 | 主要许可证 | 说明 |
| --- | --- | --- |
| React、Electron、MUI 等 | MIT 等 | 保留安装包中的许可及版权声明 |
| Apache ECharts 6、zrender | Apache-2.0、BSD-3-Clause | 已替换 ApexCharts；许可文本见 `third_party/licenses/` |
| sharp / libvips | Apache-2.0 / LGPL-3.0-or-later 等 | 二进制分发须遵守其 LGPL 源码、通知及替换等适用要求 |
| CefSharp / CEF / Chromium | BSD 等多种 | 浏览器产物具有独立的第三方许可集合 |
| OpenClaw 及微信插件 | 依对应版本声明 | 可选助手运行时；锁文件不一定穷尽上游嵌套依赖 |
| FastAPI、SQLAlchemy、Pydantic、cryptography 等 | MIT、BSD、Apache-2.0 等 | 以下载版本的包内许可为准 |

`third_party/npm-license-inventory.json` 是按 npm 锁文件生成的依赖元数据清单，包含开发和可选依赖，并非法律结论或完整二进制 SBOM。Python 完整版本记录见 `server/requirements-lock.txt`。

重新分发安装包时，应再次盘点实际装入的组件及资源，附带完整适用许可与 NOTICE，并履行 LGPL/MPL 等义务。此源码首发不提供安装包，也不声称已经完成二进制产品发布门禁。
