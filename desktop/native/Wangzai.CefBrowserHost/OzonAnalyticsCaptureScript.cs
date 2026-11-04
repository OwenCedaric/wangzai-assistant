using System.Text.Json;
using System.Text.Json.Nodes;

namespace Wangzai.CefBrowserHost;

internal static class OzonAnalyticsCaptureScript
{
	public static string RequireVersion(string script, string expectedVersion) => $$"""
(() => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  if (runtime && String(runtime.version || '') !== {{JsonSerializer.Serialize(expectedVersion)}})
    throw new Error('OZON_DATA_OBSERVER_RESTART_REQUIRED');
  if (runtime && Number(runtime.status?.()?.frameCapture?.scopeFailures || 0) > 0)
    throw new Error('OZON_DATA_FRAME_SCOPE_UNVERIFIED');
  return ({{script}});
})()
""";

	public static string Status => """
(() => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  return JSON.stringify(runtime && typeof runtime.status === 'function'
    ? runtime.status()
    : { ready: false, version: '', queueLength: 0, lastSequence: 0 });
})()
""";

	private const string ReadTemplate = """
(() => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  return JSON.stringify(runtime && typeof runtime.read === 'function'
    ? runtime.read(__AFTER_SEQUENCE__, __LIMIT__, __DRAIN__)
    : { ready: false, version: '', queueLength: 0, lastSequence: 0, entries: [] });
})()
""";

	public static string Catalog => """
(() => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  return JSON.stringify(runtime && typeof runtime.catalog === 'function'
    ? runtime.catalog()
    : { ready: false, version: '', endpointCount: 0, discoveredEndpointCount: 0, endpoints: [] });
})()
""";

	public static string CancelPagination => """
(() => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  return JSON.stringify(runtime && typeof runtime.cancelPagination === 'function'
    ? runtime.cancelPagination()
    : { ready: false, version: '', cancelled: false, generation: 0 });
})()
""";

	private const string NormalizeTemplate = """
(() => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  return JSON.stringify(runtime && typeof runtime.normalize === 'function'
    ? runtime.normalize(__AFTER_SEQUENCE__, __LIMIT__)
    : { ready: false, version: '', datasets: [] });
})()
""";

	private const string PayloadTemplate = """
(() => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  return JSON.stringify(runtime && typeof runtime.payload === 'function'
    ? runtime.payload(__SOURCE_SEQUENCE__, __OFFSET__, __LIMIT__)
    : { ready: false, version: '', sourceSequence: 0, offset: 0, nextOffset: 0, totalChars: 0, complete: true, chunk: '' });
})()
""";

	private const string PaginateTemplate = """
(async () => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  return JSON.stringify(runtime && typeof runtime.paginate === 'function'
    ? await runtime.paginate(__SOURCE_SEQUENCE__, __MAX_PAGES__, __DELAY_MS__)
    : { ready: false, version: '', sourceSequence: 0, pagesFetched: 0, capturedSequences: [] });
})()
""";

	private const string SearchTemplate = """
(async () => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  return JSON.stringify(runtime && typeof runtime.search === 'function'
    ? await runtime.search(__SOURCE_SEQUENCE__, __QUERY__)
    : { ready: false, version: '', sourceSequence: 0, query: '', capturedSequence: 0, status: 0, quality: 'empty', recordCount: 0 });
})()
""";

	private const string ProbeTemplate = """
(async () => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  return JSON.stringify(runtime && typeof runtime.probe === 'function'
    ? await runtime.probe(__PATH__, __METHOD__, __BODY__, __ORIGIN__, __SOURCE_SEQUENCE__)
    : { ready: false, version: '', sourceSequence: 0, capturedSequence: 0, endpoint: '', status: 0, quality: 'empty', recordCount: 0 });
})()
""";

	private const string PrepareProbeTemplate = """
(() => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  return JSON.stringify(runtime && typeof runtime.prepareProbe === 'function'
    ? runtime.prepareProbe(__PATH__, __METHOD__, __BODY__, __ORIGIN__, __SOURCE_SEQUENCE__)
    : { ready: false, version: '', sourceSequence: 0, recipe: null });
})()
""";

	private const string CommitProbeTemplate = """
(() => {
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  return JSON.stringify(runtime && typeof runtime.commitProbe === 'function'
    ? runtime.commitProbe(
      __PATH__,
      __METHOD__,
      __BODY__,
      __ORIGIN__,
      __SOURCE_SEQUENCE__,
      __STATUS__,
      JSON.parse(__RESPONSE_TEXT__)
    )
    : { ready: false, version: '', sourceSequence: 0, capturedSequence: 0, endpoint: '', status: 0, quality: 'empty', recordCount: 0 });
})()
""";

