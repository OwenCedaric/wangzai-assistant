using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using CefSharp;
using CefSharp.DevTools;
using CefSharp.DevTools.Input;
using CefSharp.WinForms;

namespace Wangzai.CefBrowserHost;

internal sealed class BrowserSession : IDisposable
{
	private const string BuiltInVersion = "1.1.0";
	private const string OzonDataObserverName = "旺崽 Ozon 数据观察器";
	private static readonly string OzonDataObserverScriptRelativePath = Path.Combine(
		"content",
		"ozon-analytics-observer.js");
	private const int MaximumOzonDataObserverScriptBytes = 2 * 1024 * 1024;
	// 1688 detail pages keep a desktop min-width that is wider than the
	// workbench browser column. Chromium zoom -1.25 is about 80%, balancing
	// readable product details with the narrow embedded workbench viewport.
	private const double Embedded1688ZoomLevel = -1.25d;
	// Ozon Seller after-sales pages use the currently approved native 90%
	// scale. Keep it explicit so navigation, renderer replacement, and profile
	// reuse cannot inherit another workbench's zoom.
	private const double EmbeddedAfterSalesZoomLevel = -0.5778829311823857d;
	private const string CrossBorderChargePageContextScript = """
(() => {
  const clean = (value, maximum = 500) => String(value ?? '').trim().slice(0, maximum);
  const values = {};
  for (const field of document.querySelectorAll('input[name], select[name], textarea[name]')) {
    if (field.disabled) continue;
    const name = clean(field.getAttribute('name'), 80);
    if (!name) continue;
    const type = clean(field.getAttribute('type'), 20).toLowerCase();
    if ((type === 'checkbox' || type === 'radio') && !field.checked) continue;
    const value = clean(field.value);
    if (value) values[name] = value;
  }
  const pick = (...names) => {
    for (const name of names) {
      const value = clean(values[name]);
      if (value) return value;
    }
    return '';
  };
  return JSON.stringify({
    pageUrl: location.href,
    reason: pick('reason'),
    time: pick('time', 'date', 'date_range', 'time_range'),
    searchTime: pick('search_time', 'searchTime', 'time_type', 'time_range_type'),
    filters: values
  });
})()
""";
	private const string OzonSellerSessionEvidenceScript = """
(async () => {
  const clean = (value) => String(value ?? '').trim();
  const pathname = clean(location.pathname).toLowerCase();
  const explicitLoginRoute = pathname.includes('/registration/signin')
    || pathname.includes('/login')
    || pathname.includes('/signin');
  const isVisible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0
      && bounds.width > 0
      && bounds.height > 0;
  };
  const loginControlPresent = [...document.querySelectorAll([
    'form[action*="signin" i]',
    'form[action*="login" i]',
    'input[type="password"]',
    'input[autocomplete="one-time-code"]'
  ].join(','))].some(isVisible);
  const appLinks = [...document.querySelectorAll('a[href*="/app/"]')]
    .map((link) => clean(link.getAttribute('href')))
    .filter((href) => href && !href.includes('/registration/'));
  const sellerAppShellReady = document.readyState === 'complete'
    && pathname.startsWith('/app/')
    && !explicitLoginRoute
    && !loginControlPresent
    && appLinks.length >= 3
    && Boolean(document.querySelector('main, nav, header, [role="navigation"]'));

  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  let companyContextReady = false;
  let liveSellerResponse = false;
  if (runtime && typeof runtime.status === 'function') {
    try { companyContextReady = runtime.status()?.companyContextReady === true; } catch {}
  }
  if (runtime && typeof runtime.read === 'function') {
    try {
      const entries = runtime.read(0, 50, false)?.entries || [];
      liveSellerResponse = entries.some((entry) => {
        const status = Number(entry?.status) || 0;
        return entry?.origin === location.origin
          && status >= 200
          && status < 300
          && entry?.quality !== 'access-denied'
          && entry?.quality !== 'http-error';
      });
    } catch {}
  }

  const initialState = window.__INITIAL_STATE__ && typeof window.__INITIAL_STATE__ === 'object'
    ? window.__INITIAL_STATE__
    : {};
  const identityText = (...candidates) => {
    for (const candidate of candidates) {
      const value = clean(candidate);
      if (value) return value.slice(0, 200);
    }
    return '';
  };
  let companyId = identityText(
    window.__companyId,
    initialState.companyId,
    initialState.company?.id,
    initialState.company?.companyId,
    initialState.user?.companyId
  );
  let companyName = identityText(
    initialState.company?.name,
    initialState.companyName,
    initialState.user?.companyName,
    document.querySelector('[data-company-name]')?.textContent
  );

  const readIdentityField = (value, acceptedKeys, depth = 0) => {
    if (!value || depth > 6) return '';
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = readIdentityField(entry, acceptedKeys, depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    for (const [key, entry] of Object.entries(value)) {
      if (acceptedKeys.has(key)) {
        const found = identityText(entry);
        if (found) return found;
      }
    }
    for (const entry of Object.values(value)) {
      const found = readIdentityField(entry, acceptedKeys, depth + 1);
      if (found) return found;
    }
    return '';
  };
  const companyIdKeys = new Set([
    'currentCompanyId', 'selectedCompanyId', 'activeCompanyId',
    'companyId', 'company_id', 'sellerId', 'seller_id', 'clientId', 'client_id'
  ]);
  const companyNameKeys = new Set([
    'currentCompanyName', 'selectedCompanyName', 'activeCompanyName',
    'companyName', 'company_name', 'sellerName', 'seller_name'
  ]);

  let pageProbeStatus = 0;
  let pageProbeRedirectedToLogin = false;
  try {
    const response = await fetch('/api/user/interface-state', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}'
    });
    pageProbeStatus = Number(response.status) || 0;
    const responsePath = new URL(response.url || location.href, location.href).pathname.toLowerCase();
    pageProbeRedirectedToLogin = responsePath.includes('/registration/signin')
      || responsePath.includes('/login')
      || responsePath.includes('/signin');
    if (response.ok && !pageProbeRedirectedToLogin) {
      try {
        const payload = await response.clone().json();
        companyId = companyId || readIdentityField(payload, companyIdKeys);
        companyName = companyName || readIdentityField(payload, companyNameKeys);
      } catch {}
    }
  } catch {}

  return JSON.stringify({
    explicitLoginRoute,
    loginControlPresent,
    sellerAppShellReady,
    companyContextReady,
    companyId,
    companyName,
    liveSellerResponse,
    pageProbeStatus,
    pageProbeRedirectedToLogin
  });
})()
""";

	private readonly BrowserHostForm owner;

	private readonly RequestContext requestContext;
	private readonly BrowserExtensionPackageManager extensions;

	private readonly CrossBorderBuiltInRuntime crossBorder;

	private readonly System.Threading.Timer automaticCrossBorderTimer;
	private readonly System.Threading.Timer enforcedZoomTimer;

	private JsonNode? target;
	private double zoomLevel;
	private string pageFitMode = "native";

	private bool disposed;
	private readonly BrowserRendererHealth rendererHealth = new();
	private readonly BrowserNavigationReadiness navigationReadiness = new();
	private readonly object storageFlushGate = new();
	private Task<bool>? storageFlushTask;
	private int navigationSequence = 1;
	private int navigationStartedSequence;
	private int navigationCompletedSequence;

	public int LastLoadErrorCode { get; private set; }

	public string LastLoadErrorHost { get; private set; } = string.Empty;

	public BrowserProfile Profile { get; }

	public ChromiumWebBrowser Browser { get; }

	public string Address { get; private set; } = "about:blank";

	public string Title { get; private set; } = "新标签页";

	public bool IsLoading { get; private set; }

	public bool CanGoBack { get; private set; }

	public bool CanGoForward { get; private set; }

	public double ZoomLevel => zoomLevel;

	public string PageFitMode => pageFitMode;

