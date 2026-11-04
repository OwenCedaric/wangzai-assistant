import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function readSource(relativePath) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

function normalizeLegacyImportText(source) {
  return source
    .replace(/from '\.\/(?:\.\.\/)+/g, "from './")
    .replace(/from '(?:\.\.\/)+/g, "from './")
    .replace(/([A-Za-z_$][\w$]*)\(\s*\n\s*/g, '$1(')
    .replace(/\{\s*\n\s*/g, '{ ')
    .replace(/,\s*\n\s*/g, ', ')
    .replace(/\|\|\s*\n\s*/g, '|| ')
    .replace(/,\s*options\s*\n\s*\)/g, ', options)')
    .replace(/\}\s*\n\s*\);/g, '});');
}

function readSourceTree(relativeDir) {
  const absoluteDir = join(process.cwd(), relativeDir);
  return readdirSync(absoluteDir)
    .sort()
    .flatMap((entry) => {
      const relativePath = `${relativeDir}/${entry}`;
      const absolutePath = join(process.cwd(), relativePath);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) return readSourceTree(relativePath);
      // Source-boundary assertions must inspect production modules only.  Including
      // Vitest files makes the test suite itself look like an application storage
      // writer whenever a test seeds localStorage.
      if (!/\.(js|jsx)$/.test(entry) || /\.(?:test|spec)\.(js|jsx)$/.test(entry)) return [];
      return [relativePath];
    });
}

const legacySourceOrder = [
  'src/shared/ui/ChartSupport.jsx',
  'src/app/shell/AppNavigation.jsx',
  'src/shared/config/appConfigCore.jsx',
  'src/shared/config/appConfigRuntime.jsx',
  'src/services/dashboardMetricsRuntime.jsx',
  'src/services/feeSettingsRuntime.js',
  'src/services/localMirrorProductRows.js',
  'src/services/ozonShopSettingsStore.js',
  'src/services/purchaseOrderStatus.js',
  'src/services/purchaseOrderRuntime.js',
  'src/services/purchaseOrderOverrideRules.js',
  'src/services/purchaseLogisticsRuntime.js',
  'src/services/purchaseImageRuntime.js',
  'src/services/purchaseCrossBorderRuntime.js',
  'src/services/productRowRuntime.js',
  'src/shared/ozon/ozonRuntime.jsx',
  'src/entities/product/productLocalData.jsx',
  'src/app/bootstrap/serviceConfiguration.jsx',
  'src/entities/product/productLocalMirror.jsx',
  'src/entities/product/productOzonApi.jsx',
  'src/entities/product/productAttributes.jsx',
  'src/entities/product/productWriteHelpers.jsx',
  'src/features/products/lib/productEditing.jsx',
  'src/entities/order/orderShopScope.jsx',
  'src/entities/order/orderAsyncRules.jsx',
  'src/entities/order/orderDisplayFormat.jsx',
  'src/entities/order/crossBorderOrderApi.jsx',
  'src/entities/order/orderSourceLinks.jsx',
  'src/entities/order/orderSourceLinkFields.jsx',
  'src/entities/profit/profitOrderSnapshot.jsx',
  'src/entities/profit/profitFinanceEvidence.jsx',
  'src/entities/profit/profitLedgerMapping.jsx',
  'src/entities/profit/profitDisplayRules.jsx',
  'src/entities/profit/profitAfterSalesRules.jsx',
  'src/entities/profit/profitAfterSalesSnapshot.jsx',
  'src/entities/marketing/marketingOrderFields.jsx',
  'src/entities/marketing/marketingSnapshotRuntime.jsx',
  'src/entities/marketing/marketingActionDisplay.jsx',
  'src/features/orders/purchase/lib/purchaseMarketingApi.jsx',
  'src/features/orders/purchase/lib/purchaseOrderNormalize.jsx',
  'src/features/orders/purchase/lib/purchaseImageRules.jsx',
  'src/features/dashboard/lib/dashboardSummary.js',
  'src/features/promptLibrary/lib/promptLibraryStore.jsx',
  'src/features/promptLibrary/PromptLibraryPage.jsx',
  'src/features/dashboard/DashboardPage.jsx',
  'src/features/dashboard/ui/DashboardChrome.jsx',
  'src/shared/ui/ImagePreview.jsx',
  'src/features/products/ui/ProductListImageThumb.jsx',
  'src/features/products/ui/ProductEditDialog.jsx',
  'src/features/products/ProductListWorkspace.jsx',
  'src/features/products/ProductListPage.jsx',
  'src/features/orders/afterSales/AfterSalesOrdersPage.jsx',
  'src/features/orders/sales/lib/salesOrderDisplay.jsx',
  'src/features/orders/sales/ui/SalesOrderProductImagePreview.jsx',
  'src/features/orders/sales/SalesOrdersWorkspace.jsx',
  'src/features/orders/sales/SalesOrdersPage.jsx',
  'src/features/orders/purchase/ui/PurchaseOrderProductImagePreview.jsx',
  'src/features/orders/purchase/PurchaseOrdersWorkspace.jsx',
  'src/features/orders/purchase/PurchaseOrdersPage.jsx',
  'src/features/marketing/MarketingActivitiesWorkspace.jsx',
  'src/features/marketing/MarketingActivitiesPage.jsx',
  'src/features/profit/ProfitPage.jsx',
  'src/features/warehouse/ui/WarehouseProductIdentity.jsx',
  'src/features/warehouse/warehouseRuntime.jsx',
  'src/features/warehouse/WarehouseLogisticsPage.jsx',
  'src/features/settings/ui/SettingsModulePanel.jsx',
  'src/features/settings/ui/WatermarkSettingsPanel.jsx',
  'src/features/settings/lib/modelApiSettings.jsx',
  'src/features/settings/StructuredSettingsLayout.jsx',
  'src/features/settings/ModelApiSettingsPanel.jsx',
  'src/features/settings/lib/feeSettings.jsx',
  'src/features/settings/ui/FeeSettingsPanel.jsx',
  'src/features/settings/ShopSettingsDialog.jsx',
  'src/appLazyRoutes.jsx',
  'src/App.jsx',
];

