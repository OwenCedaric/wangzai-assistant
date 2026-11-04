import { SOURCE_LINK_LIMIT } from '../../shared/config/appConfigCore.jsx';
import { getCrossBorderPayload } from '../../shared/ozon/ozonRuntime.jsx';
import { formatPlainNumber } from '../product/productAttributes.jsx';
import { firstFilled, normalizeOzonId } from './orderShopScope.jsx';
import {
  detectSourcePlatformFromLink,
  normalizeProductSourceEntry,
  normalizeProductSourceRecord,
  normalizeSourcePlatformName,
} from './orderSourceRecordRules.jsx';
import {
  formatSourceLinkSummary,
  getSourcePlatformClassName,
  getSourceRecordSlots,
  getSourceSlotLabel,
} from './orderSourceDisplayRules.jsx';
import Box from '@mui/material/Box';
import Popper from '@mui/material/Popper';
import Typography from '@mui/material/Typography';
import React from 'react';

export function SourceLinkDropdownField({
  value,
  record,
  selectedIndex = 0,
  onChange,
  onSelectSlot,
  placeholder = '粘贴货源链接',
  className = '',
  disabled = false,
}) {
  const [anchorEl, setAnchorEl] = React.useState(null);
  const rootRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const normalizedRecord = React.useMemo(() => normalizeProductSourceRecord(record), [record]);
  const slots = React.useMemo(() => getSourceRecordSlots(normalizedRecord), [normalizedRecord]);
  const safeSelectedIndex = Math.max(0, Math.min(Number(selectedIndex) || 0, SOURCE_LINK_LIMIT - 1));
  const selectedEntry = slots[safeSelectedIndex] ?? {};
  const currentValue = String(value || '');
  const currentPlatform = currentValue
    ? normalizeSourcePlatformName(selectedEntry.platform || detectSourcePlatformFromLink(currentValue))
    : '待补录';
  const open = Boolean(anchorEl);

  const openMenu = (event) => {
    if (disabled) return;
    setAnchorEl(rootRef.current || event.currentTarget);
  };

  const closeMenu = () => setAnchorEl(null);

  React.useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      const target = event.target;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeMenu();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const selectSlot = (index, item) => {
    onSelectSlot?.(index, item);
    onChange?.(item?.link || '', index, item);
    closeMenu();
  };

  return (
    <div
      ref={rootRef}
      className={`source-link-dropdown-field ${className}`}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="source-link-input-base source-link-native-input-shell">
        <span className={`source-link-field-chip ${getSourcePlatformClassName(currentPlatform)}`}>
          {currentValue ? currentPlatform : '货源'}
        </span>
        <input
          className="source-link-native-input"
          value={currentValue}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={openMenu}
          onClick={openMenu}
          onChange={(event) => onChange?.(event.target.value, safeSelectedIndex, selectedEntry)}
        />
        <button
          type="button"
          className="source-link-native-toggle"
          aria-label="切换货源链接"
          disabled={disabled}
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openMenu}
        >
          <span aria-hidden="true">⌄</span>
        </button>
      </div>
      {open ? (
        <Popper
          open
          anchorEl={anchorEl}
          placement="bottom-start"
          className="source-link-dropdown-popper"
          modifiers={[
            {
              name: 'offset',
              options: { offset: [0, 6] },
            },
            {
              name: 'preventOverflow',
              options: { padding: 16 },
            },
            {
              name: 'flip',
              options: { padding: 16 },
            },
          ]}
        >
          <Box
            ref={menuRef}
            className="source-link-dropdown-menu"
            style={{ width: Math.max(anchorEl?.offsetWidth || 0, 420) }}
          >
            <Box className="source-link-dropdown-list">
              {slots.map((item, index) => {
                const entry = normalizeProductSourceEntry(item);
                const hasLink = Boolean(entry.link);
                const platform = hasLink ? normalizeSourcePlatformName(entry.platform) : '待补录';
                return (
                  <Box
                    component="button"
                    type="button"
                    key={`source-slot-${index}`}
                    className={`source-link-dropdown-option${index === safeSelectedIndex ? ' selected' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      selectSlot(index, entry);
                    }}
                  >
                    <Box className="source-link-option-text">
                      <Typography variant="body2" className="source-link-option-title">
                        {getSourceSlotLabel(index, normalizedRecord.primaryIndex)}
                      </Typography>
                      <Typography
                        variant="caption"
                        className="source-link-option-link"
                        title={entry.link || '空位，可粘贴保存'}
                      >
                        {formatSourceLinkSummary(entry.link)}
                      </Typography>
                    </Box>
                    <Box component="span" className={`source-link-field-chip ${getSourcePlatformClassName(platform)}`}>
                      {platform}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Popper>
      ) : null}
    </div>
  );
}

export function getSalesOrderStatusTags(order = {}) {
  const currentOrder = order || {};
  return Array.isArray(currentOrder.statusTags) && currentOrder.statusTags.length
    ? currentOrder.statusTags
    : [currentOrder.status].filter(Boolean);
}

export function getCrossBorderOrderId(item = {}) {
  const safeItem = item && typeof item === 'object' ? item : {};
  return normalizeOzonId(firstFilled(safeItem.id, safeItem.order_id, safeItem.orderId, safeItem.platform_order));
}

export function getCrossBorderStatusLabel(source = {}) {
  const direct = firstFilled(source.status_name, source.statusName, source.status_type, source.status);
  if (direct) return String(direct);
  const orderStatus = String(firstFilled(source.order_status, source.orderStatus));
  if (source.is_question === 1 || source.is_question === '1') return '问题件';
  if (source.is_delete === 1 || source.is_delete === 2 || source.is_delete === '1' || source.is_delete === '2')
    return '已删除';
  if (String(firstFilled(source.data_status, source.dataStatus)) === '0') return '草稿';
  if (orderStatus === '0') return '待打包';
  if (orderStatus === '1') return '已打包';
  if (orderStatus === '3') return '已发货';
  return '未返回';
}

export function getCrossBorderPayloadObject(data) {
  const payload = getCrossBorderPayload(data);
  if (Array.isArray(payload)) return payload[0] ?? {};
  if (Array.isArray(payload?.list)) return payload.list[0] ?? {};
  return payload && typeof payload === 'object' ? payload : {};
}

export function formatCrossBorderWeight(value) {
  const text = formatPlainNumber(value);
  return text ? `${text} kg` : '未返回';
}

export function formatCrossBorderSize(source = {}) {
  const primaryVolume = Array.isArray(source.volume) && source.volume[0] ? source.volume[0] : {};
  const sizeSource = Object.keys(primaryVolume).length ? primaryVolume : source;
  const length = formatPlainNumber(
    firstFilled(sizeSource.long, sizeSource.length, sizeSource.package_long, sizeSource.packageLength)
  );
  const width = formatPlainNumber(firstFilled(sizeSource.width, sizeSource.package_width, sizeSource.packageWidth));
  const height = formatPlainNumber(firstFilled(sizeSource.height, sizeSource.package_height, sizeSource.packageHeight));
  if (!length || !width || !height) return '未返回';
  return `${length} cm x ${width} cm x ${height} cm`;
}

export function normalizeCrossBorderOrderInfo(orderItem = {}, statusPayload = null, outPayload = null) {
  const statusInfo = statusPayload ? getCrossBorderPayloadObject(statusPayload) : {};
  const outInfo = outPayload ? getCrossBorderPayloadObject(outPayload) : {};
  const packages = Array.isArray(orderItem.package_list) ? orderItem.package_list : [];
  const firstPackage = packages[0] ?? {};
  const weightSource = firstFilled(outInfo.weight, outInfo.grossweight, outInfo.chargeweight, firstPackage.weight);
  const statusSource = Object.keys(statusInfo).length ? statusInfo : orderItem;

  return {
    orderId: getCrossBorderOrderId(orderItem) || getCrossBorderOrderId(statusInfo) || '未返回',
    packageWeight: formatCrossBorderWeight(weightSource),
    packageSize: formatCrossBorderSize(Object.keys(outInfo).length ? outInfo : firstPackage),
    readStatus: getCrossBorderStatusLabel(statusSource),
    warehouse:
      firstFilled(
        orderItem.storehouse_name,
        orderItem.storehouseName,
        orderItem.warehouse,
        orderItem.warehouse_name,
        statusInfo.storehouse_name,
        statusInfo.storehouseName
      ) || '未返回',
  };
}
