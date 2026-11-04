import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPackage } from '@electron/asar';

import {
  protectedComputeSemanticAuditInternals,
  scanProtectedComputeSemanticBoundary,
  scanProtectedComputeSemanticText,
} from './protected-compute-semantic-audit.mjs';

const LEGACY_FRACTIONAL_IMPLEMENTATION = `
  export function calculate(input = {}) {
    const purchase = parse(input.purchaseCost);
    const shipping = parse(input.firstMileCost) ?? 0;
    const extra = parse(input.extraCost) ?? 0;
    const commission = Math.min(Math.max(parse(input.feePercent) ?? 0, 0), 95) / 100;
    const margin = Math.max(parse(input.marginPercent) ?? 0, 0) / 100;
    const cost = Number.isFinite(purchase) ? purchase + shipping + extra : null;
    const denominator = 1 - commission;
    const breakEven = Number.isFinite(cost) ? cost / denominator : null;
    const suggested = Number.isFinite(cost) ? cost * (1 + margin) / denominator : null;
    return { breakEven, suggested };
  }
`;

const INTEGER_IMPLEMENTATION = `
  function quote(total, commission, margin) {
    const denominator = 10_000 - commission;
    const breakEven = Math.ceil(total * 10_000 / denominator);
    const suggested = Math.ceil(total * (10_000 + margin) / denominator);
    return { breakEven, suggested };
  }
`;

const PROFITABILITY_IMPLEMENTATION = `
  function q(p) {
    const s = p.s;
    const b = p.a + p.b + p.c;
    const v = Math.ceil(s * b / 10_000);
    const l = Math.ceil(p.l * 103 / 100);
    const r = Math.ceil(s * 137 / 10_000);
    const c = s - p.k - l - v - r;
    const m = Math.floor(c * 10_000 / s);
    const d = m < 450 ? 'reject' : m < 1_250 ? 'review' : m < 2_100 ? 'acceptable' : 'preferred';
    return { c, m, d };
  }
`;

