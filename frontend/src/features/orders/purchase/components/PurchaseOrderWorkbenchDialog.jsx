import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { MinimizableDialogTitle } from '../../../../shared/ui/minimizedTasks/MinimizableDialogTitle.jsx';
import { PurchaseOrderWorkbenchSidebar } from './PurchaseOrderWorkbenchSidebar.jsx';

function display(value, fallback = '未返回') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function platformLabel(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    if (host.includes('1688.com') || host.includes('alibaba.com')) return '1688 采购';
    if (host.includes('taobao.com')) return '淘宝采购';
    if (host.includes('tmall.com')) return '天猫采购';
    if (host.includes('yangkeduo.com') || host.includes('pinduoduo.com')) return '拼多多采购';
    if (host.includes('ozon.ru')) return 'Ozon 买家采购';
  } catch {
    return '采购网页';
  }
  return '采购网页';
}

function isPinduoduoUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    return host.includes('yangkeduo.com') || host.includes('pinduoduo.com');
  } catch {
    return false;
  }
}

const PINDUODUO_TOOLBAR_ACTIONS = Object.freeze([
  ['pinduoduo-home', '首页'],
  ['pinduoduo-personal', '个人中心'],
  ['pinduoduo-orders', '我的订单'],
  ['pinduoduo-addresses', '收货地址'],
]);

const COMMON_TOOLBAR_ACTIONS = Object.freeze([
  ['capture-purchase', '捕捉采购信息'],
  ['target-mode', '目标订单'],
  ['purchase-login-save', '保存账号'],
  ['account-status', '账号状态'],
  ['browser-extensions', '浏览器插件'],
]);

const RESULT_LABELS = Object.freeze({
  productTitle: '商品',
  purchaseOrderNumber: '采购单号',
  purchasePrice: '采购金额',
  quantity: '数量',
  status: '订单状态',
  phase: '浏览器状态',
  health: '连接状态',
  page: '当前页面',
  targetLocked: '目标订单',
  targetPhase: '目标状态',
  proxyMode: '网络模式',
  cookieStatus: '账号保存',
  lastLoginVerifiedAt: '核验时间',
  loggedIn: '登录状态',
  missingFields: '缺少字段',
  conflicts: '冲突字段',
  readbackVerified: '回读核验',
});

function safeToolbarResultRows(result = {}) {
  if (!result || typeof result !== 'object') return [];
  const preferredKeys = [
    '提示', 'productTitle', 'purchaseOrderNumber', 'purchasePrice', 'quantity', 'status',
    'phase', 'health', 'page', 'targetLocked', 'targetPhase', 'proxyMode', 'cookieStatus',
    'lastLoginVerifiedAt', 'loggedIn', 'missingFields', 'conflicts', 'readbackVerified',
  ];
  return preferredKeys.flatMap((key) => {
    const value = result[key];
    if (value === undefined || value === null || value === '') return [];
    const displayed = Array.isArray(value)
      ? value.length ? value.map((entry) => display(entry)).join('、') : '无'
      : typeof value === 'boolean' ? (value ? '是' : '否')
        : typeof value === 'object' ? `${Object.keys(value).length} 项` : String(value);
    return [{ key, label: RESULT_LABELS[key] || key, value: displayed }];
  });
}

