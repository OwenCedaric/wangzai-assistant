using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using CefSharp;

namespace Wangzai.CefBrowserHost;

internal sealed class CrossBorderBuiltInRuntime : IDisposable
{
	private const string BusBaseUrl = "https://www.kuajing84.com";

	private const int MaximumOrders = 100;

	private const int MaximumDirectReadOrders = 100;

	private const int DirectReadConcurrency = 12;

	private const int MaximumChargeRows = 100000;

	private const int MaximumChargeOrders = 100000;

	private const int MaximumChargePages = 2000;
	// Same per-response ceiling already used by Alibaba1688OrderNetworkCapture.
	// Keep the existing 500k normalized text boundary, but reject overflow
	// instead of silently dropping later identity evidence from a mixed page.
	private const int MaximumSupplierResponseBytes = 8 * 1024 * 1024;
	private const int MaximumBusResponseBytes = 8 * 1024 * 1024;
	private const int DetailReadConcurrency = 4;
	private const int MaximumSupplierDocumentCharacters = 500000;
	private const string SupplierOrderFields = "purchaseOrderNumber|orderNumber|orderNo|order_no|orderId|order_id|orderSn|order_sn|bizOrderId|biz_order_id|tradeId|trade_id|mainOrderId|main_order_id|订单号|订单编号|交易号|交易编号";
	private static readonly TimeSpan SupplierPatternTimeout = TimeSpan.FromSeconds(1.0);

	private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(25.0);

	private static readonly Regex WhitespaceRegex = new("\\s+", RegexOptions.CultureInvariant | RegexOptions.Compiled);

	private static readonly Regex HtmlTagRegex = new("<[^>]+>", RegexOptions.CultureInvariant | RegexOptions.Compiled | RegexOptions.NonBacktracking, SupplierPatternTimeout);
	private static readonly Regex SupplierOrderLabelRegex = new(
		@"(?:(?:订单号|订单编号|交易号|交易编号)\s*[:：#]?|Order\s*(?:ID|Number|No\.?)(?:\s*[:：#]|\s+))\s*[""']?(?<id>[A-Za-z0-9][A-Za-z0-9_-]*)",
		RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled | RegexOptions.NonBacktracking, SupplierPatternTimeout);
	private static readonly Regex SupplierOrderFieldRegex = new(
		@"(?:[""'](?:" + SupplierOrderFields + @")[""']|(?:\{|,)\s*(?:" + SupplierOrderFields + @"))\s*:\s*[""']?(?<id>[A-Za-z0-9][A-Za-z0-9_-]*)",
		RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled | RegexOptions.NonBacktracking, SupplierPatternTimeout);
	private static readonly Regex SupplierOrderAttributeRegex = new(
		@"\bdata-(?:order-(?:id|sn|no|number)|orderid|trade-id|biz-order-id)\s*=\s*[""']?(?<id>[A-Za-z0-9][A-Za-z0-9_-]*)",
		RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled | RegexOptions.NonBacktracking, SupplierPatternTimeout);

	private static readonly Regex JsonpRegex = new("^[^(]+\\((?<json>.*)\\)\\s*;?$", RegexOptions.Singleline | RegexOptions.CultureInvariant | RegexOptions.Compiled);

	private static readonly Regex LoginMessageRegex = new("登录|login|unauthor", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);
	private static readonly Regex LoginRequiredMessageRegex = new(
		@"未登[录陆]|(?:请|需要).{0,30}登[录陆]|登[录陆].{0,20}(?:过期|失效|超时)|not\s+(?:logged|signed)\s+in|(?:login|authentication)\s+required|unauthori[sz]ed|session.{0,20}expired|please.{0,20}(?:log\s*in|sign\s*in)",
		RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled | RegexOptions.NonBacktracking);

