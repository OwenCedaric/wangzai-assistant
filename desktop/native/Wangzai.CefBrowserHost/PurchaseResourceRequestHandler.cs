using System.IO;
using CefSharp;
using CefSharp.Handler;
using CefSharp.ResponseFilter;

namespace Wangzai.CefBrowserHost;

/// <summary>
/// Keeps Chromium requests untouched while preserving the business-specific
/// 1688 response observer used by the purchasing workflow.
/// </summary>
internal sealed class PurchaseResourceRequestHandler : ResourceRequestHandler
{
	private readonly Alibaba1688OrderNetworkCapture? alibaba1688OrderCapture;
	private MemoryStream? capturedResponseBody;
	private StreamResponseFilter? capturedResponseFilter;
	private string capturedResponseUrl = string.Empty;

	public PurchaseResourceRequestHandler(Alibaba1688OrderNetworkCapture? alibaba1688OrderCapture = null)
	{
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
