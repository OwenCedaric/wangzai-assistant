import { SOURCE_LINK_LIMIT } from '../../shared/config/appConfigCore.jsx';
import {
  detectSourcePlatformFromLink,
  normalizeProductSourceRecord,
  normalizeSourcePlatformName,
} from './orderSourceRecordRules.jsx';

export function getSourceSlotLabel(index, primaryIndex = 0) {
  if (index === primaryIndex) return '主货源';
  return `备用${index}`;
}

export function getSourcePlatformClassName(platform = '') {
  const normalized = normalizeSourcePlatformName(platform);
  if (normalized === 'PDD') return 'platform-pdd';
  if (normalized === '1688') return 'platform-1688';
  if (normalized === '淘宝') return 'platform-taobao';
  if (normalized === '天猫') return 'platform-tmall';
  if (normalized === 'Ozon买家') return 'platform-ozon-buyer';
  if (normalized === '待补录') return 'platform-pending';
  return 'platform-other';
}

export function getSourceRecordSlots(record = {}) {
  const normalizedRecord = normalizeProductSourceRecord(record);
  return Array.from(
    { length: SOURCE_LINK_LIMIT },
    (_, index) =>
      normalizedRecord.links[index] ?? {
        link: '',
        productId: '',
        platform: index === normalizedRecord.primaryIndex ? '待补录' : '其他',
      }
  );
}

export function formatSourceLinkSummary(link = '') {
  const text = String(link || '').trim();
  if (!text) return '空位，可粘贴保存';
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname}`.replace(/\/$/, '') || text;
  } catch {
    return text;
  }
}

export function getSourcePlatformForLink(link = '', fallback = '待补录') {
  return normalizeSourcePlatformName(link ? detectSourcePlatformFromLink(link) : fallback);
}
