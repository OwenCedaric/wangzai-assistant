using System;
using System.Collections.Generic;
using System.IO;
using System.Windows.Forms;
using CefSharp;
using CefSharp.Handler;

namespace Wangzai.CefBrowserHost;

internal sealed record DownloadProgressInfo(
	int Id,
	string FileName,
	string Path,
	int Progress,
	long ReceivedBytes,
	long TotalBytes,
	bool Complete,
	bool Cancelled,
	bool Interrupted,
	string Reason);

internal sealed class AccountDownloadHandler : DownloadHandler
{
	private readonly BrowserHostForm owner;
	private readonly BrowserProfile profile;
	private readonly Dictionary<int, int> lastProgress = new();

	public AccountDownloadHandler(BrowserHostForm owner, BrowserProfile profile)
	{
		this.owner = owner;
		this.profile = profile;
	}

	protected override bool CanDownload(IWebBrowser chromiumWebBrowser, IBrowser browser, string url, string requestMethod)
	{
		return BrowserUrlPolicy.IsWebUrl(url) && string.Equals(requestMethod, "GET", StringComparison.OrdinalIgnoreCase);
	}

	protected override bool OnBeforeDownload(
		IWebBrowser chromiumWebBrowser,
		IBrowser browser,
		DownloadItem downloadItem,
		IBeforeDownloadCallback callback)
	{
		if (callback.IsDisposed) return true;
		if (owner.IsDisposed || owner.Disposing || !owner.IsHandleCreated)
		{
			callback.Dispose();
			return true;
		}
		try
		{
			owner.BeginInvoke(delegate
			{
				using (callback)
				{
				if (owner.IsDisposed || owner.Disposing || !downloadItem.IsValid) return;
				Directory.CreateDirectory(profile.DownloadsDirectory);
				using SaveFileDialog dialog = new()
				{
					Title = "保存下载文件",
					InitialDirectory = profile.DownloadsDirectory,
					FileName = SafeFileName(downloadItem.SuggestedFileName),
					OverwritePrompt = true,
					AddExtension = true
				};
				if (dialog.ShowDialog(owner) == DialogResult.OK)
				{
					callback.Continue(dialog.FileName, showDialog: false);
				}
				}
			});
		}
		catch (ObjectDisposedException)
		{
			callback.Dispose();
		}
		catch (InvalidOperationException)
		{
			callback.Dispose();
		}
		return true;
	}

	protected override void OnDownloadUpdated(
		IWebBrowser chromiumWebBrowser,
		IBrowser browser,
		DownloadItem downloadItem,
		IDownloadItemCallback callback)
	{
		if (!downloadItem.IsValid) return;
		int progress = downloadItem.PercentComplete;
		bool terminal = downloadItem.IsComplete || downloadItem.IsCancelled || downloadItem.IsInterrupted;
		bool changed = !lastProgress.TryGetValue(downloadItem.Id, out int previous)
			|| progress < 0
			|| progress / 10 != previous / 10;
		if (!changed && !terminal) return;
		lastProgress[downloadItem.Id] = progress;
		if (terminal) lastProgress.Remove(downloadItem.Id);
		owner.OnDownloadChanged(profile.OwnerRef, new DownloadProgressInfo(
			downloadItem.Id,
			SafeFileName(downloadItem.SuggestedFileName),
			terminal && downloadItem.IsComplete ? downloadItem.FullPath : string.Empty,
			progress,
			downloadItem.ReceivedBytes,
			downloadItem.TotalBytes,
			downloadItem.IsComplete,
			downloadItem.IsCancelled,
			downloadItem.IsInterrupted,
			downloadItem.IsInterrupted ? downloadItem.InterruptReason.ToString() : string.Empty));
	}

	private static string SafeFileName(string? value)
	{
		string fileName = Path.GetFileName(string.IsNullOrWhiteSpace(value) ? "下载文件" : value.Trim());
		foreach (char character in Path.GetInvalidFileNameChars()) fileName = fileName.Replace(character, '_');
		return fileName.Length > 180 ? fileName[..180] : fileName;
	}
}
