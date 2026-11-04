import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditArchitecture } from './architecture-guard-core.mjs';
import { auditProductRendererBoundary } from './product-boundary-guard-core.mjs';

function withFixture(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-architecture-guard-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = join(root, relativePath);
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, content, 'utf8');
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('architecture guard rejects production import cycles', () => {
  withFixture(
    {
      'entities/a.js': "import './b.js'; export const a = 1;\n",
      'entities/b.js': "import './a.js'; export const b = 1;\n",
    },
    (srcRoot) => {
      const report = auditArchitecture({ srcRoot });
      assert.equal(report.ok, false);
      assert.equal(report.summary.importCycles, 1);
      assert.equal(report.violations[0].kind, 'import-cycle');
    }
  );
});

test('architecture guard allows documented direct fetch baseline but blocks a new one', () => {
  withFixture(
    {
      'features/example.js': 'fetch("/legacy");\nfetch("/new");\n',
    },
    (srcRoot) => {
      const report = auditArchitecture({
        srcRoot,
        baseline: { directFetchByFile: { 'features/example.js': 1 } },
      });
      assert.equal(report.ok, false);
      assert.equal(report.violations[0].kind, 'feature-direct-fetch');
    }
  );
});

function validProductBoundaryFixture(overrides = {}) {
  return {
    'features/products/ProductListPage.jsx':
      "import ProductListPageImpl from './ProductListWorkspace.jsx'; export default ProductListPageImpl;\n",
    'features/products/ProductListWorkspace.jsx':
      "import { useProductListPageModel } from './model/useProductListPageModel.jsx'; import { ProductListPageView } from './view/ProductListPageView.jsx'; export function ProductListWorkspace(props) { return ProductListPageView({ model: useProductListPageModel(props) }); }\n",
    'features/products/view/ProductListPageView.jsx':
      'export function ProductListPageView() { return null; }\n',
    'features/products/model/useProductListPageModel.jsx':
      "import { useProductSyncState } from './useProductSyncState.jsx'; export function useProductListPageModel() { return useProductSyncState(); }\n",
    'features/products/model/useProductSyncState.jsx': `
      import { readLocalApiProductPage } from '../../../entities/product/productLocalMirror.jsx';
      import { startProductListSync } from '../../../services/productListSyncClient.js';
      const loadOzonProducts = async () => { await readLocalApiProductPage(); };
      const ensureProductPageLoaded = async () => { await loadOzonProducts({ localOnly: true }); };
      const handleRefreshProducts = async () => { await startProductListSync({ shopId: 'shop-1' }); };
      export function useProductSyncState() {
        React.useEffect(() => { ensureProductPageLoaded(); }, []);
        return { loadOzonProducts, handleRefreshProducts };
      }
    `,
    'features/products/model/useProductWriteState.jsx':
      "import { submitProductInfoWrite } from '../../../services/productModuleClient.js'; export function useProductWriteState() { return submitProductInfoWrite; }\n",
    'entities/product/productLocalMirror.jsx': `
      import { readProductListCache } from '../../services/productListSyncClient.js';
      export function prefetchLocalApiProductNeighborPages() { return readProductListCache(); }
      export function readProductListInitialSnapshot() { return { rows: [] }; }
      export async function readLocalApiProductPage() { return readProductListCache(); }
    `,
    'entities/product/productListQuery.jsx': 'export function normalizeProductListQueryFilters(value) { return value; }\n',
    'services/productListSyncClient.js': `
      import { getDomainCache, startDomainSync } from '../api/localApiClient.js';
      export const readProductListCache = (query) => getDomainCache('products', query);
      export const startProductListSync = (payload) => startDomainSync('products', payload);
    `,
    'services/productModuleClient.js':
      "import { requestLocalApi } from '../api/localApiClient.js'; export * from './productReadClient.js'; export * from './productWriteClient.js'; export const submitProductInfoWrite = requestLocalApi;\n",
    'services/productReadClient.js':
      "import { getDomainCache } from '../api/localApiClient.js'; export const readProduct = () => getDomainCache('products');\n",
    'services/productWriteClient.js':
      "import { confirmDomainWrite } from '../api/localApiClient.js'; export const confirmProductWrite = confirmDomainWrite;\n",
    'api/localApiClient.js':
      'export const getDomainCache = () => ({}); export const startDomainSync = () => ({}); export const requestLocalApi = () => ({}); export const confirmDomainWrite = () => ({});\n',
    ...overrides,
  };
}

