import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { auditDataAnalysisInsightFreeze } from '../frontend/scripts/data-analysis-insight-freeze-core.mjs';
import { auditDataAnalysisMarketCaptureFreeze } from '../frontend/scripts/data-analysis-market-capture-freeze-core.mjs';
import { auditProductImageOssFreeze } from '../frontend/scripts/product-image-oss-freeze-core.mjs';
import { auditFollowSellerScheme1Freeze } from '../frontend/scripts/follow-seller-scheme1-freeze-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = join(root, 'frontend');
const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf8');
const target = instructions.match(/\[冻结契约\]\(([^)#]+)(?:#[^)]*)?\)/u)?.[1];
const frozenPath = target && resolve(root, target);
const cases = [
  ['data-analysis-insight', auditDataAnalysisInsightFreeze,
    'src/features/dataAnalysis/constants/dataAnalysisInsightFreezeContract.js', 'DATA_ANALYSIS_INSIGHT_FREEZE_VERSION'],
  ['data-analysis-market-capture', auditDataAnalysisMarketCaptureFreeze,
    'src/features/dataAnalysis/constants/dataAnalysisMarketCaptureFreezeContract.js', 'DATA_ANALYSIS_MARKET_CAPTURE_FREEZE_VERSION'],
  ['product-image-oss', auditProductImageOssFreeze,
    'src/features/products/services/productImageAssetService.js', 'PRODUCT_IMAGE_OSS_FREEZE_VERSION'],
  ['follow-seller-scheme1', auditFollowSellerScheme1Freeze,
    'src/features/followSellerDefense/services/followSellerDefenseService.js', 'FOLLOW_SELLER_SCHEME1_FREEZE_VERSION'],
];

test('root instructions route to existing workflow and the enforced freeze document', () => {
  assert.ok(frozenPath, 'root AGENTS must link to the frozen contracts');
  assert.ok(readFileSync(frozenPath, 'utf8').includes('## 已冻结模块：'));
  const workflow = instructions.match(/\[开发工作流\]\(([^)]+)\)/u)?.[1];
  assert.ok(workflow, 'root AGENTS must link to the development workflow');
  assert.ok(readFileSync(resolve(root, workflow), 'utf8').trim());
});

for (const [name, audit, versionFile, versionSymbol] of cases) {
  test(`${name}: relocated instruction contract remains fail-closed`, async t => {
    const original = JSON.parse(readFileSync(join(frontend, 'scripts', `${name}-freeze-manifest.json`), 'utf8'));
    const contracts = original.contracts.filter(item => resolve(frontend, item.file) === frozenPath);
    assert.equal(contracts.length, 1, 'exactly one contract must enforce the root-linked document');
    const contract = contracts[0];
    assert.ok(contract.required.length > 0);
    const source = readFileSync(frozenPath, 'utf8');
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'wangzai-agent-contract-'));
    const fixtureFrontend = join(fixtureRoot, 'frontend');
    function fixturePath(file) {
      const value = resolve(fixtureFrontend, file);
      const rel = relative(fixtureRoot, value);
      assert.ok(rel && rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel));
      return value;
    }
    function write(file, value) {
      const destination = fixturePath(file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, value);
    }
    try {
      const version = `export const ${versionSymbol} = '${original.featureVersion}';\n`;
      write(versionFile, version);
      const manifest = { ...original,
        files: { [versionFile]: createHash('sha256').update(version).digest('hex') },
        segments: [], sequences: [], contracts: [contract] };
      write(contract.file, source);
      await t.test('the relocated document satisfies the unchanged contract', () => {
        assert.deepEqual(audit({ root: fixtureFrontend, manifest }).violations, []);
      });
      for (const [index, required] of contract.required.entries()) {
        await t.test(`missing requirement ${index + 1} is rejected`, () => {
          write(contract.file, source.replaceAll(required, '[omitted in isolated fixture]'));
          const result = audit({ root: fixtureFrontend, manifest });
          assert.equal(result.ok, false);
          assert.ok(result.violations.some(item => item.kind === 'missing-required-contract' && item.message.includes(required)));
        });
      }
      await t.test('a missing referenced document is rejected', () => {
        rmSync(fixturePath(contract.file));
        assert.ok(audit({ root: fixtureFrontend, manifest }).violations.some(item => item.kind === 'missing-file'));
      });
    } finally {
      assert.equal(dirname(fixtureRoot), resolve(tmpdir()));
      assert.ok(relative(tmpdir(), fixtureRoot).startsWith('wangzai-agent-contract-'));
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
}
