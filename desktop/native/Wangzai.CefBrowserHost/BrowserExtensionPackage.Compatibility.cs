using System.Text.Json.Nodes;

namespace Wangzai.CefBrowserHost;

internal sealed partial class BrowserExtensionPackageManager
{
	private static string CompatibilityCode(JsonObject manifest)
	{
		int version = Integer(manifest["manifest_version"]);
		if (version == 2) return "PURCHASE_BROWSER_PLUGIN_MV2_UNSUPPORTED";
		if (version != 3 || Text(manifest["name"], 160).Length == 0 || Text(manifest["version"], 60).Length == 0)
			return "PURCHASE_BROWSER_PLUGIN_MANIFEST_INVALID";
		return string.Empty;
	}

	private static void RequireCompatible(JsonObject manifest)
	{
		string code = CompatibilityCode(manifest);
		if (code.Length > 0) throw new InvalidOperationException(code);
	}

	private bool CanLoadDirectory(BrowserExtensionPackage package)
	{
		try
		{
			EnsureOwnedPackagePath(package.InstallDirectory, package.Id);
			if (package.InstallDirectory.Contains(',')) return false;
			JsonObject manifest = ReadManifest(Path.Combine(package.InstallDirectory, "manifest.json"));
			return CompatibilityCode(manifest).Length == 0 && ExtensionId(manifest) == package.Id;
		}
		catch { return false; }
	}

	private static void AssertPlainAncestors(string candidate)
	{
		for (string? current = Path.GetFullPath(candidate); current != null; current = Path.GetDirectoryName(current))
		{
			if (!Directory.Exists(current) && !File.Exists(current)) continue;
			FileAttributes attributes = File.GetAttributes(current);
			if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0)
				throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_PATH_INVALID");
		}
	}
}
