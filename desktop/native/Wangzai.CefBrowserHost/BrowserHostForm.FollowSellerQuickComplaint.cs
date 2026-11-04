using System.Drawing;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using CefSharp;
using CefSharp.DevTools;
using CefSharp.DevTools.Input;
using CefSharp.DevTools.Page;
using CefSharp.WinForms;

namespace Wangzai.CefBrowserHost;

internal sealed partial class BrowserHostForm
{
	private const string OzonSellerQuickComplaintUrl = "https://seller.ozon.ru/app/messenger?channel=SCRM";
	private const string OzonSellerQuickComplaintStartUrl = "https://seller.ozon.ru/app/dashboard/main";
	private static readonly string[] QuickComplaintTransportCookieNames =
	[
		"__Secure-sid",
		"__Secure-sso-state",
		"__Secure-token",
		"__Secure-ETC",
	];
	private const string QuickPreparedEvidenceLedgerName = "scheme1-prepared-evidence.json";
	private const string QuickPromptReplayStateLedgerName = "scheme1-prompt-replay-state.json";
	private const string QuickComplaintPageAdapterExpression = """
(() => {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = node => !!node && node.getClientRects().length > 0
    && getComputedStyle(node).visibility !== 'hidden';
  const inputSelector = 'textarea,input:not([type="file"]):not([type="hidden"]):not([type="button"]):not([type="submit"]),[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
  const sendSelector = 'button[type="submit"],button[aria-label*="send" i],button[aria-label*="отправ" i],button[aria-label*="发送" i],[role="button"][data-testid*="send" i]';
  const composer = () => document.querySelector('[current-chat-id]');
  const conversation = root => (root || composer())?.parentElement || null;
  const input = root => {
    const host = root || composer();
    if (!host) return null;
    return [
      ...(host.matches?.(inputSelector) ? [host] : []),
      ...host.querySelectorAll(inputSelector),
    ].find(node => visible(node) && !node.disabled && !node.readOnly
      && node.getAttribute?.('aria-disabled') !== 'true') || null;
  };
  const inputText = node => clean(node ? node.value ?? node.innerText ?? node.textContent ?? '' : '');
  const sendButton = root => {
    const host = root || composer();
    if (!host) return null;
    return [...host.querySelectorAll(sendSelector)]
      .filter(node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true')
      .at(-1) || null;
  };
  const cloneHistory = root => {
    const host = root || composer();
    const chat = conversation(host);
    const history = chat?.cloneNode(true) || null;
    history?.querySelector('[current-chat-id]')?.remove();
    return history;
  };
  const historyText = root => clean(cloneHistory(root)?.innerText || '');
  const ticketNumber = value => {
    const normalized = clean(value);
    const match = normalized.match(/(?:№|#)\s*([0-9]{6,20})|(?:新请求|请求|request|обращение)\s*(?:№|#)?\s*([0-9]{6,20})/iu);
    return match?.[1] || match?.[2] || '';
  };
	const freshRequestNumber = value => {
	  const normalized = clean(value);
	  const match = normalized.match(/(?:新请求|new\s+request|новое\s+обращение)\s*(?:№|#)?\s*([0-9]{6,20})/iu);
	  return match?.[1] || '';
	};
  const ticketId = root => {
    const chat = root || conversation();
    if (!chat) return '';
    const legacy = chat.querySelector('.m9d-o7');
    const legacyText = clean(legacy?.innerText || legacy?.textContent || '');
    const legacyId = ticketNumber(legacyText) || legacyText.match(/[0-9]{6,20}/)?.[0] || '';
    if (legacyId) return legacyId;
    const resolveFrom = nodes => [...new Set(nodes)]
      .filter(visible)
      .sort((left, right) => clean(left.innerText || left.textContent).length
        - clean(right.innerText || right.textContent).length)
      .map(node => ticketNumber(node.innerText || node.textContent))
      .find(Boolean) || '';
    const semanticId = resolveFrom(chat.querySelectorAll(
      '[data-testid*="ticket" i],[data-test*="ticket" i],[class*="ticket" i],[class*="request" i],[role="heading"],h1,h2,h3'
    ));
    return semanticId || resolveFrom(chat.querySelectorAll('*'));
  };
	const freshRequestTicketId = root => {
	  const chat = root || conversation();
	  if (!chat) return '';
	  const resolveFrom = nodes => [...new Set(nodes)]
	    .filter(visible)
	    .sort((left, right) => clean(left.innerText || left.textContent).length
	      - clean(right.innerText || right.textContent).length)
	    .map(node => freshRequestNumber(node.innerText || node.textContent))
	    .find(Boolean) || '';
	  const semanticId = resolveFrom(chat.querySelectorAll(
	    '[data-testid*="ticket" i],[data-test*="ticket" i],[class*="ticket" i],[class*="request" i],[role="heading"],h1,h2,h3'
	  ));
	  return semanticId || resolveFrom(chat.querySelectorAll('*'));
	};
  return { clean, visible, inputSelector, sendSelector, composer, conversation, input, inputText,
	  sendButton, cloneHistory, historyText, ticketNumber, ticketId, freshRequestTicketId };
})()
""";
	private ChromiumWebBrowser? activeFollowSellerQuickBrowser;
	private string activeFollowSellerQuickOwnerRef = string.Empty;
	private string activeFollowSellerQuickEvidenceId = string.Empty;

	private sealed record QuickComplaintImage(string Name, string Path, string Sha256);
	private sealed record QuickEvidenceFollower(string Sku, string ProductLink);
	private sealed record QuickFollowerPageReview(bool IsLive, string ScreenshotPath);
	private sealed record QuickPromptReplayState(
		string TicketId,
		string PromptText,
		string AnswerAction,
		int ReplayCount);
	private sealed record QuickSupplementSubmissionResult(
		string BeforeScreenshot,
		bool MessageSent,
		bool ResidualTextCleared,
		bool BatchPromptObserved);
	private sealed record QuickBundleSubmissionReadback(
		bool MessageSent,
		bool AttachmentsSent,
		bool ResidualTextSent,
		bool BatchPromptObserved);
	private sealed record QuickEvidenceScreenshots(
		string OwnProductPage,
		string OwnSellerList,
		string[] FollowerProductPages,
		string ListingDate,
		QuickEvidenceFollower[] LiveFollowers,
		string[] ExcludedFollowerSkus);
	private sealed class QuickTransitionGuard(TimeSpan minimumDuration, int minimumReads)
	{
		private DateTime? firstObservedAt;
		private int consecutiveReads;

		public bool IsConfirmed(bool observed)
		{
			if (!observed)
			{
				Reset();
				return false;
			}
			firstObservedAt ??= DateTime.UtcNow;
			consecutiveReads += 1;
			return consecutiveReads >= minimumReads
				&& DateTime.UtcNow - firstObservedAt.Value >= minimumDuration;
		}

		public void Reset()
		{
			firstObservedAt = null;
			consecutiveReads = 0;
		}
	}

