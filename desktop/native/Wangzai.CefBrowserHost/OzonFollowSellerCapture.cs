using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Wangzai.CefBrowserHost;

internal static partial class OzonFollowSellerCapture
{
	// 单次 IPC 只承载一个浏览器批次；全店数量由前端持续分批调度，
	// 这里不是全店总量上限。
	private const int MaximumSkuCount = 100;
	private const int MaximumConcurrency = 8;
	private const int StreamingChunkSize = 12;
	private const int MaximumSellerDetails = 50;
	private const int MaximumResponseChars = 8 * 1024 * 1024;

	public static async Task<object> ExecuteAsync(
		JsonObject payload,
		Func<IReadOnlyCollection<string>, int, bool, Task<string>> browserCapture,
		Action<string, JsonObject>? onResult = null)
	{
		string[] skus = ReadSkus(payload);
		int concurrency = Math.Clamp(Integer(payload, "concurrency", 6), 1, MaximumConcurrency);
		bool includeProductFacts = Boolean(payload, "includeProductFacts");
		string captureToken = Text(payload["captureToken"], 120);
		if (skus.Length == 0)
		{
			return Result(skus, Array.Empty<JsonObject>());
		}

		Dictionary<string, JsonObject> results = new(StringComparer.Ordinal);
		for (int offset = 0; offset < skus.Length; offset += StreamingChunkSize)
		{
			string[] chunk = skus.Skip(offset).Take(StreamingChunkSize).ToArray();
			try
			{
				string browserPayload = await browserCapture(chunk, concurrency, includeProductFacts).ConfigureAwait(false);
				Dictionary<string, JsonObject> chunkResults = ReadBrowserResults(browserPayload)
					.Select(NormalizeBrowserResult)
					.Where(result => result is not null)
					.ToDictionary(
						result => Text(result!["sku"], 32),
						result => result!,
						StringComparer.Ordinal);
				foreach (string sku in chunk)
				{
					JsonObject result = chunkResults.TryGetValue(sku, out JsonObject? captured)
						? captured
						: Failure(sku, "OZON_FOLLOW_SELLERS_RESULT_MISSING", string.Empty);
					results[sku] = result;
					onResult?.Invoke(captureToken, result);
				}
				JsonObject? blocking = chunk
					.Select(sku => results[sku])
					.FirstOrDefault(IsBlockingNetworkFailure);
				if (blocking is null) continue;
				int status = Integer(blocking, "status", 0);
				string code = Text(blocking["errorCode"], 120);
				string detail = Text(blocking["detail"], 300);
				foreach (string remainingSku in skus.Skip(offset + chunk.Length))
				{
					results[remainingSku] = Failure(
						remainingSku,
						code.Length > 0 ? code : "OZON_FOLLOW_SELLERS_BROWSER_REQUEST_FAILED",
						detail,
						status);
				}
				break;
			}
			catch (Exception error)
			{
				foreach (string remainingSku in skus.Skip(offset))
				{
					JsonObject failure = Failure(
						remainingSku,
						"OZON_FOLLOW_SELLERS_BROWSER_REQUEST_FAILED",
						error.Message);
					results[remainingSku] = failure;
					onResult?.Invoke(captureToken, failure);
				}
				break;
			}
		}

		return Result(
			skus,
			skus.Select(sku => results.TryGetValue(sku, out JsonObject? result)
				? result
				: Failure(sku, "OZON_FOLLOW_SELLERS_RESULT_MISSING", string.Empty)).ToArray());
	}

