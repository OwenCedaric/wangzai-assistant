import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const mainSource = readFileSync(join(process.cwd(), 'src', 'main.jsx'), 'utf8');
const structuredSettingsSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'settings', 'StructuredSettingsLayout.jsx'),
  'utf8'
);

describe('browser storage write protection rules', () => {
  it('keeps business data from being written back to browser localStorage', () => {
    expect(appSource).not.toMatch(/(?:window\.)?localStorage\.setItem\(/);
    expect(appSource).not.toMatch(/(?:window\.)?localStorage\.removeItem\(/);
    expect(appSource).not.toMatch(/(?:window\.)?localStorage\.clear\(/);
  });

  it('does not introduce IndexedDB, sessionStorage, or WebSQL business storage paths', () => {
    expect(appSource).not.toMatch(/\bindexedDB\b/i);
    expect(appSource).not.toMatch(/\bsessionStorage\b/i);
    expect(appSource).not.toMatch(/\bopenDatabase\b/i);
  });

  it('removes the retired browser localStorage mirror from application bootstrap', () => {
    expect(mainSource).not.toContain('BROWSER_LOCAL_STORAGE_MIRROR_KEYS');
    expect(mainSource).not.toContain('bootstrapBrowserLocalStorageMirror');
    expect(mainSource).not.toContain('browser-local-storage');
  });

  it('does not keep a dormant local-data fetch path in main bootstrap', () => {
    expect(mainSource).not.toContain("import { safeWarn } from './services/safeLog.js';");
    expect(mainSource).not.toContain("'/local-data-api'");
    expect(mainSource).not.toContain('console.warn');
  });

  it('never persists Performance client_secret into browser localStorage', () => {
    expect(structuredSettingsSource).toContain("performanceClientSecret: ''");
    expect(structuredSettingsSource).toContain('savePerformanceAccount');
    expect(structuredSettingsSource).not.toMatch(/(?:window|globalThis)\.localStorage/u);
    expect(structuredSettingsSource).not.toContain('readLegacyBrowserValue');
    expect(structuredSettingsSource).not.toContain('JSON.stringify(records)');
  });
});