	public async Task<object> SubmitOzonFollowSellerQuickComplaintAsync(
		ChromiumWebBrowser sessionBrowser,
		BrowserProfile profile,
		IRequestContext requestContext,
		JsonObject payload)
	{
		string evidenceId = RequiredComplaintText(payload["evidenceId"], "FOLLOW_SELLER_EVIDENCE_ID_REQUIRED", 160);
		string progressToken = payload["progressToken"]?.GetValue<string>()?.Trim() ?? string.Empty;
		if (progressToken.Length > 200
			|| (progressToken.Length > 0 && !Regex.IsMatch(progressToken, "^[A-Za-z0-9:_-]+$", RegexOptions.CultureInvariant)))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PROGRESS_TOKEN_INVALID");
		}
		string originalSku = RequiredComplaintText(payload["originalSku"], "FOLLOW_SELLER_SCHEME1_ORIGINAL_SKU_REQUIRED", 30);
		string offerId = RequiredComplaintText(payload["offerId"], "FOLLOW_SELLER_SCHEME1_OFFER_ID_REQUIRED", 160);
		JsonObject? speech = payload["speech"] as JsonObject;
		string initialEvidenceText = RequiredComplaintText(
			speech?["initialEvidenceRu"] ?? speech?["ru"],
			"FOLLOW_SELLER_SCHEME1_INITIAL_MESSAGE_REQUIRED",
			1000);
		string supplementText = RequiredComplaintText(
			speech?["supplementRu"],
			"FOLLOW_SELLER_SCHEME1_SUPPLEMENT_MESSAGE_REQUIRED",
			1000);
		if (!supplementText.Contains("{{LISTING_DATE}}", StringComparison.Ordinal))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_SUPPLEMENT_DATE_SLOT_REQUIRED");
		}
		string followerBatchText = RequiredComplaintText(
			speech?["followerBatchRu"],
			"FOLLOW_SELLER_SCHEME1_FOLLOWER_BATCH_REQUIRED",
			1000);
		string materialDirectory = Path.GetFullPath(RequiredComplaintText(payload["materialDirectory"], "FOLLOW_SELLER_SCHEME1_DIRECTORY_REQUIRED", 1000));
		if (!Directory.Exists(materialDirectory)
			|| !materialDirectory.Contains($"{Path.DirectorySeparatorChar}follow-seller-evidence{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_DIRECTORY_FORBIDDEN");
		}
		string sourceProductUrl = RequiredComplaintText(payload["sourceProductUrl"], "FOLLOW_SELLER_SCHEME1_PRODUCT_URL_REQUIRED", 1000);
		if (!Uri.TryCreate(sourceProductUrl, UriKind.Absolute, out Uri? sourceUri)
			|| sourceUri.Scheme != Uri.UriSchemeHttps
			|| !sourceUri.Host.EndsWith("ozon.ru", StringComparison.OrdinalIgnoreCase)
			|| !sourceProductUrl.Contains(originalSku, StringComparison.Ordinal))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PRODUCT_URL_INVALID");
		}
		string[] followerSkus = payload["followerSkus"] is JsonArray skuNodes
			? skuNodes.Select(node => node?.GetValue<string>()?.Trim() ?? string.Empty)
				.Where(value => Regex.IsMatch(value, "^[0-9]{5,20}$", RegexOptions.CultureInvariant))
				.Distinct(StringComparer.Ordinal)
				.ToArray()
			: [];
		if (followerSkus.Length == 0) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_FOLLOWER_SKU_REQUIRED");
		QuickEvidenceFollower[] followers = ParseQuickFollowers(payload, followerSkus);
		QuickEvidenceFollower[] evidenceFollowers = ParseQuickEvidenceFollowers(payload, followerSkus);
		QuickComplaintImage[] images = ParseQuickComplaintImages(payload, materialDirectory);
		bool resumeExisting = payload["resumeExisting"]?.GetValue<bool>() == true;
		bool reusePreparedEvidence = payload["reusePreparedEvidence"]?.GetValue<bool>() == true;
		string resumeTicketId = payload["resumeTicketId"]?.GetValue<string>()?.Trim() ?? string.Empty;
		string resumePageUrl = payload["resumePageUrl"]?.GetValue<string>()?.Trim() ?? string.Empty;
		string resumePhase = payload["resumePhase"]?.GetValue<string>()?.Trim() ?? string.Empty;
		bool stopBeforeFirstMessage = payload["stopBeforeFirstMessage"]?.GetValue<bool>() == true;
		bool stopAfterRepeatedPromptDetection = payload["stopAfterRepeatedPromptDetection"]?.GetValue<bool>() == true;
		if (resumeExisting)
		{
			if (!Regex.IsMatch(resumeTicketId, "^[0-9]{6,20}$", RegexOptions.CultureInvariant)
				|| !Uri.TryCreate(resumePageUrl, UriKind.Absolute, out Uri? resumeUri)
				|| resumeUri.Scheme != Uri.UriSchemeHttps
				|| !resumeUri.Host.Equals("seller.ozon.ru", StringComparison.OrdinalIgnoreCase)
				|| !resumeUri.AbsolutePath.StartsWith("/app/messenger", StringComparison.OrdinalIgnoreCase))
			{
				throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_CONTINUATION_INVALID");
			}
		}
		return await SubmitOzonFollowSellerQuickComplaintCoreAsync(
			sessionBrowser,
			profile,
			requestContext,
			evidenceId,
			progressToken,
			originalSku,
			offerId,
			followerSkus,
			followers,
			evidenceFollowers,
			initialEvidenceText,
			supplementText,
			followerBatchText,
			sourceProductUrl,
			materialDirectory,
			reusePreparedEvidence,
			resumeExisting,
			resumeTicketId,
			resumePageUrl,
			resumePhase,
			stopBeforeFirstMessage,
			stopAfterRepeatedPromptDetection,
			images).ConfigureAwait(false);
	}

	private Task<object> SubmitOzonFollowSellerQuickComplaintCoreAsync(
		ChromiumWebBrowser sessionBrowser,
		BrowserProfile profile,
		IRequestContext requestContext,
		string evidenceId,
		string progressToken,
		string originalSku,
		string offerId,
		string[] followerSkus,
		QuickEvidenceFollower[] followers,
		QuickEvidenceFollower[] evidenceFollowers,
		string initialEvidenceText,
		string supplementText,
		string followerBatchText,
		string sourceProductUrl,
		string materialDirectory,
		bool reusePreparedEvidence,
		bool resumeExisting,
		string resumeTicketId,
		string resumePageUrl,
		string resumePhase,
		bool stopBeforeFirstMessage,
		bool stopAfterRepeatedPromptDetection,
		QuickComplaintImage[] images)
	{
		TaskCompletionSource<object> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
		ChromiumWebBrowser? browser = sessionBrowser;
		System.Threading.Timer? timeout = null;
		int settled = 0;
		int started = 0;
		int submissionStarted = 0;
		int conversationRefreshAttempts = 0;
		bool conversationTransportRecoveryAttempted = false;
		bool conversationNavigationRecoveryAttempted = false;
		DateTime conversationNavigationRecoveryAt = DateTime.MinValue;
		int ticketSearchAttempts = 0;
		int ticketRestoreAttempts = 0;
		int ticketHistoryLoadAttempts = 0;
		string lastProgressKey = string.Empty;
		string lastTicketId = resumeTicketId;
		string lastPageUrl = resumePageUrl;
		string lastPhase = resumePhase;
		string lastStage = "prepare-evidence";

		if (InvokeRequired) BeginInvoke(Create);
		else Create();
		return completion.Task;

		void Create()
		{
			try
			{
				ReportOnce("browser-starting", "正在复用本店方案1专用浏览器");
				if (browser is null || browser.IsDisposed)
				{
					throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BROWSER_CLOSED");
				}
				activeFollowSellerQuickBrowser = browser;
				activeFollowSellerQuickOwnerRef = profile.OwnerRef;
				activeFollowSellerQuickEvidenceId = evidenceId;
				ReportOnce("browser-surface-ready", "方案1内置浏览器已经就绪，可点击“可视化操作页面”查看实时页面");
				timeout = new System.Threading.Timer(
					_ => Fail("FOLLOW_SELLER_SCHEME1_BROWSER_TIMEOUT"),
					null,
					TimeSpan.FromSeconds(600),
					Timeout.InfiniteTimeSpan);
				if (Interlocked.CompareExchange(ref started, 1, 0) == 0) _ = Task.Run(RunAsync);
			}
			catch
			{
				Fail("FOLLOW_SELLER_SCHEME1_BROWSER_CREATE_FAILED");
			}
		}

		async Task RunAsync()
		{
			string stage = "prepare-evidence";
			JsonObject? lastState = null;
			QuickTransitionGuard loginTransitionGuard = new(TimeSpan.FromSeconds(8), 6);
			QuickTransitionGuard backendFailureGuard = new(TimeSpan.FromSeconds(8), 6);
			try
			{
				if (browser is null || browser.IsDisposed) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BROWSER_CLOSED");
				ReportOnce("prepare-evidence", "浏览器已经打开，正在核对商品和证据页面");
				QuickEvidenceScreenshots? preparedEvidence = reusePreparedEvidence
					? LoadQuickPreparedEvidence(
						materialDirectory,
						evidenceId,
						originalSku,
						offerId,
						sourceProductUrl,
						followers)
					: null;
				QuickEvidenceScreenshots screenshots;
				if (preparedEvidence is not null)
				{
					screenshots = preparedEvidence;
					ReportOnce("evidence-reused", $"已复用上次核对完成的证据页面：有效跟卖 SKU 共 {screenshots.LiveFollowers.Length} 个");
				}
				else
				{
					screenshots = await PrepareQuickEvidenceScreenshotsAsync(
						browser,
						profile.OwnerRef,
						originalSku,
						offerId,
						sourceProductUrl,
						followers,
						materialDirectory,
						ReportOnce).ConfigureAwait(false);
					await SaveQuickPreparedEvidenceAsync(
						materialDirectory,
						evidenceId,
						originalSku,
						offerId,
						sourceProductUrl,
						followers,
						screenshots).ConfigureAwait(false);
				}
				string[] liveFollowerSkus = screenshots.LiveFollowers.Select(item => item.Sku).ToArray();
				QuickEvidenceFollower[] liveEvidenceFollowers = screenshots.LiveFollowers.Take(3).ToArray();
				string resolvedInitialEvidenceText = BuildQuickLiveInitialEvidenceText(
					initialEvidenceText,
					images.Length,
					liveEvidenceFollowers);
				string resolvedSupplementText = supplementText.Replace(
					"{{LISTING_DATE}}",
					screenshots.ListingDate,
					StringComparison.Ordinal);
				string resolvedFollowerBatchText = BuildQuickLiveFollowerBatchText(liveFollowerSkus);
				QuickPromptReplayState promptReplayState = LoadQuickPromptReplayState(
					materialDirectory,
					evidenceId);
				string[] initialAttachmentPaths = [
					screenshots.OwnProductPage,
					.. images.Select(item => item.Path),
					.. screenshots.FollowerProductPages,
				];
				string[] initialAttachmentNames = initialAttachmentPaths
					.Select(file => Path.GetFileName(file) ?? string.Empty)
					.ToArray();
				string[] supplementAttachmentPaths = [screenshots.OwnSellerList];
				string[] supplementAttachmentNames = [Path.GetFileName(screenshots.OwnSellerList) ?? string.Empty];
				stage = resumeExisting ? "seller-resume-request" : "seller-new-request";
				ReportOnce(
					resumeExisting ? "open-existing-support" : "open-support",
					resumeExisting ? $"证据已经核对完成，正在打开上次 Ozon 工单 {resumeTicketId} 并读取断点" : "证据页面已经核对完成，正在打开 Ozon 客服");
				browser.Load(QuickComplaintEntryUrl(resumeExisting, resumePageUrl));
				await WaitForQuickNavigationAsync(browser, "seller.ozon.ru", TimeSpan.FromSeconds(25)).ConfigureAwait(false);

				string beforeScreenshot = string.Empty;
				string supplementBeforeScreenshot = string.Empty;
				string repeatedInitialBeforeScreenshot = string.Empty;
				string repeatedSupplementBeforeScreenshot = string.Empty;
				bool supplementTextSent = false;
				bool supplementResidualTextCleared = false;
				bool supplementBatchPromptObserved = false;
				DateTime deadline = DateTime.UtcNow.AddSeconds(420);
				while (DateTime.UtcNow < deadline)
				{
					if (browser.IsDisposed) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BROWSER_CLOSED");
					JsonObject state;
					try
					{
						state = await EvaluateQuickBackendComplaintStateAsync(
							browser,
							evidenceId,
							originalSku,
							liveFollowerSkus,
							resolvedInitialEvidenceText,
							resolvedSupplementText,
							resolvedFollowerBatchText,
							resumeExisting,
							resumeTicketId,
							resumePhase,
							initialAttachmentPaths.Length,
							promptReplayState.TicketId,
							promptReplayState.PromptText,
							promptReplayState.AnswerAction,
							promptReplayState.ReplayCount,
							stopAfterRepeatedPromptDetection).ConfigureAwait(false);
					}
					catch (Exception error) when (IsQuickBackendStateTransient(error))
					{
						stage = "seller-backend:browser-recovery";
						lastStage = stage;
						if (backendFailureGuard.IsConfirmed(true))
						{
							throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BROWSER_TRANSIENT_FAILED", error);
						}
						ReportOnce("browser-recovery", "Ozon 页面正在切换，内置浏览器正在自动恢复，不会提前判定失败");
						await Task.Delay(750).ConfigureAwait(false);
						continue;
					}
					backendFailureGuard.Reset();
					lastState = state;
					string status = state["status"]?.GetValue<string>() ?? string.Empty;
					stage = $"seller-backend:{status}";
					lastStage = stage;
					string action = state["action"]?.GetValue<string>() ?? string.Empty;
					string phase = state["phase"]?.GetValue<string>() ?? string.Empty;
					string stateTicketId = state["ticketId"]?.GetValue<string>()?.Trim() ?? string.Empty;
					string statePageUrl = state["url"]?.GetValue<string>()?.Trim() ?? string.Empty;
					if (stateTicketId.Length > 0) lastTicketId = stateTicketId;
					bool wrongTicketView = action is "conversation-loading"
						or "ticket-view-match"
						or "ticket-search-results"
						or "restore-ticket"
						or "restore-ticket-search";
					if (!wrongTicketView)
					{
						if (statePageUrl.Length > 0) lastPageUrl = statePageUrl;
						else if (!string.IsNullOrWhiteSpace(browser.Address)) lastPageUrl = browser.Address;
					}
					lastPhase = phase.Length > 0 ? phase : lastPhase;
					bool stalledConversationSkeleton = IsQuickConversationSkeletonStalled(
						state,
						resumeExisting,
						resumeTicketId);
					if (status == "conversation-refresh-required" || stalledConversationSkeleton)
					{
						if (Volatile.Read(ref submissionStarted) != 0)
						{
							throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_CONVERSATION_LOAD_TIMEOUT");
						}
						if (conversationRefreshAttempts >= 3)
						{
							if (!conversationTransportRecoveryAttempted)
							{
								conversationTransportRecoveryAttempted = true;
								conversationRefreshAttempts = 0;
								ReportOnce(
									"conversation-transport-recovery",
									"Ozon 客服连续刷新仍未建立聊天连接，正在重建临时客服会话；店铺登录凭证和店铺选择保持不变");
								await RefreshQuickComplaintTransportSessionAsync(requestContext).ConfigureAwait(false);
								browser.Load(OzonSellerQuickComplaintStartUrl);
								await WaitForQuickNavigationAsync(browser, "seller.ozon.ru", TimeSpan.FromSeconds(25)).ConfigureAwait(false);
								await Task.Delay(TimeSpan.FromSeconds(8)).ConfigureAwait(false);
								browser.Load(QuickComplaintEntryUrl(resumeExisting, resumePageUrl));
								await Task.Delay(TimeSpan.FromSeconds(12)).ConfigureAwait(false);
								continue;
							}
							if (!conversationNavigationRecoveryAttempted)
							{
								(double x, double y, string supportUrl) = await FindQuickSupportNavigationAsync(browser).ConfigureAwait(false);
								if (supportUrl.Length == 0 && (x < 0 || y < 0))
									throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_CONVERSATION_LOAD_TIMEOUT");
								conversationNavigationRecoveryAttempted = true;
								conversationNavigationRecoveryAt = DateTime.UtcNow;
								ReportOnce(
									"conversation-navigation-recovery",
									"Ozon 客服刷新后仍未显示对话，正在点击顶部消息入口重新建立聊天连接");
								if (supportUrl.Length > 0) browser.Load(supportUrl);
								else await DispatchQuickSessionPageClickAsync(browser, x, y).ConfigureAwait(false);
								await Task.Delay(TimeSpan.FromSeconds(8)).ConfigureAwait(false);
								continue;
							}
							if (DateTime.UtcNow - conversationNavigationRecoveryAt < TimeSpan.FromSeconds(20))
							{
								await Task.Delay(750).ConfigureAwait(false);
								continue;
							}
							throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_CONVERSATION_LOAD_TIMEOUT");
						}
						conversationRefreshAttempts += 1;
						ReportOnce(
							$"conversation-refresh:{conversationRefreshAttempts}",
							stalledConversationSkeleton
								? resumeExisting
									? $"Ozon 客服持续停留在加载页面，正在自动刷新并恢复原工单（第 {conversationRefreshAttempts}/3 次）"
									: $"Ozon 新建工单页面仍在加载，正在重新进入新建入口（第 {conversationRefreshAttempts}/3 次）"
								: resumeExisting
									? $"Ozon 客服聊天加载失败，正在自动刷新并恢复原工单（第 {conversationRefreshAttempts}/3 次）"
									: $"Ozon 新建工单页面加载失败，正在重新进入新建入口（第 {conversationRefreshAttempts}/3 次）");
						double refreshX = state["x"]?.GetValue<double>() ?? -1;
						double refreshY = state["y"]?.GetValue<double>() ?? -1;
						if (refreshX >= 0 && refreshY >= 0)
						{
							await DispatchQuickSessionPageClickAsync(browser, refreshX, refreshY).ConfigureAwait(false);
						}
						else
						{
							browser.Reload();
						}
						await Task.Delay(TimeSpan.FromSeconds(8)).ConfigureAwait(false);
						continue;
					}
					if (status == "waiting")
					{
						string waitingMessage = action == "new-request"
							? "正在等待 Ozon 建立新的客服工单"
							: action == "ticket-view-match"
								? $"Ozon 当前显示的聊天不是本次工单 {stateTicketId}，正在查找精确工单"
							: action == "ticket-search-results"
								? $"正在等待 Ozon 返回工单 {stateTicketId} 的精确搜索结果"
							: action == "ticket-view-stable"
								? $"已经切回工单 {stateTicketId}，正在确认聊天内容稳定后继续"
							: action == "route-reply"
								? "菜单已经选择，正在等待 Ozon 返回下一步"
							: phase switch
							{
								"wait-follower-prompt" => "我方 SKU 已发送，正在等待 Ozon 要求跟卖 SKU",
								"wait-evidence-prompt" => "跟卖 SKU 已发送，正在等待 Ozon 要求版权证据",
								"wait-initial-reply" => "首次图文证据已发送，正在等待 Ozon 回复",
								"wait-supplement-reply" => "补充证据已发送，正在等待 Ozon 回复",
								"submitted-awaiting-support-reply" => "全部跟卖 SKU 已发送，正在确认工单回执",
								_ => "正在等待 Ozon 显示下一步",
						};
						ReportOnce($"waiting:{action}:{phase}", waitingMessage);
						ThrowIfQuickComplaintWaitExpired(state);
					}
					if (status == "login-required")
					{
						stage = "seller-backend:login-transition";
						lastStage = stage;
						if (!loginTransitionGuard.IsConfirmed(true))
						{
							ReportOnce("login-transition", "Ozon 正在完成登录跳转，系统会稳定确认后再继续");
							await Task.Delay(550).ConfigureAwait(false);
							continue;
						}
						throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_LOGIN_REQUIRED");
					}
					loginTransitionGuard.Reset();
					if (status == "captcha")
					{
						await WaitForQuickComplaintHumanVerificationAsync(
							browser,
							profile.OwnerRef,
							ReportOnce).ConfigureAwait(false);
						continue;
					}
					if (status == "daily-limit") throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT");
					if (status == "resume-ticket-mismatch") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_RESUME_TICKET_MISMATCH");
					if (status == "repeated-prompt-limit") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_REPEATED_PROMPT_LIMIT");
					if (status == "repeated-prompt-observed")
					{
						if (!stopAfterRepeatedPromptDetection
							|| action != "initial-evidence"
							|| stateTicketId.Length == 0)
						{
							throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_REPEATED_PROMPT_OBSERVATION_INVALID");
						}
						ReportOnce(
							"repeated-prompt-observed",
							"实机验证已识别同一工单内前后两次完全相同的索要信息，已按验证要求停止，未发送任何内容");
						Succeed(new JsonObject
						{
							["ok"] = true,
							["observationOnly"] = true,
							["submissionStarted"] = false,
							["status"] = "repeated-prompt-observed",
							["evidenceId"] = evidenceId,
							["ticketId"] = stateTicketId,
							["pageUrl"] = statePageUrl.Length > 0 ? statePageUrl : browser.Address ?? string.Empty,
							["phase"] = phase,
							["action"] = action,
							["promptText"] = state["promptText"]?.GetValue<string>() ?? string.Empty,
							["replayDiagnostics"] = state["replayDiagnostics"]?.DeepClone(),
						});
						return;
					}
					if (status == "original-sku-not-found") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_ORIGINAL_SKU_NOT_FOUND");
					if (status == "follower-sku-not-found") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_FOLLOWER_SKU_NOT_FOUND");
					if (status == "materials-rejected") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_SUPPLEMENT_REJECTED");
					if (status == "ticket-history-load-required")
					{
						if (ticketHistoryLoadAttempts >= 6)
						{
							throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_INITIAL_REPLY_TIMEOUT");
						}
						ticketHistoryLoadAttempts += 1;
						ReportOnce(
							$"load-ticket-history:{ticketHistoryLoadAttempts}",
							$"当前工单较早的聊天尚未加载，正在向上读取首次证据前的机器人提示（第 {ticketHistoryLoadAttempts}/6 次）");
						double historyX = state["x"]?.GetValue<double>() ?? -1;
						double historyY = state["y"]?.GetValue<double>() ?? -1;
						double historyDelta = state["deltaY"]?.GetValue<double>() ?? 0;
						if (historyX < 0 || historyY < 0 || historyDelta <= 0)
						{
							throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_INITIAL_REPLY_TIMEOUT");
						}
						await DispatchQuickTrustedScrollAsync(browser, historyX, historyY, -historyDelta).ConfigureAwait(false);
						await Task.Delay(900).ConfigureAwait(false);
						continue;
					}
					if (status == "prompt-replay-baseline-required")
					{
						string baselinePrompt = state["promptText"]?.GetValue<string>()?.Trim() ?? string.Empty;
						if (!resumeExisting
							|| action != "initial-evidence"
							|| baselinePrompt.Length == 0
							|| stateTicketId.Length == 0
							|| (string.Equals(promptReplayState.TicketId, stateTicketId, StringComparison.Ordinal)
								&& promptReplayState.AnswerAction == "initial-evidence"))
						{
							throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PROMPT_REPLAY_STATE_INVALID");
						}
						ReportOnce(
							"restore-prompt-replay-baseline",
							"检测到旧工单缺少重复提示记录，已从当前精确工单的完整聊天顺序恢复一次性重发基线");
						promptReplayState = await SaveQuickPromptReplayStateAsync(
							materialDirectory,
							evidenceId,
							stateTicketId,
							baselinePrompt,
							"initial-evidence",
							0).ConfigureAwait(false);
						double restoreX = state["x"]?.GetValue<double>() ?? -1;
						double restoreY = state["y"]?.GetValue<double>() ?? -1;
						if (restoreX >= 0 && restoreY >= 0)
						{
							await DispatchQuickTrustedScrollAsync(browser, restoreX, restoreY, 100000).ConfigureAwait(false);
						}
						await Task.Delay(700).ConfigureAwait(false);
						continue;
					}
					if (status == "ticket-search-required")
					{
						if (ticketSearchAttempts >= 2)
						{
							throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_TICKET_VIEW_MISMATCH");
						}
						ticketSearchAttempts += 1;
						ReportOnce(
							$"restore-ticket-search:{ticketSearchAttempts}",
							$"客服列表中暂未显示工单 {stateTicketId}，正在按工单号精确搜索");
						double searchX = state["x"]?.GetValue<double>() ?? -1;
						double searchY = state["y"]?.GetValue<double>() ?? -1;
						await SetQuickComplaintTicketSearchAsync(browser, searchX, searchY, stateTicketId).ConfigureAwait(false);
						await Task.Delay(1000).ConfigureAwait(false);
						continue;
					}
					if (status == "navigate-required")
					{
						ReportOnce("navigate-support", "Ozon 正在切换客服页面");
						string targetUrl = state["targetUrl"]?.GetValue<string>() ?? string.Empty;
						if (!Uri.TryCreate(targetUrl, UriKind.Absolute, out Uri? targetUri)
							|| !targetUri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
							|| (!targetUri.Host.Equals("seller.ozon.ru", StringComparison.OrdinalIgnoreCase)
								&& !targetUri.Host.Equals("seller-edu.ozon.ru", StringComparison.OrdinalIgnoreCase)))
						{
							throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_ROUTE_URL_INVALID");
						}
						browser.Load(targetUrl);
						await Task.Delay(1000).ConfigureAwait(false);
						continue;
					}
					if (status == "click-required")
					{
						string clickMessage = action switch
						{
							"product-prices" => "正在选择“商品和价格”",
							"quality-control" => "正在选择“质量监督”",
							"seller-content-use" => "正在选择“卖家使用我的内容”",
							"confirm-send" => "Ozon 要求确认发送，正在确认",
							"seller-entry" => "正在进入 Ozon 卖家客服",
							"start-new-request" => "正在新建 Ozon 客服工单",
							"restore-ticket" => $"已经找到本次工单 {stateTicketId}，正在切回并核对聊天内容",
							_ => "正在选择 Ozon 客服的下一步",
						};
						ReportOnce($"select:{action}", clickMessage);
						double x = state["x"]?.GetValue<double>() ?? -1;
						double y = state["y"]?.GetValue<double>() ?? -1;
						if (x < 0 || y < 0) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_CLICK_TARGET_INVALID");
						if (action is "product-prices" or "quality-control" or "seller-content-use")
						{
							await SetQuickComplaintRoutePendingAsync(browser, evidenceId, action).ConfigureAwait(false);
						}
						if (action == "restore-ticket" && ++ticketRestoreAttempts > 3)
						{
							throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_TICKET_VIEW_MISMATCH");
						}
						await DispatchQuickSessionPageClickAsync(browser, x, y).ConfigureAwait(false);
						await Task.Delay(900).ConfigureAwait(false);
						continue;
					}
					if (status == "route-not-found")
					{
						throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BACKEND_ROUTE_CHANGED");
					}
					if (status == "repeat-answer-required")
					{
						string repeatedAction = action;
						string repeatedPrompt = state["promptText"]?.GetValue<string>()?.Trim() ?? string.Empty;
						if (!IsQuickPromptReplayAction(repeatedAction)
							|| repeatedPrompt.Length == 0
							|| !string.Equals(promptReplayState.TicketId, stateTicketId, StringComparison.Ordinal)
							|| !string.Equals(promptReplayState.PromptText, repeatedPrompt, StringComparison.Ordinal)
							|| !string.Equals(promptReplayState.AnswerAction, repeatedAction, StringComparison.Ordinal)
							|| promptReplayState.ReplayCount != 0)
						{
							throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PROMPT_REPLAY_STATE_INVALID");
						}
						ReportOnce(
							$"repeat-answer:{repeatedAction}",
							"Ozon 机器人连续两次发送了字符完全相同的索要信息，正在把第一次回复原样重发一次");
						promptReplayState = await SaveQuickPromptReplayStateAsync(
							materialDirectory,
							evidenceId,
							stateTicketId,
							repeatedPrompt,
							repeatedAction,
							1).ConfigureAwait(false);
						if (repeatedAction is "original-sku" or "follower-sku")
						{
							string repeatedMessage = repeatedAction == "original-sku" ? originalSku : liveFollowerSkus[0];
							await TypeQuickComplaintMessageAsync(browser, repeatedMessage).ConfigureAwait(false);
							Interlocked.Exchange(ref submissionStarted, 1);
							await ClickQuickComplaintSendAsync(browser, repeatedMessage).ConfigureAwait(false);
						}
						else if (repeatedAction == "initial-evidence")
						{
							repeatedInitialBeforeScreenshot = await SubmitQuickComplaintBundleAsync(
								browser,
								initialAttachmentPaths,
								initialAttachmentNames,
								resolvedInitialEvidenceText,
								materialDirectory,
								"scheme1-initial-evidence-repeat-before.png",
								"initial-evidence-repeat",
								ReportOnce,
								() => Interlocked.Exchange(ref submissionStarted, 1)).ConfigureAwait(false);
						}
						else if (repeatedAction == "supplement-evidence")
						{
							QuickSupplementSubmissionResult repeatedSupplement = await SubmitQuickComplaintSupplementBundleAsync(
								browser,
								supplementAttachmentPaths,
								supplementAttachmentNames,
								resolvedSupplementText,
								materialDirectory,
								"scheme1-supplement-repeat-before.png",
								"supplement-evidence-repeat",
								ReportOnce,
								() => Interlocked.Exchange(ref submissionStarted, 1)).ConfigureAwait(false);
							repeatedSupplementBeforeScreenshot = repeatedSupplement.BeforeScreenshot;
							supplementTextSent = supplementTextSent || repeatedSupplement.MessageSent;
							supplementResidualTextCleared = supplementResidualTextCleared || repeatedSupplement.ResidualTextCleared;
							supplementBatchPromptObserved = supplementBatchPromptObserved || repeatedSupplement.BatchPromptObserved;
						}
						ReportOnce("repeat-answer-sent", "相同索要信息的第一次回复已原样重发一次，正在等待 Ozon 下一条回复");
						await Task.Delay(900).ConfigureAwait(false);
						continue;
					}
					if (status == "type-message-required")
					{
						if (stopBeforeFirstMessage && action == "original-sku" && stateTicketId.Length > 0)
						{
							ReportOnce(
								"route-ready-observed",
								"实机验证已进入正确投诉工单并看到机器人索要我方 SKU，已按验证要求停止，未发送任何内容");
							Succeed(new JsonObject
							{
								["ok"] = true,
								["observationOnly"] = true,
								["submissionStarted"] = false,
								["status"] = "route-ready-observed",
								["evidenceId"] = evidenceId,
								["ticketId"] = stateTicketId,
								["pageUrl"] = statePageUrl.Length > 0 ? statePageUrl : browser.Address ?? string.Empty,
								["phase"] = phase,
								["action"] = action,
								["promptText"] = state["promptText"]?.GetValue<string>() ?? string.Empty,
							});
							return;
						}
						string sendMessage = action switch
						{
							"original-sku" => $"正在发送我方商品 SKU：{originalSku}",
							"follower-sku" => $"正在发送一个跟卖 SKU：{liveFollowerSkus[0]}",
							"follower-batch" => $"Ozon 已允许批量投诉，正在发送全部 {liveFollowerSkus.Length} 个跟卖 SKU",
							"repair-initial-text" => "检测到旧工单首次证据只有图片，正在补齐首次证据说明",
							"repair-supplement-text" => "检测到旧工单补充证据只有图片，正在补齐补证说明",
							_ => "正在填写 Ozon 客服消息",
						};
						ReportOnce($"send:{action}", sendMessage);
						string message = action switch
						{
							"original-sku" => originalSku,
							"follower-sku" => liveFollowerSkus[0],
							"follower-batch" => resolvedFollowerBatchText,
							"repair-initial-text" => resolvedInitialEvidenceText,
							"repair-supplement-text" => resolvedSupplementText,
							_ => throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_MESSAGE_ACTION_INVALID"),
						};
						if (IsQuickPromptReplayAction(action))
						{
							string promptText = state["promptText"]?.GetValue<string>()?.Trim() ?? string.Empty;
							promptReplayState = await SaveQuickPromptReplayStateAsync(
								materialDirectory,
								evidenceId,
								stateTicketId,
								promptText,
								action,
								0).ConfigureAwait(false);
						}
						await TypeQuickComplaintMessageAsync(browser, message).ConfigureAwait(false);
						Interlocked.Exchange(ref submissionStarted, 1);
						await ClickQuickComplaintSendAsync(browser, message).ConfigureAwait(false);
						string nextPhase = action switch
						{
							"original-sku" => "wait-follower-prompt",
							"follower-sku" => "wait-evidence-prompt",
							"follower-batch" => "submitted-awaiting-support-reply",
							"repair-initial-text" => "resume-history",
							"repair-supplement-text" => "resume-history",
							_ => throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_MESSAGE_ACTION_INVALID"),
						};
						await SetQuickComplaintPhaseAsync(browser, evidenceId, nextPhase).ConfigureAwait(false);
						await Task.Delay(850).ConfigureAwait(false);
						continue;
					}
					if (status == "initial-evidence-required")
					{
						ReportOnce("submit-initial-evidence", $"Ozon 已要求版权证据，正在一次性发送说明和 {initialAttachmentPaths.Length} 张图片");
						promptReplayState = await SaveQuickPromptReplayStateAsync(
							materialDirectory,
							evidenceId,
							stateTicketId,
							state["promptText"]?.GetValue<string>()?.Trim() ?? string.Empty,
							"initial-evidence",
							0).ConfigureAwait(false);
						beforeScreenshot = await SubmitQuickComplaintBundleAsync(
							browser,
							initialAttachmentPaths,
							initialAttachmentNames,
							resolvedInitialEvidenceText,
							materialDirectory,
							"scheme1-initial-evidence-before.png",
							"initial-evidence",
							ReportOnce,
							() => Interlocked.Exchange(ref submissionStarted, 1)).ConfigureAwait(false);
						await SetQuickComplaintPhaseAsync(browser, evidenceId, "wait-initial-reply").ConfigureAwait(false);
						ReportOnce("initial-evidence-sent", "首次图文证据已经发送，正在等待 Ozon 回复");
						await Task.Delay(900).ConfigureAwait(false);
						continue;
					}
					if (status == "supplement-required")
					{
						ReportOnce("submit-supplement", "Ozon 提示首次材料不足，正在发送后台商品列表和上架时间");
						promptReplayState = await SaveQuickPromptReplayStateAsync(
							materialDirectory,
							evidenceId,
							stateTicketId,
							state["promptText"]?.GetValue<string>()?.Trim() ?? string.Empty,
							"supplement-evidence",
							0).ConfigureAwait(false);
						QuickSupplementSubmissionResult supplementResult = await SubmitQuickComplaintSupplementBundleAsync(
							browser,
							supplementAttachmentPaths,
							supplementAttachmentNames,
							resolvedSupplementText,
							materialDirectory,
							"scheme1-supplement-before.png",
							"supplement-evidence",
							ReportOnce,
							() => Interlocked.Exchange(ref submissionStarted, 1)).ConfigureAwait(false);
						supplementBeforeScreenshot = supplementResult.BeforeScreenshot;
						supplementTextSent = supplementResult.MessageSent;
						supplementResidualTextCleared = supplementResult.ResidualTextCleared;
						supplementBatchPromptObserved = supplementResult.BatchPromptObserved;
						await SetQuickComplaintPhaseAsync(browser, evidenceId, "wait-supplement-reply").ConfigureAwait(false);
						ReportOnce("supplement-sent", "补充证据已经发送，正在等待 Ozon 是否允许批量投诉");
						await Task.Delay(900).ConfigureAwait(false);
						continue;
					}
					if (status == "submitted")
					{
						string receiptId = state["receiptId"]?.GetValue<string>() ?? string.Empty;
						if (string.IsNullOrWhiteSpace(receiptId)) throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_RECEIPT_REQUIRED");
						ReportOnce("save-receipt", $"已取得 Ozon 工单 {receiptId}，正在保存提交截图和回执");
						string afterScreenshot = await CaptureQuickScreenshotAsync(browser, materialDirectory, "scheme1-submission-after.png").ConfigureAwait(false);
						JsonObject evidenceLedger = new()
						{
							["version"] = 2,
							["workflow"] = "ozon-seller-backend-content-complaint-v2",
							["capturedAt"] = DateTimeOffset.UtcNow.ToString("O"),
							["ticketId"] = receiptId,
							["status"] = "submitted-awaiting-support-reply",
							["messages"] = new JsonObject
							{
								["initialEvidenceRu"] = resolvedInitialEvidenceText,
								["supplementRu"] = resolvedSupplementText,
								["followerBatchRu"] = resolvedFollowerBatchText,
							},
							["originalFollowerSkus"] = new JsonArray(followerSkus.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
							["liveFollowerSkus"] = new JsonArray(liveFollowerSkus.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
							["excludedFollowerSkus"] = new JsonArray(screenshots.ExcludedFollowerSkus.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
							["supplementTextSent"] = supplementTextSent,
							["supplementResidualTextCleared"] = supplementResidualTextCleared,
							["supplementBatchPromptObserved"] = supplementBatchPromptObserved,
							["promptReplay"] = new JsonObject
							{
								["ticketId"] = promptReplayState.TicketId,
								["promptText"] = promptReplayState.PromptText,
								["answerAction"] = promptReplayState.AnswerAction,
								["replayCount"] = promptReplayState.ReplayCount,
							},
							["initialAttachmentOrder"] = new JsonArray(initialAttachmentPaths.Select(path => (JsonNode?)EvidenceFileNode(path)).ToArray()),
							["supplementAttachmentOrder"] = new JsonArray(supplementAttachmentPaths.Select(path => (JsonNode?)EvidenceFileNode(path)).ToArray()),
							["ownProductPage"] = EvidenceFileNode(screenshots.OwnProductPage),
							["ownSellerList"] = EvidenceFileNode(screenshots.OwnSellerList),
							["listingDate"] = screenshots.ListingDate,
							["followerProductPages"] = new JsonArray(screenshots.FollowerProductPages.Select(path => (JsonNode?)EvidenceFileNode(path)).ToArray()),
							["currentImages"] = new JsonArray(images.Select(image => (JsonNode?)EvidenceFileNode(image.Path)).ToArray()),
							["initialEvidenceBefore"] = EvidenceFileNode(beforeScreenshot),
							["supplementBefore"] = EvidenceFileNode(supplementBeforeScreenshot),
							["repeatedInitialEvidenceBefore"] = EvidenceFileNode(repeatedInitialBeforeScreenshot),
							["repeatedSupplementBefore"] = EvidenceFileNode(repeatedSupplementBeforeScreenshot),
							["submissionAfter"] = EvidenceFileNode(afterScreenshot),
						};
						string evidenceLedgerPath = Path.Combine(materialDirectory, "scheme1-browser-evidence.json");
						await File.WriteAllTextAsync(
							evidenceLedgerPath,
							evidenceLedger.ToJsonString(new JsonSerializerOptions { WriteIndented = true })).ConfigureAwait(false);
						Report("submitted", $"方案1已提交成功，Ozon 工单号：{receiptId}", "completed");
						Succeed(new JsonObject
						{
							["ok"] = true,
							["submissionStarted"] = true,
							["scheme"] = "scheme1-seller-backend",
							["workflow"] = "ozon-seller-backend-content-complaint-v2",
							["status"] = "submitted-awaiting-support-reply",
							["evidenceId"] = evidenceId,
							["ticketId"] = receiptId,
							["messageId"] = receiptId,
							["pageUrl"] = browser.Address ?? OzonSellerQuickComplaintUrl,
							["submittedAt"] = DateTimeOffset.UtcNow.ToString("O"),
							["originalSku"] = originalSku,
							["followerSkus"] = new JsonArray(liveFollowerSkus.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
							["originalFollowerSkus"] = new JsonArray(followerSkus.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
							["excludedFollowerSkus"] = new JsonArray(screenshots.ExcludedFollowerSkus.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
							["productPageScreenshotPath"] = screenshots.OwnProductPage,
							["productPageScreenshotSha256"] = FileSha256(screenshots.OwnProductPage),
							["sellerListScreenshotPath"] = screenshots.OwnSellerList,
							["sellerListScreenshotSha256"] = FileSha256(screenshots.OwnSellerList),
							["evidenceLedgerPath"] = evidenceLedgerPath,
							["evidenceLedgerSha256"] = FileSha256(evidenceLedgerPath),
							["beforeScreenshotPath"] = beforeScreenshot,
							["beforeScreenshotSha256"] = OptionalFileSha256(beforeScreenshot),
							["promptReplayCount"] = promptReplayState.ReplayCount,
							["supplementBeforeScreenshotPath"] = supplementBeforeScreenshot,
							["supplementBeforeScreenshotSha256"] = OptionalFileSha256(supplementBeforeScreenshot),
							["afterScreenshotPath"] = afterScreenshot,
							["afterScreenshotSha256"] = FileSha256(afterScreenshot),
						});
						return;
					}
					await Task.Delay(450).ConfigureAwait(false);
				}
				throw new InvalidOperationException(QuickComplaintTimeoutCode(lastState));
			}
			catch (Exception error)
			{
				string code = ErrorCode.From(error);
				Report("failed", "方案1没有提交完成，材料已经保留", "failed", code);
				if (browser is not null && !browser.IsDisposed)
				{
					try
					{
						await SaveQuickBackendDiagnosticAsync(browser, materialDirectory, lastState, stage, code).ConfigureAwait(false);
					}
					catch (Exception diagnosticError)
					{
						Console.Error.WriteLine($"[follow-seller-scheme1] diagnostic-failed type={diagnosticError.GetType().Name}");
					}
				}
				Console.Error.WriteLine($"[follow-seller-scheme1] failed code={code} stage={stage} type={error.GetType().Name}");
				Fail(code.StartsWith("FOLLOW_SELLER_", StringComparison.Ordinal) ? code : "FOLLOW_SELLER_SCHEME1_SUBMIT_FAILED");
			}
		}

		void Succeed(JsonObject result)
		{
			if (Interlocked.Exchange(ref settled, 1) != 0) return;
			timeout?.Dispose();
			Cleanup(() => completion.TrySetResult(result));
		}

		void Fail(string code)
		{
			if (Interlocked.Exchange(ref settled, 1) != 0) return;
			Report("failed", "方案1没有提交完成，材料已经保留", "failed", code);
			timeout?.Dispose();
			JsonObject result = new JsonObject
			{
				["ok"] = false,
				["submissionStarted"] = Volatile.Read(ref submissionStarted) == 1,
				["evidenceId"] = evidenceId,
				["ticketId"] = lastTicketId,
				["pageUrl"] = lastPageUrl.Length > 0 ? lastPageUrl : browser?.Address ?? string.Empty,
				["phase"] = lastPhase,
				["stage"] = lastStage,
				["continuationAvailable"] = lastTicketId.Length > 0
					&& (lastPageUrl.Length > 0 || !string.IsNullOrWhiteSpace(browser?.Address)),
				["error"] = new JsonObject
				{
					["code"] = code,
					["message"] = code,
				},
			};
			Cleanup(() => completion.TrySetResult(result));
		}

		void ReportOnce(string stage, string message)
		{
			string key = $"{stage}\n{message}";
			if (string.Equals(lastProgressKey, key, StringComparison.Ordinal)) return;
			lastProgressKey = key;
			Report(stage, message);
		}

		void Report(string stage, string message, string status = "running", string code = "")
		{
			if (string.IsNullOrWhiteSpace(progressToken)) return;
			ProtocolWriter.Write(new
			{
				type = "event",
				ownerRef = profile.OwnerRef,
				eventName = "follow-seller-scheme1-progress",
				@event = "follow-seller-scheme1-progress",
				progressToken,
				evidenceId,
				offerId,
				originalSku,
				stage,
				status,
				message,
				code,
				at = DateTimeOffset.UtcNow.ToString("O"),
			});
		}

		void Cleanup(Action complete)
		{
			if (InvokeRequired) BeginInvoke(() =>
			{
				Remove();
				complete();
			});
			else
			{
				Remove();
				complete();
			}
		}

		void Remove()
		{
			if (ReferenceEquals(activeFollowSellerQuickBrowser, browser))
			{
				activeFollowSellerQuickBrowser = null;
				activeFollowSellerQuickOwnerRef = string.Empty;
				activeFollowSellerQuickEvidenceId = string.Empty;
			}
			if (activeOwnerRef.Equals(profile.OwnerRef, StringComparison.Ordinal)
				&& browserPresentationVisible)
			{
				HideBrowser(fenceVisibility: false);
			}
			browser = null;
		}
	}

	private Task<object?> ShowFollowSellerQuickBrowserAsync(string ownerRef)
	{
		return UiAsync<object?>(delegate
		{
			if (activeFollowSellerQuickBrowser is null
				|| activeFollowSellerQuickBrowser.IsDisposed
				|| !activeFollowSellerQuickOwnerRef.Equals(ownerRef, StringComparison.Ordinal))
			{
				throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BROWSER_NOT_RUNNING");
			}
			string currentUrl = activeFollowSellerQuickBrowser.Address ?? string.Empty;
			if (!IsQuickComplaintOzonUrl(currentUrl))
			{
				throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BROWSER_TARGET_INVALID");
			}
			RestoreSessionForObservation(ownerRef);
			if (!activeOwnerRef.Equals(ownerRef, StringComparison.Ordinal)
				|| Active is null
				|| !ReferenceEquals(Active.Browser, activeFollowSellerQuickBrowser))
			{
				throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BROWSER_TARGET_INVALID");
			}
			return new
			{
				ok = true,
				visible = true,
				evidenceId = activeFollowSellerQuickEvidenceId,
				url = currentUrl
			};
		});
	}

	private static bool IsQuickComplaintOzonUrl(string value)
	{
		if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)) return false;
		return uri.Scheme is "http" or "https"
			&& (uri.Host.Equals("ozon.ru", StringComparison.OrdinalIgnoreCase)
				|| uri.Host.EndsWith(".ozon.ru", StringComparison.OrdinalIgnoreCase));
	}

	private static QuickComplaintImage[] ParseQuickComplaintImages(JsonObject payload, string materialDirectory)
	{
		if (payload["attachments"] is not JsonArray values || values.Count is < 1 or > 3)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_IMAGE_REQUIRED");
		}
		List<QuickComplaintImage> results = [];
		foreach (JsonNode? node in values)
		{
			if (node is not JsonObject item || item["kind"]?.GetValue<string>() != "current_image") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_IMAGE_INVALID");
			string filePath = Path.GetFullPath(RequiredComplaintText(item["path"], "FOLLOW_SELLER_SCHEME1_IMAGE_INVALID", 1000));
			string expectedHash = RequiredComplaintText(item["sha256"], "FOLLOW_SELLER_SCHEME1_IMAGE_INVALID", 64).ToLowerInvariant();
			if (!filePath.StartsWith(materialDirectory, StringComparison.OrdinalIgnoreCase)
				|| !File.Exists(filePath)
				|| !Regex.IsMatch(expectedHash, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant))
			{
				throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_IMAGE_PATH_FORBIDDEN");
			}
			byte[] bytes = File.ReadAllBytes(filePath);
			bool webp = bytes.Length >= 12 && bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8) && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8);
			bool magic = bytes.AsSpan().StartsWith(new byte[] { 0xFF, 0xD8, 0xFF })
				|| bytes.AsSpan().StartsWith(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A })
				|| bytes.AsSpan().StartsWith("GIF87a"u8) || bytes.AsSpan().StartsWith("GIF89a"u8) || webp;
			if (!magic || bytes.Length == 0 || bytes.Length > 20 * 1024 * 1024 || Sha256(bytes) != expectedHash)
			{
				throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_IMAGE_TAMPERED");
			}
			results.Add(new QuickComplaintImage(Path.GetFileName(filePath), filePath, expectedHash));
		}
		return results.ToArray();
	}

	private static QuickEvidenceFollower[] ParseQuickEvidenceFollowers(JsonObject payload, string[] followerSkus)
	{
		if (payload["evidenceFollowers"] is not JsonArray values || values.Count is < 1 or > 3)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_REQUIRED");
		}
		HashSet<string> allowedSkus = new(followerSkus, StringComparer.Ordinal);
		List<QuickEvidenceFollower> results = [];
		foreach (JsonNode? node in values)
		{
			if (node is not JsonObject item) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID");
			string sku = RequiredComplaintText(item["sku"], "FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID", 30);
			string productLink = RequiredComplaintText(item["productLink"], "FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID", 1000);
			if (!allowedSkus.Contains(sku)
				|| !Uri.TryCreate(productLink, UriKind.Absolute, out Uri? uri)
				|| uri.Scheme != Uri.UriSchemeHttps
				|| !(uri.Host.Equals("ozon.ru", StringComparison.OrdinalIgnoreCase)
					|| uri.Host.EndsWith(".ozon.ru", StringComparison.OrdinalIgnoreCase))
				|| !productLink.Contains(sku, StringComparison.Ordinal))
			{
				throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID");
			}
			results.Add(new QuickEvidenceFollower(sku, productLink));
		}
		return results.DistinctBy(item => item.Sku, StringComparer.Ordinal).ToArray();
	}

	private static QuickEvidenceFollower[] ParseQuickFollowers(JsonObject payload, string[] followerSkus)
	{
		if (payload["followers"] is not JsonArray values || values.Count < 1 || values.Count > 200)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_FOLLOWER_DATA_INCOMPLETE");
		}
		Dictionary<string, QuickEvidenceFollower> bySku = new(StringComparer.Ordinal);
		foreach (JsonNode? node in values)
		{
			if (node is not JsonObject item) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID");
			string sku = RequiredComplaintText(item["sku"], "FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID", 30);
			string productLink = RequiredComplaintText(item["productLink"], "FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID", 1000);
			if (!Regex.IsMatch(sku, "^[0-9]{5,20}$", RegexOptions.CultureInvariant)
				|| !Uri.TryCreate(productLink, UriKind.Absolute, out Uri? uri)
				|| uri.Scheme != Uri.UriSchemeHttps
				|| !(uri.Host.Equals("ozon.ru", StringComparison.OrdinalIgnoreCase)
					|| uri.Host.EndsWith(".ozon.ru", StringComparison.OrdinalIgnoreCase))
				|| !productLink.Contains(sku, StringComparison.Ordinal)
				|| !bySku.TryAdd(sku, new QuickEvidenceFollower(sku, productLink)))
			{
				throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID");
			}
		}
		if (bySku.Count != followerSkus.Length || followerSkus.Any(sku => !bySku.ContainsKey(sku)))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_FOLLOWER_DATA_INCOMPLETE");
		}
		return followerSkus.Select(sku => bySku[sku]).ToArray();
	}

	private static string BuildQuickLiveInitialEvidenceText(
		string originalMessage,
		int currentImageCount,
		QuickEvidenceFollower[] liveEvidenceFollowers)
	{
		List<string> lines = originalMessage
			.Replace("\r\n", "\n", StringComparison.Ordinal)
			.Split('\n')
			.Where(line => !Regex.IsMatch(
				line,
				@"карточка\s+(?:другого\s+)?продавца,\s*SKU",
				RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
			.ToList();
		List<string> liveLines = liveEvidenceFollowers.Select((item, index) =>
			$"Вложение {currentImageCount + index + 2} — карточка продавца, SKU {item.Sku}: https://www.ozon.ru/product/{item.Sku}/").ToList();
		int insertionIndex = lines.FindIndex(line =>
			line.Contains("Другие продавцы используют", StringComparison.OrdinalIgnoreCase)
			|| line.Contains("Наши изображения используют", StringComparison.OrdinalIgnoreCase));
		if (insertionIndex < 0) insertionIndex = lines.Count;
		lines.InsertRange(insertionIndex, liveLines);
		string result = string.Join("\n", lines).Trim();
		if (string.IsNullOrWhiteSpace(result) || result.Length > 1000)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_INITIAL_MESSAGE_TOO_LONG");
		}
		return result;
	}

	private static string BuildQuickLiveFollowerBatchText(string[] liveFollowerSkus)
	{
		string result = $"{string.Join("\n", liveFollowerSkus)}\n\nПрошу принять жалобу на перечисленные выше {liveFollowerSkus.Length} SKU.";
		if (liveFollowerSkus.Length == 0 || result.Length > 1000)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_FOLLOWER_BATCH_TOO_LONG");
		}
		return result;
	}

	private static async Task WaitForQuickBrowserReadyAsync(ChromiumWebBrowser browser, TimeSpan timeout)
	{
		DateTime deadline = DateTime.UtcNow.Add(timeout);
		while (DateTime.UtcNow < deadline)
		{
			if (!browser.IsDisposed && !browser.IsLoading && browser.CanExecuteJavascriptInMainFrame) return;
			await Task.Delay(120).ConfigureAwait(false);
		}
		throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PAGE_NOT_READY");
	}

	private static async Task WaitForQuickNavigationAsync(ChromiumWebBrowser browser, string host, TimeSpan timeout)
	{
		DateTime deadline = DateTime.UtcNow.Add(timeout);
		while (DateTime.UtcNow < deadline)
		{
			bool expectedOzonHost = host.Equals("ozon.ru", StringComparison.OrdinalIgnoreCase)
				|| host.EndsWith(".ozon.ru", StringComparison.OrdinalIgnoreCase);
			if (!browser.IsDisposed && !browser.IsLoading && browser.CanExecuteJavascriptInMainFrame
				&& Uri.TryCreate(browser.Address, UriKind.Absolute, out Uri? uri)
				&& (uri.Host.Equals(host, StringComparison.OrdinalIgnoreCase)
					|| (expectedOzonHost && (uri.Host.Equals("ozon.ru", StringComparison.OrdinalIgnoreCase)
						|| uri.Host.EndsWith(".ozon.ru", StringComparison.OrdinalIgnoreCase))))) return;
			await Task.Delay(150).ConfigureAwait(false);
		}
		throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BACKEND_NOT_READY");
	}

	private static bool IsQuickBackendStateTransient(Exception error)
	{
		if (error is TaskCanceledException) return true;
		string code = ErrorCode.From(error);
		return code is "PURCHASE_BROWSER_CEF_FAILED"
			or "FOLLOW_SELLER_SCHEME1_PAGE_SCRIPT_FAILED"
			or "FOLLOW_SELLER_SCHEME1_PAGE_STATE_INVALID";
	}

	private static void ThrowIfQuickComplaintWaitExpired(JsonObject state)
	{
		long waitStartedAt = state["waitStartedAt"]?.GetValue<long>() ?? 0;
		if (waitStartedAt <= 0) return;
		string action = state["action"]?.GetValue<string>() ?? string.Empty;
		string phase = state["phase"]?.GetValue<string>() ?? string.Empty;
		int timeoutSeconds = action switch
		{
			"new-request" or "conversation-loading" => 90,
			"route-reply" => 65,
			"ticket-view-match" or "ticket-search-results" => 12,
			_ => phase switch
			{
				"wait-initial-reply" or "wait-supplement-reply" => 120,
				"wait-follower-prompt" or "wait-evidence-prompt" => 90,
				"submitted-awaiting-support-reply" => 90,
				_ => 90,
			},
		};
		long elapsedMilliseconds = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - waitStartedAt;
		if (elapsedMilliseconds >= timeoutSeconds * 1000L)
		{
			throw new InvalidOperationException(QuickComplaintTimeoutCode(state));
		}
	}

	private static bool IsQuickConversationSkeletonStalled(
		JsonObject state,
		bool resumeExisting,
		string resumeTicketId)
	{
		if (state["status"]?.GetValue<string>() != "waiting")
		{
			return false;
		}
		string action = state["action"]?.GetValue<string>() ?? string.Empty;
		string ticketId = state["ticketId"]?.GetValue<string>()?.Trim() ?? string.Empty;
		bool exactExistingTicketSkeleton = resumeExisting
			&& action == "conversation-loading"
			&& ticketId.Length > 0
			&& ticketId.Equals(resumeTicketId, StringComparison.Ordinal);
		bool newRequestSkeleton = !resumeExisting
			&& action == "new-request"
			&& ticketId.Length == 0;
		if (!exactExistingTicketSkeleton && !newRequestSkeleton) return false;
		long waitStartedAt = state["waitStartedAt"]?.GetValue<long>() ?? 0;
		return waitStartedAt > 0
			&& DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - waitStartedAt >= 15000L;
	}

	private static string QuickComplaintTimeoutCode(JsonObject? state)
	{
		string action = state?["action"]?.GetValue<string>() ?? string.Empty;
		string phase = state?["phase"]?.GetValue<string>() ?? string.Empty;
		if (action == "new-request") return "FOLLOW_SELLER_SCHEME1_TICKET_CREATE_TIMEOUT";
		if (action == "conversation-loading") return "FOLLOW_SELLER_SCHEME1_CONVERSATION_LOAD_TIMEOUT";
		if (action is "ticket-view-match" or "ticket-search-results") return "FOLLOW_SELLER_SCHEME1_TICKET_VIEW_MISMATCH";
		if (action == "route-reply" || phase == "route") return "FOLLOW_SELLER_SCHEME1_ROUTE_REPLY_TIMEOUT";
		return phase switch
		{
			"wait-follower-prompt" => "FOLLOW_SELLER_SCHEME1_FOLLOWER_PROMPT_TIMEOUT",
			"wait-evidence-prompt" => "FOLLOW_SELLER_SCHEME1_EVIDENCE_PROMPT_TIMEOUT",
			"wait-initial-reply" => "FOLLOW_SELLER_SCHEME1_INITIAL_REPLY_TIMEOUT",
			"wait-supplement-reply" => "FOLLOW_SELLER_SCHEME1_SUPPLEMENT_REPLY_TIMEOUT",
			"submitted-awaiting-support-reply" => "FOLLOW_SELLER_SCHEME1_RECEIPT_CONFIRM_TIMEOUT",
			_ => "FOLLOW_SELLER_SCHEME1_STAGE_TIMEOUT",
		};
	}

	private static async Task<JsonObject> EvaluateQuickProductPageAsync(ChromiumWebBrowser browser, string sku)
	{
		string skuJson = JsonSerializer.Serialize(sku);
		string script = $$"""
(() => {
  const sku = {{skuJson}};
  const body = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const url = String(location.href || '');
  if (/captcha|капч|подтвердите, что вы не робот|验证码|人机验证/i.test(body)) return JSON.stringify({ status: 'captcha' });
	  if (/403 forbidden|access denied|err_(?:connection|timed_out|proxy)|无法访问此网站|拒绝访问/i.test(body)) return JSON.stringify({ status: 'network-error' });
	  if (/такой страницы не существует|страница не существует|товар (?:снят|недоступен)|page not found|product not found|页面不存在|商品已下架/i.test(body)) return JSON.stringify({ status: 'not-found' });
	  const hasProductImage = [...document.images].some(node => node.naturalWidth >= 240 && node.naturalHeight >= 240);
	  if (!body.includes(sku) || !hasProductImage) return JSON.stringify({ status: 'waiting' });
	  const textNodes = [...document.querySelectorAll('span,div,p,li')]
	    .filter(node => String(node.innerText || '').includes(sku));
	  const exactNode = textNodes.sort((a, b) => String(a.innerText || '').length - String(b.innerText || '').length)[0] || null;
	  exactNode?.scrollIntoView({ block: 'center', inline: 'nearest' });
  return JSON.stringify({ status: 'ready' });
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(10)).ConfigureAwait(false);
		if (!response.Success || response.Result is not string json) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PRODUCT_PAGE_SCRIPT_FAILED");
		return JsonNode.Parse(json) as JsonObject ?? throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PRODUCT_PAGE_STATE_INVALID");
	}

	private static async Task RefreshQuickComplaintTransportSessionAsync(IRequestContext requestContext)
	{
		ICookieManager cookieManager = requestContext.GetCookieManager(null);
		foreach (string cookieName in QuickComplaintTransportCookieNames)
		{
			await cookieManager.DeleteCookiesAsync("https://seller.ozon.ru/", cookieName).ConfigureAwait(false);
		}
		if (!await cookieManager.FlushStoreAsync().ConfigureAwait(false))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_SUPPORT_SESSION_RECOVERY_FAILED");
		}
	}

	private static string QuickComplaintEntryUrl(bool resumeExisting, string resumePageUrl)
	{
		if (!resumeExisting) return OzonSellerQuickComplaintUrl;
		return Uri.TryCreate(resumePageUrl, UriKind.Absolute, out Uri? uri)
			&& uri.Scheme == Uri.UriSchemeHttps
			&& uri.Host.Equals("seller.ozon.ru", StringComparison.OrdinalIgnoreCase)
			&& uri.AbsolutePath.StartsWith("/app/messenger", StringComparison.OrdinalIgnoreCase)
			&& Regex.IsMatch(uri.Query, @"(?:^|[?&])group=support_v2(?:&|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
			? resumePageUrl
			: OzonSellerQuickComplaintUrl;
	}

	private async Task WaitForQuickComplaintHumanVerificationAsync(
		ChromiumWebBrowser browser,
		string ownerRef,
		Action<string, string>? reportProgress = null)
	{
		if (browser.IsDisposed) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BROWSER_CLOSED");
		reportProgress?.Invoke(
			"captcha-required",
			"Ozon 要求人机验证，已弹出当前内置浏览器；请完成滑块或验证码，通过后将自动继续。");
		await UiAsync<object?>(delegate
		{
			RestoreSessionForObservation(ownerRef);
			return null;
		}).ConfigureAwait(false);

		DateTime deadline = DateTime.UtcNow.AddMinutes(8);
		int stableClearReads = 0;
		const string verificationScript = """
(() => {
  const body = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const url = String(location.href || '');
  const captcha = /captcha|капч|подтвердите,? что вы не робот|verify you are human|验证码|人机验证|拖动滑块/i.test(body)
    || /(?:[?&]__rr=)|\/(?:captcha|challenge)(?:\/|\?|$)/i.test(url);
  const loginRequired = /\/(?:signin|login)(?:\/|\?|$)/i.test(url)
    || /войти в ozon seller|登录.*ozon/i.test(body);
  return JSON.stringify({ captcha, loginRequired, ready: document.readyState === 'complete', url });
})()
""";
		while (DateTime.UtcNow < deadline)
		{
			if (browser.IsDisposed) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BROWSER_CLOSED");
			if (!browser.IsLoading && browser.CanExecuteJavascriptInMainFrame)
			{
				JavascriptResponse response = await browser.EvaluateScriptAsync(
					verificationScript,
					timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
				JsonObject? state = response.Success && response.Result is string json
					? JsonNode.Parse(json) as JsonObject
					: null;
				if (state?["loginRequired"]?.GetValue<bool>() == true)
				{
					throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_LOGIN_REQUIRED");
				}
				bool cleared = state?["ready"]?.GetValue<bool>() == true
					&& state["captcha"]?.GetValue<bool>() == false
					&& IsQuickComplaintOzonUrl(state["url"]?.GetValue<string>() ?? browser.Address ?? string.Empty);
				stableClearReads = cleared ? stableClearReads + 1 : 0;
				if (stableClearReads >= 3)
				{
					reportProgress?.Invoke(
						"captcha-completed",
						"人机验证已通过，正在从当前步骤自动继续。");
					return;
				}
			}
			await Task.Delay(650).ConfigureAwait(false);
		}
		throw new InvalidOperationException("FOLLOW_SELLER_MANUAL_VERIFICATION_TIMEOUT");
	}

	private Task<QuickEvidenceScreenshots> PrepareQuickEvidenceScreenshotsAsync(
		ChromiumWebBrowser browser,
		string originalSku,
		string offerId,
		string sourceProductUrl,
		QuickEvidenceFollower[] followers,
		string materialDirectory,
		Action<string, string>? reportProgress = null)
	{
		return PrepareQuickEvidenceScreenshotsAsync(
			browser,
			string.Empty,
			originalSku,
			offerId,
			sourceProductUrl,
			followers,
			materialDirectory,
			reportProgress);
	}

	private async Task<QuickEvidenceScreenshots> PrepareQuickEvidenceScreenshotsAsync(
		ChromiumWebBrowser browser,
		string ownerRef,
		string originalSku,
		string offerId,
		string sourceProductUrl,
		QuickEvidenceFollower[] followers,
		string materialDirectory,
		Action<string, string>? reportProgress = null)
	{
		Func<Task> resolveCaptcha = string.IsNullOrWhiteSpace(ownerRef)
			? () => Task.FromException(new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_CAPTCHA_REQUIRED"))
			: () => WaitForQuickComplaintHumanVerificationAsync(browser, ownerRef, reportProgress);
		reportProgress?.Invoke("capture-own-product", "正在打开并截图我方商品页面");
		string ownProductPage = await ExecuteQuickEvidenceStepWithRetryAsync(
			() => CaptureQuickVerifiedProductPageAsync(
				browser,
				sourceProductUrl,
				originalSku,
				materialDirectory,
				"own-product-page.png",
				"FOLLOW_SELLER_SCHEME1_ORIGINAL_PRODUCT_PAGE_INVALID",
				resolveCaptcha),
			"FOLLOW_SELLER_SCHEME1_PRODUCT_PAGE_NETWORK_FAILED").ConfigureAwait(false);

		List<QuickEvidenceFollower> liveFollowers = [];
		List<string> excludedFollowerSkus = [];
		List<string> followerPages = [];
		for (int index = 0; index < followers.Length; index += 1)
		{
			QuickEvidenceFollower follower = followers[index];
			reportProgress?.Invoke(
				$"review-follower:{index + 1}",
				$"正在核对跟卖商品页面（{index + 1}/{followers.Length}），SKU：{follower.Sku}");
			bool captureScreenshot = liveFollowers.Count < 3;
			QuickFollowerPageReview review = await ExecuteQuickEvidenceStepWithRetryAsync(
				() => ReviewQuickFollowerProductPageAsync(
					browser,
					follower.ProductLink,
					follower.Sku,
					materialDirectory,
					captureScreenshot ? $"follower-{liveFollowers.Count + 1:D2}-{follower.Sku}-page.png" : string.Empty,
					resolveCaptcha),
				"FOLLOW_SELLER_SCHEME1_PRODUCT_PAGE_NETWORK_FAILED").ConfigureAwait(false);
			if (!review.IsLive)
			{
				excludedFollowerSkus.Add(follower.Sku);
				continue;
			}
			liveFollowers.Add(follower);
			if (!string.IsNullOrWhiteSpace(review.ScreenshotPath)) followerPages.Add(review.ScreenshotPath);
		}
		if (liveFollowers.Count == 0) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_ALL_FOLLOWERS_NOT_FOUND");

		reportProgress?.Invoke("capture-seller-list", "正在读取卖家后台商品列表和真实上架时间");
		string sellerListUrl = $"https://seller.ozon.ru/app/products?search={Uri.EscapeDataString(offerId)}";
		browser.Load(sellerListUrl);
		await WaitForQuickNavigationAsync(browser, "seller.ozon.ru", TimeSpan.FromSeconds(25)).ConfigureAwait(false);
		DateTime sellerDeadline = DateTime.UtcNow.AddSeconds(25);
		QuickTransitionGuard loginTransitionGuard = new(TimeSpan.FromSeconds(8), 6);
		while (DateTime.UtcNow < sellerDeadline)
		{
			JsonObject state = await EvaluateQuickSellerListAsync(browser, originalSku, offerId).ConfigureAwait(false);
			string status = state["status"]?.GetValue<string>() ?? string.Empty;
			if (status == "ready")
			{
				string listingDate = state["listingDate"]?.GetValue<string>()?.Trim() ?? string.Empty;
				if (string.IsNullOrWhiteSpace(listingDate))
				{
					throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_LISTING_DATE_NOT_FOUND");
				}
				await Task.Delay(300).ConfigureAwait(false);
				string sellerListScreenshot = await CaptureQuickScreenshotAsync(
					browser,
					materialDirectory,
					"own-seller-list.png").ConfigureAwait(false);
				reportProgress?.Invoke("evidence-ready", $"证据页面核对完成：有效跟卖 SKU 共 {liveFollowers.Count} 个");
				return new QuickEvidenceScreenshots(
					ownProductPage,
					sellerListScreenshot,
					followerPages.ToArray(),
					listingDate,
					liveFollowers.ToArray(),
					excludedFollowerSkus.ToArray());
			}
			if (status == "login-required")
			{
				if (!loginTransitionGuard.IsConfirmed(true))
				{
					reportProgress?.Invoke("seller-login-transition", "卖家后台正在完成登录跳转，系统会稳定确认后再读取商品列表");
					await Task.Delay(550).ConfigureAwait(false);
					continue;
				}
				throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_LOGIN_REQUIRED");
			}
			loginTransitionGuard.Reset();
			if (status == "captcha")
			{
				await resolveCaptcha().ConfigureAwait(false);
				continue;
			}
			if (status == "network-error") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_SELLER_LIST_NETWORK_FAILED");
			await Task.Delay(450).ConfigureAwait(false);
		}
		throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_SELLER_LIST_NOT_FOUND");
	}

	private static async Task SaveQuickPreparedEvidenceAsync(
		string materialDirectory,
		string evidenceId,
		string originalSku,
		string offerId,
		string sourceProductUrl,
		QuickEvidenceFollower[] requestedFollowers,
		QuickEvidenceScreenshots screenshots)
	{
		JsonObject ledger = new()
		{
			["schemaVersion"] = 1,
			["evidenceId"] = evidenceId,
			["originalSku"] = originalSku,
			["offerId"] = offerId,
			["sourceProductUrl"] = sourceProductUrl,
			["capturedAt"] = DateTimeOffset.UtcNow.ToString("O"),
			["listingDate"] = screenshots.ListingDate,
			["requestedFollowers"] = new JsonArray(requestedFollowers.Select(item => (JsonNode?)new JsonObject
			{
				["sku"] = item.Sku,
				["productLink"] = item.ProductLink,
			}).ToArray()),
			["liveFollowerSkus"] = new JsonArray(screenshots.LiveFollowers.Select(item => (JsonNode?)JsonValue.Create(item.Sku)).ToArray()),
			["excludedFollowerSkus"] = new JsonArray(screenshots.ExcludedFollowerSkus.Select(item => (JsonNode?)JsonValue.Create(item)).ToArray()),
			["ownProductPage"] = EvidenceFileNode(screenshots.OwnProductPage),
			["ownSellerList"] = EvidenceFileNode(screenshots.OwnSellerList),
			["followerProductPages"] = new JsonArray(screenshots.FollowerProductPages.Select(path => (JsonNode?)EvidenceFileNode(path)).ToArray()),
		};
		await File.WriteAllTextAsync(
			Path.Combine(materialDirectory, QuickPreparedEvidenceLedgerName),
			ledger.ToJsonString(new JsonSerializerOptions { WriteIndented = true })).ConfigureAwait(false);
	}

	private static QuickEvidenceScreenshots? LoadQuickPreparedEvidence(
		string materialDirectory,
		string evidenceId,
		string originalSku,
		string offerId,
		string sourceProductUrl,
		QuickEvidenceFollower[] requestedFollowers)
	{
		try
		{
			string ledgerPath = Path.Combine(materialDirectory, QuickPreparedEvidenceLedgerName);
			if (!File.Exists(ledgerPath)) return null;
			JsonObject? ledger = JsonNode.Parse(File.ReadAllText(ledgerPath)) as JsonObject;
			if (ledger is null
				|| ledger["schemaVersion"]?.GetValue<int>() != 1
				|| !string.Equals(ledger["evidenceId"]?.GetValue<string>(), evidenceId, StringComparison.Ordinal)
				|| !string.Equals(ledger["originalSku"]?.GetValue<string>(), originalSku, StringComparison.Ordinal)
				|| !string.Equals(ledger["offerId"]?.GetValue<string>(), offerId, StringComparison.Ordinal)
				|| !string.Equals(ledger["sourceProductUrl"]?.GetValue<string>(), sourceProductUrl, StringComparison.Ordinal))
			{
				return null;
			}
			JsonArray? requestedNodes = ledger["requestedFollowers"] as JsonArray;
			if (requestedNodes is null || requestedNodes.Count != requestedFollowers.Length) return null;
			for (int index = 0; index < requestedFollowers.Length; index += 1)
			{
				JsonObject? node = requestedNodes[index] as JsonObject;
				if (node is null
					|| !string.Equals(node["sku"]?.GetValue<string>(), requestedFollowers[index].Sku, StringComparison.Ordinal)
					|| !string.Equals(node["productLink"]?.GetValue<string>(), requestedFollowers[index].ProductLink, StringComparison.Ordinal))
				{
					return null;
				}
			}
			string ownProductPage = LoadQuickPreparedFile(ledger["ownProductPage"] as JsonObject, materialDirectory);
			string ownSellerList = LoadQuickPreparedFile(ledger["ownSellerList"] as JsonObject, materialDirectory);
			if (ownProductPage.Length == 0 || ownSellerList.Length == 0) return null;
			string[] liveSkus = ledger["liveFollowerSkus"] is JsonArray liveNodes
				? liveNodes.Select(node => node?.GetValue<string>()?.Trim() ?? string.Empty).Where(value => value.Length > 0).ToArray()
				: [];
			if (liveSkus.Length == 0 || liveSkus.Distinct(StringComparer.Ordinal).Count() != liveSkus.Length) return null;
			Dictionary<string, QuickEvidenceFollower> requestedBySku = requestedFollowers.ToDictionary(item => item.Sku, StringComparer.Ordinal);
			if (liveSkus.Any(sku => !requestedBySku.ContainsKey(sku))) return null;
			QuickEvidenceFollower[] liveFollowers = liveSkus.Select(sku => requestedBySku[sku]).ToArray();
			string[] excludedSkus = ledger["excludedFollowerSkus"] is JsonArray excludedNodes
				? excludedNodes.Select(node => node?.GetValue<string>()?.Trim() ?? string.Empty).Where(value => value.Length > 0).ToArray()
				: [];
			if (excludedSkus.Any(sku => !requestedBySku.ContainsKey(sku))
				|| liveSkus.Length + excludedSkus.Length != requestedFollowers.Length
				|| liveSkus.Intersect(excludedSkus, StringComparer.Ordinal).Any()
				|| liveSkus.Concat(excludedSkus).Distinct(StringComparer.Ordinal).Count() != requestedFollowers.Length)
			{
				return null;
			}
			string[] followerPages = ledger["followerProductPages"] is JsonArray pageNodes
				? pageNodes.Select(node => LoadQuickPreparedFile(node as JsonObject, materialDirectory)).Where(value => value.Length > 0).ToArray()
				: [];
			if (followerPages.Length != Math.Min(3, liveFollowers.Length)) return null;
			string listingDate = ledger["listingDate"]?.GetValue<string>()?.Trim() ?? string.Empty;
			if (listingDate.Length == 0) return null;
			return new QuickEvidenceScreenshots(
				ownProductPage,
				ownSellerList,
				followerPages,
				listingDate,
				liveFollowers,
				excludedSkus);
		}
		catch
		{
			return null;
		}
	}

	private static bool IsQuickPromptReplayAction(string action)
	{
		return action is "original-sku" or "follower-sku" or "initial-evidence" or "supplement-evidence";
	}

	private static string NormalizeQuickBotPromptText(string promptText)
	{
		return Regex.Replace(
			promptText.Trim(),
			@"(?:\s*\d{1,2}:\d{2})+(?:\s+(?:返回|Вернуться|Назад|Back))?\s*$",
			string.Empty,
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant).Trim();
	}

	private static QuickPromptReplayState LoadQuickPromptReplayState(
		string materialDirectory,
		string evidenceId)
	{
		string ledgerPath = Path.Combine(materialDirectory, QuickPromptReplayStateLedgerName);
		if (!File.Exists(ledgerPath)) return new QuickPromptReplayState(string.Empty, string.Empty, string.Empty, 0);
		try
		{
			JsonObject? ledger = JsonNode.Parse(File.ReadAllText(ledgerPath)) as JsonObject;
			string ticketId = ledger?["ticketId"]?.GetValue<string>()?.Trim() ?? string.Empty;
			string promptText = NormalizeQuickBotPromptText(ledger?["promptText"]?.GetValue<string>() ?? string.Empty);
			string answerAction = ledger?["answerAction"]?.GetValue<string>()?.Trim() ?? string.Empty;
			int replayCount = ledger?["replayCount"]?.GetValue<int>() ?? -1;
			if (ledger?["schemaVersion"]?.GetValue<int>() != 1
				|| !string.Equals(ledger?["evidenceId"]?.GetValue<string>(), evidenceId, StringComparison.Ordinal)
				|| !Regex.IsMatch(ticketId, "^[0-9]{6,20}$", RegexOptions.CultureInvariant)
				|| promptText.Length is < 1 or > 4000
				|| !IsQuickPromptReplayAction(answerAction)
				|| replayCount is < 0 or > 1)
			{
				throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PROMPT_REPLAY_STATE_INVALID");
			}
			return new QuickPromptReplayState(ticketId, promptText, answerAction, replayCount);
		}
		catch (InvalidOperationException)
		{
			throw;
		}
		catch (Exception error)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PROMPT_REPLAY_STATE_INVALID", error);
		}
	}

	private static async Task<QuickPromptReplayState> SaveQuickPromptReplayStateAsync(
		string materialDirectory,
		string evidenceId,
		string ticketId,
		string promptText,
		string answerAction,
		int replayCount)
	{
		string normalizedTicketId = ticketId.Trim();
		string normalizedPromptText = NormalizeQuickBotPromptText(promptText);
		string normalizedAction = answerAction.Trim();
		if (!Regex.IsMatch(normalizedTicketId, "^[0-9]{6,20}$", RegexOptions.CultureInvariant)
			|| normalizedPromptText.Length is < 1 or > 4000
			|| !IsQuickPromptReplayAction(normalizedAction)
			|| replayCount is < 0 or > 1)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PROMPT_REPLAY_STATE_INVALID");
		}
		JsonObject ledger = new()
		{
			["schemaVersion"] = 1,
			["evidenceId"] = evidenceId,
			["ticketId"] = normalizedTicketId,
			["promptText"] = normalizedPromptText,
			["answerAction"] = normalizedAction,
			["replayCount"] = replayCount,
			["updatedAt"] = DateTimeOffset.UtcNow.ToString("O"),
		};
		string ledgerPath = Path.Combine(materialDirectory, QuickPromptReplayStateLedgerName);
		string temporaryPath = $"{ledgerPath}.{Guid.NewGuid():N}.tmp";
		try
		{
			await File.WriteAllTextAsync(
				temporaryPath,
				ledger.ToJsonString(new JsonSerializerOptions { WriteIndented = true })).ConfigureAwait(false);
			File.Move(temporaryPath, ledgerPath, true);
		}
		catch (Exception error)
		{
			try { if (File.Exists(temporaryPath)) File.Delete(temporaryPath); } catch { }
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PROMPT_REPLAY_STATE_SAVE_FAILED", error);
		}
		return new QuickPromptReplayState(
			normalizedTicketId,
			normalizedPromptText,
			normalizedAction,
			replayCount);
	}

	private static string LoadQuickPreparedFile(JsonObject? descriptor, string materialDirectory)
	{
		if (descriptor is null) return string.Empty;
		string filePath = descriptor["path"]?.GetValue<string>()?.Trim() ?? string.Empty;
		string expectedSha256 = descriptor["sha256"]?.GetValue<string>()?.Trim() ?? string.Empty;
		if (filePath.Length == 0 || !Regex.IsMatch(expectedSha256, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)) return string.Empty;
		string fullPath = Path.GetFullPath(filePath);
		string root = Path.GetFullPath(materialDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
			+ Path.DirectorySeparatorChar;
		if (!fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase)
			|| !File.Exists(fullPath)
			|| !string.Equals(FileSha256(fullPath), expectedSha256, StringComparison.OrdinalIgnoreCase))
		{
			return string.Empty;
		}
		return fullPath;
	}

	private static async Task<T> ExecuteQuickEvidenceStepWithRetryAsync<T>(
		Func<Task<T>> action,
		string failureCode)
	{
		Exception? lastError = null;
		for (int attempt = 0; attempt < 2; attempt += 1)
		{
			try
			{
				return await action().ConfigureAwait(false);
			}
			catch (Exception error) when (ErrorCode.From(error) == "PURCHASE_BROWSER_CEF_FAILED")
			{
				lastError = error;
				if (attempt == 0) await Task.Delay(650).ConfigureAwait(false);
			}
		}
		throw new InvalidOperationException(failureCode, lastError);
	}

	private static async Task<QuickFollowerPageReview> ReviewQuickFollowerProductPageAsync(
		ChromiumWebBrowser browser,
		string productUrl,
		string sku,
		string materialDirectory,
		string screenshotName,
		Func<Task> resolveCaptcha)
	{
		Uri target = new(productUrl, UriKind.Absolute);
		browser.Load(productUrl);
		await WaitForQuickNavigationAsync(browser, target.Host, TimeSpan.FromSeconds(25)).ConfigureAwait(false);
		DateTime deadline = DateTime.UtcNow.AddSeconds(20);
		while (DateTime.UtcNow < deadline)
		{
			JsonObject state = await EvaluateQuickProductPageAsync(browser, sku).ConfigureAwait(false);
			string status = state["status"]?.GetValue<string>() ?? string.Empty;
			if (status == "ready")
			{
				await Task.Delay(300).ConfigureAwait(false);
				string screenshot = string.IsNullOrWhiteSpace(screenshotName)
					? string.Empty
					: await CaptureQuickScreenshotAsync(browser, materialDirectory, screenshotName).ConfigureAwait(false);
				return new QuickFollowerPageReview(true, screenshot);
			}
			if (status == "not-found") return new QuickFollowerPageReview(false, string.Empty);
			if (status == "captcha")
			{
				await resolveCaptcha().ConfigureAwait(false);
				continue;
			}
			if (status == "network-error") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PRODUCT_PAGE_NETWORK_FAILED");
			await Task.Delay(350).ConfigureAwait(false);
		}
		throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_FOLLOWER_PRODUCT_PAGE_INVALID");
	}

	private static async Task<string> CaptureQuickVerifiedProductPageAsync(
		ChromiumWebBrowser browser,
		string productUrl,
		string sku,
		string materialDirectory,
		string fileName,
		string invalidCode,
		Func<Task> resolveCaptcha)
	{
		Uri target = new(productUrl, UriKind.Absolute);
		browser.Load(productUrl);
		await WaitForQuickNavigationAsync(browser, target.Host, TimeSpan.FromSeconds(25)).ConfigureAwait(false);
		DateTime deadline = DateTime.UtcNow.AddSeconds(20);
		while (DateTime.UtcNow < deadline)
		{
			JsonObject state = await EvaluateQuickProductPageAsync(browser, sku).ConfigureAwait(false);
			string status = state["status"]?.GetValue<string>() ?? string.Empty;
			if (status == "ready")
			{
				await Task.Delay(300).ConfigureAwait(false);
				return await CaptureQuickScreenshotAsync(browser, materialDirectory, fileName).ConfigureAwait(false);
			}
			if (status == "captcha")
			{
				await resolveCaptcha().ConfigureAwait(false);
				continue;
			}
			if (status == "network-error") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PRODUCT_PAGE_NETWORK_FAILED");
			if (status == "not-found") throw new InvalidOperationException(invalidCode);
			await Task.Delay(350).ConfigureAwait(false);
		}
		throw new InvalidOperationException(invalidCode);
	}

	private static async Task<JsonObject> EvaluateQuickSellerListAsync(
		ChromiumWebBrowser browser,
		string originalSku,
		string offerId)
	{
		string originalSkuJson = JsonSerializer.Serialize(originalSku);
		string offerIdJson = JsonSerializer.Serialize(offerId);
		string script = $$"""
(() => {
  const originalSku = {{originalSkuJson}};
  const offerId = {{offerIdJson}};
  const body = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const url = String(location.href || '');
  if (/\/(?:signin|login)(?:\/|\?|$)/i.test(url) || /войти в ozon seller|登录.*ozon/i.test(body)) return JSON.stringify({ status: 'login-required' });
  if (/captcha|капч|подтвердите, что вы не робот|验证码|人机验证/i.test(body)) return JSON.stringify({ status: 'captcha' });
  if (/403 forbidden|access denied|err_(?:connection|timed_out|proxy)|无法访问此网站|拒绝访问/i.test(body)) return JSON.stringify({ status: 'network-error' });
	  if (body.includes(originalSku) && body.includes(offerId)) {
	    const center = Math.max(body.indexOf(offerId), body.indexOf(originalSku));
	    const snippet = body.slice(Math.max(0, center - 700), Math.min(body.length, center + 1800));
	    const datePatterns = [
	      /\b20\d{2}-[01]\d-[0-3]\d(?:[T, ]+[0-2]\d:[0-5]\d(?::[0-5]\d)?)?/u,
	      /\b[0-3]?\d[./-][01]?\d[./-]20\d{2}(?:[, ]+[0-2]?\d:[0-5]\d)?/u,
	      /\b[0-3]?\d\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+20\d{2}(?:[, ]+[0-2]?\d:[0-5]\d)?/iu,
	    ];
	    const listingDate = datePatterns.map(pattern => snippet.match(pattern)?.[0] || '').find(Boolean) || '';
	    if (!listingDate) return JSON.stringify({ status: 'waiting-date' });
	    const textNodes = [...document.querySelectorAll('td,tr,[role="row"],article,section,div')]
	      .filter(node => String(node.innerText || '').includes(offerId));
	    const exactRow = textNodes.sort((a, b) => String(a.innerText || '').length - String(b.innerText || '').length)[0] || null;
	    exactRow?.scrollIntoView({ block: 'center', inline: 'nearest' });
	    return JSON.stringify({ status: 'ready', listingDate });
	  }
  return JSON.stringify({ status: 'waiting' });
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(10)).ConfigureAwait(false);
		if (!response.Success || response.Result is not string json) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_SELLER_LIST_SCRIPT_FAILED");
		return JsonNode.Parse(json) as JsonObject ?? throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_SELLER_LIST_STATE_INVALID");
	}

	private static async Task<JsonObject> EvaluateQuickBackendComplaintStateAsync(
		ChromiumWebBrowser browser,
		string evidenceId,
		string originalSku,
		string[] followerSkus,
		string initialEvidenceText,
		string supplementText,
		string followerBatchText,
		bool resumeExisting,
		string resumeTicketId,
		string resumePhase = "",
		int expectedInitialAttachmentCount = 0,
		string answeredPromptTicketId = "",
		string answeredPromptText = "",
		string answeredPromptAction = "",
		int answeredPromptReplayCount = 0,
		bool stopAfterRepeatedPromptDetection = false)
	{
		string evidenceJson = JsonSerializer.Serialize(evidenceId);
		string originalSkuJson = JsonSerializer.Serialize(originalSku);
		string followerSkusJson = JsonSerializer.Serialize(followerSkus);
		string initialEvidenceJson = JsonSerializer.Serialize(initialEvidenceText);
		string supplementJson = JsonSerializer.Serialize(supplementText);
		string followerBatchJson = JsonSerializer.Serialize(followerBatchText);
		string resumeJson = JsonSerializer.Serialize(resumeExisting);
		string resumeTicketJson = JsonSerializer.Serialize(resumeTicketId);
		string resumePhaseJson = JsonSerializer.Serialize(resumePhase);
		string expectedInitialAttachmentCountJson = JsonSerializer.Serialize(expectedInitialAttachmentCount);
		string answeredPromptTicketJson = JsonSerializer.Serialize(answeredPromptTicketId);
		string answeredPromptTextJson = JsonSerializer.Serialize(answeredPromptText);
		string answeredPromptActionJson = JsonSerializer.Serialize(answeredPromptAction);
		string answeredPromptReplayCountJson = JsonSerializer.Serialize(answeredPromptReplayCount);
		string stopAfterRepeatedPromptDetectionJson = JsonSerializer.Serialize(stopAfterRepeatedPromptDetection);
		string script = $$"""
(() => {
  const evidenceId = {{evidenceJson}};
  const originalSku = {{originalSkuJson}};
  const followerSkus = {{followerSkusJson}};
  const initialEvidence = {{initialEvidenceJson}};
  const supplement = {{supplementJson}};
  const followerBatch = {{followerBatchJson}};
	const resumeExisting = {{resumeJson}};
	const resumeTicketId = {{resumeTicketJson}};
	const resumePhase = {{resumePhaseJson}};
	const expectedInitialAttachmentCount = {{expectedInitialAttachmentCountJson}};
	const answeredPromptTicketId = {{answeredPromptTicketJson}};
	const answeredPromptText = {{answeredPromptTextJson}};
	const answeredPromptAction = {{answeredPromptActionJson}};
	const answeredPromptReplayCount = {{answeredPromptReplayCountJson}};
	const stopAfterRepeatedPromptDetection = {{stopAfterRepeatedPromptDetectionJson}};
  const storageKey = `__wangzaiScheme1Complaint:${evidenceId}`;
  let stored = {};
  try { stored = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch {}
	  const previousRuntime = window.__wangzaiScheme1Complaint;
	  const runtime = previousRuntime?.evidenceId === evidenceId ? previousRuntime : {
	    evidenceId,
	    routeStep: Number(stored.routeStep ?? (resumeExisting ? 3 : 0)),
		routeVerified: stored.routeVerified === true,
		pendingRouteKey: String(stored.pendingRouteKey || ''),
		pendingRouteAt: Number(stored.pendingRouteAt || 0),
		routeStartedAt: Number(stored.routeStartedAt || stored.startedAt || Date.now()),
	    phase: String(stored.phase || (resumeExisting ? 'resume-history' : 'route')),
		phaseStartedAt: Number(stored.phaseStartedAt || stored.startedAt || Date.now()),
		conversationMissingAt: Number(stored.conversationMissingAt || 0),
		baselineTicketId: String(stored.baselineTicketId || ''),
		freshRequestConfirmed: stored.freshRequestConfirmed === true,
			ticketLocked: stored.ticketLocked === true || resumeExisting,
		ticketMismatchAt: Number(stored.ticketMismatchAt || 0),
		ticketRecoveredAt: Number(stored.ticketRecoveredAt || 0),
		legacyReplayPrompt: String(stored.legacyReplayPrompt || ''),
	    clicked: Array.isArray(stored.clicked) ? stored.clicked : [],
	    startedAt: Number(stored.startedAt || Date.now()),
	    ticketId: String((stored.ticketLocked === true || resumeExisting) ? (stored.ticketId || resumeTicketId) : ''),
	  };
	  window.__wangzaiScheme1Complaint = runtime;
  const persist = () => sessionStorage.setItem(storageKey, JSON.stringify({
	    evidenceId,
    routeStep: runtime.routeStep,
		routeVerified: runtime.routeVerified === true,
		pendingRouteKey: String(runtime.pendingRouteKey || ''),
		pendingRouteAt: Number(runtime.pendingRouteAt || 0),
		routeStartedAt: Number(runtime.routeStartedAt || runtime.startedAt || Date.now()),
	    phase: runtime.phase,
		phaseStartedAt: Number(runtime.phaseStartedAt || runtime.startedAt || Date.now()),
		conversationMissingAt: Number(runtime.conversationMissingAt || 0),
		baselineTicketId: String(runtime.baselineTicketId || ''),
		freshRequestConfirmed: runtime.freshRequestConfirmed === true,
		ticketLocked: runtime.ticketLocked === true,
		ticketMismatchAt: Number(runtime.ticketMismatchAt || 0),
		ticketRecoveredAt: Number(runtime.ticketRecoveredAt || 0),
		legacyReplayPrompt: String(runtime.legacyReplayPrompt || ''),
    clicked: runtime.clicked.slice(-20),
    startedAt: runtime.startedAt,
    ticketId: runtime.ticketId,
  }));
  const pageAdapter = {{QuickComplaintPageAdapterExpression}};
  const { clean, visible } = pageAdapter;
  const url = String(location.href || '');
  const bodyText = clean(document.body?.innerText || '');
  if (/\/(?:signin|login)(?:\/|\?|$)/i.test(url) || (/войти|登录|sign in/i.test(bodyText) && !pageAdapter.composer())) {
    return JSON.stringify({ status: 'login-required', url });
  }
  if (/captcha|капч|подтвердите, что вы не робот|验证码|人机验证/i.test(bodyText)) {
    return JSON.stringify({ status: 'captcha', url });
  }
	let currentUrl = null;
	try { currentUrl = new URL(url); } catch {}
	const exactSupportScope = currentUrl?.hostname === 'seller.ozon.ru'
	  && /^\/app\/messenger(?:\/|$)/i.test(currentUrl.pathname)
	  && (currentUrl.searchParams.get('group') === 'support_v2'
	    || (!resumeExisting && currentUrl.searchParams.get('channel') === 'SCRM'));
	if (!exactSupportScope) {
	  return JSON.stringify({
		status: 'navigate-required',
		action: 'open-support',
		targetUrl: resumeExisting
		  ? 'https://seller.ozon.ru/app/messenger?group=support_v2'
		  : 'https://seller.ozon.ru/app/messenger?channel=SCRM',
		url,
	  });
	}
  const composer = pageAdapter.composer();
  const conversation = pageAdapter.conversation(composer);
	  const chatText = pageAdapter.historyText(composer);
	  const observedTicketId = pageAdapter.ticketId(conversation);
	  const observedFreshRequestTicketId = pageAdapter.freshRequestTicketId(conversation);
	  const ticketNumberIn = (node, expectedTicketId) => {
	    const numbers = clean(node?.innerText || node?.textContent).match(/[0-9]{6,20}/g) || [];
	    return numbers.includes(expectedTicketId);
	  };
	  const findTicketTarget = expectedTicketId => [...document.querySelectorAll('button,[role="button"],a,[tabindex],div,span')]
	    .filter(node => visible(node) && !conversation?.contains?.(node) && ticketNumberIn(node, expectedTicketId))
	    .sort((left, right) => clean(left.innerText || left.textContent).length
	      - clean(right.innerText || right.textContent).length)[0] || null;
	  const findTicketSearch = () => [...document.querySelectorAll('input')]
	    .filter(node => visible(node) && !composer?.contains?.(node))
	    .find(node => /请求|request|обращ|поиск|search/i.test(clean(
	      node.placeholder || node.getAttribute?.('aria-label') || ''
	    )) || clean(node.type) === 'search') || null;
	  const entryLabels = node => ({
	    accessible: clean(node?.getAttribute?.('aria-label') || node?.getAttribute?.('title') || ''),
	    text: clean(node?.innerText || node?.textContent || ''),
	  });
	  const findEntryTarget = labels => [...document.querySelectorAll(
	    'button,a,[role="button"],[role="menuitem"],[role="option"],label,.om_6inde--yWDHe'
	  )]
	    .filter(visible)
	    .find(node => {
	      const candidate = entryLabels(node);
	      return labels.includes(candidate.accessible)
	        || (candidate.text !== '新请求' && labels.includes(candidate.text));
	    }) || null;
	  if (!resumeExisting && !runtime.ticketLocked && observedTicketId && !runtime.baselineTicketId) {
	    runtime.baselineTicketId = observedTicketId;
	    persist();
	  }
	  if (!resumeExisting && !runtime.ticketLocked && observedTicketId
	    && runtime.baselineTicketId && observedTicketId !== runtime.baselineTicketId) {
	    runtime.ticketId = observedTicketId;
	    runtime.ticketLocked = true;
	    runtime.freshRequestConfirmed = false;
	    runtime.ticketMismatchAt = 0;
	    runtime.legacyReplayPrompt = '';
	    runtime.routeStep = 0;
		runtime.routeVerified = false;
		runtime.pendingRouteKey = '';
		runtime.pendingRouteAt = 0;
		runtime.routeStartedAt = Date.now();
	    runtime.phase = 'route';
		runtime.phaseStartedAt = Date.now();
	    runtime.clicked = [];
	    runtime.startedAt = Date.now();
	    persist();
	  }
	  let ticketId = runtime.ticketLocked ? clean(runtime.ticketId || resumeTicketId) : '';
	  const conversationLoadFailed = /无法加载聊天列表|не удалось загрузить список чат|ws1006/i.test(bodyText);
	  if (!conversation && conversationLoadFailed) {
	    runtime.conversationMissingAt = Number(runtime.conversationMissingAt || Date.now());
	    persist();
	    const refreshTarget = [...document.querySelectorAll('button,[role="button"],.om_6inde--yWDHe')]
	      .filter(visible)
	      .find(node => /^(?:刷新(?:页面)?|Обновить|Refresh)$/i.test(clean(node.innerText || node.textContent))) || null;
	    const refreshRect = refreshTarget?.getBoundingClientRect() || null;
	    return JSON.stringify({
	      status: 'conversation-refresh-required',
	      action: 'conversation-refresh',
	      routeStep: runtime.routeStep,
	      phase: runtime.phase,
	      ticketId,
	      waitStartedAt: runtime.conversationMissingAt,
	      x: refreshRect ? Math.max(0, refreshRect.left + refreshRect.width / 2) : -1,
	      y: refreshRect ? Math.max(0, refreshRect.top + refreshRect.height / 2) : -1,
	      url,
	    });
	  }
	  if (!conversation) {
	    runtime.conversationMissingAt = Number(runtime.conversationMissingAt || Date.now());
	    if (ticketId) {
	      runtime.ticketMismatchAt = Number(runtime.ticketMismatchAt || Date.now());
	      runtime.ticketRecoveredAt = 0;
	      persist();
	      const ticketTarget = findTicketTarget(ticketId);
	      if (ticketTarget) {
	        ticketTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	        const rect = ticketTarget.getBoundingClientRect();
	        return JSON.stringify({
	          status: 'click-required',
	          action: 'restore-ticket',
	          routeStep: runtime.routeStep,
	          phase: runtime.phase,
	          ticketId,
	          expectedTicketId: ticketId,
	          observedTicketId: '',
	          x: Math.max(0, rect.left + rect.width / 2),
	          y: Math.max(0, rect.top + rect.height / 2),
	          url,
	        });
	      }
	      const ticketSearch = findTicketSearch();
	      const searchValue = clean(ticketSearch?.value || '');
	      if (ticketSearch && searchValue !== ticketId) {
	        const rect = ticketSearch.getBoundingClientRect();
	        return JSON.stringify({
	          status: 'ticket-search-required',
	          action: 'restore-ticket-search',
	          routeStep: runtime.routeStep,
	          phase: runtime.phase,
	          ticketId,
	          expectedTicketId: ticketId,
	          observedTicketId: '',
	          x: Math.max(0, rect.left + rect.width / 2),
	          y: Math.max(0, rect.top + rect.height / 2),
	          waitStartedAt: runtime.ticketMismatchAt,
	          url,
	        });
	      }
	      return JSON.stringify({
	        status: 'waiting',
	        action: ticketSearch ? 'ticket-search-results' : 'conversation-loading',
	        routeStep: runtime.routeStep,
	        phase: runtime.phase,
	        ticketId,
	        expectedTicketId: ticketId,
	        observedTicketId: '',
	        waitStartedAt: runtime.ticketMismatchAt,
	        url,
	      });
	    }
	    if (!resumeExisting) {
	      const sellerEntry = findEntryTarget(['Я продавец', '我是卖家']);
	      const newRequestEntry = findEntryTarget([
	        'Создать заявку', 'Создать обращение', 'Create request', 'New request',
	        '创建申请', '创建新请求', '新建请求', '发起请求', '新请求',
	      ]);
	      const entryTarget = sellerEntry || newRequestEntry;
	      if (entryTarget) {
	        const rect = entryTarget.getBoundingClientRect();
	        return JSON.stringify({
	          status: 'click-required',
	          action: sellerEntry ? 'seller-entry' : 'start-new-request',
	          routeStep: runtime.routeStep,
	          phase: runtime.phase,
	          ticketId: '',
	          x: Math.max(0, rect.left + rect.width / 2),
	          y: Math.max(0, rect.top + rect.height / 2),
	          url,
	        });
	      }
	    }
	    persist();
	    return JSON.stringify({
	      status: 'waiting',
	      action: ticketId ? 'conversation-loading' : 'new-request',
	      routeStep: runtime.routeStep,
	      ticketId,
	      waitStartedAt: runtime.conversationMissingAt,
	      url,
	    });
	  }
	  if (runtime.conversationMissingAt) {
	    runtime.conversationMissingAt = 0;
	    persist();
	  }
	  if (ticketId && observedTicketId !== ticketId) {
	    runtime.ticketMismatchAt = Number(runtime.ticketMismatchAt || Date.now());
	    runtime.ticketRecoveredAt = 0;
	    persist();
	    if (observedTicketId) {
	      const ticketTarget = findTicketTarget(ticketId);
	      if (ticketTarget) {
	        ticketTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	        const rect = ticketTarget.getBoundingClientRect();
	        return JSON.stringify({
	          status: 'click-required',
	          action: 'restore-ticket',
	          routeStep: runtime.routeStep,
	          phase: runtime.phase,
	          ticketId,
	          expectedTicketId: ticketId,
	          observedTicketId,
	          x: Math.max(0, rect.left + rect.width / 2),
	          y: Math.max(0, rect.top + rect.height / 2),
	          url,
	        });
	      }
	      const ticketSearch = findTicketSearch();
	      const searchValue = clean(ticketSearch?.value || '');
	      if (ticketSearch && searchValue !== ticketId) {
	        const rect = ticketSearch.getBoundingClientRect();
	        return JSON.stringify({
	          status: 'ticket-search-required',
	          action: 'restore-ticket-search',
	          routeStep: runtime.routeStep,
	          phase: runtime.phase,
	          ticketId,
	          expectedTicketId: ticketId,
	          observedTicketId,
	          x: Math.max(0, rect.left + rect.width / 2),
	          y: Math.max(0, rect.top + rect.height / 2),
	          waitStartedAt: runtime.ticketMismatchAt,
	          url,
	        });
	      }
	    }
	    return JSON.stringify({
	      status: 'waiting',
	      action: 'ticket-view-match',
	      routeStep: runtime.routeStep,
	      phase: runtime.phase,
	      ticketId,
	      expectedTicketId: ticketId,
	      observedTicketId,
	      waitStartedAt: runtime.ticketMismatchAt,
	      url,
	    });
	  }
	  if (runtime.ticketMismatchAt) {
	    runtime.ticketRecoveredAt = Number(runtime.ticketRecoveredAt || Date.now());
	    persist();
	    if (Date.now() - runtime.ticketRecoveredAt < 1500) {
	      return JSON.stringify({
	        status: 'waiting',
	        action: 'ticket-view-stable',
	        routeStep: runtime.routeStep,
	        phase: runtime.phase,
	        ticketId,
	        observedTicketId,
	        waitStartedAt: runtime.ticketRecoveredAt,
	        url,
	      });
	    }
	    runtime.ticketMismatchAt = 0;
	    runtime.ticketRecoveredAt = 0;
	    persist();
	  }
  const clickables = [...document.querySelectorAll('button,[role="button"],.om_6inde--yWDHe')].filter(visible);
  const confirmLabels = ['确认发送', 'Подтвердить отправку', 'Всё равно отправить', 'Send anyway'];
  const confirmTarget = clickables.find(node => confirmLabels.includes(clean(node.innerText || node.textContent)));
  if (confirmTarget) {
    const rect = confirmTarget.getBoundingClientRect();
    return JSON.stringify({
      status: 'click-required',
      action: 'confirm-send',
      routeStep: runtime.routeStep,
      phase: runtime.phase,
      x: Math.max(0, rect.left + rect.width / 2),
      y: Math.max(0, rect.top + rect.height / 2),
      url,
    });
  }
  const batchMarker = clean(followerBatch).slice(0, 80);
	const initialMarker = clean(initialEvidence).slice(0, 80);
	const supplementMarker = clean(supplement).slice(0, 80);
	const hasBatchMessage = !!batchMarker && chatText.includes(batchMarker);
	const hasInitialMessage = !!initialMarker && chatText.includes(initialMarker);
	const hasSupplementMessage = !!supplementMarker && chatText.includes(supplementMarker);
	const textarea = pageAdapter.input(composer);
	const ownPrompt = /请发送被其他卖家使用的商品卡片对应的\s*SKU|пришлите.*sku.*(?:вашей|своей|использует)/i.test(chatText);
	const afterMarker = marker => {
	  const normalized = clean(marker);
	  const shortMarker = normalized.slice(0, 80);
	  const index = shortMarker ? chatText.lastIndexOf(shortMarker) : -1;
	  return index >= 0 ? chatText.slice(index + shortMarker.length) : '';
	};
	const beforeMarker = marker => {
	  const normalized = clean(marker);
	  const shortMarker = normalized.slice(0, 80);
	  const index = shortMarker ? chatText.lastIndexOf(shortMarker) : -1;
	  return index >= 0 ? chatText.slice(0, index) : '';
	};
	const markerCount = marker => {
	  const normalized = clean(marker);
	  const shortMarker = normalized.slice(0, 80);
	  if (!shortMarker) return 0;
	  let count = 0;
	  let offset = 0;
	  while ((offset = chatText.indexOf(shortMarker, offset)) >= 0) {
	    count += 1;
	    offset += shortMarker.length;
	  }
	  return count;
	};
	const exactBotPrompt = source => {
	  const normalized = clean(source);
	  if (!normalized) return '';
	  const markers = [...normalized.matchAll(/(?:Ozon\s*机器人|Ozon\s*(?:robot|bot)|Робот\s*Ozon)\s*/giu)];
	  const latest = markers.at(-1);
	  const prompt = latest ? normalized.slice(Number(latest.index || 0) + latest[0].length) : normalized;
	  return clean(prompt.replace(/(?:\s*\d{1,2}:\d{2})+(?:\s+(?:返回|Вернуться|Назад|Back))?\s*$/iu, ''));
	};
	const evidencePromptPattern = /要确认内容的版权|请将证据.*源文件|подтвердить.*автор|доказательств.*(?:скрин|ссылк)|авторск.*(?:скрин|ссылк)/i;
	const findHistoryScrollPoint = () => {
	  const conversationRect = conversation.getBoundingClientRect();
	  const composerRect = composer.getBoundingClientRect();
	  const top = Math.max(2, conversationRect.top + 4);
	  const bottom = Math.min(innerHeight - 2, composerRect.top - 8, conversationRect.bottom - 4);
	  if (bottom - top < 80) return null;
	  const messageTarget = [...conversation.querySelectorAll('*')]
	    .filter(node => node && node !== composer && !composer.contains(node) && visible(node)
	      && (!initialMarker || clean(node.innerText || node.textContent).includes(initialMarker)))
	    .sort((left, right) => clean(left.innerText || left.textContent).length
	      - clean(right.innerText || right.textContent).length)[0] || conversation;
	  const targetRect = messageTarget.getBoundingClientRect();
	  return {
	    x: Math.min(innerWidth - 2, Math.max(2, targetRect.left + targetRect.width / 2)),
	    y: Math.min(bottom - 2, Math.max(top + 2, targetRect.top + Math.min(targetRect.height / 2, 120))),
	    deltaY: Math.max(300, Math.min(1200, (bottom - top) * 0.85)),
	  };
	};
	const responseMarkerForAction = action => ({
	  'original-sku': originalSku,
	  'follower-sku': followerSkus[0] || '',
	  'initial-evidence': initialEvidence,
	  'supplement-evidence': supplement,
	}[action] || '');
	const currentReplySource = runtime.phase === 'wait-follower-prompt'
	  ? afterMarker(originalSku)
	  : runtime.phase === 'wait-evidence-prompt'
	    ? afterMarker(followerSkus[0] || '')
	    : runtime.phase === 'wait-initial-reply'
	      ? afterMarker(initialEvidence)
	      : runtime.phase === 'wait-supplement-reply'
	        ? afterMarker(supplement)
	        : runtime.phase === 'submitted-awaiting-support-reply'
	          ? afterMarker(followerBatch)
	          : chatText;
	const dailyLimitPattern = /(?:在这一天内)?已超过了此问题的申请次数的限制|(?:您可在)?\s*24\s*小时后创建新申请|превысили.*лимит.*обращен|создать.*через 24 час/i;
	if (runtime.ticketLocked && dailyLimitPattern.test(currentReplySource)) {
	  return JSON.stringify({ status: 'daily-limit', ticketId, phase: runtime.phase, url });
	}
	const answeredMarker = answeredPromptTicketId === ticketId
	  ? responseMarkerForAction(answeredPromptAction)
	  : '';
	const repeatedPromptText = answeredMarker ? exactBotPrompt(afterMarker(answeredMarker)) : '';
	if (runtime.ticketLocked && textarea && answeredPromptText
	  && repeatedPromptText && repeatedPromptText === answeredPromptText) {
	  if (stopAfterRepeatedPromptDetection && answeredPromptAction === 'initial-evidence') {
	    return JSON.stringify({
	      status: 'repeated-prompt-observed',
	      action: answeredPromptAction,
	      promptText: repeatedPromptText,
	      ticketId,
	      phase: runtime.phase,
	      replayDiagnostics: {
	        source: 'persisted-baseline',
	        resumeExisting,
	        ticketLocked: runtime.ticketLocked === true,
	        textareaPresent: !!textarea,
	        currentTicketHasReplayBaseline: true,
	        promptsExactMatch: true,
	      },
	      url,
	    });
	  }
	  if (answeredPromptReplayCount < 1) {
	    return JSON.stringify({
	      status: 'repeat-answer-required',
	      action: answeredPromptAction,
	      promptText: repeatedPromptText,
	      ticketId,
	      phase: runtime.phase,
	      url,
	    });
	  }
	  return JSON.stringify({
	    status: 'repeated-prompt-limit',
	    action: answeredPromptAction,
	    promptText: repeatedPromptText,
	    ticketId,
	    phase: runtime.phase,
	    url,
	  });
	}
	const legacyPromptBeforeInitialEvidence = exactBotPrompt(beforeMarker(initialEvidence));
	const legacyPromptAfterInitialEvidence = exactBotPrompt(afterMarker(initialEvidence));
	const currentTicketHasReplayBaseline = answeredPromptTicketId === ticketId
	  && !!answeredPromptText && answeredPromptAction === 'initial-evidence';
	const initialMessageMarkerCount = markerCount(initialEvidence);
	const legacyReplayCandidate = resumeExisting && runtime.ticketLocked
	  && runtime.phase === 'wait-initial-reply' && textarea
	  && !currentTicketHasReplayBaseline && initialMessageMarkerCount === 1;
	if (legacyReplayCandidate && legacyPromptAfterInitialEvidence
	  && evidencePromptPattern.test(legacyPromptAfterInitialEvidence)
	  && runtime.legacyReplayPrompt !== legacyPromptAfterInitialEvidence) {
	  runtime.legacyReplayPrompt = legacyPromptAfterInitialEvidence;
	  persist();
	}
	const legacyCurrentPrompt = exactBotPrompt(runtime.legacyReplayPrompt || legacyPromptAfterInitialEvidence);
	const legacyPreviousPromptLoaded = !!legacyPromptBeforeInitialEvidence
	  && evidencePromptPattern.test(legacyPromptBeforeInitialEvidence);
	const historyScrollPoint = legacyReplayCandidate ? findHistoryScrollPoint() : null;
	const legacyPromptsExactMatch = !!legacyCurrentPrompt && legacyPreviousPromptLoaded
	  && legacyPromptBeforeInitialEvidence === legacyCurrentPrompt;
	const replayDiagnostics = {
	  source: 'legacy-history-recovery',
	  resumeExisting,
	  expectedTicketId: resumeTicketId,
	  observedTicketId,
	  ticketId,
	  ticketLocked: runtime.ticketLocked === true,
	  phase: runtime.phase,
	  textareaPresent: !!textarea,
	  hasInitialMessage,
	  initialMarkerLength: initialMarker.length,
	  initialMarkerIndex: initialMarker ? chatText.lastIndexOf(initialMarker) : -1,
	  initialMessageMarkerCount,
	  answeredPromptTicketMatches: answeredPromptTicketId === ticketId,
	  answeredPromptTextLength: answeredPromptText.length,
	  answeredPromptAction,
	  currentTicketHasReplayBaseline,
	  legacyReplayCandidate: !!legacyReplayCandidate,
	  legacyPromptAfterMatchesPattern: !!legacyPromptAfterInitialEvidence
	    && evidencePromptPattern.test(legacyPromptAfterInitialEvidence),
	  legacyPreviousPromptLoaded,
	  legacyPromptsExactMatch,
	  historyScrollPointFound: !!historyScrollPoint,
	  chatTextLength: chatText.length,
	  legacyPromptBeforeInitialEvidence,
	  legacyPromptAfterInitialEvidence,
	  legacyCurrentPrompt,
	};
	if (stopAfterRepeatedPromptDetection && legacyReplayCandidate && legacyPromptsExactMatch) {
	  return JSON.stringify({
	    status: 'repeated-prompt-observed',
	    action: 'initial-evidence',
	    promptText: legacyCurrentPrompt,
	    ticketId,
	    phase: runtime.phase,
	    replayDiagnostics,
	    url,
	  });
	}
	if (legacyReplayCandidate && legacyCurrentPrompt && legacyPreviousPromptLoaded
	  && legacyPromptBeforeInitialEvidence === legacyCurrentPrompt) {
	  return JSON.stringify({
	    status: 'prompt-replay-baseline-required',
	    action: 'initial-evidence',
	    promptText: legacyCurrentPrompt,
	    ticketId,
	    phase: runtime.phase,
	    x: historyScrollPoint?.x ?? -1,
	    y: historyScrollPoint?.y ?? -1,
	    replayDiagnostics,
	    url,
	  });
	}
	if (legacyReplayCandidate && legacyCurrentPrompt && !legacyPreviousPromptLoaded && historyScrollPoint) {
	  return JSON.stringify({
	    status: 'ticket-history-load-required',
	    action: 'load-ticket-history',
	    ticketId,
	    phase: runtime.phase,
	    x: historyScrollPoint.x,
	    y: historyScrollPoint.y,
	    deltaY: historyScrollPoint.deltaY,
	    replayDiagnostics,
	    url,
	  });
	}
	const historyAttachmentImages = [...conversation.querySelectorAll('img')]
	  .filter(node => !composer.contains(node) && visible(node)
	    && (node.currentSrc || node.src) && node.complete
	    && node.naturalWidth >= 96 && node.naturalHeight >= 96);
	const insufficientPrompt = /您提供的材料不足以证明著作权|材料不足.*著作权|предоставленн.*материал.*недостаточ|материал.*недостаточ.*авторск/i.test(chatText);
	const batchPrompt = /您可以立即投诉该卖家的其他商品[\s\S]*SKU\s*列表|发送\s*SKU\s*列表|можете.*пожаловаться.*друг(?:ие|их).*товар.*sku|пришлите.*список.*sku/i.test(chatText);
	const initialImagesAlreadySent = resumeExisting
	  && resumePhase === 'wait-evidence-prompt'
	  && !hasInitialMessage
	  && followerSkus.some(sku => chatText.includes(sku))
	  && expectedInitialAttachmentCount > 0
	  && historyAttachmentImages.length >= expectedInitialAttachmentCount;
	if (initialImagesAlreadySent && runtime.phase !== 'repair-initial-text') {
	  runtime.phase = 'repair-initial-text';
	  runtime.phaseStartedAt = Date.now();
	  persist();
	}
	if (runtime.phase === 'resume-history') {
	  const previousPhase = runtime.phase;
	  if (!hasInitialMessage && (insufficientPrompt || batchPrompt || hasBatchMessage)) runtime.phase = 'repair-initial-text';
	  else if (!hasSupplementMessage && (batchPrompt || hasBatchMessage)) runtime.phase = 'repair-supplement-text';
	  else if (hasBatchMessage) runtime.phase = 'submitted-awaiting-support-reply';
	  else if (hasSupplementMessage) runtime.phase = 'wait-supplement-reply';
	  else if (hasInitialMessage) runtime.phase = 'wait-initial-reply';
	  else if (followerSkus.some(sku => chatText.includes(sku))) runtime.phase = 'wait-evidence-prompt';
	  else if (chatText.includes(originalSku)) runtime.phase = 'wait-follower-prompt';
	  else runtime.phase = 'route';
	  if (runtime.phase !== previousPhase) runtime.phaseStartedAt = Date.now();
	  if (runtime.phase === 'route') runtime.routeStartedAt = Date.now();
	  if (runtime.phase !== 'route') {
		runtime.routeStep = 3;
		runtime.routeVerified = true;
		runtime.pendingRouteKey = '';
		runtime.pendingRouteAt = 0;
	  }
	  persist();
	}
  if (runtime.phase === 'submitted-awaiting-support-reply' && hasBatchMessage) {
    return JSON.stringify({ status: 'submitted', receiptId: ticketId, url });
  }
	  const answerTiles = [...conversation.querySelectorAll('.om_6inde--yWDHe')].filter(visible);
  const route = [
    { key: 'product-prices', labels: ['Товары и цены', 'Products and prices', '商品和价格'] },
    { key: 'quality-control', labels: ['Контроль качества', 'Quality control', '质量监督'] },
    { key: 'seller-content-use', labels: ['Продавец использует мой контент', 'Seller uses my content', '卖家使用我的内容'] },
  ];
	  const routeMatches = route.map(step => {
	    let node = null;
	    let domIndex = -1;
	    answerTiles.forEach((candidate, index) => {
	      if (step.labels.includes(clean(candidate.innerText || candidate.textContent)) && index >= domIndex) {
	        node = candidate;
	        domIndex = index;
	      }
	    });
	    return { node, domIndex };
	  });
	  let activeRouteIndex = -1;
	  let latestRouteDomIndex = -1;
	  routeMatches.forEach((match, index) => {
	    if (match.domIndex > latestRouteDomIndex) {
	      activeRouteIndex = index;
	      latestRouteDomIndex = match.domIndex;
	    }
	  });
	  const targetFor = step => {
	    const index = route.indexOf(step);
	    return index >= 0 ? routeMatches[index]?.node || null : null;
	  };
	  if (runtime.phase === 'route') {
	    if (runtime.pendingRouteKey) {
	      const pendingIndex = route.findIndex(step => step.key === runtime.pendingRouteKey);
	      const nextIndex = pendingIndex + 1;
	      const nextMenuConfirmed = pendingIndex >= 0 && nextIndex < route.length && activeRouteIndex === nextIndex;
	      const finalPromptConfirmed = pendingIndex >= 0 && nextIndex === route.length && ownPrompt && textarea;
	      if (!nextMenuConfirmed && !finalPromptConfirmed) {
			if (Date.now() - Number(runtime.pendingRouteAt || runtime.routeStartedAt || runtime.startedAt) > 65000) {
			  return JSON.stringify({
				status: 'route-not-found',
				routeStep: runtime.routeStep,
				routeVerified: false,
				pendingRouteKey: runtime.pendingRouteKey,
				phase: runtime.phase,
				clicked: runtime.clicked,
				ticketId,
				observedTicketId,
				observedFreshRequestTicketId,
				baselineTicketId: String(runtime.baselineTicketId || ''),
				ticketLocked: runtime.ticketLocked === true,
				freshRequestConfirmed: runtime.freshRequestConfirmed === true,
				composerInputPresent: !!textarea,
				url,
				excerpt: chatText.slice(-1800),
			  });
			}
	        return JSON.stringify({
	          status: 'waiting',
	          action: 'route-reply',
	          pendingRouteKey: runtime.pendingRouteKey,
	          routeStep: runtime.routeStep,
	          phase: runtime.phase,
	          ticketId,
	          waitStartedAt: Number(runtime.pendingRouteAt || runtime.routeStartedAt || runtime.startedAt),
	          url,
	        });
	      }
	      runtime.clicked.push({ key: runtime.pendingRouteKey, at: runtime.pendingRouteAt, confirmedAt: Date.now() });
	      runtime.routeStep = nextIndex;
	      runtime.routeVerified = finalPromptConfirmed;
	      runtime.pendingRouteKey = '';
	      runtime.pendingRouteAt = 0;
	      persist();
	    }
	    if (!runtime.routeVerified && activeRouteIndex >= 0 && activeRouteIndex !== runtime.routeStep) {
	      runtime.routeStep = activeRouteIndex;
	      runtime.pendingRouteKey = '';
	      runtime.pendingRouteAt = 0;
	      persist();
	    }
	    if (!runtime.routeVerified && ownPrompt && textarea) {
	      runtime.routeStep = route.length;
	      runtime.routeVerified = true;
	      runtime.pendingRouteKey = '';
	      runtime.pendingRouteAt = 0;
	      persist();
	    }
	    if (!runtime.routeVerified) {
	      const step = route[Math.max(0, Number(runtime.routeStep) || 0)] || null;
	      const target = targetFor(step);
	      if (step && target) {
	        const rect = target.getBoundingClientRect();
	        return JSON.stringify({
	          status: 'click-required',
	          action: step.key,
	          routeStep: runtime.routeStep,
	          x: Math.max(0, rect.left + rect.width / 2),
	          y: Math.max(0, rect.top + rect.height / 2),
	          url,
	        });
	      }
	    }
	  }
	  const confirmedRouteKeys = runtime.clicked.map(entry => clean(entry?.key || ''));
	  const freshRouteConfirmed = route.every((step, index) => confirmedRouteKeys[index] === step.key);
	  const supportConversationUrl = /\/app\/messenger\/?\?(?=[^#]*\bid=[0-9a-f-]{36}\b)(?=[^#]*\bgroup=support_v2\b)/i.test(url);
	  const freshRequestConfirmed = !resumeExisting && !runtime.ticketLocked
	    && !!observedTicketId && observedFreshRequestTicketId === observedTicketId
	    && supportConversationUrl && freshRouteConfirmed
	    && runtime.routeVerified && runtime.routeStep >= route.length
	    && runtime.phase === 'route' && ownPrompt && !!textarea;
	  if (freshRequestConfirmed) {
	    runtime.ticketId = observedTicketId;
	    runtime.ticketLocked = true;
	    runtime.freshRequestConfirmed = true;
	    runtime.ticketMismatchAt = 0;
	    runtime.ticketRecoveredAt = 0;
	    ticketId = observedTicketId;
	    persist();
	  }
	  const originalReply = afterMarker(originalSku);
	  const followerReply = afterMarker(followerSkus[0] || '');
	  const notFoundPattern = /未在您的商店中找到|не найден[а-я\s]*в вашем магазине|товар.*не найден/i;
	  const followerPrompt = /转到您要投诉的商品卡片|отправьте.*sku.*(?:пожаловаться|жалоб)|sku товара.*(?:пожаловаться|жалоб)/i.test(originalReply);
	  const evidencePrompt = evidencePromptPattern.test(followerReply);
	  if (runtime.routeVerified && runtime.phase === 'wait-follower-prompt' && notFoundPattern.test(originalReply)) return JSON.stringify({ status: 'original-sku-not-found', ticketId, url });
	  if (runtime.routeVerified && runtime.phase === 'wait-evidence-prompt' && notFoundPattern.test(followerReply)) return JSON.stringify({ status: 'follower-sku-not-found', ticketId, url });
	  if (runtime.ticketLocked && runtime.routeVerified && runtime.routeStep >= route.length && runtime.phase === 'route' && ownPrompt && textarea) {
    return JSON.stringify({ status: 'type-message-required', action: 'original-sku', promptText: exactBotPrompt(chatText), ticketId, phase: runtime.phase, url });
  }
	  if (runtime.ticketLocked && runtime.routeVerified && runtime.phase === 'wait-follower-prompt' && followerPrompt && textarea) {
    return JSON.stringify({ status: 'type-message-required', action: 'follower-sku', promptText: exactBotPrompt(originalReply), ticketId, phase: runtime.phase, url });
  }
	  if (runtime.ticketLocked && runtime.routeVerified && runtime.phase === 'wait-evidence-prompt' && evidencePrompt && textarea) {
    return JSON.stringify({ status: 'initial-evidence-required', promptText: exactBotPrompt(followerReply), ticketId, phase: runtime.phase, url });
  }
	if (runtime.phase === 'repair-initial-text' && textarea) {
	  return JSON.stringify({ status: 'type-message-required', action: 'repair-initial-text', ticketId, phase: runtime.phase, url });
	}
	if (runtime.phase === 'repair-supplement-text' && textarea) {
	  return JSON.stringify({ status: 'type-message-required', action: 'repair-supplement-text', ticketId, phase: runtime.phase, url });
	}
  if (runtime.phase === 'wait-initial-reply') {
	const reply = afterMarker(initialEvidence);
    if (batchPrompt && /sku/i.test(reply) && textarea) {
      return JSON.stringify({ status: 'type-message-required', action: 'follower-batch', promptText: exactBotPrompt(reply), ticketId, phase: runtime.phase, url });
    }
	if (insufficientPrompt && reply) {
      return JSON.stringify({ status: 'supplement-required', promptText: exactBotPrompt(reply), ticketId, phase: runtime.phase, url });
    }
  }
  if (runtime.phase === 'wait-supplement-reply') {
    const reply = afterMarker(supplement);
	if (batchPrompt && /sku/i.test(reply) && textarea) {
	  return JSON.stringify({ status: 'type-message-required', action: 'follower-batch', promptText: exactBotPrompt(reply), ticketId, phase: runtime.phase, url });
	}
    if (insufficientPrompt && reply) {
      return JSON.stringify({ status: 'materials-rejected', ticketId, phase: runtime.phase, url });
    }
  }
  const routeCandidates = answerTiles.map(node => ({
    text: clean(node.innerText || node.textContent).slice(0, 180),
    className: String(node.className || '').slice(0, 300),
    html: String(node.outerHTML || '').slice(0, 1000),
  })).slice(0, 80);
  const frameUrls = [...document.querySelectorAll('iframe')]
    .map(frame => String(frame.src || frame.getAttribute?.('src') || '').slice(0, 1000))
    .filter(Boolean);
	  if (runtime.phase === 'route' && Date.now() - Number(runtime.routeStartedAt || runtime.startedAt) > 65000) return JSON.stringify({
    status: 'route-not-found',
    routeStep: runtime.routeStep,
		routeVerified: runtime.routeVerified === true,
		pendingRouteKey: runtime.pendingRouteKey,
	    phase: runtime.phase,
    clicked: runtime.clicked,
	    ticketId,
	    observedTicketId,
	    observedFreshRequestTicketId,
	    baselineTicketId: String(runtime.baselineTicketId || ''),
	    ticketLocked: runtime.ticketLocked === true,
	    freshRequestConfirmed: runtime.freshRequestConfirmed === true,
	    composerInputPresent: !!textarea,
	    url,
    excerpt: chatText.slice(-1800),
    routeCandidates,
    frameUrls,
  });
  return JSON.stringify({
    status: 'waiting',
    routeStep: runtime.routeStep,
		routeVerified: runtime.routeVerified === true,
		pendingRouteKey: runtime.pendingRouteKey,
	    phase: runtime.phase,
	    ticketId,
	    observedTicketId,
	    observedFreshRequestTicketId,
	    baselineTicketId: String(runtime.baselineTicketId || ''),
	    ticketLocked: runtime.ticketLocked === true,
	    freshRequestConfirmed: runtime.freshRequestConfirmed === true,
	    composerInputPresent: !!textarea,
	    waitStartedAt: runtime.phase === 'route'
	      ? Number(runtime.pendingRouteAt || runtime.routeStartedAt || runtime.startedAt)
	      : Number(runtime.phaseStartedAt || runtime.startedAt),
	    replayDiagnostics,
	    url,
  });
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(12)).ConfigureAwait(false);
		if (!response.Success || response.Result is not string json) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PAGE_SCRIPT_FAILED");
		return JsonNode.Parse(json) as JsonObject ?? throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PAGE_STATE_INVALID");
	}

	private static async Task<string> SubmitQuickComplaintBundleAsync(
		ChromiumWebBrowser browser,
		string[] attachmentPaths,
		string[] expectedNames,
		string message,
		string materialDirectory,
		string beforeScreenshotName,
		string progressStagePrefix = "evidence",
		Action<string, string>? report = null,
		Action? onSubmissionStarted = null)
	{
		if (attachmentPaths.Length == 0 || attachmentPaths.Length != expectedNames.Length)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BUNDLE_INVALID");
		}
		int beforeHistoryImageCount = await GetQuickHistoryImageCountAsync(browser).ConfigureAwait(false);
		await TypeQuickComplaintMessageAsync(browser, message).ConfigureAwait(false);
		await AttachComplaintFilesAsync(browser, attachmentPaths).ConfigureAwait(false);
		if (!await WaitForQuickAttachmentSendReadinessAsync(
			browser,
			beforeHistoryImageCount,
			attachmentPaths.Length,
			message,
			TimeSpan.FromSeconds(120)).ConfigureAwait(false))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_ATTACHMENT_UPLOAD_FAILED");
		}
		report?.Invoke($"{progressStagePrefix}-attachments-ready", $"{attachmentPaths.Length} 张图片已稳定就绪，正在一次发送完整图文证据");
		string beforeScreenshot = await CaptureQuickScreenshotAsync(
			browser,
			materialDirectory,
			beforeScreenshotName).ConfigureAwait(false);
		onSubmissionStarted?.Invoke();
		await ClickQuickComplaintSendAsync(
			browser,
			message,
			requireMessageReadback: false).ConfigureAwait(false);
		QuickBundleSubmissionReadback? readback = await WaitForQuickBundleSubmissionReadbackAsync(
			browser,
			message,
			beforeHistoryImageCount,
			attachmentPaths.Length,
			TimeSpan.FromSeconds(120),
			progressStagePrefix,
			report).ConfigureAwait(false);
		if (readback is null) throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_BUNDLE_SUBMIT_NOT_CONFIRMED");
		return beforeScreenshot;
	}

	private static async Task<QuickSupplementSubmissionResult> SubmitQuickComplaintSupplementBundleAsync(
		ChromiumWebBrowser browser,
		string[] attachmentPaths,
		string[] expectedNames,
		string message,
		string materialDirectory,
		string beforeScreenshotName,
		string progressStagePrefix,
		Action<string, string>? report,
		Action? onSubmissionStarted)
	{
		if (attachmentPaths.Length == 0 || attachmentPaths.Length != expectedNames.Length)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_BUNDLE_INVALID");
		}
		int beforeHistoryImageCount = await GetQuickHistoryImageCountAsync(browser).ConfigureAwait(false);
		await TypeQuickComplaintMessageAsync(browser, message).ConfigureAwait(false);
		await AttachComplaintFilesAsync(browser, attachmentPaths).ConfigureAwait(false);
		if (!await WaitForQuickAttachmentSendReadinessAsync(
			browser,
			beforeHistoryImageCount,
			attachmentPaths.Length,
			message,
			TimeSpan.FromSeconds(120)).ConfigureAwait(false))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_ATTACHMENT_UPLOAD_FAILED");
		}
		report?.Invoke($"{progressStagePrefix}-attachments-ready", $"{attachmentPaths.Length} 张图片已稳定就绪，正在一次发送完整图文证据");
		string beforeScreenshot = await CaptureQuickScreenshotAsync(
			browser,
			materialDirectory,
			beforeScreenshotName).ConfigureAwait(false);
		onSubmissionStarted?.Invoke();
		await ClickQuickComplaintSendAsync(
			browser,
			message,
			requireMessageReadback: false).ConfigureAwait(false);
		QuickSupplementSubmissionResult readback = await WaitForQuickSupplementSubmissionReadbackAsync(
			browser,
			message,
			beforeHistoryImageCount,
			attachmentPaths.Length,
			beforeScreenshot,
			TimeSpan.FromSeconds(120),
			progressStagePrefix,
			report).ConfigureAwait(false);
		return readback;
	}

	private static async Task<bool> WaitForQuickAttachmentSendReadinessAsync(
		ChromiumWebBrowser browser,
		int beforeHistoryImageCount,
		int expectedAttachmentCount,
		string expectedMessage,
		TimeSpan timeout)
	{
		string beforeCountJson = JsonSerializer.Serialize(beforeHistoryImageCount);
		string expectedCountJson = JsonSerializer.Serialize(expectedAttachmentCount);
		string marker = Regex.Replace(expectedMessage, "\\s+", " ").Trim();
		marker = marker[..Math.Min(80, marker.Length)];
		string markerJson = JsonSerializer.Serialize(marker);
		string script = $$"""
(() => {
  const pageAdapter = {{QuickComplaintPageAdapterExpression}};
  const composer = pageAdapter.composer();
	  const conversation = pageAdapter.conversation(composer);
	  if (!composer || !conversation) return JSON.stringify({ ready: false });
  const visible = pageAdapter.visible;
	  const composerAttachmentImages = [...composer.querySelectorAll('img')]
	    .filter(node => visible(node) && (node.currentSrc || node.src));
	  const composerImages = composerAttachmentImages.length;
	  const historyImages = [...conversation.querySelectorAll('img')]
	    .filter(node => !composer.contains(node) && visible(node)
	      && (node.currentSrc || node.src) && node.complete && node.naturalWidth > 0);
  const explicitUploadSignals = [...composer.querySelectorAll(
    'progress,[role="progressbar"],[aria-busy="true"],[data-loading="true"],[data-uploading="true"],[class*="progress" i],[class*="spinner" i],[class*="loader" i],[class*="loading" i],[class*="uploading" i]'
  )].filter(visible);
  const animatedUploadSignals = [...composer.querySelectorAll('*')].filter(node => {
    if (!visible(node)) return false;
    const style = getComputedStyle(node);
    const names = String(style.animationName || '').split(',').map(value => value.trim());
    const durations = String(style.animationDuration || '').split(',').map(value => {
      const normalized = value.trim().toLowerCase();
      return normalized.endsWith('ms') ? Number.parseFloat(normalized)
        : normalized.endsWith('s') ? Number.parseFloat(normalized) * 1000 : 0;
    });
    return names.some(name => name && name !== 'none')
      && durations.some(duration => Number.isFinite(duration) && duration > 0)
      && style.animationPlayState !== 'paused';
  });
  const circularUploadSignals = [...composer.querySelectorAll('svg circle')].filter(node => {
    const svg = node.closest('svg');
    if (!visible(svg)) return false;
    const style = getComputedStyle(node);
    const token = `${svg.getAttribute('class') || ''} ${node.getAttribute('class') || ''}`.toLowerCase();
    return token.includes('progress') || token.includes('spinner') || token.includes('loading')
      || (style.strokeDasharray && style.strokeDasharray !== 'none' && style.strokeDasharray !== '0px');
  });
  const activeUploadSignals = new Set([
    ...explicitUploadSignals,
    ...animatedUploadSignals,
    ...circularUploadSignals,
  ]).size;
  const composerText = String(composer.innerText || '').replace(/\s+/g, ' ').trim();
  const uploadError = /发送消息时出错|上传失败|发送失败|ошибк[^.]{0,40}(?:отправ|загруз)|не удалось[^.]{0,40}(?:отправ|загруз)|upload failed|send failed/i.test(composerText);
  const textarea = pageAdapter.input(composer);
  const inputText = pageAdapter.inputText(textarea);
  const marker = {{markerJson}};
  const messagePresent = !!marker && inputText.includes(marker);
  const sendReady = !!pageAdapter.sendButton(composer);
	  const beforeCount = {{beforeCountJson}};
	  const expectedCount = {{expectedCountJson}};
	  const completedAttachmentCount = Math.max(0, historyImages.length - beforeCount);
	  const attachmentsStaged = composerImages >= expectedCount;
	  const attachmentsAlreadyInHistory = completedAttachmentCount >= expectedCount;
	  const attachmentsReady = attachmentsStaged || attachmentsAlreadyInHistory;
	  const attachmentImages = attachmentsStaged ? composerAttachmentImages : historyImages.slice(-expectedCount);
	  const attachmentFingerprint = `${attachmentsStaged ? 'composer' : 'history'}\n${attachmentImages
	    .map(node => `${node.currentSrc || node.src}|${node.naturalWidth}x${node.naturalHeight}`)
	    .sort()
	    .join('\n')}`;
  return JSON.stringify({
	    ready: attachmentsReady && activeUploadSignals === 0
	      && !uploadError && messagePresent && sendReady,
	    historyImageCount: historyImages.length,
	    completedAttachmentCount,
	    composerImages,
	    attachmentsStaged,
	    attachmentsAlreadyInHistory,
	    attachmentsReady,
    activeUploadSignals,
    uploadError,
    messagePresent,
    sendReady,
    attachmentFingerprint,
  });
})()
""";
		DateTime deadline = DateTime.UtcNow.Add(timeout);
		int stableReads = 0;
		string stableFingerprint = string.Empty;
		while (DateTime.UtcNow < deadline)
		{
			JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
			JsonObject? state = response.Success && response.Result is string json ? JsonNode.Parse(json) as JsonObject : null;
			bool ready = state?["ready"]?.GetValue<bool>() == true;
			string fingerprint = state?["attachmentFingerprint"]?.GetValue<string>() ?? string.Empty;
			if (ready && fingerprint.Length > 0)
			{
				stableReads = fingerprint == stableFingerprint ? stableReads + 1 : 1;
				stableFingerprint = fingerprint;
			}
			else
			{
				stableReads = 0;
				stableFingerprint = string.Empty;
			}
			if (stableReads >= 12) return true;
			await Task.Delay(250).ConfigureAwait(false);
		}
		return false;
	}

	private static async Task<int> GetQuickHistoryImageCountAsync(ChromiumWebBrowser browser)
	{
		string script = $$"""
(() => {
  const pageAdapter = {{QuickComplaintPageAdapterExpression}};
  const composer = pageAdapter.composer();
  const conversation = pageAdapter.conversation(composer);
  if (!composer || !conversation) return 0;
  const visibleLoaded = node => !!node && !composer.contains(node)
    && pageAdapter.visible(node)
    && (node.currentSrc || node.src)
    && node.naturalWidth > 0;
  return [...conversation.querySelectorAll('img')].filter(visibleLoaded).length;
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
		return response.Success && response.Result is int count ? count : Convert.ToInt32(response.Result ?? 0);
	}

	private static async Task<QuickBundleSubmissionReadback?> WaitForQuickBundleSubmissionReadbackAsync(
		ChromiumWebBrowser browser,
		string expectedMessage,
		int beforeHistoryImageCount,
		int expectedAttachmentCount,
		TimeSpan timeout,
		string progressStagePrefix,
		Action<string, string>? report)
	{
		string marker = Regex.Replace(expectedMessage, "\\s+", " ").Trim();
		marker = marker[..Math.Min(80, marker.Length)];
		string markerJson = JsonSerializer.Serialize(marker);
		string beforeCountJson = JsonSerializer.Serialize(beforeHistoryImageCount);
		string expectedCountJson = JsonSerializer.Serialize(expectedAttachmentCount);
		string script = $$"""
(() => {
  const pageAdapter = {{QuickComplaintPageAdapterExpression}};
  const composer = pageAdapter.composer();
  const conversation = pageAdapter.conversation(composer);
  if (!composer || !conversation) return JSON.stringify({ ok: false });
  const visible = pageAdapter.visible;
  const historyText = pageAdapter.historyText(composer);
  const textarea = pageAdapter.input(composer);
	  const inputText = pageAdapter.inputText(textarea);
  const composerImages = [...composer.querySelectorAll('img')]
    .filter(node => visible(node) && (node.currentSrc || node.src)).length;
  const historyImages = [...conversation.querySelectorAll('img')]
    .filter(node => !composer.contains(node) && visible(node)
      && (node.currentSrc || node.src) && node.naturalWidth > 0).length;
  const marker = {{markerJson}};
  const beforeCount = {{beforeCountJson}};
  const expectedCount = {{expectedCountJson}};
	  const messageSent = !!marker && historyText.includes(marker);
	  const messageStillInComposer = !!marker && inputText.includes(marker);
	  const attachmentsSent = composerImages === 0 && historyImages - beforeCount >= expectedCount;
	  const sendReady = !!pageAdapter.sendButton(composer);
	  const clickables = [...document.querySelectorAll('button,[role="button"],.om_6inde--yWDHe')]
	    .filter(visible);
	  const confirmLabels = ['确认发送', 'Подтвердить отправку', 'Всё равно отправить', 'Send anyway'];
	  const confirm = clickables.find(node => confirmLabels.includes(pageAdapter.clean(node.innerText || node.textContent))) || null;
	  const confirmRect = confirm?.getBoundingClientRect() || null;
	  const batchPrompt = /您可以立即投诉该卖家的其他商品[\s\S]*SKU\s*列表|发送\s*SKU\s*列表|можете.*пожаловаться.*друг(?:ие|их).*товар.*sku|пришлите.*список.*sku/i.test(historyText);
  return JSON.stringify({
	    ok: messageSent && inputText === '' && attachmentsSent,
	    messageSent,
	    attachmentsSent,
	    messageStillInComposer,
	    residualTextReady: attachmentsSent && messageStillInComposer && sendReady && !confirm,
	    sendReady,
	    confirm: !!confirm,
	    confirmX: confirmRect ? confirmRect.left + confirmRect.width / 2 : -1,
	    confirmY: confirmRect ? confirmRect.top + confirmRect.height / 2 : -1,
	    batchPrompt,
    historyImages,
    composerImages,
    inputLength: inputText.length,
  });
})()
""";
		DateTime deadline = DateTime.UtcNow.Add(timeout);
		int stableReads = 0;
		int confirmationClicks = 0;
		bool residualTextSent = false;
		while (DateTime.UtcNow < deadline)
		{
			JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
			JsonObject? state = response.Success && response.Result is string json ? JsonNode.Parse(json) as JsonObject : null;
			stableReads = state?["ok"]?.GetValue<bool>() == true ? stableReads + 1 : 0;
			if (stableReads >= 3)
			{
				return new QuickBundleSubmissionReadback(
					state?["messageSent"]?.GetValue<bool>() == true,
					state?["attachmentsSent"]?.GetValue<bool>() == true,
					residualTextSent,
					state?["batchPrompt"]?.GetValue<bool>() == true);
			}
			if (state?["confirm"]?.GetValue<bool>() == true && confirmationClicks < 4)
			{
				confirmationClicks += 1;
				report?.Invoke($"{progressStagePrefix}-confirm-send", "Ozon 要求二次确认，正在确认发送当前证据内容");
				await DispatchQuickSessionPageClickAsync(
					browser,
					state["confirmX"]?.GetValue<double>() ?? -1,
					state["confirmY"]?.GetValue<double>() ?? -1).ConfigureAwait(false);
				await Task.Delay(550).ConfigureAwait(false);
				continue;
			}
			if (state?["residualTextReady"]?.GetValue<bool>() == true && !residualTextSent)
			{
				report?.Invoke($"{progressStagePrefix}-send-residual-text", "全部图片已经进入聊天记录，正在发送输入框中保留的证据文案（不重复图片）");
				await ClickQuickComplaintSendAsync(
					browser,
					expectedMessage,
					requireMessageReadback: false).ConfigureAwait(false);
				residualTextSent = true;
				stableReads = 0;
				await Task.Delay(550).ConfigureAwait(false);
				continue;
			}
			await Task.Delay(250).ConfigureAwait(false);
		}
		return null;
	}

	private static async Task<QuickSupplementSubmissionResult> WaitForQuickSupplementSubmissionReadbackAsync(
		ChromiumWebBrowser browser,
		string expectedMessage,
		int beforeHistoryImageCount,
		int expectedAttachmentCount,
		string beforeScreenshot,
		TimeSpan timeout,
		string progressStagePrefix,
		Action<string, string>? report)
	{
		QuickBundleSubmissionReadback? readback = await WaitForQuickBundleSubmissionReadbackAsync(
			browser,
			expectedMessage,
			beforeHistoryImageCount,
			expectedAttachmentCount,
			timeout,
			progressStagePrefix,
			report).ConfigureAwait(false);
		if (readback is not null)
		{
			return new QuickSupplementSubmissionResult(
				beforeScreenshot,
				readback.MessageSent,
				readback.ResidualTextSent,
				readback.BatchPromptObserved);
		}
		throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_BUNDLE_SUBMIT_NOT_CONFIRMED");
	}

	private static async Task SetQuickComplaintRoutePendingAsync(
		ChromiumWebBrowser browser,
		string evidenceId,
		string routeKey)
	{
		if (routeKey is not ("product-prices" or "quality-control" or "seller-content-use"))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_ROUTE_PENDING_INVALID");
		}
		string evidenceJson = JsonSerializer.Serialize(evidenceId);
		string routeKeyJson = JsonSerializer.Serialize(routeKey);
		string script = $$"""
(() => {
	const evidenceId = {{evidenceJson}};
	const routeKey = {{routeKeyJson}};
	const storageKey = '__wangzaiScheme1Complaint:' + evidenceId;
	let stored = {};
	try { stored = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch {}
	stored.evidenceId = evidenceId;
	stored.pendingRouteKey = routeKey;
	stored.pendingRouteAt = Date.now();
	stored.routeStartedAt = Number(stored.routeStartedAt || stored.startedAt || stored.pendingRouteAt);
	sessionStorage.setItem(storageKey, JSON.stringify(stored));
	if (window.__wangzaiScheme1Complaint?.evidenceId === evidenceId) {
		window.__wangzaiScheme1Complaint.pendingRouteKey = routeKey;
		window.__wangzaiScheme1Complaint.pendingRouteAt = stored.pendingRouteAt;
	}
	return true;
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
		if (!response.Success || response.Result is not true)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_ROUTE_PENDING_PERSIST_FAILED");
		}
	}

	private static async Task SetQuickComplaintPhaseAsync(
		ChromiumWebBrowser browser,
		string evidenceId,
		string phase)
	{
		string evidenceJson = JsonSerializer.Serialize(evidenceId);
		string phaseJson = JsonSerializer.Serialize(phase);
		string script = $$"""
(() => {
	  const storageKey = '__wangzaiScheme1Complaint:' + {{evidenceJson}};
  let stored = {};
  try { stored = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch {}
	  stored.phase = {{phaseJson}};
	  stored.phaseStartedAt = Date.now();
	  stored.evidenceId = {{evidenceJson}};
  sessionStorage.setItem(storageKey, JSON.stringify(stored));
	  if (window.__wangzaiScheme1Complaint?.evidenceId === {{evidenceJson}}) {
	    window.__wangzaiScheme1Complaint.phase = {{phaseJson}};
	    window.__wangzaiScheme1Complaint.phaseStartedAt = stored.phaseStartedAt;
	  }
  return true;
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
		if (!response.Success || response.Result is not true)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PHASE_PERSIST_FAILED");
		}
	}

	private static async Task PrimeQuickComplaintRuntimeAsync(
		ChromiumWebBrowser browser,
		string evidenceId,
		string ticketId,
		int completedRouteSteps)
	{
		string evidenceJson = JsonSerializer.Serialize(evidenceId);
		string ticketJson = JsonSerializer.Serialize(ticketId);
		string routeStepsJson = JsonSerializer.Serialize(completedRouteSteps);
		string script = $$"""
(() => {
	const evidenceId = {{evidenceJson}};
	const ticketId = {{ticketJson}};
	const routeStep = {{routeStepsJson}};
	const storageKey = '__wangzaiScheme1Complaint:' + evidenceId;
	const runtime = {
		evidenceId,
		routeStep,
		routeVerified: routeStep >= 3,
		pendingRouteKey: '',
		pendingRouteAt: 0,
		phase: 'route',
		clicked: [],
		startedAt: Date.now(),
		ticketId,
	};
	sessionStorage.setItem(storageKey, JSON.stringify(runtime));
	window.__wangzaiScheme1Complaint = runtime;
	return true;
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
		if (!response.Success || response.Result is not true)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_PHASE_PRIME_FAILED");
		}
	}

	private static async Task SetQuickComplaintTicketSearchAsync(
		ChromiumWebBrowser browser,
		double x,
		double y,
		string ticketId)
	{
		string normalizedTicketId = ticketId.Trim();
		if (x < 0 || y < 0
			|| !Regex.IsMatch(normalizedTicketId, "^[0-9]{6,20}$", RegexOptions.CultureInvariant))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_TICKET_VIEW_MISMATCH");
		}
		await DispatchQuickSessionPageClickAsync(browser, x, y).ConfigureAwait(false);
		string clearScript = $$"""
(() => {
  const pageAdapter = {{QuickComplaintPageAdapterExpression}};
  const visible = pageAdapter.visible;
  const clean = pageAdapter.clean;
  const composer = pageAdapter.composer();
  const candidate = document.activeElement instanceof HTMLInputElement && !composer?.contains?.(document.activeElement)
    ? document.activeElement
    : [...document.querySelectorAll('input')]
      .filter(node => visible(node) && !composer?.contains?.(node))
      .find(node => /请求|request|обращ|поиск|search/i.test(clean(node.placeholder || '')) || clean(node.type) === 'search');
  if (!candidate) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter ? setter.call(candidate, '') : (candidate.value = '');
  candidate.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  candidate.dispatchEvent(new Event('change', { bubbles: true }));
  candidate.focus();
  return true;
})()
""";
		JavascriptResponse cleared = await browser.EvaluateScriptAsync(clearScript, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
		if (!cleared.Success || cleared.Result is not true)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_TICKET_VIEW_MISMATCH");
		}
		using DevToolsClient devTools = browser.GetDevToolsClient();
		await devTools.Input.InsertTextAsync(normalizedTicketId).ConfigureAwait(false);

		string ticketJson = JsonSerializer.Serialize(normalizedTicketId);
		string verifyScript = $$"""
(() => {
  const pageAdapter = {{QuickComplaintPageAdapterExpression}};
  const clean = pageAdapter.clean;
  const composer = pageAdapter.composer();
  const candidate = document.activeElement instanceof HTMLInputElement && !composer?.contains?.(document.activeElement)
    ? document.activeElement
    : [...document.querySelectorAll('input')]
      .filter(node => node.getClientRects().length > 0 && !composer?.contains?.(node))
      .find(node => /请求|request|обращ|поиск|search/i.test(clean(node.placeholder || '')) || clean(node.type) === 'search');
  return clean(candidate?.value || '') === {{ticketJson}};
})()
""";
		for (int attempt = 0; attempt < 15; attempt += 1)
		{
			JavascriptResponse verification = await browser.EvaluateScriptAsync(verifyScript, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
			if (verification.Success && verification.Result is true) return;
			await Task.Delay(120).ConfigureAwait(false);
		}
		throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_TICKET_VIEW_MISMATCH");
	}

	private static async Task TypeQuickComplaintMessageAsync(ChromiumWebBrowser browser, string message)
	{
		string targetScript = $$"""
(() => {
  const pageAdapter = {{QuickComplaintPageAdapterExpression}};
  const composer = pageAdapter.composer();
  const textarea = pageAdapter.input(composer);
  if (!textarea) return JSON.stringify({ ok: false });
  const rect = textarea.getBoundingClientRect();
  return JSON.stringify({
    ok: true,
    x: Math.max(0, rect.left + rect.width / 2),
    y: Math.max(0, rect.top + rect.height / 2),
	    value: String(textarea.value ?? textarea.textContent ?? ''),
  });
})()
""";
		JavascriptResponse targetResponse = await browser.EvaluateScriptAsync(targetScript, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
		JsonObject? target = targetResponse.Success && targetResponse.Result is string targetJson ? JsonNode.Parse(targetJson) as JsonObject : null;
		if (target?["ok"]?.GetValue<bool>() != true)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_COMPOSER_REQUIRED");
		}
		double x = target["x"]?.GetValue<double>() ?? -1;
		double y = target["y"]?.GetValue<double>() ?? -1;
		string currentValue = target["value"]?.GetValue<string>() ?? string.Empty;
		if (x < 0 || y < 0) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_CLICK_TARGET_INVALID");
		await DispatchQuickSessionPageClickAsync(browser, x, y).ConfigureAwait(false);
		if (!currentValue.Equals(message, StringComparison.Ordinal))
		{
			if (!string.IsNullOrEmpty(currentValue))
			{
				string clearScript = $$"""
(() => {
  const pageAdapter = {{QuickComplaintPageAdapterExpression}};
  const composer = pageAdapter.composer();
  const textarea = pageAdapter.input(composer);
  if (!textarea) return false;
  if (textarea.isContentEditable) textarea.textContent = '';
  else {
    const prototype = textarea instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : textarea instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set : null;
    setter ? setter.call(textarea, '') : (textarea.value = '');
  }
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()
""";
				JavascriptResponse cleared = await browser.EvaluateScriptAsync(clearScript, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
				if (!cleared.Success || cleared.Result is not true)
				{
					throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_COMPOSER_CLEAR_FAILED");
				}
			}
			using DevToolsClient devTools = browser.GetDevToolsClient();
			await devTools.Input.InsertTextAsync(message).ConfigureAwait(false);
		}

		string expectedJson = JsonSerializer.Serialize(message);
		string verifyScript = $$"""
(() => {
  const pageAdapter = {{QuickComplaintPageAdapterExpression}};
  const composer = pageAdapter.composer();
  const textarea = pageAdapter.input(composer);
  const value = textarea ? String(textarea.value ?? textarea.textContent ?? '') : '';
  const send = pageAdapter.sendButton(composer);
  return JSON.stringify({
    ok: value === {{expectedJson}},
    sendEnabled: !!send && !send.disabled && send.getAttribute('aria-disabled') !== 'true',
    length: value.length,
  });
})()
""";
		JsonObject? verification = null;
		for (int attempt = 0; attempt < 25; attempt += 1)
		{
			JavascriptResponse response = await browser.EvaluateScriptAsync(verifyScript, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
			verification = response.Success && response.Result is string verificationJson ? JsonNode.Parse(verificationJson) as JsonObject : null;
			if (verification?["ok"]?.GetValue<bool>() == true && verification["sendEnabled"]?.GetValue<bool>() == true) return;
			await Task.Delay(120).ConfigureAwait(false);
		}
		throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_COMPOSER_INPUT_FAILED");
	}

	private static async Task ClickQuickComplaintSendAsync(
		ChromiumWebBrowser browser,
		string expectedMessage,
		bool requireMessageReadback = true,
		Action? onConfirm = null)
	{
		string composerScript = $$"""
(() => {
  const pageAdapter = {{QuickComplaintPageAdapterExpression}};
  const composer = pageAdapter.composer();
  if (!composer) return JSON.stringify({ ok: false });
  const textarea = pageAdapter.input(composer);
  const target = pageAdapter.sendButton(composer);
	  if (!textarea || !target) return JSON.stringify({ ok: false });
	  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	  const rect = target.getBoundingClientRect();
	  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) {
	    return JSON.stringify({ ok: false });
	  }
	  return JSON.stringify({
	    ok: true,
	    x: Math.min(innerWidth - 2, Math.max(2, rect.left + rect.width / 2)),
	    y: Math.min(innerHeight - 2, Math.max(2, rect.top + rect.height / 2)),
	  });
})()
""";
		JsonObject? state = null;
		for (int attempt = 0; attempt < 250; attempt += 1)
		{
			JavascriptResponse response = await browser.EvaluateScriptAsync(composerScript, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
			state = response.Success && response.Result is string json ? JsonNode.Parse(json) as JsonObject : null;
			if (state?["ok"]?.GetValue<bool>() == true) break;
			await Task.Delay(120).ConfigureAwait(false);
		}
		if (state?["ok"]?.GetValue<bool>() != true)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_SUBMIT_BUTTON_REQUIRED");
		}
		double x = state["x"]?.GetValue<double>() ?? -1;
		double y = state["y"]?.GetValue<double>() ?? -1;
		if (x < 0 || y < 0) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_CLICK_TARGET_INVALID");
		await DispatchQuickSessionPageClickAsync(browser, x, y).ConfigureAwait(false);
		if (requireMessageReadback
			&& !await WaitForQuickComplaintMessageReadbackAsync(browser, expectedMessage, onConfirm).ConfigureAwait(false))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_SUBMIT_NOT_CONFIRMED");
		}
	}

	private static async Task<bool> WaitForQuickComplaintMessageReadbackAsync(
		ChromiumWebBrowser browser,
		string expectedMessage,
		Action? onConfirm = null)
	{
		string markerJson = JsonSerializer.Serialize(Regex.Replace(expectedMessage, "\\s+", " ").Trim()[..Math.Min(80, Regex.Replace(expectedMessage, "\\s+", " ").Trim().Length)]);
		string script = $$"""
(() => {
	  const pageAdapter = {{QuickComplaintPageAdapterExpression}};
	  const composer = pageAdapter.composer();
	  const text = pageAdapter.historyText(composer);
	  const marker = {{markerJson}};
	  const clickables = [...document.querySelectorAll('button,[role="button"],.om_6inde--yWDHe')]
	    .filter(pageAdapter.visible);
	  const confirmLabels = ['确认发送', 'Подтвердить отправку', 'Всё равно отправить', 'Send anyway'];
	  const confirm = clickables.find(node => confirmLabels.includes(pageAdapter.clean(node.innerText || node.textContent))) || null;
	  if (confirm) {
	    const rect = confirm.getBoundingClientRect();
	    return JSON.stringify({ ok: false, confirm: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
	  }
	  return JSON.stringify({ ok: !!marker && text.includes(marker), confirm: false });
})()
""";
		for (int attempt = 0; attempt < 80; attempt += 1)
		{
			JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
			JsonObject? state = response.Success && response.Result is string json ? JsonNode.Parse(json) as JsonObject : null;
			if (state?["ok"]?.GetValue<bool>() == true) return true;
			if (state?["confirm"]?.GetValue<bool>() == true)
			{
				onConfirm?.Invoke();
				await DispatchQuickSessionPageClickAsync(
					browser,
					state["x"]?.GetValue<double>() ?? -1,
					state["y"]?.GetValue<double>() ?? -1).ConfigureAwait(false);
			}
			await Task.Delay(200).ConfigureAwait(false);
		}
		return false;
	}

	private static async Task DispatchQuickTrustedScrollAsync(
		ChromiumWebBrowser browser,
		double x,
		double y,
		double deltaY)
	{
		using DevToolsClient devTools = browser.GetDevToolsClient();
		await devTools.Input.DispatchMouseEventAsync(
			DispatchMouseEventType.MouseMoved,
			x,
			y,
			button: MouseButton.None,
			buttons: 0,
			clickCount: 0).ConfigureAwait(false);
		await devTools.Input.DispatchMouseEventAsync(
			DispatchMouseEventType.MouseWheel,
			x,
			y,
			button: MouseButton.None,
			buttons: 0,
			clickCount: 0,
			deltaX: 0,
			deltaY: deltaY).ConfigureAwait(false);
	}

	private static async Task<(double X, double Y, string Url)> FindQuickSupportNavigationAsync(
		ChromiumWebBrowser browser)
	{
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
		&& url.searchParams.get('group') === 'support_v2';
    } catch { return false; }
  };
  const buyerHref = node => {
    try { return new URL(hrefOf(node), location.href).searchParams.get('group') === 'customers_v2'; }
    catch { return false; }
  };
  const target = candidates.find(({ node }) => supportHref(node))
	|| candidates.find(({ node }) => !buyerHref(node) && /(?:客服|support|поддержк)/iu.test(labelOf(node)));
  if (!target) return JSON.stringify({ found: false, x: -1, y: -1 });
  let href = '';
  try { href = new URL(hrefOf(target.node), location.href).href; } catch {}
  return JSON.stringify({
    found: true,
    x: target.rect.left + target.rect.width / 2,
    y: target.rect.top + target.rect.height / 2,
    href,
  });
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(
			script,
			timeout: TimeSpan.FromSeconds(10)).ConfigureAwait(false);
		JsonObject? state = response.Success && response.Result is string json
			? JsonNode.Parse(json) as JsonObject
			: null;
		return state?["found"]?.GetValue<bool>() == true
			? (
				state["x"]?.GetValue<double>() ?? -1,
				state["y"]?.GetValue<double>() ?? -1,
				ValidQuickSupportNavigationUrl(state["href"]?.GetValue<string>()))
			: (-1, -1, string.Empty);
	}

	private static string ValidQuickSupportNavigationUrl(string? value)
	{
		string candidate = value?.Trim() ?? string.Empty;
		return Uri.TryCreate(candidate, UriKind.Absolute, out Uri? uri)
			&& uri.Scheme == Uri.UriSchemeHttps
			&& uri.Host.Equals("seller.ozon.ru", StringComparison.OrdinalIgnoreCase)
			&& uri.AbsolutePath.StartsWith("/app/messenger", StringComparison.OrdinalIgnoreCase)
			&& Regex.IsMatch(uri.Query, @"(?:^|[?&])group=support_v2(?:&|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
			? candidate
			: string.Empty;
	}

	private static async Task DispatchQuickTrustedClickAsync(ChromiumWebBrowser browser, double x, double y)
	{
		using DevToolsClient devTools = browser.GetDevToolsClient();
		await devTools.Input.DispatchMouseEventAsync(
			DispatchMouseEventType.MouseMoved,
			x,
			y,
			button: MouseButton.None,
			buttons: 0,
			clickCount: 0).ConfigureAwait(false);
		await devTools.Input.DispatchMouseEventAsync(
			DispatchMouseEventType.MousePressed,
			x,
			y,
			button: MouseButton.Left,
			buttons: 1,
			clickCount: 1).ConfigureAwait(false);
		await devTools.Input.DispatchMouseEventAsync(
			DispatchMouseEventType.MouseReleased,
			x,
			y,
			button: MouseButton.Left,
			buttons: 0,
			clickCount: 1).ConfigureAwait(false);
	}

	private static async Task DispatchQuickSessionPageClickAsync(ChromiumWebBrowser browser, double x, double y)
	{
		string script = $$"""
(() => {
  const point = document.elementFromPoint({{JsonSerializer.Serialize(x)}}, {{JsonSerializer.Serialize(y)}});
  const target = point?.closest?.('button,a,[role="button"],[role="option"],[role="menuitem"],[tabindex]') || point;
  if (!target || typeof target.click !== 'function') return false;
  target.click();
  return true;
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(
			script,
			timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
		if (!response.Success || response.Result is not bool clicked || !clicked)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME1_PAGE_CLICK_FAILED");
		}
	}

	private static async Task SaveQuickBackendDiagnosticAsync(
		ChromiumWebBrowser browser,
		string directory,
		JsonObject? state,
		string stage,
		string? errorCode)
	{
		string diagnosticStamp = DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmssfff");
		string diagnosticCode = Regex.Replace(errorCode ?? "snapshot", "[^A-Za-z0-9_-]", "-");
		string historyBaseName = $"scheme1-backend-diagnostic-{diagnosticStamp}-{diagnosticCode}";
		JsonObject diagnostic = new()
		{
			["capturedAt"] = DateTimeOffset.UtcNow.ToString("O"),
			["stage"] = stage,
			["errorCode"] = errorCode ?? string.Empty,
			["pageUrl"] = browser.Address ?? string.Empty,
			["state"] = state?.DeepClone(),
		};
		string historyJsonPath = Path.Combine(directory, $"{historyBaseName}.json");
		string historyScreenshotName = $"{historyBaseName}.png";
		await File.WriteAllTextAsync(
			historyJsonPath,
			diagnostic.ToJsonString(new JsonSerializerOptions { WriteIndented = true })).ConfigureAwait(false);
		string historyScreenshotPath = await CaptureQuickScreenshotAsync(browser, directory, historyScreenshotName).ConfigureAwait(false);
		File.Copy(historyJsonPath, Path.Combine(directory, "scheme1-backend-diagnostic.json"), true);
		File.Copy(historyScreenshotPath, Path.Combine(directory, "scheme1-backend-diagnostic.png"), true);
	}

	private static JsonObject EvidenceFileNode(string filePath)
	{
		if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath)) return new JsonObject();
		return new JsonObject
		{
			["name"] = Path.GetFileName(filePath),
			["path"] = filePath,
			["sha256"] = FileSha256(filePath),
		};
	}

	private static string OptionalFileSha256(string filePath) =>
		string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath) ? string.Empty : FileSha256(filePath);

	private static async Task<string> CaptureQuickScreenshotAsync(ChromiumWebBrowser browser, string directory, string fileName)
	{
		string filePath = Path.Combine(directory, fileName);
		using DevToolsClient devTools = browser.GetDevToolsClient();
		var response = await devTools.Page.CaptureScreenshotAsync(CaptureScreenshotFormat.Png, null, null, true, false, true).ConfigureAwait(false);
		await File.WriteAllBytesAsync(filePath, response.Data).ConfigureAwait(false);
		return filePath;
	}
}
