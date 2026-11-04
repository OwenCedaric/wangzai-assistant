import {
  clearOzonNotifications,
  listOzonNotificationSettings,
  listOzonNotifications,
  markOzonNotificationsRead,
  saveOzonNotificationSetting,
} from '../../api/localApiClient.js';
import { getOzonShopLabel } from '../../entities/order/orderShopScope.jsx';
import {
  formatNotificationEvent,
  getNotificationDomainLabel,
  getNotificationEventLabel,
} from './notificationEventFormatter.js';
import DeleteSweepRounded from '@mui/icons-material/DeleteSweepRounded';
import DoneAllRounded from '@mui/icons-material/DoneAllRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import React from 'react';

const FALLBACK_NOTIFICATION_CATALOG = [
  { domain: 'products', title: '商品变化', eventTypes: [] },
  { domain: 'orders', title: '订单进度', eventTypes: [] },
  { domain: 'returns', title: '售后处理', eventTypes: [] },
  { domain: 'purchase', title: '采购跟进', eventTypes: [] },
  { domain: 'profit', title: '利润变化', eventTypes: [] },
  { domain: 'performance', title: '推广变化', eventTypes: [] },
  { domain: 'marketing', title: '营销变化', eventTypes: [] },
  { domain: 'logistics', title: '物流进度', eventTypes: [] },
  { domain: 'finance', title: '财务变化', eventTypes: [] },
  { domain: 'customer', title: '买家消息', eventTypes: [] },
];

const DOMAIN_TONES = {
  products: 'primary',
  orders: 'success',
  returns: 'warning',
  purchase: 'primary',
  profit: 'error',
  performance: 'error',
  marketing: 'warning',
  logistics: 'success',
  finance: 'primary',
  customer: 'success',
};

function getShopKey(shop = {}) {
  return String(shop.id || shop.shopId || shop.clientId || '').trim();
}

function getShopTabLabel(shop = {}) {
  return getOzonShopLabel(shop) || shop.shopAlias || shop.alias || shop.name || getShopKey(shop) || 'Ozon 店铺';
}

