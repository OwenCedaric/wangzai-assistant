import BackupRounded from '@mui/icons-material/BackupRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { DataBackupExportPanel } from './components/DataBackupExportPanel.jsx';
import { DataBackupHistoryPanel } from './components/DataBackupHistoryPanel.jsx';
import { DataBackupOverviewPanel } from './components/DataBackupOverviewPanel.jsx';
import { HistoricalDimensionSyncPanel } from './components/HistoricalDimensionSyncPanel.jsx';
import { HistoricalOrderImportPanel } from './components/HistoricalOrderImportPanel.jsx';
import { SoftwareBackupRestorePanel } from './components/SoftwareBackupRestorePanel.jsx';
import { useDataBackupPageModel } from './model/useDataBackupPageModel.js';
import { useHistoricalDimensionSync } from './model/useHistoricalDimensionSync.js';
import { useHistoricalOrderImport } from './model/useHistoricalOrderImport.js';
import { useSoftwareBackupRestore } from './model/useSoftwareBackupRestore.js';

export function DataBackupPage({ shops = [], activeShopId = '', isActive = true }) {
  const model = useDataBackupPageModel({ shops, activeShopId, isActive });
  const restoreModel = useSoftwareBackupRestore({
    shopOptions: model.shopOptions,
    defaultShopId: model.shopId,
    onCompleted: model.refresh,
  });
  const historicalImportModel = useHistoricalOrderImport({
    shopId: model.shopId,
    isActive: isActive && model.status === 'ready',
    onCompleted: model.refresh,
  });
  const dimensionSyncModel = useHistoricalDimensionSync({
    shopId: model.shopId,
    completedImport: historicalImportModel.completedImport,
  });
  const loading = model.status === 'loading';
  return (
    <Box component="main" data-testid="data-backup-page" sx={{ minWidth: 0 }}>
      <Stack spacing={2}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
          <Box
            sx={{
              width: 46,
              height: 46,
              borderRadius: 2.5,
              display: 'grid',
              placeItems: 'center',
              color: 'primary.main',
              bgcolor: 'primary.50',
            }}
          >
            <BackupRounded />
          </Box>
          <Box>
            <Typography variant="h4" fontWeight={900}>数据备份</Typography>
            <Typography variant="body2" color="text.secondary" mt={0.25}>
              导出重要用户数据，在更换设备时恢复软件备份，也可导入使用软件前的历史订单资料。
            </Typography>
          </Box>
        </Stack>
        {model.error ? <Alert severity="error">{model.error}</Alert> : null}
        {model.warning ? <Alert severity="warning">{model.warning}</Alert> : null}

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 1.15fr) minmax(340px, 0.85fr)' },
            gap: 2,
          }}
        >
          <DataBackupOverviewPanel shop={model.selectedPreview} loading={loading} />
          <DataBackupExportPanel
            shopOptions={model.backupOwnerOptions}
            shopId={model.backupOwnerKey}
            loading={loading}
            exporting={model.exportStatus === 'exporting'}
            canExport={model.canExport}
            confirmOpen={model.exportConfirmationOpen}
            confirmMode={model.exportConfirmationMode}
            batchCount={model.preview.owners.length}
            canBatchExport={model.canBatchExport}
            fingerprint={model.selectedPreview?.dataFingerprint || ''}
            domains={model.availableDomains}
            selectedDomains={model.selectedDomains}
            message={model.exportMessage}
            onShopChange={model.selectBackupOwner}
            onRefresh={model.refresh}
            onExport={model.requestExport}
            onBatchExport={model.requestBatchExport}
            onConfirmExport={model.runExport}
            onCancelExport={model.cancelExport}
            onToggleDomain={model.toggleDomain}
            onSelectAllDomains={model.selectAllDomains}
            onRequiredDomainsOnly={model.selectRequiredDomainsOnly}
          />
        </Box>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', xl: 'minmax(340px, 0.85fr) minmax(0, 1.15fr)' },
            gap: 2,
            alignItems: 'start',
          }}
        >
          <SoftwareBackupRestorePanel shopOptions={model.shopOptions} model={restoreModel} />
          <HistoricalOrderImportPanel
            shopOptions={model.shopOptions}
            shopId={model.shopId}
            onShopChange={model.selectShop}
            model={historicalImportModel}
          />
        </Box>
        {historicalImportModel.completedImport ? (
          <HistoricalDimensionSyncPanel model={dimensionSyncModel} />
        ) : null}
        <DataBackupHistoryPanel
          backups={model.history}
          imports={historicalImportModel.history}
          onResumeHistoricalImport={historicalImportModel.resumeImport}
        />
      </Stack>
    </Box>
  );
}