	private static readonly Regex FormFieldNameRegex = new("^[A-Za-z0-9_\\[\\]-]{1,80}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);

	private static readonly Regex TrackingNumberRegex = new("^[A-Za-z0-9][A-Za-z0-9._/-]{5,79}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);

	private readonly BrowserProfile profile;

	private readonly IRequestContext requestContext;

	private readonly Func<string, string, Task<string>> captureOriginalPluginLogistics;
	private readonly Func<string, Task<string>> captureSupplierOrder;

	private readonly Func<string, Task<JsonObject?>> capture1688Order;

	private readonly Action<string> openAuthorization;

	private readonly HttpClient http;

	private readonly SemaphoreSlim syncGate = new SemaphoreSlim(1, 1);

	private readonly SemaphoreSlim chargeGate = new SemaphoreSlim(1, 1);
	private readonly CancellationTokenSource lifetime = new();
	private readonly ConcurrentDictionary<string, CancellationTokenSource> operations = new(StringComparer.Ordinal);
	private readonly ConcurrentDictionary<string, byte> earlyCancellations = new(StringComparer.Ordinal);
	private readonly ConcurrentQueue<string> earlyCancellationOrder = new();
	private readonly AsyncLocal<CancellationToken> operationToken = new();
	private CancellationToken CurrentToken => operationToken.Value.CanBeCanceled ? operationToken.Value : lifetime.Token;

	private readonly string lastSyncPath;

	private JsonNode? lastSync;

	private bool disposed;

	private sealed class PagedRows
	{
		public JsonArray Rows { get; } = new JsonArray();
		public int ExpectedTotal { get; set; }
		public int RawRowCount { get; set; }
		public int PagesRead { get; set; }
		public bool Complete { get; set; }
	}

	public CrossBorderBuiltInRuntime(
		BrowserProfile profile,
		IRequestContext requestContext,
		Func<string, string, Task<string>> captureOriginalPluginLogistics,
		Func<string, Task<string>> captureSupplierOrder,
		Func<string, Task<JsonObject?>> capture1688Order,
		Action<string> openAuthorization)
	{
		this.profile = profile;
		this.requestContext = requestContext;
		this.captureOriginalPluginLogistics = captureOriginalPluginLogistics;
		this.captureSupplierOrder = captureSupplierOrder;
		this.capture1688Order = capture1688Order;
		this.openAuthorization = openAuthorization;
		Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
		http = new HttpClient(CreateHandler(profile), disposeHandler: true)
		{
			Timeout = RequestTimeout
		};
		string text = Path.Combine(profile.ProfileDirectory, "cross-border-builtin");
		Directory.CreateDirectory(text);
		lastSyncPath = Path.Combine(text, "last-sync.json");
		lastSync = ReadLastSync(lastSyncPath);
	}

	public async Task<object?> ExecuteAsync(string command, JsonObject payload)
	{
		ThrowIfDisposed();
		if (command == "cross-border-cancel")
		{
			string cancelledId = Text(payload["operationId"], 160);
			bool found = operations.TryGetValue(cancelledId, out CancellationTokenSource? pending);
			if (!found && cancelledId.Length > 0 && earlyCancellations.TryAdd(cancelledId, 0))
			{
				earlyCancellationOrder.Enqueue(cancelledId);
				while (earlyCancellationOrder.Count > 256 && earlyCancellationOrder.TryDequeue(out string? old)) earlyCancellations.TryRemove(old, out _);
			}
			try { pending?.Cancel(); } catch (ObjectDisposedException) { found = false; }
			return new { ok = true, cancelled = found };
		}
		string operationId = Text(payload["operationId"], 160);
		if (operationId.Length == 0) operationId = Guid.NewGuid().ToString("N");
		using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
		if (!operations.TryAdd(operationId, cancellation)) throw new InvalidOperationException("CROSS_BORDER_OPERATION_ALREADY_RUNNING");
		if (earlyCancellations.TryRemove(operationId, out _)) cancellation.Cancel();
		CancellationToken previousToken = operationToken.Value;
		operationToken.Value = cancellation.Token;
		try
		{
		CurrentToken.ThrowIfCancellationRequested();
		return command switch
		{
			"cross-border-ping" => new
			{
				ok = true,
				enabled = true,
				runtimeKind = "builtin",
				version = "1.0.0"
			}, 
			"cross-border-login-status" => await GetLoginStatusAsync().ConfigureAwait(continueOnCapturedContext: false), 
			"cross-border-status" => await StatusAsync().ConfigureAwait(continueOnCapturedContext: false), 
			"cross-border-charges-status" => await ChargeStatusAsync().ConfigureAwait(continueOnCapturedContext: false), 
			"cross-border-charges" => await GetChargeLedgerAsync(payload).ConfigureAwait(continueOnCapturedContext: false), 
			"cross-border-orders" => new
			{
				ok = true,
				orders = await GetPendingOrdersAsync().ConfigureAwait(continueOnCapturedContext: false)
			}, 
			"cross-border-sync" => await RunSyncAsync(payload).ConfigureAwait(continueOnCapturedContext: false), 
			_ => throw new InvalidOperationException("CROSS_BORDER_EXTENSION_COMMAND_INVALID"), 
		};
		}
		catch (OperationCanceledException error) { throw new InvalidOperationException("CROSS_BORDER_OPERATION_CANCELLED", error); }
		finally { operations.TryRemove(operationId, out _); operationToken.Value = previousToken; }
	}

	public async Task RunAutomaticSyncAsync()
	{
		if (disposed)
		{
			return;
		}
		string text = PlatformKey(profile.PlatformKey);
		if (text.Length == 0 || text == "cross-border")
		{
			return;
		}
		try
		{
			await RunSyncAsync(new JsonObject
			{
				["commit"] = true,
				["automatic"] = true,
				["platform"] = text
			}).ConfigureAwait(continueOnCapturedContext: false);
		}
		catch
		{
		}
	}

	private async Task<JsonObject> StatusAsync()
	{
		JsonObject value = await GetLoginStatusAsync().ConfigureAwait(continueOnCapturedContext: false);
		return new JsonObject
		{
			["ok"] = true,
			["login"] = value,
			["lastSync"] = lastSync?.DeepClone()
		};
	}

	private async Task<JsonObject> GetLoginStatusAsync()
	{
		try
		{
			JsonObject jsonObject = await RequestBusAsync("/index/plugin/get_login_status").ConfigureAwait(continueOnCapturedContext: false);
			JsonObject jsonObject2 = (Payload(jsonObject) as JsonObject) ?? new JsonObject();
			return new JsonObject
			{
				["ok"] = true,
				["loggedIn"] = Number(jsonObject["code"]) == 1.0 || Text(jsonObject2["user_code"] ?? jsonObject["user_code"], 120).Length > 0,
				["userCode"] = Text(jsonObject2["user_code"] ?? jsonObject["user_code"], 120)
			};
		}
		catch (Exception ex)
		{
			return new JsonObject
			{
				["ok"] = false,
				["loggedIn"] = false,
				["code"] = ErrorCode.From(ex),
				["message"] = Text(ex.Message, 300)
			};
		}
	}

	private async Task<JsonArray> GetPendingOrdersAsync()
	{
		JsonObject value = await RequestBusAsync("/index/plugin/get_order").ConfigureAwait(continueOnCapturedContext: false);
		JsonArray jsonArray = new JsonArray();
		HashSet<string> hashSet = new HashSet<string>(StringComparer.Ordinal);
		foreach (JsonNode? item in List(value))
		{
			if (!(item is JsonObject source))
			{
				continue;
			}
			JsonObject jsonObject = NormalizePendingOrder(source);
			string text = Text(jsonObject["orderId"], 180);
			string text2 = Text(jsonObject["packId"], 180);
			if (text.Length != 0 && hashSet.Add(text + "\0" + text2))
			{
				jsonArray.Add(jsonObject);
				if (jsonArray.Count >= 100)
				{
					break;
				}
			}
		}
		return jsonArray;
	}

	private async Task<JsonObject> ChargeStatusAsync()
	{
		JsonObject login = await GetLoginStatusAsync().ConfigureAwait(continueOnCapturedContext: false);
		return new JsonObject
		{
			["ok"] = Boolean(login["loggedIn"], fallback: false),
			["loggedIn"] = Boolean(login["loggedIn"], fallback: false),
			["userCode"] = Text(login["userCode"], 120),
			["browserAccountRef"] = profile.StorageRef,
			["runtimeKind"] = "builtin",
			["code"] = login["code"]?.DeepClone(),
			["message"] = login["message"]?.DeepClone()
		};
	}

	private static void RequireLoggedIn(JsonObject login)
	{
		if (!Boolean(login["ok"], fallback: false))
		{
			string code = Text(login["code"], 160);
			throw new InvalidOperationException(code.StartsWith("CROSS_BORDER_", StringComparison.Ordinal)
				|| code.StartsWith("PURCHASE_BROWSER_", StringComparison.Ordinal) ? code : "CROSS_BORDER_API_FAILED");
		}
		if (!Boolean(login["loggedIn"], fallback: false)) throw new InvalidOperationException("CROSS_BORDER_LOGIN_REQUIRED");
	}

	private async Task<JsonObject> GetChargeLedgerAsync(JsonObject input)
	{
		await chargeGate.WaitAsync(CurrentToken).ConfigureAwait(continueOnCapturedContext: false);
		try
		{
			string selectedPageUrl = Text(input["pageUrl"], 1800);
			if (!IsCrossBorderPageUrl(selectedPageUrl))
			{
				throw new InvalidOperationException("CROSS_BORDER_CHARGE_PAGE_REQUIRED");
			}
			JsonObject login = await GetLoginStatusAsync().ConfigureAwait(continueOnCapturedContext: false);
			RequireLoggedIn(login);
			int pageSize = Math.Clamp((int)Number(input["pageSize"]), 20, 200);
			if (pageSize == 20 && input["pageSize"] == null)
			{
				pageSize = 100;
			}
			int maxPages = input["maxPages"] == null
				? MaximumChargePages
				: Math.Clamp((int)Number(input["maxPages"]), 1, MaximumChargePages);
			PagedRows chargeRead = await ReadChargePagesAsync(input, pageSize, maxPages).ConfigureAwait(continueOnCapturedContext: false);
			PagedRows orderRead = await ReadChargeOrderPagesAsync(pageSize, maxPages).ConfigureAwait(continueOnCapturedContext: false);
			if (!chargeRead.Complete || !orderRead.Complete)
			{
				throw new InvalidOperationException("CROSS_BORDER_CHARGE_PAGINATION_INCOMPLETE");
			}
			JsonArray charges = chargeRead.Rows;
			JsonArray orders = orderRead.Rows;
			await FillMissingChargeOrdersAsync(charges, orders).ConfigureAwait(continueOnCapturedContext: false);
			JsonObject detailCoverage = Boolean(input["includeDetails"], fallback: true)
				? await AddChargeOrderDetailsAsync(orders).ConfigureAwait(false)
				: new JsonObject { ["requested"] = false, ["total"] = orders.Count, ["completed"] = 0, ["failed"] = 0, ["complete"] = false };
			return new JsonObject
			{
				["ok"] = true,
				["loggedIn"] = true,
				["userCode"] = Text(login["userCode"], 120),
				["browserAccountRef"] = profile.StorageRef,
				["selectedPageUrl"] = selectedPageUrl,
				["charges"] = charges,
				["orders"] = orders,
				["chargeCount"] = charges.Count,
				["orderCount"] = orders.Count,
				["detailCoverage"] = detailCoverage,
				["pagination"] = new JsonObject
				{
					["complete"] = true,
					["chargePagesRead"] = chargeRead.PagesRead,
					["chargeRawRowCount"] = chargeRead.RawRowCount,
					["chargeUniqueRowCount"] = charges.Count,
					["chargeExpectedTotal"] = chargeRead.ExpectedTotal,
					["orderPagesRead"] = orderRead.PagesRead,
					["orderRawRowCount"] = orderRead.RawRowCount,
					["orderUniqueRowCount"] = orders.Count,
					["orderExpectedTotal"] = orderRead.ExpectedTotal
				},
				["capturedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)
			};
		}
		finally
		{
			chargeGate.Release();
		}
	}

	private static bool IsCrossBorderPageUrl(string value)
	{
		if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)) return false;
		if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;
		bool correctHost = uri.Host.Equals("kuajing84.com", StringComparison.OrdinalIgnoreCase)
			|| uri.Host.EndsWith(".kuajing84.com", StringComparison.OrdinalIgnoreCase);
		return correctHost
			&& uri.AbsolutePath.Equals("/index/finance/record_consume.html", StringComparison.OrdinalIgnoreCase);
	}

	private async Task<PagedRows> ReadChargePagesAsync(JsonObject input, int pageSize, int maxPages)
	{
		PagedRows result = new PagedRows();
		HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
		HashSet<string> pageFingerprints = new HashSet<string>(StringComparer.Ordinal);
		JsonObject selectedFilters = input["pageFilters"] as JsonObject ?? new JsonObject();
		for (int page = 1; page <= maxPages && result.Rows.Count < MaximumChargeRows; page++)
		{
			Dictionary<string, string> form = BuildChargePageForm(input, selectedFilters, page, pageSize);
			JsonObject response = await RequestBusTableAsync(
				"/index/finance/record_consume.html",
				HttpMethod.Post,
				form).ConfigureAwait(continueOnCapturedContext: false);
			List<JsonObject> pageRows = List(response).OfType<JsonObject>().ToList();
			result.PagesRead = page;
			result.RawRowCount += pageRows.Count;
			result.ExpectedTotal = Math.Max(result.ExpectedTotal, (int)Number(response["count"] ?? response["total"]));
			if (pageRows.Count == 0)
			{
				result.Complete = result.ExpectedTotal <= 0 || result.Rows.Count >= result.ExpectedTotal;
				break;
			}
			List<JsonObject> normalizedRows = pageRows.Select(NormalizeChargeRecord).ToList();
			string pageFingerprint = string.Join("\u001e", normalizedRows.Select(row => Text(row["sourceRecordKey"], 500)));
			if (!pageFingerprints.Add(pageFingerprint))
			{
				throw new InvalidOperationException("CROSS_BORDER_CHARGE_PAGINATION_REPEATED_PAGE");
			}
			foreach (JsonObject normalized in normalizedRows)
			{
				string key = Text(normalized["sourceRecordKey"], 500);
				if (key.Length > 0 && seen.Add(key))
				{
					result.Rows.Add(normalized);
					if (result.Rows.Count >= MaximumChargeRows) break;
				}
			}
			if (result.ExpectedTotal > 0 && result.Rows.Count >= result.ExpectedTotal)
			{
				result.Complete = true;
				break;
			}
		}
		if (!result.Complete && result.ExpectedTotal > 0 && result.Rows.Count >= result.ExpectedTotal)
		{
			result.Complete = true;
		}
		return result;
	}

	private static Dictionary<string, string> BuildChargePageForm(
		JsonObject input,
		JsonObject selectedFilters,
		int page,
		int pageSize)
	{
		Dictionary<string, string> form = new Dictionary<string, string>(StringComparer.Ordinal);
		foreach (KeyValuePair<string, JsonNode?> filter in selectedFilters)
		{
			string name = filter.Key.Trim();
			if (!FormFieldNameRegex.IsMatch(name)
				|| name.Equals("page", StringComparison.OrdinalIgnoreCase)
				|| name.Equals("limit", StringComparison.OrdinalIgnoreCase))
			{
				continue;
			}
			form[name] = Text(filter.Value, 500);
		}
		form["reason"] = Text(input["reason"] ?? selectedFilters["reason"], 180);
		form["time"] = Text(input["time"] ?? selectedFilters["time"], 80);
		form["search_time"] = Text(
			input["searchTime"] ?? input["search_time"] ?? selectedFilters["search_time"],
			120);
		form["page"] = page.ToString(CultureInfo.InvariantCulture);
		form["limit"] = pageSize.ToString(CultureInfo.InvariantCulture);
		return form;
	}

	private async Task<PagedRows> ReadChargeOrderPagesAsync(int pageSize, int maxPages)
	{
		PagedRows result = new PagedRows();
		HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
		HashSet<string> pageFingerprints = new HashSet<string>(StringComparer.Ordinal);
		for (int page = 1; page <= maxPages && result.Rows.Count < MaximumChargeOrders; page++)
		{
			JsonObject response = await RequestBusTableAsync("/index/Accountorder/order_list_submit/order_type/all", HttpMethod.Post, new Dictionary<string, string>
			{
				["page"] = page.ToString(CultureInfo.InvariantCulture),
				["limit"] = pageSize.ToString(CultureInfo.InvariantCulture)
			}).ConfigureAwait(continueOnCapturedContext: false);
			List<JsonObject> pageRows = List(response).OfType<JsonObject>().ToList();
			result.PagesRead = page;
			result.RawRowCount += pageRows.Count;
			result.ExpectedTotal = Math.Max(result.ExpectedTotal, (int)Number(response["count"] ?? response["total"]));
			if (pageRows.Count == 0)
			{
				result.Complete = result.ExpectedTotal <= 0 || result.Rows.Count >= result.ExpectedTotal;
				break;
			}
			List<JsonObject> normalizedRows = pageRows.Select(NormalizeChargeOrder).ToList();
			string pageFingerprint = string.Join("\u001e", normalizedRows.Select(row => Text(row["collectionNumber"] ?? row["postingNumber"] ?? row["internalOrderId"], 180)));
			if (!pageFingerprints.Add(pageFingerprint))
			{
				throw new InvalidOperationException("CROSS_BORDER_CHARGE_PAGINATION_REPEATED_PAGE");
			}
			foreach (JsonObject normalized in normalizedRows)
			{
				string key = Text(normalized["collectionNumber"] ?? normalized["postingNumber"] ?? normalized["internalOrderId"], 180);
				if (key.Length > 0 && seen.Add(key)) result.Rows.Add(normalized);
				if (result.Rows.Count >= MaximumChargeOrders) break;
			}
			if (result.ExpectedTotal > 0 && result.Rows.Count >= result.ExpectedTotal)
			{
				result.Complete = true;
				break;
			}
		}
		if (!result.Complete && result.ExpectedTotal > 0 && result.Rows.Count >= result.ExpectedTotal)
		{
			result.Complete = true;
		}
		return result;
	}

	private async Task FillMissingChargeOrdersAsync(JsonArray charges, JsonArray orders)
	{
		HashSet<string> existing = orders.OfType<JsonObject>()
			.Select(row => Text(row["collectionNumber"], 180))
			.Where(value => value.Length > 0)
			.ToHashSet(StringComparer.Ordinal);
		string[] missing = charges.OfType<JsonObject>()
			.Select(row => Text(row["collectionNumber"], 180))
			.Where(value => value.Length > 0 && !existing.Contains(value))
			.Distinct(StringComparer.Ordinal)
			.Take(100)
			.ToArray();
		foreach (string collectionNumber in missing)
		{
			JsonObject? match = null;
			foreach (string field in new[] { "order_id", "oid", "keyword", "search" })
			{
				JsonObject response = await RequestBusTableAsync("/index/Accountorder/order_list_search/order_type/all", HttpMethod.Post, new Dictionary<string, string>
				{
					[field] = collectionNumber,
					["page"] = "1",
					["limit"] = "20"
				}).ConfigureAwait(continueOnCapturedContext: false);
				match = List(response).OfType<JsonObject>()
					.Select(NormalizeChargeOrder)
					.FirstOrDefault(row => Text(row["collectionNumber"], 180) == collectionNumber);
				if (match != null) break;
			}
			if (match != null && existing.Add(collectionNumber)) orders.Add(match);
		}
	}

	private async Task<JsonObject> AddChargeOrderDetailsAsync(JsonArray orders)
	{
		JsonObject[] rows = orders.OfType<JsonObject>().ToArray();
		int cursor = -1, completed = 0, failed = 0, unavailable = 0;
		async Task Worker()
		{
			int index;
			while ((index = Interlocked.Increment(ref cursor)) < rows.Length)
			{
				CurrentToken.ThrowIfCancellationRequested();
				JsonObject order = rows[index];
				string internalOrderId = Text(order["internalOrderId"], 180);
				if (internalOrderId.Length == 0) { order["detailReadStatus"] = "unavailable"; Interlocked.Increment(ref unavailable); continue; }
				try
				{
					JsonObject detail = await RequestBusTableAsync("/index/Accountordersubmit/order_price/oid/" + Uri.EscapeDataString(internalOrderId)).ConfigureAwait(false);
					JsonNode? payload = Payload(detail);
					JsonObject breakdown = SanitizeFeeDetail(payload);
					if (breakdown.Count == 0) throw new InvalidOperationException("CROSS_BORDER_CHARGE_DETAILS_INVALID");
					order["feeBreakdown"] = breakdown;
					order["detailTotalCny"] = FirstMoney(payload, "total", "total_price", "price", "money", "all_money");
					order["detailReadStatus"] = "complete";
					Interlocked.Increment(ref completed);
				}
				catch (Exception error)
				{
					if (CurrentToken.IsCancellationRequested) throw;
					order["detailReadStatus"] = "failed";
					order["detailErrorCode"] = ErrorCode.From(error);
					Interlocked.Increment(ref failed);
				}
			}
		}
		await Task.WhenAll(Enumerable.Range(0, Math.Min(DetailReadConcurrency, rows.Length)).Select(_ => Worker())).ConfigureAwait(false);
		return new JsonObject { ["requested"] = true, ["total"] = rows.Length, ["completed"] = completed,
			["failed"] = failed, ["unavailable"] = unavailable, ["complete"] = completed == rows.Length };
	}

	private async Task<JsonObject> RequestBusTableAsync(string pathname, HttpMethod? method = null, IReadOnlyDictionary<string, string>? form = null)
	{
		Uri uri = new Uri(new Uri(BusBaseUrl), pathname);
		string raw = await RequestTextAsync(uri, method ?? HttpMethod.Get, form, null).ConfigureAwait(continueOnCapturedContext: false);
		JsonObject body = ParseBusResponse(raw);
		if (body["code"] != null)
		{
			double code = Number(body["code"]);
			if (code != 0.0 && code != 1.0)
			{
				string message = ApiMessage(body);
				if (LoginMessage().IsMatch(message)) throw new InvalidOperationException("CROSS_BORDER_LOGIN_REQUIRED");
				throw new InvalidOperationException("CROSS_BORDER_API_FAILED");
			}
		}
		return body;
	}

	private async Task<JsonObject> RunSyncAsync(JsonObject input)
	{
		await syncGate.WaitAsync(CurrentToken).ConfigureAwait(continueOnCapturedContext: false);
		try
		{
			string mode = Text(input["mode"], 40).ToLowerInvariant();
			if (mode == "supplier-orders-read")
			{
				return await ReadSupplierOrdersAsync(input).ConfigureAwait(continueOnCapturedContext: false);
			}
			if (mode == "supplier-order-read")
			{
				return await ReadSingleSupplierOrderAsync(input).ConfigureAwait(continueOnCapturedContext: false);
			}
			if (mode == "supplier-read")
			{
				return await ReadSingleSupplierLogisticsAsync(input).ConfigureAwait(continueOnCapturedContext: false);
			}
			if (mode == "package-update")
			{
				return await UpdateSinglePackageWithReadbackAsync(input).ConfigureAwait(continueOnCapturedContext: false);
			}
			JsonObject login = await GetLoginStatusAsync().ConfigureAwait(continueOnCapturedContext: false);
			RequireLoggedIn(login);
			JsonArray source = await GetPendingOrdersAsync().ConfigureAwait(continueOnCapturedContext: false);
			HashSet<string> requested = new HashSet<string>(StringComparer.Ordinal);
			if (input["orderIds"] is JsonArray jsonArray)
			{
				foreach (JsonNode? item in jsonArray)
				{
					string text = Text(item, 180);
					if (text.Length > 0)
					{
						requested.Add(text);
					}
				}
			}
			string selectedPlatform = PlatformKey(Text(input["platform"], 60));
			if (selectedPlatform.Length == 0)
			{
				selectedPlatform = PlatformKey(profile.PlatformKey);
			}
			bool commit = Boolean(input["commit"], fallback: true);
			bool interactive = !Boolean(input["automatic"], fallback: false);
			JsonObject[] selected = (from jsonObject3 in source.OfType<JsonObject>()
				where requested.Count == 0 || requested.Contains(Text(jsonObject3["orderId"], 180))
				where selectedPlatform.Length == 0 || PlatformKey(Text(jsonObject3["fromName"], 40)) == selectedPlatform
				select jsonObject3).ToArray();
			JsonArray results = new JsonArray();
			JsonObject[] array = selected;
			foreach (JsonObject order in array)
			{
				try
				{
					JsonObject logistics = await FetchSupplierLogisticsAsync(order, interactive).ConfigureAwait(continueOnCapturedContext: false);
					if (Text(logistics["trackingNumber"], 180).Length == 0)
					{
						results.Add(Merge(order, new JsonObject
						{
							["ok"] = false,
							["status"] = "未发货",
							["logistics"] = logistics
						}));
						continue;
					}
					JsonObject? jsonObject = null;
					if (commit)
					{
						jsonObject = await UpdatePackageAsync(order, logistics).ConfigureAwait(continueOnCapturedContext: false);
					}
					results.Add(Merge(order, new JsonObject
					{
						["ok"] = !commit,
						["writeAccepted"] = commit,
						["readbackVerified"] = false,
						["status"] = (commit ? "已写入待回读" : "待同步"),
						["logistics"] = logistics,
						["updateMessage"] = Text(jsonObject?["data"], 200)
					}));
				}
				catch (Exception ex)
				{
					results.Add(Merge(order, new JsonObject
					{
						["ok"] = false,
						["status"] = "读取失败",
						["errorCode"] = ErrorCode.From(ex),
						["error"] = Text(ex.Message, 300)
					}));
				}
			}
			if (commit)
			{
				await VerifyPackageReadbackAsync(results.OfType<JsonObject>()
					.Where(row => Boolean(row["writeAccepted"], fallback: false)).ToArray()).ConfigureAwait(false);
			}
			bool complete = results.OfType<JsonObject>().All(row => Boolean(row["ok"], fallback: false));
			JsonObject jsonObject2 = new JsonObject
			{
				["ok"] = !commit || complete,
				["complete"] = complete,
				["partial"] = !complete,
				["loggedIn"] = true,
				["userCode"] = Text(login["userCode"], 120),
				["platform"] = selectedPlatform,
				["commit"] = commit,
				["total"] = selected.Length,
				["synced"] = results.OfType<JsonObject>().Count((JsonObject row) => Boolean(row["ok"], fallback: false) && Text(row["status"], 40) == "已同步"),
				["results"] = results,
				["finishedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)
			};
			lastSync = jsonObject2.DeepClone();
			WriteLastSync(lastSyncPath, jsonObject2);
			return jsonObject2;
		}
		finally
		{
			syncGate.Release();
		}
	}

	private async Task<JsonObject> ReadSingleSupplierLogisticsAsync(JsonObject input)
	{
		JsonObject order = NormalizePendingOrder(input["order"] as JsonObject ?? new JsonObject());
		string orderId = Text(order["orderId"], 180);
		string expectedPlatform = PlatformKey(Text(order["fromName"], 40));
		string profilePlatform = PlatformKey(profile.PlatformKey);
		if (orderId.Length == 0 || expectedPlatform.Length == 0)
		{
			throw new InvalidOperationException("CROSS_BORDER_PACKAGE_CONTEXT_MISSING");
		}
		bool sharedAlibabaLogin = (profilePlatform == "taobao" && expectedPlatform == "tmall")
			|| (profilePlatform == "tmall" && expectedPlatform == "taobao");
		if (profilePlatform.Length == 0 || (profilePlatform != expectedPlatform && !sharedAlibabaLogin))
		{
			throw new InvalidOperationException("CROSS_BORDER_PURCHASE_ACCOUNT_MISMATCH");
		}
		JsonObject? purchase = null;
		string purchaseInfoErrorCode = string.Empty;
		if (Boolean(input["includePurchaseInfo"], fallback: false))
		{
			try
			{
				purchase = await FetchSupplierOrderSnapshotAsync(order).ConfigureAwait(continueOnCapturedContext: false);
			}
			catch (Exception ex)
			{
				purchaseInfoErrorCode = ErrorCode.From(ex);
			}
		}
		JsonObject logistics = await FetchSupplierLogisticsAsync(order, interactive: false).ConfigureAwait(continueOnCapturedContext: false);
		string trackingNumber = NormalizeTrackingNumber(Text(logistics["trackingNumber"], 180));
		if (trackingNumber.Length == 0)
		{
			return new JsonObject
			{
				["ok"] = false,
				["mode"] = "supplier-read",
				["status"] = "未发货",
				["order"] = order.DeepClone(),
				["purchase"] = purchase?.DeepClone(),
				["purchaseInfoComplete"] = purchase != null,
				["purchaseInfoErrorCode"] = purchaseInfoErrorCode,
				["logistics"] = new JsonObject
				{
					["carrier"] = Text(logistics["carrier"], 100),
					["trackingNumber"] = string.Empty
				}
			};
		}
		JsonObject verified = RequireExactLogistics(logistics);
		return new JsonObject
		{
			["ok"] = true,
			["mode"] = "supplier-read",
			["status"] = "待同步",
			["order"] = order.DeepClone(),
			["purchase"] = purchase?.DeepClone(),
			["purchaseInfoComplete"] = purchase != null,
			["purchaseInfoErrorCode"] = purchaseInfoErrorCode,
			["logistics"] = verified
		};
	}

	private async Task<JsonObject> ReadSingleSupplierOrderAsync(JsonObject input)
	{
		JsonObject order = NormalizePendingOrder(input["order"] as JsonObject ?? new JsonObject());
		string orderId = Text(order["orderId"], 180);
		string expectedPlatform = PlatformKey(Text(order["fromName"], 40));
		string profilePlatform = PlatformKey(profile.PlatformKey);
		if (orderId.Length == 0 || expectedPlatform.Length == 0)
		{
			throw new InvalidOperationException("CROSS_BORDER_PACKAGE_CONTEXT_MISSING");
		}
		bool sharedAlibabaLogin = (profilePlatform == "taobao" && expectedPlatform == "tmall")
			|| (profilePlatform == "tmall" && expectedPlatform == "taobao");
		if (profilePlatform.Length == 0 || (profilePlatform != expectedPlatform && !sharedAlibabaLogin))
		{
			throw new InvalidOperationException("CROSS_BORDER_PURCHASE_ACCOUNT_MISMATCH");
		}
		Task<JsonObject> purchaseTask = FetchSupplierOrderSnapshotAsync(order);
		Task<JsonObject?> logisticsTask = ReadOptionalSupplierLogisticsAsync(order);
		JsonObject purchase = await purchaseTask.ConfigureAwait(continueOnCapturedContext: false);
		JsonObject logistics = new JsonObject
		{
			["carrier"] = string.Empty,
			["trackingNumber"] = string.Empty,
			["sourceMethod"] = string.Empty
		};
		JsonObject? candidate = await logisticsTask.ConfigureAwait(continueOnCapturedContext: false);
		if (candidate != null)
		{
			logistics["carrier"] = Text(candidate["carrier"], 100);
			logistics["trackingNumber"] = NormalizeTrackingNumber(Text(candidate["trackingNumber"], 180));
			logistics["sourceMethod"] = Text(candidate["sourceMethod"], 120);
		}
		return new JsonObject
		{
			["ok"] = true,
			["mode"] = "supplier-order-read",
			["directRead"] = true,
			["pluginVerified"] = true,
			["order"] = order.DeepClone(),
			["purchase"] = purchase,
			["logistics"] = logistics,
			["fetchedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)
		};
	}

	private async Task<JsonObject> ReadSupplierOrdersAsync(JsonObject input)
	{
		JsonObject[] orders = (input["orders"] as JsonArray)?
			.OfType<JsonObject>()
			.Take(MaximumDirectReadOrders)
			.Select(order => order.DeepClone() as JsonObject ?? new JsonObject())
			.ToArray() ?? Array.Empty<JsonObject>();
		if (orders.Length == 0)
		{
			throw new InvalidOperationException("CROSS_BORDER_PURCHASE_ORDER_NUMBER_REQUIRED");
		}

		using SemaphoreSlim directReadGate = new(DirectReadConcurrency, DirectReadConcurrency);
		Task<JsonObject>[] reads = orders.Select(async order =>
		{
			await directReadGate.WaitAsync().ConfigureAwait(continueOnCapturedContext: false);
			try
			{
				try
				{
					return await ReadSingleSupplierOrderAsync(new JsonObject
					{
						["order"] = order.DeepClone()
					}).ConfigureAwait(continueOnCapturedContext: false);
				}
				catch (Exception error)
				{
					return new JsonObject
					{
						["ok"] = false,
						["pluginVerified"] = true,
						["order"] = order.DeepClone(),
						["errorCode"] = ErrorCode.From(error)
					};
				}
			}
			finally
			{
				directReadGate.Release();
			}
		}).ToArray();
		JsonObject[] results = await Task.WhenAll(reads).ConfigureAwait(continueOnCapturedContext: false);
		return new JsonObject
		{
			["ok"] = results.All(result => Boolean(result["ok"], fallback: false)),
			["mode"] = "supplier-orders-read",
			["directRead"] = true,
			["pluginVerified"] = true,
			["results"] = new JsonArray(results.Select(result => result.DeepClone()).ToArray())
		};
	}

	private async Task<JsonObject?> ReadOptionalSupplierLogisticsAsync(JsonObject order)
	{
		try
		{
			return await FetchSupplierLogisticsAsync(order, interactive: false)
				.WaitAsync(TimeSpan.FromSeconds(45))
				.ConfigureAwait(continueOnCapturedContext: false);
		}
		catch
		{
			// Amount and order status are the required evidence. Logistics may be absent
			// before shipment and a slow logistics endpoint must not delay the batch.
			return null;
		}
	}

	private async Task<JsonObject> UpdateSinglePackageWithReadbackAsync(JsonObject input)
	{
		if (PlatformKey(profile.PlatformKey) != "cross-border")
		{
			throw new InvalidOperationException("CROSS_BORDER_BUS_PROFILE_REQUIRED");
		}
		JsonObject login = await GetLoginStatusAsync().ConfigureAwait(continueOnCapturedContext: false);
		RequireLoggedIn(login);
		JsonObject order = NormalizePendingOrder(input["order"] as JsonObject ?? new JsonObject());
		JsonObject logistics = RequireExactLogistics(input["logistics"] as JsonObject ?? new JsonObject());
		string orderId = Text(order["orderId"], 180);
		string packId = Text(order["packId"], 180);
		if (orderId.Length == 0 || packId.Length == 0)
		{
			throw new InvalidOperationException("CROSS_BORDER_PACKAGE_CONTEXT_MISSING");
		}
		JsonObject update = await UpdatePackageAsync(order, logistics).ConfigureAwait(continueOnCapturedContext: false);
		JsonObject receipt = Merge(order, new JsonObject { ["ok"] = false, ["writeAccepted"] = true, ["readbackVerified"] = false, ["logistics"] = logistics.DeepClone() });
		await VerifyPackageReadbackAsync(new[] { receipt }).ConfigureAwait(false);
		bool readbackVerified = Boolean(receipt["readbackVerified"], fallback: false);
		return new JsonObject
		{
			["ok"] = readbackVerified,
			["mode"] = "package-update",
			["writeAccepted"] = true,
			["readbackVerified"] = readbackVerified,
			["readbackErrorCode"] = receipt["readbackErrorCode"]?.DeepClone(),
			["status"] = readbackVerified ? "已同步" : "已写入待回读",
			["order"] = order.DeepClone(),
			["logistics"] = logistics.DeepClone(),
			["updateMessage"] = Text(update["data"] ?? update["message"], 200)
		};
	}

	private async Task VerifyPackageReadbackAsync(IReadOnlyCollection<JsonObject> receipts)
	{
		if (receipts.Count == 0) return;
		for (int attempt = 0; attempt < 3; attempt++)
		{
			try
			{
				JsonObject response = await RequestBusAsync("/index/plugin/get_order").ConfigureAwait(false);
				IEnumerable<JsonNode?> listed = List(response);
				JsonNode?[] sourceRows = listed.ToArray();
				JsonObject[] rows = sourceRows.OfType<JsonObject>().ToArray();
				bool complete = listed is JsonArray && rows.Length == sourceRows.Length;
				foreach (JsonObject? metadata in new[] { response, Payload(response) as JsonObject })
				{
					if (metadata == null) continue;
					foreach (string key in new[] { "count", "total" })
					{
						if (metadata[key] is not JsonNode total) continue;
						if (!double.TryParse(total.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double expected)
							|| !double.IsFinite(expected) || expected < 0 || expected != Math.Truncate(expected) || expected > rows.Length) complete = false;
					}
					if (Boolean(metadata["hasMore"] ?? metadata["has_more"], fallback: false)) complete = false;
				}
				// The 100-row display/sync limit is not evidence that later rows
				// disappeared. Read back the complete API list, once for the batch.
				var pending = rows.Select(NormalizePendingOrder)
					.Select(row => (Text(row["orderId"], 180), Text(row["packId"], 180))).ToHashSet();
				if (pending.Any(key => key.Item1.Length == 0 || key.Item2.Length == 0)) complete = false;
				foreach (JsonObject receipt in receipts.Where(row => !Boolean(row["readbackVerified"], fallback: false)))
				{
					bool queueAcknowledged = complete && !pending.Contains((Text(receipt["orderId"], 180), Text(receipt["packId"], 180)));
					receipt["queueAcknowledged"] = queueAcknowledged;
					bool verified = queueAcknowledged && await VerifyStoredPackageFieldsAsync(receipt).ConfigureAwait(false);
					receipt["ok"] = verified;
					receipt["readbackVerified"] = verified;
					receipt["status"] = verified ? "已同步" : "已写入待回读";
					receipt["readbackErrorCode"] = verified ? null : "CROSS_BORDER_PACKAGE_READBACK_UNVERIFIED";
				}
			}
			catch (Exception error)
			{
				foreach (JsonObject receipt in receipts.Where(row => !Boolean(row["readbackVerified"], fallback: false)))
				{
					receipt["ok"] = false;
					receipt["status"] = "已写入待回读";
					receipt["readbackErrorCode"] = ErrorCode.From(error);
				}
				break; // Never re-submit writes to compensate for a failed read.
			}
			if (receipts.All(row => Boolean(row["readbackVerified"], fallback: false))) break;
			if (attempt < 2) await Task.Delay(TimeSpan.FromMilliseconds(500 * (attempt + 1)), CurrentToken).ConfigureAwait(false);
		}
	}

	private async Task<bool> VerifyStoredPackageFieldsAsync(JsonObject receipt)
	{
		string collection = Text(receipt["collectionNumber"], 180);
		if (collection.Length == 0 || receipt["logistics"] is not JsonObject expected) return false;
		JsonObject response = await RequestBusTableAsync("/index/Accountorder/order_list_search/order_type/all", HttpMethod.Post,
			new Dictionary<string, string> { ["order_id"] = collection, ["page"] = "1", ["limit"] = "20" }).ConfigureAwait(false);
		IEnumerable<JsonNode?> listed = List(response);
		if (listed is not JsonArray list || Boolean(response["hasMore"] ?? response["has_more"], false)) return false;
		if (Number(response["count"] ?? response["total"]) > list.Count) return false;
		JsonObject[] matches = list.OfType<JsonObject>().Where(row =>
			Text(First(row, "collection_number", "collectionNumber", "order_id", "oid"), 180) == collection
			&& Text(First(row, "from_order", "purchase_order_number", "purchaseOrderNumber"), 180) == Text(receipt["orderId"], 180)
			&& Text(First(row, "pack_id", "packId", "package_id"), 180) == Text(receipt["packId"], 180)).ToArray();
		if (matches.Length != 1) return false;
		string carrier = Text(First(matches[0], "express_number_title", "carrier", "carrierName"), 100);
		string tracking = NormalizeTrackingNumber(Text(First(matches[0], "express_number_value", "tracking_number", "trackingNumber", "logistics_order"), 180));
		return carrier.Length > 0 && tracking.Length > 0
			&& carrier == Text(expected["carrier"] ?? expected["carrierName"], 100)
			&& tracking == NormalizeTrackingNumber(Text(expected["trackingNumber"], 180));
	}

	private static JsonObject RequireExactLogistics(JsonObject source)
	{
		string carrier = Text(source["carrier"] ?? source["carrierName"], 100);
		string trackingNumber = NormalizeTrackingNumber(Text(source["trackingNumber"], 180));
		if (carrier.Length == 0
			|| carrier == "未知快递公司"
			|| carrier.Equals("undefined", StringComparison.OrdinalIgnoreCase)
			|| !TrackingNumber().IsMatch(trackingNumber))
		{
			throw new InvalidOperationException("CROSS_BORDER_LOGISTICS_EVIDENCE_INVALID");
		}
		return new JsonObject
		{
			["carrier"] = carrier,
			["trackingNumber"] = trackingNumber,
			["sourceMethod"] = Text(source["sourceMethod"], 120)
		};
	}

	private static string NormalizeTrackingNumber(string value)
	{
		return Regex.Replace(value ?? string.Empty, "\\s+", string.Empty, RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1.0)).Trim();
	}

	private async Task<JsonObject> FetchSupplierLogisticsAsync(JsonObject order, bool interactive)
	{
		string text = Text(order["fromName"], 40);
		string text2 = Uri.EscapeDataString(Text(order["orderId"], 180));
		JsonObject jsonObject;
		bool flag;
		switch (text)
		{
		case "1688":
		{
			string url = "https://air.1688.com/app/ctf-m-page/logistics-detail/index.html?orderId=" + text2;
			jsonObject = ParseOriginalPluginLogistics(
				await captureOriginalPluginLogistics(url, "1688").ConfigureAwait(continueOnCapturedContext: false));
			break;
		}
		case "淘宝":
		case "天猫":
			flag = true;
			goto IL_01c8;
		default:
			{
				flag = false;
				goto IL_01c8;
			}
			IL_01c8:
			if (flag)
			{
				jsonObject = NormalizeTrace(ParseJson(await RequestSupplierTextAsync("https://detail.i56.taobao.com/call/queryTrace.do?callback=&dimension=TRADE_ID&tradeId=" + text2, Encoding.GetEncoding(936)).ConfigureAwait(continueOnCapturedContext: false)));
				string text3 = AllowedSupplierAuthorizationUrl(Text(jsonObject["authorizationUrl"], 1000));
				if (text3.Length > 0)
				{
					if (interactive)
					{
						openAuthorization(text3);
					}
					throw new InvalidOperationException("CROSS_BORDER_SUPPLIER_AUTH_REQUIRED");
				}
			}
			else
			{
				if (!(text == "拼多多"))
				{
					throw new InvalidOperationException("CROSS_BORDER_PLATFORM_UNSUPPORTED");
				}
				string url = "https://mobile.yangkeduo.com/goods_express.html?order_sn=" + text2;
				jsonObject = ParseOriginalPluginLogistics(
					await captureOriginalPluginLogistics(url, "拼多多").ConfigureAwait(continueOnCapturedContext: false));
			}
			break;
		}
		JsonObject jsonObject2 = new JsonObject();
		string text4 = Text(jsonObject["carrier"], 100);
		jsonObject2["carrier"] = ((text4 != null && text4.Length > 0) ? text4 : "未知快递公司");
		jsonObject2["trackingNumber"] = Text(jsonObject["trackingNumber"], 180);
		jsonObject2["sourceMethod"] = "cross-border-bus-plugin-original-v1.0.8";
		return jsonObject2;
	}

	private async Task<JsonObject> FetchSupplierOrderSnapshotAsync(JsonObject order)
	{
		string orderId = Text(order["orderId"], 180);
		string platform = PlatformKey(Text(order["fromName"], 40));
		if (orderId.Length == 0 || platform.Length == 0)
		{
			throw new InvalidOperationException("CROSS_BORDER_PACKAGE_CONTEXT_MISSING");
		}
		bool exactOrderSeen = false;
		bool loginPageSeen = false;
		IReadOnlyList<string> detailUrls = SupplierOrderDetailUrls(platform, orderId);
		IEnumerable<string> directDetailUrls = platform is "taobao" or "tmall" or "1688"
			? Array.Empty<string>()
			: detailUrls;
		foreach (string url in directDetailUrls)
		{
			string raw;
			try
			{
				raw = await RequestSupplierTextAsync(url).ConfigureAwait(continueOnCapturedContext: false);
			}
			catch (InvalidOperationException ex) when (ErrorCode.From(ex) == "CROSS_BORDER_LOGIN_REQUIRED")
			{
				loginPageSeen = true;
				continue;
			}
			string documentText = SupplierDocumentText(raw);
			bool exact = ContainsExactSupplierOrderToken(raw, orderId) || ContainsExactSupplierOrderToken(documentText, orderId);
			exactOrderSeen |= exact;
			loginPageSeen |= !exact && Regex.IsMatch(
				documentText,
				"请登录|登录后查看|登录淘宝|登录天猫|手机号登录|扫码登录",
				RegexOptions.CultureInvariant,
				TimeSpan.FromSeconds(1.0));
			if (!exact) continue;
			if (TryParseSupplierOrderSnapshot(raw, documentText, url, platform, orderId, out JsonObject? snapshot)
				&& snapshot != null)
			{
				return snapshot;
			}
		}
		if (platform == "1688")
		{
			try
			{
				JsonObject? captured = await capture1688Order(orderId).ConfigureAwait(continueOnCapturedContext: false);
				if (captured?["orderCandidates"] is JsonArray candidates)
				{
					JsonObject? exact = candidates.OfType<JsonObject>().FirstOrDefault(candidate =>
						Text(candidate["purchaseOrderNumber"] ?? candidate["orderNumber"], 180) == orderId);
					if (exact != null && TryNormalizePurchaseCandidate(
						exact,
						Text(captured["pageUrl"] ?? captured["sourceUrl"], 1000),
						platform,
						orderId,
						"1688-hidden-network-capture",
						out JsonObject? snapshot)
						&& snapshot != null)
					{
						return snapshot;
					}
				}
			}
			catch (InvalidOperationException ex) when (ErrorCode.From(ex) == "CROSS_BORDER_LOGIN_REQUIRED")
			{
				loginPageSeen = true;
			}
		}
		if (platform is "taobao" or "tmall")
		{
			foreach (string url in detailUrls)
			{
				string raw;
				try
				{
					raw = await captureSupplierOrder(url).ConfigureAwait(continueOnCapturedContext: false);
				}
				catch
				{
					continue;
				}
				string documentText = SupplierDocumentText(raw);
				bool exact = ContainsExactSupplierOrderToken(raw, orderId) || ContainsExactSupplierOrderToken(documentText, orderId);
				exactOrderSeen |= exact;
				loginPageSeen |= !exact && Regex.IsMatch(
					documentText,
					"请登录|登录后查看|登录淘宝|登录天猫|手机号登录|扫码登录",
					RegexOptions.CultureInvariant,
					TimeSpan.FromSeconds(1.0));
				if (!exact) continue;
				if (TryParseSupplierOrderSnapshot(raw, documentText, url, platform, orderId, out JsonObject? snapshot)
					&& snapshot != null)
				{
					snapshot["sourceMethod"] = "supplier-hidden-render-detail";
					return snapshot;
				}
			}
		}
		if (loginPageSeen && !exactOrderSeen)
		{
			throw new InvalidOperationException("CROSS_BORDER_PURCHASE_LOGIN_REQUIRED");
		}
		throw new InvalidOperationException(exactOrderSeen
			? "CROSS_BORDER_PURCHASE_ORDER_INCOMPLETE"
			: "CROSS_BORDER_PURCHASE_ORDER_NOT_FOUND");
	}

	private static IReadOnlyList<string> SupplierOrderDetailUrls(string platform, string orderId)
	{
		string encoded = Uri.EscapeDataString(orderId);
		return platform switch
		{
			"1688" => new[]
			{
				"https://trade.1688.com/order/new_step_order_detail.htm?orderId=" + encoded,
				"https://air.1688.com/app/ctf-page/trade-order-detail/index.html?orderId=" + encoded
			},
			"pdd" => new[]
			{
				"https://mobile.yangkeduo.com/order.html?order_sn=" + encoded
			},
			"taobao" => new[]
			{
				"https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=" + encoded
			},
			"tmall" => new[]
			{
				"https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=" + encoded
			},
			_ => Array.Empty<string>()
		};
	}

	private static bool TryParseSupplierOrderSnapshot(
		string raw,
		string documentText,
		string pageUrl,
		string platform,
		string orderId,
		out JsonObject? snapshot)
	{
		snapshot = null;
		AssertSupplierPageSize(raw, documentText);
		try
		{
			if (JsonNode.Parse(raw) is JsonObject captured
				&& Text(captured["pageType"], 40) is "order-detail" or "logistics-detail")
			{
				// A normalized browser capture is not arbitrary HTML. Once it says
				// which order it captured, do not re-interpret its unrelated fields
				// as the requested order after exact normalization rejects it.
				if (!Boolean(captured["orderIdentityVerified"], fallback: false)
					|| Text(captured["purchaseOrderNumber"] ?? captured["orderNumber"], 180) != orderId) return false;
				return TryNormalizePurchaseCandidate(
					captured,
					pageUrl,
					platform,
					orderId,
					"supplier-hidden-structured-capture",
					out snapshot);
			}
		}
		catch (JsonException)
		{
			// The same parser also accepts HTML and embedded JSON responses.
		}
		if (platform == "1688")
		{
			if (Alibaba1688OrderNetworkParser.TryParse(raw, pageUrl, out JsonObject? network)
				&& network?["orderCandidates"] is JsonArray candidates)
			{
				JsonObject? exact = candidates.OfType<JsonObject>().FirstOrDefault(candidate =>
					Text(candidate["purchaseOrderNumber"] ?? candidate["orderNumber"], 180) == orderId);
				if (exact != null && TryNormalizePurchaseCandidate(exact, pageUrl, platform, orderId, "1688-structured-response", out snapshot))
				{
					return true;
				}
			}
		}

		// Network/structured multi-order parsing above selects an exact record.
		// The legacy free-text fallback is a single-order detail reader: without
		// one complete, unambiguous identity its amounts have no safe owner.
		string? actualOrderId = VerifiedSupplierDetailOrderId(raw, documentText, orderId);
		if (actualOrderId == null) return false;
		if (platform == "1688")
		{
			if (Alibaba1688OrderNetworkParser.TryParseVisibleOrderText(documentText, pageUrl, out JsonObject? visible)
				&& visible?["orderCandidates"] is JsonArray visibleCandidates)
			{
				JsonObject? exact = visibleCandidates.OfType<JsonObject>().FirstOrDefault(candidate =>
					Text(candidate["purchaseOrderNumber"] ?? candidate["orderNumber"], 180) == orderId);
				if (exact != null && TryNormalizePurchaseCandidate(exact, pageUrl, platform, orderId, "1688-visible-response", out snapshot))
				{
					return true;
				}
			}
		}

		string status = ExtractSupplierOrderStatus(raw, documentText);
		double? amount = ExtractSupplierOrderAmount(raw, documentText, platform);
		if (status.Length == 0 || amount == null || amount <= 0) return false;
		bool refundConfirmed = Regex.IsMatch(
			status,
			"退款成功|已退款|退款完成",
			RegexOptions.CultureInvariant,
			TimeSpan.FromSeconds(1.0))
			&& !Regex.IsMatch(status, "申请退款|退款处理中|等待退款", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1.0));
		bool paymentConfirmed = !refundConfirmed && Regex.IsMatch(
			status,
			"支付成功|买家已付款|已付款|待发货|等待卖家发货|等待商家发货|已发货|待收货|交易成功|已完成",
			RegexOptions.CultureInvariant,
			TimeSpan.FromSeconds(1.0))
			&& !Regex.IsMatch(status, "待付款|等待付款|关闭|取消", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1.0));
		snapshot = new JsonObject
		{
			["platform"] = platform == "pdd" ? "pinduoduo" : platform,
			["purchaseOrderNumber"] = actualOrderId,
			["orderNumber"] = actualOrderId,
			["purchaseOrderUrl"] = pageUrl,
			["purchasePrice"] = Math.Round(amount.Value, 2, MidpointRounding.AwayFromZero),
			["currency"] = "CNY",
			["purchaseOrderStatus"] = status,
			["orderStatus"] = status,
			["status"] = status,
			["paymentConfirmed"] = paymentConfirmed,
			["refundConfirmed"] = refundConfirmed,
			["sourceMethod"] = "supplier-cookie-http-detail",
			["fetchedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)
		};
		return true;
	}

	private static bool TryNormalizePurchaseCandidate(
		JsonObject candidate,
		string pageUrl,
		string platform,
		string orderId,
		string sourceMethod,
		out JsonObject? snapshot)
	{
		snapshot = null;
		string capturedOrderId = Text(candidate["purchaseOrderNumber"] ?? candidate["orderNumber"], 180);
		string capturedPlatform = PlatformKey(Text(candidate["platform"], 60));
		string status = Text(candidate["purchaseOrderStatus"] ?? candidate["orderStatus"] ?? candidate["status"], 160);
		double amount = Number(candidate["purchasePrice"] ?? candidate["amount"]);
		bool sharedAlibabaOrder = (capturedPlatform is "taobao" or "tmall")
			&& (platform is "taobao" or "tmall");
		if (capturedOrderId != orderId
			|| (capturedPlatform.Length > 0 && capturedPlatform != platform && !sharedAlibabaOrder)
			|| status.Length == 0
			|| !double.IsFinite(amount) || amount <= 0) return false;
		string resolvedPlatform = capturedPlatform.Length > 0 ? capturedPlatform : platform;
		snapshot = new JsonObject
		{
			["platform"] = resolvedPlatform,
			["purchaseOrderNumber"] = capturedOrderId,
			["orderNumber"] = capturedOrderId,
			["purchaseOrderUrl"] = Text(candidate["purchaseOrderUrl"] ?? candidate["pageUrl"], 1000).Length > 0
				? Text(candidate["purchaseOrderUrl"] ?? candidate["pageUrl"], 1000)
				: pageUrl,
			["purchasePrice"] = Math.Round(amount, 2, MidpointRounding.AwayFromZero),
			["currency"] = Text(candidate["currency"], 12).Length > 0 ? Text(candidate["currency"], 12) : "CNY",
			["purchaseOrderStatus"] = status,
			["orderStatus"] = status,
			["status"] = status,
			["paymentConfirmed"] = Boolean(candidate["paymentConfirmed"], fallback: false),
			["refundConfirmed"] = Boolean(candidate["refundConfirmed"], fallback: false),
			["sourceMethod"] = sourceMethod,
			["fetchedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)
		};
		return true;
	}

	private static string SupplierDocumentText(string raw)
	{
		AssertSupplierPageSize(raw);
		try
		{
			string decoded = WebUtility.HtmlDecode(raw ?? string.Empty).Replace("\\/", "/", StringComparison.Ordinal);
			decoded = Regex.Replace(
				decoded,
				@"\\u(?<hex>[0-9a-fA-F]{4})",
				match => ((char)int.Parse(match.Groups["hex"].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture)).ToString(),
				RegexOptions.CultureInvariant | RegexOptions.NonBacktracking,
				SupplierPatternTimeout);
			decoded = decoded.Replace("\\\"", "\"", StringComparison.Ordinal);
			string text = Regex.Replace(HtmlTag().Replace(decoded, " "), "\\s+", " ",
				RegexOptions.CultureInvariant | RegexOptions.NonBacktracking, SupplierPatternTimeout).Trim();
			AssertSupplierPageSize(raw, text);
			return text;
		}
		catch (RegexMatchTimeoutException error)
		{
			throw new InvalidOperationException("CROSS_BORDER_PURCHASE_PAGE_TOO_COMPLEX", error);
		}
	}

	private static void AssertSupplierPageSize(string? raw, string? documentText = null)
	{
		if ((raw?.Length ?? 0) > MaximumSupplierResponseBytes
			|| (documentText?.Length ?? 0) > MaximumSupplierDocumentCharacters)
			throw new InvalidOperationException("CROSS_BORDER_PURCHASE_PAGE_TOO_LARGE");
	}

	private static bool OrderTokenCharacter(char value) => char.IsAsciiLetterOrDigit(value) || value is '_' or '-';

	private static bool ContainsExactSupplierOrderToken(string source, string orderId)
	{
		AssertSupplierPageSize(source);
		if (string.IsNullOrEmpty(orderId) || orderId.Length > 180) return false;
		int start = 0;
		while ((start = source.IndexOf(orderId, start, StringComparison.Ordinal)) >= 0)
		{
			int end = start + orderId.Length;
			if ((start == 0 || !OrderTokenCharacter(source[start - 1]))
				&& (end == source.Length || !OrderTokenCharacter(source[end]))) return true;
			start += 1;
		}
		return false;
	}

	private static string? VerifiedSupplierDetailOrderId(string raw, string documentText, string expected)
	{
		AssertSupplierPageSize(raw, documentText);
		HashSet<string> identities = new(StringComparer.Ordinal);
		long startedAt = Stopwatch.GetTimestamp();
		int observations = 0;
		void CheckBudget()
		{
			if (Stopwatch.GetElapsedTime(startedAt) > SupplierPatternTimeout)
				throw new InvalidOperationException("CROSS_BORDER_PURCHASE_PAGE_TOO_COMPLEX");
		}
		try
		{
			foreach (string source in new[] { raw, documentText })
			{
				foreach (Regex pattern in new[] { SupplierOrderLabelRegex, SupplierOrderFieldRegex, SupplierOrderAttributeRegex })
				{
					CheckBudget();
					foreach (Match match in pattern.Matches(source))
					{
						if ((++observations & 127) == 0) CheckBudget();
						if (ReferenceEquals(pattern, SupplierOrderLabelRegex))
						{
							string prefix = source.Substring(Math.Max(0, match.Index - 8), Math.Min(8, match.Index)).TrimEnd();
							if (new[] { "支付宝", "支付", "物流", "运单" }.Any(value => prefix.EndsWith(value, StringComparison.Ordinal))) continue;
						}
						string identity = match.Groups["id"].Value;
						if (identity.Length > 180) throw new InvalidOperationException("CROSS_BORDER_PURCHASE_ORDER_IDENTITY_INVALID");
						identities.Add(identity);
						if (identities.Count > 1) throw new InvalidOperationException("CROSS_BORDER_PURCHASE_ORDER_AMBIGUOUS");
					}
					CheckBudget();
				}
			}
		}
		catch (RegexMatchTimeoutException error)
		{
			throw new InvalidOperationException("CROSS_BORDER_PURCHASE_PAGE_TOO_COMPLEX", error);
		}
		return identities.Count == 1 && identities.Contains(expected) ? identities.Single() : null;
	}

	private static string ExtractSupplierOrderStatus(string raw, string documentText)
	{
		Match labelled = Regex.Match(
			documentText,
			@"(?:当前订单状态|订单状态|交易状态|售后状态)\s*[:：]?\s*(?<value>退款成功|已退款|退款完成|退款处理中|申请退款|交易关闭|订单关闭|已关闭|已取消|交易取消|待付款|等待付款|支付成功|买家已付款|已付款|待发货|等待卖家发货|等待商家发货|已发货|待收货|交易成功|已完成)",
			RegexOptions.CultureInvariant,
			TimeSpan.FromSeconds(1.0));
		if (labelled.Success) return Text(labelled.Groups["value"].Value, 160);
		Match preferredStructured = Regex.Match(
			raw,
			@"[""'](?:orderStatusPrompt|order_status_prompt|chatStatusPrompt|chat_status_prompt)[""']\s*:\s*[""'](?<value>[^""']{1,160})[""']",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
			TimeSpan.FromSeconds(1.0));
		if (preferredStructured.Success)
		{
			string normalized = NormalizeSupplierStatusCode(preferredStructured.Groups["value"].Value);
			if (normalized.Length > 0) return normalized;
		}
		Match structured = Regex.Match(
			raw,
			@"[""'](?:order_status_text|orderStatusText|status_text|statusText|order_status_desc|orderStatusDesc|tradeStatus|orderStatus)[""']\s*:\s*[""'](?<value>[^""']{1,160})[""']",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
			TimeSpan.FromSeconds(1.0));
		if (structured.Success)
		{
			string normalized = NormalizeSupplierStatusCode(structured.Groups["value"].Value);
			if (normalized.Length > 0) return normalized;
		}
		Match known = Regex.Match(
			documentText,
			@"退款成功|已退款|退款完成|退款处理中|申请退款|交易关闭|订单关闭|已关闭|已取消|交易取消|待付款|等待付款|支付成功|买家已付款|已付款|待发货|等待卖家发货|等待商家发货|已发货|待收货|交易成功|已完成",
			RegexOptions.CultureInvariant,
			TimeSpan.FromSeconds(1.0));
		return known.Success ? Text(known.Value, 160) : string.Empty;
	}

	private static string NormalizeSupplierStatusCode(string value)
	{
		string status = Text(WebUtility.HtmlDecode(value ?? string.Empty), 160);
		string key = Regex.Replace(status, "[^A-Za-z0-9]+", "_", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1.0)).Trim('_').ToUpperInvariant();
		return key switch
		{
			"WAIT_BUYER_PAY" or "WAIT_PAYMENT" or "UNPAID" => "待付款",
			"WAIT_SELLER_SEND_GOODS" or "WAIT_SELLER_SEND" or "PAID" => "待发货",
			"WAIT_BUYER_CONFIRM_GOODS" or "WAIT_BUYER_RECEIVE" or "SHIPPED" => "已发货",
			"TRADE_FINISHED" or "SUCCESS" or "COMPLETED" => "交易成功",
			"TRADE_CLOSED" or "CANCEL" or "CANCELLED" or "CANCELED" => "交易关闭",
			"REFUND_SUCCESS" or "REFUNDED" => "退款成功",
			_ => Regex.IsMatch(status, @"[\u4e00-\u9fff]", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1.0)) ? status : string.Empty
		};
	}

