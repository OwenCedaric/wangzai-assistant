import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createProductRepository } from "../src/db/repositories/productRepository.js";
import { createProductsService } from "../src/domain/products/productsService.js";
import { createMigratedTestDb } from "./testDb.js";

function read(relativeUrl) {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");
}

function currentProductArchitectureSources() {
  return {
    createApp: read("../src/app/createApp.js"),
    repositoryFacade: read("../src/db/repositories/productRepository.js"),
    serviceFacade: read("../src/domain/products/productsService.js"),
    canonicalQuery: read(
      "../src/db/repositories/productCanonicalQueryRepository.js",
    ),
    canonicalReadService: read(
      "../src/domain/products/productCanonicalReadService.js",
    ),
  };
}

function auditProductBackendBoundary(sources, { maxFacadeLines = 100 } = {}) {
  const violations = [];
  const add = (kind, file, evidence) => {
    violations.push({ kind, file, evidence });
  };
  const required = [
    "createApp",
    "repositoryFacade",
    "serviceFacade",
    "canonicalQuery",
    "canonicalReadService",
  ];
  for (const key of required) {
    if (typeof sources[key] === "string") continue;
    add("missing-source", key, "架构 guard 缺少必需源码。");
  }
  if (violations.length > 0) return { ok: false, violations };

  const productEndpoint =
    /["']\/api\/(?:products(?:[/?"']|$)|(?:cache|sync|write)\/products(?:[/?"']|$))/u;
  if (productEndpoint.test(sources.createApp)) {
    add(
      "create-app-product-endpoint",
      "src/app/createApp.js",
      "createApp 重新拼装了商品 endpoint，而不是只装配 productsRoutes。",
    );
  }
  for (const [pattern, evidence] of [
    [/import\s+\{\s*createProductsRoutes\s*\}/u, "createApp 未导入商品领域路由。"],
    [/createProductsRoutes\s*\(/u, "createApp 未实例化商品领域路由。"],
    [/productsRoutes\.handleRequest\s*\(/u, "createApp 未把请求交给商品领域路由。"],
  ]) {
    if (pattern.test(sources.createApp)) continue;
    add("missing-products-route-composition", "src/app/createApp.js", evidence);
  }

  for (const [file, source] of [
    ["src/db/repositories/productRepository.js", sources.repositoryFacade],
    ["src/domain/products/productsService.js", sources.serviceFacade],
  ]) {
    const lines = source.split(/\r?\n/u).length;
    if (lines > maxFacadeLines) {
      add(
        "oversized-product-facade",
        file,
        `商品公开 facade 为 ${lines} 行，超过 ${maxFacadeLines} 行上限。`,
      );
    }
    if (
      /["'`]\s*(?:SELECT\s+[\s\S]{0,160}?\s+FROM|INSERT\s+INTO|UPDATE\s+[A-Za-z_][A-Za-z0-9_]*\s+SET|DELETE\s+FROM)/iu.test(
        source,
      ) ||
      /(?<![\w$.])fetch\s*\(/u.test(source) ||
      productEndpoint.test(source)
    ) {
      add(
        "facade-contains-implementation",
        file,
        "商品公开 facade 出现 SQL、fetch 或 endpoint 实现。",
      );
    }
  }

  for (const [file, source] of [
    [
      "src/db/repositories/productCanonicalQueryRepository.js",
      sources.canonicalQuery,
    ],
    [
      "src/domain/products/productCanonicalReadService.js",
      sources.canonicalReadService,
    ],
  ]) {
    if (
      /from\s+["'][^"']*productLegacyMigration[^"']*["']/iu.test(source) ||
      /\bimportLegacy[A-Za-z0-9_]*\b/u.test(source)
    ) {
      add(
        "canonical-read-imports-legacy",
        file,
        "正常 canonical read 重新依赖 legacy migration。",
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

test("product public entries are thin acyclic composition facades", () => {
  const repositoryFacade = read("../src/db/repositories/productRepository.js");
  const serviceFacade = read("../src/domain/products/productsService.js");
  const canonicalQuery = read(
    "../src/db/repositories/productCanonicalQueryRepository.js",
  );
  const supportRepository = read(
    "../src/db/repositories/productSupportRepository.js",
  );
  const stagingRepository = read(
    "../src/db/repositories/productSyncStagingRepository.js",
  );
  const legacyRepository = read(
    "../src/db/repositories/productLegacyMigrationRepository.js",
  );
  const syncService = read("../src/domain/products/productSyncService.js");
  const supportService = read("../src/domain/products/productSupportService.js");
  const legacyService = read(
    "../src/domain/products/productLegacyMigrationService.js",
  );

  assert.ok(repositoryFacade.split(/\r?\n/u).length <= 100);
  assert.ok(serviceFacade.split(/\r?\n/u).length <= 100);
  assert.doesNotMatch(repositoryFacade, /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/iu);
  assert.doesNotMatch(serviceFacade, /\b(?:SELECT|INSERT|UPDATE|DELETE|fetch)\b/iu);

  for (const implementation of [
    canonicalQuery,
    supportRepository,
    stagingRepository,
    legacyRepository,
  ]) {
    assert.doesNotMatch(implementation, /from\s+["']\.\/productRepository\.js["']/u);
  }
  for (const implementation of [syncService, supportService, legacyService]) {
    assert.doesNotMatch(implementation, /from\s+["']\.\/productsService\.js["']/u);
  }

  assert.match(canonicalQuery, /FROM canonical_source/u);
  assert.match(canonicalQuery, /product_warehouse_stock_facts/u);
  assert.match(canonicalQuery, /product_material_profiles/u);
  assert.match(canonicalQuery, /product_source_links/u);
  assert.doesNotMatch(canonicalQuery, /importLegacy/u);
  assert.match(stagingRepository, /recordProductHydrationFacetObservations/u);
  assert.match(stagingRepository, /getProductHydrationCoverage/u);
  assert.match(legacyRepository, /importLegacyProductMaterialProfiles/u);
  assert.match(legacyService, /cursorMode/u);

  const boundaryReport = auditProductBackendBoundary(
    currentProductArchitectureSources(),
  );
  assert.equal(
    boundaryReport.ok,
    true,
    JSON.stringify(boundaryReport.violations, null, 2),
  );
});

test("product backend architecture guard has executable negative fixtures", () => {
  const valid = {
    createApp: `
      import { createProductsRoutes } from "../domain/products/productsRoutes.js";
      const productsRoutes = createProductsRoutes({ service });
      productsRoutes.handleRequest({ req, res, requestUrl });
    `,
    repositoryFacade:
      'import { createCanonical } from "./canonical.js"; export const createProductRepository = createCanonical;\n',
    serviceFacade:
      'import { createCanonicalRead } from "./canonicalRead.js"; export const createProductsService = createCanonicalRead;\n',
    canonicalQuery: 'export const listProducts = () => [];\n',
    canonicalReadService: 'export const readCache = () => [];\n',
  };
  assert.equal(auditProductBackendBoundary(valid).ok, true);

  const endpointReport = auditProductBackendBoundary({
    ...valid,
    createApp: `${valid.createApp}\nif (pathname === "/api/products/material") return true;`,
  });
  assert.equal(endpointReport.ok, false);
  assert.ok(
    endpointReport.violations.some(
      (violation) => violation.kind === "create-app-product-endpoint",
    ),
  );

  const facadeReport = auditProductBackendBoundary({
    ...valid,
    serviceFacade: Array.from({ length: 101 }, () => "export {};").join("\n"),
  });
  assert.equal(facadeReport.ok, false);
  assert.ok(
    facadeReport.violations.some(
      (violation) => violation.kind === "oversized-product-facade",
    ),
  );

  const legacyReport = auditProductBackendBoundary({
    ...valid,
    canonicalReadService:
      'import { importLegacyRows } from "./productLegacyMigrationService.js"; export const readCache = importLegacyRows;\n',
  });
  assert.equal(legacyReport.ok, false);
  assert.ok(
    legacyReport.violations.some(
      (violation) => violation.kind === "canonical-read-imports-legacy",
    ),
  );
});

test("composed product repository and service preserve their public surfaces", () => {
  const db = createMigratedTestDb();
  const repository = createProductRepository(db);
  assert.deepEqual(Object.keys(repository), [
    "upsertProducts",
    "mergeProductInfoRows",
    "mergeProductPictureRows",
    "mergeProductPriceRows",
    "mergeProductStockRows",
    "mergeProductWarehouseStockRows",
    "recordProductWarehouseStockObservations",
    "mergeProductAttributeRows",
    "reconcileVisibilitySnapshot",
    "recordProductHydrationFacetObservations",
    "markProductHydrationFacetChecked",
    "getProductHydrationCoverage",
    "listProducts",
    "listWarehousePickerProducts",
    "getProductsByIds",
    "resolveOfferIdsForProducts",
    "resolveProductModelNamesForOffers",
    "listSkuFamily",
    "upsertProductMaterialProfile",
    "importLegacyProductMaterialProfiles",
    "listProductMaterialProfiles",
    "listProductMaterialProfilesPage",
    "upsertProductSourceLinks",
    "importLegacyProductSourceLinks",
    "listProductSourceLinks",
    "listProductSourceLinksPage",
    "upsertProductImageHealth",
  ]);

  const service = createProductsService({ db });
  assert.deepEqual(Object.keys(service), [
    "domain",
    "readCache",
    "startSync",
    "runProductsSyncJob",
    "readSummary",
    "readSkuFamily",
    "hydrateSummary",
    "refreshProductsByRefs",
    "cleanupProductCache",
    "readSupport",
    "listMaterialProfiles",
    "saveMaterialProfile",
    "importLegacyMaterialProfiles",
    "saveSourceLinks",
    "listSourceLinks",
    "importLegacySourceLinks",
    "saveImageHealth",
    "executeConfirmedWrite",
    "countOwnerHotCache",
    "invalidateOwnerHotCache",
  ]);
  db.close();
});
