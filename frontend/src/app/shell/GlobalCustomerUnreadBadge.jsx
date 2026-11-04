import badgeImage from '../../assets/buyer-message-assistant-badge-hd.png';
import ButtonBase from '@mui/material/ButtonBase';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';

function normalizeUnreadCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function GlobalCustomerUnreadBadge({ unreadCount = 0, latest = null, onClick }) {
  const count = normalizeUnreadCount(unreadCount);
  if (!count) return null;
  const detail = [latest?.shopName, latest?.customerName].filter(Boolean).join(' · ');
  const tooltip = detail ? `${count} 条买家消息 · ${detail}` : `${count} 条买家消息`;

  return (
    <Tooltip title={tooltip} placement="left">
      <span className="global-customer-unread-badge">
        <ButtonBase
          className="global-customer-unread-badge-button"
          onClick={onClick}
          aria-label={`打开在线客服，当前有 ${count} 条未读买家消息`}
        >
          <img src={badgeImage} alt="" draggable="false" />
        </ButtonBase>
        <span className="global-customer-unread-badge-count" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      </span>
    </Tooltip>
  );
}

export default GlobalCustomerUnreadBadge;