	public static string Read(JsonObject payload)
	{
		int afterSequence = Integer(payload, "afterSequence", 0, 0, int.MaxValue);
		int limit = Integer(payload, "limit", 20, 1, 50);
		bool drain = Boolean(payload, "drain", false);
		return ReadTemplate
			.Replace("__AFTER_SEQUENCE__", afterSequence.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
			.Replace("__LIMIT__", limit.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
			.Replace("__DRAIN__", drain ? "true" : "false", StringComparison.Ordinal);
	}

	public static string Normalize(JsonObject payload)
	{
		int afterSequence = Integer(payload, "afterSequence", 0, 0, int.MaxValue);
		int limit = Integer(payload, "limit", 10, 1, 20);
		return NormalizeTemplate
			.Replace("__AFTER_SEQUENCE__", afterSequence.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
			.Replace("__LIMIT__", limit.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
	}

	public static string Payload(JsonObject payload)
	{
		int sourceSequence = Integer(payload, "sourceSequence", 0, 1, int.MaxValue);
		int offset = Integer(payload, "offset", 0, 0, int.MaxValue);
		int limit = Integer(payload, "limit", 256 * 1024, 1, 512 * 1024);
		return PayloadTemplate
			.Replace("__SOURCE_SEQUENCE__", sourceSequence.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
			.Replace("__OFFSET__", offset.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
			.Replace("__LIMIT__", limit.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
	}

	public static string Paginate(JsonObject payload)
	{
		int sourceSequence = Integer(payload, "sourceSequence", 0, 1, int.MaxValue);
		int maxPages = Integer(payload, "maxPages", 5, 1, 250);
		int delayMs = Integer(payload, "delayMs", 350, 250, 3000);
		return PaginateTemplate
			.Replace("__SOURCE_SEQUENCE__", sourceSequence.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
			.Replace("__MAX_PAGES__", maxPages.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
			.Replace("__DELAY_MS__", delayMs.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
	}

	public static string Search(JsonObject payload)
	{
		int sourceSequence = Integer(payload, "sourceSequence", 0, 1, int.MaxValue);
		string query = Text(payload, "query", 160);
		return SearchTemplate
			.Replace("__SOURCE_SEQUENCE__", sourceSequence.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
			.Replace("__QUERY__", JsonSerializer.Serialize(query), StringComparison.Ordinal);
	}

	public static string Probe(JsonObject payload)
	{
		return ReplaceProbeParameters(ProbeTemplate, payload);
	}

	public static string PrepareProbe(JsonObject payload)
	{
		return ReplaceProbeParameters(PrepareProbeTemplate, payload);
	}

	public static string CommitProbe(JsonObject payload, int status, string responseText)
	{
		return ReplaceProbeParameters(CommitProbeTemplate, payload)
			.Replace(
				"__STATUS__",
				Math.Clamp(status, 0, 999).ToString(System.Globalization.CultureInfo.InvariantCulture),
				StringComparison.Ordinal)
			.Replace("__RESPONSE_TEXT__", JsonSerializer.Serialize(responseText), StringComparison.Ordinal);
	}

	private static string ReplaceProbeParameters(string template, JsonObject payload)
	{
		int sourceSequence = Integer(payload, "sourceSequence", 0, 0, int.MaxValue);
		string path = Text(payload, "path", 500);
		string method = Text(payload, "method", 10).ToUpperInvariant();
		string origin = Text(payload, "origin", 200);
		JsonNode? body = payload["body"]?.DeepClone();
		return template
			.Replace("__PATH__", JsonSerializer.Serialize(path), StringComparison.Ordinal)
			.Replace("__METHOD__", JsonSerializer.Serialize(method), StringComparison.Ordinal)
			.Replace("__BODY__", body?.ToJsonString() ?? "null", StringComparison.Ordinal)
			.Replace("__ORIGIN__", JsonSerializer.Serialize(origin), StringComparison.Ordinal)
			.Replace("__SOURCE_SEQUENCE__", sourceSequence.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
	}

	private static int Integer(JsonObject source, string name, int fallback, int minimum, int maximum)
	{
		try { return Math.Clamp(source[name]?.GetValue<int>() ?? fallback, minimum, maximum); }
		catch { return fallback; }
	}

	private static bool Boolean(JsonObject source, string name, bool fallback)
	{
		try { return source[name]?.GetValue<bool>() ?? fallback; }
		catch { return fallback; }
	}

	private static string Text(JsonObject source, string name, int maximum)
	{
		try
		{
			string value = source[name]?.GetValue<string>()?.Trim() ?? string.Empty;
			if (value.Length == 0 || value.Length > maximum || value.Any(character => char.IsControl(character)))
			{
				throw new InvalidOperationException("OZON_DATA_SEARCH_QUERY_INVALID");
			}
			return value;
		}
		catch (InvalidOperationException) { throw; }
		catch { throw new InvalidOperationException("OZON_DATA_SEARCH_QUERY_INVALID"); }
	}
}
