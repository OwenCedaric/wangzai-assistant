import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../test/appSource';

describe('interaction cursor rules', () => {
  it('keeps clickable controls and their icons using the pointer cursor', () => {
    const styles = readProjectSource('src/styles.css');

    expect(styles).toContain('button:not(:disabled),');
    expect(styles).toContain("[role='button']:not([aria-disabled='true']),");
    expect(styles).toContain('.MuiButtonBase-root:not(.Mui-disabled),');
    expect(styles).toContain('.MuiIconButton-root:not(.Mui-disabled)');
    expect(styles).toContain('button:not(:disabled) .MuiSvgIcon-root,');
    expect(styles).toContain('.MuiIconButton-root:not(.Mui-disabled) .MuiSvgIcon-root');
    expect(styles).toContain('cursor: pointer;');
    expect(styles).toContain('.MuiIconButton-root.Mui-disabled {\n  cursor: default;');
  });
});
