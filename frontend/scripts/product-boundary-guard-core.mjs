import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx']);
const PRODUCT_FEATURE_ROOT = 'features/products';
const NORMAL_PRODUCT_CHAIN_FILES = Object.freeze([
  'entities/product/productListQuery.jsx',
  'services/productListSyncClient.js',
  'services/productModuleClient.js',
  'services/productReadClient.js',
  'services/productWriteClient.js',
]);

const FORBIDDEN_IMPORT_PATTERN =
  /(?:productSearchFallbackService|productOzonApi|localMirrorDataset|localMirrorProductRows|ozonLocalDataLayer|browserLegacyReadStore|legacyBrowserReadStore|productLegacyMigrationService|productLegacyMigrationRepository)/iu;

const SOURCE_RULES = Object.freeze([
  {
    rule: 'PRODUCT-FE-01',
    kind: 'direct-fetch',
    pattern: /(?<![\w$.])fetch\s*\(/u,
    evidence: '商品正常链路出现 Renderer 直接 fetch。',
  },
  {
    rule: 'PRODUCT-FE-02',
    kind: 'direct-ozon-request',
    pattern: /\brequestOzon[A-Za-z0-9_]*\b/u,
    evidence: '商品正常链路出现 Renderer Ozon transport 调用。',
  },
  {
    rule: 'PRODUCT-FE-03',
    kind: 'ozon-endpoint',
    pattern: /(?:api-seller\.ozon\.ru|["'`]\/v\d+\/[A-Za-z0-9_-])/iu,
    evidence: '商品正常链路拼接了 Ozon endpoint。',
  },
  {
    rule: 'PRODUCT-FE-04',
    kind: 'renderer-sql',
    pattern:
      /(?:["'`]\s*(?:SELECT\s+[\s\S]{0,160}?\s+FROM|INSERT\s+INTO|UPDATE\s+[A-Za-z_][A-Za-z0-9_]*\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|PRAGMA\b)|\b(?:db|database|sqlite)\s*\.\s*(?:prepare|exec|run|all|get)\s*\()/iu,
    evidence: '商品正常链路出现 Renderer SQL。',
  },
  {
    rule: 'PRODUCT-FE-05',
    kind: 'browser-storage',
    pattern: /\b(?:localStorage|sessionStorage|indexedDB)\b/u,
    evidence: '商品正常链路出现浏览器持久化。',
  },
  {
    rule: 'PRODUCT-FE-06',
    kind: 'json-local-mirror',
    pattern: /\bJSON\s*\.\s*(?:parse|stringify)\s*\(/u,
    evidence: '商品 feature 正常链路出现 JSON 镜像读写。',
    featureOnly: true,
  },
  {
    rule: 'PRODUCT-FE-14',
    kind: 'partial-page-render',
    pattern:
      /\b(?:ProductTableRowsSpacer|renderProgress|INITIAL_RENDERED_PRODUCT_ROWS|PRODUCT_ROW_RENDER_CHUNK_SIZE|PRODUCT_ROW_RENDER_DELAY_MS|useProgressiveProductRows|progressivePageProducts)\b|正在加载其余商品|products\s*\.\s*slice\s*\(\s*0\s*,\s*renderedProductCount\s*\)/u,
    evidence: '商品长列表出现虚拟、渐进或截断渲染，不能把不完整 SQLite 页伪装成已完成。',
  },
]);

const IMPORT_PATTERN = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu;
const NAMED_IMPORT_PATTERN = /\bimport\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/gu;

function toFileId(root, filePath) {
  return relative(root, filePath).replaceAll('\\', '/');
}

function isProductionSource(fileName) {
  return SOURCE_EXTENSIONS.has(extname(fileName)) && !/\.test\.[jt]sx?$/u.test(fileName);
}

function listProductionSources(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const filePath = resolve(directory, entry);
      const stat = statSync(filePath);
      if (stat.isDirectory()) return listProductionSources(filePath);
      return isProductionSource(entry) ? [filePath] : [];
    });
}

function importSpecifiers(source) {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1]);
}

function namedImports(source) {
  const imports = [];
  for (const match of source.matchAll(NAMED_IMPORT_PATTERN)) {
    const names = match[1]
      .split(',')
      .map((part) => part.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0]?.trim())
      .filter(Boolean);
    imports.push({ specifier: match[2], names });
  }
  return imports;
}

function resolveSourceImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = resolve(dirname(importer), specifier);
  for (const filePath of [candidate, `${candidate}.js`, `${candidate}.jsx`]) {
    if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
  }
  return null;
}

