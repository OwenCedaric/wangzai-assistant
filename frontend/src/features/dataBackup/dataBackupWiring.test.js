import { describe, expect, it } from 'vitest';
import appSource from '../../App.jsx?raw';
import navigationSource from '../../app/shell/AppNavigation.jsx?raw';
import pageSource from './DataBackupPage.jsx?raw';
import modelSource from './model/useDataBackupPageModel.js?raw';
import restoreModelSource from './model/useSoftwareBackupRestore.js?raw';
import dimensionSyncModelSource from './model/useHistoricalDimensionSync.js?raw';
import historicalImportModelSource from './model/useHistoricalOrderImport.js?raw';
import clientSource from './services/dataBackupClient.js?raw';
import desktopClientSource from './services/dataBackupDesktopClient.js?raw';
import dimensionSyncClientSource from './services/historicalDimensionSyncClient.js?raw';
import historicalImportClientSource from './services/historicalOrderImportClient.js?raw';

describe('data backup workspace wiring', () => {
  it('mounts a real data-backup workspace page and passes the current shop scope', () => {
    expect(navigationSource).toContain("id: 'data-backup'");
    expect(appSource).toContain("import('./features/dataBackup/DataBackupPage.jsx')");
    expect(appSource).toContain("pageId === 'data-backup'");
    expect(appSource).toContain('<DataBackupPage shops={ozonShops} activeShopId={activeOzonShopId} isActive={isActive} />');
    expect(pageSource).toContain('<SoftwareBackupRestorePanel');
    expect(pageSource).toContain('<HistoricalOrderImportPanel');
    expect(pageSource).toContain('<HistoricalDimensionSyncPanel');
    expect(pageSource).not.toContain('商品和订单可以重新同步');
  });

  it('keeps transport, browser storage, table names, and package bytes out of the page/model', () => {
    const featureSource = [
      pageSource,
      modelSource,
      restoreModelSource,
      historicalImportModelSource,
      dimensionSyncModelSource,
      clientSource,
      desktopClientSource,
      historicalImportClientSource,
      dimensionSyncClientSource,
    ].join('\n');
    expect(featureSource).not.toMatch(/(?<![\w$.])fetch\s*\(/u);
    expect(featureSource).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/u);
    expect(featureSource).not.toMatch(/\b(?:purchase_order_overrides|purchase_source_links|product_source_links|sales_source_links|cross_border_order_records)\b/u);
    expect(desktopClientSource).not.toMatch(/\.path\b|artifactPath|packageBytes|fileContents/u);
  });
});
