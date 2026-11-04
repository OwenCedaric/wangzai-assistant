import {
  buildCustomerOrderTimeline,
  resolveCustomerOrderContext,
  resolveCustomerProductContext,
} from '../lib/customerOrderTimeline.js';
import { safeImageUrl } from '../../../shared/lib/imageUrlRules.js';
import { openInternalBrowserLinkFromEvent } from '../../../services/internalBrowserLinkClient.js';
import { LazyHoverImagePreview } from '../../../shared/ui/ImagePreview.jsx';
import CheckRounded from '@mui/icons-material/CheckRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { CustomerMessageRichText } from './CustomerMessageRichText.jsx';

function ContextItem({ label, value, fullWidth = false, wrap = false }) {
  const displayValue = String(value ?? '').trim() || '未返回';
  return (
    <Box className={`customer-chat-context-item${fullWidth ? ' full-width' : ''}${wrap ? ' wrap' : ''}`}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <CustomerMessageRichText variant="body2" title={displayValue} text={displayValue} />
    </Box>
  );
}

function OrderNumberItem({ value }) {
  const [copied, setCopied] = React.useState(false);
  const copyOrderNumber = React.useCallback(async () => {
    if (!value || value === '未关联订单') return;
    await globalThis.navigator?.clipboard?.writeText?.(value);
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 1200);
  }, [value]);

  return (
    <Box className="customer-chat-order-number">
      <Typography variant="caption" color="text.secondary">
        发货单号
      </Typography>
      <Stack direction="row" alignItems="flex-start" spacing={0.5}>
        <Typography variant="body2" title={value}>
          {value}
        </Typography>
        {value && value !== '未关联订单' ? (
          <Tooltip title={copied ? '已复制' : '复制订单号'}>
            <IconButton
              size="small"
              aria-label={copied ? '订单号已复制' : `复制订单号 ${value}`}
              onClick={copyOrderNumber}
            >
              {copied ? <CheckRounded /> : <ContentCopyRounded />}
            </IconButton>
          </Tooltip>
        ) : null}
      </Stack>
    </Box>
  );
}

function LatestPushCard({ message }) {
  if (!message) return null;
  return (
    <Box className={`customer-chat-context-push ${message.domain || 'customerService'}`}>
      <Typography variant="subtitle2" title={message.title || 'Ozon 信息更新'}>
        {message.title || 'Ozon 信息更新'}
      </Typography>
      <CustomerMessageRichText variant="body2" text={message.text} />
      <Typography variant="caption" color="text.secondary">
        {[message.source, message.time].filter(Boolean).join(' · ')}
      </Typography>
    </Box>
  );
}

function CustomerProductContext({ product, translatedName = '' }) {
  const displayName = translatedName || product.name;
  const imageUrl = safeImageUrl(product.imageUrl);
  const linkProps = product.href
    ? {
        component: 'a',
        href: product.href,
        onClick: (event) => {
          void openInternalBrowserLinkFromEvent(event, product.href).catch(() => undefined);
        },
        'aria-label': `打开 Ozon 商品页：${displayName}`,
      }
    : { component: 'div' };

  return (
    <Box
      {...linkProps}
      className={`customer-chat-product-context${product.href ? ' clickable' : ''}`}
      title={product.href ? '在内置浏览器打开 Ozon 商品页' : '当前商品缺少可用的 Ozon SKU'}
    >
      {imageUrl ? (
        <LazyHoverImagePreview
          className="customer-chat-product-image-hover"
          previewClassName="customer-chat-product-image-preview"
          imageUrl={imageUrl}
          alt={displayName}
        >
          <Box
            component="img"
            src={imageUrl}
            alt={displayName}
            className="customer-chat-product-image"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        </LazyHoverImagePreview>
      ) : null}
      <Box className="customer-chat-product-copy">
        <Typography variant="body2" title={displayName}>
          {displayName}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Ozon SKU：{product.sku}
        </Typography>
        {product.offerId ? (
          <Typography variant="caption" color="text.secondary">
            货号：{product.offerId}
          </Typography>
        ) : null}
      </Box>
      {product.href ? <OpenInNewRounded className="customer-chat-product-open-icon" /> : null}
    </Box>
  );
}

