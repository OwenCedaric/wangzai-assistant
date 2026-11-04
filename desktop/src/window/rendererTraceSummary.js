export const RENDERER_TRACE_CATEGORIES = [
  "devtools.timeline",
  "blink.user_timing",
  "disabled-by-default-devtools.timeline",
].join(",");

export function getRendererTraceCategories() {
  if (process.env.WANGZAI_PERFORMANCE_TRACE_DEEP !== "1") {
    return RENDERER_TRACE_CATEGORIES;
  }
  return [
    RENDERER_TRACE_CATEGORIES,
    "disabled-by-default-devtools.timeline.invalidationTracking",
  ].join(",");
}

export function summarizeRendererTrace(tracePayload) {
  let traceEvents = [];
  try {
    const parsedTrace = JSON.parse(tracePayload);
    traceEvents = Array.isArray(parsedTrace?.traceEvents) ? parsedTrace.traceEvents : [];
  } catch (_error) {
    return { eventCount: 0, completeEventCount: 0, topCompleteEvents: [] };
  }

  const completeEvents = traceEvents
    .filter((event) => event?.ph === "X" && Number.isFinite(Number(event?.dur)) && Number(event.dur) > 0)
    .map((event) => ({
      category: String(event.cat || ""),
      name: String(event.name || "unknown"),
      durationMs: Number((Number(event.dur) / 1000).toFixed(3)),
    }));
  return {
    eventCount: traceEvents.length,
    completeEventCount: completeEvents.length,
    topCompleteEvents: completeEvents
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 16),
    invalidationCount: traceEvents.filter((event) =>
      String(event?.name || "").includes("InvalidationTracking"),
    ).length,
    topInvalidations: Object.entries(
      traceEvents
        .filter((event) => String(event?.name || "").includes("InvalidationTracking"))
        .reduce((summary, event) => {
          const data = event?.args?.data || {};
          const nodeName = String(data.nodeName || "unknown").split(/\s+class=/u)[0];
          const reason = String(data.reason || event.name || "unknown");
          const key = `${reason} | ${nodeName}`;
          summary[key] = (summary[key] || 0) + 1;
          return summary;
        }, {}),
    )
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 16),
  };
}

export async function readRendererTraceStream(debuggerSession, stream) {
  const chunks = [];
  let eof = false;
  try {
    while (!eof) {
      const chunk = await debuggerSession.sendCommand("IO.read", { handle: stream, size: 1_000_000 });
      chunks.push(String(chunk?.data || ""));
      eof = Boolean(chunk?.eof);
    }
  } finally {
    await debuggerSession.sendCommand("IO.close", { handle: stream }).catch(() => undefined);
  }
  return chunks.join("");
}