	private static double? ExtractSupplierOrderAmount(string raw, string documentText, string platform)
	{
		Match labelled = Regex.Match(
			documentText,
			@"(?:订单实付|实付款(?:含运费|\(\s*含运费\s*\)|（\s*含运费\s*）)?|实付金额|付款金额|支付金额|订单金额|应付金额|应付总额|订单总价|总金额|总计|合计)\s*[:：]?\s*[¥￥]?\s*(?<value>[\d,]+(?:\.\d{1,2})?)",
			RegexOptions.CultureInvariant,
			TimeSpan.FromSeconds(1.0));
		if (labelled.Success && TryParsePurchaseMoney(labelled.Groups["value"].Value, out double labelledAmount))
		{
			return labelledAmount;
		}
		Match structured = Regex.Match(
			raw,
			@"[""'](?<key>actualAmount|payAmount|paidAmount|totalAmount|orderAmount|sumPayment|sumPaymentNoCarriage|totalFee|actualFee|pay_fee|pay_price|payPrice|order_amount|pay_amount|paid_amount|total_amount)[""']\s*:\s*[""']?(?<value>[\d,]+(?:\.\d{1,2})?)[""']?",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
			TimeSpan.FromSeconds(1.0));
		if (!structured.Success || !TryParsePurchaseMoney(structured.Groups["value"].Value, out double structuredAmount))
		{
			return null;
		}
		string rawValue = structured.Groups["value"].Value;
		if (platform == "pdd" && !rawValue.Contains('.', StringComparison.Ordinal) && structuredAmount >= 100)
		{
			structuredAmount /= 100.0;
		}
		return Math.Round(structuredAmount, 2, MidpointRounding.AwayFromZero);
	}

