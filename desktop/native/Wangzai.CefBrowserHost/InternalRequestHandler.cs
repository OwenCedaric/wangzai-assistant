using CefSharp;
using CefSharp.Handler;
using CefSharp.WinForms;
using System.Windows.Forms;

namespace Wangzai.CefBrowserHost;

internal sealed class InternalRequestHandler : RequestHandler
{
	private readonly BrowserProfile profile;
	private readonly BrowserExtensionPackageManager extensions;
	private readonly Alibaba1688OrderNetworkCapture? alibaba1688OrderCapture;
	private readonly Action<CefTerminationStatus, int>? renderProcessTerminated;
	private readonly Action? renderViewReady;

	public InternalRequestHandler(
		BrowserProfile profile,
		BrowserExtensionPackageManager extensions,
		Alibaba1688OrderNetworkCapture? alibaba1688OrderCapture = null,
		Action<CefTerminationStatus, int>? renderProcessTerminated = null,
		Action? renderViewReady = null)
	{
		this.profile = profile;
		this.extensions = extensions;
		this.alibaba1688OrderCapture = alibaba1688OrderCapture;
		this.renderProcessTerminated = renderProcessTerminated;
		this.renderViewReady = renderViewReady;
	}

	protected override void OnRenderProcessTerminated(IWebBrowser chromiumWebBrowser, IBrowser browser,
		CefTerminationStatus status, int errorCode, string errorMessage)
	{
		// Do not forward errorMessage: it can include page data or addresses.
		renderProcessTerminated?.Invoke(status, errorCode);
	}

	protected override void OnRenderViewReady(IWebBrowser chromiumWebBrowser, IBrowser browser)
	{
		renderViewReady?.Invoke();
	}

	protected override bool OnBeforeBrowse(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, IRequest request, bool userGesture, bool isRedirect)
	{
		if (frame.IsMain)
		{
			string normalizedUrl = profile.PlatformKey.Equals("pinduoduo", StringComparison.OrdinalIgnoreCase)
				? BrowserUrlPolicy.NormalizePinduoduoTopLevelUrl(request.Url)
				: request.Url;
			if (!string.Equals(normalizedUrl, request.Url, StringComparison.Ordinal)
				&& chromiumWebBrowser is ChromiumWebBrowser browserControl
				&& !browserControl.IsDisposed
				&& browserControl.IsHandleCreated)
			{
				try
				{
					browserControl.BeginInvoke((MethodInvoker)(() =>
					{
						if (!browserControl.IsDisposed
							&& BrowserUrlPolicy.IsAllowedInteractiveNavigation(normalizedUrl, extensions))
						{
							browserControl.LoadUrl(normalizedUrl);
						}
					}));
				}
				catch (ObjectDisposedException) { }
				catch (InvalidOperationException) { }
				return true;
			}
			return !BrowserUrlPolicy.IsAllowedInteractiveNavigation(request.Url, extensions);
		}
		return false;
	}

	protected override IResourceRequestHandler? GetResourceRequestHandler(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, IRequest request, bool isNavigation, bool isDownload, string requestInitiator, ref bool disableDefaultHandling)
	{
		if (Uri.TryCreate(request.Url, UriKind.Absolute, out Uri? uri)
			&& (uri.Scheme.Equals("ws", StringComparison.OrdinalIgnoreCase)
				|| uri.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase)))
		{
			return null;
		}
		return new FingerprintResourceRequestHandler(profile, alibaba1688OrderCapture);
	}

}