	public BrowserSession(
		BrowserHostForm owner,
		BrowserProfile profile,
		BrowserExtensionPackageManager extensions,
		string initialUrl,
		RequestContext sharedRequestContext)
	{
		this.owner = owner;
		this.extensions = extensions;
		Profile = profile;
		Address = BrowserUrlPolicy.IsAllowed(initialUrl, extensions) ? initialUrl : "about:blank";
		Directory.CreateDirectory(profile.ProfileDirectory);
		Directory.CreateDirectory(profile.DownloadsDirectory);
		requestContext = sharedRequestContext;
		Browser = new ChromiumWebBrowser(Address, requestContext)
		{
			Dock = DockStyle.Fill,
			LifeSpanHandler = new InternalLifeSpanHandler(extensions),
			RequestHandler = new InternalRequestHandler(profile, extensions,
				renderProcessTerminated: OnRenderProcessTerminated,
				renderViewReady: OnRenderViewReady),
			PermissionHandler = new InternalPermissionHandler(owner, extensions),
			RenderProcessMessageHandler = new FingerprintRenderProcessMessageHandler(profile),
			DownloadHandler = new AccountDownloadHandler(owner, profile),
			DialogHandler = new AccountFileDialogHandler(owner, profile),
			Visible = false
		};
		crossBorder = new CrossBorderBuiltInRuntime(
			profile,
			requestContext,
			(string url, string platform) => owner.CaptureHiddenOriginalPluginLogisticsAsync(
				profile,
				requestContext,
				url,
				platform),
			(string url) => owner.CaptureHiddenPurchaseOrderAsync(profile, requestContext, url),
			async (string expectedOrderNumber) => await owner.CaptureAlibaba1688OrdersAsync(
				profile,
				requestContext,
				Alibaba1688OrderNetworkCapture.OrderListUrl,
				expectedOrderNumber).ConfigureAwait(continueOnCapturedContext: false),
			delegate(string url)
		{
			Browser.LoadUrl(url);
		});
		automaticCrossBorderTimer = new System.Threading.Timer(delegate(object? _)
		{
			_ = crossBorder.RunAutomaticSyncAsync();
		}, null, TimeSpan.FromHours(1.0), TimeSpan.FromHours(1.0));
		enforcedZoomTimer = new System.Threading.Timer(delegate(object? _)
		{
			if (!disposed && string.Equals(
				pageFitMode,
				"embedded-after-sales-fixed",
				StringComparison.Ordinal))
			{
				ApplyRequestedZoomLevel();
			}
		}, null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
		Browser.AddressChanged += delegate(object? _, AddressChangedEventArgs args)
		{
			Address = args.Address;
			owner.OnSessionStateChanged(this, "address");
		};
		Browser.LoadError += delegate(object? _, LoadErrorEventArgs args)
		{
			if (args.Frame?.IsMain != true || args.ErrorCode == CefErrorCode.Aborted) return;
			LastLoadErrorCode = (int)args.ErrorCode;
			LastLoadErrorHost = Uri.TryCreate(args.FailedUrl, UriKind.Absolute, out Uri? failed)
				? failed.Host
				: string.Empty;
			owner.OnSessionStateChanged(this, "load-error");
		};
		Browser.TitleChanged += delegate(object? _, TitleChangedEventArgs args)
		{
			Title = (string.IsNullOrWhiteSpace(args.Title) ? "新标签页" : args.Title);
			owner.OnSessionStateChanged(this, "title");
		};
		Browser.LoadingStateChanged += delegate(object? _, LoadingStateChangedEventArgs args)
		{
			IsLoading = args.IsLoading;
			CanGoBack = args.CanGoBack;
			CanGoForward = args.CanGoForward;
			if (args.IsLoading)
			{
				int requestedNavigation = Volatile.Read(ref navigationSequence);
				Interlocked.Exchange(ref navigationStartedSequence, Math.Max(
					Volatile.Read(ref navigationStartedSequence),
					requestedNavigation));
				LastLoadErrorCode = 0;
				LastLoadErrorHost = string.Empty;
			}
			else
			{
				int startedNavigation = Volatile.Read(ref navigationStartedSequence);
				if (startedNavigation > Volatile.Read(ref navigationCompletedSequence))
				{
					Interlocked.Exchange(ref navigationCompletedSequence, startedNavigation);
				}
				if (startedNavigation > 0) navigationReadiness.MarkInitialLoadCompleted();
			}
			// A committed cross-origin navigation can replace the renderer after
			// workbench mode already requested its 1688 fit. Reapply once the new
			// main frame settles so the recorded zoom and the visible page cannot
			// diverge.
			if (!args.IsLoading) ApplyRequestedZoomLevel();
			if (!args.IsLoading) _ = FlushPersistentStorageAsync();
			owner.OnSessionStateChanged(this, "loading");
		};
		Browser.IsBrowserInitializedChanged += delegate
		{
			if (Browser.IsBrowserInitialized)
			{
				navigationReadiness.MarkInitialized();
				ApplyRequestedZoomLevel();
				owner.OnSessionStateChanged(this, "initialized");
			}
		};
	}

	public void ApplyEmbeddedPageFit(bool embedded, string sidebarKind = "")
	{
		bool fit1688 = embedded && string.Equals(Profile.PlatformKey, "1688", StringComparison.OrdinalIgnoreCase);
		bool lockAfterSales = embedded
			&& string.Equals(sidebarKind, "after-sales", StringComparison.OrdinalIgnoreCase);
		double nextZoomLevel = fit1688
			? Embedded1688ZoomLevel
			: lockAfterSales
				? EmbeddedAfterSalesZoomLevel
				: 0.0d;
		string nextFitMode = fit1688
			? "embedded-fit-width"
			: lockAfterSales
				? "embedded-after-sales-fixed"
				: "native";
		zoomLevel = nextZoomLevel;
		pageFitMode = nextFitMode;
		enforcedZoomTimer.Change(
			lockAfterSales ? TimeSpan.FromMilliseconds(150.0) : Timeout.InfiniteTimeSpan,
			lockAfterSales ? TimeSpan.FromMilliseconds(150.0) : Timeout.InfiniteTimeSpan);
		ApplyRequestedZoomLevel();
	}

	private void ApplyRequestedZoomLevel()
	{
		if (disposed || !Browser.IsBrowserInitialized) return;
		Browser.SetZoomLevel(zoomLevel);
	}


	public object State()
	{
		BrowserRendererHealthSnapshot renderer = rendererHealth.Snapshot;
		return new
		{
			url = Address,
			title = Title,
			loading = IsLoading,
			navigationSequence = Volatile.Read(ref navigationSequence),
			navigationStartedSequence = Volatile.Read(ref navigationStartedSequence),
			navigationCompletedSequence = Volatile.Read(ref navigationCompletedSequence),
			crashed = renderer.Crashed,
			rendererTerminationStatus = renderer.TerminationStatus,
			rendererExitCode = renderer.ExitCode,
			canGoBack = CanGoBack,
			canGoForward = CanGoForward,
			extensionVersion = BuiltInVersion,
			crossBorderVersion = "1.0.0",
			proxyMode = BrowserProfile.Text(Profile.Proxy, "mode", "direct", 40),
			proxyConfigured = BrowserProfile.Text(Profile.Proxy, "mode", "direct", 40) == "fixed_servers",
			zoomLevel,
			pageFitMode,
			loadErrorCode = LastLoadErrorCode,
			loadErrorHost = LastLoadErrorHost,
			engine = "cef",
			embedding = owner.EmbeddingState()
		};
	}

	private void OnRenderProcessTerminated(CefTerminationStatus status, int errorCode)
	{
		if (disposed) return;
		rendererHealth.MarkTerminated(status.ToString(), errorCode);
		IsLoading = false;
		owner.OnSessionStateChanged(this, "renderer-crashed");
	}

	private void OnRenderViewReady()
	{
		if (disposed || !rendererHealth.MarkReady()) return;
		owner.OnSessionStateChanged(this, "renderer-ready");
	}

	public async Task<object?> ExecuteAsync(string command, JsonObject payload)
	{
		if (disposed)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_CLOSED");
		}
		switch (command)
		{
		case "health":
			BrowserRendererHealthSnapshot renderer = rendererHealth.Snapshot;
			return new
			{
				ok = !renderer.Crashed,
				health = renderer.Crashed ? "crashed" : "healthy",
				crashed = renderer.Crashed,
				rendererTerminationStatus = renderer.TerminationStatus,
				rendererExitCode = renderer.ExitCode,
				engine = "cef"
			};
		case "state":
			return State();
		case "activate":
			owner.ActivateSession(Profile.OwnerRef);
			return State();
		case "navigate":
		{
			string text = BrowserProfile.Required(payload, "url", 1800);
			if (!BrowserUrlPolicy.IsAllowed(text, extensions))
			{
				throw new InvalidOperationException("PURCHASE_BROWSER_NAVIGATION_FORBIDDEN");
			}
			// LoadUrl is asynchronous. Mark the request before handing it to CEF so
			// callers cannot mistake an unchanged URL and the previous loading=false
			// snapshot for a committed same-route navigation.
			// Wait for the actual initial page completion, not just host creation.
			// Otherwise CEF can overwrite this request with its initial about:blank
			// and that blank page's completion can falsely complete our sequence.
			await navigationReadiness.ExecuteAsync(() =>
			{
				int requestedNavigation = Interlocked.Increment(ref navigationSequence);
				// An initialized replacement may reuse an in-flight loading state,
				// so start its fence immediately before the single LoadUrl call.
				Interlocked.Exchange(ref navigationStartedSequence, Math.Max(
					Volatile.Read(ref navigationStartedSequence),
					requestedNavigation));
				IsLoading = true;
				Browser.LoadUrl(text);
			}, TimeSpan.FromSeconds(10)).ConfigureAwait(false);
			return State();
		}
		case "back":
			if (Browser.CanGoBack)
			{
				Browser.Back();
			}
			return State();
		case "forward":
			if (Browser.CanGoForward)
			{
				Browser.Forward();
			}
			return State();
		case "reload":
			Browser.Reload(ignoreCache: false);
			return State();
		case "ozon-open-order":
			return await OpenExactOzonSellerOrderAsync(payload).ConfigureAwait(continueOnCapturedContext: false);
		case "restore":
			owner.RestoreSession(Profile.OwnerRef);
			return State();
		case "hide":
			owner.HideBrowser();
			return State();
		case "inspect":
		case "capture-purchase":
			return await InspectAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "inspect-pinduoduo-order":
			return await InspectPinduoduoOrderAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "inspect-1688-order":
			return await InspectAlibaba1688OrderAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "set-target":
		case "target-recovery":
			target = payload["target"]?.DeepClone();
			return new
			{
				ok = true,
				target = target
			};
		case "get-target":
			return new
			{
				ok = true,
				target = target
			};
		case "clear-target":
			target = null;
			return new
			{
				ok = true,
				target = (object?)null
			};
		case "execute":
			return await ExecuteFixtureAsync(payload["task"] as JsonObject).ConfigureAwait(continueOnCapturedContext: false);
		case "purchase-auto-order":
			return await ExecutePurchaseAutoOrderAsync(payload).ConfigureAwait(continueOnCapturedContext: false);
		case "purchase-wait-pay-scan":
			return await ScanPurchaseWaitPayOrdersAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "export-purchase-session-cookies":
			return await ExportPurchaseSessionCookiesAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "import-purchase-session-cookies":
			return await ImportPurchaseSessionCookiesAsync(payload).ConfigureAwait(continueOnCapturedContext: false);
		case "approve-download":
			return new
			{
				ok = true,
				approved = true,
				reason = "native-save-dialog",
				downloadDirectory = Profile.DownloadsDirectory
			};
		case "cross-border-ping":
			return new
			{
				ok = true,
				enabled = true,
				runtimeKind = "builtin",
				version = "1.0.0"
			};
		case "cross-border-sync":
		case "cross-border-cancel":
		case "cross-border-orders":
		case "cross-border-status":
		case "cross-border-login-status":
		case "cross-border-charges-status":
			return await crossBorder.ExecuteAsync(command, payload).ConfigureAwait(continueOnCapturedContext: false);
		case "cross-border-charges":
		{
			// The visible native CEF page is the authority.  Never let a stale
			// renderer snapshot or an IPC caller claim that another page was selected.
			JsonObject chargePayload = (payload.DeepClone() as JsonObject) ?? new JsonObject();
			JsonObject pageContext = await ReadCrossBorderChargePageContextAsync().ConfigureAwait(continueOnCapturedContext: false);
			chargePayload["pageUrl"] = pageContext["pageUrl"]?.DeepClone();
			foreach (string field in new[] { "reason", "time", "searchTime" })
			{
				string selectedValue = pageContext[field]?.GetValue<string>()?.Trim() ?? string.Empty;
				if (selectedValue.Length > 0) chargePayload[field] = selectedValue;
			}
			chargePayload["pageFilters"] = pageContext["filters"]?.DeepClone();
			return await crossBorder.ExecuteAsync(command, chargePayload).ConfigureAwait(continueOnCapturedContext: false);
		}
		case "ozon-login-status":
			return await GetOzonLoginStatusAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-support-status":
			return await GetOzonSupportStatusAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "follow-seller-verification-status":
			return await GetFollowSellerVerificationStatusAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-support-open":
			return await OpenOzonSupportFromSellerShellAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "purchase-login-status":
			return await GetPurchaseLoginStatusAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "purchase-login-fixture":
			return await SeedPurchaseLoginFixtureAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-data-status":
			return await GetOzonDataStatusAsync().ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-data-read":
			return await ReadOzonDataAsync(payload).ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-data-catalog":
			return await EvaluateOzonDataAsync(OzonAnalyticsCaptureScript.Catalog, "OZON_DATA_OBSERVER_CATALOG_FAILED").ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-data-normalize":
			if (!Browser.CanExecuteJavascriptInMainFrame)
			{
				return new
				{
					ready = false,
					version = string.Empty,
					datasets = Array.Empty<object>()
				};
			}
			return await EvaluateOzonDataAsync(OzonAnalyticsCaptureScript.Normalize(payload), "OZON_DATA_OBSERVER_NORMALIZE_FAILED").ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-data-payload":
			return await EvaluateOzonDataAsync(OzonAnalyticsCaptureScript.Payload(payload), "OZON_DATA_OBSERVER_PAYLOAD_FAILED").ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-data-search":
			return await EvaluateOzonDataAsync(OzonAnalyticsCaptureScript.Search(payload), "OZON_DATA_OBSERVER_SEARCH_FAILED").ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-data-probe":
			return await ProbeOzonDataAsync(payload).ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-data-follow-sellers":
			// Reuse the patrol-only Chromium tab for the whole patrol.  Recreating a
			// renderer for every 100 SKUs discarded normal browser continuity and made
			// Ozon see a train of cold tabs.  The tab is still isolated from every
			// purchase, market and seller-backend browser role.
			return await OzonFollowSellerCapture.ExecuteAsync(
				payload,
				(skus, concurrency, includeProductFacts) => owner.CaptureOzonFollowSellerPayloadsAsync(
					Profile,
					requestContext,
					skus,
					concurrency,
					includeProductFacts,
					Browser),
				(captureToken, result) => owner.OnFollowSellerCaptureProgress(
					this,
					captureToken,
					result)).ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-submit-follow-seller-complaint":
			return await owner.SubmitOzonFollowSellerComplaintAsync(
				Profile,
				requestContext,
				payload).ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-prepare-follow-seller-scheme2-evidence":
			return await owner.PrepareOzonFollowSellerScheme2EvidenceAsync(
				Browser,
				payload).ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-submit-follow-seller-quick-complaint":
			return await owner.SubmitOzonFollowSellerQuickComplaintAsync(
				Browser,
				Profile,
				requestContext,
				payload).ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-data-paginate":
			return await PaginateOzonDataAsync(payload).ConfigureAwait(continueOnCapturedContext: false);
		case "ozon-data-cancel-pagination":
			return await EvaluateOzonDataAsync(OzonAnalyticsCaptureScript.CancelPagination, "OZON_DATA_OBSERVER_PAGINATION_CANCEL_FAILED").ConfigureAwait(continueOnCapturedContext: false);
		default:
			throw new InvalidOperationException("PURCHASE_BROWSER_COMMAND_INVALID");
		}
	}

	private async Task<object> PaginateOzonDataAsync(JsonObject payload)
	{
		try
		{
			return await EvaluateOzonDataAsync(
				OzonAnalyticsCaptureScript.Paginate(payload),
				"OZON_DATA_OBSERVER_PAGINATION_FAILED",
				TimeSpan.FromSeconds(90)).ConfigureAwait(continueOnCapturedContext: false);
		}
		catch (InvalidOperationException error) when (
			string.Equals(error.Message, "OZON_DATA_OBSERVER_NOT_READY", StringComparison.Ordinal))
		{
			try
			{
				await EvaluateOzonDataAsync(
					OzonAnalyticsCaptureScript.CancelPagination,
					"OZON_DATA_OBSERVER_PAGINATION_CANCEL_FAILED",
					TimeSpan.FromSeconds(10)).ConfigureAwait(continueOnCapturedContext: false);
			}
			catch
			{
				// The typed timeout below is authoritative. Cancellation is best-effort
				// and the observer's per-fetch deadline still fences a late response.
			}
			throw new InvalidOperationException("OZON_DATA_PAGINATION_TIMEOUT");
		}
	}

