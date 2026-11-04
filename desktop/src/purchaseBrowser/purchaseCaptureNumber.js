// One parsing contract for native page readers and the desktop capture adapter.
// The native host embeds this pure module at build time; no runtime source-file
// lookup, currency conversion, or profit/fee rule is involved.
export function parseCaptureNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, 180);
  if (!text) return null;
  const direct = Number(text);
  if (Number.isFinite(direct)) return direct;
  let token = text.replace(/\s/gu, '').match(/[+-]?\d+(?:[.,]\d+)*/u)?.[0];
  if (!token) return null;
  const comma = token.lastIndexOf(',');
  const dot = token.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    // Both conventions carry explicit evidence: 1,299.90 / 1.299,90.
    token = comma > dot ? token.replace(/\./gu, '').replace(',', '.') : token.replace(/,/gu, '');
  } else if (comma >= 0) {
    token = /^[+-]?\d{1,3}(?:,\d{3})+$/u.test(token) ? token.replace(/,/gu, '') : token.replace(',', '.');
  }
  const number = Number(token);
  return Number.isFinite(number) ? number : null;
}
