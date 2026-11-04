using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CefSharp;
using CefSharp.DevTools;
using CefSharp.DevTools.Page;
using CefSharp.WinForms;

namespace Wangzai.CefBrowserHost;

internal sealed partial class BrowserHostForm
{
	private const string OzonComplaintSupportUrl = "https://www.ozon.ru/complaint/support/?platform=web";

	private sealed record ComplaintAttachment(string Kind, string Name, string Path, string Sha256);
	private sealed record ComplaintSupplement(string Name, string Path, string Sha256);

	public async Task<object> PrepareOzonFollowSellerScheme2EvidenceAsync(
		ChromiumWebBrowser browser,
		JsonObject payload)
	{
		string evidenceId = RequiredComplaintText(payload["evidenceId"], "FOLLOW_SELLER_EVIDENCE_ID_REQUIRED", 160);
		string originalSku = RequiredComplaintText(payload["originalSku"], "FOLLOW_SELLER_SCHEME2_ORIGINAL_SKU_REQUIRED", 30);
		string offerId = RequiredComplaintText(payload["offerId"], "FOLLOW_SELLER_SCHEME2_OFFER_ID_REQUIRED", 160);
		string materialDirectory = Path.GetFullPath(RequiredComplaintText(payload["materialDirectory"], "FOLLOW_SELLER_SCHEME2_DIRECTORY_REQUIRED", 1000));
		if (!Directory.Exists(materialDirectory)
			|| !materialDirectory.Contains($"{Path.DirectorySeparatorChar}follow-seller-evidence{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_DIRECTORY_FORBIDDEN");
		}
		string sourceProductUrl = RequiredComplaintText(payload["sourceProductUrl"], "FOLLOW_SELLER_SCHEME2_PRODUCT_URL_REQUIRED", 1000);
		if (!Uri.TryCreate(sourceProductUrl, UriKind.Absolute, out Uri? sourceUri)
			|| sourceUri.Scheme != Uri.UriSchemeHttps
			|| !(sourceUri.Host.Equals("ozon.ru", StringComparison.OrdinalIgnoreCase)
				|| sourceUri.Host.EndsWith(".ozon.ru", StringComparison.OrdinalIgnoreCase))
			|| !sourceProductUrl.Contains(originalSku, StringComparison.Ordinal))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_PRODUCT_URL_INVALID");
		}
		string[] followerSkus = payload["followerSkus"] is JsonArray skuNodes
			? skuNodes.Select(node => node?.GetValue<string>()?.Trim() ?? string.Empty)
				.Where(value => Regex.IsMatch(value, "^[0-9]{5,20}$", RegexOptions.CultureInvariant))
				.Distinct(StringComparer.Ordinal)
				.ToArray()
			: [];
		if (followerSkus.Length == 0) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_FOLLOWER_SKU_REQUIRED");
		QuickEvidenceFollower[] evidenceFollowers = ParseQuickEvidenceFollowers(payload, followerSkus);
		QuickEvidenceScreenshots screenshots = await PrepareQuickEvidenceScreenshotsAsync(
			browser,
			originalSku,
			offerId,
			sourceProductUrl,
			evidenceFollowers,
			materialDirectory).ConfigureAwait(false);
		string capturedAt = DateTimeOffset.UtcNow.ToString("O");
		JsonArray followerPages = new();
		for (int index = 0; index < screenshots.FollowerProductPages.Length; index += 1)
		{
			JsonObject file = EvidenceFileNode(screenshots.FollowerProductPages[index]);
			file["sku"] = evidenceFollowers[index].Sku;
			file["productLink"] = evidenceFollowers[index].ProductLink;
			followerPages.Add(file);
		}
		JsonObject ledger = new()
		{
			["schemaVersion"] = 1,
			["workflow"] = "ozon-scheme2-browser-evidence-v1",
			["evidenceId"] = evidenceId,
			["originalSku"] = originalSku,
			["offerId"] = offerId,
			["capturedAt"] = capturedAt,
			["listingDate"] = screenshots.ListingDate,
			["ownProductPage"] = EvidenceFileNode(screenshots.OwnProductPage),
			["ownSellerList"] = EvidenceFileNode(screenshots.OwnSellerList),
			["followerProductPages"] = followerPages.DeepClone(),
		};
		string ledgerPath = Path.Combine(materialDirectory, "scheme2-evidence-capture.json");
		await File.WriteAllTextAsync(
			ledgerPath,
			ledger.ToJsonString(new JsonSerializerOptions { WriteIndented = true })).ConfigureAwait(false);
		return new JsonObject
		{
			["ok"] = true,
			["workflow"] = "ozon-scheme2-browser-evidence-v1",
			["evidenceId"] = evidenceId,
			["originalSku"] = originalSku,
			["offerId"] = offerId,
			["capturedAt"] = capturedAt,
			["listingDate"] = screenshots.ListingDate,
			["ownProductPage"] = EvidenceFileNode(screenshots.OwnProductPage),
			["ownSellerList"] = EvidenceFileNode(screenshots.OwnSellerList),
			["followerProductPages"] = followerPages,
			["ledger"] = EvidenceFileNode(ledgerPath),
		};
	}

	public Task<object> SubmitOzonFollowSellerComplaintAsync(
		BrowserProfile profile,
		IRequestContext requestContext,
		JsonObject payload)
	{
		ComplaintAttachment[] attachments = ParseComplaintAttachments(payload);
		ComplaintSupplement supplement = ParseComplaintSupplement(payload, attachments);
		string evidenceId = RequiredComplaintText(payload["evidenceId"], "FOLLOW_SELLER_EVIDENCE_ID_REQUIRED", 160);
		string originalSku = RequiredComplaintText(payload["originalSku"], "FOLLOW_SELLER_SCHEME2_ORIGINAL_SKU_REQUIRED", 30);
		string offerId = RequiredComplaintText(payload["offerId"], "FOLLOW_SELLER_SCHEME2_OFFER_ID_REQUIRED", 160);
		string materialDirectory = Path.GetFullPath(RequiredComplaintText(payload["materialDirectory"], "FOLLOW_SELLER_SCHEME2_DIRECTORY_REQUIRED", 1000));
		if (!Directory.Exists(materialDirectory)
			|| !materialDirectory.Contains($"{Path.DirectorySeparatorChar}follow-seller-evidence{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase)
			|| !attachments.All(item => Path.GetDirectoryName(item.Path)!.Equals(materialDirectory, StringComparison.OrdinalIgnoreCase))
			|| !Path.GetDirectoryName(supplement.Path)!.Equals(materialDirectory, StringComparison.OrdinalIgnoreCase))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_DIRECTORY_FORBIDDEN");
		}
		string[] followerSkus = payload["followerSkus"] is JsonArray skuNodes
			? skuNodes.Select(node => node?.GetValue<string>()?.Trim() ?? string.Empty)
				.Where(value => Regex.IsMatch(value, "^[0-9]{5,20}$", RegexOptions.CultureInvariant))
				.Distinct(StringComparer.Ordinal)
				.ToArray()
			: [];
		if (followerSkus.Length == 0) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_FOLLOWER_SKU_REQUIRED");
		JsonObject? speech = payload["speech"] as JsonObject;
		string initialEvidenceText = RequiredComplaintText(speech?["initialEvidenceRu"] ?? speech?["ru"], "FOLLOW_SELLER_COMPLAINT_SPEECH_REQUIRED", 12000);
		string supplementText = RequiredComplaintText(speech?["supplementRu"], "FOLLOW_SELLER_SCHEME2_SUPPLEMENT_REQUIRED", 4000);
		string followerBatchText = RequiredComplaintText(speech?["followerBatchRu"], "FOLLOW_SELLER_SCHEME2_BATCH_REQUIRED", 4000);
		string listingDate = RequiredComplaintText(payload["listingDate"], "FOLLOW_SELLER_SCHEME2_LISTING_DATE_REQUIRED", 160);
		supplementText = supplementText.Replace("{{LISTING_DATE}}", listingDate, StringComparison.Ordinal);
		return SubmitOzonFollowSellerComplaintCoreAsync(
			profile,
			requestContext,
			evidenceId,
			originalSku,
			offerId,
			followerSkus,
			initialEvidenceText,
			supplementText,
			followerBatchText,
			listingDate,
			materialDirectory,
			attachments,
			supplement);
	}

	private Task<object> SubmitOzonFollowSellerComplaintCoreAsync(
		BrowserProfile profile,
		IRequestContext requestContext,
		string evidenceId,
		string originalSku,
		string offerId,
		string[] followerSkus,
		string initialEvidenceText,
		string supplementText,
		string followerBatchText,
		string listingDate,
		string materialDirectory,
		ComplaintAttachment[] attachments,
		ComplaintSupplement supplement)
	{
		TaskCompletionSource<object> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
		ChromiumWebBrowser? browser = null;
		HiddenBrowserSurface? surface = null;
		System.Threading.Timer? timeout = null;
		int settled = 0;
		int started = 0;
		int submissionStarted = 0;

		if (InvokeRequired) BeginInvoke(Create);
		else Create();
		return completion.Task;

		void Create()
		{
			try
			{
				browser = new ChromiumWebBrowser(OzonComplaintSupportUrl, requestContext)
				{
					Location = new System.Drawing.Point(-4096, -4096),
					Size = new System.Drawing.Size(1440, 1000),
					LifeSpanHandler = new InternalLifeSpanHandler(extensions),
					RequestHandler = new InternalRequestHandler(profile, extensions),
					PermissionHandler = new InternalPermissionHandler(this, extensions),
					RenderProcessMessageHandler = new FingerprintRenderProcessMessageHandler(profile),
					Visible = true,
				};
				surface = new HiddenBrowserSurface { Size = new System.Drawing.Size(1440, 1000) };
				browser.Dock = System.Windows.Forms.DockStyle.Fill;
				surface.Controls.Add(browser);
				browser.CreateControl();
				surface.Show();
				browser.LoadingStateChanged += (_, args) =>
				{
					if (!args.IsLoading && Interlocked.CompareExchange(ref started, 1, 0) == 0)
					{
						_ = RunAsync();
					}
				};
				_ = Task.Run(async () =>
				{
					await Task.Delay(3500).ConfigureAwait(false);
					if (Interlocked.CompareExchange(ref started, 1, 0) == 0) await RunAsync().ConfigureAwait(false);
				});
				timeout = new System.Threading.Timer(
					_ => Fail("FOLLOW_SELLER_COMPLAINT_BROWSER_TIMEOUT"),
					null,
					TimeSpan.FromSeconds(480),
					Timeout.InfiniteTimeSpan);
			}
			catch (Exception error)
			{
				Console.Error.WriteLine($"[follow-seller-complaint] create failed type={error.GetType().Name}");
				Fail("FOLLOW_SELLER_COMPLAINT_BROWSER_CREATE_FAILED");
			}
		}

		async Task RunAsync()
		{
			string stage = "front-route";
			JsonObject? lastState = null;
			JsonArray workflowTimeline = new();
			try
			{
				DateTime readyDeadline = DateTime.UtcNow.AddSeconds(15);
				while (browser is { IsDisposed: false }
					&& !browser.CanExecuteJavascriptInMainFrame
					&& DateTime.UtcNow < readyDeadline)
				{
					await Task.Delay(150).ConfigureAwait(false);
				}
				if (browser is null || browser.IsDisposed || !browser.CanExecuteJavascriptInMainFrame)
				{
					throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_PAGE_NOT_READY");
				}

				string[] initialPaths = attachments.Select(item => item.Path).ToArray();
				string[] initialNames = attachments.Select(item => item.Name).ToArray();
				string[] supplementPaths = [supplement.Path];
				string[] supplementNames = [supplement.Name];
				string beforeScreenshot = string.Empty;
				string supplementBeforeScreenshot = string.Empty;
				bool strictConversationReady = false;
				string ticketId = string.Empty;
				string lastTimelineStatus = string.Empty;
				DateTime deadline = DateTime.UtcNow.AddSeconds(430);
				while (DateTime.UtcNow < deadline)
				{
					if (browser is null || browser.IsDisposed)
					{
						throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_BROWSER_CLOSED");
					}
					JsonObject state = strictConversationReady
						? await EvaluateQuickBackendComplaintStateAsync(
							browser,
							evidenceId,
							originalSku,
							followerSkus,
							initialEvidenceText,
							supplementText,
							followerBatchText,
							false,
							string.Empty).ConfigureAwait(false)
						: await EvaluateComplaintEntryStateAsync(browser).ConfigureAwait(false);
					lastState = state;
					string status = state["status"]?.GetValue<string>() ?? string.Empty;
					stage = strictConversationReady ? $"strict-chat:{status}" : $"front-route:{status}";
					if (!status.Equals(lastTimelineStatus, StringComparison.Ordinal))
					{
						workflowTimeline.Add(new JsonObject
						{
							["at"] = DateTimeOffset.UtcNow.ToString("O"),
							["stage"] = stage,
							["action"] = state["action"]?.GetValue<string>() ?? string.Empty,
						});
						lastTimelineStatus = status;
					}
					if (status == "login-required") throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_LOGIN_REQUIRED");
					if (status == "captcha") throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_CAPTCHA_REQUIRED");
					if (status == "daily-limit") throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT");
					if (status == "original-sku-not-found") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_ORIGINAL_SKU_NOT_FOUND");
					if (status == "follower-sku-not-found") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_FOLLOWER_SKU_NOT_FOUND");
					if (status == "materials-rejected") throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_SUPPLEMENT_REJECTED");
					if (status == "route-not-found") throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_ROUTE_CHANGED");
					if (status == "chat-ready")
					{
						ticketId = state["ticketId"]?.GetValue<string>() ?? string.Empty;
						if (string.IsNullOrWhiteSpace(ticketId)) throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_RECEIPT_REQUIRED");
						await PrimeQuickComplaintRuntimeAsync(browser, evidenceId, ticketId, 3).ConfigureAwait(false);
						strictConversationReady = true;
						await Task.Delay(450).ConfigureAwait(false);
						continue;
					}
					if (status == "click-required")
					{
						double x = state["x"]?.GetValue<double>() ?? -1;
						double y = state["y"]?.GetValue<double>() ?? -1;
						if (x < 0 || y < 0) throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_CLICK_TARGET_INVALID");
						await DispatchQuickTrustedClickAsync(browser, x, y).ConfigureAwait(false);
						await Task.Delay(850).ConfigureAwait(false);
						continue;
					}
					if (status == "type-message-required")
					{
						string action = state["action"]?.GetValue<string>() ?? string.Empty;
						string message = action switch
						{
							"original-sku" => originalSku,
							"follower-sku" => followerSkus[0],
							"follower-batch" => followerBatchText,
							_ => throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_MESSAGE_ACTION_INVALID"),
						};
						await TypeQuickComplaintMessageAsync(browser, message).ConfigureAwait(false);
						Interlocked.Exchange(ref submissionStarted, 1);
						await ClickQuickComplaintSendAsync(browser, message).ConfigureAwait(false);
						string nextPhase = action switch
						{
							"original-sku" => "wait-follower-prompt",
							"follower-sku" => "wait-evidence-prompt",
							"follower-batch" => "submitted-awaiting-support-reply",
							_ => throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_MESSAGE_ACTION_INVALID"),
						};
						await SetQuickComplaintPhaseAsync(browser, evidenceId, nextPhase).ConfigureAwait(false);
						await Task.Delay(850).ConfigureAwait(false);
						continue;
					}
					if (status == "initial-evidence-required")
					{
						beforeScreenshot = await SubmitComplaintDocumentBundleAsync(
							browser,
							initialPaths,
							initialNames,
							initialEvidenceText,
							materialDirectory,
							"scheme2-initial-evidence-before.png").ConfigureAwait(false);
						await SetQuickComplaintPhaseAsync(browser, evidenceId, "wait-initial-reply").ConfigureAwait(false);
						await Task.Delay(900).ConfigureAwait(false);
						continue;
					}
					if (status == "supplement-required")
					{
						supplementBeforeScreenshot = await SubmitQuickComplaintBundleAsync(
							browser,
							supplementPaths,
							supplementNames,
							supplementText,
							materialDirectory,
							"scheme2-supplement-before.png").ConfigureAwait(false);
						await SetQuickComplaintPhaseAsync(browser, evidenceId, "wait-supplement-reply").ConfigureAwait(false);
						await Task.Delay(900).ConfigureAwait(false);
						continue;
					}
					if (status == "submitted")
					{
						string receiptId = state["receiptId"]?.GetValue<string>() ?? ticketId;
						if (string.IsNullOrWhiteSpace(receiptId)) throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_RECEIPT_REQUIRED");
						string afterScreenshot = await CaptureQuickScreenshotAsync(browser, materialDirectory, "scheme2-submission-after.png").ConfigureAwait(false);
						JsonObject evidenceLedger = new()
						{
							["schemaVersion"] = 1,
							["workflow"] = "ozon-front-content-complaint-v2",
							["evidenceId"] = evidenceId,
							["ticketId"] = receiptId,
							["submittedAt"] = DateTimeOffset.UtcNow.ToString("O"),
							["originalSku"] = originalSku,
							["offerId"] = offerId,
							["followerSkus"] = new JsonArray(followerSkus.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
							["listingDate"] = listingDate,
							["messages"] = new JsonObject
							{
								["originalSku"] = originalSku,
								["firstFollowerSku"] = followerSkus[0],
								["initialEvidenceRu"] = initialEvidenceText,
								["supplementRu"] = supplementText,
								["followerBatchRu"] = followerBatchText,
							},
							["initialAttachmentOrder"] = new JsonArray(initialPaths.Select(path => (JsonNode?)EvidenceFileNode(path)).ToArray()),
							["supplementAttachmentOrder"] = new JsonArray(supplementPaths.Select(path => (JsonNode?)EvidenceFileNode(path)).ToArray()),
							["workflowTimeline"] = workflowTimeline,
							["initialEvidenceBefore"] = EvidenceFileNode(beforeScreenshot),
							["supplementBefore"] = EvidenceFileNode(supplementBeforeScreenshot),
							["submissionAfter"] = EvidenceFileNode(afterScreenshot),
						};
						string evidenceLedgerPath = Path.Combine(materialDirectory, "scheme2-browser-evidence.json");
						await File.WriteAllTextAsync(
							evidenceLedgerPath,
							evidenceLedger.ToJsonString(new JsonSerializerOptions { WriteIndented = true })).ConfigureAwait(false);
						JsonObject result = new()
						{
							["ok"] = true,
							["submissionStarted"] = true,
							["scheme"] = "scheme2-watermark-evidence",
							["workflow"] = "ozon-front-content-complaint-v2",
							["status"] = "submitted-awaiting-support-reply",
							["evidenceId"] = evidenceId,
							["ticketId"] = receiptId,
							["messageId"] = receiptId,
							["pageUrl"] = browser.Address ?? OzonComplaintSupportUrl,
							["submittedAt"] = DateTimeOffset.UtcNow.ToString("O"),
							["originalSku"] = originalSku,
							["followerSkus"] = new JsonArray(followerSkus.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
							["evidenceLedgerPath"] = evidenceLedgerPath,
							["evidenceLedgerSha256"] = FileSha256(evidenceLedgerPath),
							["beforeScreenshotPath"] = beforeScreenshot,
							["beforeScreenshotSha256"] = FileSha256(beforeScreenshot),
							["supplementBeforeScreenshotPath"] = supplementBeforeScreenshot,
							["supplementBeforeScreenshotSha256"] = OptionalFileSha256(supplementBeforeScreenshot),
							["afterScreenshotPath"] = afterScreenshot,
							["afterScreenshotSha256"] = FileSha256(afterScreenshot),
						};
						Succeed(result);
						return;
					}
					await Task.Delay(650).ConfigureAwait(false);
				}
				throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_RECEIPT_TIMEOUT");
			}
			catch (Exception error)
			{
				string code = ErrorCode.From(error);
				if (browser is not null && !browser.IsDisposed)
				{
					try
					{
						await SaveScheme2DiagnosticAsync(browser, materialDirectory, lastState, stage, code).ConfigureAwait(false);
					}
					catch (Exception diagnosticError)
					{
						Console.Error.WriteLine($"[follow-seller-scheme2] diagnostic-failed type={diagnosticError.GetType().Name}");
					}
				}
				Console.Error.WriteLine($"[follow-seller-complaint] failed code={code} stage={stage} type={error.GetType().Name}");
				Fail(code.StartsWith("FOLLOW_SELLER_", StringComparison.Ordinal)
					? code
					: "FOLLOW_SELLER_COMPLAINT_SUBMIT_FAILED");
			}
		}

		void Succeed(JsonObject result)
		{
			if (Interlocked.Exchange(ref settled, 1) != 0) return;
			timeout?.Dispose();
			completion.TrySetResult(result);
			Cleanup();
		}

		void Fail(string code)
		{
			if (Interlocked.Exchange(ref settled, 1) != 0) return;
			timeout?.Dispose();
			completion.TrySetResult(new JsonObject
			{
				["ok"] = false,
				["submissionStarted"] = Volatile.Read(ref submissionStarted) == 1,
				["error"] = new JsonObject
				{
					["code"] = code,
					["message"] = code,
				},
			});
			Cleanup();
		}

		void Cleanup()
		{
			if (InvokeRequired) BeginInvoke(Remove);
			else Remove();
		}

		void Remove()
		{
			if (browser is not null)
			{
				surface?.Controls.Remove(browser);
				browser.Dispose();
				browser = null;
			}
			if (surface is not null)
			{
				surface.Close();
				surface.Dispose();
				surface = null;
			}
		}
	}

	private static ComplaintAttachment[] ParseComplaintAttachments(JsonObject payload)
	{
		if (payload["attachments"] is not JsonArray values || values.Count != 2)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_EVIDENCE_PAIR_REQUIRED");
		}
		List<ComplaintAttachment> results = [];
		foreach (JsonNode? node in values)
		{
			if (node is not JsonObject item) throw new InvalidOperationException("FOLLOW_SELLER_EVIDENCE_ATTACHMENT_INVALID");
			string kind = RequiredComplaintText(item["kind"], "FOLLOW_SELLER_EVIDENCE_ATTACHMENT_INVALID", 10).ToLowerInvariant();
			string filePath = Path.GetFullPath(RequiredComplaintText(item["path"], "FOLLOW_SELLER_EVIDENCE_ATTACHMENT_INVALID", 1000));
			string expectedHash = RequiredComplaintText(item["sha256"], "FOLLOW_SELLER_EVIDENCE_ATTACHMENT_INVALID", 64).ToLowerInvariant();
			if ((kind != "psd" && kind != "pdf") || !Regex.IsMatch(expectedHash, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant))
			{
				throw new InvalidOperationException("FOLLOW_SELLER_EVIDENCE_ATTACHMENT_INVALID");
			}
			if (!File.Exists(filePath) || !filePath.Contains($"{Path.DirectorySeparatorChar}follow-seller-evidence{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase))
			{
				throw new InvalidOperationException("FOLLOW_SELLER_EVIDENCE_ATTACHMENT_PATH_FORBIDDEN");
			}
			byte[] bytes = File.ReadAllBytes(filePath);
			bool magicValid = kind == "psd"
				? bytes.AsSpan().StartsWith("8BPS"u8)
				: bytes.AsSpan().StartsWith("%PDF-"u8);
			if (bytes.Length == 0 || bytes.Length > 50 * 1024 * 1024 || !magicValid || Sha256(bytes) != expectedHash)
			{
				throw new InvalidOperationException("FOLLOW_SELLER_EVIDENCE_ATTACHMENT_TAMPERED");
			}
			results.Add(new ComplaintAttachment(kind, Path.GetFileName(filePath), filePath, expectedHash));
		}
		if (results.Select(item => item.Kind).Distinct(StringComparer.OrdinalIgnoreCase).Count() != 2)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_EVIDENCE_PAIR_REQUIRED");
		}
		return results
			.OrderBy(item => item.Kind.Equals("psd", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
			.ToArray();
	}

	private static ComplaintSupplement ParseComplaintSupplement(
		JsonObject payload,
		ComplaintAttachment[] attachments)
	{
		if (payload["supplementAttachments"] is not JsonArray values || values.Count != 1)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_SUPPLEMENT_PAIR_REQUIRED");
		}
		if (values[0] is not JsonObject item)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_SUPPLEMENT_INVALID");
		}
		string kind = RequiredComplaintText(item["kind"], "FOLLOW_SELLER_SCHEME2_SUPPLEMENT_INVALID", 32).ToLowerInvariant();
		string filePath = Path.GetFullPath(RequiredComplaintText(item["path"], "FOLLOW_SELLER_SCHEME2_SUPPLEMENT_INVALID", 1000));
		string expectedHash = RequiredComplaintText(item["sha256"], "FOLLOW_SELLER_SCHEME2_SUPPLEMENT_INVALID", 64).ToLowerInvariant();
		string attachmentDirectory = Path.GetDirectoryName(attachments.First().Path)
			?? throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_SUPPLEMENT_PATH_FORBIDDEN");
		if (kind != "supplement_image"
			|| !Regex.IsMatch(expectedHash, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)
			|| !File.Exists(filePath)
			|| !Path.GetDirectoryName(filePath)!.Equals(attachmentDirectory, StringComparison.OrdinalIgnoreCase)
			|| !Path.GetExtension(filePath).Equals(".png", StringComparison.OrdinalIgnoreCase))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_SUPPLEMENT_PATH_FORBIDDEN");
		}
		byte[] bytes = File.ReadAllBytes(filePath);
		ReadOnlySpan<byte> pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		if (bytes.Length < pngMagic.Length
			|| bytes.Length > 20 * 1024 * 1024
			|| !bytes.AsSpan(0, pngMagic.Length).SequenceEqual(pngMagic)
			|| Sha256(bytes) != expectedHash)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_SUPPLEMENT_TAMPERED");
		}
		return new ComplaintSupplement(Path.GetFileName(filePath), filePath, expectedHash);
	}

	private static async Task<string> SubmitComplaintDocumentBundleAsync(
		ChromiumWebBrowser browser,
		string[] attachmentPaths,
		string[] expectedNames,
		string message,
		string materialDirectory,
		string beforeScreenshotName)
	{
		if (attachmentPaths.Length != 2
			|| attachmentPaths.Length != expectedNames.Length
			|| !Path.GetExtension(attachmentPaths[0]).Equals(".psd", StringComparison.OrdinalIgnoreCase)
			|| !Path.GetExtension(attachmentPaths[1]).Equals(".pdf", StringComparison.OrdinalIgnoreCase))
		{
			throw new InvalidOperationException("FOLLOW_SELLER_EVIDENCE_PAIR_REQUIRED");
		}
		int beforeDocumentCount = await GetComplaintHistoryDocumentCountAsync(browser).ConfigureAwait(false);
		await TypeQuickComplaintMessageAsync(browser, message).ConfigureAwait(false);
		string beforeScreenshot = await CaptureQuickScreenshotAsync(
			browser,
			materialDirectory,
			beforeScreenshotName).ConfigureAwait(false);
		await AttachComplaintFilesAsync(browser, attachmentPaths).ConfigureAwait(false);
		await ClickQuickComplaintSendAsync(browser, message, requireMessageReadback: false).ConfigureAwait(false);
		bool submitted = await WaitForComplaintDocumentSubmissionReadbackAsync(
			browser,
			message,
			expectedNames,
			beforeDocumentCount,
			TimeSpan.FromSeconds(120)).ConfigureAwait(false);
		if (!submitted)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_SCHEME2_DOCUMENT_SUBMIT_NOT_CONFIRMED");
		}
		return beforeScreenshot;
	}

	private static async Task<int> GetComplaintHistoryDocumentCountAsync(ChromiumWebBrowser browser)
	{
		const string script = """
(() => {
  const composer = document.querySelector('[current-chat-id]');
  const conversation = composer?.parentElement || null;
  if (!composer || !conversation) return 0;
  const nodes = [...conversation.querySelectorAll('a,[download],[data-testid*="attachment" i],[class*="attachment" i],[class*="file" i]')]
    .filter(node => !composer.contains(node));
  const documents = nodes.filter(node => {
    const value = `${node.innerText || node.textContent || ''} ${node.getAttribute?.('href') || ''} ${node.getAttribute?.('download') || ''}`;
    return /\.psd(?:\b|$)|\.pdf(?:\b|$)/i.test(value)
      || /скачать файл|download file|document|документ/i.test(value);
  });
  return new Set(documents).size;
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
		return response.Success ? Convert.ToInt32(response.Result ?? 0) : 0;
	}

	private static async Task<bool> WaitForComplaintDocumentSubmissionReadbackAsync(
		ChromiumWebBrowser browser,
		string expectedMessage,
		string[] expectedNames,
		int beforeDocumentCount,
		TimeSpan timeout)
	{
		string marker = Regex.Replace(expectedMessage, "\\s+", " ").Trim();
		marker = marker[..Math.Min(80, marker.Length)];
		string markerJson = JsonSerializer.Serialize(marker);
		string namesJson = JsonSerializer.Serialize(expectedNames);
		string beforeCountJson = JsonSerializer.Serialize(beforeDocumentCount);
		string script = $$"""
(() => {
  const composer = document.querySelector('[current-chat-id]');
  const conversation = composer?.parentElement || null;
  if (!composer || !conversation) return JSON.stringify({ ok: false });
  const visible = node => !!node && node.getClientRects().length > 0
    && getComputedStyle(node).visibility !== 'hidden';
  const history = conversation.cloneNode(true);
  history.querySelector('[current-chat-id]')?.remove();
  const historyText = String(history.innerText || '').replace(/\s+/g, ' ').trim();
  const textarea = [...composer.querySelectorAll('textarea,[contenteditable="true"]')]
    .find(node => visible(node) && !node.disabled) || null;
  const inputText = textarea ? String(textarea.value ?? textarea.textContent ?? '').trim() : '';
  const uploading = !!composer.querySelector('[role="progressbar"],[aria-busy="true"]')
    || /загрузка|uploading|正在上传/i.test(String(composer.innerText || ''));
  const historyNodes = [...conversation.querySelectorAll('a,[download],[data-testid*="attachment" i],[class*="attachment" i],[class*="file" i]')]
    .filter(node => !composer.contains(node));
  const documentNodes = historyNodes.filter(node => {
    const value = `${node.innerText || node.textContent || ''} ${node.getAttribute?.('href') || ''} ${node.getAttribute?.('download') || ''}`;
    return /\.psd(?:\b|$)|\.pdf(?:\b|$)/i.test(value)
      || /скачать файл|download file|document|документ/i.test(value);
  });
  const expectedNames = {{namesJson}};
  const namedCount = expectedNames.filter(name => historyText.includes(name)).length;
  const documentCount = new Set(documentNodes).size;
  const beforeCount = {{beforeCountJson}};
  const marker = {{markerJson}};
  return JSON.stringify({
    ok: !!marker && historyText.includes(marker) && inputText === '' && !uploading
      && (namedCount === expectedNames.length || documentCount - beforeCount >= expectedNames.length),
    namedCount,
    documentCount,
    inputLength: inputText.length,
    uploading,
  });
})()
""";
		DateTime deadline = DateTime.UtcNow.Add(timeout);
		int stableReads = 0;
		while (DateTime.UtcNow < deadline)
		{
			JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
			JsonObject? state = response.Success && response.Result is string json ? JsonNode.Parse(json) as JsonObject : null;
			stableReads = state?["ok"]?.GetValue<bool>() == true ? stableReads + 1 : 0;
			if (stableReads >= 3) return true;
			await Task.Delay(300).ConfigureAwait(false);
		}
		return false;
	}

	private static async Task SaveScheme2DiagnosticAsync(
		ChromiumWebBrowser browser,
		string materialDirectory,
		JsonObject? state,
		string stage,
		string errorCode)
	{
		string screenshotPath = await CaptureQuickScreenshotAsync(
			browser,
			materialDirectory,
			"scheme2-diagnostic.png").ConfigureAwait(false);
		JsonObject diagnostic = new()
		{
			["schemaVersion"] = 1,
			["workflow"] = "ozon-front-content-complaint-v2",
			["capturedAt"] = DateTimeOffset.UtcNow.ToString("O"),
			["stage"] = stage,
			["errorCode"] = errorCode,
			["pageUrl"] = browser.Address ?? string.Empty,
			["state"] = state?.DeepClone(),
			["screenshot"] = EvidenceFileNode(screenshotPath),
		};
		string diagnosticPath = Path.Combine(materialDirectory, "scheme2-diagnostic.json");
		await File.WriteAllTextAsync(
			diagnosticPath,
			diagnostic.ToJsonString(new JsonSerializerOptions { WriteIndented = true })).ConfigureAwait(false);
	}

	private static string RequiredComplaintText(JsonNode? node, string code, int maximum)
	{
		string value = node?.GetValue<string>()?.Trim() ?? string.Empty;
		if (value.Length == 0 || value.Length > maximum || value.Any(ch => ch < ' ' && ch is not '\r' and not '\n' and not '\t'))
		{
			throw new InvalidOperationException(code);
		}
		return value;
	}

	private static async Task<JsonObject> EvaluateComplaintEntryStateAsync(ChromiumWebBrowser browser)
	{
		const string script = """
(() => {
  const runtime = window.__wangzaiFollowSellerComplaintEntry ||= { clicked: [], startedAt: Date.now() };
  const visible = (node) => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const bodyText = clean(document.body?.innerText || '');
  const url = String(location.href || '');
  if (/\/(?:signin|login)(?:\/|\?|$)/i.test(url) || ((/войти|登录|sign in/i.test(bodyText)) && !document.querySelector('textarea,[contenteditable="true"]'))) {
    return JSON.stringify({ status: 'login-required', url });
  }
  if (/captcha|капч|подтвердите, что вы не робот|验证码|人机验证/i.test(bodyText)) {
    return JSON.stringify({ status: 'captcha', url });
  }
  if (/已超过了此问题的申请次数的限制|24小时后创建新申请|превысили.*лимит.*обращен|создать.*через 24 час/i.test(bodyText)) {
    return JSON.stringify({ status: 'daily-limit', url });
  }
  const composer = document.querySelector('[current-chat-id]');
  const conversation = composer?.parentElement || null;
  const ticketId = clean(conversation?.querySelector('.m9d-o7')?.textContent || '').match(/[0-9]{6,20}/)?.[0] || '';
  const history = conversation?.cloneNode(true) || null;
  history?.querySelector('[current-chat-id]')?.remove();
  const chatText = clean(history?.innerText || '');
  const ownPrompt = /请发送被其他卖家使用的商品卡片对应的\s*SKU|пришлите.*sku.*(?:вашей|своей|использует)/i.test(chatText);
  if (composer && ticketId && ownPrompt) {
    return JSON.stringify({ status: 'chat-ready', ticketId, url });
  }
  const clickable = [...document.querySelectorAll('button,a,[role="button"],[role="menuitem"],[role="option"],label,.om_6inde--yWDHe')]
    .filter(visible);
  const route = [
    { key: 'seller', labels: ['Я продавец', '我是卖家'] },
    { key: 'new-request', labels: ['Создать заявку', 'Создать обращение', '创建申请'] },
    { key: 'product-prices', labels: ['Товары и цены', 'Products and prices', '商品和价格'] },
    { key: 'quality-control', labels: ['Контроль качества', 'Quality control', '质量监督'] },
    { key: 'seller-content-use', labels: ['Продавец использует мой контент', 'Seller uses my content', '卖家使用我的内容'] },
  ];
  for (const step of route) {
    if (runtime.clicked.includes(step.key)) continue;
    const target = clickable.find(node => step.labels.some(label => clean(node.innerText || node.textContent) === label))
      || clickable.find(node => step.labels.some(label => clean(node.innerText || node.textContent).includes(label)));
    if (target) {
      runtime.clicked.push(step.key);
      const rect = target.getBoundingClientRect();
      return JSON.stringify({
        status: 'click-required',
        action: step.key,
        x: Math.max(0, rect.left + rect.width / 2),
        y: Math.max(0, rect.top + rect.height / 2),
        url,
      });
    }
  }
  if (Date.now() - runtime.startedAt > 65000) {
    return JSON.stringify({ status: 'route-not-found', url, excerpt: bodyText.slice(0, 500) });
  }
  return JSON.stringify({ status: 'waiting', ticketId, url });
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(12)).ConfigureAwait(false);
		if (!response.Success || response.Result is not string json)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_PAGE_SCRIPT_FAILED");
		}
		return JsonNode.Parse(json) as JsonObject
			?? throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_PAGE_STATE_INVALID");
	}

	private static async Task AttachComplaintFilesAsync(ChromiumWebBrowser browser, string[] filePaths)
	{
		using DevToolsClient devTools = browser.GetDevToolsClient();
		TaskCompletionSource<int> chooserOpened = new(TaskCreationOptions.RunContinuationsAsynchronously);
		EventHandler<FileChooserOpenedEventArgs>? handler = null;
		handler = (_, args) =>
		{
			if (args.BackendNodeId is int backendNodeId && backendNodeId > 0)
			{
				chooserOpened.TrySetResult(backendNodeId);
			}
		};
		devTools.Page.FileChooserOpened += handler;
		try
		{
			await devTools.Page.EnableAsync(true).ConfigureAwait(false);
			await devTools.Page.SetInterceptFileChooserDialogAsync(true, false).ConfigureAwait(false);
			const string targetScript = """
(() => {
  const composer = document.querySelector('[current-chat-id]');
  if (!composer) return JSON.stringify({ ok: false });
  const visible = node => !!node && node.getClientRects().length > 0
    && getComputedStyle(node).visibility !== 'hidden';
  const buttons = [...composer.querySelectorAll('button[type="submit"]')].filter(visible);
  const target = buttons[0] || null;
  if (!target) return JSON.stringify({ ok: false });
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
			JavascriptResponse targetResponse = await browser.EvaluateScriptAsync(targetScript, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
			JsonObject? target = targetResponse.Success && targetResponse.Result is string json
				? JsonNode.Parse(json) as JsonObject
				: null;
			if (target?["ok"]?.GetValue<bool>() != true)
			{
				throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_ATTACHMENT_BUTTON_REQUIRED");
			}
			await DispatchQuickTrustedClickAsync(
				browser,
				target["x"]?.GetValue<double>() ?? -1,
				target["y"]?.GetValue<double>() ?? -1).ConfigureAwait(false);
			Task completed = await Task.WhenAny(chooserOpened.Task, Task.Delay(TimeSpan.FromSeconds(8))).ConfigureAwait(false);
			if (completed != chooserOpened.Task)
			{
				throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_FILE_CHOOSER_TIMEOUT");
			}
			int backendNodeId = await chooserOpened.Task.ConfigureAwait(false);
			await devTools.DOM.SetFileInputFilesAsync(filePaths, null, backendNodeId, null!).ConfigureAwait(false);
		}
		finally
		{
			devTools.Page.FileChooserOpened -= handler;
			try
			{
				await devTools.Page.SetInterceptFileChooserDialogAsync(false, false).ConfigureAwait(false);
			}
			catch
			{
				// The page can navigate immediately after accepting the file. The
				// verified attachment readback below remains the source of truth.
			}
		}
	}

	private static async Task ClickComplaintSubmitAsync(ChromiumWebBrowser browser)
	{
		const string script = """
(() => {
  const visible = node => !!node && node.getClientRects().length > 0;
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const labels = ['Отправить обращение', 'Создать обращение', 'Отправить', '提交', '发送'];
  const target = [...document.querySelectorAll('button,[role="button"]')]
    .filter(visible)
    .find(node => labels.includes(clean(node.innerText || node.textContent)) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
  if (!target) return false;
  const runtime = window.__wangzaiFollowSellerComplaint ||= {};
  runtime.submitClicked = true;
  target.click();
  return true;
})()
""";
		JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout: TimeSpan.FromSeconds(8)).ConfigureAwait(false);
		if (!response.Success || response.Result is not true)
		{
			throw new InvalidOperationException("FOLLOW_SELLER_COMPLAINT_SUBMIT_BUTTON_REQUIRED");
		}
	}

	private static async Task<string> CaptureComplaintScreenshotAsync(
		ChromiumWebBrowser browser,
		ComplaintAttachment[] attachments,
		string fileName)
	{
		string directory = Path.GetDirectoryName(attachments.First().Path)
			?? throw new InvalidOperationException("FOLLOW_SELLER_EVIDENCE_ATTACHMENT_PATH_FORBIDDEN");
		string filePath = Path.Combine(directory, fileName);
		using DevToolsClient devTools = browser.GetDevToolsClient();
		var response = await devTools.Page.CaptureScreenshotAsync(
			CaptureScreenshotFormat.Png,
			null,
			null,
			true,
			false,
			true).ConfigureAwait(false);
		byte[] bytes = response.Data;
		await File.WriteAllBytesAsync(filePath, bytes).ConfigureAwait(false);
		return filePath;
	}

	private static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

	private static string FileSha256(string filePath) => Sha256(File.ReadAllBytes(filePath));
}