	private async Task<object> ScanPurchaseWaitPayOrdersAsync()
	{
		if (!Browser.CanExecuteJavascriptInMainFrame)
			throw new InvalidOperationException("PURCHASE_WAIT_PAY_BROWSER_NOT_READY");
		// This reader only inspects current DOM/page state. Do not involve the
		// site's Promise machinery for a synchronous scan.
		JavascriptResponse response = await Browser.EvaluateScriptAsync(
			PurchaseWaitPayScanScript.Value,
			TimeSpan.FromSeconds(20.0)).ConfigureAwait(continueOnCapturedContext: false);
		if (!response.Success || response.Result is not string json || JsonNode.Parse(json) is not JsonObject result)
			throw new InvalidOperationException("PURCHASE_WAIT_PAY_SCAN_FAILED");
		return result;
	}

	private async Task<object> ExecutePurchaseAutoOrderAsync(JsonObject payload)
	{
		string script = PurchaseAutoOrderScript.Build(payload);
		DateTimeOffset deadline = DateTimeOffset.UtcNow.AddMinutes(3);
		JsonObject? lastResult = null;
		for (int attempt = 0; attempt < 45 && DateTimeOffset.UtcNow < deadline; attempt++)
		{
			DateTimeOffset readyDeadline = DateTimeOffset.UtcNow.AddSeconds(20);
			while ((IsLoading || !Browser.CanExecuteJavascriptInMainFrame)
				&& DateTimeOffset.UtcNow < readyDeadline
				&& DateTimeOffset.UtcNow < deadline)
			{
				await Task.Delay(200).ConfigureAwait(continueOnCapturedContext: false);
			}
			if (!Browser.CanExecuteJavascriptInMainFrame)
			{
				await Task.Delay(350).ConfigureAwait(continueOnCapturedContext: false);
				continue;
			}

			JavascriptResponse response;
			try
			{
				response = await Browser.EvaluateScriptAsPromiseAsync(
					$"return ({script});",
					TimeSpan.FromSeconds(35.0)).ConfigureAwait(continueOnCapturedContext: false);
			}
			catch
			{
				// A checkout navigation destroys the old V8 context.  Wait for the
				// committed page and resume the same idempotent state machine.
				await Task.Delay(500).ConfigureAwait(continueOnCapturedContext: false);
				continue;
			}
			if (!response.Success || response.Result is not string json)
			{
				await Task.Delay(500).ConfigureAwait(continueOnCapturedContext: false);
				continue;
			}
			JsonObject? result = null;
			try { result = JsonNode.Parse(json) as JsonObject; }
			catch { /* navigation can truncate a renderer result */ }
			if (result == null)
			{
				await Task.Delay(500).ConfigureAwait(continueOnCapturedContext: false);
				continue;
			}
			lastResult = result;
			string stage = result["stage"]?.ToString()?.Trim() ?? string.Empty;
			bool paused = result["paused"]?.GetValue<bool>() == true;
			bool completed = string.Equals(stage, "completed", StringComparison.OrdinalIgnoreCase);
			bool paymentPending = string.Equals(stage, "payment-pending", StringComparison.OrdinalIgnoreCase)
				|| !string.IsNullOrWhiteSpace(result["paymentUrl"]?.ToString());
			bool pinduoduoPayment = string.Equals(
				payload["sourcePlatform"]?.ToString(),
				"拼多多",
				StringComparison.OrdinalIgnoreCase);
			bool autoSubmit = payload["autoSubmitOrder"]?.GetValue<bool>() == true;
			if (paused || completed || (paymentPending && pinduoduoPayment)
				|| (string.Equals(stage, "checkout-pending", StringComparison.OrdinalIgnoreCase) && !autoSubmit))
				return result;
			if (paymentPending)
			{
				await Task.Delay(1000).ConfigureAwait(continueOnCapturedContext: false);
				continue;
			}
			if (string.Equals(stage, "checkout-progress", StringComparison.OrdinalIgnoreCase))
			{
				await Task.Delay(750).ConfigureAwait(continueOnCapturedContext: false);
				continue;
			}
			if (string.Equals(stage, "checkout-pending", StringComparison.OrdinalIgnoreCase) && autoSubmit)
			{
				result["paused"] = true;
				result["pauseReason"] = "PURCHASE_AUTO_ORDER_PAGE_UNSUPPORTED";
				result["stage"] = "paused";
				return result;
			}
			await Task.Delay(500).ConfigureAwait(continueOnCapturedContext: false);
		}
		if (lastResult != null)
		{
			lastResult["paused"] = true;
			lastResult["pauseReason"] = "PURCHASE_AUTO_ORDER_EXECUTION_TIMEOUT";
			lastResult["stage"] = "paused";
			return lastResult;
		}
		throw new InvalidOperationException("PURCHASE_AUTO_ORDER_EXECUTION_FAILED");
	}

	private async Task<object> ExportPurchaseSessionCookiesAsync()
	{
		string platform = Profile.PlatformKey.ToLowerInvariant();
		string[] cookieUrls = platform switch
		{
			"pinduoduo" => new[] { "https://mobile.yangkeduo.com/" },
			"taobao" or "tmall" => new[] { "https://buyertrade.taobao.com/", "https://trade.taobao.com/", "https://www.taobao.com/", "https://www.tmall.com/" },
			"1688" => new[] { "https://air.1688.com/", "https://trade.1688.com/", "https://www.1688.com/" },
			_ => throw new InvalidOperationException("PURCHASE_PAYMENT_PLATFORM_ACCOUNT_REQUIRED")
		};
		ICookieManager manager = await requestContext.GetCookieManagerAsync().ConfigureAwait(continueOnCapturedContext: false);
		if (manager == null) throw new InvalidOperationException("PURCHASE_BROWSER_COOKIE_MANAGER_UNAVAILABLE");
		var cookies = new List<CefSharp.Cookie>();
		foreach (string cookieUrl in cookieUrls)
		{
			IReadOnlyList<CefSharp.Cookie> rows = await manager.VisitUrlCookiesAsync(
				cookieUrl,
				includeHttpOnly: true).ConfigureAwait(continueOnCapturedContext: false);
			cookies.AddRange(rows);
		}
		var uniqueCookies = cookies
			.GroupBy(cookie => $"{cookie.Domain}\u0000{cookie.Path}\u0000{cookie.Name}", StringComparer.Ordinal)
			.Select(group => group.First())
			.ToArray();
		return new
		{
			ok = true,
			platform,
			urls = cookieUrls,
			cookies = uniqueCookies.Select(cookie => new
			{
				name = cookie.Name,
				value = cookie.Value,
				domain = cookie.Domain,
				path = string.IsNullOrWhiteSpace(cookie.Path) ? "/" : cookie.Path,
				secure = cookie.Secure,
				httpOnly = cookie.HttpOnly,
				expirationDate = cookie.Expires.HasValue
					? new DateTimeOffset(cookie.Expires.Value.ToUniversalTime()).ToUnixTimeSeconds()
					: (long?)null
			}).ToArray()
		};
	}

	private async Task<object> ImportPurchaseSessionCookiesAsync(JsonObject payload)
	{
		string platform = Profile.PlatformKey.ToLowerInvariant();
		string[] allowedSuffixes = platform switch
		{
			"pinduoduo" => new[] { "yangkeduo.com", "pinduoduo.com" },
			"taobao" or "tmall" => new[] { "taobao.com", "tmall.com", "tb.cn" },
			"1688" => new[] { "1688.com", "alibaba.com" },
			_ => throw new InvalidOperationException("PURCHASE_PAYMENT_PLATFORM_ACCOUNT_REQUIRED")
		};
		if (payload["cookies"] is not JsonArray rows)
		{
			return new { ok = true, platform, importedCookieCount = 0, cookieSaved = false };
		}
		ICookieManager manager = await requestContext.GetCookieManagerAsync().ConfigureAwait(continueOnCapturedContext: false);
		if (manager == null) throw new InvalidOperationException("PURCHASE_BROWSER_COOKIE_MANAGER_UNAVAILABLE");
		int imported = 0;
		foreach (JsonNode? node in rows)
		{
			if (node is not JsonObject source) continue;
			string name = JsonScalarText(source["name"], 256);
			string value = JsonScalarText(source["value"], 8192);
			string domain = JsonScalarText(source["domain"], 253).TrimStart('.').ToLowerInvariant();
			if (name.Length == 0 || value.Length == 0 || domain.Length == 0) continue;
			if (!allowedSuffixes.Any(suffix => domain == suffix || domain.EndsWith($".{suffix}", StringComparison.Ordinal))) continue;
			string path = JsonScalarText(source["path"], 512);
			if (path.Length == 0 || !path.StartsWith('/')) path = "/";
			bool secure = source["secure"]?.GetValue<bool>() ?? true;
			bool httpOnly = source["httpOnly"]?.GetValue<bool>() ?? false;
			var cookie = new CefSharp.Cookie
			{
				Name = name,
				Value = value,
				Domain = $".{domain}",
				Path = path,
				Secure = secure,
				HttpOnly = httpOnly
			};
			string expirationText = JsonScalarText(source["expirationDate"], 40);
			if (long.TryParse(expirationText, out long expirationSeconds) && expirationSeconds > DateTimeOffset.UtcNow.ToUnixTimeSeconds())
			{
				cookie.Expires = DateTimeOffset.FromUnixTimeSeconds(expirationSeconds).UtcDateTime;
			}
			if (await manager.SetCookieAsync($"https://{domain}/", cookie).ConfigureAwait(continueOnCapturedContext: false)) imported++;
		}
		bool saved = imported > 0 && await manager.FlushStoreAsync().ConfigureAwait(continueOnCapturedContext: false);
		return new { ok = true, platform, importedCookieCount = imported, cookieSaved = saved };
	}

	public Task<bool> FlushPersistentStorageAsync()
	{
		lock (storageFlushGate)
		{
			if (disposed) return Task.FromResult(false);
			return storageFlushTask ??= FlushPersistentStorageCoreAsync();
		}
	}

	private async Task<bool> FlushPersistentStorageCoreAsync()
	{
		try
		{
			ICookieManager manager = await requestContext.GetCookieManagerAsync().ConfigureAwait(false);
			return manager != null && await manager.FlushStoreAsync().ConfigureAwait(false);
		}
		catch
		{
			return false;
		}
		finally
		{
			lock (storageFlushGate)
			{
				storageFlushTask = null;
			}
		}
	}

	private BrowserExtensionPackage? OzonDataObserver()
	{
		return extensions.List().FirstOrDefault(package =>
			string.Equals(package.Name, OzonDataObserverName, StringComparison.Ordinal));
	}

