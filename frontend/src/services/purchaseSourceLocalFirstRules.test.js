import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const mainSource = readFileSync(join(process.cwd(), 'src', 'main.jsx'), 'utf8');
const pluginSource = readFileSync(join(process.cwd(), 'localDataPlugin.js'), 'utf8');
const catalogSource = readFileSync(join(process.cwd(), 'src', 'services', 'localDataDomainCatalog.js'), 'utf8');
const purchaseSourceStoreSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'purchaseSourceLinkStore.js'),
  'utf8'
);
const purchasePluginContextStoreSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'purchasePluginContextStore.js'),
  'utf8'
);
const purchasePageViewSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'orders', 'purchase', 'view', 'PurchaseOrdersPageView.jsx'),
  'utf8'
);
const purchaseSourceStateSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'orders', 'purchase', 'model', 'usePurchaseSourceLinkState.jsx'),
  'utf8'
);
const imagePreviewSource = readFileSync(join(process.cwd(), 'src', 'shared', 'ui', 'ImagePreview.jsx'), 'utf8');

describe('purchase source local-first rules', () => {
  it('keeps the retired plugin JSON file available only as a one-time migration input', () => {
    expect(appSource).toContain("const LOCAL_PURCHASE_SOURCE_FILE_KEY = 'purchase-source-links';");
    expect(appSource).toContain(
      "const LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY = 'purchase-source-plugin-context';"
    );
    expect(pluginSource).toContain("'purchase-source-links'");
    expect(pluginSource).toContain("fileName: 'purchase-source-links.json'");
    expect(pluginSource).toContain("'purchase-source-plugin-context'");
    expect(pluginSource).toContain("fileName: 'purchase-source-plugin-context.json'");
    expect(catalogSource).toContain("'purchasePluginContext'");
    expect(purchasePluginContextStoreSource).toContain("PROFILE_PURCHASE_PLUGIN_CONTEXT_NAMESPACE = 'purchase-plugin-context'");
    expect(purchasePluginContextStoreSource).toContain('readLegacyFileAdapter(LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY)');
  });

  it('keeps interactive saves canonical and preserves legacy files only during migration', () => {
    expect(purchaseSourceStoreSource).toContain('savePurchaseSourcesForOrder(order, normalized.links');
    const saveSource = purchaseSourceStoreSource.slice(purchaseSourceStoreSource.indexOf('export function savePurchaseSourceLinkRecord'),
      purchaseSourceStoreSource.indexOf('async function hydratePurchaseSourceLinks('));
    expect(saveSource).toContain("if (!result?.ok) throw new Error('PURCHASE_SOURCE_LINK_SAVE_FAILED')");
    expect(saveSource).not.toContain('writeLegacyFallback');
    expect(purchaseSourceStoreSource).toContain('await writeLegacyFallback(legacyLinks, task).catch(() => undefined);');
    expect(purchaseSourceStoreSource).toContain('if (task.excludedOwnerIds.size) return;');
    expect(purchaseSourceStoreSource).not.toContain('readLegacyBrowserValue');
    expect(purchaseSourceStoreSource).not.toContain('compareAndRemoveLegacyBrowserValue');
    expect(purchaseSourceStoreSource).not.toContain('window.localStorage.setItem');
    expect(mainSource).not.toContain('BROWSER_LOCAL_STORAGE_MIRROR_KEYS');
  });

  it('hydrates purchase source links from SQLite before relying on legacy file fallback only', () => {
    expect(appSource).toContain('migrateLegacyPurchaseSourceLinksAtStartup(store.shops)');
    expect(purchaseSourceStoreSource).toContain('export function migrateLegacyPurchaseSourceLinksAtStartup(shops = [])');
    expect(purchaseSourceStoreSource).toContain('hydratePurchaseSourceLinks({}, shops, task)');
    expect(purchaseSourceStoreSource).toContain('trackPurchaseSourceTask');
    expect(purchaseSourceStoreSource).toContain('readEveryCursorPage(');
    expect(purchaseSourceStoreSource).toContain('(pageQuery) => readPurchaseSourceLinks(pageQuery)');
    expect(purchaseSourceStoreSource).toContain('const readbackComplete = sourceEntries.every');
    expect(purchaseSourceStoreSource).toContain('return publishPurchaseSources(currentCanonical, legacyLinks, task, shops);');
  });

  it('refreshes the visible source slots from SQLite after an automatic browser capture', () => {
    expect(purchaseSourceStateSource).toContain('await readPurchaseSourceLinksFromLocalApi()');
    expect(purchaseSourceStateSource).toContain(
      'const canonicalSourceKey = `${expected.shopId || expected.shopClientId}:${expected.orderKey || expected.orderId}`;'
    );
    expect(purchaseSourceStateSource).toContain('sourceEntries.find((entry) => entry.link === capturedSourceUrl)');
    expect(purchaseSourceStateSource).toContain('setLegacyPurchaseSourceLinks((current) => ({');
  });

  it('saves purchase source links and overrides to local-api while keeping old files out of failed interactive writes', () => {
    const overrideApiSaveStart = appSource.indexOf('function savePurchaseOrderOverridesToLocalApi');
    const overrideApiSaveEnd = appSource.indexOf('function savePurchaseOrderLocalOverrides', overrideApiSaveStart);
    const overrideApiSaveSource = appSource.slice(overrideApiSaveStart, overrideApiSaveEnd);
    const overrideSaveStart = appSource.indexOf('function savePurchaseOrderLocalOverrides');
    const overrideSaveEnd = appSource.indexOf('function writePurchaseOrderLocalOverrides', overrideSaveStart);
    const overrideSaveSource = appSource.slice(overrideSaveStart, overrideSaveEnd);
    const purchaseSaveStart = appSource.indexOf('const handleSaveSourceLink = async () => {');
    const purchaseSaveEnd = appSource.indexOf('const updateSelectedSourceLink =', purchaseSaveStart);
    const purchaseSaveSource = appSource.slice(purchaseSaveStart, purchaseSaveEnd);

    expect(appSource).toContain("from './services/purchaseOrderOverrideClient'");
    expect(overrideApiSaveSource).toContain(".map(([orderKey, value]) => ({ orderKey: String(orderKey || '').trim(), value }))");
    expect(overrideApiSaveSource).toContain(".filter(({ orderKey, value }) => orderKey && value && typeof value === 'object' && !Array.isArray(value));");
    expect(overrideApiSaveSource).toContain('purchaseOrderOverrideLocalApiHashes.get(orderKey)');
    expect(overrideApiSaveSource).toContain(
      'savePurchaseOverrideToLocalApi({ ...value, orderKey }, value)'
    );
    expect(overrideApiSaveSource).toContain('return { orderKey, saved: false, error };');
    const overrideHydrateStart = appSource.indexOf('async function hydratePurchaseOrderLocalOverridesFromLocalFileInternal(task)');
    const overrideHydrateEnd = appSource.indexOf(
      'export function hydratePurchaseOrderLocalOverridesFromLocalFile()',
      overrideHydrateStart
    );
    const overrideHydrateSource = appSource.slice(overrideHydrateStart, overrideHydrateEnd);

    expect(overrideSaveSource).toContain('return savePurchaseOrderOverridesToLocalApi(normalizedOverrides);');
    expect(overrideSaveSource).not.toContain('if (result.failedKeys.length && options.persistFile !== false)');
    expect(overrideSaveSource).toContain('if (options.persistLocalApi === false)');
    expect(overrideSaveSource).toContain('if (options.persistFile === true)');
    expect(overrideHydrateSource).toContain('const migrationEntries = [];');
    expect(overrideHydrateSource).toContain(
      'const result = await importLegacyPurchaseOverrides(migrationEntries.map(({ payload }) => payload)'
    );
    expect(overrideHydrateSource).toContain(
      'const result = await savePurchaseOverrideToLocalApi({ ...legacyOverride, orderKey }, legacyOverride);'
    );
    expect(overrideHydrateSource).toContain(
      'purchaseOrderOverrideReadbackMatches(orderKey, legacyOverride, canonicalOverride)'
    );
    expect(overrideHydrateSource).toContain('const canonicalOverride = canonicalReadback.byScopedIdentity[scopedKey];');
    expect(overrideHydrateSource).not.toContain('readLegacyBrowserValue');
    expect(overrideHydrateSource).not.toContain('compareAndRemoveLegacyBrowserValue');
    expect(appSource).toContain('function purchaseOrderOverrideReadbackMatches(orderKey, legacyOverride, canonicalOverride)');
    expect(overrideHydrateSource).toContain('await writeLocalDataFile(LOCAL_PURCHASE_ORDER_OVERRIDES_FILE_KEY, {});');
    expect(purchaseSaveSource).toContain('await persistSelectedSourceRecord(nextRecord);');
    expect(appSource).toContain('savePurchaseSourceLinkRecord({');
    expect(appSource).toContain('saveProductSourceLinkRecord({');
  });

  it('uses the saved source-link image for the purchase order card hover preview', () => {
    expect(purchasePageViewSource).toContain(
      "import { LazyHoverImagePreview, OrderImagePreviewSlot } from '../../../../shared/ui/ImagePreview.jsx';"
    );
    expect(purchasePageViewSource).toContain('getPurchaseSourceProductImageUrl');
    expect(purchasePageViewSource).toContain('getPurchaseSourceProductPreviewImageUrl');
    expect(purchasePageViewSource).toContain(
      'const sourceProductImageUrl = getPurchaseSourceProductImageUrl(selectedSourceEntry);'
    );
    expect(purchasePageViewSource).toContain('const sourceProductPreviewImageUrl =');
    expect(purchasePageViewSource).not.toContain(
      'const productImageUrl = getPurchaseProductImageUrl(product, selectedSourceEntry);'
    );
    expect(purchasePageViewSource).toContain('className="detail-product-image-hover purchase-order-image-hover"');
    expect(purchasePageViewSource).toContain('previewClassName="purchase-order-image-preview"');
    expect(purchasePageViewSource).toContain('imageUrl={sourceProductPreviewImageUrl}');
    expect(purchasePageViewSource).toContain('src={sourceProductImageUrl}');
    expect(purchasePageViewSource).toContain('referrerPolicy="no-referrer"');
    expect(imagePreviewSource).toContain('referrerPolicy="no-referrer"');
  });

  it('keeps purchase plugin source context out of browser writes while preserving the bridge publish', () => {
    const bridgeStart = appSource.indexOf('async function requestPurchasePluginBridge(path, options = {})');
    const bridgeEnd = appSource.indexOf('export function readPurchasePluginCaptures(after = 0)', bridgeStart);
    const bridgeSource = appSource.slice(bridgeStart, bridgeEnd);
    const captureStart = appSource.indexOf('function readPurchasePluginCaptures(after = 0)');
    const captureEnd = appSource.indexOf('function getLocalRecordTimestamp(record)', captureStart);
    const captureSource = appSource.slice(captureStart, captureEnd);
    const publishStart = appSource.indexOf('savePurchasePluginSourceContext(context);');
    const publishEnd = appSource.indexOf('React.useEffect(() => {', publishStart + 1);
    const publishSource = appSource.slice(publishStart, publishEnd);

    expect(purchasePluginContextStoreSource).not.toContain('readPurchasePluginSourceContextFromBrowser');
    expect(purchasePluginContextStoreSource).not.toContain('readLegacyBrowser');
    expect(purchasePluginContextStoreSource).toContain('saveProfileSettingAdapter(PROFILE_PURCHASE_PLUGIN_CONTEXT_NAMESPACE, nextStore');
    const runtimeSaveStart = purchasePluginContextStoreSource.indexOf('export function savePurchasePluginSourceContext(context)');
    const runtimeSaveEnd = purchasePluginContextStoreSource.indexOf('export function flushPurchasePluginContextWritesForTest()', runtimeSaveStart);
    const runtimeSaveSource = purchasePluginContextStoreSource.slice(runtimeSaveStart, runtimeSaveEnd);
    expect(runtimeSaveSource).not.toContain('writeLegacyFileAdapter');
    expect(appSource).not.toContain('window.localStorage.setItem(PURCHASE_PLUGIN_SOURCE_CONTEXT_STORAGE_KEY');
    expect(bridgeSource).toContain('isPurchasePluginBridgeEnabled()');
    expect(bridgeSource).toContain("reason: 'purchase_plugin_bridge_disabled'");
    expect(bridgeSource).toContain("reason: 'purchase_plugin_bridge_unavailable'");
    expect(captureSource).toContain('if (!isPurchasePluginBridgeEnabled())');
    expect(captureSource).toContain('bridgeSkipped: true');
    expect(publishSource).toContain('sendPurchasePluginContext(context).catch(() => undefined)');
  });

  it('publishes purchase plugin context without a repeating timer', () => {
    const contextStart = appSource.indexOf('const buildPurchasePluginSourceContext = React.useCallback');
    const contextEnd = appSource.indexOf('setPurchaseImageMap(new Map());', contextStart);
    expect(contextStart).toBeGreaterThanOrEqual(0);
    expect(contextEnd).toBeGreaterThan(contextStart);
    const contextPublishSource = appSource.slice(contextStart, contextEnd);

    expect(contextPublishSource).toContain('savePurchasePluginSourceContext(context);');
    expect(contextPublishSource).toContain('sendPurchasePluginContext(context).catch(() => undefined)');
    expect(contextPublishSource).toContain("window.addEventListener('focus', publishContext)");
    expect(contextPublishSource).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)");
    expect(contextPublishSource).not.toContain('window.setInterval');
    expect(contextPublishSource).not.toContain('setInterval(publishContext');
  });

  it('does not keep no-op legacy purchase cleanup placeholders', () => {
    expect(appSource).not.toContain('function cleanupPurchasePluginLegacyOverride');
    expect(appSource).not.toContain('function cleanupPurchasePluginLegacySourcePollution');
    expect(appSource).not.toContain('function cleanupPurchasePluginLegacyOrderOverrides');
    expect(appSource).not.toContain('function cleanupPurchasePluginLegacySourceMap');
    expect(appSource).not.toContain('function countPurchaseOrderStage');
  });
});
