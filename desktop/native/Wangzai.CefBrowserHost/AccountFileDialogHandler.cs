using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows.Forms;
using CefSharp;
using CefSharp.Handler;

namespace Wangzai.CefBrowserHost;

internal sealed class AccountFileDialogHandler : DialogHandler
{
	private readonly BrowserHostForm owner;
	private readonly BrowserProfile profile;

	public AccountFileDialogHandler(BrowserHostForm owner, BrowserProfile profile)
	{
		this.owner = owner;
		this.profile = profile;
	}

	protected override bool OnFileDialog(
		IWebBrowser chromiumWebBrowser,
		IBrowser browser,
		CefFileDialogMode mode,
		string title,
		string defaultFilePath,
		IReadOnlyCollection<string> acceptFilters,
		IReadOnlyCollection<string> acceptExtensions,
		IReadOnlyCollection<string> acceptDescriptions,
		IFileDialogCallback callback)
	{
		if (owner.IsDisposed || owner.Disposing || !owner.IsHandleCreated)
		{
			callback.Cancel();
			callback.Dispose();
			return true;
		}
		try
		{
			owner.BeginInvoke(delegate
			{
			using (callback)
			{
				if (owner.IsDisposed) return;
				if (mode == CefFileDialogMode.OpenFolder)
				{
					using FolderBrowserDialog folder = new()
					{
						Description = string.IsNullOrWhiteSpace(title) ? "选择上传文件夹" : title,
						UseDescriptionForTitle = true,
						SelectedPath = InitialDirectory(defaultFilePath)
					};
					if (folder.ShowDialog(owner) == DialogResult.OK) callback.Continue([folder.SelectedPath]);
					else callback.Cancel();
					return;
				}
				if (mode == CefFileDialogMode.Save)
				{
					using SaveFileDialog save = new()
					{
						Title = string.IsNullOrWhiteSpace(title) ? "保存文件" : title,
						InitialDirectory = InitialDirectory(defaultFilePath),
						FileName = Path.GetFileName(defaultFilePath),
						Filter = Filter(acceptExtensions, acceptDescriptions),
						OverwritePrompt = true
					};
					if (save.ShowDialog(owner) == DialogResult.OK) callback.Continue([save.FileName]);
					else callback.Cancel();
					return;
				}
				using OpenFileDialog open = new()
				{
					Title = string.IsNullOrWhiteSpace(title) ? "选择上传文件" : title,
					InitialDirectory = InitialDirectory(defaultFilePath),
					Filter = Filter(acceptExtensions, acceptDescriptions),
					CheckFileExists = true,
					Multiselect = mode == CefFileDialogMode.OpenMultiple
				};
				if (open.ShowDialog(owner) == DialogResult.OK) callback.Continue(open.FileNames.ToList());
				else callback.Cancel();
			}
			});
		}
		catch (ObjectDisposedException)
		{
			callback.Cancel();
			callback.Dispose();
		}
		catch (InvalidOperationException)
		{
			callback.Cancel();
			callback.Dispose();
		}
		return true;
	}

	private string InitialDirectory(string defaultFilePath)
	{
		try
		{
			string full = Path.GetFullPath(defaultFilePath);
			if (Directory.Exists(full)) return full;
			string? directory = Path.GetDirectoryName(full);
			if (!string.IsNullOrWhiteSpace(directory) && Directory.Exists(directory)) return directory;
		}
		catch { }
		Directory.CreateDirectory(profile.DownloadsDirectory);
		return profile.DownloadsDirectory;
	}

	private static string Filter(IReadOnlyCollection<string> extensions, IReadOnlyCollection<string> descriptions)
	{
		string[] values = extensions
			.SelectMany(value => value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
			.Select(value => value.StartsWith('.') ? $"*{value}" : value.StartsWith('*') ? value : $"*.{value}")
			.Where(value => !value.Contains('|') && !value.Contains(Path.DirectorySeparatorChar))
			.Distinct(StringComparer.OrdinalIgnoreCase)
			.Take(50)
			.ToArray();
		if (values.Length == 0) return "所有文件 (*.*)|*.*";
		string description = descriptions.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))?.Trim() ?? "允许的文件";
		return $"{description}|{string.Join(';', values)}|所有文件 (*.*)|*.*";
	}
}
