import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInitialProductDataReady } from './ProductListPageView.jsx';
import viewSource from './ProductListPageView.jsx?raw';
import paginationSource from '../model/useProductPaginationState.jsx?raw';

const stylesSource = readFileSync(
  join(process.cwd(), 'src', 'styles.css'),
  'utf8'
);

describe('isInitialProductDataReady', () => {
  it('requires the complete bounded SQLite page before marking the visual page ready', () => {
    expect(isInitialProductDataReady({ totalRows: 1000, renderedRows: 20 })).toBe(true);
    expect(isInitialProductDataReady({ totalRows: 1000, renderedRows: 8 })).toBe(false);
    expect(isInitialProductDataReady({ totalRows: 12, renderedRows: 12 })).toBe(true);
    expect(isInitialProductDataReady({ totalRows: 50, renderedRows: 50, pageSize: 50 })).toBe(true);
    expect(isInitialProductDataReady({ totalRows: 0, renderedRows: 20 })).toBe(false);
    expect(isInitialProductDataReady({ totalRows: 1000, renderedRows: 0 })).toBe(false);
    expect(
      isInitialProductDataReady({
        totalRows: 1000,
        loading: false,
        productTablePageBusy: false,
        productLoadError: '本地查询失败',
      })
    ).toBe(false);
  });
});

describe('product list loading presentation', () => {
  it('uses the bounded progress panel without inserting placeholder table rows', () => {
    expect(viewSource).toContain('<ReadProgressPanel');
    expect(viewSource).not.toContain('ProductListLoadingRows');
  });

  it('never truncates or progressively materializes a canonical SQLite page', () => {
    const productionSource = `${paginationSource}\n${viewSource}`;
    expect(productionSource).not.toMatch(
      /ProductTableRowsSpacer|renderProgress|INITIAL_RENDERED_PRODUCT_ROWS|PRODUCT_ROW_RENDER_CHUNK_SIZE|PRODUCT_ROW_RENDER_DELAY_MS|正在加载其余商品|useProgressiveProductRows|progressivePageProducts/u
    );
    expect(productionSource).not.toMatch(
      /products\s*\.\s*slice\s*\(\s*0\s*,\s*renderedProductCount\s*\)/u
    );
    expect(viewSource).toContain('products={renderedPageProducts}');
  });
});

describe('product list bounded layout', () => {
  it('keeps fixed columns and skips only safe off-screen cell subtrees', () => {
    expect(stylesSource).toMatch(/\.product-list-table\s*\{[\s\S]*?table-layout:\s*fixed;/u);
    expect(stylesSource).toMatch(
      /\.product-list-table \.product-list-thumb,[\s\S]*?\.product-list-table \.product-row-actions\s*\{\s*content-visibility:\s*auto;/u
    );
    expect(stylesSource).toMatch(
      /\.product-list-table \.product-row-actions\s*\{\s*contain-intrinsic-block-size:\s*auto 90px;/u
    );
    expect(stylesSource).not.toMatch(/\.product-list-table \.product-native-row\s*\{[^}]*content-visibility/u);
  });
});
