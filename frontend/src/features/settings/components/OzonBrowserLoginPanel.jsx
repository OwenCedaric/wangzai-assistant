import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import LoginRounded from '@mui/icons-material/LoginRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { getPurchaseBrowserErrorMessage } from '../services/purchaseBrowserLoginClient.js';
import {
  hideOzonBrowserLogin,
  openOzonBrowserLogin,
  waitForOzonBrowserLogin,
} from '../services/ozonBrowserLoginService.js';
import { waitForOzonBrowserDataObserver } from '../services/ozonBrowserDataService.js';

const PHASE_PRESENTATION = Object.freeze({
  idle: { label: '未连接', color: 'default' },
  opening: { label: '正在打开', color: 'warning' },
  waiting: { label: '等待验证码登录', color: 'warning' },
  saving: { label: '正在保存 Cookie', color: 'warning' },
  connected: { label: '已连接', color: 'success' },
  failed: { label: '连接失败', color: 'error' },
});

function loginErrorMessage(error) {
  if (error?.code === 'OZON_BROWSER_LOGIN_TIMEOUT') return error.message;
  const browserMessage = getPurchaseBrowserErrorMessage(error);
  if (!String(error?.code || error?.message || '').match(/(?:PURCHASE_BROWSER|CROSS_BORDER)_[A-Z0-9_]+/u)) {
    return error instanceof Error ? error.message : String(error || browserMessage);
  }
  return browserMessage;
}

function formatVerifiedAt(value) {
  const text = String(value || '').trim();
  if (!text) return '未验证';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString('zh-CN', { hour12: false });
}

