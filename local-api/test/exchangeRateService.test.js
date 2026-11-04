import assert from "node:assert/strict";
import test from "node:test";
import { createExchangeRateService } from "../src/domain/exchange/exchangeRateService.js";

function createFetch(payloadByUrl = {}) {
  return async (url) => {
    const payload =
      typeof payloadByUrl === "function"
        ? payloadByUrl(String(url))
        : payloadByUrl[String(url)];
    if (payload instanceof Error) throw payload;
    return {
      ok: payload?.ok !== false,
      status: payload?.status || 200,
      async json() {
        return payload?.body ?? payload;
      },
      async text() {
        const body = payload?.body ?? payload;
        return typeof body === "string" ? body : JSON.stringify(body);
      },
    };
  };
}

test("exchange rate service returns realtime RUB/CNY only from realtime provider", async () => {
  const service = createExchangeRateService({
    fetchImpl: createFetch((url) => {
      assert.equal(url, "https://open.er-api.com/v6/latest/RUB");
      return {
        result: "success",
        rates: { CNY: 0.09123 },
        time_last_update_unix: 123,
      };
    }),
    now: () => new Date("2026-07-04T10:00:00.000Z"),
  });

  const result = await service.readRealtimeRubCnyRate();
  assert.equal(result.ok, true);
  assert.equal(result.mode, "realtime");
  assert.equal(result.rubToCnyRate, 0.09123);
  assert.equal(result.source, "exchange-rate-api-open");
});

test("exchange rate service returns daily RUB/CNY from the official CBR date provider", async () => {
  const service = createExchangeRateService({
    fetchImpl: createFetch((url) => {
      assert.equal(
        url,
        "https://www.cbr.ru/scripts/XML_daily.asp?date_req=03%2F07%2F2026",
      );
      return `<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="03.07.2026"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>90,0000</Value></Valute><Valute><CharCode>CNY</CharCode><Nominal>1</Nominal><Value>11,1111</Value></Valute></ValCurs>`;
    }),
  });

  const result = await service.readDailyRubCnyRate({ date: "2026-07-03" });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "daily");
  assert.equal(result.date, "2026-07-03");
  assert.equal(result.rubToCnyRate, 1 / 11.1111);
  assert.equal(result.source, "cbr-official");
});

test("exchange rate service uses nearest previous daily rate when requested date has no rate", async () => {
  const calls = [];
  const service = createExchangeRateService({
    fetchImpl: createFetch((url) => {
      calls.push(url);
      return `<?xml version="1.0"?><ValCurs Date="03.07.2026"><Valute><CharCode>CNY</CharCode><Nominal>1</Nominal><Value>11,415525114155252</Value></Valute></ValCurs>`;
    }),
  });

  const result = await service.readDailyRubCnyRate({
    date: "2026-07-04",
    maxLookbackDays: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.requestedDate, "2026-07-04");
  assert.equal(result.date, "2026-07-03");
  assert.equal(result.nearestFallback, true);
  assert.equal(result.lookbackDaysUsed, 1);
  assert.equal(result.rubToCnyRate, 0.0876);
  assert.deepEqual(calls, [
    "https://www.cbr.ru/scripts/XML_daily.asp?date_req=04%2F07%2F2026",
  ]);
});

test("exchange rate service reads a requested date range with one official batch request", async () => {
  const calls = [];
  const service = createExchangeRateService({
    fetchImpl: createFetch((url) => {
      calls.push(url);
      return `<?xml version="1.0"?><ValCurs><Record Date="02.07.2026"><Nominal>1</Nominal><Value>11,2000</Value></Record><Record Date="03.07.2026"><Nominal>1</Nominal><Value>11,4000</Value></Record></ValCurs>`;
    }),
    now: () => new Date("2026-07-04T10:00:00.000Z"),
  });

  const result = await service.readDailyRubCnyRates({
    dates: ["2026-07-03", "2026-07-04"],
    maxLookbackDays: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.rates.length, 2);
  assert.deepEqual(
    result.rates.map((item) => ({
      requestedDate: item.requestedDate,
      date: item.date,
      nearestFallback: item.nearestFallback,
    })),
    [
      {
        requestedDate: "2026-07-03",
        date: "2026-07-03",
        nearestFallback: false,
      },
      {
        requestedDate: "2026-07-04",
        date: "2026-07-03",
        nearestFallback: true,
      },
    ],
  );
  assert.equal(result.rates[0].source, "cbr-official-dynamic");
  assert.equal(calls.length, 1);
  assert.match(
    calls[0],
    /^https:\/\/www\.cbr\.ru\/scripts\/XML_dynamic\.asp\?/u,
  );
  assert.match(calls[0], /date_req1=30%2F06%2F2026/u);
  assert.match(calls[0], /date_req2=04%2F07%2F2026/u);
  assert.match(calls[0], /VAL_NM_RQ=R01375/u);
});

test("exchange rate service uses latest obtainable daily rate after lookback misses", async () => {
  const calls = [];
  const service = createExchangeRateService({
    fetchImpl: createFetch((url) => {
      calls.push(url);
      if (url === "https://www.cbr-xml-daily.ru/daily_json.js") {
        return {
          Date: "2026-07-04T11:30:00+03:00",
          Valute: { CNY: { Nominal: 1, Value: 11.3803 } },
        };
      }
      return { ok: false, status: 404 };
    }),
  });

  const result = await service.readDailyRubCnyRate({
    date: "2026-08-01",
    maxLookbackDays: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.requestedDate, "2026-08-01");
  assert.equal(result.date, "2026-07-04");
  assert.equal(result.nearestFallback, true);
  assert.equal(result.lookbackDaysUsed, null);
  assert.equal(result.source, "cbr-daily-latest");
  assert.equal(result.rubToCnyRate, 1 / 11.3803);
  assert.deepEqual(calls, [
    "https://www.cbr.ru/scripts/XML_daily.asp?date_req=01%2F08%2F2026",
    "https://www.cbr-xml-daily.ru/archive/2026/08/01/daily_json.js",
    "https://www.cbr-xml-daily.ru/archive/2026/07/31/daily_json.js",
    "https://www.cbr-xml-daily.ru/daily_json.js",
  ]);
});

test("exchange rate service does not fabricate fallback rate", async () => {
  const service = createExchangeRateService({
    fetchImpl: createFetch({
      "https://open.er-api.com/v6/latest/RUB": { result: "success", rates: {} },
    }),
  });

  const result = await service.readRealtimeRubCnyRate();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EXCHANGE_RATE_RATE_MISSING");
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, "rubToCnyRate"),
    false,
  );
});
