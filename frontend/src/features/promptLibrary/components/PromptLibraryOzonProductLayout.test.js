import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../../../test/appSource.js';

const styles = readProjectSource('src/styles.css');
const component = readProjectSource('src/features/promptLibrary/components/PromptLibraryOzonProductResult.jsx');

describe('Ozon product search layout', () => {
  it('keeps all seven summary cards on one grid row at every breakpoint', () => {
    expect(styles).toMatch(/\.prompt-library-ozon-summary-grid\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/su);
    expect(styles.match(/\.prompt-library-ozon-summary-grid/gu)).toHaveLength(1);
  });

  it('styles product titles as an internal workbench action instead of a raw page link', () => {
    expect(styles).toContain('.prompt-library-ozon-product-link');
  });

  it('removes the coverage chip region and groups named metrics into four full-width sections', () => {
    expect(component).not.toContain('字段完整度');
    expect(styles).not.toContain('.prompt-library-ozon-coverage-row');
    expect(component).toContain('colSpan={primaryColumnCount}');
    expect(component).toContain('title="广告与促销"');
    expect(component).toContain("label: '商品卡浏览量'");
    expect(component).toContain("label: '退货取消率'");
    expect(component).toContain("label: '跟卖最低价'");
    expect(styles).toMatch(/\.prompt-library-ozon-expanded-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/su);
    expect(styles).toContain('.prompt-library-ozon-core-metrics');
  });

  it('uses a restrained table surface instead of colored metric tiles', () => {
    expect(styles).not.toContain('--ozon-expanded-soft');
    expect(styles).not.toContain('.prompt-library-ozon-expanded-section.is-violet');
    expect(styles).toMatch(/\.prompt-library-ozon-expanded-grid\s*\{[^}]*gap:\s*0;[^}]*border:\s*1px solid #e2e6ec/su);
    expect(styles).toMatch(/\.prompt-library-ozon-expanded-value dt\s*\{[^}]*font-size:\s*12px/su);
    expect(styles).toMatch(/\.prompt-library-ozon-expanded-value dd\s*\{[^}]*font-size:\s*12px/su);
  });

  it('prevents narrow price cells from overlapping labels and values', () => {
    expect(styles).toMatch(/\.prompt-library-ozon-core-metrics:not\(\.is-taxonomy\) \.prompt-library-ozon-core-metric\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);
    expect(styles).toMatch(/\.prompt-library-ozon-product-row > \.MuiTableCell-root:nth-child\(3\)\s*\{\s*width:\s*14%/su);
  });

  it('keeps numeric headers, labels, and values on the same right baseline', () => {
    expect(component).toContain('label="价格"');
    expect(component).toContain('label="销售"');
    expect(component).toContain('label="销售额"');
    expect(component).toContain('label="库存与口碑"');
    expect(component).toMatch(/label="价格"[^>]*align="right"/su);
    expect(component).toMatch(/label="销售"[^>]*align="right"/su);
    expect(component).toMatch(/label="销售额"[^>]*align="right"/su);
    expect(component).toMatch(/label="库存与口碑"[^>]*align="right"/su);
    expect(styles).toMatch(/\.prompt-library-ozon-core-metrics:not\(\.is-taxonomy\) \.prompt-library-ozon-core-metric dt\s*\{[^}]*text-align:\s*right/su);
  });

  it('keeps the decision rules in one structured panel without changing the product table', () => {
    expect(component).toContain('选品决策');
    expect(component).toContain('选品参考分');
    expect(component).toContain('opportunity.breakdown');
    expect(styles).toMatch(/\.prompt-library-ozon-decision-main\s*\{[^}]*grid-template-columns:\s*minmax\(180px,\s*0\.62fr\) repeat\(2,\s*minmax\(0,\s*1fr\)\)/su);
    expect(styles).toMatch(/\.prompt-library-ozon-decision-dimensions\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/su);
    expect(component).toContain('prompt-library-ozon-table-wrap');
  });

  it('keeps the seven-column geometry while giving descriptions enough vertical room', () => {
    expect(styles).toMatch(/\.prompt-library-ozon-decision-signal \.MuiTypography-subtitle2\s*\{[^}]*font-size:\s*12\.5px[^}]*line-height:\s*16px/su);
    expect(styles).toMatch(/\.prompt-library-ozon-decision-signal \.MuiTypography-body2,[^{]+\{[^}]*font-size:\s*11\.5px[^}]*line-height:\s*16px[^}]*max-height:\s*32px/su);
    expect(styles).toMatch(/\.prompt-library-ozon-decision-dimension-head \.MuiTypography-caption\s*\{[^}]*font-size:\s*11\.5px/su);
    expect(styles).toMatch(/\.prompt-library-ozon-summary-card\s*\{[^}]*min-height:\s*96px/su);
    expect(styles).toMatch(/\.prompt-library-ozon-summary-hint\s*\{[^}]*min-height:\s*28px[^}]*white-space:\s*normal/su);
    expect(styles).toMatch(/\.prompt-library-ozon-decision-dimension > \.MuiTypography-body2\s*\{[^}]*min-height:\s*30px[^}]*font-size:\s*11px[^}]*white-space:\s*normal/su);
    expect(styles).toMatch(/\.prompt-library-ozon-decision-main\s*\{[^}]*grid-template-columns:\s*minmax\(180px,\s*0\.62fr\) repeat\(2,\s*minmax\(0,\s*1fr\)\)/su);
    expect(styles).toMatch(/\.prompt-library-ozon-decision-dimensions\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/su);
    expect(component).not.toContain('prompt-library-ozon-decision-profit-note');
    expect(styles).not.toContain('.prompt-library-ozon-decision-profit-note');
    expect(component).not.toContain('仅分析真实返回字段');
    expect(styles).not.toContain('.prompt-library-ozon-truth-chip');
  });

  it('keeps the link input rail compact and renders parsed product facts on the right', () => {
    expect(styles).toMatch(/\.prompt-library-run-dialog\.is-ozon-product-analysis \.prompt-library-standard-run-shell\s*\{[^}]*grid-template-columns:\s*320px minmax\(0,\s*1fr\)/su);
    expect(styles).toMatch(/\.prompt-library-run-dialog\.is-ozon-product-analysis \.prompt-library-standard-fixed-sidebar\s*\{[^}]*overflow:\s*hidden/su);
    expect(styles).toMatch(/\.prompt-library-run-dialog\.is-ozon-product-analysis \.prompt-library-image-fixed-section \.MuiOutlinedInput-root,[^{]+\{[^}]*border-radius:\s*5px/su);
    expect(component).toContain('prompt-library-ozon-target-product');
    expect(component).toContain('预估佣金');
    expect(component).toContain('预估平台费用');
  });
});
