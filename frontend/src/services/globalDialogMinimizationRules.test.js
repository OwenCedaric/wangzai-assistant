import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function listProductionFiles(relativeDir) {
  const absoluteDir = join(process.cwd(), relativeDir);
  return readdirSync(absoluteDir).sort().flatMap((entry) => {
    const relativePath = `${relativeDir}/${entry}`;
    const absolutePath = join(process.cwd(), relativePath);
    if (statSync(absolutePath).isDirectory()) return listProductionFiles(relativePath);
    if (!/\.(js|jsx)$/.test(entry) || /\.(?:test|spec)\.(js|jsx)$/.test(entry)) return [];
    return [relativePath];
  });
}

describe('global dialog minimization coverage', () => {
  it('routes every feature Dialog through the global wrapper or an audited dedicated implementation', () => {
    const dialogFiles = listProductionFiles('src/features').filter((relativePath) =>
      /<Dialog(?:\s|>)/.test(readFileSync(join(process.cwd(), relativePath), 'utf8'))
    );
    const uncovered = dialogFiles.filter((relativePath) => {
      const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
      const usesRawMuiDialog = source.includes("from '@mui/material/Dialog'");
      const hasDedicatedMinimize = source.includes('MinimizableDialogTitle') && source.includes('onMinimize');
      const usesGlobalDialog = source.includes('GlobalMinimizableDialog.jsx');
      return !usesGlobalDialog && !(usesRawMuiDialog && hasDedicatedMinimize);
    });

    expect(dialogFiles.length).toBeGreaterThanOrEqual(25);
    expect(uncovered).toEqual([]);
  });

  it('keeps the custom shop settings surface on the same minimized-task runtime', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/features/settings/ShopSettingsDialog.jsx'),
      'utf8'
    );

    expect(source).toContain('useMinimizableDialogTask');
    expect(source).toContain('settingsDialogTask.visibleOpen');
    expect(source).toContain('最小化店铺管理弹窗');
  });

  it('defines one borderless action style for both title-bar controls', () => {
    const styles = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8');
    expect(styles).toContain('.global-dialog-control.MuiIconButton-root');
    expect(styles).toContain('border: 0 !important;');
    expect(styles).toContain('.global-dialog-action-bar');
  });
});
