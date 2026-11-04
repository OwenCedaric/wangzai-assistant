import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

function ShopLicenseRenewalDialog({
  open,
  shopName,
  clientId,
  expirationText,
  licenseStatus = 'ready',
  cardKey,
  error,
  busy,
  onCardKeyChange,
  onCancel,
  onSubmit,
}) {
  const dialogRef = React.useRef(null);
  // Without a license for this Client ID in the current account the card is
  // activated as a new shop license, not used to extend an existing one.
  const bindMode = licenseStatus === 'missing';
  const statusPending = licenseStatus === 'loading';
  const statusUnknown = licenseStatus === 'error';
  const submitBlocked = busy || statusPending || statusUnknown;
  const title = bindMode ? '为当前店铺绑定卡密' : '续费当前店铺卡密';
  const cardLabel = bindMode ? '月卡或年卡卡密' : '续费卡密';

  React.useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const dialogNode = dialogRef.current;
    const previousFocus = document.activeElement;
    const focusTimer = globalThis.setTimeout(() => {
      dialogNode?.querySelector('input:not([disabled])')?.focus();
    }, 0);
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onCancel?.();
        return;
      }
      if (event.key !== 'Tab' || !dialogNode) return;
      const focusable = [...dialogNode.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialogNode.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div
      className="shop-card-gate-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel?.();
      }}
    >
      <Box
        ref={dialogRef}
        component="form"
        className="shop-card-gate-panel shop-license-renewal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shop-license-renewal-title"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitBlocked) onSubmit?.();
        }}
      >
        <DialogTitle id="shop-license-renewal-title">{title}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Box className="shop-license-renewal-summary">
              <Box>
                <Typography variant="caption" color="text.secondary">当前店铺</Typography>
                <Typography variant="subtitle1">{shopName || '未命名店铺'}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">Ozon Client ID</Typography>
                <Typography variant="subtitle1">{clientId || '未填写'}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">当前到期时间</Typography>
                <Typography variant="subtitle1">{expirationText || '暂未获取'}</Typography>
              </Box>
            </Box>
            {bindMode ? (
              <Alert severity="info">
                当前账号下没有这个 Client ID 的卡密授权，验证后会消耗一张新的月卡或年卡并绑定到该店铺。
                如果这个店铺之前在其他账号下绑定过，请先在原账号解除绑定或联系管理员换绑，不需要在这里续费。
              </Alert>
            ) : null}
            {statusPending ? <Alert severity="info">正在读取当前店铺的授权状态，请稍候…</Alert> : null}
            {statusUnknown ? (
              <Alert severity="warning">暂时无法读取当前店铺的授权状态，为避免误用卡密，请关闭后稍后重试。</Alert>
            ) : null}
            {error ? <Alert severity="error">{error}</Alert> : null}
            <TextField
              label={cardLabel}
              value={cardKey}
              onChange={(event) => onCardKeyChange?.(
                event.target.value.toUpperCase().replace(/[^A-Z0-9-]/gu, '').slice(0, 19),
              )}
              placeholder="AAAA-BBBB-CCCC-DDDD"
              autoComplete="off"
              disabled={busy}
              inputProps={{ 'aria-label': cardLabel }}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancel} disabled={busy}>取消</Button>
          <Button type="submit" variant="contained" disabled={submitBlocked}>
            {busy ? (bindMode ? '验证绑定中…' : '验证续费中…') : bindMode ? '验证并绑定' : '验证并续费'}
          </Button>
        </DialogActions>
      </Box>
    </div>
  );
}

export { ShopLicenseRenewalDialog };
export default ShopLicenseRenewalDialog;