	private static JsonObject? NormalizeBrowserResult(JsonObject browserResult)
	{
		string sku = Text(browserResult["sku"], 32);
		if (!SkuPattern().IsMatch(sku)) return null;
		bool legacyConfirmed = Boolean(browserResult, "confirmed");
		bool followSellerConfirmed = Boolean(
			browserResult,
			"followSellerConfirmed",
			legacyConfirmed && browserResult["followSellerCount"] is not null);
		bool productFactsConfirmed = Boolean(
			browserResult,
			"productFactsConfirmed",
			legacyConfirmed && HasAnyProductFact(browserResult));
		int status = Integer(browserResult, "status", 0);
		string detail = Text(browserResult["detail"], 300);
		bool challengeDetected = Boolean(browserResult, "challengeDetected")
			|| detail.Contains("OZON_RR_CHALLENGE", StringComparison.OrdinalIgnoreCase);
		if (!followSellerConfirmed && !productFactsConfirmed)
		{
			return Failure(
				sku,
				challengeDetected
					? "OZON_RR_CHALLENGE"
					: status > 0
						? $"OZON_PRODUCT_FACTS_HTTP_{status}"
						: "OZON_PRODUCT_FACTS_BROWSER_REQUEST_FAILED",
				detail,
				status);
		}
		return CompactBrowserResult(
			sku,
			status,
			followSellerConfirmed,
			productFactsConfirmed,
			browserResult);
	}

	private static bool IsBlockingNetworkFailure(JsonObject result)
	{
		if (Boolean(result, "confirmed") || Boolean(result, "followSellerConfirmed")) return false;
		int status = Integer(result, "status", 0);
		string code = Text(result["errorCode"], 120).ToUpperInvariant();
		return status is 403 or 408 or 425 or 429
			|| status >= 500
			|| code.Contains("OZON_RR_CHALLENGE", StringComparison.Ordinal)
			|| code.Contains("BROWSER_REQUEST_FAILED", StringComparison.Ordinal)
			|| code.Contains("TIMEOUT", StringComparison.Ordinal);
	}

	private static JsonObject CompactBrowserResult(
		string sku,
		int status,
		bool followSellerConfirmed,
		bool productFactsConfirmed,
		JsonObject source)
	{
		JsonArray compactSellers = new();
		if (followSellerConfirmed && source["followSellers"] is JsonArray sellers)
		{
			foreach (JsonObject seller in sellers.OfType<JsonObject>().Take(MaximumSellerDetails))
			{
				string sellerSku = Text(seller["sku"], 20);
				string sellerLink = OzonLink(seller["link"], allowRelative: true);
				string productLink = OzonLink(seller["productLink"], allowRelative: false);
				string coverImage = OzonImageLink(seller["coverImage"]);
				JsonArray credentials = new();
				if (seller["credentials"] is JsonArray sellerCredentials)
				{
					foreach (JsonNode? credential in sellerCredentials.Take(8))
					{
						string value = Text(credential, 240);
						if (value.Length > 0) credentials.Add(value);
					}
				}
				compactSellers.Add(new JsonObject
				{
					["sku"] = SkuPattern().IsMatch(sellerSku) ? sellerSku : string.Empty,
					["id"] = Text(seller["id"], 100),
					["name"] = Text(seller["name"], 240),
					["link"] = sellerLink,
					["productLink"] = productLink,
					["credentials"] = credentials,
					["coverImage"] = coverImage,
					["price"] = Money(seller["price"]) is decimal price ? (double)price : null
				});
			}
		}
		decimal? minimum = Money(source["followMinPrice"]);
		decimal? maximum = Money(source["followMaxPrice"]);
		JsonObject result = new()
		{
			["sku"] = sku,
			["confirmed"] = true,
			["status"] = status,
			["followSellerConfirmed"] = followSellerConfirmed,
			["followSellerStatus"] = Integer(source, "followSellerStatus", followSellerConfirmed ? 200 : 0),
			["productFactsConfirmed"] = productFactsConfirmed,
			["productFactsStatus"] = Integer(source, "productFactsStatus", productFactsConfirmed ? 200 : 0),
			["challengeDetected"] = Boolean(source, "challengeDetected"),
			["detail"] = Text(source["detail"], 300),
			["source"] = "ozon-public-product-page",
			["capturedAt"] = Text(source["capturedAt"], 80),
			["sourceProductUrl"] = OzonLink(source["sourceProductUrl"], allowRelative: false),
			["offersRoute"] = OzonLink(source["offersRoute"], allowRelative: true)
		};
		if (followSellerConfirmed)
		{
			result["followSellerCount"] = Math.Max(0, Integer(source, "followSellerCount", 0));
			result["followMinPrice"] = minimum.HasValue ? (double)minimum.Value : null;
			result["followMaxPrice"] = maximum.HasValue ? (double)maximum.Value : null;
			result["followSellers"] = compactSellers;
			result["followSellerSource"] = "ozon-public-other-offers";
		}
		if (productFactsConfirmed)
		{
			decimal? cardPrice = Money(source["cardPrice"]);
			decimal? rating = Decimal(source["rating"]);
			int? reviews = NonNegativeInteger(source["reviews"]);
			int? orders = NonNegativeInteger(source["orders"]);
			result["cardPrice"] = cardPrice is > 0 ? (double)cardPrice.Value : null;
			result["cardPriceCurrency"] = cardPrice is > 0
				? Currency(source["cardPriceCurrency"])
				: string.Empty;
			result["rating"] = rating is >= 0 and <= 5 ? (double)rating.Value : null;
			result["reviews"] = reviews;
			result["orders"] = orders;
			result["productFactsSource"] = Text(source["productFactsSource"], 120) switch
			{
				"ozon-public-product-page-json" => "ozon-public-product-page-json",
				"ozon-public-product-page-html" => "ozon-public-product-page-html",
				_ => "ozon-public-product-page"
			};
		}
		return result;
	}

