const DEFAULT_MAX_AGE_MS = 120_000;

function normalizeText(value) {
  return String(value ?? '').trim();
}

export function inspectPaidPromotionAiSnapshot(overview, nowMs = Date.now()) {
  if (!overview?.ok) {
    return { ready: false, reason: '推广数据尚未读取成功。', ageMs: null, incompleteDataSets: [] };
  }
  const readiness = overview.aiReadiness || {};
  const capturedAt = normalizeText(readiness.capturedAt || overview.freshness?.capturedAt || overview.finishedAt);
  const capturedAtMs = Date.parse(capturedAt);
  const ageMs = Number.isFinite(capturedAtMs) ? Math.max(0, nowMs - capturedAtMs) : null;
  const maxAgeMs = Number(readiness.maxAgeMs) > 0 ? Number(readiness.maxAgeMs) : DEFAULT_MAX_AGE_MS;
  const incompleteDataSets = Array.isArray(readiness.incompleteDataSets)
    ? readiness.incompleteDataSets.map(normalizeText).filter(Boolean)
    : [];
  if (overview.cache?.fallback === true || overview.freshness?.live === false) {
    return { ready: false, reason: '当前是本地秒开快照，必须等待本次实时读取后再交给 AI。', ageMs, incompleteDataSets };
  }
  if (readiness.ready !== true) {
    return {
      ready: false,
      reason: normalizeText(readiness.reason) || '推广数据集尚未完整返回。',
      ageMs,
      incompleteDataSets,
    };
  }
  if (ageMs === null || ageMs > maxAgeMs) {
    return { ready: false, reason: '推广数据已超过 AI 决策新鲜度，必须先实时刷新。', ageMs, incompleteDataSets };
  }
  return { ready: true, reason: '', ageMs, incompleteDataSets: [] };
}

export function requirePaidPromotionAiSnapshot(overview, nowMs = Date.now()) {
  const inspection = inspectPaidPromotionAiSnapshot(overview, nowMs);
  if (!inspection.ready) {
    const error = new Error(inspection.reason);
    error.code = 'PAID_PROMOTION_AI_SNAPSHOT_NOT_READY';
    error.details = inspection;
    throw error;
  }
  return overview;
}

