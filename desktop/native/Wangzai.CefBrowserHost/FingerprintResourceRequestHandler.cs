using System;
using System.Collections.Specialized;
using System.IO;
using CefSharp;
using CefSharp.Handler;
using CefSharp.ResponseFilter;

namespace Wangzai.CefBrowserHost;

internal sealed class FingerprintResourceRequestHandler : ResourceRequestHandler
{
	private readonly BrowserProfile profile;
	private readonly Alibaba1688OrderNetworkCapture? alibaba1688OrderCapture;
	private MemoryStream? capturedResponseBody;
	private StreamResponseFilter? capturedResponseFilter;
	private string capturedResponseUrl = string.Empty;

	public FingerprintResourceRequestHandler(
		BrowserProfile profile,
		Alibaba1688OrderNetworkCapture? alibaba1688OrderCapture = null)
	{
		this.profile = profile;
		this.alibaba1688OrderCapture = alibaba1688OrderCapture;
	}

	protected override CefReturnValue OnBeforeResourceLoad(
		IWebBrowser chromiumWebBrowser,
		IBrowser browser,
		IFrame frame,
		IRequest request,
		IRequestCallback callback)
	{
		alibaba1688OrderCapture?.Observe(request.Url);
		// WebSocket authentication is negotiated by Chromium together with the
		// cookie jar and connection identity. Reassigning its header collection can
		// make Ozon reject an otherwise valid Seller session. The bundled CEF major
		// is already aligned with the profile, so preserve the native handshake.
		if (Uri.TryCreate(request.Url, UriKind.Absolute, out Uri? requestUri)
			&& (requestUri.Scheme.Equals("ws", StringComparison.OrdinalIgnoreCase)
				|| requestUri.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase)))
		{
			return CefReturnValue.Continue;
		}
		NameValueCollection headers = request.Headers;
		headers["User-Agent"] = profile.UserAgent;
		headers["Accept-Language"] = profile.AcceptLanguage;
		// Client Hints and Sec-Fetch headers stay Chromium-owned. Manually creating
		// them here can diverge from the TLS/browser identity even when UA matches.
		request.Headers = headers;
		return CefReturnValue.Continue;
	}

	protected override IResponseFilter? GetResourceResponseFilter(
		IWebBrowser chromiumWebBrowser,
		IBrowser browser,
		IFrame frame,
		IRequest request,
		IResponse response)
	{
		if (alibaba1688OrderCapture == null
			|| alibaba1688OrderCapture.IsCompleted
			|| !Alibaba1688OrderNetworkCapture.Matches(request.Url)
			|| response.StatusCode < 200
			|| response.StatusCode >= 300)
		{
			return null;
		}

		capturedResponseUrl = request.Url ?? string.Empty;
		capturedResponseBody = new MemoryStream();
		capturedResponseFilter = new StreamResponseFilter(capturedResponseBody);
		return capturedResponseFilter;
	}

	protected override void OnResourceLoadComplete(
		IWebBrowser chromiumWebBrowser,
		IBrowser browser,
		IFrame frame,
		IRequest request,
		IResponse response,
		UrlRequestStatus status,
		long receivedContentLength)
	{
		if (capturedResponseBody == null) return;
		try
		{
			if (status == UrlRequestStatus.Success)
			{
				alibaba1688OrderCapture?.Accept(capturedResponseUrl, capturedResponseBody.ToArray());
			}
		}
		finally
		{
			capturedResponseFilter?.Dispose();
			capturedResponseBody.Dispose();
			capturedResponseFilter = null;
			capturedResponseBody = null;
			capturedResponseUrl = string.Empty;
		}
	}

}