	private static bool TryParsePurchaseMoney(string value, out double amount)
	{
		return double.TryParse(
			(value ?? string.Empty).Replace(",", string.Empty, StringComparison.Ordinal),
			NumberStyles.AllowDecimalPoint | NumberStyles.AllowThousands,
			CultureInfo.InvariantCulture,
			out amount)
			&& double.IsFinite(amount)
			&& amount > 0;
	}

	private async Task<JsonObject> UpdatePackageAsync(JsonObject order, JsonObject logistics)
	{
		if (Text(order["orderId"], 180).Length == 0 || Text(order["packId"], 180).Length == 0)
		{
			throw new InvalidOperationException("CROSS_BORDER_PACKAGE_CONTEXT_MISSING");
		}
		return await RequestBusAsync("/index/plugin/updatePackage", HttpMethod.Post, new Dictionary<string, string>
		{
			["express_number_title"] = Text(logistics["carrier"], 100),
			["express_number_value"] = Text(logistics["trackingNumber"], 180),
			["orderId"] = Text(order["orderId"], 180),
			["packId"] = Text(order["packId"], 180)
		}).ConfigureAwait(continueOnCapturedContext: false);
	}

	private async Task<JsonObject> RequestBusAsync(string pathname, HttpMethod? method = null, IReadOnlyDictionary<string, string>? form = null)
	{
		Uri uri = new Uri(new Uri("https://www.kuajing84.com"), pathname);
		string text = await RequestTextAsync(uri, method ?? HttpMethod.Get, form, null).ConfigureAwait(continueOnCapturedContext: false);
		JsonObject jsonObject = ParseBusResponse(text);
		if (jsonObject["code"] != null && Number(jsonObject["code"]) != 1.0)
		{
			string input = ApiMessage(jsonObject);
			if (LoginMessage().IsMatch(input))
			{
				throw new InvalidOperationException("CROSS_BORDER_LOGIN_REQUIRED");
			}
			throw new InvalidOperationException("CROSS_BORDER_API_FAILED");
		}
		return jsonObject;
	}

