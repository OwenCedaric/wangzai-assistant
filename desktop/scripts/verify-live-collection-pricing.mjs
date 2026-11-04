import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProtectedComputeService } from '../../local-api/src/domain/protectedCompute/protectedComputeService.js';
import { createProtectedComputeRuntimeFromConfig } from '../../local-api/src/domain/protectedCompute/protectedComputeRuntime.js';
import { requestCollectionSkuPricingQuotes } from '../../frontend/src/features/collectionPricing/services/collectionPricingQuoteService.js';
import { loadProtectedComputeDistribution } from '../src/licensing/protectedComputeDistribution.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(desktopRoot, '..');
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 30;

function progress(message) {
  process.stderr.write(`[collection-pricing-evidence] ${message}\n`);
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function money(value) {
  return Number(Number(value).toFixed(2));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function latestScopedDraft(userDataDirectory) {
  const scopeDirectory = path.join(
    userDataDirectory,
    '本地数据',
    '分类缓存',
    '17-采集核价',
    'scopes',
  );
  const entries = await fs.readdir(scopeDirectory, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      const filePath = path.join(scopeDirectory, entry.name);
      const stat = await fs.stat(filePath);
      return { filePath, modifiedAtMs: stat.mtimeMs };
    }));
  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  if (!candidates[0]) throw new Error('没有找到当前用户的采集核价草稿。');
  const bytes = await fs.readFile(candidates[0].filePath);
  const payload = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(payload?.items)) throw new Error('采集核价草稿结构无效。');
  return { filePath: candidates[0].filePath, bytes, payload };
}

function preferredDraft(item = {}) {
  if (item.ozonListingDraft?.skus?.length) return item.ozonListingDraft;
  return Object.values(item.ozonListingDrafts || {}).find((draft) => draft?.skus?.length) || null;
}

function eligibleGroups(items = []) {
  return items.flatMap((item) => {
    const draft = preferredDraft(item);
    const pricingDraft = draft?.pricingDraft || {};
    if (
      String(item?.currency || '').toUpperCase() !== 'CNY'
      || !positiveNumber(pricingDraft.ozonFeePercent)
      || !positiveNumber(pricingDraft.expectedProfitCny)
      || !positiveNumber(pricingDraft.firstMileCost)
    ) return [];
    const skus = (draft.skus || []).filter((sku) => (
      sku?.enabled !== false && positiveNumber(sku?.sourcePriceCny)
    ));
    if (!skus.length) return [];
    return [{
      item,
      draft,
      pricingDraft,
      skus: skus.map((sku) => ({
        ...sku,
        firstMileCostCny: sku.firstMileCostCny ?? sku.freightCostCny ?? pricingDraft.firstMileCost,
      })),
    }];
  });
}

function roundRobinSamples(groups, limit) {
  const queues = groups.map((group) => ({ ...group, skus: [...group.skus] }));
  const selected = new Map(groups.map((group) => [group, []]));
  let total = 0;
  while (total < limit && queues.some((group) => group.skus.length)) {
    for (let index = 0; index < queues.length && total < limit; index += 1) {
      const queue = queues[index];
      const sku = queue.skus.shift();
      if (!sku) continue;
      selected.get(groups[index]).push(sku);
      total += 1;
    }
  }
  return groups
    .map((group) => ({ ...group, skus: selected.get(group) }))
    .filter((group) => group.skus.length);
}

