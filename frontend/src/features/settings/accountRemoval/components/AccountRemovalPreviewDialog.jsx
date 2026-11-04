import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '../../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { AccountRemovalBackupGate } from './AccountRemovalBackupGate.jsx';
import { AccountRemovalSkipBackupDialog } from './AccountRemovalSkipBackupDialog.jsx';
import {
  accountRemovalOwnerLabels,
  getAccountRemovalAccountLabel,
  getAccountRemovalPhaseLabel,
  getAccountRemovalResourceLabel,
  getAccountRemovalStorageKindLabel,
  isAccountRemovalBackupAuthorizationCurrent,
  summarizeAccountRemovalPreview,
} from '../lib/accountRemovalPresentation.js';

function ResourceSummary({ title, resources = [], tone = 'default', preserved = false }) {
  return (
    <Box component="details" sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, px: 1.5, py: 1 }}>
      <Box component="summary" sx={{ cursor: 'pointer', fontWeight: 600 }}>
        {title}（{resources.length}）
      </Box>
      <Stack spacing={0.75} sx={{ mt: 1, maxHeight: 180, overflow: 'auto' }}>
        {resources.map((resource) => (
          <Stack key={resource.id} direction="row" spacing={1} alignItems="flex-start">
            <Chip
              size="small"
              color={tone}
              variant="outlined"
              label={getAccountRemovalStorageKindLabel(resource.storageKind)}
            />
            <Typography variant="body2">
              {getAccountRemovalResourceLabel(resource, { preserved })}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

export function AccountRemovalPreviewDialog({
  flow,
  busy,
  onConfirm,
  onExportBackup,
  onUseRecentBackup,
  onSkipBackup,
  onRefresh,
  onClose,
}) {
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [skipDialogOpen, setSkipDialogOpen] = React.useState(false);
  const directMode = flow.mode === 'direct';
  const resumeMode = flow.mode === 'resume';
  const preview = flow.preview;
  const owner = flow.owner || preview?.owner || {};
  const accountLabel = getAccountRemovalAccountLabel(flow.account, owner);
  const summary = summarizeAccountRemovalPreview(preview);
  const confirmed = acknowledged;
  const backupAuthorized = isAccountRemovalBackupAuthorizationCurrent(
    flow.backupReview,
    preview,
    flow.backupAuthorization,
  );
  const backupRequired = flow.backupReview?.required === true;
  const requiresBackupAction = backupRequired && !backupAuthorized;
  const canShowDeletionConfirmation = (
    !directMode
    && !resumeMode
    &&
    (flow.stage === 'preview' || flow.stage === 'error')
    && backupAuthorized
  );
  const hasDurableOperation = Boolean(flow.operation?.operationId);
  const retainsTaskOnClose = busy || flow.confirmationUncertain === true || (['error', 'pending'].includes(flow.stage) && hasDurableOperation);
  const closeBlocked = false;

  React.useEffect(() => {
    setAcknowledged(false);
    setSkipDialogOpen(false);
  }, [flow.backupAuthorization?.outcome, flow.open, preview?.previewFingerprint]);

  const handleClose = () => {
    if (closeBlocked) return;
    setSkipDialogOpen(false);
    onClose();
  };

  const handleExportBackup = async () => {
    if (busy || typeof onExportBackup !== 'function') return;
    await onExportBackup();
  };

  const handleSkipBackup = async () => {
    if (typeof onSkipBackup !== 'function') return;
    const authorization = await onSkipBackup();
    if (authorization) setSkipDialogOpen(false);
  };

  return (
    <>
      <Dialog
        open={Boolean(flow.open)}
        onClose={handleClose}
        disableEscapeKeyDown={closeBlocked}
        fullWidth
        maxWidth="md"
        aria-labelledby="account-removal-dialog-title"
        data-account-removal-stage={flow.stage}
      >
        <DialogTitle id="account-removal-dialog-title">删除账号</DialogTitle>
        {busy ? <LinearProgress /> : null}
        <DialogContent dividers>
          <Stack spacing={2}>
          {flow.stage !== 'preview' || flow.errorMessage ? (
            <Alert severity={flow.stage === 'completed' ? 'success' : flow.stage === 'error' ? 'error' : 'warning'}
              data-account-removal-error-code={flow.error?.code || undefined}>
              <Typography variant="subtitle2">{getAccountRemovalPhaseLabel(flow.stage)}</Typography>
              {flow.errorMessage ? <Typography variant="body2">{flow.errorMessage}</Typography> : null}
            </Alert>
          ) : null}

          <Box>
            <Typography variant="h6">{accountLabel}</Typography>
            <Typography variant="body2" color="text.secondary">
              {accountRemovalOwnerLabels[owner.ownerType] || '账号'}
            </Typography>
          </Box>

          {preview && !directMode ? (
            <>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Chip color="error" label={`将删除 ${summary.plannedCount} 项`} />
                <Chip color="success" variant="outlined" label={`明确保留 ${summary.preservedCount} 项`} />
                <Chip color="warning" variant="outlined" label={`删除前停止 ${summary.barrierCount} 个相关任务`} />
              </Stack>
              <ResourceSummary title="本次精确删除" resources={preview.plannedResources} tone="error" />
              <ResourceSummary title="本次明确保留" resources={preview.preserveResources} tone="success" preserved />
            </>
          ) : null}

          {preview && flow.backupReview && !directMode ? (
            <AccountRemovalBackupGate
              review={flow.backupReview}
              authorization={backupAuthorized ? flow.backupAuthorization : null}
              busy={busy}
              errorMessage={flow.backupError}
              onUseRecentBackup={onUseRecentBackup}
              onOpenSkip={() => setSkipDialogOpen(true)}
            />
          ) : null}

          {canShowDeletionConfirmation ? (
            <FormControlLabel
              control={<Checkbox checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />}
              label="我已核对删除账号和数据范围，确认继续永久删除"
            />
          ) : null}

          {flow.confirmationUncertain ? (
            <Alert severity="warning">删除请求已发送，结果尚未确认。关闭只隐藏窗口，请刷新恢复原删除任务。</Alert>
          ) : null}
          {flow.operation?.operationId ? (
            <Stack spacing={0.5}>
              <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                操作编号：{flow.operation.operationId} · 状态：{getAccountRemovalPhaseLabel(flow.operation.phase)}
              </Typography>
              {retainsTaskOnClose ? (
                <Typography variant="caption" color="text.secondary">
                  可以关闭弹窗继续使用软件；删除任务和安全保护会保留，任务完成前不会当作删除成功。
                </Typography>
              ) : null}
            </Stack>
          ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          {((flow.stage === 'error' && !directMode) || flow.stage === 'pending') && (!resumeMode || flow.operation?.operationId) ? (
            <Button onClick={onRefresh} disabled={busy}>{flow.stage === 'pending' || resumeMode ? '继续查看' : '刷新预览'}</Button>
          ) : null}
          <Button onClick={handleClose} disabled={closeBlocked}>
            {flow.stage === 'completed'
              ? '关闭'
              : retainsTaskOnClose
                ? '关闭弹窗（任务继续）'
                : flow.stage === 'error'
                  ? '关闭并取消删除'
                  : '取消'}
          </Button>
          {flow.stage === 'preview' && requiresBackupAction && !directMode ? (
            <Button
              variant="contained"
              onClick={handleExportBackup}
              disabled={busy || !preview}
            >
              先备份再删除
            </Button>
          ) : null}
          {canShowDeletionConfirmation ? (
            <Button color="error" variant="contained" onClick={onConfirm} disabled={!confirmed || busy || !preview}>
              确认永久删除
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>
      <AccountRemovalSkipBackupDialog
        open={skipDialogOpen && requiresBackupAction}
        busy={busy}
        onClose={() => setSkipDialogOpen(false)}
        onConfirm={handleSkipBackup}
      />
    </>
  );
}

export default AccountRemovalPreviewDialog;
