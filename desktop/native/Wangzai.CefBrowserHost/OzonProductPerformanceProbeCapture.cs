using System.Text;
using System.Text.Json.Nodes;
using CefSharp;

namespace Wangzai.CefBrowserHost;

internal static class OzonProductPerformanceProbeCapture
{
	private const string ProductPerformancePath = "/api/site/seller-analytics/what_to_sell/data/v3";
	private const int MaximumResponseChars = 12 * 1024 * 1024;
	private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(25);
	private static readonly HashSet<string> AllowedOrigins = new(StringComparer.OrdinalIgnoreCase)
	{
		"https://api.seller.ozon.ru",
		"https://seller.ozon.ru"
	};
	private static readonly HashSet<string> AllowedHeaders = new(StringComparer.OrdinalIgnoreCase)
	{
		"accept",
		"content-type",
		"x-o3-app-name",
		"x-o3-company-id",
		"x-o3-language",
		"x-o3-page-type"
	};

	public static bool Supports(JsonObject payload)
	{
		return Text(payload["path"], 500).Equals(ProductPerformancePath, StringComparison.Ordinal)
			&& Text(payload["method"], 10).Equals("POST", StringComparison.OrdinalIgnoreCase)
			&& AllowedOrigins.Contains(Text(payload["origin"], 200));
	}

