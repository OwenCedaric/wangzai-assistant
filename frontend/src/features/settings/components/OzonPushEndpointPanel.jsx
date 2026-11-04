import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import LinkRounded from '@mui/icons-material/LinkRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

function desktopCommand() {
  return globalThis.window?.wangzaiDesktop?.ozonPushEndpoint?.command;
}

function formatTime(value) {
  if (!value) return '尚未收到';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

async function copyText(value) {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

export default function OzonPushEndpointPanel({ activeShop, activeClientId = '' }) {
  const shopId = String(activeShop?.id || '').trim();
  const clientId = String(activeClientId || activeShop?.clientId || '').trim();
  // Re-read the authoritative shop record after every successful save of this shop.
  const savedRevision = [
    activeShop?.savedAt,
    activeShop?.shopIncarnation,
    activeShop?.credentialRevision,
  ].map((value) => String(value ?? '')).join('|');
  const [binding, setBinding] = React.useState(null);
  const [savedState, setSavedState] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    setBinding(null);
    setSavedState(null);
    setError('');
    setCopied(false);
    if (!shopId || !clientId || typeof desktopCommand() !== 'function') return () => { active = false; };
    setBusy(true);
    Promise.resolve(desktopCommand()({ command: 'read', shopId }))
      .then((result) => {
        if (!active) return;
        if (!result?.ok) throw new Error(result?.error || '店铺通知地址读取失败。');
        if (typeof result.shopSaved === 'boolean') {
          setSavedState({ saved: result.shopSaved, clientId: String(result.savedClientId || '').trim() });
        }
        setBinding(result.binding || null);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '店铺通知地址读取失败。');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => { active = false; };
  }, [clientId, savedRevision, shopId]);

  const saveHint = !clientId
    ? '请先保存当前店铺的 Client ID。'
    : savedState && !savedState.saved
      ? '当前店铺还没有保存成功，请先点击「保存」或「测试连接」，保存成功后再生成通知地址。'
      : savedState && savedState.clientId !== clientId
        ? 'Client ID 已修改但尚未保存，请先保存当前店铺后再生成通知地址。'
        : '';

  const run = async (command) => {
    const invoke = desktopCommand();
    if (typeof invoke !== 'function') {
      setError('当前桌面运行环境尚未就绪，请重启旺崽助手。');
      return;
    }
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const result = await invoke({ command, shopId });
      if (!result?.ok) throw new Error(result?.error || '店铺通知地址生成失败。');
      setBinding(result.binding || null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '店铺通知地址生成失败。');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    try {
      await copyText(binding?.url || '');
      setCopied(true);
      setError('');
    } catch {
      setError('复制失败，请选中地址后手动复制。');
    }
  };

  const receiving = Boolean(binding?.lastReceivedAt || binding?.status === 'receiving');
  const statusLabel = receiving ? '接收正常' : binding ? '待后台绑定' : '未生成';

  return (
    <Box
      data-testid="ozon-push-endpoint-panel"
      sx={{ mt: 1.5, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
        <Box>
          <Typography variant="subtitle1" fontWeight={700}>店铺消息通知</Typography>
          <Typography variant="caption" color="text.secondary">每个店铺一个地址，填到 Ozon 卖家后台的通知设置</Typography>
        </Box>
        <Chip
          size="small"
          color={receiving ? 'success' : binding ? 'warning' : 'default'}
          label={statusLabel}
          variant="outlined"
        />
      </Stack>

      {binding ? (
        <Stack spacing={1.1} mt={1.25}>
          <TextField
            size="small"
            label="Ozon 通知地址"
            value={binding.url || ''}
            fullWidth
            InputProps={{ readOnly: true }}
            inputProps={{ 'aria-label': 'Ozon 通知地址' }}
          />
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} flexWrap="wrap" useFlexGap>
            <Typography variant="caption" color="text.secondary">
              {binding.mode === 'server' ? '服务器地址' : '当前电脑公网地址'} · 最近接收：{formatTime(binding.lastReceivedAt)}
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="contained" startIcon={<ContentCopyRounded />} onClick={handleCopy} disabled={busy}>
                {copied ? '已复制' : '复制地址'}
              </Button>
              <Button size="small" variant="outlined" startIcon={<RefreshRounded />} onClick={() => run('rotate')} disabled={busy || Boolean(saveHint)}>
                重新生成
              </Button>
            </Stack>
          </Stack>
        </Stack>
      ) : (
        <Button
          sx={{ mt: 1.25 }}
          fullWidth
          size="small"
          variant="contained"
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <LinkRounded />}
          onClick={() => run('ensure')}
          disabled={busy || !shopId || Boolean(saveHint)}
        >
          {busy ? '正在生成…' : '一键生成通知地址'}
        </Button>
      )}

      {saveHint ? <Alert severity="info" sx={{ mt: 1 }}>{saveHint}</Alert> : null}
      {error ? <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert> : null}
    </Box>
  );
}

