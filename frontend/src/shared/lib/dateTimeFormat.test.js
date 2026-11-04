import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { formatLocalChineseDate, formatShopBindingTime } from './dateTimeFormat.js';
import { formatOzonOrderDate } from '../../entities/order/orderShopScope.jsx';

const full = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
const short = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };

it('preserves exact full/short display, midnight, dates and invalid/missing fallback rules', () => {
  for (const value of ['', null, undefined, 0, false]) {
    expect(formatShopBindingTime(value, 'missing')).toBe('missing');
    expect(formatOzonOrderDate(value, 'missing')).toBe('missing');
  }
  expect(formatShopBindingTime('not-a-date')).toBe('not-a-date');
  expect(formatOzonOrderDate('not-a-date')).toBe('not-a-date');
  for (const value of ['2026-09-07T00:00:00', '2026-02-28T23:59:59', '2024-02-29T12:00:00Z', -8640000000000000, 8640000000000000]) {
    const date = new Date(value);
    expect(formatShopBindingTime(value)).toBe(date.toLocaleString('zh-CN', full));
    expect(formatOzonOrderDate(value)).toBe(date.toLocaleString('zh-CN', short));
    expect(formatLocalChineseDate(date)).toBe(date.toLocaleString('zh-CN', full));
  }
});

it('matches old Intl output across timezone changes, DST, fractional offsets and historical dates', () => {
  const url = pathToFileURL(path.resolve('src/shared/lib/dateTimeFormat.js')).href;
  const code = `import assert from 'node:assert/strict';
    import {formatLocalChineseDate} from ${JSON.stringify(url)};
    const full=${JSON.stringify(full)},short=${JSON.stringify(short)};
    let cases=0;
    for(const zone of ['UTC','Asia/Shanghai','Europe/Moscow','America/Los_Angeles','Europe/Berlin','Pacific/Apia','Pacific/Kiritimati','Asia/Kathmandu','Australia/Lord_Howe']) {
      process.env.TZ=zone;
      const dates=[-8640000000000000,8640000000000000,Date.UTC(1900,0,1),Date.UTC(2011,11,30),Date.UTC(2026,2,8,9,59),Date.UTC(2026,10,1,9,0)];
      for(let n=0;n<250;n++)dates.push(Date.UTC(2024,0,1)+n*93712439);
      for(const value of dates)for(const compact of [false,true]) {
        const date=new Date(value);
        assert.equal(formatLocalChineseDate(date,compact),date.toLocaleString('zh-CN',compact?short:full),zone+':'+value);
        cases++;
      }
    }
    console.log(cases);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  expect(Number(result.stdout.trim())).toBe(4608);
});
