using CefSharp;

namespace Wangzai.CefBrowserHost;

internal sealed class FingerprintRenderProcessMessageHandler : IRenderProcessMessageHandler
{
	private readonly string fingerprintScript;

	public FingerprintRenderProcessMessageHandler(BrowserProfile profile)
	{
		// OnContextCreated runs before the marketplace SPA consumes and compacts
		// its bootstrap state. Install the PDD watcher in that earliest main-world
		// context; the script itself immediately exits on every non-PDD page.
		fingerprintScript = FingerprintScript.Build(profile);
	}

	public void OnContextCreated(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame)
	{
		// Checkout/payment transitions create and destroy several short-lived
		// subframes. Scheduling two renderer messages for every one of those
		// frames races CefFrame detach and has produced native access violations
		// after the Pinduoduo SKU-confirm button. Both scripts only need the main
		// marketplace document, so fail closed before scheduling any work.
		if (!frame.IsMain || !frame.IsValid) return;
		// Keep the two early scripts independent: one rejected fingerprint API
		// must never prevent the PDD product snapshot watcher from starting.
		try
		{
			frame.ExecuteJavaScriptAsync(fingerprintScript);
			if (frame.IsValid) frame.ExecuteJavaScriptAsync(PinduoduoProductSnapshotScript.Value);
		}
		catch (ObjectDisposedException)
		{
			// Main frame was replaced between OnContextCreated and dispatch.
		}
		catch (InvalidOperationException)
		{
			// Browser/frame teardown won the navigation race.
		}
	}

	public void OnContextReleased(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame)
	{
	}

	public void OnFocusedNodeChanged(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, IDomNode node)
	{
	}

	public void OnUncaughtException(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, JavascriptException exception)
	{
	}
}
