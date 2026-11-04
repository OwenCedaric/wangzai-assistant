import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();

function getPageSource(name, nextName) {
  const start = appSource.indexOf(`function ${name}`);
  const end = appSource.indexOf(`function ${nextName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return appSource.slice(start, end);
}

describe('warehouse logistics local-first rules', () => {
  const pageSource = getPageSource('WarehouseLogisticsPage', 'SettingsModulePanel');

  it('hydrates warehouse config and product rows from canonical SQLite caches on page entry', () => {
    const hydrationSource = pageSource.slice(
      pageSource.indexOf('React.useEffect(() => {'),
      pageSource.indexOf('const loadWarehouseConfig')
    );
    expect(hydrationSource).toContain('requestOzonWarehouseConfigSnapshot(activeShop, {');
    expect(hydrationSource).toContain('requestOzonWarehouseProductsSnapshot(activeShop, {');
    expect(hydrationSource).toContain('forceRefresh: false');
    expect(hydrationSource).toContain('autoSync: false');
    expect(pageSource).not.toContain('LOCAL_OZON_DATA_LAYER_FILE_KEY');
    expect(pageSource).not.toContain('readOzonLocalDomainSnapshot(');
    expect(pageSource).not.toContain('readOzonLocalProductSnapshot(');
  });

  it('keeps real Ozon warehouse reads behind manual refresh or a completed warehouse write', () => {
    const localHydrationIndex = pageSource.indexOf('requestOzonWarehouseConfigSnapshot(activeShop, {');
    const configLoaderIndex = pageSource.indexOf('const loadWarehouseConfig');
    const productLoaderIndex = pageSource.indexOf('const loadWarehouseProducts');
    const refreshHandlerIndex = pageSource.indexOf('const refreshWarehousePage');
    const refreshButtonIndex = pageSource.indexOf('onClick={refreshWarehousePage}');
    const configRequestIndex = pageSource.indexOf('await requestOzonWarehouseConfigSnapshot(activeShop,');
    const productRequestIndex = pageSource.indexOf('await requestOzonWarehouseProductsSnapshot(activeShop,');
    const configLoaderCalls = pageSource.match(/loadWarehouseConfig\(\);/g) ?? [];
    const productLoaderCalls = pageSource.match(/loadWarehouseProducts\(\);/g) ?? [];

    expect(localHydrationIndex).toBeGreaterThanOrEqual(0);
    expect(configLoaderIndex).toBeGreaterThan(localHydrationIndex);
    expect(productLoaderIndex).toBeGreaterThan(configLoaderIndex);
    expect(refreshHandlerIndex).toBeGreaterThan(productLoaderIndex);
    expect(refreshButtonIndex).toBeGreaterThan(refreshHandlerIndex);
    expect(configRequestIndex).toBeGreaterThan(configLoaderIndex);
    expect(configRequestIndex).toBeLessThan(productLoaderIndex);
    expect(productRequestIndex).toBeGreaterThan(productLoaderIndex);
    expect(productRequestIndex).toBeLessThan(refreshHandlerIndex);
    expect(configLoaderCalls).toHaveLength(2);
    expect(productLoaderCalls).toHaveLength(1);
    expect(pageSource).toContain('const completeWarehouseManagement = async () =>');
    expect(pageSource).toContain('await loadWarehouseConfig();');
    expect(pageSource).not.toMatch(/React\.useEffect\(\(\)\s*=>\s*\{[\s\S]{0,500}refreshWarehousePage\(\)/);
    expect(pageSource).not.toMatch(/React\.useEffect\(\(\)\s*=>\s*\{[\s\S]{0,500}loadWarehouseConfig\(\)/);
    expect(pageSource).not.toMatch(/React\.useEffect\(\(\)\s*=>\s*\{[\s\S]{0,500}loadWarehouseProducts\(\)/);
  });

  it('does not let empty warehouse refresh results overwrite visible cached rows', () => {
    const configStart = pageSource.indexOf('const loadWarehouseConfig');
    const productStart = pageSource.indexOf('const loadWarehouseProducts');
    const refreshStart = pageSource.indexOf('const refreshWarehousePage');
    const configSource = pageSource.slice(configStart, productStart);
    const productSource = pageSource.slice(productStart, refreshStart);
    const configEmptyIndex = configSource.indexOf('if (!hasWarehouseConfigRows) {');
    const productEmptyIndex = productSource.indexOf('if (!hasProductRows) {');

    expect(configEmptyIndex).toBeGreaterThanOrEqual(0);
    expect(configSource).toContain('本次仓库接口未返回配置，已保留上次读取结果');
    expect(configSource).toContain('includeInactive: true');
    expect(configSource).toContain('forceRefresh: true');
    expect(configSource).toContain('timeoutMs: 25_000');
    expect(configSource).toContain('logisticsSyncTimeoutMs: 20_000');
    expect(configSource).not.toContain('backgroundRefresh: true');
    expect(configSource).toContain('后台刷新未完成，已保留本机仓库和配送方式');
    expect(configSource).toContain('return;');
    expect(configSource).not.toContain('writeOzonLocalDomainSnapshot(');

    expect(productEmptyIndex).toBeGreaterThanOrEqual(0);
    expect(productSource).toContain('本次商品接口未返回商品，已保留上次读取结果');
    expect(productSource).toContain('hydrate: false');
    expect(productSource).toContain('autoSync: true');
    expect(productSource).toContain('forceRefresh: true');
    expect(productSource).toContain('后台刷新未完成，已保留本机商品数据');
    expect(productSource).toContain('return;');
    expect(productSource).not.toContain('writeOzonLocalProductSnapshot(');
  });

  it('drops stale warehouse config and product refresh responses after shop changes', () => {
    const configStart = pageSource.indexOf('const loadWarehouseConfig');
    const productStart = pageSource.indexOf('const loadWarehouseProducts');
    const refreshStart = pageSource.indexOf('const refreshWarehousePage');
    const configSource = pageSource.slice(configStart, productStart);
    const productSource = pageSource.slice(productStart, refreshStart);

    expect(pageSource).toContain('const activeWarehouseShopKey = getOzonSnapshotSourceKey(activeShop);');
    expect(pageSource).toContain('const activeWarehouseShopKeyRef = React.useRef(activeWarehouseShopKey);');
    expect(pageSource).toContain('const warehousePageActiveRef = React.useRef(isActive);');
    expect(pageSource).toContain('const warehouseConfigRequestRef = React.useRef(0);');
    expect(pageSource).toContain('const warehouseProductRequestRef = React.useRef(0);');
    expect(pageSource).toContain('activeWarehouseShopKeyRef.current = activeWarehouseShopKey;');
    expect(pageSource).toContain('warehouseConfigRequestRef.current += 1;');
    expect(pageSource).toContain('warehouseProductRequestRef.current += 1;');

    expect(configSource).toContain('const requestShopKey = activeWarehouseShopKey;');
    expect(configSource).toContain('const requestId = warehouseConfigRequestRef.current + 1;');
    expect(configSource).toMatch(
      /warehousePageActiveRef\.current\s*&&\s*warehouseConfigRequestRef\.current === requestId\s*&&\s*activeWarehouseShopKeyRef\.current === requestShopKey/u
    );
    expect(configSource).toContain('if (!isCurrentRequest()) return;');
    expect(configSource).toContain('if (!isCurrentRequest()) return current;');

    expect(productSource).toContain('const requestId = warehouseProductRequestRef.current + 1;');
    expect(productSource).toMatch(
      /warehousePageActiveRef\.current\s*&&\s*warehouseProductRequestRef\.current === requestId\s*&&\s*activeWarehouseShopKeyRef\.current === requestShopKey/u
    );
    expect(productSource).toContain('if (!isCurrentRequest()) return;');
    expect(productSource).toContain('if (!isCurrentRequest()) return current;');
    expect(pageSource).toContain('setSnapshot(createEmptyWarehouseConfigSnapshot());');
    expect(pageSource).toContain('setProductSnapshot(createEmptyWarehouseProductSnapshot());');
    expect(pageSource).toContain('activeWarehouseShopKeyRef.current === hydrationShopKey');
  });

  it('uses shared indexes and pagination for warehouse method and product search', () => {
    expect(pageSource).toContain('const warehouseMethodRowsIndex = React.useMemo');
    expect(pageSource).toContain('buildRowsIndex(currentMethodRows');
    expect(pageSource).toContain('queryRowsIndex(warehouseMethodRowsIndex');
    expect(pageSource).toContain('const warehouseProductRowsIndex = React.useMemo');
    expect(pageSource).toContain('buildRowsIndex(productRows');
    expect(pageSource).toContain('queryRowsIndex(warehouseProductRowsIndex');
    expect(pageSource).toContain('paginateRows(filteredProducts, productPage, productPageSize)');
    expect(pageSource).not.toContain('const filteredMethods = currentMethodRows.filter');
    expect(pageSource).not.toContain('const productPageRows = filteredProducts.slice');
  });

  it('renders warehouse delivery methods in Chinese without the unused type/provider column', () => {
    expect(pageSource).toContain('getOzonDeliveryMethodDisplayName(method)');
    expect(pageSource).toContain('getDeliveryMethodStatusLabel(method.status)');
    expect(pageSource).toContain('getWarehouseStatusLabel(warehouse.status)');
    expect(pageSource).toContain('<TableCell colSpan={3}>');
    expect(pageSource).toContain('管理 Ozon 仓库');
    expect(pageSource).toContain('openDeliveryMethodManagement(method)');
    expect(pageSource).not.toContain('状态为阻断或停用');
    expect(pageSource).toContain('客户编号');
    expect(pageSource).toContain('仓库编号');
    expect(pageSource).toContain('方式编号');
    expect(pageSource).not.toContain('<TableCell>类型 / 服务商</TableCell>');
    expect(pageSource).not.toContain('<TableCell>{method.type}</TableCell>');
    expect(pageSource).not.toContain('blocked / disabled');
    expect(pageSource).not.toContain('Client ID');
    expect(pageSource).not.toContain('API Key');
    expect(pageSource).not.toContain('仓库 ID');
    expect(pageSource).not.toContain('方式 ID');
  });

  it('records page-level consistency logs for warehouse product rows', () => {
    expect(pageSource).toContain('const warehouseProductDatasetConsistency = React.useMemo');
    expect(pageSource).toContain('validatePageDatasetConsistency(');
    expect(pageSource).toContain("domain: '12_warehouse_logistics'");
    expect(pageSource).toContain(
      "status: warehouseProductDatasetConsistency.ok ? 'consistency-ok' : 'consistency-failed'"
    );
    expect(pageSource).toContain("configSnapshotScope: 'ozon-warehouse-config'");
    expect(pageSource).toContain("productsSnapshotScope: 'ozon-warehouse-products'");
    expect(pageSource).toContain("shopId: activeShop?.id || 'unknown'");
    expect(pageSource).toContain('consistency: warehouseProductDatasetConsistency');
    const logMatch = pageSource.match(
      /recordLocalMirrorReadLog\(\{\s*domain:\s*'12_warehouse_logistics'[\s\S]*?\}\)\.catch\(\(\) => undefined\);/u
    );
    expect(logMatch).not.toBeNull();
    const logSource = logMatch[0];
    expect(logSource).not.toContain('activeWarehouseShopKey,');
    expect(logSource).not.toContain('getOzonWarehouseConfigSnapshotKey(activeShop)');
    expect(logSource).not.toContain('getOzonWarehouseProductsSnapshotKey(activeShop)');
  });

  it('uses the warehouse page for multi-provider freight estimation instead of fake product binding', () => {
    expect(pageSource).toContain('<WarehouseFreightEstimatorCard');
    expect(pageSource).toContain('selectedProduct={selectedProduct}');
    expect(pageSource).toContain('methodRows={currentMethodRows}');
    expect(pageSource).not.toContain('商品配送方式绑定');
    expect(pageSource).not.toContain('查看绑定预览');
    expect(pageSource).not.toContain('配送方式绑定预览');
  });
});
