import pageViewSource from './view/PurchaseOrdersPageView.jsx?raw';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const stylesSource = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

describe('拍单管理批量按钮区视觉规则', () => {
  it('keeps every purchase action in the same compact row as sales orders', () => {
    expect(pageViewSource).toContain('className="purchase-order-selection-actions"');
    expect(pageViewSource).toContain('只渲染当前页，打开更快');
    expect(pageViewSource).toContain('批量回查巴士');
    expect(pageViewSource).toContain('批量取消');
  });

  it('uses compact auto-width buttons and never wraps the action row', () => {
    const buttonRule = stylesSource.match(
      /\.purchase-order-selection-bar \.MuiButton-root\s*\{(?<body>[^}]*)\}/u,
    )?.groups?.body || '';
    expect(stylesSource).toMatch(/\.purchase-order-selection-bar\s*\{[\s\S]*?flex-wrap:\s*nowrap;/u);
    expect(stylesSource).toMatch(/\.purchase-order-selection-bar > \.MuiStack-root\s*\{[\s\S]*?flex-wrap:\s*nowrap;/u);
    expect(buttonRule).toMatch(/width:\s*auto;/u);
    expect(buttonRule).toMatch(/height:\s*30px;/u);
    expect(buttonRule).not.toMatch(/width:\s*112px;/u);
  });
});