	private static bool HasAnyProductFact(JsonObject source)
	{
		return source["cardPrice"] is not null
			|| source["rating"] is not null
			|| source["reviews"] is not null
			|| source["orders"] is not null;
	}

	private static IEnumerable<JsonObject> ReadBrowserResults(string source)
	{
		if (source.Length == 0 || source.Length > MaximumResponseChars) return [];
		try
		{
			return (JsonNode.Parse(source) as JsonArray ?? [])
				.OfType<JsonObject>()
				.ToArray();
		}
		catch
		{
			return [];
		}
	}

	private static decimal? Money(JsonNode? value)
	{
		string source = Text(value, 120);
		if (source.Length == 0) return null;
		string numeric = MoneyCharacters().Replace(source, string.Empty).Replace(',', '.');
		int lastSeparator = numeric.LastIndexOf('.');
		if (lastSeparator >= 0)
		{
			string before = numeric[..lastSeparator].Replace(".", string.Empty, StringComparison.Ordinal);
			string after = numeric[(lastSeparator + 1)..];
			numeric = after.Length is 1 or 2 ? before + "." + after : before + after;
		}
		return decimal.TryParse(
			numeric,
			NumberStyles.AllowDecimalPoint | NumberStyles.AllowLeadingSign,
			CultureInfo.InvariantCulture,
			out decimal parsed)
			? decimal.Round(parsed, 2)
			: null;
	}

	private static decimal? Decimal(JsonNode? value)
	{
		if (value is JsonValue scalar)
		{
			if (scalar.TryGetValue(out decimal decimalValue)) return decimalValue;
			if (scalar.TryGetValue(out double doubleValue) && double.IsFinite(doubleValue))
				return (decimal)doubleValue;
			if (scalar.TryGetValue(out long integerValue)) return integerValue;
		}
		string source = Text(value, 120).Replace(',', '.');
		return decimal.TryParse(
			source,
			NumberStyles.AllowDecimalPoint | NumberStyles.AllowLeadingSign,
			CultureInfo.InvariantCulture,
			out decimal parsed)
			? parsed
			: null;
	}

	private static int? NonNegativeInteger(JsonNode? value)
	{
		decimal? parsed = Decimal(value);
		if (!parsed.HasValue || parsed.Value < 0 || parsed.Value > int.MaxValue) return null;
		return decimal.Truncate(parsed.Value) == parsed.Value ? (int)parsed.Value : null;
	}

