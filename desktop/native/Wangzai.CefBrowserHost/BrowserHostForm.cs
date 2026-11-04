using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using CefSharp;
using CefSharp.WinForms;

namespace Wangzai.CefBrowserHost;

internal sealed partial class BrowserHostForm : Form
{
	private const string MinimizeGlyph = "\uE921";

	private const string MaximizeGlyph = "\uE922";

	private const string RestoreGlyph = "\uE923";

	private const string CloseGlyph = "\uE8BB";

	private const string BackGlyph = "\uE72B";

	private const string ForwardGlyph = "\uE72A";

	private const string ReloadGlyph = "\uE72C";

	private const string StopGlyph = "\uE71A";

	private readonly Dictionary<string, BrowserSession> sessions = new Dictionary<string, BrowserSession>(StringComparer.Ordinal);
	private readonly Dictionary<string, SharedRequestContext> requestContexts = new Dictionary<string, SharedRequestContext>(StringComparer.Ordinal);
	private readonly BrowserPendingLaunches pendingLaunches = new();
	private volatile bool shutdownRequested;
	private readonly Dictionary<string, JsonObject?> workbenchPresentations = new Dictionary<string, JsonObject?>(StringComparer.Ordinal);

	private sealed class SharedRequestContext
	{
		public SharedRequestContext(RequestContext context, BrowserRequestContextPreferences preferences)
		{
			Context = context;
			Preferences = preferences;
			References = 1;
		}

		public RequestContext Context { get; }
		public BrowserRequestContextPreferences Preferences { get; }
		public int References { get; set; }
	}

	private sealed class HiddenBrowserSurface : Form
	{
		private const int WsExNoActivate = 0x08000000;
		private const int WsExToolWindow = 0x00000080;

		public HiddenBrowserSurface()
		{
			FormBorderStyle = FormBorderStyle.None;
			ShowInTaskbar = false;
			StartPosition = FormStartPosition.Manual;
			Location = new Point(-32000, -32000);
			Size = new Size(1024, 768);
			Text = string.Empty;
		}

		protected override bool ShowWithoutActivation => true;

		protected override CreateParams CreateParams
		{
			get
			{
				CreateParams parameters = base.CreateParams;
				parameters.ExStyle |= WsExNoActivate | WsExToolWindow;
				return parameters;
			}
		}
	}

	private readonly Panel browserPanel = new Panel
	{
		Dock = DockStyle.Fill,
		BackColor = Color.White
	};

	private readonly PurchaseOrderWorkbenchPanel workbenchPanel = new();

	private readonly TextBox addressBox = new TextBox
	{
		BorderStyle = BorderStyle.None,
		Font = new Font("Microsoft YaHei UI", 10.5f)
	};

