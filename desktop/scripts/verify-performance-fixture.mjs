import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withManagedDevScratch } from '../../tools/managed-dev-scratch.mjs';
import { seedRendererPerformanceFixture, disposeRendererPerformanceFixture } from './performanceFixture.mjs';
import { parsePerformanceOptions, preparePerformanceEvidenceDirectory } from './perf-electron-navigation.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = parsePerformanceOptions();
await withManagedDevScratch({ workspaceRoot, purpose: 'test-scratch' }, async (lease) => {
  const fixture = await seedRendererPerformanceFixture({ ...options, ownedRoot: lease.directory,
    dataRoot: path.join(lease.directory, 'profile') });
  const shops = await Promise.all(fixture.shopReceipts.map(async (receipt) => ({
    shopId: receipt.shopId, products: receipt.products, orders: receipt.orders, reopened: receipt.reopened,
    productReadbackMs: receipt.productReadbackMs, orderReadbackMs: receipt.orderReadbackMs,
    databaseBytes: (await fs.stat(receipt.route.databasePath)).size,
  })));
  const report = { kind: 'isolated-authoritative-storage-fixture', createdAt: new Date().toISOString(),
    node: process.version, platform: process.platform, products: fixture.products, orders: fixture.orders,
    shopCount: fixture.shops, durationMs: fixture.durationMs, sharedOrderRows: 0, sharedProductRows: 0,
    reopened: fixture.reopened, shops, rendererPerformanceVerified: false, releaseAcceptance: false,
    note: '单轮权威仓储落盘/重开回读；不是真实页面、API延迟或安装包容量验收，不外推更大数据量。' };
  const outputDirectory = await preparePerformanceEvidenceDirectory(options.outputDirectory);
  const reportPath = path.join(outputDirectory, `fixture-${lease.runId}.json`);
  report.syntheticProfileDisposed = disposeRendererPerformanceFixture(fixture, { ownedRoot: lease.directory }).disposed;
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, products: fixture.products, orders: fixture.orders, shops: fixture.shops,
    seedAndReopenMs: fixture.durationMs, reportPath }));
});