	private static string Currency(JsonNode? value)
	{
		string currency = Text(value, 12).ToUpperInvariant();
		return currency is "RUB" or "CNY" or "USD" or "KZT" or "AMD" or "BYN" or "EUR"
			? currency
			: string.Empty;
	}

	private static string OzonLink(JsonNode? value, bool allowRelative)
	{
		string link = Text(value, 1200);
		if (allowRelative && (link.StartsWith("/seller/", StringComparison.Ordinal)
			|| link.StartsWith("/modal/otherOffersFromSellers", StringComparison.Ordinal))) return link;
		if (!Uri.TryCreate(link, UriKind.Absolute, out Uri? uri) || uri.Scheme != Uri.UriSchemeHttps)
			return string.Empty;
		string host = uri.Host.ToLowerInvariant();
		return host == "ozon.ru" || host.EndsWith(".ozon.ru", StringComparison.Ordinal)
			? uri.ToString()
			: string.Empty;
	}

	private static string OzonImageLink(JsonNode? value)
	{
		string link = Text(value, 1200);
		if (!Uri.TryCreate(link, UriKind.Absolute, out Uri? uri) || uri.Scheme != Uri.UriSchemeHttps)
			return string.Empty;
		string host = uri.Host.ToLowerInvariant();
		return host == "ozon.ru"
			|| host.EndsWith(".ozon.ru", StringComparison.Ordinal)
			|| host == "ozone.ru"
			|| host.EndsWith(".ozone.ru", StringComparison.Ordinal)
			? uri.ToString()
			: string.Empty;
	}

	private static string[] ReadSkus(JsonObject payload)
	{
		if (payload["skus"] is not JsonArray values) return [];
		return values
			.Select(value => Text(value, 32))
			.Where(value => SkuPattern().IsMatch(value))
			.Distinct(StringComparer.Ordinal)
			.Take(MaximumSkuCount)
			.ToArray();
	}

	private static object Result(IReadOnlyCollection<string> requestedSkus, IReadOnlyCollection<JsonObject> results)
	{
		int confirmed = results.Count(result => result["confirmed"]?.GetValue<bool>() == true);
		int followSellerConfirmed = results.Count(result => Boolean(result, "followSellerConfirmed"));
		int productFactsConfirmed = results.Count(result => Boolean(result, "productFactsConfirmed"));
		return new
		{
			ready = true,
			source = "ozon-public-product-page",
			requested = requestedSkus.Count,
			confirmed,
			followSellerConfirmed,
			productFactsConfirmed,
			failed = Math.Max(0, requestedSkus.Count - confirmed),
			results
		};
	}

	private static JsonObject Failure(string sku, string code, string detail, int status = 0)
	{
		return new JsonObject
		{
			["sku"] = sku,
			["confirmed"] = false,
			["followSellerConfirmed"] = false,
			["productFactsConfirmed"] = false,
			["status"] = status,
			["errorCode"] = code,
			["detail"] = Text(detail, 300),
			["source"] = "ozon-public-product-page"
		};
	}

	private static bool Boolean(JsonObject source, string name, bool fallback = false)
	{
		try { return source[name]?.GetValue<bool>() ?? fallback; }
		catch { return fallback; }
	}

	private static int Integer(JsonObject source, string name, int fallback)
	{
		try { return source[name]?.GetValue<int>() ?? fallback; }
		catch { return fallback; }
	}

	private static string Text(JsonNode? value, int maximum)
	{
		try
		{
			string text = value is JsonValue scalar && scalar.TryGetValue(out string? stringValue)
				? stringValue.Trim()
				: value?.ToString().Trim() ?? string.Empty;
			return text.Length <= maximum ? text : text[..maximum];
		}
		catch { return string.Empty; }
	}

	[GeneratedRegex(@"[^\d,.\-]+", RegexOptions.CultureInvariant)]
	private static partial Regex MoneyCharacters();

	[GeneratedRegex(@"^\d{5,20}$", RegexOptions.CultureInvariant)]
	private static partial Regex SkuPattern();
}
