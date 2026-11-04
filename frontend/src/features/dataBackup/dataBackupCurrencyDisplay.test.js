import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function productionSources(relativeDir) {
  const absoluteDir = join(process.cwd(), relativeDir);
  return readdirSync(absoluteDir).flatMap((entry) => {
    const relativePath = `${relativeDir}/${entry}`;
    const absolutePath = join(process.cwd(), relativePath);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) return productionSources(relativePath);
    if (!/\.(js|jsx)$/u.test(entry) || /\.(?:test|spec)\.(js|jsx)$/u.test(entry)) return [];
    return [relativePath];
  });
}

describe('data backup currency display boundary', () => {
  it('does not render a raw RUB symbol or code from the backup module', () => {
    const source = productionSources('src/features/dataBackup')
      .map((file) => readFileSync(join(process.cwd(), file), 'utf8'))
      .join('\n');
    expect(source).not.toContain('₽');
    expect(source).not.toMatch(/\bRUB\b/u);
  });
});
