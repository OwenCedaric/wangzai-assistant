const DEFAULT_EXCHANGE_TIMEOUT_MS = 8000;
const DEFAULT_DAILY_LOOKBACK_DAYS = 10;
const RUB_CNY_REALTIME_URL = "https://open.er-api.com/v6/latest/RUB";
const RUB_CNY_CBR_DAILY_URL = "https://www.cbr.ru/scripts/XML_daily.asp";
const RUB_CNY_CBR_DYNAMIC_URL = "https://www.cbr.ru/scripts/XML_dynamic.asp";
const RUB_CNY_CBR_CURRENCY_ID = "R01375";
const RUB_CNY_DAILY_URL_BASE = "https://www.cbr-xml-daily.ru/archive";
const RUB_CNY_LATEST_DAILY_URL = "https://www.cbr-xml-daily.ru/daily_json.js";

function nowIso(now) {
  const value = typeof now === "function" ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date().toISOString();
}

function normalizeRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function normalizeDateKey(value) {
  const text = String(value || "")
    .trim()
    .slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return "";
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && getUtcDateKey(date) === text
    ? text
    : "";
}

function getUtcDateKey(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function shiftDateKey(dateKey, offsetDays) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return getUtcDateKey(date);
}

function normalizeLookbackDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return DEFAULT_DAILY_LOOKBACK_DAYS;
  return Math.max(0, Math.min(Math.floor(days), 30));
}

function buildDailyRubCnyUrl(dateKey) {
  const [year, month, day] = dateKey.split("-");
  return `${RUB_CNY_DAILY_URL_BASE}/${encodeURIComponent(year)}/${encodeURIComponent(month)}/${encodeURIComponent(day)}/daily_json.js`;
}

function formatCbrDate(dateKey) {
  const [year, month, day] = String(dateKey || "").split("-");
  return year && month && day ? `${day}/${month}/${year}` : "";
}

function parseCbrDateKey(value) {
  const match = String(value || "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/u);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

function parseCbrNumber(value) {
  return normalizeRate(
    String(value || "")
      .replace(/\s+/gu, "")
      .replace(",", "."),
  );
}

function buildCbrDailyRubCnyUrl(dateKey) {
  return `${RUB_CNY_CBR_DAILY_URL}?date_req=${encodeURIComponent(formatCbrDate(dateKey))}`;
}

function buildCbrDynamicRubCnyUrl(startDate, endDate) {
  const query = new URLSearchParams({
    date_req1: formatCbrDate(startDate),
    date_req2: formatCbrDate(endDate),
    VAL_NM_RQ: RUB_CNY_CBR_CURRENCY_ID,
  });
  return `${RUB_CNY_CBR_DYNAMIC_URL}?${query.toString()}`;
}

function normalizeCbrDailyXml(xml, fallbackDate = "") {
  const source = String(xml || "");
  const block = [...source.matchAll(/<Valute\b[^>]*>[\s\S]*?<\/Valute>/gu)]
    .map((match) => match[0])
    .find((value) => /<CharCode>CNY<\/CharCode>/u.test(value));
  if (!block) return null;
  const nominal = parseCbrNumber(
    block.match(/<Nominal>([^<]+)<\/Nominal>/u)?.[1],
  );
  const value = parseCbrNumber(block.match(/<Value>([^<]+)<\/Value>/u)?.[1]);
  const rate = nominal && value ? normalizeRate(nominal / value) : null;
  if (rate === null) return null;
  const providerDate =
    parseCbrDateKey(source.match(/<ValCurs\b[^>]*\bDate="([^"]+)"/u)?.[1]) ||
    fallbackDate;
  return { date: providerDate, rate };
}

function normalizeCbrDynamicXml(xml) {
  const source = String(xml || "");
  const rows = [];
  for (const match of source.matchAll(
    /<Record\b[^>]*\bDate="([^"]+)"[^>]*>([\s\S]*?)<\/Record>/gu,
  )) {
    const date = parseCbrDateKey(match[1]);
    const nominal = parseCbrNumber(
      match[2].match(/<Nominal>([^<]+)<\/Nominal>/u)?.[1],
    );
    const value = parseCbrNumber(
      match[2].match(/<Value>([^<]+)<\/Value>/u)?.[1],
    );
    const rate = nominal && value ? normalizeRate(nominal / value) : null;
    if (date && rate !== null) rows.push({ date, rate });
  }
  return rows.sort((left, right) => left.date.localeCompare(right.date));
}

