import assert from 'node:assert/strict';
import test from 'node:test';
import { toDateKey } from './dataAnalysisUtils.js';

function original(value) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return '';
  const direct = text.match(/^(\d{4}-\d{2}-\d{2})/u);
  if (direct && !/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text)) return direct[1];
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return byType.year && byType.month && byType.day ? `${byType.year}-${byType.month}-${byType.day}` : date.toISOString().slice(0, 10);
}

test('date bucketing preserves timezone, midnight, historic DST and legacy no-zone rules exactly', () => {
  const values = ['', null, undefined, 0, 'invalid', '2026-99-99', '2026-09-07T23:10:00',
    '2026-09-07T15:59:59.999Z', '2026-09-07T16:00:00.000Z', '1991-04-14T00:00:00Z',
    '1991-09-15T00:00:00Z', '1900-01-01T00:00:00Z', '2026-09-07T23:00:00-05:00'];
  for (let i = 0; i < 1000; i++) values.push(new Date(Date.UTC(2024, 0, 1) + i * 73483211).toISOString());
  for (const value of values) assert.equal(toDateKey(value), original(value), String(value));
});

test('many timestamp rows do not construct a formatter per row', () => {
  const Base = Intl.DateTimeFormat;
  let constructions = 0;
  Intl.DateTimeFormat = new Proxy(Base, { construct(target, args) { constructions++; return new target(...args); } });
  try {
    for (let i = 0; i < 1000; i++) toDateKey('2026-09-07T16:00:00.000Z');
    assert.equal(constructions, 0);
  } finally { Intl.DateTimeFormat = Base; }
});
