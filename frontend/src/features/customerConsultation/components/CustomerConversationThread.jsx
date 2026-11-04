import AssignmentReturnRounded from '@mui/icons-material/AssignmentReturnRounded';
import DoneAllRounded from '@mui/icons-material/DoneAllRounded';
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded';
import NotificationsNoneRounded from '@mui/icons-material/NotificationsNoneRounded';
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SupportAgentRounded from '@mui/icons-material/SupportAgentRounded';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { CustomerMessageAttachments } from './CustomerMessageAttachments.jsx';
import { CustomerMessageRichText } from './CustomerMessageRichText.jsx';

function getBubbleClassName(role) {
  return role === 'seller' ? 'customer-chat-bubble seller' : 'customer-chat-bubble buyer';
}

function getSystemMessageIcon(message = {}) {
  if (message.domain === 'orders') return ReceiptLongRounded;
  if (message.domain === 'logistics' || message.userType === 'courier') return LocalShippingRounded;
  if (message.domain === 'returns') return AssignmentReturnRounded;
  return SupportAgentRounded;
}

function CustomerTranslatedText({ message, translatedText = '', shopId = '' }) {
  const hasTranslation = Boolean(translatedText && translatedText !== message.text);
  const sourceText = String(message.text ?? '').trim() || '空消息';

  return (
    <>
      <CustomerMessageRichText
        variant="body2"
        className="customer-chat-primary-text"
        text={hasTranslation ? translatedText : sourceText}
      />
      {hasTranslation ? (
        <Box className="customer-chat-original-text">
          <Typography variant="caption">俄文原文</Typography>
          <CustomerMessageRichText variant="body2" text={sourceText} />
        </Box>
      ) : null}
      <CustomerMessageAttachments attachments={message.attachments} shopId={shopId} />
    </>
  );
}

const CustomerSystemMessage = React.memo(function CustomerSystemMessage({ message, translatedText = '', shopId = '' }) {
  const MessageIcon = getSystemMessageIcon(message);
  const tone = message.domain || 'customerService';
  const sourceText = String(message.text ?? '').trim();
  const translated = String(translatedText ?? '').trim();
  const isCollapsible = sourceText.length > 260 || translated.length > 260 || (message.attachments?.length || 0) > 2;
  const [expanded, setExpanded] = React.useState(!isCollapsible);

  return (
    <Box className={`customer-chat-system-event ${tone}`} data-message-role="system">
      <Box className="customer-chat-system-icon">
        <MessageIcon fontSize="small" />
      </Box>
      <Box className="customer-chat-system-copy">
        <Box className="customer-chat-system-head">
          <Typography variant="subtitle2" title={message.title || 'Ozon 信息更新'}>
            {message.title || 'Ozon 信息更新'}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap title={message.time || '时间未知'}>
            {message.time}
          </Typography>
        </Box>
        <Box className={`customer-chat-system-body${expanded ? ' expanded' : ''}`}>
          <CustomerTranslatedText message={message} translatedText={translatedText} shopId={shopId} />
        </Box>
        {isCollapsible ? (
          <Button
            size="small"
            variant="text"
            className="customer-chat-system-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起全文' : '展开全文'}
          </Button>
        ) : null}
        <CustomerMessageRichText
          variant="caption"
          color="text.secondary"
          text={[message.source, message.shopName, message.orderNumber ? `订单 ${message.orderNumber}` : '']
            .filter(Boolean)
            .join(' · ')}
        />
      </Box>
    </Box>
  );
});

const CustomerChatMessage = React.memo(function CustomerChatMessage({ message, translatedText = '', shopId = '' }) {
  const seller = message.role === 'seller';
  return (
    <Stack alignItems={seller ? 'flex-end' : 'flex-start'} spacing={0.5} data-message-role={message.role}>
      <Box className={getBubbleClassName(message.role)}>
        <CustomerTranslatedText message={message} translatedText={translatedText} shopId={shopId} />
      </Box>
      <Typography variant="caption" color="text.secondary" className="customer-chat-message-meta">
        {seller ? '店铺客服' : message.author || '买家信息待回读'} · {message.time || '时间未知'}
      </Typography>
    </Stack>
  );
});

function getTranslationLabel(status, translations = {}) {
  const translatedCount = Object.keys(translations).length;
  if (status === 'loading') return '翻译中';
  if (status === 'partial') return translatedCount ? '部分已翻译' : '翻译未完成，点击重试';
  if (status === 'error') return '翻译未完成，点击重试';
  if (status === 'success' && translatedCount) return '中文已翻译';
  return '';
}