function stripComments(source) {
  let result = '';
  let index = 0;
  let state = 'code';
  let quote = '';
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (current === '\n') {
        result += '\n';
        state = 'code';
      } else {
        result += ' ';
      }
      index += 1;
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        result += '  ';
        state = 'code';
        index += 2;
      } else {
        result += current === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (state === 'string') {
      result += current;
      if (current === '\\') {
        result += next ?? '';
        index += 2;
        continue;
      }
      if (current === quote) state = 'code';
      index += 1;
      continue;
    }
    if (current === '/' && next === '/') {
      result += '  ';
      state = 'line-comment';
      index += 2;
      continue;
    }
    if (current === '/' && next === '*') {
      result += '  ';
      state = 'block-comment';
      index += 2;
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      state = 'string';
    }
    result += current;
    index += 1;
  }
  return result;
}

function findMatchingBrace(source, openingIndex) {
  let depth = 0;
  let state = 'code';
  let quote = '';
  for (let index = openingIndex; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (current === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'string') {
      if (current === '\\') {
        index += 1;
        continue;
      }
      if (current === quote) state = 'code';
      continue;
    }
    if (current === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      state = 'string';
      continue;
    }
    if (current === '{') depth += 1;
    if (current !== '}') continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function findNamedFunctionBody(source, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=`, 'u').exec(source);
  const functionDeclaration = new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(`, 'u').exec(source);
  const start = declaration?.index ?? functionDeclaration?.index ?? -1;
  if (start < 0) return null;
  let openingIndex;
  if (declaration) {
    const arrowIndex = source.indexOf('=>', declaration.index + declaration[0].length);
    const initializerEnd = source.indexOf(';', declaration.index + declaration[0].length);
    if (arrowIndex < 0 || (initializerEnd >= 0 && arrowIndex > initializerEnd)) return null;
    openingIndex = source.indexOf('{', arrowIndex + 2);
  } else {
    openingIndex = source.indexOf('{', functionDeclaration.index + functionDeclaration[0].length);
  }
  if (openingIndex < 0) return null;
  const closingIndex = findMatchingBrace(source, openingIndex);
  if (closingIndex < 0) return null;
  return {
    start,
    end: closingIndex + 1,
    source: source.slice(openingIndex, closingIndex + 1),
  };
}

function findReactEffectBodies(source) {
  const bodies = [];
  const effectPattern = /\bReact\.useEffect\s*\(/gu;
  for (const match of source.matchAll(effectPattern)) {
    const arrowIndex = source.indexOf('=>', match.index + match[0].length);
    if (arrowIndex < 0) continue;
    const openingIndex = source.indexOf('{', arrowIndex + 2);
    if (openingIndex < 0) continue;
    const closingIndex = findMatchingBrace(source, openingIndex);
    if (closingIndex < 0) continue;
    bodies.push(source.slice(openingIndex, closingIndex + 1));
  }
  return bodies;
}

function addViolation(violations, { rule, kind, file, evidence }) {
  violations.push({
    rule,
    severity: 'P0',
    kind,
    file,
    evidence,
    remediation: '保持 Page→Model→typed client→local-api；同步只能由明确人工刷新动作触发。',
    baseline: false,
  });
}

function scanSourceRules({ source, file, featureFile, violations }) {
  const commentFreeSource = stripComments(source);
  for (const sourceRule of SOURCE_RULES) {
    if (sourceRule.featureOnly && !featureFile) continue;
    if (!sourceRule.pattern.test(commentFreeSource)) continue;
    addViolation(violations, { ...sourceRule, file });
  }
  for (const specifier of importSpecifiers(commentFreeSource)) {
    if (FORBIDDEN_IMPORT_PATTERN.test(specifier) || /\.json(?:$|[?#])/iu.test(specifier)) {
      addViolation(violations, {
        rule: 'PRODUCT-FE-07',
        kind: 'forbidden-product-fallback-import',
        file,
        evidence: `商品正常链路导入禁用 fallback/legacy/JSON 资源：${specifier}`,
      });
    }
    const isFeatureServiceBoundary = /(?:^|\/)[A-Za-z0-9]+Service\.js$/u.test(file);
    if (
      featureFile &&
      !isFeatureServiceBoundary &&
      /(?:^|\/)api\/localApiClient(?:\.[jt]sx?)?$/u.test(specifier)
    ) {
      addViolation(violations, {
        rule: 'PRODUCT-FE-08',
        kind: 'feature-bypasses-typed-client',
        file,
        evidence: `商品 feature 绕过 typed client 直连 local-api transport：${specifier}`,
      });
    }
  }
}

function auditImportedProductSymbols({ root, featureFiles, violations }) {
  const scanned = new Set();
  for (const featureFile of featureFiles) {
    const featureSource = readFileSync(featureFile, 'utf8');
    for (const imported of namedImports(stripComments(featureSource))) {
      const target = resolveSourceImport(featureFile, imported.specifier);
      if (!target || !target.startsWith(root)) continue;
      const targetId = toFileId(root, target);
      const isProductEntity = targetId.startsWith('entities/product/');
      const isProductService = /^services\/product[A-Za-z0-9_-]*(?:Client|Service)\.js$/u.test(targetId);
      if (!isProductEntity && !isProductService) continue;
      const targetSource = readFileSync(target, 'utf8');
      for (const name of imported.names) {
        const key = `${targetId}#${name}`;
        if (scanned.has(key)) continue;
        scanned.add(key);
        const body = findNamedFunctionBody(targetSource, name);
        if (!body) continue;
        scanSourceRules({
          source: body.source,
          file: key,
          featureFile: targetId !== 'entities/product/productListQuery.jsx',
          violations,
        });
      }
    }
  }
}

function requireImport({ source, file, pattern, rule, evidence, violations }) {
  if (pattern.test(stripComments(source))) return;
  addViolation(violations, { rule, kind: 'missing-required-layer-edge', file, evidence });
}

function auditTopology({ sourceById, violations }) {
  const page = sourceById.get('features/products/ProductListPage.jsx') ?? '';
  const workspace = sourceById.get('features/products/ProductListWorkspace.jsx') ?? '';
  const pageModel = sourceById.get('features/products/model/useProductListPageModel.jsx') ?? '';
  const syncState = sourceById.get('features/products/model/useProductSyncState.jsx') ?? '';
  const writeState = sourceById.get('features/products/model/useProductWriteState.jsx') ?? '';
  const listAdapter = sourceById.get('entities/product/productLocalMirror.jsx') ?? '';
  const listClient = sourceById.get('services/productListSyncClient.js') ?? '';
  const moduleClient = sourceById.get('services/productModuleClient.js') ?? '';
  const readClient = sourceById.get('services/productReadClient.js') ?? '';
  const writeClient = sourceById.get('services/productWriteClient.js') ?? '';

  const requiredFiles = [
    'features/products/ProductListPage.jsx',
    'features/products/ProductListWorkspace.jsx',
    'features/products/model/useProductListPageModel.jsx',
    'features/products/model/useProductSyncState.jsx',
    'features/products/model/useProductWriteState.jsx',
    'entities/product/productLocalMirror.jsx',
    ...NORMAL_PRODUCT_CHAIN_FILES,
  ];
  for (const file of requiredFiles) {
    if (sourceById.has(file)) continue;
    addViolation(violations, {
      rule: 'PRODUCT-FE-09',
      kind: 'missing-product-layer-file',
      file,
      evidence: '商品规范调用链缺少必需文件。',
    });
  }
  if (requiredFiles.some((file) => !sourceById.has(file))) return;

  requireImport({
    source: page,
    file: 'features/products/ProductListPage.jsx',
    pattern: /from\s+["']\.\/ProductListWorkspace\.jsx["']/u,
    rule: 'PRODUCT-FE-10',
    evidence: 'ProductListPage 必须只装配 ProductListWorkspace。',
    violations,
  });
  requireImport({
    source: workspace,
    file: 'features/products/ProductListWorkspace.jsx',
    pattern: /from\s+["']\.\/model\/useProductListPageModel\.jsx["']/u,
    rule: 'PRODUCT-FE-10',
    evidence: 'ProductListWorkspace 必须通过页面 Model 取数。',
    violations,
  });
  requireImport({
    source: pageModel,
    file: 'features/products/model/useProductListPageModel.jsx',
    pattern: /from\s+["']\.\/useProductSyncState\.jsx["']/u,
    rule: 'PRODUCT-FE-10',
    evidence: '商品页面 Model 必须组合 SQLite 查询状态。',
    violations,
  });
  requireImport({
    source: syncState,
    file: 'features/products/model/useProductSyncState.jsx',
    pattern: /from\s+["'][^"']*services\/productListSyncClient(?:\.js)?["']/u,
    rule: 'PRODUCT-FE-10',
    evidence: '商品查询/同步 Model 必须调用 productListSyncClient。',
    violations,
  });
  requireImport({
    source: listAdapter,
    file: 'entities/product/productLocalMirror.jsx',
    pattern: /from\s+["'][^"']*services\/productListSyncClient(?:\.js)?["']/u,
    rule: 'PRODUCT-FE-10',
    evidence: '商品 DTO adapter 必须经 productListSyncClient 读取 SQLite。',
    violations,
  });
  requireImport({
    source: writeState,
    file: 'features/products/model/useProductWriteState.jsx',
    pattern: /from\s+["'][^"']*services\/productModuleClient(?:\.js)?["']/u,
    rule: 'PRODUCT-FE-10',
    evidence: '商品写入 Model 必须经 productModuleClient typed facade。',
    violations,
  });
  for (const [file, source] of [
    ['services/productListSyncClient.js', listClient],
    ['services/productModuleClient.js', moduleClient],
    ['services/productReadClient.js', readClient],
    ['services/productWriteClient.js', writeClient],
  ]) {
    requireImport({
      source,
      file,
      pattern: /from\s+["'][^"']*api\/localApiClient(?:\.js)?["']/u,
      rule: 'PRODUCT-FE-10',
      evidence: '商品 typed client 必须只通过 localApiClient 进入 local-api。',
      violations,
    });
  }
}

function auditFirstEntry({ sourceById, violations }) {
  const file = 'features/products/model/useProductSyncState.jsx';
  const source = sourceById.get(file);
  if (!source) return;
  const localLoad = findNamedFunctionBody(source, 'loadOzonProducts');
  const firstEntry = findNamedFunctionBody(source, 'ensureProductPageLoaded');
  const manualRefresh = findNamedFunctionBody(source, 'handleRefreshProducts');
  if (!localLoad || !firstEntry || !manualRefresh) {
    addViolation(violations, {
      rule: 'PRODUCT-FE-11',
      kind: 'unprovable-first-entry-boundary',
      file,
      evidence: '无法识别本地加载、首次进入和人工刷新三个独立函数。',
    });
    return;
  }

  if (!/\breadLocalApiProductPage\s*\(/u.test(localLoad.source)) {
    addViolation(violations, {
      rule: 'PRODUCT-FE-11',
      kind: 'first-entry-not-sqlite',
      file,
      evidence: '商品首次加载没有从 typed SQLite page adapter 读取。',
    });
  }
  if (/\b(?:startProductListSync|startProductFullSync|startDomainSync)\s*\(/u.test(localLoad.source)) {
    addViolation(violations, {
      rule: 'PRODUCT-FE-12',
      kind: 'local-load-starts-sync',
      file,
      evidence: '本地读取函数包含同步启动调用。',
    });
  }
  if (!/\bloadOzonProducts\s*\(\s*\{\s*localOnly\s*:\s*true\s*\}/u.test(firstEntry.source)) {
    addViolation(violations, {
      rule: 'PRODUCT-FE-12',
      kind: 'first-entry-not-local-only',
      file,
      evidence: '首次进入没有显式执行 localOnly SQLite 读取。',
    });
  }
  if (/\b(?:startProductListSync|startProductFullSync|startDomainSync|handleRefreshProducts)\s*\(/u.test(firstEntry.source)) {
    addViolation(violations, {
      rule: 'PRODUCT-FE-12',
      kind: 'first-entry-auto-sync',
      file,
      evidence: '首次进入路径触发了商品同步。',
    });
  }
  if (!/\bstartProductListSync\s*\(/u.test(manualRefresh.source)) {
    addViolation(violations, {
      rule: 'PRODUCT-FE-12',
      kind: 'manual-sync-boundary-missing',
      file,
      evidence: '同步启动没有被收口到明确人工刷新函数。',
    });
  }
  for (const effectBody of findReactEffectBodies(source)) {
    if (!/\b(?:startProductListSync|startProductFullSync|startDomainSync|handleRefreshProducts)\s*\(/u.test(effectBody)) {
      continue;
    }
    addViolation(violations, {
      rule: 'PRODUCT-FE-12',
      kind: 'effect-auto-sync',
      file,
      evidence: 'React effect 中出现商品同步/人工刷新调用，打开页面不再是 0 自动同步。',
    });
  }
}

export function auditProductRendererBoundary({ srcRoot, requireTopology = true } = {}) {
  const root = resolve(srcRoot);
  const featureDirectory = resolve(root, PRODUCT_FEATURE_ROOT);
  const featureFiles = listProductionSources(featureDirectory);
  const extraFileIds = [
    ...NORMAL_PRODUCT_CHAIN_FILES,
    'entities/product/productLocalMirror.jsx',
  ];
  const extraFiles = extraFileIds.map((file) => resolve(root, file)).filter(existsSync);
  const files = [...new Set([...featureFiles, ...extraFiles])].sort();
  const sourceById = new Map(
    files.map((filePath) => [toFileId(root, filePath), readFileSync(filePath, 'utf8')]),
  );
  const violations = [];

  for (const [file, source] of sourceById) {
    const featureFile = file.startsWith(`${PRODUCT_FEATURE_ROOT}/`);
    if (file === 'entities/product/productLocalMirror.jsx') continue;
    scanSourceRules({ source, file, featureFile, violations });
  }

  const listAdapter = sourceById.get('entities/product/productLocalMirror.jsx');
  if (listAdapter) {
    for (const functionName of [
      'prefetchLocalApiProductNeighborPages',
      'readProductListInitialSnapshot',
      'readLocalApiProductPage',
    ]) {
      const body = findNamedFunctionBody(listAdapter, functionName);
      if (!body) {
        addViolation(violations, {
          rule: 'PRODUCT-FE-13',
          kind: 'missing-canonical-adapter-symbol',
          file: 'entities/product/productLocalMirror.jsx',
          evidence: `商品正常读取 adapter 缺少 ${functionName}。`,
        });
        continue;
      }
      scanSourceRules({
        source: body.source,
        file: `entities/product/productLocalMirror.jsx#${functionName}`,
        featureFile: true,
        violations,
      });
    }
  }

  auditImportedProductSymbols({ root, featureFiles, violations });

  if (requireTopology) auditTopology({ sourceById, violations });
  if (requireTopology) auditFirstEntry({ sourceById, violations });

  return {
    ok: violations.length === 0,
    sourceRoot: root,
    summary: {
      featureFiles: featureFiles.length,
      normalChainFiles: files.length - featureFiles.length,
      violations: violations.length,
    },
    violations,
  };
}
