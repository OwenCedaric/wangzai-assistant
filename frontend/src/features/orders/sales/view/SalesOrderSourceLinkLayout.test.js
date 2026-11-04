import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const stylesSource = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const viewSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'orders', 'sales', 'view', 'SalesOrdersPageView.jsx'),
  'utf8',
);
const productRowsSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'products', 'view', 'ProductTableRows.jsx'),
  'utf8',
);

function readRule(selector) {
  const start = stylesSource.indexOf(`${selector} {`);
  if (start < 0) return '';
  const end = stylesSource.indexOf('}', start);
  return stylesSource.slice(start, end + 1);
}

describe('shared compact source link layout', () => {
  it('renders the source input and save action as one slim aligned control on both lists', () => {
    const rowRule = readRule('.compact-source-link-row');
    const inputRule = readRule(
      '.compact-source-link-input.source-link-dropdown-field .source-link-input-base',
    );
    const buttonRule = readRule('.compact-source-save-button.product-native-button');

    expect(rowRule).toContain('grid-template-columns: minmax(0, 1fr) 46px');
    expect(rowRule).toContain('height: 30px');
    expect(rowRule).toContain('overflow: hidden');
    expect(inputRule).toContain('height: 100%');
    expect(inputRule).toContain('border: 0');
    expect(inputRule).toContain('border-radius: 0');
    expect(buttonRule).toContain('width: 46px');
    expect(buttonRule).toContain('height: 100%');
    expect(buttonRule).toContain('border-radius: 0 !important');
    expect(buttonRule).toContain('transform: none !important');
    expect(viewSource).toContain('sales-source-link-row compact-source-link-row');
    expect(productRowsSource).toContain('product-source-link-row compact-source-link-row');
    expect(productRowsSource).toContain('product-source-list-input compact-source-link-input');
    expect(productRowsSource).toContain('product-source-list-save compact-source-save-button');
  });

  it('extends the sales source control through the shop column while keeping the shop name on top', () => {
    const gridRule = readRule('.sales-order-product-shop-grid');

    expect(viewSource).toContain('<TableCell colSpan={2} className="sales-order-product-shop-cell">');
    expect(viewSource).toContain('className="sales-order-shop-value"');
    expect(gridRule).toContain('"product shop"');
    expect(gridRule).toContain('"source source"');
  });

  it('keeps the table placeholder short enough for the compact combined control', () => {
    expect(viewSource).toContain('placeholder="粘贴货源链接"');
    expect(productRowsSource).toContain('placeholder="粘贴货源链接"');
    expect(viewSource).not.toContain('placeholder="粘贴拼多多 / 1688 / 淘宝 / 天猫链接"');
  });
});
