import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../test/appSource';

describe('Ozon push full linkage rules', () => {
  it('connects accepted and refreshed push stages to every live business surface', () => {
    const localApp = readProjectSource('../local-api/src/app/createApp.js');
    const coordinator = readProjectSource('../local-api/src/domain/notifications/ozonPushDomainRefreshCoordinator.js');
    const app = readProjectSource('src/App.jsx');
    const sales = readProjectSource('src/features/orders/sales/model/useSalesOrderPagedCacheState.jsx');
    const products = readProjectSource('src/features/products/model/useProductSyncState.jsx');
    const marketing = readProjectSource('src/features/marketing/model/useMarketingActivitiesPageModel.jsx');
    const dashboard = readProjectSource('src/features/dashboard/DashboardPage.jsx');
    const analysis = readProjectSource('src/features/dataAnalysis/DataAnalysisPage.jsx');
    const customer = readProjectSource('src/features/customerConsultation/model/useCustomerConsultationRealtime.js');
    const bell = readProjectSource('src/app/shell/NotificationCenterPopover.jsx');

    expect(localApp).toContain('stage: "accepted"');
    expect(localApp).toContain('stage: "refreshed"');
    expect(coordinator).toContain('TYPE_ORDER_STATE_CHANGED');
    expect(coordinator).toContain('TYPE_FBO_STOCKS_CHANGED');
    expect(coordinator).toContain('TYPE_CHAT_CLOSED');
    expect(app).toContain('<OzonPushRealtimeBridge');
    expect(app).toContain('setProfitLocalInputsRefreshTick');
    expect(sales).toContain("isOzonPushDomainRefreshEvent(event, 'orders')");
    expect(sales).toContain('bypassMemory: true');
    expect(products).toContain("isOzonPushDomainRefreshEvent(event, 'products')");
    expect(marketing).toContain('handleOzonProductPush');
    expect(dashboard).toContain("!['orders', 'products'].includes(detail.domain)");
    expect(analysis).toContain("!['orders', 'products'].includes(detail.domain)");
    expect(customer).toContain('waitForCustomerServiceRealtimeEvent');
    expect(bell).toContain('realtimeTick');
  });
});