export const CustomerConversationThread = React.memo(function CustomerConversationThread({
  conversation,
  translations = {},
  translationStatus = 'idle',
  translationError = '',
  onRetryTranslation,
  unreadCount = 0,
  markReadSupported = false,
  markReadUnavailableReason = '当前会话没有可用的已读标识',
  markingRead = false,
  onMarkRead,
  refreshing = false,
  onRefresh,
  onLoadOlder,
}) {
  if (!conversation) {
    return (
      <Box className="customer-chat-thread-empty">
        <Typography color="text.secondary">从左侧选择一个 Ozon 会话</Typography>
      </Box>
    );
  }

  const isPush = conversation.channel === 'push';
  const translationLabel = getTranslationLabel(translationStatus, translations);
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const historyLoading = refreshing || conversation.historyStatus === 'loading';
  const hasUnread = Number(unreadCount) > 0;

  return (
    <Box className="customer-chat-thread">
      <Box className="customer-chat-thread-head">
        <Avatar className={`customer-chat-avatar${isPush ? ' push' : ''}`}>
          {isPush ? (
            <NotificationsNoneRounded fontSize="small" />
          ) : (
            String(conversation.title || '客')
              .slice(0, 1)
              .toUpperCase()
          )}
        </Avatar>
        <Box className="customer-chat-thread-identity">
          <Typography variant="subtitle1" noWrap title={conversation.title || '未命名会话'}>
            {conversation.title}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap title={conversation.subtitle || ''}>
            {conversation.subtitle}
          </Typography>
        </Box>
        <Stack direction="row" alignItems="center" spacing={0.75} className="customer-chat-thread-actions">
          {translationLabel ? (
            <Tooltip title={translationError || '俄文消息自动翻译为中文，原文保留在消息下方'}>
              <Chip
                size="small"
                className={`customer-chat-translation-status ${translationStatus}`}
                label={translationLabel}
              />
            </Tooltip>
          ) : null}
          {['partial', 'error'].includes(translationStatus) && onRetryTranslation ? (
            <Button
              size="small"
              variant="text"
              className="customer-chat-translation-retry"
              onClick={onRetryTranslation}
            >
              重试翻译
            </Button>
          ) : null}
          {hasUnread && onMarkRead && markReadSupported ? (
            <Tooltip title={markReadSupported ? '先预览，再确认将当前会话标记为已读' : markReadUnavailableReason}>
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  className="customer-chat-mark-read"
                  startIcon={<DoneAllRounded />}
                  onClick={onMarkRead}
                  disabled={!markReadSupported || markingRead}
                >
                  {markingRead ? '处理中' : '标记已读'}
                </Button>
              </span>
            </Tooltip>
          ) : null}
          {onRefresh ? (
            <Tooltip title="同步当前 Ozon 会话">
              <span>
                <IconButton
                  size="small"
                  className={`customer-chat-refresh${refreshing ? ' loading' : ''}`}
                  aria-label="同步当前 Ozon 会话"
                  onClick={() => onRefresh()}
                  disabled={refreshing}
                >
                  <RefreshRounded fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          ) : null}
          <Chip
            size="small"
            className={`customer-chat-status ${Number(conversation.unreadCount ?? conversation.unread) ? 'pending' : ''}`}
            label={conversation.status || '状态待确认'}
          />
        </Stack>
      </Box>
      <Divider />

      <Box className="customer-chat-history">
        <Typography variant="caption" className="customer-chat-history-label">
          {conversation.updatedAt}
        </Typography>
        {messages.length ? (
          <Stack spacing={1.75}>
            {messages.map((message) =>
              message.role === 'system' ? (
                <CustomerSystemMessage
                  key={message.id}
                  message={message}
                  translatedText={translations[message.id]}
                  shopId={conversation.shopId}
                />
              ) : (
                <CustomerChatMessage
                  key={message.id}
                  message={message}
                  translatedText={translations[message.id]}
                  shopId={conversation.shopId}
                />
              )
            )}
            {conversation.historyHasNext ? (
              <Box textAlign="center">
                <Button
                  size="small"
                  variant="text"
                  onClick={() => onLoadOlder?.()}
                  disabled={historyLoading || !onLoadOlder}
                >
                  {historyLoading ? '正在读取更早消息' : '加载更早消息'}
                </Button>
              </Box>
            ) : null}
          </Stack>
        ) : historyLoading ? (
          <Box className="customer-chat-push-empty loading">
            <CircularProgress size={22} thickness={5} />
            <Typography variant="body2">正在读取 Ozon 聊天记录</Typography>
            <Typography variant="caption" color="text.secondary">
              消息读取完成后会自动显示
            </Typography>
          </Box>
        ) : (
          <Box className={`customer-chat-push-empty${conversation.notificationError ? ' error' : ''}`}>
            <NotificationsNoneRounded />
            <Typography variant="body2">
              {conversation.historyError || conversation.notificationError
                ? 'Ozon 聊天记录读取失败'
                : '当前会话暂无消息'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {conversation.historyError || conversation.notificationError || '点击右上角同步按钮重新读取'}
            </Typography>
            {conversation.historyError && onRefresh ? (
              <Button size="small" onClick={() => onRefresh()} disabled={historyLoading}>
                重试
              </Button>
            ) : null}
          </Box>
        )}
      </Box>
    </Box>
  );
});
