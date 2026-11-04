import CampaignRounded from '@mui/icons-material/CampaignRounded';
import DoneAllRounded from '@mui/icons-material/DoneAllRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import SupportAgentRounded from '@mui/icons-material/SupportAgentRounded';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { CustomerMessageRichText } from './CustomerMessageRichText.jsx';

function getInitials(title = '') {
  return String(title).trim().slice(0, 1).toUpperCase() || '客';
}

function ConversationAvatar({ conversation }) {
  if (conversation.category === 'support') {
    return (
      <Avatar className="customer-chat-avatar support">
        <SupportAgentRounded fontSize="small" />
      </Avatar>
    );
  }
  if (conversation.category === 'notification' || conversation.channel === 'push') {
    return (
      <Avatar className="customer-chat-avatar push">
        <CampaignRounded fontSize="small" />
      </Avatar>
    );
  }
  return <Avatar className="customer-chat-avatar">{getInitials(conversation.title)}</Avatar>;
}

const CATEGORY_ORDER = ['buyer', 'notification', 'support'];
const CATEGORY_LABELS = Object.freeze({
  buyer: '买家咨询',
  notification: 'Ozon 通知',
  support: '平台支持',
});

function groupConversations(conversations = []) {
  const groups = new Map();
  for (const conversation of conversations) {
    const category = conversation.category || (conversation.channel === 'chat' ? 'buyer' : 'notification');
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(conversation);
  }
  return [...groups.entries()].sort(([left], [right]) => {
    const leftRank = CATEGORY_ORDER.indexOf(left);
    const rightRank = CATEGORY_ORDER.indexOf(right);
    return (leftRank < 0 ? 99 : leftRank) - (rightRank < 0 ? 99 : rightRank);
  });
}

const ConversationItem = React.memo(function ConversationItem({
  conversation,
  translatedPreview = '',
  active,
  onSelectConversation,
}) {
  const previewText = translatedPreview || conversation.lastMessage || '暂无消息内容';
  const selectConversation = () => onSelectConversation(conversation.id);

  return (
    <Box
      className={`customer-chat-list-item${active ? ' active' : ''}`}
      data-customer-conversation-id={conversation.id}
    >
      <ButtonBase
        component="button"
        type="button"
        className="customer-chat-list-select"
        aria-label={`打开会话：${conversation.title || '未命名会话'}`}
        onClick={selectConversation}
      >
        <Badge
          badgeContent={conversation.unreadCount ?? conversation.unread ?? 0}
          color="error"
          overlap="circular"
          invisible={!Number(conversation.unreadCount ?? conversation.unread)}
        >
          <ConversationAvatar conversation={conversation} />
        </Badge>
        <Box className="customer-chat-list-copy">
          <Box className="customer-chat-list-meta">
            <Typography variant="subtitle2" noWrap title={conversation.title || '会话信息待回读'}>
              {conversation.title || '会话信息待回读'}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap title={conversation.time || '时间未知'}>
              {conversation.time || '时间未知'}
            </Typography>
          </Box>
          <Box className="customer-chat-list-meta">
            <Typography variant="caption" color="text.secondary" noWrap title={conversation.subtitle || '未关联订单'}>
              {conversation.subtitle || '未关联订单'}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap title={conversation.status || '状态待确认'}>
              {conversation.status || '状态待确认'}
            </Typography>
          </Box>
        </Box>
      </ButtonBase>
      <Box className="customer-chat-list-preview" onClick={selectConversation}>
        <CustomerMessageRichText
          variant="body2"
          color="text.secondary"
          className="customer-chat-list-preview-text"
          text={previewText}
          title={previewText}
        />
      </Box>
    </Box>
  );
});