	private static JsonObject ParseBusResponse(string raw)
	{
		if (ParseJson(raw) is not JsonObject body)
		{
			throw new InvalidOperationException(LoginMessage().IsMatch(raw)
				? "CROSS_BORDER_LOGIN_REQUIRED" : "CROSS_BORDER_API_FAILED");
		}
		// Table endpoints use code=0 for normal data as well as some expired
		// sessions. An explicit failure must not become a successful empty list.
		if (LoginRequiredMessageRegex.IsMatch(ApiMessage(body)))
			throw new InvalidOperationException("CROSS_BORDER_LOGIN_REQUIRED");
		foreach (string flag in new[] { "success", "ok" })
		{
			if (body[flag] is JsonValue value && value.TryGetValue<bool>(out bool success) && !success)
				throw new InvalidOperationException("CROSS_BORDER_API_FAILED");
		}
		return body;
	}

	private Task<string> RequestSupplierTextAsync(string url, Encoding? encoding = null)
	{
		Uri uri = new Uri(url);
		if (!AllowedSupplierHost(uri.Host))
		{
			throw new InvalidOperationException("CROSS_BORDER_SUPPLIER_REQUEST_FAILED");
		}
		return RequestTextAsync(uri, HttpMethod.Get, null, encoding, boundedSupplierResponse: true);
	}

