import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const scanScriptSource = readFileSync(join(process.cwd(), 'scripts', 'scan-secrets.mjs'), 'utf8');

describe('security scan rules', () => {
  it('allows explicit file scans to inspect normally skipped local data diagnostics', () => {
    expect(scanScriptSource).toContain('function scanFiles(root, files, options = {})');
    expect(scanScriptSource).toContain('if (!options.includeSkipped && isSkipped(relativePath)) continue;');
    expect(scanScriptSource).toContain('scanFiles(root, files, { includeSkipped: args.files.length > 0 })');
  });
});
