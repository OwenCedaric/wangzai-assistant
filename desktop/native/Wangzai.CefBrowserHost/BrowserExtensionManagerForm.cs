using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace Wangzai.CefBrowserHost;

internal sealed class BrowserExtensionManagerForm : Form
{
	private readonly BrowserExtensionPackageManager manager;
	private readonly Action<BrowserExtensionPackage> openExtension;
	private readonly IReadOnlyDictionary<string, BrowserExtensionPackage> loadedAtStartup;
	private readonly ListView list = new();
	private readonly Label status = new();
	private IReadOnlyList<BrowserExtensionPackage> packages = [];

	public BrowserExtensionManagerForm(
		BrowserExtensionPackageManager manager,
		IReadOnlyDictionary<string, BrowserExtensionPackage> loadedExtensions,
		Action<BrowserExtensionPackage> openExtension)
	{
		this.manager = manager;
		this.openExtension = openExtension;
		loadedAtStartup = new Dictionary<string, BrowserExtensionPackage>(loadedExtensions, StringComparer.OrdinalIgnoreCase);
		Text = "浏览器插件管理";
		StartPosition = FormStartPosition.CenterParent;
		MinimumSize = new Size(760, 500);
		Size = new Size(900, 600);
		BackColor = Color.White;
		Font = new Font("Microsoft YaHei UI", 9.5f);
		ShowInTaskbar = false;

		Label title = new()
		{
			Text = "浏览器插件",
			Dock = DockStyle.Top,
			Height = 42,
			Padding = new Padding(16, 10, 16, 0),
			Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold),
			ForeColor = Color.FromArgb(42, 53, 71)
		};
		Label description = new()
		{
			Text = "支持 Manifest V3 文件夹、ZIP 和 CRX，不自动改写旧版 MV2。启停或更新后需完全退出客户端再打开；仅刷新网页不能替代重启。",
			Dock = DockStyle.Top,
			Height = 52,
			Padding = new Padding(16, 4, 16, 8),
			ForeColor = Color.FromArgb(105, 119, 143)
		};

		list.Dock = DockStyle.Fill;
		list.View = View.Details;
		list.FullRowSelect = true;
		list.MultiSelect = false;
		list.HideSelection = false;
		list.BorderStyle = BorderStyle.FixedSingle;
		list.Columns.Add("插件名称", 260);
		list.Columns.Add("版本", 90);
		list.Columns.Add("状态", 110);
		list.Columns.Add("权限", 300);
		list.DoubleClick += delegate { OpenSelected(); };

		FlowLayoutPanel actions = new()
		{
			Dock = DockStyle.Bottom,
			Height = 54,
			Padding = new Padding(12, 9, 12, 8),
			FlowDirection = FlowDirection.LeftToRight,
			WrapContents = false,
			BackColor = Color.FromArgb(247, 249, 253)
		};
		actions.Controls.Add(ActionButton("安装插件包", InstallArchive));
		actions.Controls.Add(ActionButton("安装文件夹", InstallDirectory));
		actions.Controls.Add(ActionButton("启用 / 停用", ToggleSelected));
		actions.Controls.Add(ActionButton("打开插件", OpenSelected));
		actions.Controls.Add(ActionButton("打开目录", OpenDirectory));
		actions.Controls.Add(ActionButton("卸载", RemoveSelected, danger: true));

		status.Dock = DockStyle.Bottom;
		status.Height = 34;
		status.Padding = new Padding(16, 8, 16, 0);
		status.ForeColor = Color.FromArgb(76, 94, 122);
		status.Text = "插件仅保存在当前电脑，不会上传账号密码或 Cookie。";

