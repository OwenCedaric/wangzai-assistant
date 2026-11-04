import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src');

function listProductionSourceFiles(directory = sourceRoot) {
  return readdirSync(directory).flatMap((name) => {
    const file = join(directory, name);
    if (statSync(file).isDirectory()) return listProductionSourceFiles(file);
    if (!/\.(?:js|jsx|ts|tsx)$/u.test(name) || /\.test\.[^.]+$/u.test(name)) return [];
    return [file];
  });
}

describe('internal browser link boundary', () => {
  it('does not allow production UI code to bypass CEF with window.open or target=_blank', () => {
    const offenders = listProductionSourceFiles()
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => /\bwindow\.open\s*\(/u.test(source) || /\btarget\s*(?:=|:)\s*["']_blank["']/u.test(source))
      .map(({ file }) => relative(sourceRoot, file).replaceAll('\\', '/'));

    expect(offenders).toEqual([]);
  });

  it('requires every rendered anchor to call the shared internal browser client', () => {
    const offenders = listProductionSourceFiles()
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => /(?:<a\b|component\s*=\s*["']a["']|component\s*:\s*["']a["'])/u.test(source))
      .filter(({ source }) => !source.includes('openInternalBrowserLinkFromEvent'))
      .map(({ file }) => relative(sourceRoot, file).replaceAll('\\', '/'));

    expect(offenders).toEqual([]);
  });

  it('keeps scripted href assignments limited to explicit local download flows', () => {
    const allowedDownloads = new Set([
      'features/dataBackup/services/historicalOrderSpreadsheetService.js',
      'features/orders/purchase/model/usePurchaseSourceLinkState.jsx',
      'features/profitReport/ProfitReportPage.jsx',
    ]);
    const assignments = listProductionSourceFiles()
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => /\.href\s*=/u.test(source))
      .map(({ file }) => relative(sourceRoot, file).replaceAll('\\', '/'));

    expect(assignments.every((file) => allowedDownloads.has(file))).toBe(true);
    expect(new Set(assignments)).toEqual(allowedDownloads);
  });
});

