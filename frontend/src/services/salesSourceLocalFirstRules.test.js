import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const mainSource = readFileSync(join(process.cwd(), 'src', 'main.jsx'), 'utf8');
const pluginSource = readFileSync(join(process.cwd(), 'localDataPlugin.js'), 'utf8');

describe('sales source local-first rules', () => {
  it('registers legacy sales source links as a local migration file', () => {
    expect(appSource).toContain("const LOCAL_SALES_SOURCE_FILE_KEY = 'sales-source-links';");
    expect(pluginSource).toContain("'sales-source-links'");
    expect(pluginSource).toContain("fileName: 'sales-source-links.json'");
  });

  it('migrates legacy sales source links into the dedicated shop-scoped SQLite table and retains the complete source when verification is incomplete', () => {
    const salesSnapshotSource = readFileSync(
      join(process.cwd(), 'src', 'features', 'orders', 'sales', 'model', 'useSalesOrdersSnapshotState.jsx'),
      'utf8'
    );
    const salesStoreSource = readFileSync(join(process.cwd(), 'src', 'services', 'salesSourceLinkStore.js'), 'utf8');
    expect(salesSnapshotSource).toContain('migrateLegacySalesSourceLinksAtStartup(shops)');
    expect(appSource).toContain('migrateLegacySalesSourceLinksAtStartup(store.shops)');
    expect(salesStoreSource).toContain('export function migrateLegacySalesSourceLinksAtStartup(shops = [])');
    expect(salesSnapshotSource).toContain('setLegacySalesSourceLinks({ ...unresolvedLegacyLinks, ...canonicalLinks })');
    expect(salesSnapshotSource).not.toContain('hydrateSourceLinkStorage(SALES_SOURCE_LINK_STORAGE_KEY');
    expect(salesStoreSource).toMatch(
      /await saveSalesSourcesForOrder\(\s*\{\s*shopId: identity\.shopId,\s*orderKey: identity\.orderKey,\s*record: payload,\s*\},\s*\{ timeoutMs: 30000 \}\s*\);/u
    );
    expect(salesStoreSource).toContain("if (!result?.ok) throw new Error('SALES_SOURCE_LINK_SAVE_FAILED');");
    expect(salesStoreSource).toContain('readEveryCursorPage(');
    expect(salesStoreSource).toContain('const readbackComplete = sourceEntries.every');
    expect(salesStoreSource).toContain('await writeLegacyFallback(legacyLinks, task).catch(() => undefined);');
    expect(salesStoreSource).toContain('await writeLegacyFallback({}, task);');
    expect(salesStoreSource).toMatch(
      /async function writeLegacyFallback\(records = \{\}, task\) \{\s*if \(task\.excludedOwnerIds\.size\) return;\s*await writeLocalDataFile\(LOCAL_SALES_SOURCE_FILE_KEY, records\);/u
    );
    expect(salesStoreSource).not.toContain('readLegacyBrowserValue');
    expect(salesStoreSource).not.toContain('compareAndRemoveLegacyBrowserValue');
    expect(salesStoreSource).not.toContain('window.localStorage.setItem');
    expect(mainSource).not.toContain('BROWSER_LOCAL_STORAGE_MIRROR_KEYS');
  });

  it('keeps product-scoped source links as the normal sales edit path and removes only the superseded order-scoped historical copy', () => {
    const salesLinkStateSource = readFileSync(
      join(process.cwd(), 'src', 'features', 'orders', 'sales', 'model', 'useSalesOrderSourceLinkState.jsx'),
      'utf8'
    );

    expect(salesLinkStateSource).toContain('saveProductSourceLinkRecord({');
    expect(salesLinkStateSource).toContain('removeSalesSourcesForOrder(supersededIdentity');
    expect(salesLinkStateSource).toContain('getOzonShopForOrder(order, shops, activeShop)');
    expect(salesLinkStateSource).not.toContain('saveSourceLinkStorage(');
  });
});