	public static async Task<object> ExecuteAsync(
		BrowserProfile profile,
		RequestContext requestContext,
		JsonObject payload,
		Func<Task<JsonObject>> prepareProbe,
		Func<int, string, Task<object>> commitProbe)
	{
		JsonObject prepared = await prepareProbe().ConfigureAwait(false);
		JsonObject recipe = prepared["recipe"] as JsonObject
			?? throw new InvalidOperationException("OZON_DATA_NATIVE_PROBE_RECIPE_MISSING");
		string url = Text(recipe["absoluteUrl"], 800);
		string method = Text(recipe["method"], 10).ToUpperInvariant();
		string body = Text(recipe["body"]?["text"], MaximumResponseChars);
		if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri)
			|| uri.Scheme != Uri.UriSchemeHttps
			|| !AllowedOrigins.Contains(uri.GetLeftPart(UriPartial.Authority))
			|| uri.AbsolutePath != ProductPerformancePath
			|| method != "POST"
			|| body.Length == 0)
		{
			throw new InvalidOperationException("OZON_DATA_NATIVE_PROBE_RECIPE_INVALID");
		}

		Dictionary<string, string> headers = ReadHeaders(recipe["headers"] as JsonObject);
		CefResponse response = await SendWithChromiumAsync(
			requestContext,
			profile,
			url,
			method,
			headers,
			body).ConfigureAwait(false);
		if (response.RequestStatus != UrlRequestStatus.Success)
		{
			throw new InvalidOperationException("OZON_DATA_NATIVE_PROBE_NETWORK_FAILED");
		}
		if (response.Body.Length == 0 || response.Body.Length > MaximumResponseChars)
		{
			throw new InvalidOperationException("OZON_DATA_NATIVE_PROBE_PAYLOAD_INVALID");
		}
		try
		{
			_ = JsonNode.Parse(response.Body)
				?? throw new InvalidOperationException("OZON_DATA_NATIVE_PROBE_PAYLOAD_INVALID");
		}
		catch (Exception error) when (error is not InvalidOperationException)
		{
			throw new InvalidOperationException("OZON_DATA_NATIVE_PROBE_PAYLOAD_INVALID", error);
		}

		return await commitProbe(response.Status, response.Body).ConfigureAwait(false);
	}

	private static Dictionary<string, string> ReadHeaders(JsonObject? source)
	{
		Dictionary<string, string> headers = new(StringComparer.OrdinalIgnoreCase);
		if (source == null) return headers;
		foreach ((string key, JsonNode? value) in source)
		{
			if (!AllowedHeaders.Contains(key)) continue;
			string normalized = Text(value, 500);
			if (normalized.Length > 0) headers[key] = normalized;
		}
		return headers;
	}

	private static async Task<CefResponse> SendWithChromiumAsync(
		RequestContext requestContext,
		BrowserProfile profile,
		string url,
		string method,
		IReadOnlyDictionary<string, string> headers,
		string body)
	{
		ChromiumUrlRequestClient client = new(MaximumResponseChars);
		await Cef.UIThreadTaskFactory.StartNew(() =>
		{
			Request request = new()
			{
				Url = url,
				Method = method,
				Flags = UrlRequestFlags.AllowStoredCredentials | UrlRequestFlags.NoRetryOn5XX
			};
			request.SetReferrer(
				"https://seller.ozon.ru/app/analytics/what-to-sell/ozon-bestsellers",
				ReferrerPolicy.ReduceReferrerGranularityOnTransitionCrossOrigin);
			foreach ((string name, string value) in headers)
				request.SetHeaderByName(name, value, overwrite: true);
			request.SetHeaderByName("Accept", "application/json, text/plain, */*", overwrite: true);
			request.SetHeaderByName("Accept-Language", profile.AcceptLanguage, overwrite: true);
			request.SetHeaderByName("Content-Type", "application/json", overwrite: true);
			request.SetHeaderByName("Origin", "https://seller.ozon.ru", overwrite: true);
			request.SetHeaderByName("User-Agent", profile.UserAgent, overwrite: true);
			request.SetHeaderByName("Sec-Fetch-Dest", "empty", overwrite: true);
			request.SetHeaderByName("Sec-Fetch-Mode", "cors", overwrite: true);
			request.SetHeaderByName("Sec-Fetch-Site", "same-site", overwrite: true);
			request.InitializePostData();
			request.PostData?.AddData(Encoding.UTF8.GetBytes(body));
			client.Attach(request, new UrlRequest(request, client, requestContext));
		}).ConfigureAwait(false);
		try
		{
			return await client.Completion.WaitAsync(RequestTimeout).ConfigureAwait(false);
		}
		catch (TimeoutException)
		{
			await Cef.UIThreadTaskFactory.StartNew(client.Cancel).ConfigureAwait(false);
			throw;
		}
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
		catch
		{
			return string.Empty;
		}
	}

	private sealed record CefResponse(
		UrlRequestStatus RequestStatus,
		int Status,
		string Body);

	private sealed class ChromiumUrlRequestClient : UrlRequestClient
	{
		private readonly int maximumBytes;
		private readonly MemoryStream body = new();
		private readonly TaskCompletionSource<CefResponse> completion =
			new(TaskCreationOptions.RunContinuationsAsynchronously);
		private IRequest? sourceRequest;
		private IUrlRequest? urlRequest;
		private bool tooLarge;

		public ChromiumUrlRequestClient(int maximumBytes)
		{
			this.maximumBytes = maximumBytes;
		}

		public Task<CefResponse> Completion => completion.Task;

		public void Attach(IRequest request, IUrlRequest activeRequest)
		{
			sourceRequest = request;
			urlRequest = activeRequest;
		}

		public void Cancel()
		{
			if (completion.TrySetException(new TimeoutException("OZON_DATA_NATIVE_PROBE_TIMEOUT")))
				DisposeRequest();
		}

		protected override void OnDownloadData(IUrlRequest request, Stream data)
		{
			if (tooLarge) return;
			long remaining = maximumBytes - body.Length;
			if (remaining <= 0 || data.Length > remaining)
			{
				tooLarge = true;
				return;
			}
			data.CopyTo(body);
		}

		protected override void OnRequestComplete(IUrlRequest request)
		{
			try
			{
				int status = request.Response?.StatusCode ?? 0;
				string source = tooLarge ? string.Empty : Encoding.UTF8.GetString(body.ToArray());
				completion.TrySetResult(new CefResponse(request.RequestStatus, status, source));
			}
			catch (Exception error)
			{
				completion.TrySetException(error);
			}
			finally
			{
				DisposeRequest();
			}
		}

		private void DisposeRequest()
		{
			urlRequest?.Dispose();
			sourceRequest?.Dispose();
			body.Dispose();
			urlRequest = null;
			sourceRequest = null;
		}
	}
}
