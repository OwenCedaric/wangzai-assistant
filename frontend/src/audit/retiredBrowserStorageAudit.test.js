import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RETIRED_BROWSER_STORAGE_AUDIT } from './retiredBrowserStorageAudit.js';

describe('retired browser storage audit', () => {
  it('keeps only static resource evidence and has no browser-storage execution', () => {
    expect(RETIRED_BROWSER_STORAGE_AUDIT.state).toBe('removed-no-runtime-state');
    expect(Object.keys(RETIRED_BROWSER_STORAGE_AUDIT)).toHaveLength(10);
    const source = readFileSync(join(process.cwd(), 'src', 'audit', 'retiredBrowserStorageAudit.js'), 'utf8');
    expect(source).not.toContain('window.localStorage');
    expect(source).not.toContain('.getItem(');
    expect(source).not.toContain('.setItem(');
    expect(source).not.toContain('.removeItem(');
    expect(source).not.toContain('new Set(');
  });
});
