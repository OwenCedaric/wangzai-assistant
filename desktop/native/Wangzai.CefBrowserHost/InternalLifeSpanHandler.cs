using CefSharp;
using CefSharp.Handler;
using CefSharp.WinForms;
using System.Windows.Forms;

namespace Wangzai.CefBrowserHost;

internal sealed class InternalLifeSpanHandler : LifeSpanHandler
{
	private readonly BrowserExtensionPackageManager extensions;

	public InternalLifeSpanHandler(BrowserExtensionPackageManager extensions)
	{
		this.extensions = extensions;
	}

	protected override bool OnBeforePopup(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, string targetUrl, string targetFrameName, WindowOpenDisposition targetDisposition, bool userGesture, IPopupFeatures popupFeatures, IWindowInfo windowInfo, IBrowserSettings browserSettings, ref bool noJavascriptAccess, out IWebBrowser? newBrowser)
	{
		newBrowser = null;
		string normalizedTargetUrl = BrowserUrlPolicy.NormalizePinduoduoTopLevelUrl(targetUrl);
		if (!BrowserUrlPolicy.IsAllowedInteractiveNavigation(normalizedTargetUrl, extensions)
			|| chromiumWebBrowser is not ChromiumWebBrowser browserControl
			|| browserControl.IsDisposed
			|| !browserControl.IsHandleCreated)
		{
			return true;
		}

		string deferredUrl = normalizedTargetUrl;
		try
		{
			browserControl.BeginInvoke((MethodInvoker)(() =>
			{
				if (browserControl.IsDisposed
					|| !BrowserUrlPolicy.IsAllowedInteractiveNavigation(deferredUrl, extensions))
				{
					return;
				}
				browserControl.LoadUrl(deferredUrl);
			}));
		}
		catch (ObjectDisposedException)
		{
			// Treat a late popup from a closing browser as cancelled.
		}
		catch (InvalidOperationException)
		{
			// The browser handle closed between the CEF popup callback and the UI dispatch.
		}
		return true;
	}
}