export const CustomerConversationList = React.memo(function CustomerConversationList({
  filters = [],
  statusFilters = [],
  conversations = [],
  previewTranslations = {},
  selectedFilterId,
  selectedStatusId = 'all',
  selectedConversationId,
  unreadOnly = false,
  searchText,
  unreadCount = 0,
  actionableUnreadCount = unreadCount,
  readOnlyUnreadCount = 0,
  readOnlyUnreadConversations = 0,
  syncStatus = 'idle',
  syncError = '',
  emptyReason = '',
  hasNext = false,
  loadingMore = false,
  backgroundSyncing = false,
  backgroundError = '',
  loadedCount = 0,
  totalCount = 0,
  onSelectFilter,
  onSelectStatus,
  onToggleUnread,
  onSelectConversation,
  onSearchChange,
  onRefresh,
  onLoadMore,
  markReadSupported = false,
  markReadUnavailableReason = '后端暂未提供标记已读功能',
  onMarkAllRead,
  markingRead = false,
  onVisibleConversationIdsChange,
  onStartConversation,
}) {
  const listRef = React.useRef(null);
  const syncing = syncStatus === 'loading' || syncStatus === 'refreshing';
  const groupedRows = React.useMemo(() => groupConversations(conversations), [conversations]);
  const markReadDisabled =
    !markReadSupported ||
    !actionableUnreadCount ||
    markingRead ||
    syncing ||
    loadingMore ||
    backgroundSyncing ||
    !onMarkAllRead;
  const markReadTooltip = !markReadSupported
    ? markReadUnavailableReason
    : actionableUnreadCount
      ? '全部标记为已读'
      : readOnlyUnreadCount
        ? '当前未读是 Ozon 自动消息/信息推送，Ozon 未提供 chat.read'
        : '当前没有可处理的未读会话';

  React.useEffect(() => {
    if (!onVisibleConversationIdsChange || !listRef.current || typeof IntersectionObserver !== 'function')
      return undefined;
    const visibleIds = new Set();
    let timer = null;
    const emit = () => {
      timer = null;
      onVisibleConversationIdsChange([...visibleIds]);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const id = entry.target.getAttribute('data-customer-conversation-id');
          if (!id) return;
          if (entry.isIntersecting) visibleIds.add(id);
          else visibleIds.delete(id);
        });
        if (timer) globalThis.clearTimeout(timer);
        timer = globalThis.setTimeout(emit, 80);
      },
      { root: listRef.current, threshold: 0.15 }
    );
    listRef.current.querySelectorAll('[data-customer-conversation-id]').forEach((node) => observer.observe(node));
    return () => {
      if (timer) globalThis.clearTimeout(timer);
      observer.disconnect();
    };
  }, [conversations, onVisibleConversationIdsChange]);

  return (
    <Box component="aside" className="customer-chat-list-panel">
      <Box className="customer-chat-list-head">
        <Box className="customer-chat-list-title-row">
          <Typography variant="h6">在线客服</Typography>
          <Box className="customer-chat-list-actions">
            <Button size="small" variant="outlined" onClick={onStartConversation} disabled={!onStartConversation}>
              新建会话
            </Button>
            <Tooltip title={syncError || '刷新当前店铺的 Ozon 会话'}>
              <span>
                <IconButton
                  size="small"
                  aria-label="刷新 Ozon 会话"
                  className={`customer-chat-list-refresh${syncing ? ' loading' : ''}`}
                  onClick={onRefresh}
                  disabled={syncing || !onRefresh}
                >
                  <RefreshRounded fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        </Box>
        <TextField
          size="small"
          fullWidth
          value={searchText}
          placeholder="搜索买家、订单、商品或消息"
          onChange={(event) => onSearchChange(event.target.value)}
          inputProps={{ 'aria-label': '搜索客服会话' }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchRounded fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <Box className="customer-chat-filter-controls">
          <FormControl size="small" fullWidth>
            <InputLabel id="customer-chat-status-filter-label">会话状态</InputLabel>
            <Select
              labelId="customer-chat-status-filter-label"
              value={selectedStatusId}
              label="会话状态"
              onChange={(event) => onSelectStatus(event.target.value)}
            >
              {statusFilters.map((filter) => (
                <MenuItem key={filter.id} value={filter.id}>
                  {filter.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button
            size="small"
            variant={unreadOnly ? 'contained' : 'outlined'}
            onClick={() => onToggleUnread(!unreadOnly)}
            aria-pressed={unreadOnly}
          >
            仅看未读
          </Button>
        </Box>
        <Box className="customer-chat-bulk-row">
          <Typography variant="caption" color="text.secondary">
            可处理未读 <strong>{actionableUnreadCount}</strong>
          </Typography>
          {readOnlyUnreadCount ? (
            <Tooltip
              title={
                '有 ' +
                readOnlyUnreadConversations +
                ' 个只读推送，共 ' +
                readOnlyUnreadCount +
                ' 条未读；不会伪造已读状态'
              }
            >
              <Typography variant="caption" className="customer-chat-readonly-unread">
                只读推送 {readOnlyUnreadCount}
              </Typography>
            </Tooltip>
          ) : null}
          <Tooltip title={markReadTooltip}>
            <span>
              <Button
                size="small"
                variant="text"
                aria-label="全部标记为已读"
                startIcon={<DoneAllRounded />}
                className="customer-chat-mark-all-read"
                onClick={onMarkAllRead}
                disabled={markReadDisabled}
              >
                {markingRead ? '处理中' : '全部已读'}
              </Button>
            </span>
          </Tooltip>
        </Box>
        <Box className="customer-chat-filter-row">
          {filters.map((filter) => {
            const active = filter.id === selectedFilterId;
            return (
              <ButtonBase
                key={filter.id}
                component="button"
                type="button"
                className={`customer-chat-filter${active ? ' active' : ''}`}
                onClick={() => onSelectFilter(filter.id)}
              >
                {filter.label}
              </ButtonBase>
            );
          })}
        </Box>
      </Box>

      <Box ref={listRef} className="customer-chat-list" aria-label="Ozon 会话列表">
        {syncError && conversations.length ? (
          <Alert
            severity="warning"
            className="customer-chat-inline-error"
            action={
              <Button color="inherit" size="small" onClick={onRefresh}>
                重试
              </Button>
            }
          >
            {syncError}
          </Alert>
        ) : null}

        {conversations.length ? (
          <>
            {groupedRows.map(([category, rows]) => (
              <Box className={`customer-chat-list-group ${category}`} key={category}>
                <Box className="customer-chat-list-group-title">
                  <Typography variant="caption">{CATEGORY_LABELS[category] || '其他会话'}</Typography>
                  <Typography variant="caption">{rows.length}</Typography>
                </Box>
                {rows.map((conversation) => (
                  <ConversationItem
                    key={conversation.id}
                    conversation={conversation}
                    translatedPreview={previewTranslations[conversation.id]}
                    active={conversation.id === selectedConversationId}
                    onSelectConversation={onSelectConversation}
                  />
                ))}
              </Box>
            ))}
            <Box className="customer-chat-list-pagination">
              {hasNext && backgroundSyncing ? (
                <Typography variant="caption" color="text.secondary">
                  当前列表可直接使用，后台补全中
                  {totalCount > loadedCount ? ` ${loadedCount}/${totalCount}` : ''}
                </Typography>
              ) : hasNext ? (
                <Button
                  size="small"
                  variant="outlined"
                  onClick={onLoadMore}
                  disabled={loadingMore || !onLoadMore}
                  startIcon={loadingMore ? <CircularProgress size={13} /> : null}
                >
                  {loadingMore ? '正在加载' : '加载更多'}
                </Button>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  没有更多内容
                </Typography>
              )}
              {backgroundError ? (
                <Button size="small" variant="text" onClick={onLoadMore} disabled={loadingMore || !onLoadMore}>
                  继续补全
                </Button>
              ) : null}
            </Box>
          </>
        ) : (
          <Box className="customer-chat-list-empty">
            {syncing ? <CircularProgress size={20} thickness={5} /> : null}
            <Typography variant="body2" color="text.secondary">
              {syncing
                ? '正在读取 Ozon 会话'
                : syncStatus === 'error'
                  ? 'Ozon 会话读取失败'
                  : emptyReason || '没有符合条件的会话'}
            </Typography>
            {syncError ? (
              <>
                <Typography variant="caption" color="error.main">
                  {syncError}
                </Typography>
                <Button size="small" onClick={onRefresh} disabled={!onRefresh}>
                  重试
                </Button>
              </>
            ) : null}
            {!syncing && !syncError && hasNext ? (
              <Button size="small" variant="outlined" onClick={onLoadMore} disabled={loadingMore || !onLoadMore}>
                {loadingMore ? '正在加载' : '继续加载更多会话'}
              </Button>
            ) : null}
          </Box>
        )}
      </Box>
    </Box>
  );
});
