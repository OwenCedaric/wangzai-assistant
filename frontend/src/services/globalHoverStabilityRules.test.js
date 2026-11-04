import { describe, expect, it } from 'vitest';

import { readProjectSource } from '../test/appSource.js';

describe('global hover stability rules', () => {
  it('keeps semantic interactive hit areas stationary across every page', () => {
    const styles = readProjectSource('src/styles.css');
    const main = readProjectSource('src/main.jsx');

    expect(main).toContain("import './styles.css';");
    expect(styles).toContain('全局交互控件 hover 稳定性');
    expect(styles).toMatch(
      /:where\(\s*button,\s*\[role='button'\],[\s\S]*?\.status-observation-category-item\s*\)\s*\{\s*transform:\s*none\s*!important;\s*filter:\s*none\s*!important;/u
    );
    expect(styles).not.toMatch(
      /:where\([\s\S]{0,500}(?:button|MuiButtonBase-root)[\s\S]{0,500}:hover\s*\{[^}]*transform:\s*translateY/gu
    );
  });

  it('does not paint the default gray rectangle on inherit buttons', () => {
    const styles = readProjectSource('src/styles.css');

    expect(styles).toContain('.MuiButton-outlinedInherit:not(.Mui-disabled):hover');
    expect(styles).toContain('background-color: transparent !important;');
  });
});