	private bool IsOzonSellerPage()
	{
		return Uri.TryCreate(Address, UriKind.Absolute, out Uri? uri)
			&& string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase)
			&& string.Equals(uri.Host, "seller.ozon.ru", StringComparison.OrdinalIgnoreCase);
	}

	private bool IsOzonDataPage()
	{
		return Uri.TryCreate(Address, UriKind.Absolute, out Uri? uri)
			&& string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase)
			&& (string.Equals(uri.Host, "seller.ozon.ru", StringComparison.OrdinalIgnoreCase)
				|| string.Equals(uri.Host, "www.ozon.ru", StringComparison.OrdinalIgnoreCase)
				|| string.Equals(uri.Host, "ozon.ru", StringComparison.OrdinalIgnoreCase));
	}

	private async Task<object> GetOzonDataStatusAsync()
	{
		BrowserExtensionPackage? package = OzonDataObserver();
		bool pageEligible = IsOzonDataPage();
		bool javascriptReady = Browser.CanExecuteJavascriptInMainFrame;
		bool packageChanged = package?.CanLoad == true && owner.ExtensionRequiresRestart(package);
		JsonObject runtime = pageEligible && package?.Enabled == true && package.CanLoad && javascriptReady
			? packageChanged
				? await EvaluateJsonAsync(OzonAnalyticsCaptureScript.Status, "OZON_DATA_OBSERVER_STATUS_FAILED").ConfigureAwait(continueOnCapturedContext: false)
				: await EnsureOzonDataObserverRuntimeAsync(package).ConfigureAwait(continueOnCapturedContext: false)
			: new JsonObject
			{
				["ready"] = false,
				["version"] = string.Empty,
				["queueLength"] = 0,
				["lastSequence"] = 0
			};
		bool restartRequired = packageChanged || (runtime["ready"]?.GetValue<bool>() == true
			&& !string.Equals(runtime["version"]?.ToString(), package?.Version, StringComparison.Ordinal));
		bool captureScopeVerified = (runtime["frameCapture"]?["scopeFailures"]?.GetValue<int>() ?? 0) == 0;
		return new
		{
			installed = package != null,
			enabled = package?.Enabled == true,
			extensionId = package?.Id ?? string.Empty,
			extensionVersion = package?.Version ?? string.Empty,
			compatibilityCode = package?.CompatibilityCode ?? string.Empty,
			pageEligible,
			ready = runtime["ready"]?.GetValue<bool>() == true && !restartRequired && captureScopeVerified,
			restartRequired,
			captureScopeVerified,
			runtime
		};
	}

	private async Task<JsonObject> EnsureOzonDataObserverRuntimeAsync(BrowserExtensionPackage package)
	{
		JsonObject runtime = await EvaluateJsonAsync(
			OzonAnalyticsCaptureScript.Status,
			"OZON_DATA_OBSERVER_STATUS_FAILED").ConfigureAwait(continueOnCapturedContext: false);
		if (runtime["ready"]?.GetValue<bool>() == true) return runtime;

		// CEF can report the unpacked extension as installed before its document_start
		// content script has entered the newly-created main-frame V8 context. Inject
		// the exact bundled script into that context as a deterministic fallback.
		// The script is idempotent, and the next poll repeats this check if a renderer
		// replacement happened between injection and the status readback.
		string scriptPath = Path.GetFullPath(Path.Combine(
			package.InstallDirectory,
			OzonDataObserverScriptRelativePath));
		string installRoot = Path.GetFullPath(package.InstallDirectory)
			.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
			+ Path.DirectorySeparatorChar;
		if (!scriptPath.StartsWith(installRoot, StringComparison.OrdinalIgnoreCase))
		{
			throw new InvalidOperationException("OZON_DATA_OBSERVER_SCRIPT_INVALID");
		}
		FileInfo info = new(scriptPath);
		if (!info.Exists || info.Length <= 0 || info.Length > MaximumOzonDataObserverScriptBytes)
		{
			throw new InvalidOperationException("OZON_DATA_OBSERVER_SCRIPT_INVALID");
		}
		string source = await File.ReadAllTextAsync(scriptPath).ConfigureAwait(continueOnCapturedContext: false);
		JavascriptResponse injected = await Browser.EvaluateScriptAsync(
			source,
			TimeSpan.FromSeconds(10.0)).ConfigureAwait(continueOnCapturedContext: false);
		if (!injected.Success)
		{
			throw new InvalidOperationException("OZON_DATA_OBSERVER_INJECTION_FAILED");
		}
		return await EvaluateJsonAsync(
			OzonAnalyticsCaptureScript.Status,
			"OZON_DATA_OBSERVER_STATUS_FAILED").ConfigureAwait(continueOnCapturedContext: false);
	}

	private async Task<object> ReadOzonDataAsync(JsonObject payload)
	{
		return await EvaluateOzonDataAsync(
			OzonAnalyticsCaptureScript.Read(payload),
			"OZON_DATA_OBSERVER_READ_FAILED").ConfigureAwait(continueOnCapturedContext: false);
	}

	private async Task<object> ProbeOzonDataAsync(JsonObject payload)
	{
		bool forceNativeFallback = false;
		try { forceNativeFallback = payload["forceNativeFallback"]?.GetValue<bool>() == true; }
		catch { forceNativeFallback = false; }
		if (!forceNativeFallback)
		{
			try
			{
				return await EvaluateOzonDataAsync(
					OzonAnalyticsCaptureScript.Probe(payload),
					"OZON_DATA_OBSERVER_PROBE_FAILED",
					TimeSpan.FromSeconds(30)).ConfigureAwait(continueOnCapturedContext: false);
			}
			catch (InvalidOperationException error)
			{
				if (!OzonProductPerformanceProbeCapture.Supports(payload)) throw;
				Console.Error.WriteLine(
					$"[ozon-observer] product-performance renderer probe failed; native fallback started code={error.Message}");
			}
		}
		if (!OzonProductPerformanceProbeCapture.Supports(payload))
		{
			throw new InvalidOperationException("OZON_DATA_OBSERVER_PROBE_FAILED");
		}

		try
		{
			object result = await OzonProductPerformanceProbeCapture.ExecuteAsync(
				Profile,
				requestContext,
				payload,
				async () => (JsonObject)await EvaluateOzonDataAsync(
					OzonAnalyticsCaptureScript.PrepareProbe(payload),
					"OZON_DATA_NATIVE_PROBE_PREPARE_FAILED").ConfigureAwait(continueOnCapturedContext: false),
				(status, responseText) => EvaluateOzonDataAsync(
					OzonAnalyticsCaptureScript.CommitProbe(payload, status, responseText),
					"OZON_DATA_NATIVE_PROBE_COMMIT_FAILED",
					TimeSpan.FromSeconds(30))).ConfigureAwait(continueOnCapturedContext: false);
			Console.Error.WriteLine("[ozon-observer] product-performance native fallback completed");
			return result;
		}
		catch (Exception error)
		{
			Console.Error.WriteLine(
				$"[ozon-observer] product-performance native fallback failed code={error.Message}");
			throw new InvalidOperationException("OZON_DATA_OBSERVER_PROBE_FAILED", error);
		}
	}

	private async Task<object> OpenExactOzonSellerOrderAsync(JsonObject payload)
	{
		if (!IsOzonSellerPage())
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_OZON_ORDER_PAGE_REQUIRED");
		}
		string postingNumber = BrowserProfile.Required(payload, "postingNumber", 160);
		string routeKind = BrowserProfile.Text(payload, "routeKind", "fbs", 12).ToLowerInvariant();
		if (routeKind is not ("fbs" or "fbo" or "rfbs"))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_OZON_ORDER_ROUTE_INVALID");
		}
		DateTimeOffset deadline = DateTimeOffset.UtcNow.AddSeconds(30);
		while (!Browser.CanExecuteJavascriptInMainFrame && DateTimeOffset.UtcNow < deadline)
		{
			if (disposed) throw new ObjectDisposedException(nameof(BrowserSession));
			await Task.Delay(100).ConfigureAwait(continueOnCapturedContext: false);
		}
		if (!Browser.CanExecuteJavascriptInMainFrame)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_OZON_ORDER_SEARCH_NOT_READY");
		}
		JsonObject? result = null;
		for (int nativeClickAttempt = 0; nativeClickAttempt <= 4; nativeClickAttempt++)
		{
			JavascriptResponse response;
			try
			{
				response = await Browser.EvaluateScriptAsPromiseAsync(
					$"return ({OzonSellerOrderOpenScript.Build(postingNumber)});",
					TimeSpan.FromSeconds(82)).ConfigureAwait(continueOnCapturedContext: false);
			}
			catch (TaskCanceledException error)
			{
				DateTimeOffset contextRecoveryDeadline = DateTimeOffset.UtcNow.AddSeconds(8);
				while (!Browser.CanExecuteJavascriptInMainFrame && DateTimeOffset.UtcNow < contextRecoveryDeadline)
				{
					await Task.Delay(120).ConfigureAwait(continueOnCapturedContext: false);
				}
				if (Browser.CanExecuteJavascriptInMainFrame && nativeClickAttempt < 4)
				{
					continue;
				}
				throw new InvalidOperationException("PURCHASE_BROWSER_OZON_ORDER_SEARCH_NOT_READY", error);
			}
			if (!response.Success || response.Result is not string json)
			{
				throw new InvalidOperationException("PURCHASE_BROWSER_OZON_ORDER_SEARCH_NOT_READY");
			}
			result = (JsonNode.Parse(json) as JsonObject)
				?? throw new InvalidOperationException("PURCHASE_BROWSER_OZON_ORDER_SEARCH_NOT_READY");
			if (result["exact"]?.GetValue<bool>() == true && result["opened"]?.GetValue<bool>() == true)
			{
				return result;
			}
			if (!string.Equals(result["reason"]?.GetValue<string>(), "native-click-required", StringComparison.Ordinal))
			{
				break;
			}
			double x = result["x"]?.GetValue<double>() ?? -1;
			double y = result["y"]?.GetValue<double>() ?? -1;
			double viewportWidth = result["viewportWidth"]?.GetValue<double>() ?? 0;
			double viewportHeight = result["viewportHeight"]?.GetValue<double>() ?? 0;
			if (x < 0 || y < 0
				|| viewportWidth <= 0 || viewportHeight <= 0
				|| x > viewportWidth || y > viewportHeight
				|| nativeClickAttempt >= 4)
			{
				break;
			}
			using DevToolsClient devTools = Browser.GetDevToolsClient();
			await devTools.Input.DispatchMouseEventAsync(
				DispatchMouseEventType.MouseMoved, x, y,
				button: MouseButton.None, buttons: 0, clickCount: 0).ConfigureAwait(continueOnCapturedContext: false);
			await devTools.Input.DispatchMouseEventAsync(
				DispatchMouseEventType.MousePressed, x, y,
				button: MouseButton.Left, buttons: 1, clickCount: 1).ConfigureAwait(continueOnCapturedContext: false);
			await devTools.Input.DispatchMouseEventAsync(
				DispatchMouseEventType.MouseReleased, x, y,
				button: MouseButton.Left, buttons: 0, clickCount: 1).ConfigureAwait(continueOnCapturedContext: false);
			await Task.Delay(result["clickKind"]?.GetValue<string>() == "order" ? 1200 : 500)
				.ConfigureAwait(continueOnCapturedContext: false);
		}
		if (result == null)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_OZON_ORDER_SEARCH_NOT_READY");
		}
		string reason = result["reason"]?.GetValue<string>()?.Trim() ?? string.Empty;
		string errorCode = reason switch
		{
			"page-required" => "PURCHASE_BROWSER_OZON_ORDER_PAGE_REQUIRED",
			"not-found" => "PURCHASE_BROWSER_OZON_ORDER_NOT_FOUND",
			"open-failed" => "PURCHASE_BROWSER_OZON_ORDER_OPEN_FAILED",
			_ => "PURCHASE_BROWSER_OZON_ORDER_SEARCH_NOT_READY"
		};
		throw new InvalidOperationException(errorCode);
	}

	private async Task<object> EvaluateOzonDataAsync(string script, string errorCode, TimeSpan? timeout = null)
	{
		BrowserExtensionPackage? package = OzonDataObserver();
		bool cancellation = script == OzonAnalyticsCaptureScript.CancelPagination;
		if (!cancellation && package?.Enabled != true)
		{
			throw new InvalidOperationException("OZON_DATA_OBSERVER_NOT_INSTALLED");
		}
		if (!cancellation && !package!.CanLoad) throw new InvalidOperationException(package.CompatibilityCode);
		if (!IsOzonDataPage())
		{
			throw new InvalidOperationException("OZON_DATA_OBSERVER_PAGE_REQUIRED");
		}
		// Cancellation must remain available for an old page. Other commands
		// validate the running version in the same V8 evaluation as the read.
		if (!cancellation && owner.ExtensionRequiresRestart(package!))
		{
			throw new InvalidOperationException("OZON_DATA_OBSERVER_RESTART_REQUIRED");
		}
		string guarded = cancellation
			? script : OzonAnalyticsCaptureScript.RequireVersion(script, package!.Version);
		return await EvaluateJsonAsync(guarded, errorCode, timeout).ConfigureAwait(continueOnCapturedContext: false);
	}

	private async Task<JsonObject> EvaluateJsonAsync(string script, string errorCode, TimeSpan? timeout = null)
	{
		if (!Browser.CanExecuteJavascriptInMainFrame)
		{
			throw new InvalidOperationException("OZON_DATA_OBSERVER_NOT_READY");
		}
		JavascriptResponse response;
		try
		{
			// The observer search/probe/paginate entry points return Promises.  The
			// ordinary EvaluateScriptAsync API reports that Promise object itself,
			// so Result is not the JSON string and every live pagination attempt is
			// incorrectly surfaced as OZON_DATA_OBSERVER_PAGINATION_FAILED.  Resolve
			// both synchronous and asynchronous observer expressions through the
			// CefSharp promise bridge before parsing their JSON result.
			response = await Browser.EvaluateScriptAsPromiseAsync(
				$"return ({script});",
				timeout ?? TimeSpan.FromSeconds(10.0)).ConfigureAwait(continueOnCapturedContext: false);
		}
		catch (TaskCanceledException)
		{
			Console.Error.WriteLine($"[ozon-observer] code={errorCode} diagnostic=promise-timeout");
			throw new InvalidOperationException("OZON_DATA_OBSERVER_NOT_READY");
		}
		if (!response.Success || response.Result is not string json)
		{
			string responseMessage = response.Message ?? string.Empty;
			if (responseMessage.Length > 800)
			{
				responseMessage = responseMessage[..800];
			}
			foreach (string expectedCode in new[]
			{
				"OZON_DATA_OBSERVER_RESTART_REQUIRED",
				"OZON_DATA_FRAME_SCOPE_UNVERIFIED",
				"OZON_DATA_PAGINATION_UNAVAILABLE",
				"OZON_DATA_PAGINATION_NOT_SAFE",
				"OZON_DATA_PAYLOAD_NOT_FOUND"
			})
			{
				if (responseMessage.Contains(expectedCode, StringComparison.Ordinal))
				{
					// The observer deliberately refuses unsafe or unavailable replay.
					// Preserve its typed result so the frontend can skip that source
					// without turning a normal capability miss into a CEF failure.
					throw new InvalidOperationException(expectedCode);
				}
			}
			string diagnostic = $"success={response.Success}; resultType={response.Result?.GetType().FullName ?? "null"}; message={responseMessage}";
			Console.Error.WriteLine($"[ozon-observer] code={errorCode} diagnostic={diagnostic}");
			throw new InvalidOperationException(errorCode, new InvalidOperationException(diagnostic));
		}
		try
		{
			return JsonNode.Parse(json) as JsonObject ?? throw new InvalidOperationException(errorCode);
		}
		catch
		{
			throw new InvalidOperationException(errorCode);
		}
	}

	private async Task<JsonObject> ReadCrossBorderChargePageContextAsync()
	{
		if (!IsCrossBorderChargePageAddress(Address))
		{
			throw new InvalidOperationException("CROSS_BORDER_CHARGE_PAGE_REQUIRED");
		}
		DateTimeOffset deadline = DateTimeOffset.UtcNow.AddSeconds(5.0);
		while (!Browser.CanExecuteJavascriptInMainFrame && DateTimeOffset.UtcNow < deadline)
		{
			if (disposed) throw new ObjectDisposedException(nameof(BrowserSession));
			await Task.Delay(50).ConfigureAwait(continueOnCapturedContext: false);
		}
		if (!Browser.CanExecuteJavascriptInMainFrame)
		{
			throw new InvalidOperationException("CROSS_BORDER_CHARGE_PAGE_CONTEXT_NOT_READY");
		}
		JavascriptResponse pageEvaluation;
		try
		{
			pageEvaluation = await Browser.EvaluateScriptAsync(
				CrossBorderChargePageContextScript,
				TimeSpan.FromSeconds(5.0)).ConfigureAwait(continueOnCapturedContext: false);
		}
		catch (TaskCanceledException error)
		{
			throw new InvalidOperationException("CROSS_BORDER_CHARGE_PAGE_CONTEXT_NOT_READY", error);
		}
		if (!pageEvaluation.Success || pageEvaluation.Result is not string json)
		{
			throw new InvalidOperationException("CROSS_BORDER_CHARGE_PAGE_CONTEXT_FAILED");
		}
		JsonObject context = (JsonNode.Parse(json) as JsonObject)
			?? throw new InvalidOperationException("CROSS_BORDER_CHARGE_PAGE_CONTEXT_FAILED");
		string pageUrl = context["pageUrl"]?.GetValue<string>()?.Trim() ?? string.Empty;
		if (!IsCrossBorderChargePageAddress(pageUrl))
		{
			throw new InvalidOperationException("CROSS_BORDER_CHARGE_PAGE_REQUIRED");
		}
		return context;
	}

	private static bool IsCrossBorderChargePageAddress(string? value)
	{
		if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)) return false;
		if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;
		bool correctHost = uri.Host.Equals("kuajing84.com", StringComparison.OrdinalIgnoreCase)
			|| uri.Host.EndsWith(".kuajing84.com", StringComparison.OrdinalIgnoreCase);
		return correctHost
			&& uri.AbsolutePath.Equals("/index/finance/record_consume.html", StringComparison.OrdinalIgnoreCase);
	}

	private async Task<object> GetFollowSellerVerificationStatusAsync()
	{
		if (!Profile.BrowserRole.Equals("follow-seller-collector", StringComparison.Ordinal))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_FOLLOW_SELLER_TAB_REQUIRED");
		}
		string currentUrl = Address ?? string.Empty;
		bool ozonUrl = Uri.TryCreate(currentUrl, UriKind.Absolute, out Uri? uri)
			&& uri.Scheme is "http" or "https"
			&& (uri.Host.Equals("ozon.ru", StringComparison.OrdinalIgnoreCase)
				|| uri.Host.EndsWith(".ozon.ru", StringComparison.OrdinalIgnoreCase));
		bool urlChallenge = ozonUrl && uri!.Query.Contains("__rr", StringComparison.OrdinalIgnoreCase);
		if (!ozonUrl || IsLoading || !Browser.CanExecuteJavascriptInMainFrame)
		{
			return new
			{
				pageReady = false,
				challengeDetected = urlChallenge,
				verificationReady = false,
				url = currentUrl
			};
		}
		const string script = """
(() => {
  const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  let rrUrl = false;
  try { rrUrl = new URL(location.href).searchParams.has('__rr'); } catch {}
  const markerText = `${document.title || ''} ${bodyText}`;
  const markerNode = document.querySelector([
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    '[data-widget*="captcha" i]',
    'iframe[src*="captcha" i]',
    'iframe[src*="challenge" i]',
    'iframe[src*="verify" i]'
  ].join(','));
  const textChallenge = bodyText.length > 0 && bodyText.length < 8000
    && /(?:403|обновите страницу|подтвердите, что вы не робот|доступ ограничен|пройдите проверку|refresh the page|verify you are human|are you a robot|人机验证|验证码|刷新页面|拖动滑块)/iu.test(markerText);
  const challengeDetected = rrUrl || !!markerNode || textChallenge;
  const pageReady = document.readyState === 'complete' && bodyText.length > 0;
  return JSON.stringify({
    pageReady,
    challengeDetected,
    verificationReady: pageReady && !challengeDetected,
    url: location.href,
    bodyTextLength: bodyText.length
  });
})()
""";
		try
		{
			JavascriptResponse evaluation = await Browser.EvaluateScriptAsync(
				script,
				TimeSpan.FromSeconds(5.0)).ConfigureAwait(continueOnCapturedContext: false);
			if (evaluation.Success && evaluation.Result is string json
				&& JsonNode.Parse(json) is JsonObject result)
			{
				return result;
			}
		}
		catch
		{
			// A renderer handoff is not proof that verification completed.
		}
		return new
		{
			pageReady = false,
			challengeDetected = urlChallenge,
			verificationReady = false,
			url = currentUrl
		};
	}

	private async Task<object> GetOzonSupportStatusAsync()
	{
		if (!Uri.TryCreate(Address, UriKind.Absolute, out Uri? uri)
			|| !uri.Host.Equals("seller.ozon.ru", StringComparison.OrdinalIgnoreCase)
			|| !uri.AbsolutePath.StartsWith("/app/messenger", StringComparison.OrdinalIgnoreCase))
		{
			return new
			{
				ready = false,
				pageReady = false,
				conversationVisible = false,
				composerVisible = false,
				conversationListVisible = false,
				emptyConversationVisible = false,
				loadingIndicator = false,
				loadFailed = false,
				page = Uri.TryCreate(Address, UriKind.Absolute, out Uri? current)
					? $"{current.Scheme}://{current.Host}{current.AbsolutePath}"
					: string.Empty,
				group = string.Empty
			};
		}
		const string script = """
(() => {
  const visible = node => !!node && node.getClientRects().length > 0
    && getComputedStyle(node).visibility !== 'hidden'
    && getComputedStyle(node).display !== 'none';
  const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const composer = document.querySelector('[current-chat-id]');
  const conversation = composer?.parentElement || null;
  const supportSearch = [...document.querySelectorAll('input,[role="searchbox"]')]
    .filter(visible)
    .find(node => /(?:搜索|请求|search|поиск|обращ)/iu.test(String(
      node.getAttribute('placeholder') || node.getAttribute('aria-label') || ''
    ))) || null;
  const loadingIndicator = /正在加载聊天|загрузка\s+(?:чата|чатов)|loading\s+chat/i.test(bodyText);
  const loadFailed = /无法加载聊天列表|не удалось загрузить список чат|ws1006/i.test(bodyText);
  const emptyConversationVisible = /请选择聊天以开始对话|выберите\s+(?:чат|диалог)|select\s+(?:a\s+)?chat/iu.test(bodyText);
  const conversationListVisible = visible(supportSearch)
    && (/(?:№|#)\s*[0-9]{6,20}/u.test(bodyText) || emptyConversationVisible
      || /(?:聊天室|чаты|chat\s*room)/iu.test(bodyText));
  const url = new URL(location.href);
  const composerVisible = visible(composer);
  const conversationVisible = visible(conversation) || conversationListVisible;
  return JSON.stringify({
    ready: conversationVisible && (composerVisible || conversationListVisible || emptyConversationVisible)
      && !loadingIndicator && !loadFailed,
    pageReady: document.readyState === 'complete',
    conversationVisible,
    composerVisible,
    conversationListVisible,
    emptyConversationVisible,
    loadingIndicator,
    loadFailed,
    page: `${url.origin}${url.pathname}`,
    group: url.searchParams.get('group') || '',
  });
})()
""";
		JsonObject status = await EvaluateJsonAsync(
			script,
			"OZON_SUPPORT_STATUS_FAILED",
			TimeSpan.FromSeconds(10)).ConfigureAwait(continueOnCapturedContext: false);
		return status;
	}

	private async Task<object> OpenOzonSupportFromSellerShellAsync()
	{
		if (!Uri.TryCreate(Address, UriKind.Absolute, out Uri? uri)
			|| !uri.Host.Equals("seller.ozon.ru", StringComparison.OrdinalIgnoreCase))
		{
			throw new InvalidOperationException("OZON_SUPPORT_SELLER_PAGE_REQUIRED");
		}
		const string script = """
(() => {
  const visible = node => !!node && node.getClientRects().length > 0
    && getComputedStyle(node).visibility !== 'hidden'
    && getComputedStyle(node).display !== 'none';
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const candidates = [...document.querySelectorAll('a[href],button,[role="button"]')]
    .filter(visible)
    .map(node => ({ node, rect: node.getBoundingClientRect() }))
    .filter(item => item.rect.top >= 0 && item.rect.top < 160);
  const hrefOf = node => String(
    node.getAttribute('href') || node.closest('a[href]')?.getAttribute('href') || ''
  );
  const labelOf = node => clean(
    node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent
  );
  const supportHref = node => {
    try {
      const url = new URL(hrefOf(node), location.href);
      return /\/app\/messenger(?:[/?#]|$)/i.test(url.pathname)
        && (url.searchParams.get('group') === 'support_v2'
          || url.searchParams.get('channel') === 'SCRM'
          || url.searchParams.get('helpCenter') === 'page');
    } catch { return false; }
  };
  const buyerHref = node => {
    try { return new URL(hrefOf(node), location.href).searchParams.get('group') === 'customers_v2'; }
    catch { return false; }
  };
  const target = candidates.find(({ node }) => supportHref(node))
    || candidates.find(({ node }) => !buyerHref(node) && /(?:客服|支持|帮助中心|support|поддержк)/iu.test(labelOf(node)));
  if (!target) return JSON.stringify({ found: false, x: -1, y: -1 });
  const href = String(target.node.getAttribute('href') || target.node.closest('a[href]')?.getAttribute('href') || '');
  let hrefPath = '';
  let resolvedHref = '';
  try {
    const resolved = new URL(href, location.href);
    hrefPath = resolved.pathname;
    resolvedHref = resolved.href;
  } catch {}
  return JSON.stringify({
    found: true,
    x: target.rect.left + target.rect.width / 2,
    y: target.rect.top + target.rect.height / 2,
    hrefPath,
    href: resolvedHref,
    label: labelOf(target.node).slice(0, 80),
  });
})()
""";
		JsonObject result = await EvaluateJsonAsync(
			script,
			"OZON_SUPPORT_NAVIGATION_FAILED",
			TimeSpan.FromSeconds(10)).ConfigureAwait(continueOnCapturedContext: false);
		if (result["found"]?.GetValue<bool>() != true)
			throw new InvalidOperationException("OZON_SUPPORT_NAVIGATION_CONTROL_NOT_FOUND");
		string supportUrl = result["href"]?.GetValue<string>()?.Trim() ?? string.Empty;
		if (Uri.TryCreate(supportUrl, UriKind.Absolute, out Uri? supportUri)
			&& supportUri.Scheme == Uri.UriSchemeHttps
			&& supportUri.Host.Equals("seller.ozon.ru", StringComparison.OrdinalIgnoreCase)
			&& supportUri.AbsolutePath.StartsWith("/app/messenger", StringComparison.OrdinalIgnoreCase))
		{
			Browser.LoadUrl(supportUrl);
			result["navigated"] = true;
			return result;
		}
		double x = result["x"]?.GetValue<double>() ?? -1;
		double y = result["y"]?.GetValue<double>() ?? -1;
		if (x < 0 || y < 0)
			throw new InvalidOperationException("OZON_SUPPORT_NAVIGATION_CONTROL_NOT_FOUND");
		using DevToolsClient devTools = Browser.GetDevToolsClient();
		await devTools.Input.DispatchMouseEventAsync(
			DispatchMouseEventType.MouseMoved,
			x,
			y,
			button: MouseButton.None,
			buttons: 0,
			clickCount: 0).ConfigureAwait(continueOnCapturedContext: false);
		await devTools.Input.DispatchMouseEventAsync(
			DispatchMouseEventType.MousePressed,
			x,
			y,
			button: MouseButton.Left,
			buttons: 1,
			clickCount: 1).ConfigureAwait(continueOnCapturedContext: false);
		await devTools.Input.DispatchMouseEventAsync(
			DispatchMouseEventType.MouseReleased,
			x,
			y,
			button: MouseButton.Left,
			buttons: 0,
			clickCount: 1).ConfigureAwait(continueOnCapturedContext: false);
		result["clicked"] = true;
		return result;
	}

	private async Task<object> GetOzonLoginStatusAsync()
	{
		string currentUrl = Address;
		if (!Uri.TryCreate(currentUrl, UriKind.Absolute, out Uri? pageUri)
			|| !pageUri.Host.EndsWith("ozon.ru", StringComparison.OrdinalIgnoreCase))
		{
			return new
			{
				loggedIn = false,
				cookieSaved = false,
				verificationOutcome = "pending",
				verificationPending = true,
				cookieCount = 0,
				url = currentUrl,
				verifiedAt = DateTimeOffset.UtcNow.ToString("O")
			};
		}

		ICookieManager cookieManager = await requestContext.GetCookieManagerAsync().ConfigureAwait(continueOnCapturedContext: false);
		IReadOnlyList<CefSharp.Cookie> cookies = cookieManager == null
			? Array.Empty<CefSharp.Cookie>()
			: await cookieManager.VisitUrlCookiesAsync(
				"https://seller.ozon.ru/",
				includeHttpOnly: true).ConfigureAwait(continueOnCapturedContext: false);
		bool hasAuthenticationCookie = cookies.Any(IsOzonAuthenticationCookie);
		bool authenticatedByProbe = false;
		int probeStatus = 0;
		bool explicitLoginPage = IsExplicitPurchaseLoginLocation(pageUri);
		if (cookies.Count > 0)
		{
			try
			{
				using HttpClientHandler handler = new()
				{
					AllowAutoRedirect = false,
					AutomaticDecompression = System.Net.DecompressionMethods.All,
					UseCookies = false
				};
				using HttpClient http = new(handler) { Timeout = TimeSpan.FromSeconds(12.0) };
				using HttpRequestMessage request = new(HttpMethod.Post, "https://seller.ozon.ru/api/user/interface-state");
				request.Headers.Accept.ParseAdd("application/json");
				request.Headers.TryAddWithoutValidation("User-Agent", Profile.UserAgent);
				request.Headers.TryAddWithoutValidation("Accept-Language", Profile.AcceptLanguage);
				request.Headers.TryAddWithoutValidation("Cookie", string.Join("; ", cookies.Select(cookie => cookie.Name + "=" + cookie.Value)));
				request.Headers.Referrer = new Uri("https://seller.ozon.ru/");
				request.Headers.TryAddWithoutValidation("Origin", "https://seller.ozon.ru");
				request.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
				using HttpResponseMessage response = await http.SendAsync(
					request,
					HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(continueOnCapturedContext: false);
				probeStatus = (int)response.StatusCode;
				authenticatedByProbe = response.IsSuccessStatusCode;
			}
			catch { authenticatedByProbe = false; }
		}
		JsonObject pageEvidence = await ReadOzonSellerSessionEvidenceAsync().ConfigureAwait(continueOnCapturedContext: false);
		bool pageLoginRoute = pageEvidence["explicitLoginRoute"]?.GetValue<bool>() == true;
		bool loginControlPresent = pageEvidence["loginControlPresent"]?.GetValue<bool>() == true;
		bool sellerAppShellReady = pageEvidence["sellerAppShellReady"]?.GetValue<bool>() == true;
		bool companyContextReady = pageEvidence["companyContextReady"]?.GetValue<bool>() == true;
		string companyId = JsonScalarText(pageEvidence["companyId"], 200);
		string cookieCompanyId = cookies
			.Where(cookie => string.Equals(cookie.Name, "sc_company_id", StringComparison.OrdinalIgnoreCase))
			.Select(cookie => (cookie.Value ?? string.Empty).Trim())
			.FirstOrDefault(value => value.Length is > 0 and <= 200 && value.All(char.IsDigit))
			?? string.Empty;
		string companyIdentitySource = !string.IsNullOrWhiteSpace(companyId)
			? "seller-page-context"
			: !string.IsNullOrWhiteSpace(cookieCompanyId)
				? "seller-company-cookie"
				: "none";
		if (string.IsNullOrWhiteSpace(companyId))
		{
			companyId = cookieCompanyId;
		}
		companyContextReady = companyContextReady || !string.IsNullOrWhiteSpace(companyId);
		string companyName = JsonScalarText(pageEvidence["companyName"], 300);
		bool liveSellerResponse = pageEvidence["liveSellerResponse"]?.GetValue<bool>() == true;
		bool pageProbeRedirectedToLogin = pageEvidence["pageProbeRedirectedToLogin"]?.GetValue<bool>() == true;
		int pageProbeStatus = pageEvidence["pageProbeStatus"]?.GetValue<int>() ?? 0;
		explicitLoginPage = explicitLoginPage || pageLoginRoute || loginControlPresent || pageProbeRedirectedToLogin;
		bool authenticatedByPageContext = cookies.Count > 0
			&& !explicitLoginPage
			&& (pageProbeStatus is >= 200 and < 300
				|| liveSellerResponse
				|| sellerAppShellReady);
		// Ozon changes internal endpoint headers and methods independently from the
		// visible Seller SPA.  Keep the live interface-state probe as the primary
		// signal, but accept a fully rendered, non-login Seller application session
		// with persisted cookies as the fallback.  A login route/control or a probe
		// redirect to sign-in always wins and prevents stale Cookie reuse.
		bool authenticated = !explicitLoginPage && (authenticatedByProbe || authenticatedByPageContext);
		bool loginRequired = !authenticated && (
			explicitLoginPage
			|| cookies.Count == 0
			|| probeStatus == 401
			|| pageProbeStatus == 401);
		bool verificationPending = !authenticated && !loginRequired;
		string verificationOutcome = authenticated
			? "connected"
			: loginRequired
				? "login-required"
				: "pending";
		bool cookieSaved = false;
		if (authenticated && cookieManager != null && cookies.Count > 0)
		{
			cookieSaved = await cookieManager.FlushStoreAsync().ConfigureAwait(continueOnCapturedContext: false);
		}
		string verificationSource = authenticatedByProbe
			? "interface-state"
			: authenticatedByPageContext
				? pageProbeStatus is >= 200 and < 300
					? "browser-interface-state"
					: liveSellerResponse
						? "seller-live-response"
						: "seller-app-shell"
				: explicitLoginPage
					? "login-page"
					: verificationPending
						? "seller-page-pending"
						: probeStatus > 0 ? "interface-state-rejected" : hasAuthenticationCookie ? "interface-state-unavailable" : "none";
		Console.Error.WriteLine(
			$"[ozon-login] authenticated={authenticated} outcome={verificationOutcome} source={verificationSource} nativeStatus={probeStatus} browserStatus={pageProbeStatus} shell={sellerAppShellReady} company={companyContextReady} companySource={companyIdentitySource} liveResponse={liveSellerResponse} loginPage={explicitLoginPage} cookieCount={cookies.Count}");
		return new
		{
			loggedIn = authenticated,
			cookieSaved = authenticated && cookieSaved,
			verificationOutcome,
			verificationPending,
			cookieCount = cookies.Count,
			authCookiePresent = hasAuthenticationCookie,
			verificationSource,
			probeStatus,
			pageProbeStatus,
			sellerAppShellReady,
			companyContextReady,
			companyId,
			companyIdentitySource,
			companyName,
			liveSellerResponse,
			url = currentUrl,
			verifiedAt = DateTimeOffset.UtcNow.ToString("O")
		};
	}

	private async Task<JsonObject> ReadOzonSellerSessionEvidenceAsync()
	{
		if (!IsOzonSellerPage() || !Browser.CanExecuteJavascriptInMainFrame)
		{
			return new JsonObject();
		}
		for (int attempt = 0; attempt < 3; attempt += 1)
		{
			try
			{
				JsonObject evidence = await EvaluateJsonAsync(
					OzonSellerSessionEvidenceScript,
					"OZON_LOGIN_PAGE_EVIDENCE_FAILED",
					TimeSpan.FromSeconds(8.0)).ConfigureAwait(continueOnCapturedContext: false);
				bool decisive = evidence["explicitLoginRoute"]?.GetValue<bool>() == true
					|| evidence["loginControlPresent"]?.GetValue<bool>() == true
					|| evidence["sellerAppShellReady"]?.GetValue<bool>() == true
					|| evidence["liveSellerResponse"]?.GetValue<bool>() == true
					|| (evidence["pageProbeStatus"]?.GetValue<int>() ?? 0) > 0;
				if (decisive || attempt == 2) return evidence;
			}
			catch (Exception error)
			{
				if (attempt == 2)
				{
					Console.Error.WriteLine($"[ozon-login] page evidence unavailable code={error.Message}");
					return new JsonObject();
				}
			}
			await Task.Delay(250).ConfigureAwait(continueOnCapturedContext: false);
		}
		return new JsonObject();
	}

	private static string JsonScalarText(JsonNode? node, int maxLength)
	{
		if (node is null) return string.Empty;
		string value = string.Empty;
		if (node is JsonValue jsonValue)
		{
			if (jsonValue.TryGetValue<string>(out string? textValue)) value = textValue ?? string.Empty;
			else if (jsonValue.TryGetValue<long>(out long longValue)) value = longValue.ToString();
			else if (jsonValue.TryGetValue<decimal>(out decimal decimalValue)) value = decimalValue.ToString();
			else value = jsonValue.ToString();
		}
		value = value.Trim();
		return value.Length <= maxLength ? value : value[..maxLength];
	}

	private async Task<object> GetPurchaseLoginStatusAsync()
	{
		string currentUrl = Address;
		string platformKey = ResolvePurchaseLoginPlatformKey(Profile.PlatformKey, currentUrl);
		string cookieProbeUrl = PurchaseLoginCookieProbeUrl(platformKey);
		if (cookieProbeUrl.Length == 0)
		{
			return new
			{
				loggedIn = false,
				cookieSaved = false,
				cookieCount = 0,
				platformKey,
				verificationSource = "unsupported-platform",
				url = currentUrl,
				verifiedAt = DateTimeOffset.UtcNow.ToString("O")
			};
		}

		ICookieManager cookieManager = await requestContext.GetCookieManagerAsync().ConfigureAwait(continueOnCapturedContext: false);
		IReadOnlyList<CefSharp.Cookie> cookies = cookieManager == null
			? Array.Empty<CefSharp.Cookie>()
			: await cookieManager.VisitUrlCookiesAsync(
				cookieProbeUrl,
				includeHttpOnly: true).ConfigureAwait(continueOnCapturedContext: false);
		bool strongAuthenticationCookie = HasPurchaseAuthenticationCookies(platformKey, cookies);
		bool explicitLoginPage = Uri.TryCreate(currentUrl, UriKind.Absolute, out Uri? pageUri)
			&& IsExplicitPurchaseLoginLocation(pageUri);
		bool authenticated = strongAuthenticationCookie && !explicitLoginPage;
		bool cookieSaved = authenticated && await FlushPersistentStorageAsync().ConfigureAwait(continueOnCapturedContext: false);
		return new
		{
			loggedIn = authenticated,
			cookieSaved = authenticated && cookieSaved,
			cookieCount = cookies.Count,
			platformKey,
			authCookiePresent = strongAuthenticationCookie,
			verificationSource = authenticated ? "strong-auth-cookie" : explicitLoginPage ? "login-page" : "none",
			url = currentUrl,
			verifiedAt = DateTimeOffset.UtcNow.ToString("O")
		};
	}

	private async Task<object> SeedPurchaseLoginFixtureAsync()
	{
		if (!string.Equals(
			Environment.GetEnvironmentVariable("WANGZAI_PURCHASE_BROWSER_LOGIN_FIXTURE"),
			"1",
			StringComparison.Ordinal)
			|| !string.Equals(Profile.PlatformKey, "1688", StringComparison.OrdinalIgnoreCase))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_LOGIN_FIXTURE_DISABLED");
		}
		ICookieManager cookieManager = await requestContext.GetCookieManagerAsync().ConfigureAwait(continueOnCapturedContext: false);
		if (cookieManager == null) throw new InvalidOperationException("PURCHASE_BROWSER_COOKIE_MANAGER_UNAVAILABLE");
		DateTime expires = DateTime.UtcNow.AddHours(1.0);
		bool identitySaved = await cookieManager.SetCookieAsync(
			"https://www.1688.com/",
			new CefSharp.Cookie
			{
				Name = "unb",
				Value = "fixture-user-1688",
				Domain = ".1688.com",
				Path = "/",
				Secure = true,
				HttpOnly = true,
				Expires = expires
			}).ConfigureAwait(continueOnCapturedContext: false);
		bool sessionSaved = await cookieManager.SetCookieAsync(
			"https://www.1688.com/",
			new CefSharp.Cookie
			{
				Name = "cookie2",
				Value = "fixture-session-1688",
				Domain = ".1688.com",
				Path = "/",
				Secure = true,
				HttpOnly = true,
				Expires = expires
			}).ConfigureAwait(continueOnCapturedContext: false);
		bool flushed = identitySaved && sessionSaved
			&& await cookieManager.FlushStoreAsync().ConfigureAwait(continueOnCapturedContext: false);
		return new { ok = flushed, platformKey = Profile.PlatformKey };
	}

	private static string ResolvePurchaseLoginPlatformKey(string configuredPlatformKey, string currentUrl)
	{
		string normalized = (configuredPlatformKey ?? string.Empty).Trim().ToLowerInvariant();
		if (new[]
		{
			"pinduoduo", "1688", "taobao", "tmall", "ozon-buyer",
			"jd", "wildberries", "amazon", "temu", "aliexpress"
		}.Contains(normalized, StringComparer.Ordinal))
		{
			return normalized;
		}
		if (!Uri.TryCreate(currentUrl, UriKind.Absolute, out Uri? uri)) return normalized;
		string host = uri.Host.ToLowerInvariant();
		if (host.EndsWith("yangkeduo.com", StringComparison.Ordinal)) return "pinduoduo";
		if (host.EndsWith("1688.com", StringComparison.Ordinal)) return "1688";
		if (host.EndsWith("taobao.com", StringComparison.Ordinal)) return "taobao";
		if (host.EndsWith("tmall.com", StringComparison.Ordinal)) return "tmall";
		if (host.EndsWith("ozon.ru", StringComparison.Ordinal)) return "ozon-buyer";
		if (host.EndsWith("jd.com", StringComparison.Ordinal)) return "jd";
		if (host.EndsWith("wildberries.ru", StringComparison.Ordinal)) return "wildberries";
		if (host.Contains("amazon.", StringComparison.Ordinal)) return "amazon";
		if (host.EndsWith("temu.com", StringComparison.Ordinal)) return "temu";
		if (host.EndsWith("aliexpress.com", StringComparison.Ordinal)) return "aliexpress";
		return normalized;
	}

	private static string PurchaseLoginCookieProbeUrl(string platformKey)
	{
		return platformKey switch
		{
			"pinduoduo" => "https://mobile.yangkeduo.com/",
			"1688" => "https://www.1688.com/",
			"taobao" => "https://www.taobao.com/",
			"tmall" => "https://www.tmall.com/",
			"ozon-buyer" => "https://www.ozon.ru/",
			"jd" => "https://www.jd.com/",
			"wildberries" => "https://www.wildberries.ru/",
			"amazon" => "https://www.amazon.com/",
			"temu" => "https://www.temu.com/",
			"aliexpress" => "https://www.aliexpress.com/",
			_ => string.Empty
		};
	}

	private static bool HasPurchaseAuthenticationCookies(string platformKey, IReadOnlyList<CefSharp.Cookie> cookies)
	{
		HashSet<string> names = cookies
			.Select(cookie => (cookie.Name ?? string.Empty).Trim().ToLowerInvariant())
			.Where(name => name.Length > 0)
			.ToHashSet(StringComparer.Ordinal);
		bool Has(params string[] expected) => expected.Any(names.Contains);
		return platformKey switch
		{
			"pinduoduo" => Has("pddaccesstoken", "pdd_access_token", "pdd_user_id", "pdd_user_uin", "pdduid"),
			"1688" => Has("unb", "tracknick") && Has("cookie2", "_tb_token_", "_m_h5_tk", "sgcookie"),
			"taobao" => Has("unb", "tracknick", "lgc", "_nk_") && Has("cookie2", "_tb_token_", "_m_h5_tk", "sgcookie"),
			"tmall" => Has("unb", "tracknick", "lgc", "_nk_") && Has("cookie2", "_tb_token_", "_m_h5_tk", "sgcookie"),
			"ozon-buyer" => Has("__secure-access-token", "__secure-refresh-token", "access-token", "refresh-token"),
			"jd" => Has("pt_key") && Has("pt_pin", "pin"),
			"wildberries" => Has("wbx-validation-key", "wbx-validation-token", "wbx-user-id"),
			"amazon" => names.Any(name => name.StartsWith("at-", StringComparison.Ordinal))
				&& names.Any(name => name.StartsWith("sess-at-", StringComparison.Ordinal)),
			"temu" => Has("access_token", "accesstoken", "temu_access_token", "user_uin"),
			"aliexpress" => Has("xman_t") && Has("acs_usuc_t", "xman_us_t"),
			_ => false
		};
	}

	private static bool IsExplicitPurchaseLoginLocation(Uri pageUri)
	{
		string host = pageUri.Host.ToLowerInvariant();
		string path = pageUri.AbsolutePath.ToLowerInvariant();
		return host.StartsWith("login.", StringComparison.Ordinal)
			|| host.StartsWith("passport.", StringComparison.Ordinal)
			|| host.StartsWith("auth.", StringComparison.Ordinal)
			|| path.Contains("/login", StringComparison.Ordinal)
			|| path.Contains("/signin", StringComparison.Ordinal)
			|| path.Contains("/ap/signin", StringComparison.Ordinal);
	}

	private static bool IsOzonAuthenticationCookie(CefSharp.Cookie cookie)
	{
		string name = cookie.Name ?? string.Empty;
		return name.Equals("__Secure-access-token", StringComparison.OrdinalIgnoreCase)
			|| name.Equals("__Secure-refresh-token", StringComparison.OrdinalIgnoreCase)
			|| name.Equals("__Secure-user-id", StringComparison.OrdinalIgnoreCase)
			|| name.Equals("access-token", StringComparison.OrdinalIgnoreCase)
			|| name.Equals("refresh-token", StringComparison.OrdinalIgnoreCase);
	}

	public void OpenExtensionUi(BrowserExtensionPackage package)
	{
		if (!package.Enabled || string.IsNullOrWhiteSpace(package.UiUrl)
			|| !BrowserUrlPolicy.IsAllowed(package.UiUrl, extensions))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_UI_UNAVAILABLE");
		}
		Browser.LoadUrl(package.UiUrl);
	}

	private async Task<object> InspectAsync()
	{
		DateTimeOffset contextDeadline = DateTimeOffset.UtcNow.AddSeconds(12.0);
		while (!Browser.CanExecuteJavascriptInMainFrame && DateTimeOffset.UtcNow < contextDeadline)
		{
			if (disposed)
			{
				throw new ObjectDisposedException(nameof(BrowserSession));
			}
			await Task.Delay(100).ConfigureAwait(continueOnCapturedContext: false);
		}
		if (!Browser.CanExecuteJavascriptInMainFrame)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY");
		}
		JavascriptResponse javascriptResponse;
		try
		{
			// Structured marketplace readers may wait for the page's own data API
			// (Taobao/Tmall MTOP or Ozon composer). Resolve the returned Promise
			// instead of treating the Promise object itself as an empty capture.
			javascriptResponse = await Browser.EvaluateScriptAsPromiseAsync(
				$"return ({PurchaseCaptureScript.Value});",
				TimeSpan.FromSeconds(20.0)).ConfigureAwait(continueOnCapturedContext: false);
		}
		catch (TaskCanceledException error)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY", error);
		}
		if (!javascriptResponse.Success || !(javascriptResponse.Result is string json))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CAPTURE_EMPTY");
		}
		return JsonNode.Parse(json) ?? new JsonObject();
	}

	private async Task<object> InspectPinduoduoOrderAsync()
	{
		DateTimeOffset contextDeadline = DateTimeOffset.UtcNow.AddSeconds(3.0);
		while (!Browser.CanExecuteJavascriptInMainFrame && DateTimeOffset.UtcNow < contextDeadline)
		{
			if (disposed) throw new ObjectDisposedException(nameof(BrowserSession));
			await Task.Delay(50).ConfigureAwait(continueOnCapturedContext: false);
		}
		if (!Browser.CanExecuteJavascriptInMainFrame)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY");
		}
		JavascriptResponse response;
		try
		{
			response = await Browser.EvaluateScriptAsPromiseAsync(
				$"return ({PinduoduoOrderCaptureScript.Value});",
				TimeSpan.FromSeconds(5.0)).ConfigureAwait(continueOnCapturedContext: false);
		}
		catch (TaskCanceledException error)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY", error);
		}
		if (!response.Success || !(response.Result is string json))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CAPTURE_EMPTY");
		}
		return JsonNode.Parse(json) ?? new JsonObject();
	}

	private async Task<object> InspectAlibaba1688OrderAsync()
	{
		JsonObject? frameEvidence = null;
		try
		{
			JsonObject frameResult = await InspectAlibaba1688OrderFramesAsync()
				.ConfigureAwait(continueOnCapturedContext: false);
			frameEvidence = frameResult;
			ApplyCurrentAlibabaRefundEvidence(frameResult, frameResult);
			if (HasCompleteAlibabaOrderCandidate(frameResult))
			{
				JsonArray frameOrders = (JsonArray)frameResult["orderCandidates"]!;
				Console.Error.WriteLine($"[purchase-browser-1688] all-frame capture completed orders={frameOrders.Count}");
				return PreferCurrentAlibabaOrder(frameResult);
			}
		}
		catch (Exception error)
		{
			Console.Error.WriteLine(
				$"[purchase-browser-1688] all-frame capture unavailable code={ErrorCode.From(error)}");
		}

		try
		{
			string expectedOrderNumber = ResolveAlibaba1688ExpectedOrderNumber(frameEvidence);
			JsonObject networkResult = await owner.CaptureAlibaba1688OrdersAsync(
				Profile,
				requestContext,
				ResolveAlibaba1688NetworkCaptureUrl(frameEvidence),
				expectedOrderNumber)
				.ConfigureAwait(continueOnCapturedContext: false);
			if (frameEvidence != null) ApplyCurrentAlibabaRefundEvidence(networkResult, frameEvidence);
			return PreferCurrentAlibabaOrder(networkResult);
		}
		catch (Exception error)
		{
			Console.Error.WriteLine(
				$"[purchase-browser-1688] network capture unavailable code={ErrorCode.From(error)}");
			throw new InvalidOperationException("PURCHASE_BROWSER_CAPTURE_EMPTY", error);
		}
	}

	private static bool HasCompleteAlibabaOrderCandidate(JsonObject capture)
	{
		if (capture["orderCandidates"] is not JsonArray candidates || candidates.Count == 0) return false;
		return candidates.OfType<JsonObject>().Any(order =>
		{
			string orderNumber = order["purchaseOrderNumber"]?.ToString()?.Trim() ?? string.Empty;
			string status = order["purchaseOrderStatus"]?.ToString()?.Trim() ?? string.Empty;
			string amount = order["purchasePrice"]?.ToString()?.Trim() ?? string.Empty;
			return Regex.IsMatch(orderNumber, @"^\d{12,30}$", RegexOptions.CultureInvariant)
				&& !string.IsNullOrWhiteSpace(status)
				&& double.TryParse(amount, NumberStyles.Float, CultureInfo.InvariantCulture, out double value)
				&& double.IsFinite(value)
				&& value > 0;
		});
	}

	private string ResolveAlibaba1688NetworkCaptureUrl(JsonObject? frameEvidence)
	{
		string status = frameEvidence?["pageOrderStatus"]?.ToString()?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(status)
			&& frameEvidence?["orderCandidates"] is JsonArray candidates)
		{
			status = candidates.OfType<JsonObject>()
				.Select(order => order["purchaseOrderStatus"]?.ToString()?.Trim() ?? string.Empty)
				.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? string.Empty;
		}

		string statusHint = status switch
		{
			string value when Regex.IsMatch(value, @"待付款|等待付款", RegexOptions.CultureInvariant) => "waitbuyerpay",
			string value when Regex.IsMatch(value, @"买家已付款|已付款|待发货|等待卖家发货|等待商家发货", RegexOptions.CultureInvariant) => "waitsellersend",
			string value when Regex.IsMatch(value, @"已发货|待收货|等待买家收货", RegexOptions.CultureInvariant) => "waitbuyerreceive",
			string value when Regex.IsMatch(value, @"交易成功|已完成", RegexOptions.CultureInvariant) => "success",
			string value when Regex.IsMatch(value, @"交易关闭|订单关闭|已关闭|已取消|交易取消", RegexOptions.CultureInvariant) => "cancel",
			_ => "all"
		};
		return Alibaba1688OrderNetworkCapture.BuildOrderListUrl(statusHint);
	}

	private string ResolveAlibaba1688ExpectedOrderNumber(JsonObject? frameEvidence)
	{
		string orderNumber = frameEvidence?["currentOrderNumber"]?.ToString()?.Trim() ?? string.Empty;
		if (Regex.IsMatch(orderNumber, @"^\d{12,30}$", RegexOptions.CultureInvariant)) return orderNumber;

		string address = Browser.Address ?? Address ?? string.Empty;
		Match match = Regex.Match(
			address,
			@"(?:[?&](?:orderId|order_id)=)(\d{12,30})",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
		return match.Success ? match.Groups[1].Value : string.Empty;
	}

	private void ApplyCurrentAlibabaRefundEvidence(JsonObject capture, JsonObject evidence)
	{
		string address = Browser.Address ?? Address ?? string.Empty;
		Match match = Regex.Match(
			address,
			@"(?:[?&](?:orderId|order_id)=)(\d{8,})",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
		string refundStatus = evidence["pageRefundStatus"]?.GetValue<string>()?.Trim() ?? string.Empty;
		string expectedOrderNumber = match.Success
			? match.Groups[1].Value
			: evidence["currentOrderNumber"]?.ToString()?.Trim() ?? string.Empty;
		if (!Regex.IsMatch(expectedOrderNumber, @"^\d{12,30}$", RegexOptions.CultureInvariant)
			|| !Regex.IsMatch(
			refundStatus,
			@"^(?:极速退款成功|退款成功|已退款|退款完成)$",
			RegexOptions.CultureInvariant)) return;
		if (capture["orderCandidates"] is not JsonArray candidates) return;
		JsonObject? exact = candidates
			.OfType<JsonObject>()
			.FirstOrDefault(order => string.Equals(
				order["purchaseOrderNumber"]?.GetValue<string>(),
				expectedOrderNumber,
				StringComparison.Ordinal));
		if (exact == null) return;

		exact["purchaseOrderStatus"] = refundStatus;
		exact["orderStatus"] = refundStatus;
		exact["statusText"] = refundStatus;
		exact["status"] = refundStatus;
		exact["paymentConfirmed"] = false;
		exact["refundConfirmed"] = true;
		capture["pageRefundStatus"] = refundStatus;
	}

	private JsonObject PreferCurrentAlibabaOrder(JsonObject capture)
	{
		string address = Browser.Address ?? Address ?? string.Empty;
		Match match = Regex.Match(
			address,
			@"(?:[?&](?:orderId|order_id)=)(\d{8,})",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
		if (capture["orderCandidates"] is not JsonArray candidates)
		{
			return capture;
		}

		string expectedOrderNumber = match.Success
			? match.Groups[1].Value
			: capture["currentOrderNumber"]?.ToString()?.Trim() ?? string.Empty;
		if (!Regex.IsMatch(expectedOrderNumber, @"^\d{12,30}$", RegexOptions.CultureInvariant)) return capture;
		JsonObject? exact = candidates
			.OfType<JsonObject>()
			.FirstOrDefault(order => string.Equals(
				order["purchaseOrderNumber"]?.GetValue<string>(),
				expectedOrderNumber,
				StringComparison.Ordinal));
		if (exact == null)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_1688_ORDER_NOT_FOUND");
		}
		capture["orderCandidates"] = new JsonArray(exact.DeepClone());
		capture["currentOrderNumber"] = expectedOrderNumber;
		return capture;
	}

	private async Task<JsonObject> InspectAlibaba1688OrderFramesAsync()
	{
		DateTimeOffset contextDeadline = DateTimeOffset.UtcNow.AddSeconds(3.0);
		while (!Browser.CanExecuteJavascriptInMainFrame && DateTimeOffset.UtcNow < contextDeadline)
		{
			if (disposed) throw new ObjectDisposedException(nameof(BrowserSession));
			await Task.Delay(50).ConfigureAwait(continueOnCapturedContext: false);
		}
		if (!Browser.CanExecuteJavascriptInMainFrame)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY");
		}

		IBrowser cefBrowser = Browser.GetBrowser();
		IReadOnlyCollection<IFrame> frames = cefBrowser.GetAllFrames();
		Task<JsonObject?>[] inspections = frames
			.Select(InspectFrameAsync)
			.ToArray();
		JsonObject?[] results = await Task.WhenAll(inspections)
			.ConfigureAwait(continueOnCapturedContext: false);

		JsonObject? envelope = results.FirstOrDefault(result => result != null);
		string currentOrderNumber = results
			.Select(result => result?["currentOrderNumber"]?.ToString()?.Trim() ?? string.Empty)
			.FirstOrDefault(value => Regex.IsMatch(value, @"^\d{12,30}$", RegexOptions.CultureInvariant))
			?? string.Empty;
		string pageRefundStatus = results
			.Select(result => result?["pageRefundStatus"]?.GetValue<string>()?.Trim() ?? string.Empty)
			.FirstOrDefault(value => Regex.IsMatch(
				value,
				@"^(?:极速退款成功|退款成功|已退款|退款完成)$",
				RegexOptions.CultureInvariant)) ?? string.Empty;
		JsonArray merged = new();
		HashSet<string> seen = new(StringComparer.Ordinal);
		foreach (JsonObject? result in results)
		{
			if (result?["orderCandidates"] is not JsonArray candidates) continue;
			foreach (JsonNode? candidate in candidates)
			{
				if (candidate is not JsonObject order) continue;
				string key = order["purchaseOrderNumber"]?.ToString()
					?? order["orderNumber"]?.ToString()
					?? order.ToJsonString();
				if (seen.Add(key)) merged.Add(order.DeepClone());
			}
		}
		if (merged.Count == 0
			&& string.IsNullOrWhiteSpace(pageRefundStatus)
			&& string.IsNullOrWhiteSpace(currentOrderNumber))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CAPTURE_EMPTY");
		}

		JsonObject output = envelope?.DeepClone() as JsonObject ?? new JsonObject();
		output["runtimeKind"] = "builtin-all-frame";
		output["sourceMethod"] = "1688-all-frame-dom";
		output["orderCandidates"] = merged;
		if (!string.IsNullOrWhiteSpace(currentOrderNumber)) output["currentOrderNumber"] = currentOrderNumber;
		if (!string.IsNullOrWhiteSpace(pageRefundStatus)) output["pageRefundStatus"] = pageRefundStatus;
		return output;

		async Task<JsonObject?> InspectFrameAsync(IFrame frame)
		{
			try
			{
				if (!frame.IsValid) return null;
				JavascriptResponse response = await frame.EvaluateScriptAsync(
					Alibaba1688OrderCaptureScript.Value,
					timeout: TimeSpan.FromSeconds(5.0)).ConfigureAwait(continueOnCapturedContext: false);
				JsonObject? result = response.Success && response.Result is string json
					? JsonNode.Parse(json) as JsonObject
					: null;
				string frameText = await frame.GetTextAsync().ConfigureAwait(continueOnCapturedContext: false);
				if (Alibaba1688OrderNetworkParser.TryParseVisibleOrderText(
					frameText,
					frame.Url ?? Browser.Address ?? Address,
					out JsonObject? textResult)
					&& textResult != null
					&& (result == null || !HasCompleteAlibabaOrderCandidate(result)))
				{
					result = textResult;
				}
				string knownRefund = result?["pageRefundStatus"]?.GetValue<string>()?.Trim() ?? string.Empty;
				if (string.IsNullOrWhiteSpace(knownRefund))
				{
					// 1688 新详情页的订单正文可能由隔离运行时渲染，普通 DOM
					// JavaScript 看不到商品行；CEF 的 frame text 仍能读到用户实际
					// 看到的“退款成功”。只提取明确成功词，不返回或落盘整页文本。
					Match refundMatch = Regex.Match(
						frameText ?? string.Empty,
						@"极速退款成功|退款成功|已退款|退款完成",
						RegexOptions.CultureInvariant);
					if (refundMatch.Success)
					{
						result ??= new JsonObject();
						result["pageRefundStatus"] = refundMatch.Value;
					}
				}
				return result;
			}
			catch
			{
				return null;
			}
			finally
			{
				frame.Dispose();
			}
		}
	}

	private async Task<object> ExecuteFixtureAsync(JsonObject? task)
	{
		if (task == null)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_TASK_CONTEXT_REQUIRED");
		}
		string text = task.ToJsonString();
		string script = "(async () => {\n  if (!document.querySelector('meta[name=\"wangzai-purchase-fixture\"][content=\"v1\"]')) throw new Error('PURCHASE_BROWSER_REAL_SITE_EXECUTION_DISABLED');\n  const task = " + text + ";\n  const set = (name, value) => { const element = document.querySelector(`[data-wangzai-field=\"${name}\"]`); if (!element) throw new Error('PURCHASE_BROWSER_FIXTURE_FIELD_MISSING'); element.value = String(value ?? ''); element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true})); };\n  for (const key of ['taskId','attemptId','productTitle','variant','quantity','address']) set(key, task[key]);\n  set('amount', task.expectedAmount);\n  const button = document.querySelector('[data-wangzai-action=\"submit\"]'); if (!button) throw new Error('PURCHASE_BROWSER_FIXTURE_SUBMIT_MISSING'); button.click();\n  const deadline = Date.now() + 6000;\n  while (Date.now() < deadline) { const receipt = document.querySelector('[data-wangzai-receipt-ready=\"true\"]'); if (receipt) return JSON.stringify({ orderNumber: receipt.getAttribute('data-wangzai-receipt-order'), amount: receipt.getAttribute('data-wangzai-receipt-amount'), status: receipt.getAttribute('data-wangzai-receipt-status'), pageUrl: location.href }); await new Promise(resolve => setTimeout(resolve, 50)); }\n  throw new Error('PURCHASE_BROWSER_FIXTURE_RECEIPT_TIMEOUT');\n})()";
		JavascriptResponse javascriptResponse = await Browser.EvaluateScriptAsync(script, TimeSpan.FromSeconds(10.0)).ConfigureAwait(continueOnCapturedContext: false);
		if (!javascriptResponse.Success || !(javascriptResponse.Result is string json))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_FIXTURE_RECEIPT_TIMEOUT");
		}
		return JsonNode.Parse(json) ?? new JsonObject();
	}

	public void Dispose()
	{
		if (!disposed)
		{
			navigationReadiness.Close();
			disposed = true;
			enforcedZoomTimer.Dispose();
			automaticCrossBorderTimer.Dispose();
			crossBorder.Dispose();
			Browser.Dispose();
		}
	}
}

