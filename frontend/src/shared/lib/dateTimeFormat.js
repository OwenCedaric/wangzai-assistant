const fullOptions = {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
};
const shortOptions = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
const localDateFormatters = new Map();

export function formatLocalChineseDate(date, short = false) {
  const options = short ? shortOptions : fullOptions;
  // Capture the current local wall-clock fields before using a reusable UTC
  // formatter. This preserves DST/OS-timezone changes without retaining an
  // obsolete implicit timezone or constructing an Intl formatter for each row.
  const wallClock = new Date(date.getTime());
  wallClock.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  wallClock.setUTCHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  if (!Number.isFinite(wallClock.getTime())) return date.toLocaleString('zh-CN', options);
  if (!localDateFormatters.has(short)) {
    localDateFormatters.set(short, new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: 'UTC' }));
  }
  return localDateFormatters.get(short).format(wallClock);
}

export function formatShopBindingTime(value, fallback = '未确认') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return formatLocalChineseDate(date);
}
