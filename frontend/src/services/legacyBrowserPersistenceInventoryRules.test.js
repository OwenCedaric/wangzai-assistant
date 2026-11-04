import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const LEGACY_DIRECT_BROWSER_WRITERS = [];

function listSourceFiles(directory) {
  const root = resolve(projectRoot, directory);
  const files = [];
  for (const entry of readdirSync(root)) {
    const filePath = join(root, entry);
    if (statSync(filePath).isDirectory()) files.push(...listSourceFiles(join(directory, entry)));
    else if (/\.(?:js|jsx)$/u.test(entry) && !/\.test\.(?:js|jsx)$/u.test(entry)) files.push(filePath);
  }
  return files;
}

describe('legacy browser persistence inventory', () => {
  it('prevents new direct browser localStorage writers while the remaining migration sources are explicitly tracked', () => {
    const directWriter = /(?:globalThis|window)\.localStorage\?*\.(?:setItem|removeItem|clear)\(/u;
    const writers = listSourceFiles('src')
      .filter((filePath) => directWriter.test(readFileSync(filePath, 'utf8')))
      .map((filePath) => relative(projectRoot, filePath).replaceAll('\\', '/'))
      .sort();

    expect(writers).toEqual([...LEGACY_DIRECT_BROWSER_WRITERS].sort());
  });

  it('keeps direct browser localStorage reads fully removed from production', () => {
    const directStorageAccess = /(?:globalThis|window)\.localStorage/u;
    const readers = listSourceFiles('src')
      .filter((filePath) => {
        const source = readFileSync(filePath, 'utf8');
        return directStorageAccess.test(source) && /\.getItem\(/u.test(source);
      })
      .map((filePath) => relative(projectRoot, filePath).replaceAll('\\', '/'))
      .sort();

    expect(readers).toEqual([]);
  });
});
