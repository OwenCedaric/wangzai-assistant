import { measureRouteModuleLoad } from "./app/performance/routeModuleLoadTelemetry.js";
import React from "react";

export function lazyNamed(importer, exportName, routeId = exportName) {
  return React.lazy(() => {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return importer().then((module) => {
      measureRouteModuleLoad(routeId, startedAt);
      return { default: module[exportName] };
    });
  });
}

export const DashboardPage = lazyNamed(() => import('./features/dashboard/DashboardPage.jsx'), 'DashboardPage');

export const CollectionPricingPage = lazyNamed(
  () => import('./features/collectionPricing/CollectionPricingPage.jsx'),
  'CollectionPricingPage'
);

export const PurchaseRehearsalPage = lazyNamed(
  () => import('./features/purchaseRehearsal/PurchaseRehearsalPage.jsx'),
  'PurchaseRehearsalPage'
);

export const FollowSellerDefensePage = lazyNamed(
  () => import('./features/followSellerDefense/FollowSellerDefensePage.jsx'),
  'FollowSellerDefensePage'
);

export const PointsPackagesPage = lazyNamed(
  () => import('./features/pointsPackages/PointsPackagesPage.jsx'),
  'PointsPackagesPage'
);

export const DataAnalysisPage = lazyNamed(() => import('./features/dataAnalysis/DataAnalysisPage.jsx'), 'DataAnalysisPage');

export const NotificationCenterPopover = lazyNamed(
  () => import('./app/shell/NotificationCenterPopover.jsx'),
  'NotificationCenterPopover'
);

export const StatusObservationPopover = lazyNamed(
  () => import('./app/shell/StatusObservationPopover.jsx'),
  'StatusObservationPopover'
);

export let salesOrdersPageLoadPromise = null;

export function loadSalesOrdersPage() {
  salesOrdersPageLoadPromise ??= import('./features/orders/sales/SalesOrdersPage.jsx');
  return salesOrdersPageLoadPromise;
}

export const SalesOrdersPage = lazyNamed(loadSalesOrdersPage, 'SalesOrdersPage');

export const PrintShippingPage = lazyNamed(
  () => import('./features/orders/printShipping/PrintShippingPage.jsx'),
  'PrintShippingPage'
);

export const PurchaseOrdersPage = lazyNamed(
  () => import('./features/orders/purchase/PurchaseOrdersPage.jsx'),
  'PurchaseOrdersPage'
);

export const MarketingActivityPage = lazyNamed(
  () => import('./features/marketing/MarketingActivitiesPage.jsx'),
  'MarketingActivityPage'
);

export const PaidPromotionPage = lazyNamed(
  () => import('./features/paidPromotion/PaidPromotionPage.jsx'),
  'PaidPromotionPage'
);

export const ProfitCalculationPage = lazyNamed(
  () => import('./features/profit/ProfitPage.jsx'),
  'ProfitCalculationPage'
);

export const ProfitReportPage = lazyNamed(
  () => import('./features/profitReport/ProfitReportPage.jsx'),
  'ProfitReportPage'
);

export const CustomerConsultationPage = lazyNamed(
  () => import('./features/customerConsultation/CustomerConsultationPage.jsx'),
  'CustomerConsultationPage'
);

export const SmartReplyPage = lazyNamed(
  () => import('./features/smartReply/SmartReplyPage.jsx'),
  'SmartReplyPage'
);

export const WarehouseLogisticsPage = lazyNamed(
  () => import('./features/warehouse/WarehouseLogisticsPage.jsx'),
  'WarehouseLogisticsPage'
);