	private readonly Label titleLabel = new Label
	{
		AutoEllipsis = true,
		ForeColor = Color.FromArgb(42, 53, 71),
		Font = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Bold)
	};

	private readonly Label accountLabel = new Label
	{
		AutoEllipsis = true,
		ForeColor = Color.FromArgb(105, 119, 143),
		Font = new Font("Microsoft YaHei UI", 9f)
	};

	private readonly Button backButton;

	private readonly Button forwardButton;

	private readonly Button reloadButton;

	private readonly Button maximizeButton;
	private readonly Button purchaseLoginSaveButton;
	private readonly Button crossBorderChargeSaveButton;
	private readonly FlowLayoutPanel pinduoduoShortcutGroup;
	private readonly Panel titleBarPanel;
	private readonly Panel navigationPanel;
	private readonly FlowLayoutPanel actionToolbarPanel;
	private readonly BrowserExtensionPackageManager extensions;
	private readonly IReadOnlyDictionary<string, BrowserExtensionPackage> loadedExtensions;
	private bool compactStandaloneMode;
	private readonly Label downloadStatusLabel = new()
	{
		AutoSize = true,
		Visible = false,
		ForeColor = Color.FromArgb(76, 94, 122),
		Font = new Font("Microsoft YaHei UI", 9f),
		Padding = new Padding(8, 7, 0, 0),
		Cursor = Cursors.Hand
	};
	private readonly Label actionStatusLabel = new()
	{
		AutoSize = false,
		AutoEllipsis = true,
		Visible = false,
		Size = new Size(250, 32),
		TextAlign = ContentAlignment.MiddleLeft,
		ForeColor = Color.FromArgb(15, 118, 93),
		BackColor = Color.FromArgb(236, 253, 245),
		Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold),
		Padding = new Padding(10, 0, 10, 0),
		Margin = new Padding(8, 0, 0, 0)
	};
	private readonly System.Windows.Forms.Timer actionStatusTimer = new()
	{
		Interval = 5000
	};
	private string completedDownloadPath = string.Empty;

	private readonly System.Windows.Forms.Timer addressDebounce = new System.Windows.Forms.Timer
	{
		Interval = 120
	};

	private ProtocolServer? protocol;

	private string activeOwnerRef = string.Empty;
	private string followSellerVerificationObservationOwnerRef = string.Empty;
	private long followSellerVerificationPresentationGeneration;

	private Rectangle lastBounds = new Rectangle(120, 100, 1280, 800);

	private bool closingForShutdown;

	private bool applyingBounds;

	private bool hasUserBounds;

	private bool customMaximized;
	private bool embeddedMode;
	private IntPtr parentHwnd = IntPtr.Zero;
	private bool topLevelStyleCaptured;
	private long topLevelWindowStyle;
	private bool browserPresentationVisible;
	private bool hostActionInFlight;
	private BrowserExtensionManagerForm? extensionManagerForm;
	private long latestVisibilityVersion;
	private long hiddenVisibilityFence;

	private sealed class NativeChildWindowSnapshot
	{
		public string Hwnd { get; init; } = "0";
		public string ParentHwnd { get; init; } = "0";
		public string ClassName { get; init; } = string.Empty;
		public bool Visible { get; init; }
		public bool OnScreen { get; init; }
		public object Bounds { get; init; } = new { x = 0, y = 0, width = 0, height = 0 };
	}

	private BrowserSession? Active
	{
		get
		{
			if (!sessions.TryGetValue(activeOwnerRef, out var value))
			{
				return null;
			}
			return value;
		}
	}

	public BrowserHostForm(BrowserExtensionPackageManager extensions)
	{
		this.extensions = extensions;
		loadedExtensions = extensions.List()
			.Where(package => package.Enabled && package.CanLoad && extensions.IsEnabledExtensionId(package.Id))
			.ToDictionary(static package => package.Id, StringComparer.OrdinalIgnoreCase);
		Text = "旺崽采购浏览器";
		base.AutoScaleMode = AutoScaleMode.Dpi;
		base.StartPosition = FormStartPosition.Manual;
		base.FormBorderStyle = FormBorderStyle.None;
		BackColor = Color.FromArgb(174, 184, 199);
		base.Padding = new Padding(1);
		// The order workbench keeps a readable fixed information rail while the
		// purchase page retains a real interactive browser viewport.
		MinimumSize = new Size(1240, 720);
		// Keep this property stable for the complete lifetime of the CEF host.
		// WinForms recreates the top-level HWND when ShowInTaskbar changes; doing
		// that while Chromium owns child HWNDs can terminate the native process.
		// Hidden/embedded taskbar visibility is controlled by Win32 extended
		// styles in ApplyTaskbarVisibility instead of recreating this Form.
		base.ShowInTaskbar = true;
		base.KeyPreview = true;
		base.Opacity = 0.0;
		titleBarPanel = new Panel
		{
			Dock = DockStyle.Top,
			BackColor = Color.White,
			Padding = new Padding(14, 8, 8, 7)
		};
		Label value = new Label
		{
			Text = "旺",
			TextAlign = ContentAlignment.MiddleCenter,
			ForeColor = Color.White,
			BackColor = Color.FromArgb(93, 135, 255),
			Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold),
			Location = new Point(14, 8),
			Size = new Size(32, 32)
		};
		titleLabel.Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold);
		int titleLineHeight = MeasureLineHeight(titleLabel.Font) + 4;
		int accountLineHeight = MeasureLineHeight(accountLabel.Font) + 3;
		titleBarPanel.Height = Math.Max(66, titleBarPanel.Padding.Vertical + titleLineHeight + accountLineHeight);
		titleLabel.Location = new Point(57, 8);
		titleLabel.Size = new Size(520, titleLineHeight);
		titleLabel.Text = "采购平台";
		accountLabel.Location = new Point(57, 8 + titleLineHeight);
		accountLabel.Size = new Size(520, accountLineHeight);
		accountLabel.Text = "原生 CEF · 独立账号环境";
		value.Location = new Point(14, Math.Max(8, (titleBarPanel.Height - value.Height) / 2));
		Button minimizeButton = WindowButton(MinimizeGlyph, Color.FromArgb(225, 230, 238), delegate
		{
			base.WindowState = FormWindowState.Minimized;
		});
		maximizeButton = WindowButton(MaximizeGlyph, Color.FromArgb(225, 230, 238), delegate
		{
			ToggleMaximize();
		});
		Button closeButton = WindowButton(CloseGlyph, Color.FromArgb(225, 75, 75), delegate
		{
			Close();
		}, danger: true);
		minimizeButton.Dock = DockStyle.Right;
		maximizeButton.Dock = DockStyle.Right;
		closeButton.Dock = DockStyle.Right;
		titleBarPanel.Controls.Add(minimizeButton);
		titleBarPanel.Controls.Add(maximizeButton);
		titleBarPanel.Controls.Add(closeButton);
		titleBarPanel.Controls.Add(accountLabel);
		titleBarPanel.Controls.Add(titleLabel);
		titleBarPanel.Controls.Add(value);
		titleBarPanel.MouseDown += DragWindow;
		titleLabel.MouseDown += DragWindow;
		accountLabel.MouseDown += DragWindow;
		navigationPanel = new Panel
		{
			Dock = DockStyle.Top,
			BackColor = Color.FromArgb(247, 249, 253),
			Padding = new Padding(12, 8, 12, 8)
		};
		backButton = ToolbarButton(BackGlyph, delegate
		{
			Active?.Browser.Back();
		});
		forwardButton = ToolbarButton(ForwardGlyph, delegate
		{
			Active?.Browser.Forward();
		});
		reloadButton = ToolbarButton(ReloadGlyph, delegate
		{
			Active?.Browser.Reload(ignoreCache: false);
		});
		backButton.Dock = DockStyle.Left;
		forwardButton.Dock = DockStyle.Left;
		reloadButton.Dock = DockStyle.Left;
		Panel panel3 = new Panel
		{
			Dock = DockStyle.Fill,
			BackColor = Color.White,
			MinimumSize = new Size(520, 36),
			Padding = new Padding(12, 5, 12, 5)
		};
		addressBox.Font = new Font("Microsoft YaHei UI", 10.5f);
		int addressLineHeight = MeasureLineHeight(addressBox.Font) + 8;
		navigationPanel.Height = Math.Max(56, navigationPanel.Padding.Vertical + addressLineHeight);
		panel3.MinimumSize = new Size(520, addressLineHeight);
		addressBox.MinimumSize = new Size(480, addressLineHeight);
		addressBox.Dock = DockStyle.Fill;
		addressBox.KeyDown += delegate(object? _, KeyEventArgs e)
		{
			if (e.KeyCode == Keys.Return)
			{
				e.SuppressKeyPress = true;
				NavigateFromAddress();
			}
		};
		panel3.Controls.Add(addressBox);
		navigationPanel.Controls.Add(panel3);
		navigationPanel.Controls.Add(reloadButton);
		navigationPanel.Controls.Add(forwardButton);
		navigationPanel.Controls.Add(backButton);
		actionToolbarPanel = new FlowLayoutPanel
		{
			Dock = DockStyle.Top,
			BackColor = Color.White,
			Padding = new Padding(8, 5, 8, 5),
			WrapContents = false,
			FlowDirection = FlowDirection.LeftToRight
		};
		Button collectionPricingButton = ActionButton("采集到操作台", "collection-pricing-capture");
		purchaseLoginSaveButton = ActionButton("保存账号", "purchase-login-save");
		Button captureButton = ActionButton("捕捉采购信息", "capture-purchase");
		Button targetButton = ActionButton("目标订单", "target-mode");
		Button crossBorderButton = ActionButton("实际扣费", "cross-border-charges-open");
		crossBorderChargeSaveButton = ActionButton("保存生效", "cross-border-charges-save");
		Button accountStatusButton = ActionButton("账号状态", "account-status");
		Button extensionButton = LocalActionButton("浏览器插件", OpenExtensionManager);
		FlowLayoutPanel collectionGroup = ToolbarActionGroup(
			"采集",
			Color.FromArgb(64, 105, 225),
			collectionPricingButton);
		FlowLayoutPanel orderGroup = ToolbarActionGroup(
			"订单",
			Color.FromArgb(124, 86, 210),
			captureButton,
			targetButton);
		FlowLayoutPanel crossBorderGroup = ToolbarActionGroup(
			"跨境",
			Color.FromArgb(12, 139, 133),
			crossBorderButton,
			crossBorderChargeSaveButton);
		FlowLayoutPanel accountGroup = ToolbarActionGroup(
			"账号",
			Color.FromArgb(79, 94, 117),
			purchaseLoginSaveButton,
			accountStatusButton,
			extensionButton);
		pinduoduoShortcutGroup = ToolbarActionGroup(
			"拼多多",
			Color.FromArgb(217, 70, 70),
			LocalActionButton("首页", () => NavigatePinduoduo("/")),
			LocalActionButton("个人中心", () => NavigatePinduoduo("/personal.html")),
			LocalActionButton("我的订单", () => NavigatePinduoduo("/orders.html")),
			LocalActionButton("收货地址", () => NavigatePinduoduo("/addresses.html")));
		pinduoduoShortcutGroup.Visible = false;
		actionToolbarPanel.Controls.Add(collectionGroup);
		actionToolbarPanel.Controls.Add(orderGroup);
		actionToolbarPanel.Controls.Add(crossBorderGroup);
		actionToolbarPanel.Controls.Add(accountGroup);
		actionToolbarPanel.Controls.Add(pinduoduoShortcutGroup);
		actionToolbarPanel.Controls.Add(actionStatusLabel);
		actionToolbarPanel.Controls.Add(downloadStatusLabel);
		actionToolbarPanel.Height = actionToolbarPanel.Padding.Vertical + new[]
		{
			collectionGroup,
			orderGroup,
			crossBorderGroup,
			accountGroup,
			pinduoduoShortcutGroup
		}.Max(group => group.PreferredSize.Height) + 2;
		downloadStatusLabel.Click += delegate
		{
			if (string.IsNullOrWhiteSpace(completedDownloadPath)) return;
			try
			{
				System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe", $"/select,\"{completedDownloadPath}\"")
				{
					UseShellExecute = true
				});
			}
			catch { }
		};
		actionStatusTimer.Tick += delegate
		{
			actionStatusTimer.Stop();
			actionStatusLabel.Visible = false;
		};
		Panel workspacePanel = new Panel
		{
			Dock = DockStyle.Fill,
			BackColor = Color.White
		};
		workspacePanel.Controls.Add(browserPanel);
		workspacePanel.Controls.Add(workbenchPanel);
		base.Controls.Add(workspacePanel);
		base.Controls.Add(actionToolbarPanel);
		base.Controls.Add(navigationPanel);
		base.Controls.Add(titleBarPanel);
		base.FormClosing += delegate(object? _, FormClosingEventArgs e)
		{
			if (!closingForShutdown)
			{
				e.Cancel = true;
				_ = Active?.FlushPersistentStorageAsync();
				if (followSellerVerificationObservationOwnerRef.Length > 0)
				{
					HideFollowSellerVerificationSurface(followSellerVerificationObservationOwnerRef, fenceVisibility: true);
				}
				else
				{
					HideBrowser();
				}
				EmitEvent(activeOwnerRef, "window-hidden", Active?.State());
			}
		};
		base.Shown += delegate
		{
			int value2 = 2;
			NativeMethods.DwmSetWindowAttribute(base.Handle, 33, ref value2, 4);
			base.MaximizedBounds = WorkingAreaBounds();
			if (Active == null || Active.Profile.Background)
			{
				BeginInvoke(delegate { HideBrowser(fenceVisibility: false); });
			}
		};
		base.Move += delegate
		{
			RememberUserBounds();
		};
		base.ResizeEnd += delegate
		{
			RememberUserBounds();
		};
		base.Resize += delegate
		{
			if (!embeddedMode && base.WindowState == FormWindowState.Maximized)
			{
				customMaximized = true;
				applyingBounds = true;
				try
				{
					base.WindowState = FormWindowState.Normal;
					base.Bounds = WorkingAreaBounds();
				}
				finally
				{
					applyingBounds = false;
				}
			}
			maximizeButton.Text = customMaximized ? RestoreGlyph : MaximizeGlyph;
		};
	}

	public void BindProtocol(ProtocolServer value)
	{
		protocol = value;
	}

	public Task<object?> ExecuteAsync(string command, JsonObject payload)
	{
		if (command == "shutdown")
		{
			return ShutdownSessionsAsync();
		}
		if (command == "launch")
		{
			return LaunchAsync(payload);
		}
		string ownerRef = BrowserProfile.Required(payload, "ownerRef", 64);
		if (command is "close" or "force-close") return CloseOwnerAsync(ownerRef, command == "force-close");
		if (!sessions.TryGetValue(ownerRef, out var session))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_NOT_FOUND");
		}
		switch (command)
		{
		case "bounds":
			return UiAsync<object?>(() => ApplyBounds(
				ownerRef,
				(payload["bounds"] as JsonObject) ?? payload,
				LongInteger(payload, "visibilityVersion", 0)));
		case "workbench":
			return UiAsync<object?>(() => ApplyWorkbench(ownerRef, payload["workbench"] as JsonObject));
		case "parent":
			return UiAsync<object?>(delegate
			{
				ApplyParentWindow(
					payload,
					applyNativeMode: embeddedMode
						&& activeOwnerRef.Equals(ownerRef, StringComparison.Ordinal));
				return session.State();
			});
		case "show-follow-seller-quick-browser":
			return ShowFollowSellerQuickBrowserAsync(ownerRef);
		case "show-follow-seller-verification-browser":
			return ShowFollowSellerVerificationBrowserAsync(ownerRef);
		case "hide-follow-seller-verification-browser":
			return HideFollowSellerVerificationBrowserAsync(ownerRef);
		case "open-extension-manager":
			return UiAsync<object?>(delegate
			{
				OpenExtensionManager();
				return session.State();
			});
		default:
			return session.ExecuteAsync(command, payload);
		}
	}

	private Task<object?> ShowFollowSellerVerificationBrowserAsync(string ownerRef)
	{
		return UiAsync<object?>(delegate
		{
			if (!sessions.TryGetValue(ownerRef, out var session)
				|| !session.Profile.Background
				|| !session.Profile.BrowserRole.Equals("follow-seller-collector", StringComparison.Ordinal)
				|| !IsQuickComplaintOzonUrl(session.Address ?? string.Empty))
			{
				throw new InvalidOperationException("FOLLOW_SELLER_VERIFICATION_BROWSER_TARGET_INVALID");
			}
			followSellerVerificationObservationOwnerRef = ownerRef;
			followSellerVerificationPresentationGeneration += 1;
			RestoreSessionForObservation(ownerRef);
			base.Enabled = true;
			ApplyTaskbarVisibility(visible: true);
			NativeMethods.ShowWindow(base.Handle, NativeMethods.SwShowNoActivate);
			object embedding = EmbeddingState();
			bool visible = activeOwnerRef.Equals(ownerRef, StringComparison.Ordinal)
				&& Active is not null
				&& ReferenceEquals(Active, session)
				&& base.Visible
				&& browserPanel.Visible
				&& browserPresentationVisible
				&& base.Enabled
				&& NativeMethods.IsWindowVisible(base.Handle)
				&& session.Browser.Visible;
			if (!visible)
			{
				HideFollowSellerVerificationSurface(ownerRef, fenceVisibility: false);
				throw new InvalidOperationException("FOLLOW_SELLER_VERIFICATION_WINDOW_NOT_VISIBLE");
			}
			return new
			{
				ok = true,
				visible,
				windowVisible = base.Visible,
				browserPanelVisible = browserPanel.Visible,
				browserPresentationVisible,
				browserControlVisible = session.Browser.Visible,
				embedding
			};
		});
	}

	private Task<object?> HideFollowSellerVerificationBrowserAsync(string ownerRef)
	{
		return UiAsync<object?>(delegate
		{
			if (!sessions.TryGetValue(ownerRef, out var session)
				|| !session.Profile.BrowserRole.Equals("follow-seller-collector", StringComparison.Ordinal))
			{
				throw new InvalidOperationException("FOLLOW_SELLER_VERIFICATION_BROWSER_TARGET_INVALID");
			}
			if (followSellerVerificationObservationOwnerRef.Equals(ownerRef, StringComparison.Ordinal))
			{
				HideFollowSellerVerificationSurface(ownerRef, fenceVisibility: false);
			}
			else
			{
				HideBrowser(fenceVisibility: false);
			}
			return new
			{
				ok = true,
				visible = false,
				embedding = EmbeddingState()
			};
		});
	}

	private void HideFollowSellerVerificationSurface(string ownerRef, bool fenceVisibility)
	{
		if (followSellerVerificationObservationOwnerRef.Equals(ownerRef, StringComparison.Ordinal))
		{
			followSellerVerificationObservationOwnerRef = string.Empty;
		}
		long generation = ++followSellerVerificationPresentationGeneration;
		HideBrowser(fenceVisibility);
		// This host remains alive for other browser roles.  Keep the hidden Form
		// enabled and remove its app-window style so Windows cannot expose a
		// disabled, empty taskbar shell after the verification tab is gone.
		base.Enabled = true;
		ApplyTaskbarVisibility(visible: false);
		NativeMethods.ShowWindow(base.Handle, NativeMethods.SwHide);
		BeginInvoke(delegate
		{
			if (generation != followSellerVerificationPresentationGeneration
				|| followSellerVerificationObservationOwnerRef.Length > 0)
			{
				return;
			}
			ApplyTaskbarVisibility(visible: false);
			NativeMethods.ShowWindow(base.Handle, NativeMethods.SwHide);
			base.Enabled = true;
		});
	}

	private async Task<object?> LaunchAsync(JsonObject payload)
	{
		BrowserProfile profile = BrowserProfile.From(payload);
		string url = BrowserProfile.Text(payload, "url", "about:blank", 1800);
		if (shutdownRequested) throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_CLOSED");
		BrowserPendingLaunches.Ticket ticket = pendingLaunches.Begin(profile.OwnerRef);
		SharedRequestContext? reserved = null;
		bool consumed = false;
		try
		{
			reserved = await UiAsync(() =>
			{
				pendingLaunches.Verify(profile.OwnerRef, ticket);
				if (shutdownRequested || closingForShutdown || IsDisposed) throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_CLOSED");
				AcquireRequestContext(profile);
				return requestContexts[profile.StorageRef];
			}).ConfigureAwait(false);
			await reserved.Preferences.EnsureAppliedAsync(profile, ticket.Token).ConfigureAwait(false);
			return await UiAsync<object?>(delegate
		{
			pendingLaunches.Verify(profile.OwnerRef, ticket);
			if (shutdownRequested || closingForShutdown || IsDisposed || reserved.Preferences.IsClosed)
				throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_CLOSED");
			// Store the target owner first, but do not mutate the live Form using
			// the previous session's presentation mode. ApplyWorkbench below owns
			// the single atomic standalone/embedded transition for this launch.
			ApplyParentWindow(payload, applyNativeMode: false);
			bool requestedVisible = payload["initialBounds"] is JsonObject launchBounds
				&& Boolean(launchBounds, "visible")
				&& !profile.Background;
			bool presentationPrepared = false;
			if (!profile.Background
				&& (requestedVisible || activeOwnerRef.Length == 0 || activeOwnerRef == profile.OwnerRef))
			{
				// Finalize the Form's parent/style before Chromium creates its HWND.
				// The dedicated Pinduoduo Form therefore follows the same stable
				// container lifecycle used by mature purchasing assistants.
				if (requestedVisible) activeOwnerRef = profile.OwnerRef;
				ApplyWorkbench(profile.OwnerRef, payload["workbench"] as JsonObject);
				presentationPrepared = true;
			}
			if (!sessions.TryGetValue(profile.OwnerRef, out var value))
			{
				RequestContext requestContext = reserved.Context;
				try
				{
					value = new BrowserSession(this, profile, extensions, url, requestContext);
					sessions[profile.OwnerRef] = value;
					consumed = true;
					browserPanel.Controls.Add(value.Browser);
					// A hidden collector still needs a native Chromium handle so its
					// network observers and JavaScript bridge can run. Creating the
					// control handle does not activate or show the host form.
					value.Browser.CreateControl();
					bool hiddenLaunch = profile.Background
						|| payload["initialBounds"] is not JsonObject initialBounds
						|| !Boolean(initialBounds, "visible");
					if (hiddenLaunch)
					{
						// CefSharp defers renderer/V8 creation for a never-visible
						// WinForms control. Keep the collector render surface alive at
						// the back of the panel; the active interactive browser stays
						// in front and the host form itself is never restored here.
						value.Browser.Visible = true;
						value.Browser.SendToBack();
					}
				}
				catch
				{
					if (sessions.TryGetValue(profile.OwnerRef, out var failed) && ReferenceEquals(failed, value))
					{
						sessions.Remove(profile.OwnerRef);
						failed.Dispose();
					}
					consumed = false;
					throw;
				}
			}
			if (!profile.Background && !presentationPrepared)
			{
				ApplyWorkbench(profile.OwnerRef, payload["workbench"] as JsonObject);
			}
			if (requestedVisible)
			{
				activeOwnerRef = profile.OwnerRef;
				ActivateSession(profile.OwnerRef);
			}
			if (payload["initialBounds"] is JsonObject bounds)
			{
				ApplyBounds(profile.OwnerRef, bounds);
			}
			return value.State();
			}).ConfigureAwait(false);
		}
		catch (OperationCanceledException) when (ticket.Token.IsCancellationRequested)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_COMMAND_CANCELLED");
		}
		finally
		{
			try
			{
			if (!consumed && reserved != null)
			{
				try { await UiAsync(() => { ReleaseRequestContext(profile.StorageRef, reserved.Context); return true; }).ConfigureAwait(false); }
				catch (ObjectDisposedException) { }
				catch (InvalidOperationException) when (closingForShutdown || IsDisposed || Disposing) { }
			}
			}
			finally { pendingLaunches.Complete(profile.OwnerRef, ticket); }
		}
	}

	private RequestContext AcquireRequestContext(BrowserProfile profile)
	{
		if (requestContexts.TryGetValue(profile.StorageRef, out var shared))
		{
			shared.References += 1;
			return shared.Context;
		}
		Directory.CreateDirectory(profile.ProfileDirectory);
		RequestContextSettings settings = new RequestContextSettings
		{
			CachePath = profile.ProfileDirectory,
			PersistSessionCookies = true,
			// CEF expects a comma-separated language list here and adds its own
			// quality weights. Passing already weighted HTTP syntax produced invalid
			// values such as `zh;q=0.9;q=0.8`, which PDD treated as a non-standard
			// browser environment.
			AcceptLanguageList = profile.CefAcceptLanguageList
		};
		var preferences = new BrowserRequestContextPreferences(profile);
		RequestContext context = new RequestContext(settings, preferences);
		requestContexts[profile.StorageRef] = new SharedRequestContext(context, preferences);
		return context;
	}

	private void ReleaseRequestContext(string storageRef, RequestContext? expected = null)
	{
		if (!requestContexts.TryGetValue(storageRef, out var shared))
		{
			return;
		}
		if (expected != null && !ReferenceEquals(shared.Context, expected)) return;
		shared.References -= 1;
		if (shared.References > 0)
		{
			return;
		}
		requestContexts.Remove(storageRef);
		shared.Preferences.Close();
		shared.Context.Dispose();
	}

	private void ApplyParentWindow(JsonObject payload, bool applyNativeMode)
	{
		string raw = BrowserProfile.Text(payload, "parentHwnd", "0", 32);
		if (!long.TryParse(raw, out long parsed) || parsed < 0)
		{
			parsed = 0;
		}
		IntPtr next = new IntPtr(parsed);
		if (next != IntPtr.Zero && !NativeMethods.IsWindow(next))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_PARENT_WINDOW_INVALID");
		}
		bool changed = parentHwnd != next;
		parentHwnd = next;
		if (applyNativeMode && changed)
		{
			ApplyNativeWindowMode();
		}
	}

	private void CaptureTopLevelWindowStyle()
	{
		if (topLevelStyleCaptured) return;
		topLevelWindowStyle = NativeMethods.GetWindowLongPtr(base.Handle, NativeMethods.GwlStyle).ToInt64();
		topLevelStyleCaptured = true;
	}

	private void ApplyTaskbarVisibility(bool visible)
	{
		if (!base.IsHandleCreated) return;
		IntPtr handle = base.Handle;
		long current = NativeMethods.GetWindowLongPtr(handle, NativeMethods.GwlExStyle).ToInt64();
		long next = visible && !embeddedMode
			? (current | NativeMethods.WsExAppWindow) & ~NativeMethods.WsExToolWindow
			: (current | NativeMethods.WsExToolWindow) & ~NativeMethods.WsExAppWindow;
		if (next == current) return;
		NativeMethods.SetWindowLongPtr(handle, NativeMethods.GwlExStyle, new IntPtr(next));
		NativeMethods.SetWindowPos(
			handle,
			NativeMethods.HwndTop,
			0,
			0,
			0,
			0,
			NativeMethods.SwpNoMove
				| NativeMethods.SwpNoSize
				| NativeMethods.SwpNoZOrder
				| NativeMethods.SwpNoActivate
				| NativeMethods.SwpNoOwnerZOrder
				| NativeMethods.SwpFrameChanged);
	}

	private void ApplyNativeWindowMode()
	{
		IntPtr handle = base.Handle;
		CaptureTopLevelWindowStyle();
		long currentStyle = NativeMethods.GetWindowLongPtr(handle, NativeMethods.GwlStyle).ToInt64();
		IntPtr actualParent = NativeMethods.GetParent(handle);
		bool alreadyEmbedded = embeddedMode
			&& parentHwnd != IntPtr.Zero
			&& actualParent == parentHwnd
			&& (currentStyle & NativeMethods.WsChild) != 0;
		bool alreadyStandalone = !embeddedMode
			&& (currentStyle & NativeMethods.WsChild) == 0
			&& NativeMethods.GetWindowLongPtr(handle, NativeMethods.GwlHwndParent) == IntPtr.Zero;
		if (alreadyEmbedded || alreadyStandalone)
		{
			return;
		}
		if (embeddedMode)
		{
			if (parentHwnd == IntPtr.Zero || !NativeMethods.IsWindow(parentHwnd))
			{
				throw new InvalidOperationException("PURCHASE_BROWSER_PARENT_WINDOW_REQUIRED");
			}
			long childStyle = (topLevelWindowStyle
				& ~NativeMethods.WsPopup
				& ~NativeMethods.WsCaption
				& ~NativeMethods.WsThickFrame
				& ~NativeMethods.WsSysMenu
				& ~NativeMethods.WsMinimizeBox
				& ~NativeMethods.WsMaximizeBox)
				| NativeMethods.WsChild
				| NativeMethods.WsClipChildren
				| NativeMethods.WsClipSiblings;
			NativeMethods.SetWindowLongPtr(handle, NativeMethods.GwlStyle, new IntPtr(childStyle));
			NativeMethods.SetParent(handle, parentHwnd);
		}
		else
		{
			if ((NativeMethods.GetWindowLongPtr(handle, NativeMethods.GwlStyle).ToInt64() & NativeMethods.WsChild) != 0)
			{
				NativeMethods.SetParent(handle, IntPtr.Zero);
			}
			NativeMethods.SetWindowLongPtr(handle, NativeMethods.GwlStyle, new IntPtr(topLevelWindowStyle));
			// Standalone collection is a real independent taskbar window. Keeping
			// Electron as its Win32 owner suppresses its taskbar entry, so a normal
			// minimize makes the browser look as if it disappeared.
			NativeMethods.SetWindowLongPtr(handle, NativeMethods.GwlHwndParent, IntPtr.Zero);
		}
		NativeMethods.SetWindowPos(
			handle,
			NativeMethods.HwndTop,
			0,
			0,
			0,
			0,
			NativeMethods.SwpNoMove
				| NativeMethods.SwpNoSize
				| NativeMethods.SwpNoZOrder
				| NativeMethods.SwpNoActivate
				| NativeMethods.SwpNoOwnerZOrder
				| NativeMethods.SwpFrameChanged
				| NativeMethods.SwpAsyncWindowPos);
		if (embeddedMode)
		{
			long style = NativeMethods.GetWindowLongPtr(handle, NativeMethods.GwlStyle).ToInt64();
			if (NativeMethods.GetParent(handle) != parentHwnd || (style & NativeMethods.WsChild) == 0)
			{
				throw new InvalidOperationException("PURCHASE_BROWSER_EMBED_PARENT_FAILED");
			}
		}
	}

	private async Task<object?> CloseOwnerAsync(string ownerRef, bool force)
	{
		// Cancel + lookup share the same UI queue as launch Verify + commit.
		// A protocol-thread lookup could acknowledge close between those steps.
		var captured = await UiAsync(() =>
		{
			var pending = pendingLaunches.Cancel(ownerRef);
			sessions.TryGetValue(ownerRef, out var session);
			if (pending == null && session == null) throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_NOT_FOUND");
			return (pending, session);
		}).ConfigureAwait(false);
		if (captured.pending != null) await captured.pending.Released.ConfigureAwait(false);
		if (captured.session == null) return new { ok = true, closed = true, pendingLaunchCancelled = true };
		if (!force) return await CloseSessionAsync(ownerRef, captured.session).ConfigureAwait(false);
		return await UiAsync<object?>(() =>
		{
			if (sessions.TryGetValue(ownerRef, out var current) && ReferenceEquals(current, captured.session)) RemoveSession(ownerRef);
			return new { ok = true, closed = true };
		}).ConfigureAwait(false);
	}

	private async Task<object?> CloseSessionAsync(string ownerRef, BrowserSession session)
	{
		bool storageFlushed = false;
		try
		{
			storageFlushed = await session.FlushPersistentStorageAsync()
				.WaitAsync(TimeSpan.FromSeconds(2.0))
				.ConfigureAwait(false);
		}
		catch (TimeoutException)
		{
			// Continue closing this one session; the profile remains recoverable and
			// app shutdown must not block forever on Chromium storage flush.
		}
		return await UiAsync<object?>(delegate
		{
			// A forced close may already have removed this captured session while
			// storage flush was pending. Never remove a newly opened incarnation.
			if (sessions.TryGetValue(ownerRef, out var currentSession)
				&& ReferenceEquals(currentSession, session)) RemoveSession(ownerRef);
			return new
			{
				ok = true,
				closed = true,
				storageFlushed
			};
		}).ConfigureAwait(false);
	}

	private Rectangle NativeBounds()
	{
		if (!NativeMethods.GetWindowRect(base.Handle, out var rect)) return base.Bounds;
		var topLeft = new NativeMethods.NativePoint(rect.Left, rect.Top);
		var bottomRight = new NativeMethods.NativePoint(rect.Right, rect.Bottom);
		IntPtr actualParent = NativeMethods.GetParent(base.Handle);
		if (embeddedMode && actualParent != IntPtr.Zero)
		{
			NativeMethods.ScreenToClient(actualParent, ref topLeft);
			NativeMethods.ScreenToClient(actualParent, ref bottomRight);
		}
		return Rectangle.FromLTRB(topLeft.X, topLeft.Y, bottomRight.X, bottomRight.Y);
	}

	private NativeChildWindowSnapshot[] ChromiumWindowStates()
	{
		List<NativeChildWindowSnapshot> windows = new();
		if (!base.IsHandleCreated || !NativeMethods.IsWindow(base.Handle)) return windows.ToArray();
		NativeMethods.EnumChildWindows(base.Handle, delegate(IntPtr hwnd, IntPtr ignored)
		{
			StringBuilder name = new(256);
			_ = NativeMethods.GetClassName(hwnd, name, name.Capacity);
			string className = name.ToString();
			if (
				className.Contains("Chrome", StringComparison.OrdinalIgnoreCase)
				|| className.Contains("Cef", StringComparison.OrdinalIgnoreCase))
			{
				_ = NativeMethods.GetWindowRect(hwnd, out var rect);
				int width = Math.Max(0, rect.Right - rect.Left);
				int height = Math.Max(0, rect.Bottom - rect.Top);
				bool visible = NativeMethods.IsWindowVisible(hwnd);
				bool onScreen = visible
					&& width > 0
					&& height > 0
					&& rect.Right > 0
					&& rect.Bottom > 0
					&& rect.Left < SystemInformation.VirtualScreen.Right
					&& rect.Top < SystemInformation.VirtualScreen.Bottom;
				windows.Add(new NativeChildWindowSnapshot
				{
					Hwnd = hwnd.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
					ParentHwnd = NativeMethods.GetParent(hwnd).ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
					ClassName = className,
					Visible = visible,
					OnScreen = onScreen,
					Bounds = new
					{
						x = rect.Left,
						y = rect.Top,
						width,
						height
					}
				});
			}
			return true;
		}, IntPtr.Zero);
		return windows.ToArray();
	}

	public object EmbeddingState()
	{
		IntPtr handle = base.Handle;
		IntPtr actualParent = NativeMethods.GetParent(handle);
		long style = NativeMethods.GetWindowLongPtr(handle, NativeMethods.GwlStyle).ToInt64();
		Rectangle bounds = NativeBounds();
		bool childStyle = (style & NativeMethods.WsChild) != 0;
		NativeChildWindowSnapshot[] chromiumWindows = ChromiumWindowStates();
		bool windowVisible = NativeMethods.IsWindowVisible(handle);
		return new
		{
			embedded = embeddedMode && childStyle && parentHwnd != IntPtr.Zero && actualParent == parentHwnd,
			requested = embeddedMode,
			parentHwnd = parentHwnd.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
			actualParentHwnd = actualParent.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
			windowStyle = $"0x{unchecked((uint)style):X8}",
			childStyle,
			windowVisible,
			browserPanelVisible = browserPanel.Visible,
			browserPresentationVisible,
			browserSurfaceVisible = chromiumWindows.Any(static window => window.OnScreen),
			chromiumWindows,
			bounds = new
			{
				x = bounds.X,
				y = bounds.Y,
				width = bounds.Width,
				height = bounds.Height
			}
		};
	}

	private static bool IsEmbeddedPresentation(JsonObject? payload)
	{
		return string.Equals(payload?["displayMode"]?.ToString(), "embedded", StringComparison.OrdinalIgnoreCase);
	}

	private void ApplyPresentationMode(JsonObject? payload)
	{
		bool nextEmbeddedMode = IsEmbeddedPresentation(payload);
		// Win32 rejects layered-opacity updates after the host becomes WS_CHILD.
		// Lift the startup anti-flash opacity while it is still a top-level Form;
		// native ShowWindow/SetWindowPos own all later visibility transitions.
		if (nextEmbeddedMode && !embeddedMode && base.Opacity < 1.0) base.Opacity = 1.0;
		embeddedMode = nextEmbeddedMode;
		SuspendLayout();
		try
		{
			titleBarPanel.Visible = !embeddedMode;
			navigationPanel.Visible = !embeddedMode;
			actionToolbarPanel.Visible = !embeddedMode;
			if (embeddedMode) workbenchPanel.Visible = false;
			base.Padding = embeddedMode ? Padding.Empty : new Padding(1);
			BackColor = embeddedMode ? Color.White : Color.FromArgb(174, 184, 199);
			MinimumSize = embeddedMode ? new Size(320, 240) : new Size(1240, 720);
			if (embeddedMode)
			{
				customMaximized = false;
				hasUserBounds = false;
			}
		}
		finally
		{
			ResumeLayout(performLayout: true);
		}
		ApplyNativeWindowMode();
		if (!embeddedMode && browserPresentationVisible && base.Opacity < 1.0) base.Opacity = 1.0;
	}

	private object ApplyBounds(string ownerRef, JsonObject bounds, long visibilityVersion = 0)
	{
		if (visibilityVersion > latestVisibilityVersion)
		{
			latestVisibilityVersion = visibilityVersion;
		}
		int x = Integer(bounds, "x", lastBounds.X);
		int y = Integer(bounds, "y", lastBounds.Y);
		compactStandaloneMode = !embeddedMode && Boolean(bounds, "compact");
		MinimumSize = embeddedMode
			? new Size(320, 240)
			: compactStandaloneMode ? new Size(520, 620) : new Size(1240, 720);
		int width = Math.Max(embeddedMode ? 320 : compactStandaloneMode ? 520 : 960, Integer(bounds, "width", lastBounds.Width));
		int height = Math.Max(embeddedMode ? 240 : 620, Integer(bounds, "height", lastBounds.Height));
		bool visibilityAllowed = visibilityVersion <= 0
			? hiddenVisibilityFence <= 0
			: visibilityVersion > hiddenVisibilityFence;
		bool followSellerVerificationObservation = followSellerVerificationObservationOwnerRef.Equals(
			ownerRef,
			StringComparison.Ordinal);
		bool flag = Boolean(bounds, "visible")
			&& visibilityAllowed
			&& sessions.TryGetValue(ownerRef, out var boundedSession)
			&& (!boundedSession.Profile.Background || followSellerVerificationObservation);
		Rectangle requestedBounds = new Rectangle(x, y, width, height);
		if (!embeddedMode && flag)
		{
			requestedBounds = RecoverStandaloneBounds(requestedBounds);
			x = requestedBounds.X;
			y = requestedBounds.Y;
			width = requestedBounds.Width;
			height = requestedBounds.Height;
		}
		if (embeddedMode || (!customMaximized && !hasUserBounds))
		{
			lastBounds = requestedBounds;
		}
		applyingBounds = true;
		try
		{
			if (!embeddedMode && customMaximized)
			{
				base.WindowState = FormWindowState.Normal;
				base.Bounds = WorkingAreaBounds();
			}
			else if (base.WindowState == FormWindowState.Normal)
			{
				base.Bounds = lastBounds;
			}
		}
		finally
		{
			applyingBounds = false;
		}
		if (flag)
		{
			RestoreSession(ownerRef, allowBackground: followSellerVerificationObservation);
		}
		else if (
			sessions.TryGetValue(ownerRef, out var backgroundSession)
			&& backgroundSession.Profile.Background
			&& backgroundSession.Profile.BrowserRole.Equals("product-link-parser", StringComparison.OrdinalIgnoreCase)
			&& (Active == null || Active.Profile.Background))
		{
			KeepBackgroundProductParserAlive(ownerRef);
		}
		else if (
			activeOwnerRef == ownerRef
			|| Active == null
			|| Active.Profile.Background)
		{
			HideBrowser(fenceVisibility: false);
		}
		Rectangle appliedBounds = NativeBounds();
		return new
		{
			ok = true,
			bounds = new
			{
				x = appliedBounds.X,
				y = appliedBounds.Y,
				width = appliedBounds.Width,
				height = appliedBounds.Height,
				visible = flag && base.Visible
			},
			embedding = EmbeddingState()
		};
	}

	private void KeepBackgroundProductParserAlive(string ownerRef)
	{
		if (!sessions.TryGetValue(ownerRef, out var session)) return;
		ApplyTaskbarVisibility(visible: false);
		base.Enabled = false;
		browserPanel.Visible = true;
		browserPresentationVisible = false;
		session.Browser.Visible = true;
		session.Browser.SendToBack();
		applyingBounds = true;
		try
		{
			base.WindowState = FormWindowState.Normal;
			NativeMethods.SetWindowPos(
				base.Handle,
				NativeMethods.HwndTop,
				-32000,
				-32000,
				Math.Max(960, lastBounds.Width),
				Math.Max(620, lastBounds.Height),
				NativeMethods.SwpNoActivate
					| NativeMethods.SwpNoOwnerZOrder
					| NativeMethods.SwpShowWindow);
			NativeMethods.ShowWindow(base.Handle, NativeMethods.SwShowNoActivate);
		}
		finally
		{
			applyingBounds = false;
		}
	}

	private object ApplyWorkbench(string ownerRef, JsonObject? payload)
	{
		JsonObject? copy = payload == null ? null : JsonNode.Parse(payload.ToJsonString()) as JsonObject;
		workbenchPresentations[ownerRef] = copy;
		sessions.TryGetValue(ownerRef, out var workbenchSession);
		if (activeOwnerRef == ownerRef || activeOwnerRef.Length == 0)
		{
			// React already renders the complete fixed order card in embedded
			// mode. Building the hidden native copy here costs hundreds of
			// milliseconds and provides no visible output.
			if (!IsEmbeddedPresentation(copy)) workbenchPanel.Apply(copy);
			ApplyPresentationMode(copy);
			if (workbenchSession != null)
			{
				workbenchSession.ApplyEmbeddedPageFit(
					embeddedMode,
					copy?["sidebarKind"]?.ToString() ?? string.Empty
				);
				UpdateHeaderForSession(workbenchSession);
			}
		}
		return new
		{
			ok = true,
			zoomLevel = workbenchSession?.ZoomLevel ?? 0.0d,
			pageFitMode = workbenchSession?.PageFitMode ?? "native",
			workbench = new
			{
				visible = workbenchPanel.Visible,
				kind = copy?["kind"]?.ToString() ?? string.Empty
			}
		};
	}

	private void RememberUserBounds()
	{
		if (!embeddedMode && !applyingBounds && !customMaximized && base.Visible && base.WindowState == FormWindowState.Normal)
		{
			Rectangle candidate = base.Bounds;
			if (IsStandaloneBoundsVisible(candidate, compactStandaloneMode))
			{
				lastBounds = candidate;
				hasUserBounds = true;
			}
		}
	}

	public void ActivateSession(string ownerRef)
	{
		ActivateSession(ownerRef, allowBackground: false);
	}

	private void ActivateSession(string ownerRef, bool allowBackground)
	{
		if (base.InvokeRequired)
		{
			BeginInvoke(delegate
			{
				ActivateSession(ownerRef, allowBackground);
			});
		}
		else
		{
			if (!sessions.TryGetValue(ownerRef, out var value))
			{
				return;
			}
			if (value.Profile.Background && !allowBackground)
			{
				value.Browser.Visible = false;
				return;
			}
			activeOwnerRef = ownerRef;
			foreach (KeyValuePair<string, BrowserSession> session in sessions)
			{
				if (allowBackground)
				{
					session.Value.Browser.Visible = session.Key == ownerRef;
				}
				else if (session.Value.Profile.Background)
				{
					// The collector must stay hot but never cover the active page.
					session.Value.Browser.Visible = true;
					session.Value.Browser.SendToBack();
				}
				else
				{
					session.Value.Browser.Visible = session.Key == ownerRef;
				}
			}
			value.Browser.BringToFront();
			addressBox.Text = ((value.Address == "about:blank") ? string.Empty : value.Address);
			JsonObject? presentation = workbenchPresentations.TryGetValue(ownerRef, out var storedPresentation)
				? storedPresentation
				: null;
			if (!IsEmbeddedPresentation(presentation)) workbenchPanel.Apply(presentation);
			ApplyPresentationMode(presentation);
			value.ApplyEmbeddedPageFit(
				embeddedMode,
				presentation?["sidebarKind"]?.ToString() ?? string.Empty
			);
			UpdateHeaderForSession(value);
			UpdateNavigation(value);
		}
	}

	private void UpdateHeaderForSession(BrowserSession session)
	{
		string platform = PlatformDisplayName(session.Profile.PlatformKey);
		pinduoduoShortcutGroup.Visible = session.Profile.PlatformKey.Equals(
			"pinduoduo",
			StringComparison.OrdinalIgnoreCase);
		purchaseLoginSaveButton.Visible = !session.Profile.Background;
		crossBorderChargeSaveButton.Enabled = !session.Profile.Background
			&& IsCrossBorderPageUrl(session.Address);
		if (workbenchPanel.HasContent)
		{
			titleLabel.Text = workbenchPanel.HeaderTitle + " · " + platform;
			accountLabel.Text = "左侧订单信息固定 · 右侧采购网页独立操作";
			return;
		}
		titleLabel.Text = session.Title;
		accountLabel.Text = platform + " · 原生 CEF · 独立账号环境";
	}

	private static bool IsCrossBorderPageUrl(string? value)
	{
		if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)) return false;
		if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;
		bool correctHost = uri.Host.Equals("kuajing84.com", StringComparison.OrdinalIgnoreCase)
			|| uri.Host.EndsWith(".kuajing84.com", StringComparison.OrdinalIgnoreCase);
		return correctHost
			&& uri.AbsolutePath.Equals("/index/finance/record_consume.html", StringComparison.OrdinalIgnoreCase);
	}

	private static string PlatformDisplayName(string platformKey)
	{
		return platformKey switch
		{
			"pinduoduo" => "拼多多",
			"taobao" => "淘宝",
			"tmall" => "天猫",
			"1688" => "1688",
			"ozon-buyer" => "Ozon 买家",
			"ozon" => "Ozon",
			"jd" => "京东",
			"wildberries" => "Wildberries",
			"amazon" => "Amazon",
			"temu" => "Temu",
			"aliexpress" => "AliExpress",
			_ => string.IsNullOrWhiteSpace(platformKey) ? "采购平台" : platformKey
		};
	}

	public void RestoreSession(string ownerRef)
	{
		RestoreSession(ownerRef, allowBackground: false);
	}

	private void RestoreSessionForObservation(string ownerRef)
	{
		RestoreSession(ownerRef, allowBackground: true);
	}

	private void RestoreSession(string ownerRef, bool allowBackground)
	{
		if (base.InvokeRequired)
		{
			BeginInvoke(delegate
			{
				RestoreSession(ownerRef, allowBackground);
			});
			return;
		}
		if (!sessions.TryGetValue(ownerRef, out var session)
			|| (!allowBackground && session.Profile.Background))
		{
			return;
		}
		ActivateSession(ownerRef, allowBackground);
		base.Enabled = true;
		ApplyTaskbarVisibility(visible: !embeddedMode);
		if (embeddedMode)
		{
			base.WindowState = FormWindowState.Normal;
		}
		else if (customMaximized)
		{
			base.WindowState = FormWindowState.Normal;
			base.Bounds = WorkingAreaBounds();
		}
		else
		{
			lastBounds = RecoverStandaloneBounds(lastBounds);
			base.Bounds = lastBounds;
		}
		if (!base.Visible) Show();
		if (base.WindowState == FormWindowState.Minimized)
		{
			base.WindowState = FormWindowState.Normal;
		}
		ApplyNativeWindowMode();
		browserPanel.Visible = true;
		browserPresentationVisible = true;
		if (!embeddedMode && base.Opacity < 1.0) base.Opacity = 1.0;
		if (embeddedMode)
		{
			NativeMethods.SetWindowPos(
				base.Handle,
				NativeMethods.HwndTop,
				lastBounds.X,
				lastBounds.Y,
				lastBounds.Width,
				lastBounds.Height,
				NativeMethods.SwpNoActivate
					| NativeMethods.SwpNoOwnerZOrder
					| NativeMethods.SwpShowWindow);
			NativeMethods.ShowWindow(base.Handle, NativeMethods.SwShowNoActivate);
		}
		else
		{
			NativeMethods.ShowWindow(base.Handle, NativeMethods.SwShowNoActivate);
			BringToFront();
			Activate();
		}
	}

	public void HideBrowser()
	{
		HideBrowser(fenceVisibility: true);
	}

	private void HideBrowser(bool fenceVisibility)
	{
		if (base.InvokeRequired)
		{
			BeginInvoke(delegate { HideBrowser(fenceVisibility); });
			return;
		}
		if (fenceVisibility)
		{
			// Reserve the next controller generation as well. This covers the
			// one visible bounds request that may already be in flight when the
			// user closes the native window. A later explicit open advances past
			// this fence and is the only operation allowed to show the form again.
			hiddenVisibilityFence = Math.Max(hiddenVisibilityFence, latestVisibilityVersion + 1);
		}
		// Change native extended styles instead of toggling WinForms
		// ShowInTaskbar. This removes a hidden/prewarmed standalone host from the
		// taskbar without recreating the Form/CEF handles and without flashing on
		// the next explicit open.
		ApplyTaskbarVisibility(visible: false);
		base.Enabled = false;
		browserPresentationVisible = false;
		browserPanel.Visible = false;
		applyingBounds = true;
		try
		{
			base.WindowState = FormWindowState.Normal;
			NativeMethods.SetWindowPos(
				base.Handle,
				NativeMethods.HwndTop,
				-32000,
				-32000,
				Math.Max(embeddedMode ? 320 : 960, lastBounds.Width),
				Math.Max(embeddedMode ? 240 : 620, lastBounds.Height),
				NativeMethods.SwpNoActivate
					| NativeMethods.SwpNoOwnerZOrder
					| NativeMethods.SwpHideWindow);
			NativeMethods.ShowWindow(base.Handle, NativeMethods.SwHide);
		}
		finally
		{
			applyingBounds = false;
		}
	}

	public void OnSessionStateChanged(BrowserSession session, string eventName)
	{
		if (base.IsDisposed || base.Disposing || !base.IsHandleCreated)
		{
			return;
		}
		try
		{
			BeginInvoke(delegate
			{
				if (closingForShutdown || base.IsDisposed
					|| !sessions.TryGetValue(session.Profile.OwnerRef, out var current)
					|| !ReferenceEquals(current, session)) return;
				if (activeOwnerRef == session.Profile.OwnerRef)
				{
					if (!addressBox.Focused)
					{
						addressBox.Text = ((session.Address == "about:blank") ? string.Empty : session.Address);
					}
					UpdateHeaderForSession(session);
					UpdateNavigation(session);
				}
				EmitEvent(session.Profile.OwnerRef, eventName, session.State());
			});
		}
		catch (ObjectDisposedException) { }
		catch (InvalidOperationException) { }
	}

	public void OnFollowSellerCaptureProgress(BrowserSession session, string captureToken, JsonObject result)
	{
		if (base.IsDisposed) return;
		ProtocolWriter.Write(new
		{
			type = "event",
			ownerRef = session.Profile.OwnerRef,
			eventName = "follow-seller-result",
			@event = "follow-seller-result",
			captureToken,
			result
		});
	}

	public Task<string> CaptureHiddenOriginalPluginLogisticsAsync(
		BrowserProfile profile,
		IRequestContext requestContext,
		string url,
		string platform)
	{
		string carrierSelector = platform == "1688"
			? ".content-container>.name"
			: ".express-info>.shipping-name";
		string trackingSelector = platform == "1688"
			? ".content-container>.mailNo"
			: ".express-info>.tracking-number";
		string script = "JSON.stringify({carrier:String(document.querySelector("
			+ JsonSerializer.Serialize(carrierSelector)
			+ ")?.textContent||'').trim(),trackingNumber:String(document.querySelector("
			+ JsonSerializer.Serialize(trackingSelector)
			+ ")?.textContent||'').trim()})";
		return ExecuteHiddenPageScriptAsync(
			profile,
			requestContext,
			url,
			script,
			resolvePromise: false,
			settleDelay: TimeSpan.FromSeconds(2),
			scriptTimeout: TimeSpan.FromSeconds(10),
			overallTimeout: TimeSpan.FromSeconds(40),
			requestFailedCode: "CROSS_BORDER_SUPPLIER_REQUEST_FAILED",
			tabFailedCode: "CROSS_BORDER_SUPPLIER_TAB_FAILED",
			timeoutCode: "CROSS_BORDER_REQUEST_TIMEOUT");
	}

	public Task<string> CaptureHiddenPurchaseOrderAsync(
		BrowserProfile profile,
		IRequestContext requestContext,
		string url)
	{
		string script = "return (async()=>{"
			+ "const raw=await (" + PurchaseCaptureScript.Value + ");"
			+ "const value=JSON.parse(raw);"
			+ "const order=String(value.purchaseOrderNumber||value.orderNumber||'').trim();"
			+ "const body=String(document.body&&document.body.innerText||'').replace(/\\s+/gu,' ').trim();"
			+ "value.orderIdentityVerified=Boolean(order&&body.includes(order));"
			+ "return JSON.stringify(value);"
			+ "})();";
		return ExecuteHiddenPageScriptAsync(
			profile,
			requestContext,
			url,
			script,
			resolvePromise: true,
			settleDelay: TimeSpan.FromMilliseconds(4200),
			scriptTimeout: TimeSpan.FromSeconds(4),
			overallTimeout: TimeSpan.FromSeconds(9),
			requestFailedCode: "CROSS_BORDER_SUPPLIER_REQUEST_FAILED",
			tabFailedCode: "CROSS_BORDER_SUPPLIER_TAB_FAILED",
			timeoutCode: "CROSS_BORDER_REQUEST_TIMEOUT");
	}

	public Task<string> CaptureOzonFollowSellerPayloadsAsync(
		BrowserProfile profile,
		IRequestContext requestContext,
		IReadOnlyCollection<string> skus,
		int concurrency,
		bool includeProductFacts,
		ChromiumWebBrowser? sessionBrowser = null)
	{
		string[] safeSkus = skus
			.Where(sku => !string.IsNullOrWhiteSpace(sku))
			.Take(100)
			.ToArray();
		if (safeSkus.Length == 0) return Task.FromResult("[]");
		string initialUrl = $"https://www.ozon.ru/product/product-{safeSkus[0]}/";
		string script = "const skus = " + JsonSerializer.Serialize(safeSkus) + ";\n"
			+ "const concurrency = " + Math.Clamp(concurrency, 1, 6) + ";\n"
			+ "const includeProductFacts = " + (includeProductFacts ? "true" : "false") + ";\n"
			+ """
const results = new Array(skus.length);
let cursor = 0;
const money = (value) => {
  if (value === null || value === undefined || value === '') return null;
  let source = String(value).replace(/[^\d,.\-]+/g, '');
  const comma = source.lastIndexOf(',');
  const dot = source.lastIndexOf('.');
  const separator = Math.max(comma, dot);
  if (separator >= 0) {
    const fractional = source.slice(separator + 1);
    const integer = source.slice(0, separator).replace(/[,.]/g, '');
    source = fractional.length === 1 || fractional.length === 2
      ? `${integer}.${fractional}`
      : `${integer}${fractional}`;
  }
  const parsed = Number.parseFloat(source);
  return Number.isFinite(parsed) ? parsed : null;
};
const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};
const currency = (value) => {
  const source = String(value ?? '');
  if (source.includes('₽')) return 'RUB';
  if (source.includes('¥')) return 'CNY';
  if (source.includes('$')) return 'USD';
  if (source.includes('₸')) return 'KZT';
  if (source.includes('֏')) return 'AMD';
  if (source.includes('Br')) return 'BYN';
  if (source.includes('€')) return 'EUR';
  return '';
};
const widget = (raw) => {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
};
const widgets = (states, prefixes) => {
  if (!states || typeof states !== 'object') return [];
  return Object.entries(states)
    .filter(([name]) => prefixes.some((prefix) => name.startsWith(prefix)))
    .map(([, raw]) => widget(raw))
    .filter(Boolean);
};
const field = (roots, names) => {
  const wanted = new Set(names);
  const queue = roots.map((value) => ({ value, depth: 0 }));
  let visited = 0;
  while (queue.length && visited < 6000) {
    const current = queue.shift();
    const value = current && current.value;
    const depth = current && current.depth || 0;
    visited += 1;
    if (!value || typeof value !== 'object') continue;
    for (const [name, child] of Object.entries(value)) {
      if (wanted.has(name) && child !== null && child !== undefined && child !== '') return child;
      if (depth < 8 && child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
};
const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
const isRrChallengeUrl = (value) => {
  try {
    const target = new URL(String(value || ''), location.href);
    return target.hostname.endsWith('ozon.ru') && target.searchParams.has('__rr');
  } catch {
    return false;
  }
};
const pageText = String(document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
const pageRefreshChallenge = pageText.length > 0
  && pageText.length < 4000
  && /(?:403|обновите страницу|подтвердите, что вы не робот|доступ ограничен|refresh the page|verify you are human|刷新页面|拖动滑块)/iu.test(
    `${document.title || ''} ${pageText}`,
  );
const pageRiskControl = isRrChallengeUrl(location.href) || pageRefreshChallenge;
let riskControlTripped = pageRiskControl;
const fetchWithDeadline = async (endpoint, options = {}, timeoutMs = 12000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('OZON_REQUEST_TIMEOUT'), timeoutMs);
  try {
    return await fetch(endpoint, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};
const requestStates = async (route, apiPath = '/api/entrypoint-api.bx/page/json/v2', referrer = location.href) => {
  let lastError = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const endpoint = `${apiPath}?url=${encodeURIComponent(route)}`;
       const response = await fetchWithDeadline(endpoint, {
         method: 'GET',
         credentials: 'include',
         referrer,
         referrerPolicy: 'strict-origin-when-cross-origin',
         headers: {
           Accept: 'application/json, text/plain, */*',
         },
      }, 12000);
      lastStatus = response.status;
      const riskControl = response.status === 403 || isRrChallengeUrl(response.url);
      if (riskControl) {
        riskControlTripped = true;
        return {
          ok: false,
          status: response.status || 403,
          states: null,
          detail: 'OZON_RR_CHALLENGE',
          riskControl: true,
        };
      }
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await sleep(350 * (attempt + 1));
          continue;
        }
        return { ok: false, status: response.status, states: null, detail: '', riskControl: false };
      }
      const parsed = await response.json();
      return {
        ok: true,
        status: response.status,
        states: parsed && parsed.widgetStates || {},
        detail: '',
        riskControl: false,
      };
    } catch (error) {
      lastError = String(error && error.message || error).slice(0, 300);
      if (attempt < 2) {
        await sleep(350 * (attempt + 1));
        continue;
      }
    }
  }
  return {
    ok: false,
    status: lastStatus,
    states: null,
    detail: pageRiskControl ? 'OZON_RR_CHALLENGE' : lastError,
    riskControl: pageRiskControl,
  };
};
const productSchema = (documentNode, sku) => {
  const roots = [];
  for (const scriptNode of documentNode.querySelectorAll('script[type="application/ld+json"]')) {
    try { roots.push(JSON.parse(scriptNode.textContent || 'null')); } catch { /* unrelated script */ }
  }
  const queue = roots.flatMap((value) => Array.isArray(value) ? value : [value]);
  let visited = 0;
  while (queue.length && visited < 500) {
    const value = queue.shift();
    visited += 1;
    if (!value || typeof value !== 'object') continue;
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    const schemaSku = String(value.sku ?? value.productID ?? '').replace(/\D/g, '');
    if (types.includes('Product') && (!schemaSku || schemaSku === String(sku))) return value;
    if (Array.isArray(value['@graph'])) queue.push(...value['@graph']);
  }
  return null;
};
const requestProductHtml = async (sku, sourceProductUrl) => {
  let lastError = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchWithDeadline(`/product/product-${sku}/`, {
        method: 'GET',
        credentials: 'include',
        referrer: sourceProductUrl,
        referrerPolicy: 'strict-origin-when-cross-origin',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      }, 12000);
      lastStatus = response.status;
      const riskControl = response.status === 403 || isRrChallengeUrl(response.url);
      if (riskControl) {
        riskControlTripped = true;
        return {
          ok: false,
          status: response.status || 403,
          detail: 'OZON_RR_CHALLENGE',
          riskControl: true,
        };
      }
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 1) {
          await sleep(350 * (attempt + 1));
          continue;
        }
        return { ok: false, status: response.status, detail: '', riskControl: false };
      }
      const html = await response.text();
      const documentNode = new DOMParser().parseFromString(html, 'text/html');
      const schema = productSchema(documentNode, sku);
      const aggregateRating = schema && schema.aggregateRating && typeof schema.aggregateRating === 'object'
        ? schema.aggregateRating
        : null;
      const priceWidget = documentNode.querySelector('[data-widget="webPrice"]');
      const priceText = String(priceWidget?.textContent || '').replace(/\s+/g, ' ').trim();
      const cardMatch = priceText.match(/(\d[\d\s.,]*?)\s*₽\s*[сc]\s*Ozon\s*Карт/iu);
      if (!schema && !priceWidget) {
        return { ok: false, status: response.status, detail: 'OZON_PRODUCT_HTML_FACTS_NOT_FOUND' };
      }
      return {
        ok: true,
        status: response.status,
        states: null,
        cardPrice: cardMatch ? money(cardMatch[1]) : null,
        cardPriceCurrency: cardMatch ? 'RUB' : '',
        rating: finite(aggregateRating?.ratingValue),
        reviews: finite(aggregateRating?.reviewCount ?? aggregateRating?.ratingCount),
        orders: null,
        detail: '',
        source: 'ozon-public-product-page-html',
        riskControl: false,
      };
    } catch (error) {
      lastError = String(error && error.message || error).slice(0, 300);
      if (attempt < 1) {
        await sleep(350 * (attempt + 1));
        continue;
      }
    }
  }
  return {
    ok: false,
    status: lastStatus,
    detail: pageRiskControl ? 'OZON_RR_CHALLENGE' : lastError,
    riskControl: pageRiskControl,
  };
};
const requestProductDetails = async (sku, sourceProductUrl) => {
  const json = await requestStates(
    `/product/product-${sku}/`,
    '/api/composer-api.bx/page/json/v2',
    sourceProductUrl,
  );
  if (json.ok) return { ...json, source: 'ozon-public-product-page-json' };
  if (json.riskControl) return { ...json, source: '' };
  const html = await requestProductHtml(sku, sourceProductUrl);
  if (html.ok) return html;
  return {
    ok: false,
    status: json.status || html.status,
    states: null,
    detail: [json.detail, html.detail].filter(Boolean).join(' | ').slice(0, 300),
    source: '',
    riskControl: json.riskControl === true || html.riskControl === true,
  };
};
const captureSku = async (sku) => {
  const capturedAt = new Date().toISOString();
  const sourceProductUrl = new URL(`/product/product-${sku}/`, location.origin).toString();
  const offersRoute = `/modal/otherOffersFromSellers?product_id=${sku}&page_changed=true`;
  if (riskControlTripped) {
    return {
      sku,
      confirmed: false,
      status: 403,
      followSellerConfirmed: false,
      followSellerStatus: 403,
      productFactsConfirmed: false,
      productFactsStatus: 403,
      challengeDetected: true,
      detail: 'OZON_RR_CHALLENGE',
      capturedAt,
      sourceProductUrl,
      offersRoute,
    };
  }
  // Match an ordinary product-page visit: every public-data request carries
  // that SKU's own product URL as referrer.  The offers request runs first so
  // a single 403 immediately stops the second request instead of doubling the
  // rejected burst.
  const offers = await requestStates(
    offersRoute,
    '/api/entrypoint-api.bx/page/json/v2',
    sourceProductUrl,
  );
  const product = !includeProductFacts
	? { ok: false, status: 0, states: null, detail: '', source: '', riskControl: false }
	: offers.riskControl
    ? { ok: false, status: offers.status, states: null, detail: offers.detail, source: '', riskControl: true }
    : await requestProductDetails(sku, sourceProductUrl);
  const sellerWidgets = widgets(offers.states, ['webSellerList-']);
  const sellerList = sellerWidgets.find((item) => Array.isArray(item && item.sellers));
  const sellers = Array.isArray(sellerList && sellerList.sellers) ? sellerList.sellers : [];
  const prices = sellers
    .map((seller) => money(seller?.price?.cardPrice?.price ?? seller?.price?.price))
    .filter((price) => price !== null);
  const priceWidgets = widgets(product.states, ['webPrice-', 'webSale-', 'webProductPrice-']);
  const reviewWidgets = widgets(product.states, ['webReviewProductScore-', 'webProductReviews-']);
  const productInfoWidgets = widgets(product.states, [
    'webProductInfo-',
    'webProductAbout-',
    'webCharacteristics-',
  ]);
  const cardPriceRaw = field(priceWidgets, [
    'cardPrice',
    'priceWithCard',
    'ozonCardPrice',
    'card_price',
    'priceWithOzonCard',
  ]);
  const cardPrice = product.cardPrice ?? money(cardPriceRaw);
  const cardPriceCurrency = product.cardPriceCurrency || currency(cardPriceRaw);
  const rating = product.rating ?? finite(field(reviewWidgets, [
    'rating',
    'score',
    'totalScore',
    'ratingValue',
    'productRating',
  ]));
  const reviews = product.reviews ?? finite(field(reviewWidgets, [
    'reviewsCount',
    'reviewCount',
    'commentsCount',
    'feedbackCount',
  ]));
  const orders = product.orders ?? finite(field(productInfoWidgets, [
    'orders',
    'orderCount',
    'ordersCount',
  ]));
  return {
    sku,
    confirmed: offers.ok || product.ok,
    status: offers.status || product.status,
    followSellerConfirmed: offers.ok,
    followSellerStatus: offers.status,
    productFactsConfirmed: product.ok,
    productFactsStatus: product.status,
    challengeDetected: offers.riskControl === true || product.riskControl === true,
    productFactsSource: product.source,
    followSellerCount: offers.ok ? sellers.length : null,
    followMinPrice: offers.ok && prices.length ? Math.min(...prices) : null,
    followMaxPrice: offers.ok && prices.length ? Math.max(...prices) : null,
    followSellers: offers.ok ? sellers.slice(0, 50).map((seller) => ({
      sku: String(seller?.sku ?? seller?.productId ?? seller?.product_id ?? '').replace(/\D/g, '').slice(0, 20),
      id: String(seller?.id ?? seller?.sellerId ?? seller?.seller_id ?? '').slice(0, 100),
      name: String(seller?.name ?? seller?.sellerName ?? seller?.seller_name ?? '').slice(0, 240),
      link: String(seller?.link ?? '').slice(0, 1000),
      productLink: String(seller?.productLink ?? seller?.product_link ?? '').slice(0, 1200),
      credentials: Array.isArray(seller?.credentials)
        ? seller.credentials.slice(0, 8).map((value) => String(value ?? '').slice(0, 240))
        : [],
      coverImage: String(seller?.coverImage ?? seller?.cover_image ?? '').slice(0, 1200),
      price: money(seller?.price?.cardPrice?.price ?? seller?.price?.price),
    })) : [],
    capturedAt,
    sourceProductUrl,
    offersRoute,
    cardPrice: product.ok ? cardPrice : null,
    cardPriceCurrency: product.ok ? cardPriceCurrency : '',
    rating: product.ok && rating !== null && rating >= 0 && rating <= 5 ? rating : null,
    reviews: product.ok && reviews !== null && reviews >= 0 && Number.isInteger(reviews) ? reviews : null,
    orders: product.ok && orders !== null && orders >= 0 && Number.isInteger(orders) ? orders : null,
    detail: [offers.detail, product.detail].filter(Boolean).join(' | ').slice(0, 300),
  };
};
const worker = async () => {
  while (cursor < skus.length) {
    const index = cursor++;
    const sku = skus[index];
    results[index] = await captureSku(sku);
    if (cursor < skus.length) {
      // Avoid a machine-speed request train. The stable per-item jitter keeps
      // throughput predictable while preventing all workers from firing the
      // next pair of Ozon page requests at the same instant.
      await sleep(120 + ((index * 47) % 141));
    }
  }
};
return Promise.all(Array.from({ length: Math.min(concurrency, skus.length) }, worker))
  .then(() => JSON.stringify(results));
""";
		if (sessionBrowser != null)
		{
			return ExecuteOzonPatrolSessionScriptAsync(
				sessionBrowser,
				script,
				TimeSpan.FromSeconds(230),
				"OZON_FOLLOW_SELLERS_BROWSER_REQUEST_FAILED",
				"OZON_FOLLOW_SELLERS_BROWSER_TAB_FAILED");
		}
		return ExecuteHiddenPageScriptAsync(
			profile,
			requestContext,
			initialUrl,
			script,
			resolvePromise: true,
			settleDelay: TimeSpan.FromMilliseconds(1600),
			scriptTimeout: TimeSpan.FromSeconds(230),
			overallTimeout: TimeSpan.FromSeconds(250),
			requestFailedCode: "OZON_FOLLOW_SELLERS_BROWSER_REQUEST_FAILED",
			tabFailedCode: "OZON_FOLLOW_SELLERS_BROWSER_TAB_FAILED",
			timeoutCode: "OZON_FOLLOW_SELLERS_BROWSER_TIMEOUT");
	}

	public Task<JsonObject> CaptureAlibaba1688OrdersAsync(
		BrowserProfile profile,
		IRequestContext requestContext,
		string? requestedUrl = null,
		string? expectedOrderNumber = null)
	{
		string url = ResolveAlibaba1688CaptureUrl(requestedUrl);
		string normalizedExpectedOrderNumber = (expectedOrderNumber ?? string.Empty).Trim();
		if (!Regex.IsMatch(normalizedExpectedOrderNumber, @"^\d{12,30}$", RegexOptions.CultureInvariant))
		{
			normalizedExpectedOrderNumber = Regex.Match(
				url,
				@"(?:[?&](?:orderId|order_id)=)(\d{8,})",
				RegexOptions.IgnoreCase | RegexOptions.CultureInvariant).Groups[1].Value;
		}
		if (!BrowserUrlPolicy.IsAllowed(url, extensions))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_1688_NETWORK_REQUEST_FAILED");
		}

		TaskCompletionSource<JsonObject> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
		Alibaba1688OrderNetworkCapture capture = new(normalizedExpectedOrderNumber, url);
		ChromiumWebBrowser? browser = null;
		HiddenBrowserSurface? surface = null;
		int settled = 0;

		if (base.InvokeRequired)
		{
			BeginInvoke(Create);
		}
		else
		{
			Create();
		}

		return completion.Task;

		string ResolveAlibaba1688CaptureUrl(string? candidate)
		{
			if (Uri.TryCreate(candidate, UriKind.Absolute, out Uri? parsed)
				&& parsed.Host.EndsWith("1688.com", StringComparison.OrdinalIgnoreCase)
				&& Regex.IsMatch(
					parsed.Query,
					@"(?:^|[?&])(?:orderId|order_id)=\d{8,}(?:&|$)",
					RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
				&& BrowserUrlPolicy.IsAllowed(parsed.ToString(), extensions))
			{
				return parsed.ToString();
			}
			return Alibaba1688OrderNetworkCapture.OrderListUrl;
		}

		async Task AwaitCaptureAsync()
		{
			try
			{
				JsonObject result = await capture.WaitAsync(TimeSpan.FromMilliseconds(7500))
					.ConfigureAwait(continueOnCapturedContext: false);
				if (Interlocked.Exchange(ref settled, 1) == 0)
				{
					completion.TrySetResult(result);
					Cleanup();
				}
			}
			catch (Exception error)
			{
				Console.Error.WriteLine(
					$"[purchase-browser-1688] hidden capture failed code={ErrorCode.From(error)}");
				Fail(ErrorCode.From(error));
			}
		}

		void Create()
		{
			try
			{
				browser = new ChromiumWebBrowser(url, requestContext)
				{
					Location = new Point(-4096, -4096),
					Size = new Size(1280, 900),
					LifeSpanHandler = new InternalLifeSpanHandler(extensions),
					RequestHandler = new InternalRequestHandler(profile, extensions, capture),
					PermissionHandler = new InternalPermissionHandler(this, extensions),
					RenderProcessMessageHandler = new FingerprintRenderProcessMessageHandler(profile),
					Visible = true
				};
				surface = new HiddenBrowserSurface();
				browser.Dock = DockStyle.Fill;
				surface.Controls.Add(browser);
				browser.CreateControl();
				surface.Show();
				_ = AwaitCaptureAsync();
			}
			catch (Exception error)
			{
				Console.Error.WriteLine(
					$"[purchase-browser-1688] hidden browser create failed error={error.GetType().Name}");
				Fail("PURCHASE_BROWSER_1688_NETWORK_REQUEST_FAILED");
			}
		}

		void Fail(string code)
		{
			if (Interlocked.Exchange(ref settled, 1) == 0)
			{
				completion.TrySetException(new InvalidOperationException(code));
				Cleanup();
			}
		}

		void Cleanup()
		{
			if (base.InvokeRequired)
			{
				BeginInvoke(Remove);
			}
			else
			{
				Remove();
			}
		}

		void Remove()
		{
			if (browser != null)
			{
				surface?.Controls.Remove(browser);
				browser.Dispose();
				browser = null;
			}
			if (surface != null)
			{
				surface.Close();
				surface.Dispose();
				surface = null;
			}
		}
	}

	private static async Task<string> ExecuteOzonPatrolSessionScriptAsync(
		ChromiumWebBrowser browser,
		string script,
		TimeSpan scriptTimeout,
		string requestFailedCode,
		string tabFailedCode)
	{
		DateTime readyDeadline = DateTime.UtcNow.AddSeconds(12);
		while (!browser.IsDisposed
			&& !browser.CanExecuteJavascriptInMainFrame
			&& DateTime.UtcNow < readyDeadline)
		{
			await Task.Delay(100).ConfigureAwait(continueOnCapturedContext: false);
		}
		if (browser.IsDisposed || !browser.CanExecuteJavascriptInMainFrame)
		{
			throw new InvalidOperationException(tabFailedCode);
		}
		if (!Uri.TryCreate(browser.Address, UriKind.Absolute, out Uri? address)
			|| address.Scheme != Uri.UriSchemeHttps
			|| !(address.Host.Equals("ozon.ru", StringComparison.OrdinalIgnoreCase)
				|| address.Host.EndsWith(".ozon.ru", StringComparison.OrdinalIgnoreCase)))
		{
			throw new InvalidOperationException(tabFailedCode);
		}
		try
		{
			JavascriptResponse response = await browser.EvaluateScriptAsPromiseAsync(
				script,
				scriptTimeout).ConfigureAwait(continueOnCapturedContext: false);
			if (!response.Success || response.Result is not string result)
			{
				Console.Error.WriteLine(
					$"[ozon-follow-seller] code={requestFailedCode} url={browser.Address} "
					+ $"ready={browser.CanExecuteJavascriptInMainFrame} "
					+ $"success={response.Success} message={response.Message}");
				throw new InvalidOperationException(requestFailedCode);
			}
			return result;
		}
		catch (TaskCanceledException error)
		{
			throw new InvalidOperationException(requestFailedCode, error);
		}
	}

	private Task<string> ExecuteHiddenPageScriptAsync(
		BrowserProfile profile,
		IRequestContext requestContext,
		string url,
		string script,
		bool resolvePromise,
		TimeSpan settleDelay,
		TimeSpan scriptTimeout,
		TimeSpan overallTimeout,
		string requestFailedCode,
		string tabFailedCode,
		string timeoutCode)
	{
		if (!BrowserUrlPolicy.IsAllowed(url, extensions))
		{
			throw new InvalidOperationException(requestFailedCode);
		}
		TaskCompletionSource<string> completion = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
		ChromiumWebBrowser? browser = null;
		HiddenBrowserSurface? surface = null;
		System.Threading.Timer? timeout = null;
		System.Threading.Timer? captureKickoff = null;
		int settled = 0;
		int captureStarted = 0;
		if (base.InvokeRequired)
		{
			BeginInvoke(Create);
		}
		else
		{
			Create();
		}
		return completion.Task;
		async Task CaptureAsync()
		{
			await Task.Delay(settleDelay).ConfigureAwait(continueOnCapturedContext: false);
			DateTime readyDeadline = DateTime.UtcNow.AddSeconds(8);
			while (browser != null
				&& !browser.IsDisposed
				&& !browser.CanExecuteJavascriptInMainFrame
				&& DateTime.UtcNow < readyDeadline)
			{
				await Task.Delay(100).ConfigureAwait(continueOnCapturedContext: false);
			}
			if (browser == null || browser.IsDisposed)
			{
				Fail(tabFailedCode);
				return;
			}
			try
			{
				JavascriptResponse javascriptResponse = resolvePromise
					? await browser.EvaluateScriptAsPromiseAsync(script, scriptTimeout).ConfigureAwait(continueOnCapturedContext: false)
					: await browser.EvaluateScriptAsync(script, timeout: scriptTimeout).ConfigureAwait(continueOnCapturedContext: false);
				if (!javascriptResponse.Success || !(javascriptResponse.Result is string result))
				{
					Console.Error.WriteLine(
						$"[hidden-page] code={requestFailedCode} url={url} "
						+ $"ready={browser.CanExecuteJavascriptInMainFrame} "
						+ $"success={javascriptResponse.Success} "
						+ $"message={javascriptResponse.Message}");
					throw new InvalidOperationException(requestFailedCode);
				}
				if (Interlocked.Exchange(ref settled, 1) == 0)
				{
					completion.TrySetResult(result);
					Cleanup();
				}
			}
			catch (Exception error)
			{
				string code = ErrorCode.From(error);
				Console.Error.WriteLine(
					$"[hidden-page] code={requestFailedCode} url={url} "
					+ $"error={error.GetType().Name} message={error.Message}");
				Fail(code == requestFailedCode || code == tabFailedCode || code == timeoutCode
					? code
					: requestFailedCode);
			}
		}
		void Cleanup()
		{
			timeout?.Dispose();
			captureKickoff?.Dispose();
			if (browser != null)
			{
				if (base.InvokeRequired)
				{
					BeginInvoke(Remove);
				}
				else
				{
					Remove();
				}
			}
		}
		void Create()
		{
			try
			{
				browser = new ChromiumWebBrowser(url, requestContext)
				{
					Location = new Point(-4096, -4096),
					Size = new Size(1024, 768),
					LifeSpanHandler = new InternalLifeSpanHandler(extensions),
					RequestHandler = new InternalRequestHandler(profile, extensions),
					PermissionHandler = new InternalPermissionHandler(this, extensions),
					RenderProcessMessageHandler = new FingerprintRenderProcessMessageHandler(profile),
					Visible = true
				};
				surface = new HiddenBrowserSurface();
				browser.LoadingStateChanged += delegate(object? _, LoadingStateChangedEventArgs args)
				{
					if (!args.IsLoading
						&& Volatile.Read(in settled) == 0
						&& Interlocked.CompareExchange(ref captureStarted, 1, 0) == 0)
					{
						_ = CaptureAsync();
					}
				};
				browser.Dock = DockStyle.Fill;
				surface.Controls.Add(browser);
				browser.CreateControl();
				surface.Show();
				// Some Ozon pages keep long-polling resources open, so their
				// LoadingStateChanged event may never settle. Start the isolated
				// capture after a short warm-up as a deterministic fallback.
				captureKickoff = new System.Threading.Timer(delegate
				{
					if (Volatile.Read(in settled) == 0
						&& Interlocked.CompareExchange(ref captureStarted, 1, 0) == 0)
					{
						_ = CaptureAsync();
					}
				}, null, TimeSpan.FromMilliseconds(2500), Timeout.InfiniteTimeSpan);
				timeout = new System.Threading.Timer(delegate
				{
					Fail(timeoutCode);
				}, null, overallTimeout, Timeout.InfiniteTimeSpan);
			}
			catch
			{
				Fail(tabFailedCode);
			}
		}
		void Fail(string code)
		{
			if (Interlocked.Exchange(ref settled, 1) == 0)
			{
				completion.TrySetException(new InvalidOperationException(code));
				Cleanup();
			}
		}
		void Remove()
		{
			if (browser != null)
			{
				surface?.Controls.Remove(browser);
				browser.Dispose();
				browser = null;
			}
			if (surface != null)
			{
				surface.Close();
				surface.Dispose();
				surface = null;
			}
		}
	}

	private async void HandleAction(string action)
	{
		if (hostActionInFlight)
		{
			return;
		}
		BrowserSession? active = Active;
		if (active == null || protocol == null)
		{
			return;
		}
		hostActionInFlight = true;
		actionToolbarPanel.Enabled = false;
		try
		{
			if (action == "cross-border-charges-save")
			{
				ShowActionStatus("正在自动翻页读取消费日志并匹配全部店铺…");
			}
			JsonNode? response = await protocol.RequestHostActionAsync(active.Profile.OwnerRef, action).ConfigureAwait(continueOnCapturedContext: true);
			HostActionDialog dialog = BuildHostActionDialog(response, action);
			if (dialog.ShowInlineStatus)
			{
				ShowActionStatus(dialog.Message);
				return;
			}
			if (dialog.RequiresConfirmation)
			{
				DialogResult choice = MessageBox.Show(this, dialog.Message, dialog.Title, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
				if (choice != DialogResult.Yes)
				{
					return;
				}
				response = await protocol.RequestHostActionAsync(
					active.Profile.OwnerRef,
					dialog.ConfirmationAction,
					new
					{
						confirmationToken = dialog.ConfirmationToken,
						previewId = dialog.PreviewId
					}).ConfigureAwait(continueOnCapturedContext: true);
				dialog = BuildHostActionDialog(response, dialog.ConfirmationAction);
			}
			if (dialog.AutoClose)
			{
				await active.FlushPersistentStorageAsync().ConfigureAwait(continueOnCapturedContext: true);
				HideBrowser();
				EmitEvent(active.Profile.OwnerRef, "window-hidden", active.State());
				return;
			}
			MessageBox.Show(this, dialog.Message, dialog.Title, MessageBoxButtons.OK, dialog.Icon);
		}
		catch (Exception error)
		{
			string code = ErrorCode.From(error);
			if (IsExpectedHostActionCancellation(action, code))
			{
				return;
			}
			MessageBox.Show(this, FriendlyError(code), "操作失败", MessageBoxButtons.OK, MessageBoxIcon.Exclamation);
		}
		finally
		{
			hostActionInFlight = false;
			if (!IsDisposed && !Disposing)
			{
				actionToolbarPanel.Enabled = true;
			}
		}
	}

	private static bool IsExpectedHostActionCancellation(string action, string code)
	{
		// The settings page verifies and persists the Ozon login independently. Once
		// that succeeds it hides the standalone login window, which cancels the native
		// toolbar request that initiated the same save. This is successful cleanup,
		// not an operator-visible failure. Keep every other host-action error visible.
		return action == "purchase-login-save"
			&& code == "PURCHASE_BROWSER_COMMAND_CANCELLED";
	}

	private void ShowActionStatus(string message)
	{
		actionStatusTimer.Stop();
		actionStatusLabel.Text = message;
		actionStatusLabel.Visible = true;
		actionStatusLabel.BringToFront();
		actionStatusTimer.Start();
	}

	private sealed class HostActionDialog
	{
		public string Title { get; init; } = "旺崽助手";

		public string Message { get; init; } = "操作已完成。";

		public MessageBoxIcon Icon { get; init; } = MessageBoxIcon.Information;

		public bool RequiresConfirmation { get; init; }

		public string ConfirmationToken { get; init; } = string.Empty;

		public string PreviewId { get; init; } = string.Empty;

		public string ConfirmationAction { get; init; } = "capture-confirm";

		public bool ShowInlineStatus { get; init; }

		public bool AutoClose { get; init; }
	}

	private static JsonNode? Child(JsonNode? value, string name)
	{
		return value is JsonObject jsonObject ? jsonObject[name] : null;
	}

	private static string NodeText(JsonNode? value, string fallback = "")
	{
		try
		{
			return value?.GetValue<string>()?.Trim() ?? fallback;
		}
		catch
		{
			return fallback;
		}
	}

	private static bool Flag(JsonNode? value)
	{
		try
		{
			return value?.GetValue<bool>() ?? false;
		}
		catch
		{
			return false;
		}
	}

	private static HostActionDialog BuildHostActionDialog(JsonNode? value, string action)
	{
		JsonNode? dialog = Child(Child(value, "toolbar"), "dialog");
		string kind = NodeText(Child(dialog, "kind"), action);
		string title = NodeText(Child(dialog, "title"), "旺崽助手");
		JsonNode? result = Child(dialog, "result");
		if (kind == "purchase-login-saved")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = "登录信息和 Cookie 已保存。",
				AutoClose = Flag(Child(dialog, "autoClose"))
			};
		}
		if (kind == "purchase-login-save-failed")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = "未检测到有效登录状态，请完成登录后再次点击“保存账号”。",
				Icon = MessageBoxIcon.Warning
			};
		}
		if (kind == "purchase-login-identity-pending")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = "登录信息和 Cookie 已保存，系统会继续核对当前店铺账号。",
				AutoClose = Flag(Child(dialog, "autoClose"))
			};
		}
		if (kind == "purchase-login-shop-mismatch")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = "当前网页登录账号与所选 Ozon 店铺 API 账号不一致，请切换账号后重新保存。",
				Icon = MessageBoxIcon.Warning
			};
		}
		if (kind == "collection-pricing-captured")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = "采集成功，已加入采集列表，可继续采集下一件。",
				ShowInlineStatus = true
			};
		}
		if (kind == "cross-border-charges-opened")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = NodeText(Child(result, "提示"), "跨境巴士已打开。登录并进入预报费用页面后，点击“保存生效”。"),
				ShowInlineStatus = true
			};
		}
		if (kind == "capture-preview")
		{
			string message = CaptureSummary(result, "请确认是否回填到当前目标订单？");
			return new HostActionDialog
			{
				Title = title,
				Message = message,
				Icon = MessageBoxIcon.Question,
				RequiresConfirmation = !string.IsNullOrWhiteSpace(NodeText(Child(dialog, "confirmationToken"))),
				ConfirmationToken = NodeText(Child(dialog, "confirmationToken")),
				PreviewId = NodeText(Child(dialog, "previewId")),
				ConfirmationAction = NodeText(Child(dialog, "confirmationAction"), "capture-confirm")
			};
		}
		if (kind == "cross-border-charges-preview")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = ChargePreviewSummary(result) + ChargeDetailSummary(result),
				Icon = MessageBoxIcon.Question,
				RequiresConfirmation = !string.IsNullOrWhiteSpace(NodeText(Child(dialog, "confirmationToken"))),
				ConfirmationToken = NodeText(Child(dialog, "confirmationToken")),
				PreviewId = NodeText(Child(result, "previewId")),
				ConfirmationAction = NodeText(Child(dialog, "confirmationAction"), "cross-border-charges-confirm")
			};
		}
		if (kind == "capture-result")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = CaptureSummary(result, "请进入商品详情页、订单详情页或物流详情页后重试。"),
				Icon = MessageBoxIcon.Information
			};
		}
		if (kind == "capture-complete")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = CaptureCompleteSummary(result),
				Icon = MessageBoxIcon.Information
			};
		}
		if (kind == "cross-border-charges-complete")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = "实际扣费已写入本地账本，且回读校验通过。\n保存订单数：" + NodeText(Child(result, "savedOrderCount"), "0") + "\n精确关联：" + NodeText(Child(result, "exactCount"), "0") + ChargeDetailSummary(result),
				Icon = MessageBoxIcon.Information
			};
		}
		string prompt = NodeText(Child(result, "提示"));
		if (!string.IsNullOrWhiteSpace(prompt))
		{
			return new HostActionDialog { Title = title, Message = prompt };
		}
		if (kind == "account-status")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = "当前页面：" + NodeText(Child(result, "page"), "未知")
					+ "\n会话状态：" + TranslateStatus(NodeText(Child(result, "phase")), "正常")
					+ "\n连接状态：" + TranslateHealth(NodeText(Child(result, "health")), "正常")
					+ "\n网络方式：" + NodeText(Child(result, "proxyMode"), "直连")
					+ "\n目标订单：" + (Flag(Child(result, "targetLocked")) ? "已锁定" : "未锁定")
			};
		}
		if (kind == "login-status")
		{
			return new HostActionDialog
			{
				Title = title,
				Message = Flag(Child(result, "loggedIn")) ? "跨境巴士已登录。" : "跨境巴士未登录，请先完成登录。",
				Icon = Flag(Child(result, "loggedIn")) ? MessageBoxIcon.Information : MessageBoxIcon.Warning
			};
		}
		if (kind == "orders")
		{
			int count = (Child(result, "orders") as JsonArray)?.Count ?? 0;
			return new HostActionDialog { Title = title, Message = "已读取跨境巴士订单：" + count + " 条。" };
		}
		if (kind == "logistics")
		{
			return new HostActionDialog { Title = title, Message = "物流信息已读取。" + LogisticsSummary(result) };
		}
		if (kind == "status")
		{
			return new HostActionDialog { Title = title, Message = "跨境巴士状态已读取。" };
		}
		return new HostActionDialog { Title = title, Message = "操作已完成。" };
	}

	private static string CaptureSummary(JsonNode? result, string emptyMessage)
	{
		string product = NodeText(Child(result, "productTitle"));
		string order = NodeText(Child(result, "purchaseOrderNumber"));
		string price = NodeText(Child(result, "purchasePrice"));
		string quantity = NodeText(Child(result, "quantity"));
		string page = NodeText(Child(result, "pageTitle"));
		if (string.IsNullOrWhiteSpace(product) && string.IsNullOrWhiteSpace(order))
		{
			return "当前页面没有识别到可用的采购信息。"
				+ (string.IsNullOrWhiteSpace(page) ? string.Empty : "\n当前页面：" + page)
				+ "\n" + emptyMessage;
		}
		List<string> lines = new List<string>();
		if (!string.IsNullOrWhiteSpace(product)) lines.Add("商品：" + product);
		if (!string.IsNullOrWhiteSpace(order)) lines.Add("采购单号：" + order);
		if (!string.IsNullOrWhiteSpace(price)) lines.Add("采购价：" + price);
		if (!string.IsNullOrWhiteSpace(quantity)) lines.Add("数量：" + quantity);
		return string.Join("\n", lines);
	}

	private static string ChargeDetailSummary(JsonNode? result)
	{
		JsonNode? coverage = Child(result, "detailCoverage");
		if (!Flag(Child(coverage, "requested"))) return "\n补充明细：未请求（费用以完整流水为准）。";
		return "\n补充明细：" + NodeText(Child(coverage, "completed"), "0") + "/" + NodeText(Child(coverage, "total"), "0")
			+ "；失败：" + NodeText(Child(coverage, "failed"), "0")
			+ (Flag(Child(coverage, "complete")) ? "（已完整读取）" : "（尚未完整，不等于零费用）");
	}

	private static string ChargePreviewSummary(JsonNode? result)
	{
		JsonNode? summary = Child(result, "summary");
		JsonNode? pagination = Child(result, "pagination");
		return "已读取跨境巴士消费流水，确认后才会写入本地。"
			+ "\n自动翻页：" + (Flag(Child(pagination, "complete")) ? "已完整读取" : "未完成")
			+ "（" + NodeText(Child(pagination, "chargePagesRead"), "0") + " 页）"
			+ "\n页面原始记录：" + NodeText(Child(pagination, "chargeRawRowCount"), "0")
			+ "\n流水：" + NodeText(Child(summary, "statementCount"), "0")
			+ "\n合单：" + NodeText(Child(summary, "orderCount"), "0")
			+ "\n精确关联：" + NodeText(Child(summary, "exactCount"), "0")
			+ "\n待确认/未匹配：" + NodeText(Child(summary, "ambiguousCount"), "0") + "/" + NodeText(Child(summary, "unmatchedCount"), "0")
			+ "\n精确订单实际扣费：" + NodeText(Child(summary, "exactActualFeeCny"), "0") + " CNY\n是否确认写入？";
	}

	private static string CaptureCompleteSummary(JsonNode? result)
	{
		string order = NodeText(Child(result, "purchaseOrderNumber"));
		return string.IsNullOrWhiteSpace(order)
			? "采购信息已回填，并已完成回读校验。"
			: "采购信息已回填，并已完成回读校验。\n采购单号：" + order;
	}

	private static string LogisticsSummary(JsonNode? result)
	{
		int total = (Child(result, "results") as JsonArray)?.Count ?? 0;
		return total > 0 ? "\n共返回 " + total + " 条记录。" : string.Empty;
	}

	private static string TranslateStatus(string value, string fallback)
	{
		return value switch
		{
			"ready" => "就绪",
			"hidden" => "已隐藏",
			"opening" => "打开中",
			"closing" => "关闭中",
			"crashed" => "异常",
			_ => string.IsNullOrWhiteSpace(value) ? fallback : value
		};
	}

	private static string TranslateHealth(string value, string fallback)
	{
		return value switch
		{
			"healthy" => "正常",
			"unhealthy" => "异常",
			_ => string.IsNullOrWhiteSpace(value) ? fallback : value
		};
	}

	private static string FriendlyError(string code)
	{
		return code switch
		{
			"PURCHASE_BROWSER_TARGET_REQUIRED" => "请先在拍单管理中锁定目标订单。",
			"PURCHASE_BROWSER_CAPTURE_EMPTY" => "当前页面没有可识别的采购信息，请进入商品或订单详情页。",
			"PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY" => "商品页面仍在加载，请稍候后重新采集。",
			"PURCHASE_BROWSER_PRODUCT_CAPTURE_INCOMPLETE" => "商品资料还没有读取完整，请等待商品主图和规格加载后重试。",
			"PURCHASE_BROWSER_COMMAND_TIMEOUT" => "商品页面读取超时，请确认页面加载完成后重试。",
			"PURCHASE_BROWSER_LOGIN_STATUS_SERVICE_UNAVAILABLE" => "本地账号状态服务尚未就绪，请重启软件后重试。",
			"PURCHASE_BROWSER_LOGIN_READBACK_FAILED" => "登录信息已经保存，但本地回读校验失败，请重新保存。",
			"PURCHASE_BROWSER_INTEGRATION_LOGIN_READBACK_FAILED" => "Ozon 登录信息已保存，但本地账号状态回读异常，请返回店铺设置后重新登录。",
			"PURCHASE_BROWSER_ACCOUNT_NOT_FOUND" => "当前采购账号已不存在，请关闭窗口并重新选择账号。",
			"PURCHASE_BROWSER_OWNER_NOT_FOUND" => "当前浏览器账号归属已失效，请关闭窗口后从软件中重新打开。",
			"CROSS_BORDER_LOGIN_REQUIRED" => "跨境巴士尚未登录，请先登录。",
			"CROSS_BORDER_CHARGE_PAGE_REQUIRED" => "请先点击“实际扣费”打开跨境巴士，并停在要读取的预报费用页面。",
			"CROSS_BORDER_CHARGE_PAGE_CONTEXT_NOT_READY" => "消费日志页面仍在加载，请等待表格显示后再点击“保存生效”。",
			"CROSS_BORDER_CHARGE_PAGE_CONTEXT_FAILED" => "消费日志筛选条件读取失败，请刷新页面后重试。",
			"CROSS_BORDER_CHARGE_PAGINATION_INCOMPLETE" => "消费日志没有完整翻到最后一页，本次未保存，请刷新页面后重试。",
			"CROSS_BORDER_CHARGE_AMOUNT_INVALID" => "消费流水有金额缺失或格式错误，本次未保存，不会把未知金额当成零费用。",
			"CROSS_BORDER_CHARGE_PAGINATION_REPEATED_PAGE" => "跨境巴士重复返回同一页，本次未保存，避免把不完整数据当成完成。",
			"CROSS_BORDER_CHARGE_LOCAL_MATCH_INCOMPLETE" => "本地订单匹配未完整结束，本次未保存，请重试。",
			"CROSS_BORDER_CHARGE_ROWS_REQUIRED" => "当前跨境巴士账号没有读取到可保存的消费流水，请检查页面筛选条件后重试。",
			"CROSS_BORDER_API_FAILED" => "跨境巴士接口返回异常，请稍后重试；这不表示账号已退出。",
			"CROSS_BORDER_NETWORK_FAILED" => "跨境巴士网络连接失败，请检查网络或代理后重试。",
			"CROSS_BORDER_RESPONSE_TOO_LARGE" => "接口单次返回超过8MiB，本次未保存，请缩小筛选范围分批读取。",
			"CROSS_BORDER_OPERATION_CANCELLED" => "操作已取消。已经发出的写入仍需回读核对，不会自动重复提交。",
			"CROSS_BORDER_REQUEST_TIMEOUT" => "跨境巴士读取超时，请刷新当前页面后重试。",
			"CROSS_BORDER_CHARGE_PREVIEW_REQUIRED" => "扣费预览已过期，请重新读取流水。",
			"CROSS_BORDER_CHARGE_CONFIRMATION_REQUIRED" => "扣费确认与当前浏览器账号不一致，请重新预览。",
			"CROSS_BORDER_CHARGE_READBACK_FAILED" => "扣费已尝试写入，但本地回读校验未通过，未标记为完成。",
			"CROSS_BORDER_CHARGE_SERVICE_UNAVAILABLE" => "本地账本服务尚未就绪，请稍后重试。",
			"PURCHASE_BROWSER_SESSION_STALE" => "浏览器会话已重置，请重新点击打开。",
			_ => code
		};
	}

	private void EmitEvent(string ownerRef, string eventName, object? state)
	{
		ProtocolWriter.TryWrite(new
		{
			type = "event",
			ownerRef = ownerRef,
			@event = eventName,
			state = state
		});
	}

	private void RemoveSession(string ownerRef)
	{
		if (!sessions.Remove(ownerRef, out var value))
		{
			return;
		}
		bool wasFollowSellerVerification = followSellerVerificationObservationOwnerRef.Equals(
			ownerRef,
			StringComparison.Ordinal);
		if (wasFollowSellerVerification)
		{
			HideFollowSellerVerificationSurface(ownerRef, fenceVisibility: false);
		}
		browserPanel.Controls.Remove(value.Browser);
		workbenchPresentations.Remove(ownerRef);
		value.Dispose();
		ReleaseRequestContext(value.Profile.StorageRef);
		if (activeOwnerRef == ownerRef)
		{
			activeOwnerRef = sessions
				.Where(static session => !session.Value.Profile.Background)
				.Select(static session => session.Key)
				.FirstOrDefault() ?? string.Empty;
			if (activeOwnerRef.Length > 0)
			{
				ActivateSession(activeOwnerRef);
			}
			else
			{
				if (wasFollowSellerVerification)
				{
					HideFollowSellerVerificationSurface(ownerRef, fenceVisibility: true);
				}
				else
				{
					HideBrowser();
				}
			}
		}
	}

	private async Task<object?> ShutdownSessionsAsync()
	{
		Task releases = await UiAsync(() =>
		{
			shutdownRequested = true;
			return pendingLaunches.CancelAll();
		}).ConfigureAwait(false);
		await releases.ConfigureAwait(false);
		return await UiAsync<object?>(() => { CloseForShutdown(); return new { ok = true }; }).ConfigureAwait(false);
	}

	public void CloseForShutdown()
	{
		if (closingForShutdown)
		{
			return;
		}
		closingForShutdown = true;
		_ = pendingLaunches.CancelAll();
		followSellerVerificationObservationOwnerRef = string.Empty;
		actionStatusTimer.Stop();
		actionStatusTimer.Dispose();
		if (extensionManagerForm is { IsDisposed: false }) extensionManagerForm.Close();
		extensionManagerForm = null;
		foreach (BrowserSession value in sessions.Values)
		{
			value.Dispose();
		}
		sessions.Clear();
		foreach (SharedRequestContext shared in requestContexts.Values)
		{
			shared.Preferences.Close();
			shared.Context.Dispose();
		}
		requestContexts.Clear();
		Close();
	}

	private void NavigateFromAddress()
	{
		string text = addressBox.Text.Trim();
		if (text.Length != 0)
		{
			if (!text.Contains("://", StringComparison.Ordinal))
			{
				text = "https://" + text;
			}
			text = BrowserUrlPolicy.NormalizePinduoduoTopLevelUrl(text);
			if (BrowserUrlPolicy.IsAllowed(text, extensions))
			{
				Active?.Browser.LoadUrl(text);
			}
		}
	}

	private void NavigatePinduoduo(string path)
	{
		BrowserSession? session = Active;
		if (session == null
			|| !session.Profile.PlatformKey.Equals("pinduoduo", StringComparison.OrdinalIgnoreCase))
		{
			return;
		}
		string safePath = string.IsNullOrWhiteSpace(path) || !path.StartsWith("/", StringComparison.Ordinal)
			? "/"
			: path;
		session.Browser.LoadUrl("https://mobile.yangkeduo.com" + safePath);
	}

	private void UpdateNavigation(BrowserSession session)
	{
		backButton.Enabled = session.CanGoBack;
		forwardButton.Enabled = session.CanGoForward;
		reloadButton.Text = (session.IsLoading ? StopGlyph : ReloadGlyph);
	}

	private void ToggleMaximize()
	{
		if (embeddedMode) return;
		if (customMaximized)
		{
			customMaximized = false;
			base.WindowState = FormWindowState.Normal;
			base.Bounds = lastBounds;
			return;
		}
		if (base.WindowState == FormWindowState.Minimized)
		{
			base.WindowState = FormWindowState.Normal;
		}
		if (base.Visible && base.Width > 0 && base.Height > 0)
		{
			lastBounds = base.Bounds;
			hasUserBounds = true;
		}
		customMaximized = true;
		applyingBounds = true;
		try
		{
			base.WindowState = FormWindowState.Normal;
			base.Bounds = WorkingAreaBounds();
		}
		finally
		{
			applyingBounds = false;
		}
	}

	private void OpenExtensionManager()
	{
		if (extensionManagerForm is { IsDisposed: false })
		{
			extensionManagerForm.Show();
			extensionManagerForm.Activate();
			return;
		}
		extensionManagerForm = new BrowserExtensionManagerForm(
			extensions,
			loadedExtensions,
			package => Active?.OpenExtensionUi(package));
		extensionManagerForm.FormClosed += delegate
		{
			extensionManagerForm?.Dispose();
			extensionManagerForm = null;
		};
		if (embeddedMode) extensionManagerForm.Show();
		else extensionManagerForm.Show(this);
	}

	internal bool ExtensionRequiresRestart(BrowserExtensionPackage package)
	{
		loadedExtensions.TryGetValue(package.Id, out BrowserExtensionPackage? loaded);
		return package.RuntimeState(loaded) != "已启用";
	}

	public void OnDownloadChanged(string ownerRef, DownloadProgressInfo state)
	{
		if (base.IsDisposed) return;
		if (base.InvokeRequired)
		{
			BeginInvoke(delegate { OnDownloadChanged(ownerRef, state); });
			return;
		}
		downloadStatusLabel.Visible = true;
		if (state.Complete)
		{
			completedDownloadPath = state.Path;
			downloadStatusLabel.Text = $"下载完成：{state.FileName}";
		}
		else if (state.Cancelled)
		{
			completedDownloadPath = string.Empty;
			downloadStatusLabel.Text = $"已取消下载：{state.FileName}";
		}
		else if (state.Interrupted)
		{
			completedDownloadPath = string.Empty;
			downloadStatusLabel.Text = $"下载失败：{state.FileName}";
		}
		else
		{
			completedDownloadPath = string.Empty;
			downloadStatusLabel.Text = state.Progress >= 0
				? $"正在下载：{state.Progress}%"
				: "正在下载…";
		}
		EmitEvent(ownerRef, "download", state);
	}

	private Rectangle WorkingAreaBounds()
	{
		try
		{
			return Screen.FromHandle(base.Handle).WorkingArea;
		}
		catch
		{
			return Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 720);
		}
	}

	private static bool IsStandaloneBoundsVisible(Rectangle bounds)
	{
		return IsStandaloneBoundsVisible(bounds, compact: false);
	}

	private static bool IsStandaloneBoundsVisible(Rectangle bounds, bool compact)
	{
		if (bounds.Width < (compact ? 440 : 640) || bounds.Height < 480) return false;
		return Screen.AllScreens.Any(screen =>
		{
			Rectangle visible = Rectangle.Intersect(screen.WorkingArea, bounds);
			return visible.Width >= 160 && visible.Height >= 80;
		});
	}

	private Rectangle RecoverStandaloneBounds(Rectangle candidate)
	{
		return RecoverStandaloneBounds(candidate, compactStandaloneMode);
	}

	private Rectangle RecoverStandaloneBounds(Rectangle candidate, bool compact)
	{
		if (IsStandaloneBoundsVisible(candidate, compact)) return candidate;
		Rectangle workArea = WorkingAreaBounds();
		int minimumWidth = compact ? 520 : 960;
		int width = Math.Min(Math.Max(candidate.Width, minimumWidth), Math.Max(minimumWidth, workArea.Width));
		int height = Math.Min(Math.Max(candidate.Height, 620), Math.Max(620, workArea.Height));
		return new Rectangle(
			workArea.Left + Math.Max(0, (workArea.Width - width) / 2),
			workArea.Top + Math.Max(0, (workArea.Height - height) / 2),
			width,
			height);
	}

	private void DragWindow(object? sender, MouseEventArgs args)
	{
		if (args.Button == MouseButtons.Left)
		{
			NativeMethods.ReleaseCapture();
			NativeMethods.SendMessage(base.Handle, 161, new IntPtr(2), IntPtr.Zero);
		}
	}

	private static Button WindowButton(string text, Color hover, EventHandler click, bool danger = false)
	{
		Button button = new Button
		{
			Text = text,
			Width = 48,
			Height = 42,
			Dock = DockStyle.Right,
			FlatStyle = FlatStyle.Flat,
			BackColor = Color.Transparent,
			ForeColor = Color.FromArgb(105, 119, 143),
			Font = new Font("Segoe MDL2 Assets", 10.5f),
			TextAlign = ContentAlignment.MiddleCenter,
			Cursor = Cursors.Hand,
			TabStop = false
		};
		button.FlatAppearance.BorderSize = 0;
		button.FlatAppearance.MouseOverBackColor = hover;
		button.MouseEnter += delegate
		{
			button.BackColor = hover;
			if (danger)
			{
				button.ForeColor = Color.White;
			}
		};
		button.MouseLeave += delegate
		{
			button.BackColor = Color.Transparent;
			button.ForeColor = Color.FromArgb(105, 119, 143);
		};
		button.Click += click;
		return button;
	}

	private static Button ToolbarButton(string text, EventHandler click)
	{
		Button button = new Button();
		button.Text = text;
		button.Width = 46;
		button.Height = 36;
		button.FlatStyle = FlatStyle.Flat;
		button.BackColor = Color.Transparent;
		button.ForeColor = Color.FromArgb(76, 94, 122);
		button.Font = new Font("Segoe MDL2 Assets", 11f);
		button.TextAlign = ContentAlignment.MiddleCenter;
		button.Cursor = Cursors.Hand;
		button.TabStop = false;
		button.FlatAppearance.BorderSize = 0;
		button.Click += click;
		return button;
	}

	private static int MeasureLineHeight(Font font)
	{
		return TextRenderer.MeasureText(
			"Ag国",
			font,
			new Size(int.MaxValue, int.MaxValue),
			TextFormatFlags.NoPadding | TextFormatFlags.SingleLine).Height;
	}

	private static FlowLayoutPanel ToolbarActionGroup(string title, Color accent, params Button[] buttons)
	{
		FlowLayoutPanel group = new FlowLayoutPanel
		{
			AutoSize = true,
			AutoSizeMode = AutoSizeMode.GrowAndShrink,
			WrapContents = false,
			FlowDirection = FlowDirection.LeftToRight,
			BackColor = Color.White,
			BorderStyle = BorderStyle.FixedSingle,
			Padding = new Padding(1),
			Margin = new Padding(0, 0, 5, 0)
		};
		Label label = new Label
		{
			Text = title,
			AutoSize = true,
			BackColor = Color.FromArgb(247, 249, 253),
			ForeColor = accent,
			Font = new Font("Microsoft YaHei UI", 8f, FontStyle.Bold),
			Padding = new Padding(6, 6, 6, 6),
			Margin = Padding.Empty,
			TextAlign = ContentAlignment.MiddleCenter
		};
		group.Controls.Add(label);
		foreach (Button button in buttons)
		{
			button.BackColor = Color.White;
			button.ForeColor = accent;
			button.Margin = Padding.Empty;
			button.FlatAppearance.MouseOverBackColor = Color.FromArgb(242, 246, 255);
			button.FlatAppearance.MouseDownBackColor = Color.FromArgb(232, 239, 252);
			group.Controls.Add(button);
		}
		return group;
	}

	private Button ActionButton(string text, string action)
	{
		Button button = new Button();
		button.Text = text;
		button.AutoSize = true;
		button.Height = 32;
		button.FlatStyle = FlatStyle.Flat;
		button.BackColor = Color.FromArgb(238, 243, 255);
		button.ForeColor = Color.FromArgb(76, 115, 215);
		button.Font = new Font("Microsoft YaHei UI", 9f);
		button.Margin = Padding.Empty;
		button.Padding = new Padding(7, 0, 7, 0);
		button.Cursor = Cursors.Hand;
		button.FlatAppearance.BorderSize = 0;
		button.Click += delegate
		{
			HandleAction(action);
		};
		return button;
	}

	private Button LocalActionButton(string text, Action action)
	{
		Button local = new()
		{
			Text = text,
			AutoSize = true,
			Height = 32,
			FlatStyle = FlatStyle.Flat,
			BackColor = Color.FromArgb(238, 243, 255),
			ForeColor = Color.FromArgb(76, 115, 215),
			Font = new Font("Microsoft YaHei UI", 9f),
			Margin = Padding.Empty,
			Padding = new Padding(7, 0, 7, 0),
			Cursor = Cursors.Hand
		};
		local.FlatAppearance.BorderSize = 0;
		local.Click += delegate { action(); };
		return local;
	}

	private Task<T> UiAsync<T>(Func<T> action)
	{
		if (!base.InvokeRequired)
		{
			return Task.FromResult(action());
		}
		TaskCompletionSource<T> completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
		BeginInvoke(delegate
		{
			try
			{
				completion.TrySetResult(action());
			}
			catch (Exception exception)
			{
				completion.TrySetException(exception);
			}
		});
		return completion.Task;
	}

	private static int Integer(JsonObject? value, string name, int fallback)
	{
		try
		{
			return value?[name]?.GetValue<int>() ?? fallback;
		}
		catch
		{
			return fallback;
		}
	}

	private static long LongInteger(JsonObject? value, string name, long fallback)
	{
		try
		{
			return value?[name]?.GetValue<long>() ?? fallback;
		}
		catch
		{
			return fallback;
		}
	}

	private static bool Boolean(JsonObject value, string name)
	{
		try
		{
			return value[name]?.GetValue<bool>() ?? false;
		}
		catch
		{
			return false;
		}
	}
}