test('product boundary guard accepts the canonical Page to local-api topology', () => {
  withFixture(validProductBoundaryFixture(), (srcRoot) => {
    const report = auditProductRendererBoundary({ srcRoot });
    assert.equal(report.ok, true, JSON.stringify(report.violations, null, 2));
  });
});

test('product boundary guard scans the real product runtime', () => {
  const srcRoot = join(import.meta.dirname, '..', 'src');
  const report = auditProductRendererBoundary({ srcRoot });
  assert.equal(report.ok, true, JSON.stringify(report.violations, null, 2));
  assert.ok(report.summary.featureFiles >= 20);
});

test('product boundary guard rejects each forbidden Renderer persistence/transport vector', () => {
  const forbiddenVectors = [
    ['direct-fetch', 'export const leak = () => fetch("https://example.invalid");'],
    ['direct-ozon-request', 'export const leak = () => requestOzonReadOnly();'],
    ['ozon-endpoint', 'export const leak = "/v3/product/list";'],
    ['renderer-sql', 'export const leak = db.prepare("SELECT * FROM products");'],
    ['browser-storage', 'export const leak = localStorage.getItem("products");'],
    ['json-local-mirror', 'export const leak = JSON.stringify({ products: [] });'],
    [
      'forbidden-product-fallback-import',
      "import { read } from '../../../services/productSearchFallbackService.js'; export const leak = read;",
    ],
    [
      'feature-bypasses-typed-client',
      "import { requestLocalApi } from '../../../api/localApiClient.js'; export const leak = requestLocalApi;",
    ],
  ];
  for (const [expectedKind, injectedSource] of forbiddenVectors) {
    withFixture(
      validProductBoundaryFixture({
        'features/products/model/ForbiddenVector.jsx': `${injectedSource}\n`,
      }),
      (srcRoot) => {
        const report = auditProductRendererBoundary({ srcRoot });
        assert.equal(report.ok, false, expectedKind);
        assert.ok(report.violations.some((violation) => violation.kind === expectedKind), expectedKind);
      }
    );
  }
});

test('product boundary guard rejects an implicit first-entry sync', () => {
  withFixture(
    validProductBoundaryFixture({
      'features/products/model/useProductSyncState.jsx': `
        import { readLocalApiProductPage } from '../../../entities/product/productLocalMirror.jsx';
        import { startProductListSync } from '../../../services/productListSyncClient.js';
        const loadOzonProducts = async () => { await readLocalApiProductPage(); };
        const ensureProductPageLoaded = async () => {
          await loadOzonProducts({ localOnly: true });
          await startProductListSync({ shopId: 'shop-1' });
        };
        const handleRefreshProducts = async () => { await startProductListSync({ shopId: 'shop-1' }); };
        export function useProductSyncState() {
          React.useEffect(() => { ensureProductPageLoaded(); }, []);
          return { loadOzonProducts, handleRefreshProducts };
        }
      `,
    }),
    (srcRoot) => {
      const report = auditProductRendererBoundary({ srcRoot });
      assert.equal(report.ok, false);
      assert.ok(report.violations.some((violation) => violation.kind === 'first-entry-auto-sync'));
    }
  );
});

test('product boundary guard follows imported product symbols instead of scanning only feature text', () => {
  withFixture(
    validProductBoundaryFixture({
      'features/products/model/IndirectLeak.jsx':
        "import { loadRows } from '../../../entities/product/unsafeAdapter.jsx'; export const indirectLeak = loadRows;\n",
      'entities/product/unsafeAdapter.jsx':
        'export async function loadRows() { return fetch("https://example.invalid/products"); }\n',
    }),
    (srcRoot) => {
      const report = auditProductRendererBoundary({ srcRoot });
      assert.equal(report.ok, false);
      assert.ok(
        report.violations.some(
          (violation) =>
            violation.kind === 'direct-fetch' &&
            violation.file === 'entities/product/unsafeAdapter.jsx#loadRows'
        )
      );
    }
  );
});