	private async Task<string> RequestTextAsync(Uri uri, HttpMethod method, IReadOnlyDictionary<string, string>? form, Encoding? preferredEncoding,
		bool boundedSupplierResponse = false)
	{
		if (uri.Scheme != Uri.UriSchemeHttps || !AllowedNetworkHost(uri.Host))
		{
			throw new InvalidOperationException("CROSS_BORDER_API_FAILED");
		}
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(CurrentToken);
		deadline.CancelAfter(RequestTimeout);
		CancellationToken token = deadline.Token;
		try
		{
			using HttpRequestMessage request = new HttpRequestMessage(method, uri);
			request.Headers.Accept.ParseAdd(uri.Host.EndsWith("kuajing84.com", StringComparison.OrdinalIgnoreCase) ? "application/json, text/plain, */*" : "text/html, application/json, */*");
			request.Headers.TryAddWithoutValidation("User-Agent", profile.UserAgent);
			request.Headers.TryAddWithoutValidation("Accept-Language", profile.AcceptLanguage);
			string text = await CookieHeaderAsync(uri).WaitAsync(token).ConfigureAwait(false);
			if (text.Length > 0) request.Headers.TryAddWithoutValidation("Cookie", text);
			if (form != null) request.Content = new FormUrlEncodedContent(form);
			using HttpResponseMessage response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);
			await ImportResponseCookiesAsync(uri, response.Headers).WaitAsync(token).ConfigureAwait(false);
			if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
			{
				throw new InvalidOperationException("CROSS_BORDER_LOGIN_REQUIRED");
			}
			if (!response.IsSuccessStatusCode) throw new InvalidOperationException(uri.Host.EndsWith("kuajing84.com", StringComparison.OrdinalIgnoreCase) ? "CROSS_BORDER_API_FAILED" : "CROSS_BORDER_SUPPLIER_REQUEST_FAILED");
			byte[] bytes = boundedSupplierResponse
				? await ReadBoundedSupplierResponseAsync(response.Content, token).ConfigureAwait(false)
				: await ReadBoundedResponseAsync(response.Content, token, MaximumBusResponseBytes, "CROSS_BORDER_RESPONSE_TOO_LARGE").ConfigureAwait(false);
			return (preferredEncoding ?? ResponseEncoding(response.Content.Headers.ContentType)).GetString(bytes);
		}
		catch (OperationCanceledException error) when (CurrentToken.IsCancellationRequested)
		{
			throw new InvalidOperationException("CROSS_BORDER_OPERATION_CANCELLED", error);
		}
		catch (OperationCanceledException error)
		{
			throw new InvalidOperationException("CROSS_BORDER_REQUEST_TIMEOUT", error);
		}
		catch (HttpRequestException error) { throw new InvalidOperationException("CROSS_BORDER_NETWORK_FAILED", error); }
	}

	private static Task<byte[]> ReadBoundedSupplierResponseAsync(HttpContent content, CancellationToken token)
		=> ReadBoundedResponseAsync(content, token, MaximumSupplierResponseBytes, "CROSS_BORDER_PURCHASE_PAGE_TOO_LARGE");

	private static async Task<byte[]> ReadBoundedResponseAsync(HttpContent content, CancellationToken token, int maximumBytes, string overflowCode)
	{
		if (content.Headers.ContentLength > maximumBytes)
			throw new InvalidOperationException(overflowCode);
		using Stream source = await content.ReadAsStreamAsync(token).ConfigureAwait(false);
		using var collected = new MemoryStream();
		byte[] buffer = new byte[64 * 1024];
		while (true)
		{
			int available = (int)Math.Min(buffer.Length, maximumBytes - collected.Length + 1);
			int read = await source.ReadAsync(buffer.AsMemory(0, available), token).AsTask().WaitAsync(token).ConfigureAwait(false);
			if (read == 0) return collected.ToArray();
			if (collected.Length + read > maximumBytes)
				throw new InvalidOperationException(overflowCode);
			collected.Write(buffer, 0, read);
		}
	}

	private async Task<string> CookieHeaderAsync(Uri uri)
	{
		ICookieManager cookieManager = await requestContext.GetCookieManagerAsync().ConfigureAwait(continueOnCapturedContext: false);
		if (cookieManager == null)
		{
			return string.Empty;
		}
		return string.Join("; ", (await cookieManager.VisitUrlCookiesAsync(uri.ToString(), includeHttpOnly: true).ConfigureAwait(continueOnCapturedContext: false)).Select((CefSharp.Cookie cookie) => cookie.Name + "=" + cookie.Value));
	}

	private async Task ImportResponseCookiesAsync(Uri requestUri, HttpResponseHeaders headers)
	{
		if (!headers.TryGetValues("Set-Cookie", out var values))
		{
			return;
		}
		ICookieManager manager = await requestContext.GetCookieManagerAsync().ConfigureAwait(continueOnCapturedContext: false);
		if (manager == null)
		{
			return;
		}
		foreach (string item in values)
		{
			CefSharp.Cookie? cookie = ParseSetCookie(requestUri, item);
			if (cookie != null)
			{
				await manager.SetCookieAsync(requestUri.GetLeftPart(UriPartial.Authority), cookie).ConfigureAwait(continueOnCapturedContext: false);
			}
		}
		await manager.FlushStoreAsync().ConfigureAwait(continueOnCapturedContext: false);
	}

	private static CefSharp.Cookie? ParseSetCookie(Uri requestUri, string header)
	{
		string[] array = header.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
		if (array.Length == 0)
		{
			return null;
		}
		int num = array[0].IndexOf('=');
		if (num <= 0)
		{
			return null;
		}
		CefSharp.Cookie obj = new CefSharp.Cookie
		{
			Name = array[0].Substring(0, num).Trim()
		};
		string text = array[0];
		int num2 = num + 1;
		obj.Value = text.Substring(num2, text.Length - num2).Trim();
		obj.Domain = requestUri.Host;
		obj.Path = "/";
		CefSharp.Cookie cookie = obj;
		foreach (string item in array.Skip(1))
		{
			int num3 = item.IndexOf('=');
			string text2 = ((num3 < 0) ? item : item.Substring(0, num3)).Trim();
			string text3;
			if (num3 >= 0)
			{
				text = item;
				num2 = num3 + 1;
				text3 = text.Substring(num2, text.Length - num2).Trim();
			}
			else
			{
				text3 = string.Empty;
			}
			string text4 = text3;
			DateTime result;
			if (text2.Equals("domain", StringComparison.OrdinalIgnoreCase) && text4.Length > 0)
			{
				cookie.Domain = text4;
			}
			else if (text2.Equals("path", StringComparison.OrdinalIgnoreCase) && text4.Length > 0)
			{
				cookie.Path = text4;
			}
			else if (text2.Equals("secure", StringComparison.OrdinalIgnoreCase))
			{
				cookie.Secure = true;
			}
			else if (text2.Equals("httponly", StringComparison.OrdinalIgnoreCase))
			{
				cookie.HttpOnly = true;
			}
			else if (text2.Equals("expires", StringComparison.OrdinalIgnoreCase) && DateTime.TryParse(text4, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out result))
			{
				cookie.Expires = result.ToUniversalTime();
			}
		}
		return cookie;
	}

	private static HttpClientHandler CreateHandler(BrowserProfile profile)
	{
		HttpClientHandler httpClientHandler = new HttpClientHandler
		{
			AllowAutoRedirect = true,
			AutomaticDecompression = DecompressionMethods.All,
			UseCookies = false,
			UseProxy = false
		};
		if (BrowserProfile.Text(profile.Proxy, "mode", "direct", 40) != "fixed_servers")
		{
			return httpClientHandler;
		}
		Uri? uri = ProxyUri(BrowserProfile.Text(profile.Proxy, "rules", string.Empty, 500));
		if (uri == null)
		{
			return httpClientHandler;
		}
		httpClientHandler.UseProxy = true;
		httpClientHandler.Proxy = new WebProxy(uri)
		{
			BypassProxyOnLocal = true
		};
		return httpClientHandler;
	}

	private static Uri? ProxyUri(string rules)
	{
		string? text = rules.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(delegate(string candidate)
		{
			if (!candidate.Contains('='))
			{
				return candidate;
			}
			int num = candidate.IndexOf('=') + 1;
			return candidate.Substring(num, candidate.Length - num);
		}).FirstOrDefault((string candidate) => candidate.Length > 0);
		if (string.IsNullOrWhiteSpace(text))
		{
			return null;
		}
		if (!text.Contains("://", StringComparison.Ordinal))
		{
			text = "http://" + text;
		}
		if (!Uri.TryCreate(text, UriKind.Absolute, out var result))
		{
			return null;
		}
		return result;
	}

	private static Encoding ResponseEncoding(MediaTypeHeaderValue? contentType)
	{
		string text = contentType?.CharSet?.Trim('"', '\'').ToLowerInvariant() ?? string.Empty;
		if (text.Contains("gb") || text.Contains("936"))
		{
			return Encoding.GetEncoding(936);
		}
		try
		{
			return (text.Length > 0) ? Encoding.GetEncoding(text) : Encoding.UTF8;
		}
		catch
		{
			return Encoding.UTF8;
		}
	}

	private static JsonObject NormalizePendingOrder(JsonObject source)
	{
		JsonObject jsonObject = new JsonObject();
		jsonObject["orderId"] = Text(First(source, "order_id", "orderId", "id", "purchase_order_id"), 180);
		jsonObject["packId"] = Text(First(source, "pack_id", "packId", "package_id"), 180);
		jsonObject["collectionNumber"] = Text(First(source, "collection_number", "collectionNumber"), 180);
		jsonObject["orderStatus"] = Text(First(source, "order_status", "orderStatus", "status"), 120);
		jsonObject["fromName"] = Text(First(source, "from_name", "fromName", "platform"), 40);
		jsonObject["forecastTime"] = Text(First(source, "time", "forecast_time", "forecastTime"), 80);
		return jsonObject;
	}

	private static JsonObject NormalizeChargeRecord(JsonObject source)
	{
		string collectionNumber = Text(First(source, "oid", "collection_number", "collectionNumber", "order_id"), 180);
		string type = Text(First(source, "type", "direction", "category", "trade_type"), 80);
		JsonNode? moneyNode = First(source, "money", "amount", "amount_cny", "change_money");
		if (moneyNode is not JsonValue || !double.TryParse(moneyNode.ToString(),
			NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out double money)
			|| !double.IsFinite(money))
		{
			throw new InvalidOperationException("CROSS_BORDER_CHARGE_AMOUNT_INVALID");
		}
		string occurredAt = Text(First(source, "time", "occurred_at", "occurredAt"), 80);
		string balanceAfter = Text(First(source, "after_money", "afterMoney", "balance", "balance_after"), 80);
		string reason = Text(source["reason"], 300);
		string warehouse = Text(First(source, "storehours_name", "storehouse_name", "warehouse"), 240);
		string serviceCompany = Text(First(source, "brand_name", "service_company", "service"), 300);
		bool refundReason = reason.Contains("退还", StringComparison.Ordinal)
			|| reason.Contains("退回", StringComparison.Ordinal)
			|| reason.Contains("退款", StringComparison.Ordinal)
			|| reason.Contains("返还", StringComparison.Ordinal)
			|| reason.Contains("返款", StringComparison.Ordinal)
			|| reason.Contains("返费", StringComparison.Ordinal)
			|| reason.Contains("冲正", StringComparison.Ordinal)
			|| ((reason.Contains("取消", StringComparison.Ordinal) || reason.Contains("撤销", StringComparison.Ordinal))
				&& (reason.Contains("退", StringComparison.Ordinal) || reason.Contains("返", StringComparison.Ordinal)));
		bool expenseReason = reason.Contains("支付", StringComparison.Ordinal)
			|| reason.Contains("发货费用", StringComparison.Ordinal)
			|| reason.Contains("补收", StringComparison.Ordinal)
			|| reason.Contains("扣费", StringComparison.Ordinal)
			|| reason.Contains("扣款", StringComparison.Ordinal)
			|| reason.Contains("消费", StringComparison.Ordinal)
			|| reason.Contains("收费", StringComparison.Ordinal)
			|| reason.Contains("实际服务费", StringComparison.Ordinal)
			|| reason.Contains("系统服务费", StringComparison.Ordinal);
		string direction = refundReason
			? "income"
			: expenseReason
			? "expense"
			: type.Contains("收入", StringComparison.Ordinal)
			|| type.Contains("退款", StringComparison.Ordinal)
			|| type.Contains("返", StringComparison.Ordinal)
			|| type.Equals("in", StringComparison.OrdinalIgnoreCase)
			|| type.Equals("income", StringComparison.OrdinalIgnoreCase)
			? "income"
			: type.Contains("支出", StringComparison.Ordinal)
			|| type.Contains("消费", StringComparison.Ordinal)
			|| type.Contains("扣", StringComparison.Ordinal)
			|| type.Equals("out", StringComparison.OrdinalIgnoreCase)
			|| type.Equals("expense", StringComparison.OrdinalIgnoreCase)
			? "expense"
			: money < 0 ? "income" : "expense";
		string sourceKey = Text(First(source, "id", "record_id", "recordId", "流水号"), 180);
		if (sourceKey.Length == 0)
		{
				sourceKey = string.Join("|", new[]
			{
				collectionNumber,
				occurredAt,
				money.ToString(CultureInfo.InvariantCulture),
				balanceAfter,
				reason,
				warehouse,
				serviceCompany
			});
		}
		return new JsonObject
		{
			["sourceRecordKey"] = sourceKey,
			["collectionNumber"] = collectionNumber,
			["direction"] = direction,
			["type"] = type,
			["amountCny"] = Math.Abs(money).ToString(CultureInfo.InvariantCulture),
			["balanceAfterCny"] = balanceAfter,
			["reason"] = reason,
			["occurredAt"] = occurredAt,
			["warehouse"] = warehouse,
			["serviceCompany"] = serviceCompany
		};
	}

	private static JsonObject NormalizeChargeOrder(JsonObject source)
	{
		return new JsonObject
		{
			["internalOrderId"] = Text(First(source, "id", "oid", "account_order_id", "order_id"), 180),
			["collectionNumber"] = Text(First(source, "order_id", "collection_number", "collectionNumber", "oid"), 180),
			["postingNumber"] = Text(First(source, "order_number", "posting_number", "postingNumber"), 180),
			["purchaseOrderNumber"] = Text(First(source, "from_order", "purchase_order_number", "purchaseOrderNumber", "purchase_order_no"), 180),
			["trackingNumber"] = Text(First(source, "tracking_number", "trackingNumber", "logistics_order"), 180),
			["sheetOrderSn"] = Text(First(source, "sheet_order_sn", "section_order", "sheetOrderSn"), 180),
			["serviceName"] = Text(First(source, "service_name", "brand_name", "logistics"), 240),
			["warehouse"] = Text(First(source, "storehours_name", "storehouse_name", "warehouse"), 240),
			["orderStatus"] = Text(First(source, "status", "order_status", "orderStatus"), 120),
			["packageWeightKg"] = Text(First(source, "weight", "package_weight", "chargeweight"), 80)
		};
	}

	private static JsonObject SanitizeFeeDetail(JsonNode? payload)
	{
		JsonObject source = payload as JsonObject ?? new JsonObject();
		JsonObject result = new JsonObject();
		foreach (KeyValuePair<string, JsonNode?> item in source)
		{
			string key = item.Key.Trim();
			string lower = key.ToLowerInvariant();
			if (lower.Contains("pass", StringComparison.Ordinal) || lower.Contains("token", StringComparison.Ordinal) || lower.Contains("cookie", StringComparison.Ordinal) || lower.Contains("phone", StringComparison.Ordinal) || lower.Contains("address", StringComparison.Ordinal) || lower.Contains("name", StringComparison.Ordinal)) continue;
			if (item.Value is JsonValue || item.Value is null) result[key] = item.Value?.DeepClone();
		}
		return result;
	}

	private static string FirstMoney(JsonNode? payload, params string[] names)
	{
		JsonObject source = payload as JsonObject ?? new JsonObject();
		return Text(First(source, names), 80);
	}

	private static JsonObject NormalizeTrace(JsonNode? value)
	{
		JsonObject jsonObject = (Payload(value) as JsonObject) ?? new JsonObject();
		JsonObject source = ((jsonObject["detailList"] is JsonArray source2 && source2.FirstOrDefault() is JsonObject jsonObject2) ? jsonObject2 : new JsonObject());
		JsonObject jsonObject3 = new JsonObject();
		jsonObject3["carrier"] = Text(First(source, "cpName", "cp_name", "companyName"), 100);
		jsonObject3["trackingNumber"] = Text(First(source, "mailNo", "mail_no", "mailNumber"), 180);
		jsonObject3["authorizationUrl"] = Text(jsonObject["url"] ?? (value as JsonObject)?["data"]?["url"], 1000);
		return jsonObject3;
	}

	private static JsonObject ParseOriginalPluginLogistics(string raw)
	{
		JsonObject source = (ParseJson(raw) as JsonObject) ?? new JsonObject();
		return new JsonObject
		{
			["carrier"] = Text(source["carrier"], 100),
			["trackingNumber"] = Text(source["trackingNumber"], 180)
		};
	}

	private static JsonNode? ParseJson(string raw)
	{
		string text = raw.Trim();
		if (text.Length == 0)
		{
			return null;
		}
		try
		{
			return JsonNode.Parse(text);
		}
		catch
		{
			Match match = Jsonp().Match(text);
			if (!match.Success)
			{
				return null;
			}
			try
			{
				return JsonNode.Parse(match.Groups["json"].Value);
			}
			catch
			{
				return null;
			}
		}
	}

	private static JsonNode? Payload(JsonNode? value)
	{
		if (!(value is JsonObject jsonObject))
		{
			return value;
		}
		return jsonObject["data"] ?? jsonObject["result"] ?? jsonObject["payload"] ?? value;
	}

	private static IEnumerable<JsonNode?> List(JsonNode? value)
	{
		JsonNode? jsonNode = Payload(value);
		if (jsonNode is JsonArray result)
		{
			return result;
		}
		if (!(jsonNode is JsonObject jsonObject))
		{
			return Array.Empty<JsonNode?>();
		}
		JsonNode?[] array = new JsonNode?[4]
		{
			jsonObject["list"],
			jsonObject["items"],
			jsonObject["data"]?["list"],
			jsonObject["result"]?["list"]
		};
		for (int i = 0; i < array.Length; i++)
		{
			if (array[i] is JsonArray result2)
			{
				return result2;
			}
		}
		return Array.Empty<JsonNode?>();
	}

	private static JsonNode? First(JsonObject source, params string[] names)
	{
		foreach (string propertyName in names)
		{
			JsonNode? jsonNode = source[propertyName];
			if (jsonNode != null)
			{
				return jsonNode;
			}
		}
		return null;
	}

	private static JsonObject Merge(JsonObject left, JsonObject right)
	{
		JsonObject jsonObject = left.DeepClone().AsObject();
		foreach (KeyValuePair<string, JsonNode?> item in right)
		{
			jsonObject[item.Key] = item.Value?.DeepClone();
		}
		return jsonObject;
	}

	private static string PlatformKey(string value)
	{
		string text = Text(value, 60).ToLowerInvariant();
		if (text == "1688")
		{
			return "1688";
		}
		if (text == "cross-border" || text == "kuajing84" || text.Contains("跨境巴士", StringComparison.Ordinal))
		{
			return "cross-border";
		}
		if (text == "taobao" || text.Contains("淘宝", StringComparison.Ordinal))
		{
			return "taobao";
		}
		if (text == "tmall" || text.Contains("天猫", StringComparison.Ordinal))
		{
			return "tmall";
		}
		bool flag = ((text == "pdd" || text == "pinduoduo") ? true : false);
		if (flag || text.Contains("拼多多", StringComparison.Ordinal))
		{
			return "pdd";
		}
		return string.Empty;
	}

	private static string AllowedSupplierAuthorizationUrl(string value)
	{
		if (!Uri.TryCreate(value, UriKind.Absolute, out var result) || result.Scheme != Uri.UriSchemeHttps)
		{
			return string.Empty;
		}
		if (!HostMatches(result.Host, "taobao.com") && !HostMatches(result.Host, "tmall.com"))
		{
			return string.Empty;
		}
		return result.ToString();
	}

	private static bool AllowedNetworkHost(string host)
	{
		if (!HostMatches(host, "kuajing84.com"))
		{
			return AllowedSupplierHost(host);
		}
		return true;
	}

	private static bool AllowedSupplierHost(string host)
	{
		if (!HostMatches(host, "1688.com") && !HostMatches(host, "taobao.com") && !HostMatches(host, "tmall.com") && !HostMatches(host, "yangkeduo.com"))
		{
			return HostMatches(host, "pinduoduo.com");
		}
		return true;
	}

	private static bool HostMatches(string host, string suffix)
	{
		if (!host.Equals(suffix, StringComparison.OrdinalIgnoreCase))
		{
			return host.EndsWith("." + suffix, StringComparison.OrdinalIgnoreCase);
		}
		return true;
	}

	private static string ApiMessage(JsonObject body)
	{
		JsonObject? jsonObject = Payload(body) as JsonObject;
		return Text(body["msg"] ?? body["message"] ?? jsonObject?["msg"] ?? jsonObject?["message"], 300);
	}

	private static double Number(JsonNode? node)
	{
		if (node == null)
		{
			return 0.0;
		}
		if (!double.TryParse(node.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var result))
		{
			return 0.0;
		}
		return result;
	}

	private static bool Boolean(JsonNode? node, bool fallback)
	{
		if (node == null)
		{
			return fallback;
		}
		if (!bool.TryParse(node.ToString(), out var result))
		{
			return fallback;
		}
		return result;
	}

	private static string Text(JsonNode? node, int maximum = 240)
	{
		return Text(node?.ToString(), maximum);
	}

	private static string Text(string? value, int maximum = 240)
	{
		string text = Whitespace().Replace(value ?? string.Empty, " ").Trim();
		return text.Substring(0, Math.Min(text.Length, maximum));
	}

	private static JsonNode? ReadLastSync(string path)
	{
		try
		{
			return File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8)) : null;
		}
		catch
		{
			return null;
		}
	}

	private static void WriteLastSync(string path, JsonObject value)
	{
		string text = $"{path}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
		try
		{
			File.WriteAllText(text, value.ToJsonString(new JsonSerializerOptions
			{
				Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
			}) + Environment.NewLine, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
			File.Move(text, path, overwrite: true);
		}
		finally
		{
			try
			{
				File.Delete(text);
			}
			catch
			{
			}
		}
	}

	private void ThrowIfDisposed()
	{
		if (disposed)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_CLOSED");
		}
	}

	public void Dispose()
	{
		if (!disposed)
		{
			disposed = true;
			lifetime.Cancel();
			http.Dispose();
			// In-flight operations still release their managed semaphores while
			// cancellation unwinds. Do not dispose those gates underneath them.
		}
	}

	private static Regex Whitespace()
	{
		return WhitespaceRegex;
	}

	private static Regex HtmlTag()
	{
		return HtmlTagRegex;
	}

	private static Regex Jsonp()
	{
		return JsonpRegex;
	}

	private static Regex LoginMessage()
	{
		return LoginMessageRegex;
	}

	private static Regex TrackingNumber()
	{
		return TrackingNumberRegex;
	}
}