test('structural fingerprints stay bounded for deeply shared minified expressions', () => {
  const createSharedExpression = (leafValue) => {
    let node = Object.freeze({ op: 'sym', value: leafValue });
    for (let depth = 0; depth < 80; depth += 1) {
      node = Object.freeze({ op: 'pair', args: Object.freeze([node, node]) });
    }
    return node;
  };
  const first = protectedComputeSemanticAuditInternals.stableNode(createSharedExpression('same'));
  const second = protectedComputeSemanticAuditInternals.stableNode(createSharedExpression('same'));
  const different = protectedComputeSemanticAuditInternals.stableNode(createSharedExpression('different'));

  assert.match(first, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(first, second);
  assert.notEqual(first, different);
});

test('detects the legacy fractional implementation after identifier renaming', () => {
  const result = scanProtectedComputeSemanticText(LEGACY_FRACTIONAL_IMPLEMENTATION, {
    file: 'legacy-client.js',
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].code, 'PROTECTED_COMPUTE_EQUIVALENT_FORMULA_LEAK');
  assert.match(result.findings[0].evidence, /fractional-fee-margin-pricing/u);
});

test('detects a minified integer basis-point equivalent wrapped in rounding calls', () => {
  const source = 'function q(a,b,c){const d=1e4-b,e=Math.ceil(a*1e4/d),f=Math.ceil(a*(1e4+c)/d);return[e,f]}';
  const result = scanProtectedComputeSemanticText(source, { file: 'minified-client.js' });
  assert.equal(result.ok, false);
  assert.match(result.findings[0].evidence, /integer-basis-point-fee-margin-pricing/u);
});

for (const [name, source] of Object.entries({
  'module-level scale binding': `
    const SCALE = 10_000;
    function q(a, b, c) {
      const d = SCALE - b;
      const e = Math.ceil(a * SCALE / d);
      const f = Math.ceil(a * (SCALE + c) / d);
      return [e, f];
    }
  `,
  'constant-folded scale': 'function q(a,b,c){const s=100*100,d=s-b,e=a*s/d,f=a*(s+c)/d;return e+f}',
  'hexadecimal scale': 'function q(a,b,c){const s=0x2710,d=s-b,e=a*s/d,f=a*(s+c)/d;return e+f}',
  'exponent scale': 'function q(a,b,c){const s=10**4,d=s-b,e=a*s/d,f=a*(s+c)/d;return e+f}',
  'inline return object': 'function q(a,b,c){return {e:Math.ceil(a*1e4/(1e4-b)),s:Math.ceil(a*(1e4+c)/(1e4-b))}}',
  'inline return array': 'function q(a,b,c){return [Math.ceil(a*1e4/(1e4-b)),Math.ceil(a*(1e4+c)/(1e4-b))]}',
  'concise arrow body': 'export const q=(a,b,c)=>[Math.ceil(a*1e4/(1e4-b)),Math.ceil(a*(1e4+c)/(1e4-b))]',
  'ceil-ratio helper': 'function cr(n,d){return Math.floor((n+d-1)/d)}function q(a,b,c){const d=1e4-b,e=cr(a*1e4,d),f=cr(a*(1e4+c),d);return[e,f]}',
  'split helper scopes': 'const be=(a,b)=>Math.ceil(a*1e4/(1e4-b));const sp=(a,b,c)=>Math.ceil(a*(1e4+c)/(1e4-b));export const q=(a,b,c)=>[be(a,b),sp(a,b,c)]',
  'reassociated denominator': 'function q(a,b,c){const d=(1e4-b)/1e4,e=a/d,f=a*(1+c/1e4)/d;return e+f}',
  'mutable intermediate': 'function q(a,b,c){let d=0;d=1e4-b;const e=a*1e4/d,f=a*(1e4+c)/d;return e+f}',
})) {
  test(`detects collection pricing after ${name}`, () => {
    const result = scanProtectedComputeSemanticText(source, { file: `${name}.js` });
    assert.equal(result.ok, false);
    assert.equal(
      result.findings.some((finding) => (
        finding.code === 'PROTECTED_COMPUTE_EQUIVALENT_FORMULA_LEAK'
      )),
      true,
    );
  });
}

test('detects the complete profitability reserve/logistics/decision family', () => {
  const result = scanProtectedComputeSemanticText(PROFITABILITY_IMPLEMENTATION, {
    file: 'profitability-client.js',
  });
  assert.equal(result.ok, false);
  assert.match(result.findings[0].evidence, /profitability-reserve-logistics-decision/u);
  assert.match(result.findings[0].evidence, /thresholds=3\/3/u);
});

test('detects profitability with module constants and a shared ceil-ratio helper', () => {
  const source = `
    const SCALE = 10 ** 4;
    const LOGISTICS_NUMERATOR = 103;
    const LOGISTICS_DENOMINATOR = 100;
    const RESERVE = 137;
    function ceilRatio(n, d) { return Math.floor((n + d - 1) / d); }
    function q(p) {
      const sale = p.s;
      const rates = p.a + p.b + p.c;
      const variable = ceilRatio(sale * rates, SCALE);
      const logistics = ceilRatio(p.l * LOGISTICS_NUMERATOR, LOGISTICS_DENOMINATOR);
      const reserve = ceilRatio(sale * RESERVE, SCALE);
      const contribution = sale - p.k - logistics - variable - reserve;
      const margin = Math.floor(contribution * SCALE / sale);
      const decision = margin < 450 ? 'r' : margin < 1_250 ? 'v' : margin < 2_100 ? 'a' : 'p';
      return { contribution, margin, decision };
    }
  `;
  const result = scanProtectedComputeSemanticText(source, {
    file: 'profitability-helper-client.js',
  });
  assert.equal(result.ok, false);
  assert.match(result.findings[0].evidence, /profitability-reserve-logistics-decision/u);
});

test('detects leaked source inside a source map even when the emitted wrapper is harmless', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'protected-compute-map-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'bundle.js'), 'export const remoteOnly = true;\n', 'utf8');
  await fs.writeFile(
    path.join(directory, 'bundle.js.map'),
    JSON.stringify({
      version: 3,
      sources: ['legacy-pricing.js'],
      sourcesContent: [LEGACY_FRACTIONAL_IMPLEMENTATION],
      names: [],
      mappings: '',
    }),
    'utf8',
  );
  const result = await scanProtectedComputeSemanticBoundary({ clientRoots: [directory] });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((finding) => (
    finding.code === 'PROTECTED_COMPUTE_EQUIVALENT_FORMULA_LEAK'
    && finding.file.includes('bundle.js.map::legacy-pricing.js')
  )), true);
});

