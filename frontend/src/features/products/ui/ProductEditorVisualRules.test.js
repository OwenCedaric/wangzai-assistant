import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

describe('商品列表在线商品编辑器视觉规则', () => {
  it('输入框、按钮和标签统一使用小圆角而不是胶囊形', () => {
    expect(styles).toMatch(
      /\.product-editor-modal \.MuiOutlinedInput-root,\s*\.product-editor-modal \.MuiButton-root,\s*\.product-editor-modal \.MuiChip-root\s*\{[^}]*border-radius:\s*6px\s*!important;/su
    );
  });
});
