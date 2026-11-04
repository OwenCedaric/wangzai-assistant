using CefSharp;
using CefSharp.Handler;

namespace Wangzai.CefBrowserHost;

internal sealed class InternalPermissionHandler : PermissionHandler
{
	public InternalPermissionHandler(BrowserHostForm _, BrowserExtensionPackageManager __)
	{
	}

	protected override bool OnRequestMediaAccessPermission(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, string requestingOrigin, MediaAccessPermissionType requestedPermissions, IMediaAccessCallback callback)
	{
		using (callback)
		{
			// Purchasing, SKU selection and checkout never require microphone or
			// camera access. Pinduoduo creates WebRTC probes during checkout; granting
			// those probes caused audio/STUN teardown inside libcef while the main
			// frame was navigating. Deny media explicitly instead of silently granting
			// every requested device.
			callback.Cancel();
		}
		return true;
	}

	protected override bool OnShowPermissionPrompt(
		IWebBrowser chromiumWebBrowser,
		IBrowser browser,
		ulong promptId,
		string requestingOrigin,
		PermissionRequestType requestedPermissions,
		IPermissionPromptCallback callback)
	{
		using (callback)
		{
			callback.Continue(PermissionRequestResult.Deny);
		}
		return true;
	}
}
