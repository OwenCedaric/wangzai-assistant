import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../test/appSource';

describe('Ozon push complete reuse guard', () => {
  it('keeps every original page consumer and desktop secret-path handoff', () => {
    const afterSales = readProjectSource('src/features/orders/afterSales/AfterSalesOrdersPage.jsx');
    const purchase = readProjectSource('src/features/orders/purchase/model/usePurchaseOrdersDatasetState.jsx');
    const automatic = readProjectSource('src/features/purchaseRehearsal/model/useAutomaticOrderWorkflow.js');
    const desktopServiceRuntime = readFileSync(
      join(process.cwd(), '..', 'desktop', 'src', 'runtime', 'serviceRuntime.js'),
      'utf8'
    );

    expect(afterSales).toContain("isOzonPushDomainRefreshEvent(event, 'returns')");
    expect(afterSales).toContain("isOzonPushDomainRefreshEvent(event, 'orders')");
    expect(purchase).toContain("isOzonPushDomainRefreshEvent(event, 'orders')");
    expect(automatic).toContain("isOzonPushDomainRefreshEvent(event, 'orders')");
    expect(desktopServiceRuntime).toContain('authToken,\n      secretPath,');
  });
});