		Panel content = new() { Dock = DockStyle.Fill, Padding = new Padding(16, 0, 16, 12) };
		content.Controls.Add(list);
		Controls.Add(content);
		Controls.Add(status);
		Controls.Add(actions);
		Controls.Add(description);
		Controls.Add(title);
		RefreshList();
		if (manager.RecoveryStatus.Length > 0) status.Text = FriendlyError(manager.RecoveryStatus);
	}

	private Button ActionButton(string text, Action action, bool danger = false)
	{
		Button button = new()
		{
			Text = text,
			AutoSize = true,
			Height = 34,
			FlatStyle = FlatStyle.Flat,
			BackColor = danger ? Color.FromArgb(255, 239, 239) : Color.White,
			ForeColor = danger ? Color.FromArgb(196, 52, 52) : Color.FromArgb(76, 94, 122),
			Margin = new Padding(0, 0, 8, 0),
			Padding = new Padding(10, 0, 10, 0),
			Cursor = Cursors.Hand
		};
		button.FlatAppearance.BorderColor = danger ? Color.FromArgb(245, 190, 190) : Color.FromArgb(214, 222, 235);
		button.Click += delegate { action(); };
		return button;
	}

	private BrowserExtensionPackage? Selected()
	{
		if (list.SelectedIndices.Count != 1) return null;
		int index = list.SelectedIndices[0];
		return index >= 0 && index < packages.Count ? packages[index] : null;
	}

	private void RefreshList(string selectedId = "")
	{
		packages = manager.List();
		list.BeginUpdate();
		try
		{
			list.Items.Clear();
			for (int index = 0; index < packages.Count; index += 1)
			{
				BrowserExtensionPackage package = packages[index];
				loadedAtStartup.TryGetValue(package.Id, out BrowserExtensionPackage? loaded);
				string state = package.RuntimeState(loaded);
				string permissions = package.Permissions.Count == 0
					? "未声明额外权限"
					: string.Join("、", package.Permissions.Take(5)) + (package.Permissions.Count > 5 ? "…" : string.Empty);
				ListViewItem row = new(package.Name);
				row.SubItems.Add(package.Version);
				row.SubItems.Add(state);
				row.SubItems.Add(permissions);
				row.Tag = package.Id;
				row.ToolTipText = package.CanLoad ? string.Empty : FriendlyError(package.CompatibilityCode);
				list.ShowItemToolTips = true;
				list.Items.Add(row);
				if (string.Equals(package.Id, selectedId, StringComparison.OrdinalIgnoreCase)) row.Selected = true;
			}
		}
		finally
		{
			list.EndUpdate();
		}
	}

	private void InstallArchive()
	{
		using OpenFileDialog dialog = new()
		{
			Title = "选择浏览器插件包",
			Filter = "浏览器插件包 (*.zip;*.crx)|*.zip;*.crx|ZIP 文件 (*.zip)|*.zip|CRX 文件 (*.crx)|*.crx",
			CheckFileExists = true,
			Multiselect = false
		};
		if (dialog.ShowDialog(this) != DialogResult.OK) return;
		RunInstall(() => manager.InstallArchive(dialog.FileName));
	}

	private void InstallDirectory()
	{
		using FolderBrowserDialog dialog = new()
		{
			Description = "选择包含 manifest.json 的浏览器插件文件夹",
			UseDescriptionForTitle = true,
			ShowNewFolderButton = false
		};
		if (dialog.ShowDialog(this) != DialogResult.OK) return;
		RunInstall(() => manager.InstallDirectory(dialog.SelectedPath));
	}

	private void RunInstall(Func<BrowserExtensionPackage> operation)
	{
		try
		{
			UseWaitCursor = true;
			BrowserExtensionPackage installed = operation();
			RefreshList(installed.Id);
			status.Text = WithMaintenanceStatus($"{installed.Name} 的文件已安装；请先保存操作，完全退出客户端再打开后生效。");
		}
		catch (Exception error)
		{
			RefreshList();
			status.Text = FriendlyError(ErrorCode.From(error));
			MessageBox.Show(this, FriendlyError(ErrorCode.From(error)), "插件安装失败", MessageBoxButtons.OK, MessageBoxIcon.Exclamation);
		}
		finally
		{
			UseWaitCursor = false;
		}
	}

	private void ToggleSelected()
	{
		BrowserExtensionPackage? selected = Selected();
		if (selected == null) return;
		try
		{
			BrowserExtensionPackage next = manager.SetEnabled(selected.Id, !selected.Enabled);
			RefreshList(next.Id);
			status.Text = WithMaintenanceStatus($"{next.Name} 的{(next.Enabled ? "启用" : "停用")}设置已保存；请完全退出客户端再打开后生效。");
		}
		catch (Exception error)
		{
			RefreshList(selected.Id);
			status.Text = FriendlyError(ErrorCode.From(error));
			MessageBox.Show(this, FriendlyError(ErrorCode.From(error)), "插件设置失败", MessageBoxButtons.OK, MessageBoxIcon.Exclamation);
		}
	}

	private void RemoveSelected()
	{
		BrowserExtensionPackage? selected = Selected();
		if (selected == null) return;
		DialogResult answer = MessageBox.Show(
			this,
			$"确定卸载“{selected.Name}”的程序文件吗？\n插件内部存储不会一并清除；旧代码需完全退出客户端后才停止。",
			"卸载浏览器插件",
			MessageBoxButtons.YesNo,
			MessageBoxIcon.Warning);
		if (answer != DialogResult.Yes) return;
		try
		{
			manager.Remove(selected.Id);
			RefreshList();
			status.Text = WithMaintenanceStatus("插件登记已卸载；请完全退出客户端再打开，以停止旧会话。插件内部存储仍保留。");
		}
		catch (Exception error)
		{
			RefreshList(selected.Id);
			status.Text = FriendlyError(ErrorCode.From(error));
			MessageBox.Show(this, FriendlyError(ErrorCode.From(error)), "插件卸载失败", MessageBoxButtons.OK, MessageBoxIcon.Exclamation);
		}
	}

	private void OpenSelected()
	{
		BrowserExtensionPackage? selected = Selected();
		if (selected == null) return;
		if (!selected.CanLoad)
		{
			status.Text = FriendlyError(selected.CompatibilityCode);
			return;
		}
		if (!selected.Enabled)
		{
			MessageBox.Show(this, "该插件当前已停用。", "浏览器插件", MessageBoxButtons.OK, MessageBoxIcon.Information);
			return;
		}
		loadedAtStartup.TryGetValue(selected.Id, out BrowserExtensionPackage? loaded);
		if (selected.RuntimeState(loaded) != "已启用")
		{
			MessageBox.Show(this, "该插件的更改需要完全退出客户端再打开后生效。请先保存当前操作。", "浏览器插件", MessageBoxButtons.OK, MessageBoxIcon.Information);
			return;
		}
		if (string.IsNullOrWhiteSpace(selected.UiUrl))
		{
			MessageBox.Show(this, "该插件没有独立操作页面，功能会直接在匹配的网站中运行。", "浏览器插件", MessageBoxButtons.OK, MessageBoxIcon.Information);
			return;
		}
		openExtension(selected);
		Close();
	}

	private void OpenDirectory()
	{
		BrowserExtensionPackage? selected = Selected();
		if (selected == null) return;
		try { manager.OpenInstallDirectory(selected); }
		catch (Exception error)
		{
			MessageBox.Show(this, FriendlyError(ErrorCode.From(error)), "无法打开插件目录", MessageBoxButtons.OK, MessageBoxIcon.Exclamation);
		}
	}

	private string WithMaintenanceStatus(string message) => manager.RecoveryStatus.Length == 0
		? message : message + " " + FriendlyError(manager.RecoveryStatus);

	private static string FriendlyError(string code)
	{
		return code switch
		{
			"PURCHASE_BROWSER_PLUGIN_MANIFEST_MISSING" => "插件包里没有找到 manifest.json。",
			"PURCHASE_BROWSER_PLUGIN_MANIFEST_INVALID" => "插件的 manifest.json 格式不正确或版本不受支持。",
			"PURCHASE_BROWSER_PLUGIN_ARCHIVE_INVALID" => "插件包损坏、格式不支持或文件过大。",
			"PURCHASE_BROWSER_PLUGIN_DIRECTORY_INVALID" => "插件文件夹无效，或包含不允许的链接文件。",
			"PURCHASE_BROWSER_PLUGIN_NOT_FOUND" => "插件文件已经不存在，请重新安装。",
			"PURCHASE_BROWSER_PLUGIN_FILES_BUSY" => "插件文件被占用，请保存操作并完全退出客户端，重开后再卸载。",
			"PURCHASE_BROWSER_PLUGIN_MV2_UNSUPPORTED" => "此插件使用 Manifest V2，当前内置浏览器不支持。原文件已保留；请向插件作者获取 Manifest V3 版本。",
			"PURCHASE_BROWSER_PLUGIN_PACKAGE_UNAVAILABLE" => "此插件文件缺失或清单无法读取，已保留记录并停止加载，其他正常插件不受影响。",
			"PURCHASE_BROWSER_PLUGIN_REGISTRY_INVALID" => "插件登记文件无法读取，原文件未被替换。请先检查或恢复插件登记文件。",
			"PURCHASE_BROWSER_PLUGIN_PERSISTENCE_FAILED" => "插件更改未保存，已恢复原状态和程序文件。请检查文件占用或磁盘空间后重试。",
			"PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED" => "插件事务恢复尚未完成，恢复资料和旧文件已保留。请解除文件占用并重启客户端；未恢复前不能继续更改。",
			"PURCHASE_BROWSER_PLUGIN_CLEANUP_PENDING" => "插件状态已确认，旧事务临时文件暂未清理；文件已保留，不影响已确认状态。",
			_ => code
		};
	}
}