function getDateDistanceDays(laterDateKey, earlierDateKey) {
  const later = new Date(`${laterDateKey}T00:00:00.000Z`);
  const earlier = new Date(`${earlierDateKey}T00:00:00.000Z`);
  if (
    !Number.isFinite(later.getTime()) ||
    !Number.isFinite(earlier.getTime())
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
}

function normalizeDailyRubCnyRate(payload) {
  const directRate = normalizeRate(payload?.rates?.CNY);
  if (directRate !== null) return directRate;

  const cny = payload?.Valute?.CNY;
  const nominal = Number(cny?.Nominal);
  const value = Number(cny?.Value);
  if (
    Number.isFinite(nominal) &&
    nominal > 0 &&
    Number.isFinite(value) &&
    value > 0
  ) {
    return normalizeRate(nominal / value);
  }
  return null;
}

function normalizeProviderDate(payload, fallbackDate = "") {
  return (
    normalizeDateKey(payload?.date) ||
    normalizeDateKey(payload?.Date) ||
    normalizeDateKey(payload?.Timestamp) ||
    fallbackDate
  );
}

function buildErrorPayload({
  mode,
  date = "",
  code = "EXCHANGE_RATE_UNAVAILABLE",
  message,
  cause,
}) {
  return {
    ok: false,
    mode,
    base: "RUB",
    quote: "CNY",
    date: date || undefined,
    error: {
      code,
      message: message || "卢布兑人民币汇率读取失败。",
      cause:
        cause instanceof Error
          ? cause.message
          : cause
            ? String(cause)
            : undefined,
    },
  };
}

async function fetchJsonWithTimeout(
  fetchImpl,
  url,
  { timeoutMs = DEFAULT_EXCHANGE_TIMEOUT_MS, signal } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node 运行时不可用 fetch，无法读取汇率。");
  }
  const controller = new AbortController();
  const safeTimeoutMs = Math.max(
    1,
    Number(timeoutMs) || DEFAULT_EXCHANGE_TIMEOUT_MS,
  );
  const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`汇率接口 HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`汇率接口请求超时 ${safeTimeoutMs}ms`);
      timeoutError.code = "EXCHANGE_RATE_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function fetchTextWithTimeout(
  fetchImpl,
  url,
  { timeoutMs = DEFAULT_EXCHANGE_TIMEOUT_MS, signal } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node 运行时不可用 fetch，无法读取汇率。");
  }
  const controller = new AbortController();
  const safeTimeoutMs = Math.max(
    1,
    Number(timeoutMs) || DEFAULT_EXCHANGE_TIMEOUT_MS,
  );
  const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/xml,text/xml;q=0.9,*/*;q=0.8" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`汇率接口 HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.text();
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`汇率接口请求超时 ${safeTimeoutMs}ms`);
      timeoutError.code = "EXCHANGE_RATE_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export function createExchangeRateService({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const dailyRateCache = new Map();
  const dailyBatchInflight = new Map();

  async function readRealtimeRubCnyRate(options = {}) {
    try {
      const payload = await fetchJsonWithTimeout(
        fetchImpl,
        RUB_CNY_REALTIME_URL,
        options,
      );
      const rate = normalizeDailyRubCnyRate(payload);
      if (rate === null) {
        return buildErrorPayload({
          mode: "realtime",
          code: "EXCHANGE_RATE_RATE_MISSING",
          message: "实时汇率接口未返回有效 RUB/CNY。",
        });
      }
      return {
        ok: true,
        mode: "realtime",
        base: "RUB",
        quote: "CNY",
        rate,
        rubToCnyRate: rate,
        source: "exchange-rate-api-open",
        providerUrl: RUB_CNY_REALTIME_URL,
        providerTimestamp:
          payload?.time_last_update_unix || payload?.time_last_update_utc || "",
        fetchedAt: nowIso(now),
      };
    } catch (error) {
      return buildErrorPayload({ mode: "realtime", cause: error });
    }
  }

  async function readDailyRubCnyRate(
    {
      date,
      allowNearest = true,
      maxLookbackDays = DEFAULT_DAILY_LOOKBACK_DAYS,
    } = {},
    options = {},
  ) {
    const dateKey = normalizeDateKey(date);
    if (!dateKey) {
      return buildErrorPayload({
        mode: "daily",
        code: "EXCHANGE_RATE_DATE_REQUIRED",
        message: "日汇率需要 YYYY-MM-DD 日期。",
      });
    }

    const lookbackDays =
      allowNearest === false ? 0 : normalizeLookbackDays(maxLookbackDays);
    const cached = dailyRateCache.get(dateKey);
    if (cached && (allowNearest !== false || cached.date === dateKey)) {
      return { ...cached };
    }

    const officialUrl = buildCbrDailyRubCnyUrl(dateKey);
    try {
      const xml = await fetchTextWithTimeout(fetchImpl, officialUrl, options);
      const normalized = normalizeCbrDailyXml(xml, dateKey);
      if (normalized) {
        const distance = getDateDistanceDays(dateKey, normalized.date);
        if (
          normalized.date === dateKey ||
          (allowNearest !== false && distance >= 0 && distance <= lookbackDays)
        ) {
          const result = {
            ok: true,
            mode: "daily",
            requestedDate: dateKey,
            date: normalized.date,
            providerDate: normalized.date,
            nearestFallback: normalized.date !== dateKey,
            lookbackDaysUsed: normalized.date === dateKey ? 0 : distance,
            base: "RUB",
            quote: "CNY",
            rate: normalized.rate,
            rubToCnyRate: normalized.rate,
            source: "cbr-official",
            providerUrl: officialUrl,
            fetchedAt: nowIso(now),
          };
          dailyRateCache.set(dateKey, result);
          return { ...result };
        }
      }
    } catch {
      // 官方日汇率不可达时再进入镜像兜底；不影响既有来源兼容性。
    }

    const errors = [];
    for (let offset = 0; offset <= lookbackDays; offset += 1) {
      const candidateDate = shiftDateKey(dateKey, -offset);
      if (!candidateDate) continue;
      const url = buildDailyRubCnyUrl(candidateDate);
      try {
        const payload = await fetchJsonWithTimeout(fetchImpl, url, options);
        const rate = normalizeDailyRubCnyRate(payload);
        if (rate === null) {
          errors.push({
            date: candidateDate,
            error: new Error("日汇率接口未返回有效 RUB/CNY。"),
          });
          continue;
        }
        const providerDate = normalizeProviderDate(payload, candidateDate);
        return {
          ok: true,
          mode: "daily",
          requestedDate: dateKey,
          date: providerDate,
          providerDate,
          nearestFallback:
            providerDate !== dateKey || candidateDate !== dateKey,
          lookbackDaysUsed: offset,
          base: "RUB",
          quote: "CNY",
          rate,
          rubToCnyRate: rate,
          source: "cbr-daily",
          providerUrl: url,
          fetchedAt: nowIso(now),
        };
      } catch (error) {
        errors.push({ date: candidateDate, error });
      }
    }

    if (allowNearest !== false) {
      try {
        const payload = await fetchJsonWithTimeout(
          fetchImpl,
          RUB_CNY_LATEST_DAILY_URL,
          options,
        );
        const rate = normalizeDailyRubCnyRate(payload);
        if (rate !== null) {
          const providerDate = normalizeProviderDate(payload);
          return {
            ok: true,
            mode: "daily",
            requestedDate: dateKey,
            date: providerDate,
            providerDate,
            nearestFallback: true,
            lookbackDaysUsed: null,
            base: "RUB",
            quote: "CNY",
            rate,
            rubToCnyRate: rate,
            source: "cbr-daily-latest",
            providerUrl: RUB_CNY_LATEST_DAILY_URL,
            fetchedAt: nowIso(now),
          };
        }
        errors.push({
          date: "latest",
          error: new Error("最近可取日汇率接口未返回有效 RUB/CNY。"),
        });
      } catch (error) {
        errors.push({ date: "latest", error });
      }
    }

    return buildErrorPayload({
      mode: "daily",
      date: dateKey,
      code: "EXCHANGE_RATE_NEAREST_UNAVAILABLE",
      message: `最近 ${lookbackDays} 天未取到有效 RUB/CNY 日汇率。`,
      cause: errors[0]?.error,
    });
  }

  async function readDailyRubCnyRates(
    {
      dates = [],
      allowNearest = true,
      maxLookbackDays = DEFAULT_DAILY_LOOKBACK_DAYS,
    } = {},
    options = {},
  ) {
    const dateKeys = [
      ...new Set(
        (Array.isArray(dates) ? dates : [])
          .map(normalizeDateKey)
          .filter(Boolean),
      ),
    ].sort();
    if (!dateKeys.length) {
      return buildErrorPayload({
        mode: "daily-batch",
        code: "EXCHANGE_RATE_DATES_REQUIRED",
        message: "批量日汇率至少需要一个 YYYY-MM-DD 日期。",
      });
    }

    const lookbackDays =
      allowNearest === false ? 0 : normalizeLookbackDays(maxLookbackDays);
    const cachedRates = [];
    const missingDateKeys = [];
    dateKeys.forEach((dateKey) => {
      const cached = dailyRateCache.get(dateKey);
      if (cached && (allowNearest !== false || cached.date === dateKey)) {
        cachedRates.push({ ...cached });
      } else {
        missingDateKeys.push(dateKey);
      }
    });
    if (!missingDateKeys.length) {
      return {
        ok: true,
        mode: "daily-batch",
        base: "RUB",
        quote: "CNY",
        rates: cachedRates,
        errors: [],
        source: "cbr-official-dynamic",
        fetchedAt: nowIso(now),
      };
    }

    const inflightKey = `${missingDateKeys.join(",")}|${allowNearest !== false}|${lookbackDays}`;
    const activeRequest = dailyBatchInflight.get(inflightKey);
    if (activeRequest) {
      const payload = await activeRequest;
      return {
        ...payload,
        rates: [...cachedRates, ...(payload.rates || [])].sort((left, right) =>
          String(left.requestedDate).localeCompare(String(right.requestedDate)),
        ),
      };
    }

    const requestPromise = (async () => {
      const rangeStart = shiftDateKey(missingDateKeys[0], -lookbackDays);
      const rangeEnd = missingDateKeys[missingDateKeys.length - 1];
      const providerUrl = buildCbrDynamicRubCnyUrl(rangeStart, rangeEnd);
      try {
        const xml = await fetchTextWithTimeout(fetchImpl, providerUrl, options);
        const providerRows = normalizeCbrDynamicXml(xml);
        if (!providerRows.length) {
          return buildErrorPayload({
            mode: "daily-batch",
            code: "EXCHANGE_RATE_RATE_MISSING",
            message: "官方批量日汇率接口未返回有效 RUB/CNY。",
          });
        }

        const rates = [];
        const errors = [];
        missingDateKeys.forEach((requestedDate) => {
          const providerRow = [...providerRows]
            .reverse()
            .find((row) => row.date <= requestedDate);
          const distance = providerRow
            ? getDateDistanceDays(requestedDate, providerRow.date)
            : Number.POSITIVE_INFINITY;
          const allowed =
            providerRow &&
            (providerRow.date === requestedDate ||
              (allowNearest !== false &&
                distance >= 0 &&
                distance <= lookbackDays));
          if (!allowed) {
            errors.push({
              requestedDate,
              error: {
                code: "EXCHANGE_RATE_NEAREST_UNAVAILABLE",
                message: `${requestedDate} 未取到允许范围内的 RUB/CNY 日汇率。`,
              },
            });
            return;
          }
          const result = {
            ok: true,
            mode: "daily",
            requestedDate,
            date: providerRow.date,
            providerDate: providerRow.date,
            nearestFallback: providerRow.date !== requestedDate,
            lookbackDaysUsed: providerRow.date === requestedDate ? 0 : distance,
            base: "RUB",
            quote: "CNY",
            rate: providerRow.rate,
            rubToCnyRate: providerRow.rate,
            source: "cbr-official-dynamic",
            providerUrl,
            fetchedAt: nowIso(now),
          };
          dailyRateCache.set(requestedDate, result);
          rates.push(result);
        });
        return {
          ok: rates.length > 0,
          mode: "daily-batch",
          base: "RUB",
          quote: "CNY",
          rates,
          errors,
          source: "cbr-official-dynamic",
          providerUrl,
          fetchedAt: nowIso(now),
        };
      } catch (error) {
        return buildErrorPayload({
          mode: "daily-batch",
          code: error?.code || "EXCHANGE_RATE_UNAVAILABLE",
          message: "官方批量日汇率读取失败。",
          cause: error,
        });
      }
    })();

    dailyBatchInflight.set(inflightKey, requestPromise);
    try {
      const payload = await requestPromise;
      return {
        ...payload,
        rates: [...cachedRates, ...(payload.rates || [])].sort((left, right) =>
          String(left.requestedDate).localeCompare(String(right.requestedDate)),
        ),
      };
    } finally {
      dailyBatchInflight.delete(inflightKey);
    }
  }

  return {
    readRealtimeRubCnyRate,
    readDailyRubCnyRate,
    readDailyRubCnyRates,
  };
}

export const exchangeRateServiceConstants = {
  RUB_CNY_REALTIME_URL,
  RUB_CNY_CBR_DAILY_URL,
  RUB_CNY_CBR_DYNAMIC_URL,
  RUB_CNY_CBR_CURRENCY_ID,
  RUB_CNY_DAILY_URL_BASE,
  RUB_CNY_LATEST_DAILY_URL,
  DEFAULT_DAILY_LOOKBACK_DAYS,
};
