import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('product Renderer normal-path boundaries', () => {
  const rendererFiles = [
    '../features/products/model/useProductWriteState.jsx',
    '../features/products/model/useProductBatchState.jsx',
    '../features/products/ui/ProductEditDialog.jsx',
    '../features/products/lib/productBusMaterialSync.js',
    '../features/products/lib/productEditing.jsx',
  ];

  it('keeps normal product Renderer files away from direct Ozon transports and endpoint strings', () => {
    for (const file of rendererFiles) {
      const text = source(file);
      expect(text, file).not.toContain('requestOzon');
      expect(text, file).not.toContain('productOzonApi');
      expect(text, file).not.toContain('requestOzonReadOnly');
      expect(text, file).not.toContain('api-seller.ozon.ru');
      expect(text, file).not.toMatch(/['"`]\/v\d+\//);
    }
  });

  it('opens the editor from SQLite and submits only through the typed local-api client', () => {
    const editor = source('../features/products/ui/ProductEditDialog.jsx');
    const writer = source('../features/products/model/useProductWriteState.jsx');
    expect(editor).toContain('readProductEditorContext');
    expect(editor).toContain('humanConfirmed: true');
    expect(writer).toContain('submitProductInfoWrite');
    expect(writer).toContain('submitProductPriceWrite');
    expect(writer).toContain('submitProductStockWrite');
    expect(writer).toContain('isProductWriteReadbackComplete');
    expect(writer).toContain('await saveSupplierProductMaterialProfileCanonical');
  });

  it('does not use browser mirror fallbacks for normal product pagination', () => {
    const pagination = source('../features/products/model/useProductPaginationState.jsx');
    expect(pagination).not.toContain('localMirrorDataset');
    expect(pagination).not.toContain('mergeProductSearchMirrorRows');
    expect(pagination).not.toContain('localProductMirrorRows');
    expect(pagination).not.toContain('localProductSearchRows');
  });

  it('materializes every row in the bounded SQLite page without progressive truncation', () => {
    const pagination = source('../features/products/model/useProductPaginationState.jsx');
    const view = source('../features/products/view/ProductListPageView.jsx');
    const productionSource = `${pagination}\n${view}`;
    expect(productionSource).not.toMatch(
      /ProductTableRowsSpacer|renderProgress|INITIAL_RENDERED_PRODUCT_ROWS|PRODUCT_ROW_RENDER_CHUNK_SIZE|PRODUCT_ROW_RENDER_DELAY_MS|正在加载其余商品|useProgressiveProductRows|progressivePageProducts/u
    );
    expect(productionSource).not.toMatch(/products\s*\.\s*slice\s*\(\s*0\s*,\s*renderedProductCount\s*\)/u);
    expect(view).toContain('products={renderedPageProducts}');
  });

  it('never turns a cross-border material read into an automatic Ozon write', () => {
    const sourceState = source('../features/products/model/useProductSourceMaterialState.jsx');
    const batchState = source('../features/products/model/useProductBatchState.jsx');
    const previewBuilder = source('../features/products/lib/productBusMaterialSync.js');
    expect(sourceState).not.toContain('syncSavedProductBusMaterialToOzon');
    expect(batchState).not.toContain('syncSavedProductBusMaterialToOzon');
    expect(previewBuilder).toContain('humanConfirmed: false');
    expect(previewBuilder).not.toContain('humanConfirmed: true');
    expect(previewBuilder).toContain("status: 'preview-ready'");
  });
});
