import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import pageSource from './ProfitReportPage.jsx?raw';
import appSource from '../../App.jsx?raw';

const globalStyles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

describe('profit report one-screen layout', () => {
  it('never forces the settlement table beyond the shared content shell', () => {
    expect(pageSource).not.toContain('minWidth: 1900');
    expect(pageSource).toContain("overflowX: 'hidden'");
    expect(pageSource).toContain("tableLayout: 'fixed'");
    expect(pageSource).toContain('<colgroup>');
  });

  it('uses the shared compact four-card and aligned toolbar patterns', () => {
    expect(pageSource).toContain("lg: 'repeat(4, minmax(0, 1fr))'");
    expect(pageSource).toContain('className="profit-report-toolbar"');
    expect(pageSource).toContain("height: 40");
    expect(pageSource).toContain('fontVariantNumeric');
  });

  it('uses one compact button to switch between source currency and RMB', () => {
    expect(pageSource).not.toContain('<ButtonGroup');
    expect(pageSource).not.toContain('<ToggleButtonGroup');
    expect(pageSource).toContain("onClick={() => setCurrencyMode((current) => (current === 'source' ? 'cny' : 'source'))}");
    expect(pageSource).toContain("{currencyMode === 'source' ? '原币' : '人民币'}");
    expect(pageSource).toContain("点击切换为${currencyMode === 'source' ? '人民币' : '原币'}");
  });

  it('widens only the profit-report workspace while preserving explicit page boundaries', () => {
    expect(appSource).toContain("currentPage === 'profit-report' ? ' profit-report-content-shell' : ''");
    expect(globalStyles).toMatch(/\.content-shell\.profit-report-content-shell\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*padding:\s*22px 28px 28px;/su);
    expect(globalStyles).toContain('.content-shell.profit-report-content-shell .profit-report-page');
    expect(pageSource).toContain('fontSize: emphasized ? 14 : 13.5');
    expect(pageSource).toContain('fontSize: 27');
  });
});