const splitPageSourceGroups = {
  'src/features/products/ProductListWorkspace.jsx': [
    'src/features/products/model/useProductListPageModel.jsx',
    'src/features/products/model/useProductBaseState.jsx',
    'src/features/products/model/useProductSyncState.jsx',
    'src/features/products/model/useProductFiltersState.jsx',
    'src/features/products/model/useProductPaginationState.jsx',
    'src/features/products/model/useProductSourceMaterialState.jsx',
    'src/features/products/model/useProductWriteState.jsx',
    'src/features/products/model/useProductBatchState.jsx',
    'src/features/products/view/ProductListPageView.jsx',
  ],
  'src/features/orders/sales/SalesOrdersWorkspace.jsx': [
    'src/features/orders/sales/model/useSalesOrdersPageModel.jsx',
    'src/features/orders/sales/model/useSalesOrdersSnapshotState.jsx',
    'src/features/orders/sales/model/useSalesOrderFiltersPaginationState.jsx',
    'src/features/orders/sales/model/useSalesOrderSelectionState.jsx',
    'src/features/orders/sales/model/useSalesOrderSourceLinkState.jsx',
    'src/features/orders/sales/model/useSalesOrderOperationState.jsx',
    'src/features/orders/sales/model/useSalesOrderViewMetaState.jsx',
    'src/features/orders/sales/view/SalesOrdersPageView.jsx',
  ],
  'src/features/orders/purchase/PurchaseOrdersWorkspace.jsx': [
    'src/features/orders/purchase/model/usePurchaseOrdersPageModel.jsx',
    'src/features/orders/purchase/model/usePurchaseOrdersDatasetState.jsx',
    'src/features/orders/purchase/model/useScopedPurchaseResource.js',
    'src/features/orders/purchase/model/usePurchaseFiltersPaginationState.jsx',
    'src/features/orders/purchase/model/purchaseOrderSearchIndex.js',
    'src/features/orders/purchase/model/purchaseOrderRangeReadModel.js',
    'src/features/orders/purchase/model/usePurchaseSelectionDetailState.jsx',
    'src/features/orders/purchase/model/usePurchaseSourceLinkState.jsx',
    'src/features/orders/purchase/model/usePurchaseOrderSupplement.js',
    'src/features/orders/purchase/model/usePurchasePluginCaptureState.jsx',
    'src/features/orders/purchase/model/usePurchaseCrossBorderState.jsx',
    'src/features/orders/purchase/model/usePurchaseActionItemsState.jsx',
    'src/features/orders/purchase/model/usePurchaseOperationExecutionState.jsx',
    'src/features/orders/purchase/view/PurchaseOrdersPageView.jsx',
    'src/features/orders/purchase/view/PurchaseOrdersDialogs.jsx',
  ],
  'src/features/marketing/MarketingActivitiesWorkspace.jsx': [
    'src/features/marketing/model/useMarketingActivitiesPageModel.jsx',
    'src/features/marketing/model/useMarketingActivityListState.jsx',
    'src/features/marketing/model/useMarketingFiltersState.jsx',
    'src/features/marketing/model/useMarketingProductPoolState.jsx',
    'src/features/marketing/model/useMarketingWriteFeedback.jsx',
    'src/features/marketing/model/useMarketingCardsState.jsx',
    'src/features/marketing/view/MarketingActivitiesPageView.jsx',
  ],
};

const splitPageGroupedFiles = new Set(Object.values(splitPageSourceGroups).flat());

function readSplitPageSource(relativePath) {
  const groupedFiles = splitPageSourceGroups[relativePath] ?? [];
  return [relativePath, ...groupedFiles].map((file) => readSource(file)).join('\n');
}

export function readSplitAppSource() {
  const sourceFiles = [
    'src/services/dashboardMetricsRuntime.jsx',
    'src/services/feeSettingsRuntime.js',
    'src/services/localMirrorProductRows.js',
    'src/services/ozonShopSettingsStore.js',
    'src/services/purchaseOrderStatus.js',
    'src/services/purchaseOrderRuntime.js',
    'src/services/purchaseOrderOverrideRules.js',
    'src/services/purchaseLogisticsRuntime.js',
    'src/services/purchaseCrossBorderRuntime.js',
    'src/services/purchaseImageRuntime.js',
    'src/services/productRowRuntime.js',
    ...readSourceTree('src/app'),
    ...readSourceTree('src/features'),
    ...readSourceTree('src/shared'),
    ...readSourceTree('src/entities'),
    'src/appLazyRoutes.jsx',
    'src/App.jsx',
  ].filter((file) => !splitPageGroupedFiles.has(file));
  const sourceFileSet = new Set(sourceFiles);
  const orderedFiles = [
    ...legacySourceOrder.filter((file) => sourceFileSet.has(file)),
    ...sourceFiles.filter((file) => !legacySourceOrder.includes(file)),
  ];
  const source = orderedFiles.map((file) => readSplitPageSource(file)).join('\n');

  return normalizeLegacyImportText(source);
}

export function readProjectSource(relativePath) {
  if (relativePath === 'src/App.jsx') return readSplitAppSource();
  return readSource(relativePath);
}
