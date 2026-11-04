import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../../../test/appSource.js';

const styles = readProjectSource('src/styles.css');

describe('smart tool input style', () => {
  it('uses one small-radius rectangular input system in the page and every smart-tool dialog', () => {
    const unifiedStyleStart = styles.indexOf('/* Smart tools share one restrained input shape');

    expect(unifiedStyleStart).toBeGreaterThan(styles.lastIndexOf('.prompt-library-seerfar-category-field .MuiOutlinedInput-root'));
    expect(styles.slice(unifiedStyleStart)).toContain('--prompt-library-input-height: 34px;');
    expect(styles.slice(unifiedStyleStart)).toContain('--prompt-library-input-radius: 4px;');
    expect(styles.slice(unifiedStyleStart)).toContain('.prompt-library-page,');
    expect(styles.slice(unifiedStyleStart)).toContain('.prompt-library-run-dialog,');
    expect(styles.slice(unifiedStyleStart)).toContain('.prompt-library-category-dialog,');
    expect(styles.slice(unifiedStyleStart)).toContain('.prompt-library-editor-dialog,');
    expect(styles.slice(unifiedStyleStart)).toContain('.prompt-library-simple-editor-dialog,');
    expect(styles.slice(unifiedStyleStart)).toMatch(
      /\.MuiOutlinedInput-root\s*\{[^}]*border-radius:\s*var\(--prompt-library-input-radius\)\s*!important;/su,
    );
    expect(styles.slice(unifiedStyleStart)).toMatch(
      /\.MuiOutlinedInput-root:not\(\.MuiInputBase-multiline\)\s*\{[^}]*height:\s*var\(--prompt-library-input-height\)\s*!important;[^}]*min-height:\s*var\(--prompt-library-input-height\)\s*!important;/su,
    );
  });

  it('keeps multiline editors flexible while giving their outline the same four-pixel corners', () => {
    const unifiedStyles = styles.slice(styles.indexOf('/* Smart tools share one restrained input shape'));

    expect(unifiedStyles).toContain('.MuiOutlinedInput-root fieldset');
    expect(unifiedStyles).toContain('.MuiOutlinedInput-root:not(.MuiInputBase-multiline)');
    expect(unifiedStyles).not.toMatch(/\.MuiOutlinedInput-root\.MuiInputBase-multiline[^}]*height:/su);
  });
});