test('detects leaked source inside an inline base64 data source map', () => {
  const sourceMap = {
    version: 3,
    sources: ['private-pricing.js'],
    sourcesContent: [INTEGER_IMPLEMENTATION],
    names: [],
    mappings: '',
  };
  const source = `
    export const remoteOnly = true;
    //# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(sourceMap)).toString('base64')}
  `;
  const result = scanProtectedComputeSemanticText(source, { file: 'inline-map-bundle.js' });
  assert.equal(result.ok, false);
  assert.equal(
    result.findings.some((finding) => finding.file.includes('inline-source-map::private-pricing.js')),
    true,
  );
});

for (const [name, source] of Object.entries({
  eval: 'eval("1 + 1")',
  Function: 'Function("return 1")()',
  'new Function': 'new Function("return 1")',
  WebAssembly: 'WebAssembly.instantiate(bytes)',
  'string timer': 'setTimeout("run()", 1)',
})) {
  test(`package mode fails closed on ${name}`, () => {
    const result = scanProtectedComputeSemanticText(source, {
      file: `dynamic-${name}.js`,
      packageMode: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.findings[0].code, 'PROTECTED_COMPUTE_DYNAMIC_CODE_FORBIDDEN');
  });
}

test('package mode recursively reads ASAR and does not skip fixtures or app.asar.unpacked', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'protected-compute-asar-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceRoot = path.join(directory, 'asar-source');
  const resourcesRoot = path.join(directory, 'resources');
  await fs.mkdir(path.join(sourceRoot, 'src', 'fixtures'), { recursive: true });
  await fs.mkdir(path.join(resourcesRoot, 'app.asar.unpacked', 'tests'), { recursive: true });
  await fs.mkdir(path.join(resourcesRoot, 'node_modules', 'fixture-package'), { recursive: true });
  await fs.writeFile(
    path.join(sourceRoot, 'src', 'fixtures', 'leak.js'),
    INTEGER_IMPLEMENTATION,
    'utf8',
  );
  await fs.writeFile(
    path.join(resourcesRoot, 'app.asar.unpacked', 'tests', 'leak.js'),
    LEGACY_FRACTIONAL_IMPLEMENTATION,
    'utf8',
  );
  await fs.writeFile(
    path.join(resourcesRoot, 'node_modules', 'fixture-package', 'leak.js'),
    PROFITABILITY_IMPLEMENTATION,
    'utf8',
  );
  await createPackage(sourceRoot, path.join(resourcesRoot, 'app.asar'));

  const result = await scanProtectedComputeSemanticBoundary({
    clientRoots: [resourcesRoot],
    packageMode: true,
    excludeTestFixtures: false,
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.findings.some((finding) => (
      finding.file.includes('app.asar::src/fixtures/leak.js')
    )),
    true,
  );
  assert.equal(
    result.findings.some((finding) => (
      finding.file.includes('app.asar.unpacked') && finding.file.includes('tests')
    )),
    true,
  );
  assert.equal(
    result.findings.some((finding) => finding.file.includes('node_modules')),
    true,
  );
});

test('package mode rejects WASM and HTML inline executable content', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'protected-compute-artifact-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'module.wasm'), Buffer.from([0, 97, 115, 109]));
  await fs.writeFile(
    path.join(directory, 'inline.html'),
    '<!doctype html><script>window.value = 1;</script>',
    'utf8',
  );
  await fs.writeFile(
    path.join(directory, 'external.html'),
    '<!doctype html><script type="module" src="/assets/index.js"></script>',
    'utf8',
  );
  const result = await scanProtectedComputeSemanticBoundary({
    clientRoots: [directory],
    packageMode: true,
    excludeTestFixtures: false,
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.findings.some((finding) => finding.code === 'PROTECTED_COMPUTE_WASM_ARTIFACT_FORBIDDEN'),
    true,
  );
  assert.equal(
    result.findings.some((finding) => finding.code === 'PROTECTED_COMPUTE_HTML_INLINE_CODE_FORBIDDEN'),
    true,
  );
  assert.equal(result.findings.some((finding) => finding.file.endsWith('external.html')), false);
});

test('allows DTO validation and minor-unit presentation mapping without local arithmetic', () => {
  const source = `
    export function mapSignedQuote(payload) {
      if (!Number.isSafeInteger(payload.result.suggestedPriceMinor)) throw new Error('invalid');
      return {
        totalCost: payload.result.totalCostMinor / 100,
        breakEvenPrice: payload.result.breakEvenPriceMinor / 100,
        suggestedPrice: payload.result.suggestedPriceMinor / 100,
        currentProfit: payload.result.currentProfitMinor == null
          ? null
          : payload.result.currentProfitMinor / 100,
      };
    }
  `;
  const result = scanProtectedComputeSemanticText(source, { file: 'signed-result-mapper.js' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test('allows an isolated percentage normalization that does not reproduce the protected algorithm', () => {
  const result = scanProtectedComputeSemanticText(
    'export const formatPercent = (value) => Number(value) / 100;',
    { file: 'formatter.js' },
  );
  assert.equal(result.ok, true);
});

test('fails closed when a JavaScript artifact cannot be parsed', () => {
  const result = scanProtectedComputeSemanticText('export function broken( {', { file: 'broken.js' });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].code, 'PROTECTED_COMPUTE_SEMANTIC_PARSE_FAILED');
});

test('release scripts and build filters enforce verification and test-fixture exclusion', async () => {
  const packagePath = new URL('../package.json', import.meta.url);
  const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  assert.match(packageJson.scripts['check:source'], /npm run test:protected-boundary/u);
  assert.match(packageJson.scripts['pack:win'], /^npm run test:protected-boundary/u);
  assert.match(packageJson.scripts['dist:win'], /^npm run test:protected-boundary/u);
  assert.match(
    packageJson.scripts['dist:win:installer'],
    /&& npm run verify:package && npm run smoke:installer$/u,
  );
  assert.match(
    packageJson.scripts['dist:win:portable'],
    /&& npm run verify:package && npm run smoke:portable$/u,
  );
  assert.equal(
    packageJson.build.files.includes('!src/**/{__tests__,test,tests,fixture,fixtures}/**/*'),
    true,
  );
  const localApiResource = packageJson.build.extraResources.find((entry) => (
    entry.to === 'local-api/src'
  ));
  assert.equal(
    localApiResource.filter.includes('!**/{__tests__,test,tests,fixture,fixtures}/**/*'),
    true,
  );

  const verifyPackageSource = await fs.readFile(
    new URL('./verify-package.mjs', import.meta.url),
    'utf8',
  );
  assert.match(verifyPackageSource, /const protectedClientRoots = \[resourcesRoot\]/u);
  assert.match(verifyPackageSource, /packageMode: true/u);
  assert.match(verifyPackageSource, /collectForbiddenTestFiles\(resourcesRoot\)/u);

  const localApiScannerSource = await fs.readFile(
    new URL('../../local-api/scripts/scan-protected-compute-boundary.mjs', import.meta.url),
    'utf8',
  );
  assert.match(localApiScannerSource, /artifactRoots/u);
  assert.match(localApiScannerSource, /forcePackageMode \? \[\] : defaultSourceRoots/u);
  assert.match(localApiScannerSource, /forceSourceMode \? \[\] : defaultArtifactRoots/u);
  assert.match(localApiScannerSource, /packageMode: true/u);
  assert.match(localApiScannerSource, /excludeTestFixtures: false/u);
});
