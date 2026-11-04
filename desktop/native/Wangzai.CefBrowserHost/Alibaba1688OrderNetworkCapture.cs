using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Wangzai.CefBrowserHost;

internal sealed class Alibaba1688OrderNetworkCapture
{
	private const string OrderListBaseUrl = "https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html";
	public const string OrderListUrl = OrderListBaseUrl + "?tradeStatus=all&page=1&pageSize=50";
	private const int MaximumResponseBytes = 8 * 1024 * 1024;
	private readonly TaskCompletionSource<JsonObject> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
	private readonly object diagnosticsLock = new();
	private readonly HashSet<string> observedApiEndpoints = new(StringComparer.OrdinalIgnoreCase);
	private readonly string expectedOrderNumber;
	private readonly string capturePageUrl;

	public Alibaba1688OrderNetworkCapture(string? expectedOrderNumber = null, string? capturePageUrl = null)
	{
		this.expectedOrderNumber = (expectedOrderNumber ?? string.Empty).Trim();
		this.capturePageUrl = (capturePageUrl ?? string.Empty).Trim();
	}

	public bool IsCompleted => completion.Task.IsCompleted;

	public static string BuildOrderListUrl(string? status)
	{
		string normalized = (status ?? string.Empty).Trim().ToLowerInvariant();
		if (!new[] { "all", "waitbuyerpay", "waitsellersend", "waitbuyerreceive", "success", "cancel" }
			.Contains(normalized, StringComparer.Ordinal))
		{
			normalized = "all";
		}
		return $"{OrderListBaseUrl}?tradeStatus={normalized}&page=1&pageSize=50";
	}

	public static bool Matches(string? url)
	{
		if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? parsed)
			|| !parsed.Host.EndsWith("1688.com", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}
		string path = parsed.AbsolutePath;
		return path.Contains("mtop.1688.trading.dataline.service", StringComparison.OrdinalIgnoreCase)
			|| path.Contains("mtop", StringComparison.OrdinalIgnoreCase)
			|| path.Contains("/h5/", StringComparison.OrdinalIgnoreCase)
			|| path.Contains("/api/", StringComparison.OrdinalIgnoreCase)
			|| path.Contains("order", StringComparison.OrdinalIgnoreCase)
				&& (path.Contains("query", StringComparison.OrdinalIgnoreCase)
					|| path.Contains("list", StringComparison.OrdinalIgnoreCase)
					|| path.Contains("detail", StringComparison.OrdinalIgnoreCase));
	}

	public void Observe(string? url)
	{
		if (!Matches(url)) return;
		string endpoint = SafeEndpoint(url ?? string.Empty);
		if (string.IsNullOrWhiteSpace(endpoint)) return;
		lock (diagnosticsLock)
		{
			if (observedApiEndpoints.Count < 16) observedApiEndpoints.Add(endpoint);
		}
	}

	public void Accept(string url, byte[] bytes)
	{
		if (completion.Task.IsCompleted || bytes.Length == 0 || bytes.Length > MaximumResponseBytes) return;
		try
		{
			string text = Encoding.UTF8.GetString(bytes);
			if (!string.IsNullOrWhiteSpace(expectedOrderNumber)
				&& Alibaba1688OrderNetworkParser.TryFindExplicitRefundStatus(text, out string refundStatus))
			{
				JsonObject exactRefund = new()
				{
					["extensionVersion"] = "1.1.0",
					["runtimeKind"] = "builtin-network",
					["sourceMethod"] = "1688-exact-detail-refund-response",
					["platform"] = "1688",
					["pageType"] = "order-detail",
					["pageUrl"] = capturePageUrl,
					["currentOrderNumber"] = expectedOrderNumber,
					["orderCandidates"] = new JsonArray(new JsonObject
					{
						["platform"] = "1688",
						["pageType"] = "order-detail",
						["pageUrl"] = capturePageUrl,
						["purchaseOrderUrl"] = capturePageUrl,
						["purchaseOrderNumber"] = expectedOrderNumber,
						["orderNumber"] = expectedOrderNumber,
						["purchaseOrderStatus"] = refundStatus,
						["orderStatus"] = refundStatus,
						["statusText"] = refundStatus,
						["status"] = refundStatus,
						["paymentConfirmed"] = false,
						["refundConfirmed"] = true
					}),
					["capturedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)
				};
				Console.Error.WriteLine("[purchase-browser-1688] exact refund response captured");
				completion.TrySetResult(exactRefund);
				return;
			}
			if (!Alibaba1688OrderNetworkParser.TryParse(text, url, out JsonObject? result) || result == null) return;
			if (!string.IsNullOrWhiteSpace(expectedOrderNumber)
				&& result["orderCandidates"] is JsonArray exactCandidates
				&& !exactCandidates.OfType<JsonObject>().Any(order => string.Equals(
					order["purchaseOrderNumber"]?.GetValue<string>(),
					expectedOrderNumber,
					StringComparison.Ordinal))) return;
			if (!string.IsNullOrWhiteSpace(expectedOrderNumber))
			{
				result["currentOrderNumber"] = expectedOrderNumber;
			}
			int orderCount = result["orderCandidates"] is JsonArray orders ? orders.Count : 0;
			Console.Error.WriteLine($"[purchase-browser-1688] network capture completed orders={orderCount}");
			completion.TrySetResult(result);
		}
		catch (Exception error)
		{
			Console.Error.WriteLine($"[purchase-browser-1688] network response ignored error={error.GetType().Name}");
		}
	}

	public async Task<JsonObject> WaitAsync(TimeSpan timeout)
	{
		try
		{
			return await completion.Task.WaitAsync(timeout).ConfigureAwait(false);
		}
		catch (TimeoutException error)
		{
			string diagnostics;
			lock (diagnosticsLock)
			{
				diagnostics = observedApiEndpoints.Count == 0
					? "none"
					: string.Join(",", observedApiEndpoints.Take(8));
			}
			Console.Error.WriteLine($"[purchase-browser-1688] network timeout observed={diagnostics}");
			throw new InvalidOperationException("PURCHASE_BROWSER_1688_NETWORK_TIMEOUT", error);
		}
	}

	private static string SafeEndpoint(string url)
	{
		return Uri.TryCreate(url, UriKind.Absolute, out Uri? parsed)
			? $"{parsed.Scheme}://{parsed.Host}{parsed.AbsolutePath}"
			: string.Empty;
	}
}

