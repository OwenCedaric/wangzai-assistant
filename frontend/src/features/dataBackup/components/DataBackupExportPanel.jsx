import FileDownloadRounded from '@mui/icons-material/FileDownloadRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import {
  formatDataBackupCount,
  shortDataFingerprint,
} from '../lib/dataBackupPresentation.js';
import { DataBackupDomainSelector } from './DataBackupDomainSelector.jsx';
import { DataBackupShopSelect } from './DataBackupShopSelect.jsx';

export function DataBackupExportPanel({
  shopOptions,
  shopId,
  loading,
  exporting,
  canExport,
  confirmOpen,
  confirmMode,
  batchCount = 0,
  canBatchExport = false,
  fingerprint,
  domains,
  selectedDomains,
  message,
  onShopChange,
  onRefresh,
  onExport,
  onBatchExport,
  onConfirmExport,
  onCancelExport,
  onToggleDomain,
  onSelectAllDomains,
  onRequiredDomainsOnly,
}) {
  const selectedShop = shopOptions.find((shop) => shop.shopId === shopId);
  const selectedDomainSet = new Set(selectedDomains);
  const selectedDomainRows = domains.filter((domain) => selectedDomainSet.has(domain.domain));
  const selectedRecords = selectedDomainRows.reduce((total, domain) => total + domain.recordCount, 0);
  return (
    <>
      <Card variant="outlined" sx={{ height: '100%' }}>
        <CardContent>
          <Stack spacing={2}>
            <Box>
              <Typography variant="h6" fontWeight={800}>导出备份</Typography>
              <Typography variant="body2" color="text.secondary" mt={0.5}>
                选择账号或店铺，导出本地备份。
              </Typography>
            </Box>
            {message ? <Alert severity={message.severity}>{message.text}</Alert> : null}
            <DataBackupShopSelect
              idPrefix="data-backup-export-shop"
              label="备份账号/店铺"
              value={shopId}
              disabled={loading || exporting || !shopOptions.length}
              options={shopOptions}
              onChange={onShopChange}
            />
            <DataBackupDomainSelector
              domains={domains}
              selectedDomains={selectedDomains}
              disabled={loading || exporting}
              onToggle={onToggleDomain}
              onSelectAll={onSelectAllDomains}
              onRequiredOnly={onRequiredDomainsOnly}
            />
            <Typography variant="caption" color={fingerprint ? 'text.secondary' : 'warning.main'}>
              {fingerprint ? `当前数据快照：${shortDataFingerprint(fingerprint)}` : '等待本机服务生成数据快照。'}
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="flex-end">
              <Button
                variant="outlined"
                startIcon={<RefreshRounded />}
                disabled={loading || exporting || !shopId}
                onClick={onRefresh}
              >
                刷新数据
              </Button>
              <Button
                variant="outlined"
                startIcon={<FileDownloadRounded />}
                disabled={!canBatchExport || loading || exporting}
                onClick={onBatchExport}
              >
                一键备份全部
              </Button>
              <Button
                variant="contained"
                startIcon={exporting ? <CircularProgress size={16} color="inherit" /> : <FileDownloadRounded />}
                disabled={!canExport || loading || exporting}
                onClick={onExport}
              >
                {exporting ? '正在导出' : '导出备份'}
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
      <Dialog open={Boolean(confirmOpen)} onClose={exporting ? undefined : onCancelExport} maxWidth="xs" fullWidth>
        <DialogTitle>确认导出备份</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmMode === 'batch'
              ? `将一次性导出 ${batchCount} 个账号/店铺的全部可备份数据，每个对象生成一个独立 .wzb 文件。确认后选择统一保存文件夹。`
              : `将导出“${selectedShop?.shopName || selectedShop?.displayName || '当前账号'}”（ID：${selectedShop?.shopExternalId || selectedShop?.shopId || '未绑定'}）的本地用户数据。本次选择 ${selectedDomainRows.length} 类、${formatDataBackupCount(selectedRecords)} 条；未勾选的数据不会进入备份。确认后再选择保存位置。`}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancelExport} disabled={exporting}>取消</Button>
          <Button variant="contained" onClick={onConfirmExport} disabled={exporting}>确认导出</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
