# 可丢弃开发产物：唯一受管入口

本工具仅管理它从零创建的 `.managed-dev-scratch/run-<uuid>/work`。不会扫描、导入或给已有 `.tmp`、`.codex-temp`、artifacts、profile、安装包、dist/publish、备份和验收证据打可删标记。SQLite登记库只在这个专用根中保存技术身份、租约与保留状态，不连接业务库。

## Producer API

```js
import { withManagedDevScratch } from './tools/managed-dev-scratch.mjs';

await withManagedDevScratch({
  workspaceRoot,
  purpose: 'native-build', // native-build | test-scratch | tool-scratch
  ttlMs: 7 * 24 * 60 * 60 * 1000,
}, async (scope) => {
  // 将可重新生成的中间产物写入 scope.directory。
  // 编译、测试、验证、复制激活必须全部在这个 callback 内完成。
  // 若用异步 spawn：await scope.trackChild(child)，并核验其退出码。
  // 发布报告、真实数据、唯一证据、回滚副本写到受保护的外部位置。
  // 如果本目录本身变成必须保留的证据：scope.retain()。
});
```

`scope.directory`是工作目录，`runId`是技术编号；`trackChild(child)`等待真实子进程exit，不会杀进程；`retain()`禁止自动回收。编译器的同步调用也可放进callback，租约在整个窗口内都是active。

不能在callback里只启动子进程就返回，也不能把正式运行路径指向scratch后结束callback。必须先把验收过的产物复制到不受本工具清理的运行目录。callback返回后，只能依赖已导出的结果，不能继续使用scratch路径。

## 自动与手动清理

- 创建与正常结束producer时做有界过期/容量检查。
- 源码启动器在正常Electron启动之后，可隐藏运行同一个管理工具；没有managed根就跳过，失败不阻止软件启动。它不调用旧广扫逻辑。
- 默认TTL为成功结束后7天；completed且明确可丢弃的集合还有2GiB软预算，超额可提前清理最老completed。
- 活动、callback失败、非零退出子进程、明确retain、未知目录/marker、符号链接/junction/硬链接全部保留。进程崩溃留下的active租约也不推断为可删，需要另行人工复核。
- `.keep`、`.retain`、`DO_NOT_DELETE`、`profile.json`、AGENTS及约定备份/验收/回滚marker也会阻止自动删除。
- 2GiB不是整个工作区或运行profile的硬上限。报告明确标记测量是否完整，只报告已验证移除的逻辑字节；有界检查可能需要后续检查才能收尾。
- 删除前会重新检查登记身份、inode/device、ownership、保护marker和payload元数据指纹。扫描后目录被替换或内容变化时保留，不沿用旧扫描结果继续删除。
- 自有技术账本保存有界扫描游标；后续检查从上次尝试之后继续并回绕。确证要保护的ready项转retained，扫描预算不足的项留ready但不会一直挡住后续项。原有身份、租约与retained项保持不变；预览不迁移或更新游标。
- `completedMeasurementStatus`明确为complete/partial/unknown；`completedBudgetStatus`只有完整有效测量才会判断within-budget/exceeded，否则为unknown。某一页的字节数不是整个completed集合已经达标的证据。

预览（默认）：`node tools/managed-dev-scratch-cli.mjs cleanup`

应用，仅新受管目录：`node tools/managed-dev-scratch-cli.mjs cleanup --apply`

命令producer：`node tools/managed-dev-scratch-cli.mjs run --purpose native-build -- node producer.mjs`

该producer必须把可丢弃输出写入 `process.env.WANGZAI_MANAGED_DEV_SCRATCH`。没有“CLI create后退出”入口，避免租约早于后续工作结束。

旧PowerShell入口现在委托给同一工具；`-Deep`只保留参数兼容，永远不会扩大到旧目录，`-WhatIf`保持预览。

## 隔离回归

`node --test tools/managed-dev-scratch.test.mjs desktop/scripts/cleanup-dev-workspace.test.mjs`

全部文件和apply测试均在临时夹具目录；测试不启动真实软件、不清真实工作区。