internal static class Alibaba1688OrderNetworkParser
{
	private static readonly IReadOnlyDictionary<string, string> StatusLabels =
		new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
		{
			["all"] = "全部",
			["waitbuyerpay"] = "待付款",
			["waitsellersend"] = "买家已付款，等待卖家发货",
			["waitbuyerreceive"] = "已发货，等待买家收货",
			["success"] = "交易成功",
			["cancel"] = "订单已取消"
		};

	public static bool TryParse(string responseText, string responseUrl, out JsonObject? result)
	{
		result = null;
		JsonNode? outer = ParseJsonOrJsonp(responseText);
		if (outer == null) return false;

		JsonNode? payload = outer;
		string nestedResult = RawString(Path(outer, "data", "data", "result"));
		if (!string.IsNullOrWhiteSpace(nestedResult))
		{
			payload = ParseJsonOrJsonp(nestedResult) ?? outer;
		}

		JsonArray? orders = FindOrderArray(payload, 0) ?? FindOrderArray(outer, 0);
		if (orders == null || orders.Count == 0) return false;

		JsonArray candidates = new();
		HashSet<string> seen = new(StringComparer.Ordinal);
		foreach (JsonNode? node in orders)
		{
			if (node is not JsonObject order) continue;
			JsonObject? candidate = ParseOrder(order);
			string orderNumber = Text(candidate?["purchaseOrderNumber"]);
			if (candidate == null || string.IsNullOrWhiteSpace(orderNumber) || !seen.Add(orderNumber)) continue;
			candidates.Add(candidate);
		}
		if (candidates.Count == 0) return false;

		result = new JsonObject
		{
			["extensionVersion"] = "1.1.0",
			["runtimeKind"] = "builtin-network",
			["sourceMethod"] = "1688-mtop-response",
			["platform"] = "1688",
			["pageType"] = "order-list",
			["pageUrl"] = Alibaba1688OrderNetworkCapture.OrderListUrl,
			["sourceUrl"] = Alibaba1688OrderNetworkCapture.OrderListUrl,
			["responseEndpoint"] = SafeResponseEndpoint(responseUrl),
			["orderCandidates"] = candidates,
			["capturedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)
		};
		return true;
	}

	public static bool TryParseVisibleOrderText(string visibleText, string pageUrl, out JsonObject? result)
	{
		result = null;
		string text = NormalizeVisibleText(visibleText);
		if (text.Length < 80) return false;

		// “支付宝交易号”不是 1688 订单号。可见文本兜底只接受页面明确标注的
		// “订单号/订单编号”，并且一次只允许出现一个订单，避免在列表页误绑。
		string[] orderNumbers = Regex.Matches(
			text,
			@"(?:订单号|订单编号)\s*[:：]?\s*([0-9]{12,30})",
			RegexOptions.CultureInvariant)
			.Select(match => match.Groups[1].Value)
			.Distinct(StringComparer.Ordinal)
			.Take(2)
			.ToArray();
		if (orderNumbers.Length != 1) return false;

		string orderNumber = orderNumbers[0];
		string status = Regex.Match(
			text,
			@"当前订单状态\s*[:：]?\s*(买家已付款\s*[，,]?\s*等待卖家发货|已发货\s*[，,]?\s*等待买家收货|退款成功|已退款|退款完成|退款处理中|申请退款|交易关闭|订单关闭|已关闭|已取消|交易取消|待付款|等待付款|支付成功|买家已付款|已付款|待发货|等待卖家发货|等待商家发货|已发货|待收货|交易成功|已完成)",
			RegexOptions.CultureInvariant).Groups[1].Value;
		if (string.IsNullOrWhiteSpace(status))
		{
			status = Regex.Match(
				text,
				@"买家已付款\s*[，,]?\s*等待卖家发货|已发货\s*[，,]?\s*等待买家收货|退款成功|已退款|退款完成|交易关闭|订单关闭|已取消|待付款|等待付款|支付成功|买家已付款|已付款|待发货|等待卖家发货|等待商家发货|已发货|待收货|交易成功|已完成",
				RegexOptions.CultureInvariant).Value;
		}
		status = Clean(status, 160);
		if (string.IsNullOrWhiteSpace(status)) return false;

		long? quantity = VisibleOrderQuantity(text);
		double? purchasePrice = VisibleOrderPaidAmount(text, quantity);
		string productTitle = Regex.Match(
			text,
			@"货品\s+单价\s*(?:[（(]元[）)])?\s+数量\s+优惠\s*(?:[（(]元[）)])?\s+货品状态\s+(.{4,600}?)\s+产品规格\s*[:：]",
			RegexOptions.CultureInvariant).Groups[1].Value;
		productTitle = Clean(productTitle, 600);

		bool refundConfirmed = Contains(status, "退款成功", "已退款", "退款完成")
			&& !Contains(status, "退款处理中", "申请退款");
		bool closed = Contains(status, "交易关闭", "订单关闭", "已关闭", "已取消", "交易取消");
		bool paymentConfirmed = !refundConfirmed && !closed && Contains(
			status,
			"支付成功", "买家已付款", "已付款", "待发货", "等待卖家发货", "等待商家发货",
			"已发货", "待收货", "交易成功", "已完成");
		string orderUrl = $"https://trade.1688.com/order/new_step_order_detail.htm?orderId={Uri.EscapeDataString(orderNumber)}";
		string normalizedPageUrl = Uri.TryCreate(pageUrl, UriKind.Absolute, out Uri? parsedPage)
			&& parsedPage.Host.EndsWith("1688.com", StringComparison.OrdinalIgnoreCase)
			? parsedPage.ToString()
			: orderUrl;

		JsonObject candidate = new()
		{
			["platform"] = "1688",
			["pageType"] = "order-detail",
			["pageUrl"] = normalizedPageUrl,
			["purchaseOrderUrl"] = orderUrl,
			["sourceUrl"] = string.Empty,
			["productTitle"] = productTitle,
			["productTitles"] = string.IsNullOrWhiteSpace(productTitle)
				? new JsonArray()
				: new JsonArray(productTitle),
			["quantity"] = quantity.HasValue ? JsonValue.Create(quantity.Value) : null,
			["purchaseOrderNumber"] = orderNumber,
			["orderNumber"] = orderNumber,
			["purchasePrice"] = purchasePrice.HasValue ? JsonValue.Create(purchasePrice.Value) : null,
			["amount"] = purchasePrice?.ToString("0.##", CultureInfo.InvariantCulture) ?? string.Empty,
			["currency"] = "CNY",
			["purchaseOrderStatus"] = status,
			["orderStatus"] = status,
			["statusText"] = status,
			["status"] = status,
			["paymentConfirmed"] = paymentConfirmed,
			["refundConfirmed"] = refundConfirmed,
			["fieldConfidence"] = new JsonObject
			{
				["platform"] = 1,
				["productTitle"] = string.IsNullOrWhiteSpace(productTitle) ? 0 : 0.9,
				["quantity"] = quantity.HasValue ? 0.9 : 0,
				["purchaseOrderNumber"] = 1,
				["purchasePrice"] = purchasePrice.HasValue ? 0.96 : 0
			}
		};
		result = new JsonObject
		{
			["extensionVersion"] = "1.2.0",
			["runtimeKind"] = "builtin-frame-text",
			["sourceMethod"] = "1688-visible-frame-text",
			["platform"] = "1688",
			["pageType"] = "order-detail",
			["pageUrl"] = normalizedPageUrl,
			["currentOrderNumber"] = orderNumber,
			["pageOrderStatus"] = status,
			["orderCandidates"] = new JsonArray(candidate),
			["capturedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)
		};
		return true;
	}

	public static bool TryFindExplicitRefundStatus(string responseText, out string status)
	{
		status = string.Empty;
		JsonNode? outer = ParseJsonOrJsonp(responseText);
		if (outer == null) return false;
		status = FindRefundSuccessStatus(outer, 0);
		if (!string.IsNullOrWhiteSpace(status)) return true;
		string nestedResult = RawString(Path(outer, "data", "data", "result"));
		if (string.IsNullOrWhiteSpace(nestedResult)) return false;
		status = FindRefundSuccessStatus(ParseJsonOrJsonp(nestedResult), 0);
		return !string.IsNullOrWhiteSpace(status);
	}

	private static JsonObject? ParseOrder(JsonObject order)
	{
		string orderNumber = FirstText(order, "idStr", "id", "orderId", "orderIdStr");
		if (string.IsNullOrWhiteSpace(orderNumber)) return null;

		JsonArray entries = Array(order["orderEntries"])
			?? Array(order["entries"])
			?? Array(order["items"])
			?? new JsonArray();
		JsonObject? firstStep = (Array(order["newStepOrders"])
			?? Array(order["stepOrders"])
			?? new JsonArray()).FirstOrDefault() as JsonObject;

		string statusCode = FirstText(firstStep, "stepStatus", "status");
		if (string.IsNullOrWhiteSpace(statusCode))
		{
			statusCode = FirstText(order, "status", "tradeStatus");
		}
		string status = FirstText(order, "statusLabel", "statusText", "tradeStatusLabel");
		if (string.IsNullOrWhiteSpace(status))
		{
			status = FirstText(firstStep, "stepName", "statusName");
		}
		if (string.IsNullOrWhiteSpace(status) && !string.IsNullOrWhiteSpace(statusCode))
		{
			status = StatusLabels.TryGetValue(statusCode, out string? label) ? label : statusCode;
		}
		// The 1688 detail response may expose the trade-level status as
		// “交易关闭” while the exact order entry contains “退款成功”. Only the
		// explicit success evidence is allowed to drive the destructive rollback.
		// A bare close/cancel must remain non-refund and fail closed.
		string refundStatus = FindRefundSuccessStatus(order, 0);
		if (!string.IsNullOrWhiteSpace(refundStatus)) status = refundStatus;

		JsonArray titles = new();
		HashSet<string> seenTitles = new(StringComparer.Ordinal);
		long quantityTotal = 0;
		string sourceUrl = string.Empty;
		string sourceProductId = string.Empty;
		foreach (JsonNode? entryNode in entries)
		{
			if (entryNode is not JsonObject entry) continue;
			string title = FirstText(entry, "productName", "subject", "title", "offerName");
			if (!string.IsNullOrWhiteSpace(title) && seenTitles.Add(title)) titles.Add(title);
			long quantity = Integer(Path(entry, "quantity", "realAmount"))
				?? Integer(Path(entry, "quantity", "realAmountStr"))
				?? Integer(entry["quantity"])
				?? Integer(entry["amount"])
				?? 0;
			if (quantity > 0) quantityTotal += quantity;
			sourceUrl = string.IsNullOrWhiteSpace(sourceUrl) ? Find1688OfferUrl(entry, 0) : sourceUrl;
			sourceProductId = string.IsNullOrWhiteSpace(sourceProductId)
				? FirstText(entry, "sourceId", "offerId", "offerID", "productId", "productNumber")
				: sourceProductId;
		}
		if (string.IsNullOrWhiteSpace(sourceProductId) && !string.IsNullOrWhiteSpace(sourceUrl))
		{
			sourceProductId = OfferId(sourceUrl);
		}
		if (string.IsNullOrWhiteSpace(sourceUrl)
			&& sourceProductId.All(char.IsDigit)
			&& sourceProductId.Length >= 5)
		{
			sourceUrl = $"https://detail.1688.com/offer/{sourceProductId}.html";
		}

		double? purchasePrice = Cents(FirstNode(order,
			"sumPayment", "actualAmount", "payAmount", "paidAmount", "totalAmount", "orderAmount"));
		if (purchasePrice is null && firstStep != null)
		{
			purchasePrice = Cents(FirstNode(firstStep, "payFee", "goodsFee"));
		}
		if (purchasePrice is null || purchasePrice <= 0) return null;

		bool refundConfirmed = !string.IsNullOrWhiteSpace(refundStatus);
		bool closed = Contains(status, "交易关闭", "订单关闭", "已关闭", "已取消", "交易取消")
			|| string.Equals(statusCode, "cancel", StringComparison.OrdinalIgnoreCase);
		bool paid = !refundConfirmed && !closed && (Contains(status,
			"支付成功", "买家已付款", "已付款", "待发货", "等待卖家发货", "等待商家发货", "已发货", "待收货", "交易成功", "已完成")
			|| new[] { "waitsellersend", "waitbuyerreceive", "success" }.Contains(statusCode, StringComparer.OrdinalIgnoreCase));
		string orderUrl = FirstText(order, "orderUrl", "detailUrl", "orderDetailUrl", "buyerOrderUrl");
		if (string.IsNullOrWhiteSpace(orderUrl))
		{
			orderUrl = $"https://trade.1688.com/order/new_step_order_detail.htm?orderId={Uri.EscapeDataString(orderNumber)}";
		}

		return new JsonObject
		{
			["platform"] = "1688",
			["pageType"] = "order-detail",
			["pageUrl"] = orderUrl,
			["purchaseOrderUrl"] = orderUrl,
			["sourceUrl"] = sourceUrl,
			["sourceProductId"] = sourceProductId,
			["productTitle"] = titles.FirstOrDefault()?.GetValue<string>() ?? string.Empty,
			["productTitles"] = titles,
			["quantity"] = quantityTotal > 0 ? JsonValue.Create(quantityTotal) : null,
			["purchaseOrderNumber"] = orderNumber,
			["orderNumber"] = orderNumber,
			["purchasePrice"] = purchasePrice.Value,
			["amount"] = purchasePrice.Value.ToString("0.##", CultureInfo.InvariantCulture),
			["currency"] = "CNY",
			["purchaseOrderStatus"] = status,
			["orderStatus"] = status,
			["statusText"] = status,
			["status"] = status,
			["paymentConfirmed"] = paid,
			["refundConfirmed"] = refundConfirmed,
			["fieldConfidence"] = new JsonObject
			{
				["platform"] = 1,
				["productTitle"] = titles.Count > 0 ? 0.98 : 0,
				["quantity"] = quantityTotal > 0 ? 0.98 : 0,
				["purchaseOrderNumber"] = 1,
				["purchasePrice"] = 1
			}
		};
	}

	private static long? VisibleOrderQuantity(string text)
	{
		Match match = Regex.Match(
			text,
			@"\d+(?:\.\d{1,2})?\s*元\s*/\s*[^\s]+\s+(\d{1,6})(?:\s|$)",
			RegexOptions.CultureInvariant);
		if (!match.Success)
		{
			match = Regex.Match(
				text,
				@"(?:数量|购买数量)\s*[:：xX×]?\s*(\d{1,6})",
				RegexOptions.CultureInvariant);
		}
		return long.TryParse(match.Groups[1].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out long value)
			&& value > 0
			? value
			: null;
	}

	private static double? VisibleOrderPaidAmount(string text, long? quantity)
	{
		Match paid = Regex.Match(
			text,
			@"(?:订单实付|实付款(?:\s*[（(]含运费[）)])?|实际付款|实付金额|付款金额|支付金额|应付金额|应付总额|订单总计(?:\s*[（(]含运费[）)])?)[^0-9¥￥]{0,100}[¥￥]?\s*(\d+(?:\.\d{1,2})?)",
			RegexOptions.CultureInvariant);
		if (TryPositiveMoney(paid.Groups[1].Value, out double exact)) return exact;

		Match unit = Regex.Match(
			text,
			@"(?:单价(?:\s*[（(]元[）)])?|货品单价|商品单价)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)|[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*元\s*/\s*[^\s]+",
			RegexOptions.CultureInvariant);
		string unitValue = unit.Groups[1].Success ? unit.Groups[1].Value : unit.Groups[2].Value;
		if (!quantity.HasValue || !TryPositiveMoney(unitValue, out double unitPrice)) return null;

		Match freight = Regex.Match(
			text,
			@"(?:运费|物流费|配送费)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)",
			RegexOptions.CultureInvariant);
		double shipping = 0;
		if (freight.Success)
		{
			if (!double.TryParse(freight.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out shipping)
				|| !double.IsFinite(shipping)
				|| shipping < 0) return null;
		}
		else if (!Regex.IsMatch(text, @"免运费|包邮", RegexOptions.CultureInvariant))
		{
			return null;
		}
		return Math.Round(unitPrice * quantity.Value + shipping, 2, MidpointRounding.AwayFromZero);
	}

	private static bool TryPositiveMoney(string value, out double money)
	{
		return double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out money)
			&& double.IsFinite(money)
			&& money > 0;
	}

	private static string NormalizeVisibleText(string? value)
	{
		string text = string.Join(" ", (value ?? string.Empty)
			.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
		return text.Length <= 200_000 ? text : text[..200_000];
	}

	private static JsonNode? ParseJsonOrJsonp(string? text)
	{
		string value = (text ?? string.Empty).Trim().TrimStart('\uFEFF');
		if (string.IsNullOrWhiteSpace(value)) return null;
		if (value[0] != '{' && value[0] != '[')
		{
			int start = value.IndexOf('(');
			int end = value.LastIndexOf(')');
			if (start >= 0 && end > start) value = value[(start + 1)..end].Trim();
		}
		try { return JsonNode.Parse(value); }
		catch { return null; }
	}

	private static JsonArray? FindOrderArray(JsonNode? node, int depth)
	{
		if (node == null || depth > 8) return null;
		if (node is JsonArray array)
		{
			bool looksLikeOrders = array.Any(item => item is JsonObject row
				&& !string.IsNullOrWhiteSpace(FirstText(row, "idStr", "id", "orderId"))
				&& (row["orderEntries"] is JsonArray || row["newStepOrders"] is JsonArray));
			if (looksLikeOrders) return array;
			foreach (JsonNode? item in array)
			{
				JsonArray? nested = FindOrderArray(item, depth + 1);
				if (nested != null) return nested;
			}
		}
		else if (node is JsonObject obj)
		{
			foreach (KeyValuePair<string, JsonNode?> pair in obj)
			{
				JsonArray? nested = FindOrderArray(pair.Value, depth + 1);
				if (nested != null) return nested;
			}
		}
		return null;
	}

	private static string Find1688OfferUrl(JsonNode? node, int depth)
	{
		if (node == null || depth > 5) return string.Empty;
		if (node is JsonValue)
		{
			string value = Text(node);
			return value.Contains("1688.com", StringComparison.OrdinalIgnoreCase)
				&& (value.Contains("/offer/", StringComparison.OrdinalIgnoreCase)
					|| value.Contains("offerId=", StringComparison.OrdinalIgnoreCase))
				? value
				: string.Empty;
		}
		if (node is JsonArray array)
		{
			foreach (JsonNode? item in array)
			{
				string found = Find1688OfferUrl(item, depth + 1);
				if (!string.IsNullOrWhiteSpace(found)) return found;
			}
		}
		else if (node is JsonObject obj)
		{
			foreach (KeyValuePair<string, JsonNode?> pair in obj)
			{
				string found = Find1688OfferUrl(pair.Value, depth + 1);
				if (!string.IsNullOrWhiteSpace(found)) return found;
			}
		}
		return string.Empty;
	}

	private static string FindRefundSuccessStatus(JsonNode? node, int depth)
	{
		if (node == null || depth > 8) return string.Empty;
		if (node is JsonValue)
		{
			string value = Text(node);
			foreach (string marker in new[] { "极速退款成功", "退款成功", "已退款", "退款完成" })
			{
				if (value.Contains(marker, StringComparison.OrdinalIgnoreCase)) return marker;
			}
			return string.Empty;
		}
		if (node is JsonArray array)
		{
			foreach (JsonNode? item in array)
			{
				string found = FindRefundSuccessStatus(item, depth + 1);
				if (!string.IsNullOrWhiteSpace(found)) return found;
			}
		}
		else if (node is JsonObject obj)
		{
			foreach (KeyValuePair<string, JsonNode?> pair in obj)
			{
				string found = FindRefundSuccessStatus(pair.Value, depth + 1);
				if (!string.IsNullOrWhiteSpace(found)) return found;
			}
		}
		return string.Empty;
	}

	private static string OfferId(string url)
	{
		System.Text.RegularExpressions.Match match = System.Text.RegularExpressions.Regex.Match(
			url,
			@"(?:/offer/|[?&]offer(?:_|)id=)(\d{5,})",
			System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
		return match.Success ? match.Groups[1].Value : string.Empty;
	}

	private static JsonNode? Path(JsonNode? node, params string[] names)
	{
		JsonNode? current = node;
		foreach (string name in names)
		{
			current = current is JsonObject obj ? obj[name] : null;
			if (current == null) return null;
		}
		return current;
	}

	private static JsonArray? Array(JsonNode? node) => node as JsonArray;

	private static JsonNode? FirstNode(JsonObject? obj, params string[] names)
	{
		if (obj == null) return null;
		foreach (string name in names)
		{
			JsonNode? value = obj[name];
			if (value != null && !string.IsNullOrWhiteSpace(Text(value))) return value;
		}
		return null;
	}

	private static string FirstText(JsonObject? obj, params string[] names)
	{
		return Text(FirstNode(obj, names));
	}

	private static string Text(JsonNode? node)
	{
		if (node == null) return string.Empty;
		if (node is JsonValue value)
		{
			if (value.TryGetValue<string>(out string? text)) return Clean(text);
			if (value.TryGetValue<long>(out long integer)) return integer.ToString(CultureInfo.InvariantCulture);
			if (value.TryGetValue<double>(out double number)) return number.ToString(CultureInfo.InvariantCulture);
		}
		return Clean(node.ToJsonString());
	}

	private static string RawString(JsonNode? node)
	{
		return node is JsonValue value && value.TryGetValue<string>(out string? text)
			? text ?? string.Empty
			: string.Empty;
	}

	private static string Clean(string? value, int maximum = 1800)
	{
		string text = string.Join(" ", (value ?? string.Empty)
			.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
		return text.Length <= maximum ? text : text[..maximum];
	}

	private static long? Integer(JsonNode? node)
	{
		string text = Text(node).Replace(",", string.Empty, StringComparison.Ordinal);
		return long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out long value) ? value : null;
	}

	private static double? Cents(JsonNode? node)
	{
		string text = Text(node).Replace(",", string.Empty, StringComparison.Ordinal);
		if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out double value) || !double.IsFinite(value)) return null;
		return Math.Round(value / 100d, 2, MidpointRounding.AwayFromZero);
	}

	private static bool Contains(string value, params string[] markers)
	{
		return markers.Any(marker => value.Contains(marker, StringComparison.OrdinalIgnoreCase));
	}

	private static string SafeResponseEndpoint(string url)
	{
		return Uri.TryCreate(url, UriKind.Absolute, out Uri? parsed)
			? $"{parsed.Scheme}://{parsed.Host}{parsed.AbsolutePath}"
			: string.Empty;
	}
}
