import BackupRounded from '@mui/icons-material/BackupRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { getLocalShops } from '../../../api/localApiClient.js';
import {
  activateStagedRecovery,
  backupShopRecovery,
  getRecoveryStatus,
  listRecoveryGenerations,
  reloadDesktopAfterRestore,
  stageRecoveryGenerations,
} from '../services/recoveryDesktopClient.js';

function normalizeShops(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.shops || payload?.rows || [];
  return rows
    .filter((shop) => String(shop?.id || '').trim())
    .map((shop) => ({
      id: String(shop.id),
      label: String(shop.alias || shop.name || shop.id),
    }));
}

function errorText(error) {
  const message = error instanceof Error ? error.message : String(error || '灾难备份请求失败。');
  if (message.includes('RECOVERY_REMOTE_COMMIT_CONFLICT')) {
    return '另一台设备刚更新了该店铺的备份。为避免覆盖较新的备份，本次未提交；请稍后重试。';
  }
  return message;
}

function generationIds(rows) {
  return rows
    .map((generation) => String(generation?.generation_id || generation?.generationId || '').trim())
    .filter(Boolean);
}

function reconcileStatusText(reconcile) {
  const completed = Number(reconcile?.completed || 0);
  const partial = Number(reconcile?.partial || 0);
  const failed = Number(reconcile?.failed || 0);
  const queued = Number(reconcile?.queued || 0);
  const pending = Number(reconcile?.pending || 0);
  if (failed > 0) return '恢复后的 Ozon 数据核对存在失败项，已保留恢复数据，可在服务恢复后重试。';
  if (partial > 0) return '恢复后的 Ozon 数据核对已部分完成，未完成领域会保留明确失败状态。';
  if (completed > 0) return '恢复后的 Ozon 数据核对已完成，恢复数据与 Ozon 回读已合并。';
  if (queued > 0) return '恢复后的 Ozon 数据核对已在后台排队，页面可继续正常使用。';
  if (pending > 0) return '恢复后的 Ozon 数据核对等待本机服务启动。';
  return '';
}