function assertVerifiedRows(rows, requestedProfitCny) {
  for (const row of rows) {
    const snapshot = row.pricingSnapshot || {};
    const actualProfit = money(snapshot.expectedProfitCny);
    const allInCost = money(snapshot.allInCostCny ?? snapshot.totalCostCny);
    const equationCost = money(row.priceCny - actualProfit);
    const componentCost = money(
      snapshot.purchaseCostCny
      + snapshot.firstMileCostCny
      + snapshot.extraCostCny
      + snapshot.commissionCostCny,
    );
    if (snapshot.quoteSource !== 'server-signed') throw new Error('真实核价没有返回在线签名结果。');
    if (!snapshot.inputKey) throw new Error('真实核价结果没有绑定输入。');
    if (Math.abs(equationCost - allInCost) > 0.01 || Math.abs(componentCost - allInCost) > 0.01) {
      throw new Error('真实核价金额分项无法闭合。');
    }
    if (actualProfit < requestedProfitCny || actualProfit - requestedProfitCny > 0.1) {
      throw new Error('真实核价利润未达到预期金额。');
    }
  }
}

async function main() {
  const appDataDirectory = process.env.APPDATA;
  if (!appDataDirectory) throw new Error('APPDATA 未设置，无法定位桌面资料。');
  const sourceUserDataDirectory = path.resolve(
    process.env.WANGZAI_DESKTOP_DATA_DIR || path.join(appDataDirectory, 'wangzai-desktop'),
  );
  const accessToken = String(process.env.WANGZAI_PROTECTED_COMPUTE_ACCESS_TOKEN || '').trim();
  if (!accessToken) throw new Error('当前桌面登录没有可用的受保护计算授权，请先保持软件登录。');
  progress('current protected session loaded');

  const distribution = JSON.parse(await fs.readFile(
    path.join(desktopRoot, 'resources', 'distribution.json'),
    'utf8',
  ));
  const protectedDistribution = loadProtectedComputeDistribution({
    distribution,
    licenseRoot: path.join(desktopRoot, 'resources'),
    expectedServerUrl: distribution.license_center_url,
    required: true,
  });
  const runtime = createProtectedComputeRuntimeFromConfig({
    signedPublicConfigPath: protectedDistribution.signedPublicConfigPath,
    configurationPublicKeyPath: protectedDistribution.configurationPublicKeyPath,
    configurationKeyId: protectedDistribution.configurationKeyId,
    configurationKeySha256: protectedDistribution.configurationKeySha256,
  });
  const runtimeStatus = runtime.getStatus();
  if (!runtimeStatus.available) throw new Error(`受保护计算运行时不可用：${runtimeStatus.reasonCode}`);
  progress(`signed public config verified (v${runtimeStatus.configVersion})`);
  const service = createProtectedComputeService({
    client: runtime.client,
    runtimeStatus: () => runtime.getStatus(),
  });
  const signedResponses = [];
  globalThis.window = {
    wangzaiDesktop: {
      async localApiRequest(input = {}) {
        if (input.path !== '/api/protected-compute/execute' || input.method !== 'POST') {
          return { ok: false, status: 404, data: { error: { message: '验收工具只允许采集核价。' } } };
        }
        try {
          const data = await service.execute(input.body, { accessToken });
          signedResponses.push({
            source: data.source,
            keyId: data.verification?.keyId || '',
            issuedAt: data.verification?.issuedAt || '',
            expiresAt: data.verification?.expiresAt || '',
          });
          return { ok: true, status: 200, data };
        } catch (error) {
          return {
            ok: false,
            status: Number(error?.status) || 500,
            data: { ok: false, error: { code: error?.code || 'LIVE_QUOTE_FAILED', message: error?.message || '真实核价失败。' } },
          };
        }
      },
    },
  };

  const draft = await latestScopedDraft(sourceUserDataDirectory);
  const groups = eligibleGroups(draft.payload.items);
  const requestedLimit = Number.parseInt(argument('--limit', String(DEFAULT_LIMIT)), 10);
  const limit = Math.min(Math.max(requestedLimit || DEFAULT_LIMIT, DEFAULT_LIMIT), MAX_LIMIT);
  const selectedGroups = roundRobinSamples(groups, limit);
  const selectedCount = selectedGroups.reduce((total, group) => total + group.skus.length, 0);
  if (selectedCount < DEFAULT_LIMIT || selectedGroups.length < 3) {
    throw new Error('真实采集草稿不足 20 个 SKU 或不足 3 个商品，无法完成生产金额验收。');
  }
  progress(`selected ${selectedCount} real SKUs from ${selectedGroups.length} products`);

  const evidenceRows = [];
  for (const group of selectedGroups) {
    progress(`quoting product ${String(group.item.sourceProductId || '').slice(0, 32)} (${group.skus.length} SKUs)`);
    const result = await requestCollectionSkuPricingQuotes(group.skus, group.pricingDraft, {
      concurrency: 1,
      timeoutMs: 20_000,
      maxAttempts: 3,
    });
    const requestedProfitCny = positiveNumber(group.pricingDraft.expectedProfitCny);
    assertVerifiedRows(result.rows, requestedProfitCny);
    result.rows.forEach((row) => evidenceRows.push({
      sourceProductId: String(group.item.sourceProductId || ''),
      sourceSkuId: row.sourceSkuId,
      inputKey: row.pricingSnapshot.inputKey,
      purchaseCostCny: row.pricingSnapshot.purchaseCostCny,
      firstMileCostCny: row.pricingSnapshot.firstMileCostCny,
      extraCostCny: row.pricingSnapshot.extraCostCny,
      commissionPercent: row.pricingSnapshot.commissionPercent,
      salePriceCny: row.priceCny,
      breakEvenPriceCny: row.pricingSnapshot.breakEvenPriceCny,
      totalCostCny: row.pricingSnapshot.allInCostCny,
      actualProfitCny: row.pricingSnapshot.expectedProfitCny,
      profitMarginPercent: row.pricingSnapshot.profitMarginPercent,
      quoteSource: row.pricingSnapshot.quoteSource,
    }));
  }

  const generatedAt = new Date().toISOString();
  const evidence = {
    contract: 'collection-pricing-real-signed-evidence/v1',
    generatedAt,
    draftSha256: sha256(draft.bytes),
    userScopeSha256: sha256(String(process.env.WANGZAI_PROTECTED_COMPUTE_USER_SCOPE || 'authenticated-user')),
    protectedCompute: {
      capability: 'collection-pricing.quote',
      version: 1,
      configVersion: protectedDistribution.configVersion,
      configExpiresAt: protectedDistribution.configExpiresAt,
      configurationKeyId: protectedDistribution.configurationKeyId,
      configurationKeySha256: protectedDistribution.configurationKeySha256,
      serverBaseUrl: protectedDistribution.serverBaseUrl,
      signatureVerified: protectedDistribution.signatureVerified,
      onlineSignedResponseCount: signedResponses.length,
      onlineSigningKeyIds: [...new Set(signedResponses.map((item) => item.keyId).filter(Boolean))],
    },
    sampleCount: evidenceRows.length,
    productCount: new Set(evidenceRows.map((row) => row.sourceProductId)).size,
    uniqueInputCount: new Set(evidenceRows.map((row) => row.inputKey)).size,
    checks: {
      allResponsesServerSigned: signedResponses.every((item) => item.source === 'server-signed'),
      allRowsInputBound: evidenceRows.every((row) => Boolean(row.inputKey)),
      allAmountsClosed: true,
      secretsPersisted: false,
    },
    rows: evidenceRows,
  };
  const outputPath = path.resolve(argument(
    '--output',
    path.join(workspaceRoot, 'local-api', 'evidence', 'collection-pricing-real-golden-v1.json'),
  ));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  progress('evidence written');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    outputPath,
    sampleCount: evidence.sampleCount,
    productCount: evidence.productCount,
    uniqueInputCount: evidence.uniqueInputCount,
    onlineSignedResponseCount: evidence.protectedCompute.onlineSignedResponseCount,
    configVersion: evidence.protectedCompute.configVersion,
    configExpiresAt: evidence.protectedCompute.configExpiresAt,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
