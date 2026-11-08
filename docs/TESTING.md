# 公开测试与真实业务验收

## 公开源码测试

所有测试源码均公开。GitHub 的 **Source checks** 工作流验证公开源码，不读取作者的店铺数据库、密钥或生产验收快照。

```powershell
npm test --prefix frontend
npm run test:source --prefix local-api
npm run lint --prefix admin
npm test --prefix admin
npm run build --prefix admin
server/.venv/Scripts/python.exe -m pytest -c server/pyproject.toml server/tests
server/.venv/Scripts/python.exe -m pip install "./sdk/python[test]"
server/.venv/Scripts/python.exe -m pytest -c sdk/python/pyproject.toml sdk/python/tests
node --test tools/test-suite-boundary.test.mjs
node tools/verify-source-completeness.mjs
```

依赖安装及后端环境准备见 [自部署说明](SELF_HOSTING.md)。隔离测试使用自己创建的临时数据，不能用真实店铺操作代替。

## 四项真实商品证据验收

原 `local-api/test/productRealSkuEvidence.test.js` 已原字节迁至 `local-api/acceptance/productRealSkuEvidence.acceptance.mjs`。四项验收的实现和断言全部公开且不变，不包含 `skip`，校验器也没有改成自动通过。

```powershell
npm run test:evidence --prefix local-api
npm run evidence:sku --prefix local-api
```

它们验证：证据包完整性与脱敏、佣金零值不可误当零费用、SQLite 真实持久化，以及数据迁移/店铺删除/重绑隔离。所需材料是原校验器指定的真实采集 JSON、证据清单和目标行 SQLite proof，位置为被 Git 忽略的 `local-api/evidence/`。没有材料、哈希不匹配或验收失败时，命令退出非零。

`npm test --prefix local-api` 仍是完整测试入口，先跑公开测试，再跑真实证据验收；没有证据时仍失败。Windows 各打包命令依旧在构建前执行 `verify:sku-evidence`。GitHub 的 **Product release readiness** 工作流独立执行证据验收与产品发布门禁，缺证据不会变成绿色。

**Source checks 通过只表示公开源码检查通过，不表示产品已经具备正式发布条件。** 真实材料应在受控、隔离的验收环境中提供；本轮没有上传任何真实数据库，也没有把合成数据伪装成真实平台证据。
