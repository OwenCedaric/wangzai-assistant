import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const pluginSource = readFileSync(join(process.cwd(), 'localDataPlugin.js'), 'utf8');
const catalogSource = readFileSync(join(process.cwd(), 'src', 'services', 'localDataDomainCatalog.js'), 'utf8');
const datasetSource = readFileSync(join(process.cwd(), 'src', 'services', 'localMirrorDataset.js'), 'utf8');
const productSearchFallbackServiceSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'productSearchFallbackService.js'),
  'utf8'
);

describe('local mirror read log rules', () => {
  it('retires the duplicate JSON diagnostics in favor of SQLite scheduler observability', () => {
    expect(appSource).toContain("const LOCAL_MIRROR_READ_LOG_FILE_KEY = 'local-mirror-read-log';");
    expect(appSource).toContain("const LOCAL_MIRROR_RETRY_QUEUE_FILE_KEY = 'local-mirror-retry-queue';");
    expect(appSource).toContain('const LOCAL_MIRROR_JSON_DIAGNOSTICS_RETIRED = true;');
    expect(appSource).toContain("sink: 'sqlite-scheduler-observability'");
    expect(appSource).toContain("sink: 'sqlite-request-jobs'");
    expect(pluginSource).not.toContain("'local-mirror-read-log': {");
    expect(pluginSource).not.toContain("'local-mirror-retry-queue': {");
    expect(appSource).not.toContain('writeLocalDataFile(LOCAL_MIRROR_READ_LOG_FILE_KEY');
    expect(appSource).not.toContain('writeLocalDataFile(LOCAL_MIRROR_RETRY_QUEUE_FILE_KEY');
    expect(appSource).toContain("entityType: 'domainSnapshot'");
    expect(appSource).toContain("entityType: 'productSnapshot'");
    expect(productSearchFallbackServiceSource).toContain("entityType: 'productMirror'");
  });

  it('keeps same-source dataset consistency diagnostics without persisting another cache file', () => {
    expect(catalogSource).toContain("'readDiagnostic'");
    expect(appSource).toContain('changeSummary: snapshot.changeSummary');
    expect(appSource).toContain('localSnapshotKey: snapshot.localSnapshotKey || key');
    expect(appSource).toContain('legacyCompatibleRead: Boolean(snapshot.legacyCompatibleRead)');
    expect(datasetSource).toContain('function resolveLocalMirrorDataState(options = {})');
    expect(datasetSource).toContain('sourceStatus: dataState.sourceStatus');
    expect(datasetSource).toContain('dataState,');
  });

  it('records local snapshot reads for key Ozon domains', () => {
    expect(appSource).toContain("domain: '03_products'");
    expect(appSource).toContain("domain: '10_profit_ledgers'");
    expect(appSource).not.toContain("domain: '00_dashboard'");
    expect(appSource).toContain('getLocalMirrorReadDomainFromSnapshotKey(snapshotKeys)');
    expect(appSource).toContain("status: 'miss'");
    expect(appSource).toContain("status: 'failed'");
  });

  it('exposes dataset consistency diagnostics for same-source page validation', () => {
    expect(datasetSource).toContain('function validatePageDatasetConsistency(dataset = {}, options = {})');
    expect(datasetSource).toContain("code: 'status-count-mismatch'");
    expect(datasetSource).toContain("code: 'page-total-mismatch'");
    expect(datasetSource).toContain("code: 'page-row-outside-filtered-source'");
    expect(datasetSource).toContain("code: 'detail-row-outside-source'");
    expect(datasetSource).toContain('consistency: validatePageDatasetConsistency(');
  });

  it('keeps read diagnostics out of browser localStorage', () => {
    expect(appSource).not.toMatch(/localStorage\.setItem\([^)]*local-mirror-read-log/);
    expect(appSource).not.toMatch(/localStorage\.removeItem\([^)]*local-mirror-read-log/);
    expect(appSource).not.toMatch(/localStorage\.setItem\([^)]*local-mirror-retry-queue/);
    expect(appSource).not.toMatch(/localStorage\.removeItem\([^)]*local-mirror-retry-queue/);
  });
});