/** Lazy account-portal entry; no shop or remote request runs until the user opens this card. */
export function RecoveryBackupCard({ recoveryOnly = false }) {
  const [expanded, setExpanded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [shops, setShops] = React.useState([]);
  const [shopId, setShopId] = React.useState('');
  const [enrolled, setEnrolled] = React.useState(null);
  const [reconcile, setReconcile] = React.useState(null);
  const [passphrase, setPassphrase] = React.useState('');
  const [restoreOpen, setRestoreOpen] = React.useState(false);
  const [generations, setGenerations] = React.useState([]);
  const [stagedRestore, setStagedRestore] = React.useState(null);
  const [restoreLoading, setRestoreLoading] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');

  async function open() {
    if (expanded) return;
    setExpanded(true);
    setLoading(true);
    setError('');
    try {
      const [shopPayload, recoveryStatus] = await Promise.all([
        recoveryOnly ? Promise.resolve([]) : getLocalShops({ timeoutMs: 10_000 }),
        getRecoveryStatus(),
      ]);
      const available = normalizeShops(shopPayload);
      setShops(available);
      setShopId((current) => current || available[0]?.id || '');
      setEnrolled(recoveryStatus?.enrolled === true);
      setReconcile(recoveryStatus?.reconcile || null);
      if (recoveryOnly) {
        setMessage('当前处于恢复模式：本机业务资料不会打开，请读取服务器上的恢复备份。');
      } else if (!available.length) {
        setMessage('本机尚未绑定店铺；你仍可从服务器恢复已有数据。');
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  async function loadGenerations() {
    setRestoreOpen(true);
    setRestoreLoading(true);
    setError('');
    try {
      const rows = await listRecoveryGenerations();
      setGenerations(rows);
      if (!rows.length) setMessage('服务器暂时没有可恢复的备份。');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setRestoreLoading(false);
    }
  }

  async function stageRestore() {
    const ids = generationIds(generations);
    if (!ids.length || restoreLoading) return;
    if (passphrase.length < 12) {
      setError('恢复需要输入至少 12 位的恢复口令。');
      return;
    }
    setRestoreLoading(true);
    setError('');
    setMessage('');
    try {
      const result = await stageRecoveryGenerations({ generationIds: ids, passphrase });
      setStagedRestore(result);
      setPassphrase('');
      const shopCount = Number(result?.shopCount || 0);
      setMessage(`已在隔离数据库完成${shopCount > 0 ? ` ${shopCount} 个店铺` : '全部'}备份校验。确认切换前，当前本机数据不会被修改。`);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setRestoreLoading(false);
    }
  }

  async function activateRestore() {
    if (!stagedRestore?.restoreId || restoreLoading) return;
    setRestoreLoading(true);
    setError('');
    try {
      await activateStagedRecovery({ restoreId: stagedRestore.restoreId });
      setStagedRestore(null);
      setMessage('恢复数据已切换为当前本机资料，旧数据库已保留为回滚副本。');
      try { await reloadDesktopAfterRestore(); } catch { /* current data is already active; reload may be retried manually */ }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setRestoreLoading(false);
    }
  }

  async function submit() {
    if (!shopId || loading) return;
    if (enrolled === false && passphrase.length < 12) {
      setError('首次设置恢复口令至少需要 12 位。');
      return;
    }
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const result = await backupShopRecovery({ shopId, passphrase });
      setPassphrase('');
      setEnrolled(true);
      setMessage(
        result?.remoteGenerationId
          ? '已加密提交服务器备份；之后将每 15 分钟在后台自动更新。'
          : '备份任务已提交。',
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Box sx={{ width: '100%', p: 2, borderRadius: 3, bgcolor: '#f8fafc', textAlign: 'left' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1.5}>
        <Box>
          <Typography fontWeight={800}>灾难备份</Typography>
          <Typography variant="body2" color="text.secondary" mt={0.25}>
            店铺数据加密后备份；服务器不保存商品、订单或 Ozon 凭证明文。
          </Typography>
        </Box>
        <Button size="small" variant="outlined" startIcon={<BackupRounded />} onClick={open}>
          {expanded ? '已展开' : recoveryOnly ? '恢复资料' : '设置备份'}
        </Button>
      </Stack>
      {expanded ? (
        <Stack spacing={1.25} mt={2}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {message ? <Alert severity="success">{message}</Alert> : null}
          {!recoveryOnly ? (
            <>
              <TextField
                select
                size="small"
                label="备份店铺"
                value={shopId}
                disabled={loading || !shops.length}
                onChange={(event) => setShopId(event.target.value)}
              >
                {shops.map((shop) => <MenuItem key={shop.id} value={shop.id}>{shop.label}</MenuItem>)}
              </TextField>
              <TextField
                size="small"
                type="password"
                label={enrolled ? '恢复口令（已设置，可留空）' : '恢复口令（首次设置必填）'}
                value={passphrase}
                disabled={loading}
                helperText={enrolled
                  ? '本机只保存加密 keyset；后续自动备份无需再输入口令。'
                  : '请至少设置 12 位；首次成功后本机只保存加密 keyset，后续自动备份无需再输入。'}
                onChange={(event) => setPassphrase(event.target.value)}
              />
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                <Typography variant="caption" color="text.secondary">每店上限 30MiB，首次完成后后台每 15 分钟更新。</Typography>
                <Button size="small" variant="contained" disabled={loading || !shopId} onClick={submit}>
                  {loading ? <CircularProgress size={16} color="inherit" /> : '立即备份'}
                </Button>
              </Stack>
              {reconcileStatusText(reconcile) ? (
                <Typography variant="caption" color="text.secondary">{reconcileStatusText(reconcile)}</Typography>
              ) : null}
            </>
          ) : null}
          <Box sx={{ pt: 0.5, borderTop: '1px solid #e2e8f0' }}>
            <Button size="small" variant="text" disabled={restoreLoading} onClick={loadGenerations}>
              {recoveryOnly ? '读取服务器恢复备份' : '从服务器恢复到此电脑'}
            </Button>
            {restoreOpen ? (
              <Stack spacing={1.25} mt={1.25}>
                <Typography variant="body2" color="text.secondary">
                  {generations.length
                    ? `已发现 ${generationIds(generations).length} 份当前店铺备份；会统一导入同一个隔离资料，避免单店恢复覆盖其他店铺数据。`
                    : '正在读取服务器上的可恢复备份。'}
                </Typography>
                <TextField
                  size="small"
                  type="password"
                  label="恢复口令"
                  value={passphrase}
                  disabled={restoreLoading}
                  helperText="先在隔离数据库完成完整性校验，再由你确认切换。"
                  onChange={(event) => setPassphrase(event.target.value)}
                />
                {stagedRestore ? (
                  <Alert severity="warning" action={(
                    <Button color="inherit" size="small" disabled={restoreLoading} onClick={activateRestore}>确认切换</Button>
                  )}>
                    已完成 staging 校验；确认后将重启本机服务并保留旧数据库回滚副本。
                  </Alert>
                ) : (
                  <Button size="small" variant="outlined" disabled={restoreLoading || !generationIds(generations).length} onClick={stageRestore}>
                    {restoreLoading ? <CircularProgress size={16} /> : '下载并校验全部恢复数据'}
                  </Button>
                )}
              </Stack>
            ) : null}
          </Box>
        </Stack>
      ) : null}
    </Box>
  );
}
