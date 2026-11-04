import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(desktopRoot, '..');
export const DEFAULT_COLLECTION_PRICING_EVIDENCE_PATH = path.join(
  workspaceRoot,
  'local-api',
  'evidence',
  'collection-pricing-real-golden-v1.json',
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyCollectionPricingEvidence(filePath = DEFAULT_COLLECTION_PRICING_EVIDENCE_PATH, now = new Date()) {
  const text = fs.readFileSync(filePath, 'utf8');
  assert(!/(?:access|refresh|license)[_-]?token|authorization|password|cookie|api[_-]?key/iu.test(text), '核价证据包含秘密字段');
  const evidence = JSON.parse(text);
  assert(evidence.contract === 'collection-pricing-real-signed-evidence/v1', '核价证据契约无效');
  assert(/^[a-f0-9]{64}$/u.test(evidence.draftSha256 || ''), '核价证据缺少草稿哈希');
  assert(/^[a-f0-9]{64}$/u.test(evidence.userScopeSha256 || ''), '核价证据缺少用户作用域哈希');
  assert(evidence.protectedCompute?.capability === 'collection-pricing.quote', '核价能力标识无效');
  assert(evidence.protectedCompute?.version === 1, '核价能力版本无效');
  assert(evidence.protectedCompute?.signatureVerified === true, '公开配置没有通过签名验证');
  assert(/^[a-f0-9]{64}$/u.test(evidence.protectedCompute?.configurationKeySha256 || ''), '配置公钥指纹无效');
  assert(Date.parse(evidence.protectedCompute?.configExpiresAt || '') > now.getTime(), '核价签名配置已经过期');
  assert(Number.isInteger(evidence.sampleCount) && evidence.sampleCount >= 20, '真实核价样本不足 20 条');
  assert(Number.isInteger(evidence.productCount) && evidence.productCount >= 3, '真实核价商品不足 3 个');
  assert(Number.isInteger(evidence.uniqueInputCount) && evidence.uniqueInputCount >= 3, '真实核价输入组合不足 3 组');
  assert(Array.isArray(evidence.rows) && evidence.rows.length === evidence.sampleCount, '核价证据行数不一致');
  assert(evidence.protectedCompute.onlineSignedResponseCount >= evidence.uniqueInputCount, '在线签名响应数量不足');
  assert(Array.isArray(evidence.protectedCompute.onlineSigningKeyIds) && evidence.protectedCompute.onlineSigningKeyIds.length > 0, '在线结果缺少签名 Key ID');
  assert(evidence.checks?.allResponsesServerSigned === true, '存在非在线签名核价结果');
  assert(evidence.checks?.allRowsInputBound === true, '存在未绑定输入的核价结果');
  assert(evidence.checks?.allAmountsClosed === true, '存在金额无法闭合的核价结果');
  assert(evidence.checks?.secretsPersisted === false, '核价证据错误标记为含秘密');
  const identities = new Set();
  for (const row of evidence.rows) {
    assert(row.quoteSource === 'server-signed', '核价证据行不是在线签名结果');
    assert(/^collection-sku-pricing-v1:\d+:\d+:\d+:\d+:\d+$/u.test(row.inputKey || ''), '核价证据行输入绑定无效');
    assert(String(row.sourceProductId || '').trim() && String(row.sourceSkuId || '').trim(), '核价证据缺少真实商品或 SKU');
    assert(Number(row.salePriceCny) > 0 && Number(row.actualProfitCny) > 0 && Number(row.totalCostCny) > 0, '核价证据金额无效');
    const equationCost = Number((Number(row.salePriceCny) - Number(row.actualProfitCny)).toFixed(2));
    assert(Math.abs(equationCost - Number(row.totalCostCny)) <= 0.01, '核价证据金额不闭合');
    const identity = `${row.sourceProductId}:${row.sourceSkuId}`;
    assert(!identities.has(identity), '核价证据包含重复 SKU');
    identities.add(identity);
  }
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = verifyCollectionPricingEvidence(process.argv[2] || DEFAULT_COLLECTION_PRICING_EVIDENCE_PATH);
  process.stdout.write(`${JSON.stringify({ ok: true, sampleCount: evidence.sampleCount, productCount: evidence.productCount })}\n`);
}