export function OzonBrowserLoginPanel({
  connected = false,
  cookieStatus = '',
  lastVerifiedAt = '',
  title = 'Ozon 卖家网页登录',
  description = '在独立内置浏览器中输入验证码。登录成功后会自动保存 Cookie 并收起浏览器。',
  loginButtonLabel = '打开 Ozon 登录',
  reloginButtonLabel = '重新登录',
  requireCompanyIdentity = false,
  onEnsureProfile,
  onConnected,
} = {}) {
  const [phase, setPhase] = React.useState(connected ? 'connected' : 'idle');
  const [message, setMessage] = React.useState('');
  const [observerStatus, setObserverStatus] = React.useState('等待浏览器验证');
  const abortRef = React.useRef(null);
  const activeProfileIdRef = React.useRef('');
  const activeTabIdRef = React.useRef('');

  React.useEffect(() => {
    if (connected) setPhase('connected');
  }, [connected]);

  React.useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const startLogin = async () => {
    // Native IPC cannot be cancelled after dispatch. Each continuation must
    // still belong to this attempt before it can save state or hide a window.
    if (abortRef.current && !abortRef.current.signal.aborted) return;
    const abortController = new AbortController();
    abortRef.current = abortController;
    const isCurrentAttempt = () => abortRef.current === abortController && !abortController.signal.aborted;
    setMessage('');
    setPhase('opening');
    try {
      const profile = await onEnsureProfile?.();
      if (!isCurrentAttempt()) return;
      if (!profile?.id) throw new Error('Ozon 登录配置保存失败。');
      const opened = await openOzonBrowserLogin({ profileId: profile.id });
      if (!isCurrentAttempt()) return;
      activeProfileIdRef.current = profile.id;
      activeTabIdRef.current = opened.tab.tabId;
      setPhase('waiting');
      setMessage('登录窗口已打开，请在窗口完成验证码；如果没有看到窗口，请点“重新显示登录窗口”。');
      const verified = await waitForOzonBrowserLogin({
        tabId: opened.tab.tabId,
        signal: abortController.signal,
        requireCompanyIdentity,
      });
      if (!isCurrentAttempt()) return;
      setPhase('saving');
      let observer = null;
      try {
        observer = await waitForOzonBrowserDataObserver({
          tabId: opened.tab.tabId,
          signal: abortController.signal,
          timeoutMs: 15000,
        });
        if (!isCurrentAttempt()) return;
        setObserverStatus(`已启用 v${observer.result.extensionVersion || observer.result.runtime?.version || '2.0.0'}`);
      } catch (error) {
        if (!isCurrentAttempt()) return;
        if (error?.name === 'AbortError') throw error;
        setObserverStatus('登录已保存，观察器待就绪');
      }
      await onConnected?.({
        profile,
        result: { ...verified.result, dataObserver: observer?.result ?? null },
      });
      if (!isCurrentAttempt()) return;
      await hideOzonBrowserLogin();
      if (!isCurrentAttempt()) return;
      activeProfileIdRef.current = '';
      activeTabIdRef.current = '';
      abortRef.current = null;
      setPhase('connected');
      setMessage(observer
        ? '登录成功，Cookie 已保存，登录窗口已自动关闭，Ozon 数据观察器已启用。'
        : '登录成功，Cookie 已保存，登录窗口已自动关闭；数据观察器会在下次打开 Ozon 页面时继续就绪。');
    } catch (error) {
      if (!isCurrentAttempt() || error?.name === 'AbortError') return;
      activeProfileIdRef.current = '';
      activeTabIdRef.current = '';
      abortRef.current = null;
      setPhase('failed');
      setMessage(loginErrorMessage(error));
    }
  };

  const revealLoginWindow = async () => {
    const currentAttempt = abortRef.current;
    const profileId = activeProfileIdRef.current;
    const isCurrentAttempt = () => currentAttempt && abortRef.current === currentAttempt && !currentAttempt.signal.aborted;
    if (!profileId || !isCurrentAttempt()) return;
    try {
      const opened = await openOzonBrowserLogin({ profileId });
      if (!isCurrentAttempt()) return;
      if (opened?.tab?.tabId) activeTabIdRef.current = opened.tab.tabId;
      setMessage('登录窗口已重新显示，请在窗口完成验证码登录。');
    } catch (error) {
      if (!isCurrentAttempt()) return;
      // The existing verification is still alive; a failed reveal must not
      // replace it with a second login/persistence attempt.
      setMessage(loginErrorMessage(error));
    }
  };

  const cancelLoginWait = async () => {
    const currentAttempt = abortRef.current;
    if (!currentAttempt) return;
    currentAttempt.abort();
    abortRef.current = null;
    activeProfileIdRef.current = '';
    activeTabIdRef.current = '';
    setPhase(connected ? 'connected' : 'idle');
    setMessage('已取消本次登录等待，可以重新发起登录。');
    try {
      await hideOzonBrowserLogin();
    } catch {
      // Cancel must always release the page even if the native window already closed.
    }
  };

  const presentation = PHASE_PRESENTATION[phase] || PHASE_PRESENTATION.idle;
  const hardBusy = ['opening', 'saving'].includes(phase);
  const messageSeverity = phase === 'connected'
    ? 'success'
    : phase === 'waiting' || phase === 'idle'
      ? 'info'
      : 'error';

  return (
    <Box
      className="ozon-browser-login-panel"
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1.5,
        px: 2,
        py: 1.75,
        bgcolor: 'background.paper',
      }}
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between">
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            {phase === 'connected' ? <CheckCircleRounded color="success" fontSize="small" /> : null}
            <Typography variant="subtitle1">{title}</Typography>
            <Chip size="small" color={presentation.color} variant="outlined" label={presentation.label} />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {description}
          </Typography>
        </Box>
        {phase === 'waiting' ? (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ alignSelf: { xs: 'stretch', sm: 'center' }, flexShrink: 0 }}
          >
            <Button
              size="small"
              variant="contained"
              startIcon={<LoginRounded />}
              onClick={revealLoginWindow}
              sx={{ minWidth: 176, whiteSpace: 'nowrap' }}
            >
              重新显示登录窗口
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              onClick={cancelLoginWait}
              sx={{ whiteSpace: 'nowrap' }}
            >
              取消等待
            </Button>
          </Stack>
        ) : (
          <Button
            size="small"
            variant="contained"
            startIcon={<LoginRounded />}
            disabled={hardBusy}
            onClick={startLogin}
            sx={{
              alignSelf: { xs: 'stretch', sm: 'center' },
              minWidth: 176,
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            {hardBusy ? presentation.label : connected ? reloginButtonLabel : loginButtonLabel}
          </Button>
        )}
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2.5} sx={{ mt: 1.5 }}>
        <Box>
          <Typography variant="caption" color="text.secondary">登录方式</Typography>
          <Typography variant="body2">验证码登录</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">Cookie 状态</Typography>
          <Typography variant="body2">{cookieStatus || (connected ? '已保存' : '未保存')}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">最后验证</Typography>
          <Typography variant="body2">{formatVerifiedAt(lastVerifiedAt)}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">数据观察器</Typography>
          <Typography variant="body2">{observerStatus}</Typography>
        </Box>
      </Stack>
      {message ? <Alert severity={messageSeverity} sx={{ mt: 1.5 }}>{message}</Alert> : null}
    </Box>
  );
}

export default OzonBrowserLoginPanel;