export function PurchaseOrderWorkbenchDialog({
  dialog = {},
  onClose = () => {},
  onMinimize = () => {},
  onViewportReady = () => {},
  onRetry = () => {},
  onNavigate = () => {},
  onToolbarAction = async () => null,
  onReadPaymentInfo = () => {},
  onRefreshOrderStatus = () => {},
  onSavePurchaseInfo = () => {},
}) {
  const [viewport, setViewport] = React.useState(null);
  const [toolbarBusy, setToolbarBusy] = React.useState('');
  const [toolbarDialog, setToolbarDialog] = React.useState(null);
  const {
    open = false,
    minimized = false,
    requestKey = '',
    url = '',
    shopId = '',
    requireShopBinding = false,
    sellerOrderLookup = null,
    presentation = null,
    browserTargetContext = null,
    browserTabId = '',
    status = 'idle',
    operation = '',
    pendingSave = false,
    error = '',
  } = dialog || {};

  React.useLayoutEffect(() => {
    if (!open || minimized || !requestKey || !viewport || status === 'closing') return undefined;
    let frame = 0;
    let disposed = false;
    const publish = () => {
      frame = 0;
      if (disposed || !viewport.isConnected) return;
      const rect = viewport.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      onViewportReady({
        requestKey,
        url,
        shopId,
        requireShopBinding,
        sellerOrderLookup,
        presentation,
        browserTargetContext,
        bounds: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          visible: true,
        },
      });
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(publish);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(viewport);
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);
    // The first open is latency-critical and must not depend on the next
    // animation frame. Modal focus/overlay work can defer rAF long enough to
    // leave the card at “正在打开” even though the viewport already has its
    // final rectangle. Publish once synchronously, then use rAF only to merge
    // later ResizeObserver/window-resize bursts.
    publish();
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [browserTargetContext, minimized, open, onViewportReady, presentation, requestKey, requireShopBinding, sellerOrderLookup, shopId, status, url, viewport]);

  const isReady = status === 'ready';
  const isClosing = status === 'closing';
  const hasBrowserTab = Boolean(String(browserTabId || '').trim());
  const canRefreshOrderStatus = hasBrowserTab && !isClosing && (isReady || status === 'error');
  const handleClose = React.useCallback(() => {
    if (!isClosing) onClose();
  }, [isClosing, onClose]);
  const handleMinimize = React.useCallback(() => {
    if (!isClosing) onMinimize();
  }, [isClosing, onMinimize]);
  const handleToolbarAction = React.useCallback(async (action, payload = {}) => {
    if (!isReady || isClosing || toolbarBusy) return null;
    setToolbarBusy(action);
    try {
      const result = await onToolbarAction(action, payload);
      const nextDialog = result?.toolbar?.dialog;
      if (nextDialog) setToolbarDialog(nextDialog);
      return result;
    } finally {
      setToolbarBusy('');
    }
  }, [isClosing, isReady, onToolbarAction, toolbarBusy]);
  const toolbarResultRows = safeToolbarResultRows(toolbarDialog?.result);
  const confirmationToken = display(toolbarDialog?.confirmationToken, '');
  const conflicts = Array.isArray(toolbarDialog?.result?.conflicts)
    ? toolbarDialog.result.conflicts
    : [];
  const titleActions = (
    <Box className="purchase-order-workbench-title-toolbar" aria-label="采购浏览器快捷操作">
      {isPinduoduoUrl(url) ? (
        <Box className="purchase-order-workbench-title-action-group is-pinduoduo">
          <Typography component="span" className="purchase-order-workbench-title-action-label">拼多多</Typography>
          {PINDUODUO_TOOLBAR_ACTIONS.map(([action, label]) => (
            <Button
              key={action}
              size="small"
              variant="text"
              disabled={!isReady || isClosing || Boolean(toolbarBusy)}
              onClick={() => handleToolbarAction(action)}
            >
              {toolbarBusy === action ? <CircularProgress size={13} /> : label}
            </Button>
          ))}
        </Box>
      ) : null}
      <Box className="purchase-order-workbench-title-action-group is-order">
        <Typography component="span" className="purchase-order-workbench-title-action-label">订单</Typography>
        {COMMON_TOOLBAR_ACTIONS.map(([action, label]) => (
          <Button
            key={action}
            size="small"
            variant="text"
            disabled={!isReady || isClosing || Boolean(toolbarBusy)}
            onClick={() => handleToolbarAction(action)}
          >
            {toolbarBusy === action ? <CircularProgress size={13} /> : label}
          </Button>
        ))}
      </Box>
    </Box>
  );

  return (
    <>
      <Dialog
        open={open && !minimized}
        onClose={handleClose}
        className="purchase-order-workbench-dialog"
        maxWidth={false}
        transitionDuration={0}
        aria-labelledby="purchase-order-workbench-title"
      >
        <MinimizableDialogTitle
          titleId="purchase-order-workbench-title"
          title={display(presentation?.title, '订单操作台')}
          subtitle={display(presentation?.subtitle, '左侧订单信息固定，右侧采购网页独立操作')}
          actions={titleActions}
          disabled={isClosing}
          onMinimize={handleMinimize}
          onClose={handleClose}
          minimizeLabel="最小化订单操作台"
          closeLabel="关闭订单操作台"
        />
        <DialogContent>
        <Box className="purchase-order-workbench-shell">
          <PurchaseOrderWorkbenchSidebar
            presentation={presentation || {}}
            operation={operation}
            disabled={!isReady || isClosing}
            refreshDisabled={!canRefreshOrderStatus}
            pendingSave={pendingSave}
            onReadPaymentInfo={onReadPaymentInfo}
            onRefreshOrderStatus={onRefreshOrderStatus}
            onSavePurchaseInfo={onSavePurchaseInfo}
          />

          <Box component="section" className="purchase-order-workbench-browser-column">
            <Box className="purchase-order-workbench-browser-toolbar">
              <Stack direction="row" spacing={0.5}>
                <IconButton aria-label="网页后退" size="small" disabled={!isReady || isClosing} onClick={() => onNavigate('back')}>
                  <ArrowBackRounded />
                </IconButton>
                <IconButton aria-label="网页前进" size="small" disabled={!isReady || isClosing} onClick={() => onNavigate('forward')}>
                  <ArrowForwardRounded />
                </IconButton>
                <IconButton aria-label="刷新网页" size="small" disabled={!isReady || isClosing} onClick={() => onNavigate('reload')}>
                  <RefreshRounded />
                </IconButton>
              </Stack>
              <Box className="purchase-order-workbench-address" title={url}>
                <Typography variant="body2" noWrap>{url}</Typography>
              </Box>
              <Chip
                size="small"
                color={status === 'error' ? 'error' : isReady ? 'success' : 'default'}
                label={isClosing ? '正在关闭' : status === 'error' ? '加载失败' : isReady ? '已连接' : '正在打开'}
              />
            </Box>
            <Box className="purchase-order-workbench-browser-frame">
              <Box ref={setViewport} className="purchase-order-workbench-browser-viewport" data-testid="purchase-order-browser-viewport">
                {status === 'loading' ? (
                  <Box className="purchase-order-workbench-browser-state">
                    <CircularProgress size={30} />
                    <Typography variant="subtitle2">
                      正在打开 {display(presentation?.browserLabel, platformLabel(url))}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">操作台已经显示，网页正在后台接入。</Typography>
                  </Box>
                ) : null}
                {status === 'error' ? (
                  <Box className="purchase-order-workbench-browser-state is-error">
                    <Typography variant="subtitle1">网页没有打开</Typography>
                    <Typography variant="body2" color="text.secondary">{error || '内置浏览器连接失败，请重试。'}</Typography>
                    <Button variant="contained" size="small" onClick={onRetry}>重新加载</Button>
                  </Box>
                ) : null}
              </Box>
            </Box>
          </Box>
        </Box>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(toolbarDialog)}
        onClose={() => !toolbarBusy && setToolbarDialog(null)}
        maxWidth="sm"
        fullWidth
        aria-labelledby="purchase-workbench-toolbar-result-title"
      >
        <DialogTitle id="purchase-workbench-toolbar-result-title">
          {display(toolbarDialog?.title, '浏览器操作结果')}
        </DialogTitle>
        <DialogContent>
          <Stack className="purchase-order-workbench-toolbar-result" spacing={1}>
            {toolbarResultRows.length ? toolbarResultRows.map((row) => (
              <Box key={row.key} className="purchase-order-workbench-toolbar-result-row">
                <Typography variant="body2" color="text.secondary">{row.label}</Typography>
                <Typography variant="body2">{row.value}</Typography>
              </Box>
            )) : <Typography variant="body2">操作已完成。</Typography>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={Boolean(toolbarBusy)} onClick={() => setToolbarDialog(null)}>关闭</Button>
          {confirmationToken ? (
            <Button
              variant="contained"
              disabled={Boolean(toolbarBusy)}
              onClick={async () => {
                const token = confirmationToken;
                setToolbarDialog(null);
                await handleToolbarAction('capture-confirm', {
                  confirmationToken: token,
                  acceptConflicts: conflicts.length > 0,
                });
              }}
            >
              {conflicts.length ? '确认覆盖并回填' : '确认回填'}
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>
    </>
  );
}