function CustomerOrderTimeline({ rows, translations = {}, loading = false }) {
  const hasDomesticRoute = rows.some((row) =>
    ['domestic_purchase', 'domestic_purchase_source', 'domestic_logistics'].includes(row.type)
  );
  const displayRows = React.useMemo(() => {
    if (loading || hasDomesticRoute || !rows.length) return rows;
    const domesticPlaceholder = {
      id: 'domestic-route-unlinked',
      type: 'domestic_missing',
      title: '国内采购与快递',
      detail: '暂未关联国内采购或快递记录',
      source: '本地订单关联',
      timeLabel: '未关联',
    };
    const orderedIndex = rows.findIndex((row) => row.type === 'ordered');
    if (orderedIndex < 0) return [...rows, domesticPlaceholder];
    return [...rows.slice(0, orderedIndex), domesticPlaceholder, ...rows.slice(orderedIndex)];
  }, [hasDomesticRoute, loading, rows]);
  return (
    <Box className="customer-chat-timeline-section">
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
        <Typography variant="subtitle2" className="customer-chat-context-title">
          订单完整路由
        </Typography>
        {loading ? (
          <Stack direction="row" alignItems="center" spacing={0.5} className="customer-chat-timeline-loading">
            <CircularProgress size={11} thickness={5} />
            <Typography variant="caption">读取中</Typography>
          </Stack>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {displayRows.length ? `${displayRows.length} 个节点` : '暂无记录'}
          </Typography>
        )}
      </Stack>

      <Box className="customer-order-timeline" role="list" aria-label="订单完整时间链路">
        {displayRows.length ? (
          displayRows.map((event, index) => (
            <Box key={event.id} className="customer-order-timeline-item" role="listitem">
              <Box className="customer-order-timeline-rail" aria-hidden="true">
                <Box className={`customer-order-timeline-dot ${event.type || 'ozon_event'}`} />
                {index < displayRows.length - 1 ? <Box className="customer-order-timeline-line" /> : null}
              </Box>
              <Box className="customer-order-timeline-content">
                <Box className="customer-order-timeline-head">
                  <CustomerMessageRichText
                    variant="subtitle2"
                    text={translations[`timeline:${event.id}:title`] || event.title}
                  />
                  <Typography variant="caption" className="customer-order-timeline-time">
                    {event.timeLabel}
                  </Typography>
                </Box>
                {event.detail ? (
                  <CustomerMessageRichText
                    variant="body2"
                    text={translations[`timeline:${event.id}:detail`] || event.detail}
                  />
                ) : null}
                <CustomerMessageRichText variant="caption" color="text.secondary" text={event.source} />
              </Box>
            </Box>
          ))
        ) : (
          <Box className="customer-order-timeline-empty">
            <Typography variant="body2">当前订单尚未回读到带准确时间的路由节点。</Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export const CustomerConsultationDetailPanel = React.memo(function CustomerConsultationDetailPanel({
  conversation,
  orderRow = null,
  orderRows = [],
  purchaseRows = [],
  purchaseLinks = [],
  logisticsRows = [],
  orderContextStatus = 'idle',
  notifications = [],
  product: productOverride = null,
  timelineRows: timelineRowsOverride = null,
  translations = {},
}) {
  if (!conversation) return null;

  const latestPush = [...(conversation.messages || [])].reverse().find((message) => message.role === 'system');
  const isPush = conversation.channel === 'push';
  const orderContext = resolveCustomerOrderContext(conversation, orderRow);
  const product = productOverride || resolveCustomerProductContext(conversation, orderRow);
  const timelineRows =
    timelineRowsOverride ||
    buildCustomerOrderTimeline({
      conversation,
      orderRow,
      orderRows,
      purchaseRows,
      purchaseLinks,
      logisticsRows,
      notifications,
    });

  return (
    <Box component="aside" className="customer-chat-context-panel">
      <Box className="customer-chat-context-block">
        <Typography variant="subtitle2" className="customer-chat-context-title">
          {isPush ? '推送概况' : '会话信息'}
        </Typography>
        <Box className="customer-chat-context-grid">
          <ContextItem
            label={isPush ? '推送来源' : 'Chat ID'}
            value={isPush ? conversation.shopName : conversation.chatId}
          />
          <ContextItem label="最后更新" value={conversation.updatedAt} />
          {isPush ? <ContextItem label="消息数量" value={`${conversation.notificationCount} 条`} /> : null}
          {isPush ? <ContextItem label="处理方式" value="只读展示" /> : null}
        </Box>
      </Box>

      <Divider />

      {isPush ? (
        <Box className="customer-chat-context-block">
          <Typography variant="subtitle2" className="customer-chat-context-title">
            最新推送
          </Typography>
          {latestPush ? (
            <LatestPushCard message={latestPush} />
          ) : (
            <Typography variant="body2" color="text.secondary">
              暂无与客服处理相关的推送
            </Typography>
          )}
        </Box>
      ) : (
        <>
          <Box className="customer-chat-context-block">
            <Typography variant="subtitle2" className="customer-chat-context-title">
              关联订单
            </Typography>
            <Box className="customer-chat-order-context">
              <OrderNumberItem value={orderContext.orderNumber} />
              <ContextItem label="订单状态" value={orderContext.orderStatus} wrap />
            </Box>
          </Box>

          <Divider />

          <Box className="customer-chat-context-block">
            <Typography variant="subtitle2" className="customer-chat-context-title">
              关联商品
            </Typography>
            <CustomerProductContext product={product} translatedName={translations[`product:${conversation.id}`]} />
          </Box>

          <Divider />

          <CustomerOrderTimeline
            rows={timelineRows}
            translations={translations}
            loading={orderContextStatus === 'loading'}
          />
        </>
      )}
    </Box>
  );
});