function getNotificationDateText(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function getNotificationEntityText(notification = {}) {
  return [
    notification.offerId ? `货号 ${notification.offerId}` : '',
    notification.productId ? `商品 ${notification.productId}` : '',
    notification.postingNumber ? `订单 ${notification.postingNumber}` : '',
    notification.entityType === 'performance_campaign' && notification.entityId ? `计划 ${notification.entityId}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function getCatalogDomains(catalog = []) {
  const rows = Array.isArray(catalog) && catalog.length ? catalog : FALLBACK_NOTIFICATION_CATALOG;
  return rows.filter((item) => item?.domain && item?.title);
}

function getDomainTitle(catalog = [], domain) {
  if (domain === 'all') return '全部消息';
  const sourceTitle = getCatalogDomains(catalog).find((item) => item.domain === domain)?.title || '';
  return getNotificationDomainLabel(domain, sourceTitle);
}

function getEventTypeLabel(eventType) {
  return getNotificationEventLabel(eventType);
}

function getSettingScope(shopId) {
  return shopId && shopId !== 'all' ? shopId : 'all';
}

function isDomainNotificationEnabled(settings = [], shopId, domain) {
  const scope = getSettingScope(shopId);
  const exact = settings.find((item) => item.shopScope === scope && item.domain === domain && item.eventType === '*');
  if (exact) return exact.enabled !== false;
  const globalDomain = settings.find(
    (item) => item.shopScope === 'all' && item.domain === domain && item.eventType === '*'
  );
  if (globalDomain) return globalDomain.enabled !== false;
  const globalAll = settings.find((item) => item.shopScope === 'all' && item.domain === '*' && item.eventType === '*');
  return globalAll ? globalAll.enabled !== false : true;
}

function getVisibleNotifications(rows = [], selectedDomain) {
  if (selectedDomain === 'all') return rows;
  return rows.filter((item) => item.domain === selectedDomain);
}

function countUnread(rows = []) {
  return rows.filter((item) => !item.readAt).length;
}

function countByDomain(rows = []) {
  return rows.reduce((result, item) => {
    if (item.readAt) return result;
    result[item.domain] = (result[item.domain] || 0) + 1;
    return result;
  }, {});
}

export function NotificationCenterPopover({
  open,
  anchorEl,
  onClose,
  shops = [],
  activeShopId = '',
  onUnreadChange,
  realtimeTick = 0,
}) {
  const [selectedShopId, setSelectedShopId] = React.useState(activeShopId || 'all');
  const [selectedDomain, setSelectedDomain] = React.useState('products');
  const [notifications, setNotifications] = React.useState([]);
  const [catalog, setCatalog] = React.useState(FALLBACK_NOTIFICATION_CATALOG);
  const [settings, setSettings] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [markingRead, setMarkingRead] = React.useState(false);
  const [clearingNotifications, setClearingNotifications] = React.useState(false);
  const [savingSetting, setSavingSetting] = React.useState(false);
  const [error, setError] = React.useState('');
  const [lastLoadedAt, setLastLoadedAt] = React.useState('');
  const realtimeTickRef = React.useRef(realtimeTick);
  const authorizedShopIds = React.useMemo(
    () => shops.map(getShopKey).filter(Boolean),
    [shops]
  );

  React.useEffect(() => {
    setSelectedShopId((current) => {
      if (current === 'all') return current;
      if (current && shops.some((shop) => getShopKey(shop) === current)) return current;
      return shops.some((shop) => getShopKey(shop) === activeShopId) ? activeShopId : 'all';
    });
  }, [activeShopId, shops]);

  const mergedRows = React.useMemo(
    () => [...notifications].sort((left, right) =>
      String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
    ),
    [notifications]
  );
  const visibleRows = React.useMemo(
    () => getVisibleNotifications(mergedRows, selectedDomain),
    [mergedRows, selectedDomain]
  );
  const domainCounts = React.useMemo(() => countByDomain(mergedRows), [mergedRows]);
  const unreadCount = React.useMemo(() => countUnread(mergedRows), [mergedRows]);
  const selectedDomainEnabled = isDomainNotificationEnabled(settings, selectedShopId, selectedDomain);

  const refreshGlobalUnreadCount = React.useCallback(async () => {
    if (typeof onUnreadChange !== 'function') return;
    if (!authorizedShopIds.length) {
      onUnreadChange(0);
      return;
    }
    const payload = await listOzonNotifications({
      read: 'unread',
      limit: 1,
      shopIds: authorizedShopIds.join(','),
    }, { timeoutMs: 8000 });
    if (payload?.ok !== false) {
      onUnreadChange(Number(payload?.unread) || 0);
    }
  }, [authorizedShopIds, onUnreadChange]);

  const loadNotifications = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const shopId = selectedShopId && selectedShopId !== 'all' ? selectedShopId : '';
      if (!shopId && !authorizedShopIds.length) {
        setNotifications([]);
        setLastLoadedAt(new Date().toISOString());
        onUnreadChange?.(0);
        return;
      }
      const [notificationPayload, settingsPayload] = await Promise.all([
        listOzonNotifications({
          shopId,
          shopIds: shopId ? undefined : authorizedShopIds.join(','),
          limit: 100,
        }, { timeoutMs: 12000 }),
        listOzonNotificationSettings({ shopId }, { timeoutMs: 12000 }),
      ]);
      if (notificationPayload?.ok === false) {
        throw new Error(notificationPayload?.error?.message || '通知读取失败');
      }
      if (settingsPayload?.ok === false) {
        throw new Error(settingsPayload?.error?.message || '通知设置读取失败');
      }
      setNotifications(Array.isArray(notificationPayload?.rows) ? notificationPayload.rows : []);
      setCatalog(getCatalogDomains(settingsPayload?.catalog));
      setSettings(Array.isArray(settingsPayload?.rows) ? settingsPayload.rows : []);
      setLastLoadedAt(new Date().toISOString());
      if (typeof onUnreadChange === 'function') {
        if (shopId) {
          await refreshGlobalUnreadCount();
        } else {
          onUnreadChange(Number(notificationPayload?.unread) || 0);
        }
      }
    } catch (loadError) {
      setError(loadError?.message || '通知读取失败');
    } finally {
      setLoading(false);
    }
  }, [authorizedShopIds, onUnreadChange, refreshGlobalUnreadCount, selectedShopId]);

  React.useEffect(() => {
    if (!open) return undefined;
    loadNotifications();
    const timer = window.setInterval(loadNotifications, 30000);
    return () => window.clearInterval(timer);
  }, [loadNotifications, open]);

  React.useEffect(() => {
    if (realtimeTickRef.current === realtimeTick) return;
    realtimeTickRef.current = realtimeTick;
    if (open) void loadNotifications();
  }, [loadNotifications, open, realtimeTick]);

  const handleMarkAllRead = async () => {
    setMarkingRead(true);
    setError('');
    try {
      await markOzonNotificationsRead(
        selectedShopId && selectedShopId !== 'all'
          ? { shopId: selectedShopId }
          : { shopIds: authorizedShopIds },
        { timeoutMs: 12000 }
      );
      if (typeof onUnreadChange === 'function') {
        onUnreadChange(0);
      }
      await loadNotifications();
    } catch (markError) {
      setError(markError?.message || '消息已读失败');
    } finally {
      setMarkingRead(false);
    }
  };

  const handleClearNotifications = async () => {
    const payload = {};
    if (selectedShopId && selectedShopId !== 'all') payload.shopId = selectedShopId;
    else payload.shopIds = authorizedShopIds;
    if (selectedDomain && selectedDomain !== 'all') payload.domain = selectedDomain;
    setClearingNotifications(true);
    setError('');
    try {
      await clearOzonNotifications(payload, { timeoutMs: 12000 });
      await refreshGlobalUnreadCount();
      await loadNotifications();
    } catch (clearError) {
      setError(clearError?.message || '消息清空失败');
    } finally {
      setClearingNotifications(false);
    }
  };

  const handleDomainToggle = async (enabled) => {
    if (selectedDomain === 'all') return;
    setSavingSetting(true);
    setError('');
    try {
      await saveOzonNotificationSetting(
        {
          shopId: selectedShopId === 'all' ? '' : selectedShopId,
          domain: selectedDomain,
          eventType: '*',
          enabled,
        },
        { timeoutMs: 12000 }
      );
      await loadNotifications();
    } catch (saveError) {
      setError(saveError?.message || '提醒设置保存失败');
    } finally {
      setSavingSetting(false);
    }
  };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      PaperProps={{ className: 'notification-center-popover-paper' }}
    >
      <Box className="notification-center-shell">
        <Stack direction="row" alignItems="center" justifyContent="space-between" className="notification-center-head">
          <Box>
            <Typography variant="subtitle1">消息中心</Typography>
            <Typography variant="caption" color="text.secondary">
              直接说明哪个订单或商品发生了什么变化
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5} className="notification-center-actions">
            <Button size="small" startIcon={<RefreshRounded />} onClick={loadNotifications} disabled={loading}>
              刷新
            </Button>
            <Button
              size="small"
              startIcon={<DoneAllRounded />}
              onClick={handleMarkAllRead}
              disabled={markingRead || loading}
            >
              全部已读
            </Button>
            <Button
              size="small"
              color="inherit"
              startIcon={<DeleteSweepRounded />}
              onClick={handleClearNotifications}
              disabled={clearingNotifications || loading || !visibleRows.length}
            >
              清空当前
            </Button>
          </Stack>
        </Stack>

        <Box className="notification-shop-tabs" role="tablist" aria-label="通知店铺">
          <Box
            component="button"
            type="button"
            className={`notification-shop-tab${selectedShopId === 'all' ? ' active' : ''}`}
            onClick={() => setSelectedShopId('all')}
          >
            全部店铺
          </Box>
          {shops.map((shop) => {
            const shopId = getShopKey(shop);
            if (!shopId) return null;
            return (
              <Box
                key={shopId}
                component="button"
                type="button"
                className={`notification-shop-tab${selectedShopId === shopId ? ' active' : ''}`}
                onClick={() => setSelectedShopId(shopId)}
              >
                {getShopTabLabel(shop)}
              </Box>
            );
          })}
        </Box>

        <Box className="notification-center-body">
          <Box className="notification-domain-list" aria-label="消息分类">
            <Box
              component="button"
              type="button"
              className={`notification-domain-item${selectedDomain === 'all' ? ' active' : ''}`}
              onClick={() => setSelectedDomain('all')}
            >
              <span>全部消息</span>
              <strong>{unreadCount}</strong>
            </Box>
            {getCatalogDomains(catalog).map((item) => (
              <Box
                key={item.domain}
                component="button"
                type="button"
                className={`notification-domain-item${selectedDomain === item.domain ? ' active' : ''}`}
                onClick={() => setSelectedDomain(item.domain)}
              >
                <span>{getNotificationDomainLabel(item.domain, item.title)}</span>
                <strong>{domainCounts[item.domain] || 0}</strong>
              </Box>
            ))}
          </Box>

          <Box className="notification-message-pane">
            <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
              <Box>
                <Typography variant="subtitle2">{getDomainTitle(catalog, selectedDomain)}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {selectedShopId === 'all'
                    ? '全部店铺'
                    : shops.find((shop) => getShopKey(shop) === selectedShopId)?.shopAlias || '当前店铺'}
                  {lastLoadedAt ? ` · 最后刷新 ${getNotificationDateText(lastLoadedAt)}` : ''}
                </Typography>
              </Box>
              {selectedDomain !== 'all' ? (
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  <Typography variant="caption" color="text.secondary">
                    提醒
                  </Typography>
                  <Switch
                    size="small"
                    checked={selectedDomainEnabled}
                    disabled={savingSetting}
                    onChange={(event) => handleDomainToggle(event.target.checked)}
                  />
                </Stack>
              ) : null}
            </Stack>
            {error ? (
              <Alert severity="warning" className="notification-center-alert">
                {error}
              </Alert>
            ) : null}
            <Divider />
            <Box className="notification-message-list">
              {loading ? (
                <Box className="notification-center-loading">
                  <CircularProgress size={18} />
                  <Typography variant="caption" color="text.secondary">
                    正在读取消息
                  </Typography>
                </Box>
              ) : visibleRows.length ? (
                visibleRows.map((notification) => {
                  const unread = !notification.readAt;
                  const presentation = formatNotificationEvent(notification);
                  const hasChange = presentation.change.oldText || presentation.change.newText;
                  return (
                    <Box key={notification.id} className={`notification-message-item${unread ? ' unread' : ''}`}>
                      {presentation.product.image ? (
                        <Box
                          component="img"
                          className="notification-product-image"
                          src={presentation.product.image}
                          alt={presentation.product.name || presentation.product.sku || '商品图片'}
                          loading="lazy"
                          onError={(event) => {
                            event.currentTarget.style.display = 'none';
                          }}
                        />
                      ) : null}
                      <Box className="notification-message-content">
                        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
                          <Typography variant="body2" className="notification-message-title">
                            {presentation.headline}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            noWrap
                            className="notification-event-time"
                          >
                            发生时间：{getNotificationDateText(notification.createdAt) || '时间未返回'}
                          </Typography>
                        </Stack>
                        {hasChange ? (
                          <Box className="notification-change-line">
                            <span>{presentation.change.label}</span>
                            {presentation.change.oldText ? <strong>{presentation.change.oldText}</strong> : null}
                            {presentation.change.oldText && presentation.change.newText ? <b>→</b> : null}
                            {presentation.change.newText ? <strong>{presentation.change.newText}</strong> : null}
                          </Box>
                        ) : null}
                        {presentation.facts.length ? (
                          <Box className="notification-fact-list">
                            {presentation.facts.map((fact) => (
                              <Typography key={`${fact.label}:${fact.value}`} variant="body2">
                                <span>{fact.label}：</span>
                                {fact.value}
                              </Typography>
                            ))}
                          </Box>
                        ) : null}
                        <Stack direction="row" alignItems="center" spacing={0.75} mt={0.75} flexWrap="wrap">
                          <Chip
                            size="small"
                            label={presentation.eventLabel || getEventTypeLabel(notification.eventType)}
                            color={DOMAIN_TONES[notification.domain] || 'default'}
                            variant="outlined"
                          />
                          {notification.shopName ? (
                            <Chip size="small" label={`店铺：${notification.shopName}`} variant="outlined" />
                          ) : null}
                          {presentation.product.sku ? (
                            <Typography variant="caption" color="text.secondary">
                              SKU/货号：{presentation.product.sku}
                            </Typography>
                          ) : null}
                          {getNotificationEntityText(notification) ? (
                            <Typography variant="caption" color="text.secondary">
                              {getNotificationEntityText(notification)}
                            </Typography>
                          ) : null}
                        </Stack>
                      </Box>
                    </Box>
                  );
                })
              ) : (
                <Box className="notification-empty-state">
                  <Typography variant="body2">暂无消息</Typography>
                  <Typography variant="caption" color="text.secondary">
                    暂时没有新的订单、商品或售后变化
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>
        </Box>

      </Box>
    </Popover>
  );
}

export default NotificationCenterPopover;
