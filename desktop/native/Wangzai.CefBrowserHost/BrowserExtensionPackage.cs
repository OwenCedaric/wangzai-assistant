using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Wangzai.CefBrowserHost;

internal sealed record BrowserExtensionPackage(
	string Id,
	string Name,
	string Version,
	string Description,
	bool Enabled,
	string InstallDirectory,
	string UiPath,
	int ManifestVersion,
	IReadOnlyList<string> Permissions,
	string InstalledAt,
	string UpdatedAt)
{
	public string CompatibilityCode { get; init; } = string.Empty;
	public bool CanLoad => CompatibilityCode.Length == 0;
	public string RuntimeState(BrowserExtensionPackage? loaded) => !CanLoad ? "不可加载（已保留）"
		: !Enabled ? loaded != null ? "待重启停用" : "已停用"
		: loaded == null ? "待重启启用"
		: Version != loaded.Version || UpdatedAt != loaded.UpdatedAt || InstallDirectory != loaded.InstallDirectory
			? "待重启更新" : "已启用";
	public string UiUrl => string.IsNullOrWhiteSpace(UiPath)
		? string.Empty
		: $"chrome-extension://{Id}/{UiPath.TrimStart('/')}";
}

internal sealed partial class BrowserExtensionPackageManager
{
	private const int RegistryVersion = 1;
	private const long MaximumArchiveBytes = 256L * 1024L * 1024L;
	private const int MaximumFileCount = 20_000;

	private readonly object gate = new();
	private readonly string root;
	private readonly string packagesRoot;
	private readonly string stagingRoot;
	private readonly string registryPath;
	private readonly string transactionsRoot;
	private readonly Action<string>? transactionCheckpoint;
	private readonly HashSet<string> recoveryBlockedIds = new(StringComparer.OrdinalIgnoreCase);
	private List<BrowserExtensionPackage> packages;
	public string RecoveryStatus { get; private set; } = string.Empty;

	public BrowserExtensionPackageManager(string extensionsRoot) : this(extensionsRoot, null) { }

	internal BrowserExtensionPackageManager(string extensionsRoot, Action<string>? transactionCheckpoint)
	{
		root = Path.GetFullPath(extensionsRoot);
		packagesRoot = Path.Combine(root, "packages");
		stagingRoot = Path.Combine(root, ".staging");
		registryPath = Path.Combine(root, "registry.json");
		transactionsRoot = Path.Combine(root, ".transactions");
		this.transactionCheckpoint = transactionCheckpoint;
		Directory.CreateDirectory(packagesRoot);
		Directory.CreateDirectory(stagingRoot);
		Directory.CreateDirectory(transactionsRoot);
		using (AcquireMutationLock()) RecoverTransactions();
		packages = ReadRegistry();
	}

	public string Root => root;

	public IReadOnlyList<BrowserExtensionPackage> List()
	{
		lock (gate)
		{
			return new ReadOnlyCollection<BrowserExtensionPackage>(
				packages.Select(item => recoveryBlockedIds.Contains(item.Id) || recoveryBlockedIds.Contains("*")
					? item with { CompatibilityCode = "PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED" } : item)
					.OrderBy(static item => item.Name, StringComparer.CurrentCultureIgnoreCase)
					.ThenBy(static item => item.CanLoad ? 0 : 1).ToList());
		}
	}

	public string[] EnabledDirectories()
	{
		lock (gate)
		{
			return packages
				.Where(item => item.Enabled && item.CanLoad && !recoveryBlockedIds.Contains("*") && !recoveryBlockedIds.Contains(item.Id) && CanLoadDirectory(item))
				.Select(item => item.InstallDirectory)
				.Where(static value => !value.Contains(','))
				.Distinct(StringComparer.OrdinalIgnoreCase)
				.ToArray();
		}
	}

	public bool IsEnabledExtensionId(string? extensionId)
	{
		if (string.IsNullOrWhiteSpace(extensionId)) return false;
		lock (gate)
		{
			return packages.Any(item => item.Enabled && item.CanLoad && !recoveryBlockedIds.Contains("*") && !recoveryBlockedIds.Contains(item.Id) && CanLoadDirectory(item)
				&& string.Equals(item.Id, extensionId, StringComparison.OrdinalIgnoreCase));
		}
	}

	public BrowserExtensionPackage InstallArchive(string archivePath)
	{
		string source = Path.GetFullPath(archivePath);
		FileInfo info = new(source);
		if (!info.Exists || info.Length <= 0 || info.Length > MaximumArchiveBytes)
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_ARCHIVE_INVALID");
		string extension = Path.GetExtension(source).ToLowerInvariant();
		if (extension is not ".zip" and not ".crx")
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_ARCHIVE_INVALID");

		string stage = NewStage();
		try
		{
			using Stream packageStream = OpenArchiveStream(source, extension);
			ExtractArchive(packageStream, stage);
			return InstallStaged(FindManifestRoot(stage));
		}
		finally
		{
			TryDeleteDirectory(stage);
		}
	}

	public BrowserExtensionPackage InstallDirectory(string sourceDirectory, bool forceEnabled = false)
	{
		string source = Path.GetFullPath(sourceDirectory);
		if (!Directory.Exists(source))
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_DIRECTORY_INVALID");
		string stage = NewStage();
		try
		{
			CopyDirectory(source, stage);
			return InstallStaged(FindManifestRoot(stage), forceEnabled);
		}
		finally
		{
			TryDeleteDirectory(stage);
		}
	}

	public BrowserExtensionPackage SetEnabled(string extensionId, bool enabled)
	{
		lock (gate)
		{
			using FileStream mutationLock = AcquireMutationLock();
			RequireRecoveredTransactions();
			List<BrowserExtensionPackage> currentPackages = ReadRegistry();
			int index = currentPackages.FindIndex(item => string.Equals(item.Id, extensionId, StringComparison.OrdinalIgnoreCase));
			if (index < 0) throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_NOT_FOUND");
			BrowserExtensionPackage current = currentPackages[index];
			if (enabled)
			{
				EnsureOwnedPackagePath(current.InstallDirectory, current.Id);
				RequireCompatible(ReadManifest(Path.Combine(current.InstallDirectory, "manifest.json")));
				if (!CanLoadDirectory(current)) throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_PACKAGE_UNAVAILABLE");
			}
			BrowserExtensionPackage next = current with
			{
				Enabled = enabled,
				UpdatedAt = DateTimeOffset.UtcNow.ToString("O")
			};
			List<BrowserExtensionPackage> candidate = currentPackages.ToList();
			candidate[index] = next;
			CommitMutation("settings", extensionId, candidate);
			packages = candidate;
			return next;
		}
	}

	public bool Remove(string extensionId)
	{
		lock (gate)
		{
			using FileStream mutationLock = AcquireMutationLock();
			RequireRecoveredTransactions();
			List<BrowserExtensionPackage> currentPackages = ReadRegistry();
			BrowserExtensionPackage? item = currentPackages.FirstOrDefault(candidate =>
				string.Equals(candidate.Id, extensionId, StringComparison.OrdinalIgnoreCase));
			if (item == null) return false;
			EnsureOwnedPackagePath(item.InstallDirectory, item.Id);
			List<BrowserExtensionPackage> candidate = currentPackages.Where(value => value.Id != item.Id).ToList();
			CommitMutation("remove", item.Id, candidate);
			packages = candidate;
			return true;
		}
	}

	public void OpenInstallDirectory(BrowserExtensionPackage package)
	{
		EnsureOwnedPackagePath(package.InstallDirectory, package.Id);
		if (!Directory.Exists(package.InstallDirectory))
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_NOT_FOUND");
		ProcessStartInfo start = new("explorer.exe") { UseShellExecute = true };
		start.ArgumentList.Add(package.InstallDirectory);
		Process.Start(start);
	}

	private BrowserExtensionPackage InstallStaged(string manifestRoot, bool forceEnabled = false)
	{
		JsonObject manifest = ReadManifest(Path.Combine(manifestRoot, "manifest.json"));
		RequireCompatible(manifest);
		lock (gate)
		{
			using FileStream mutationLock = AcquireMutationLock();
			RequireRecoveredTransactions();
			List<BrowserExtensionPackage> currentPackages = ReadRegistry();
			ReuseExistingManifestKey(manifest, currentPackages);
			EnsureStableManifestKey(manifest);
			string id = ExtensionId(manifest);
			string destination = Path.Combine(packagesRoot, id);
			BrowserExtensionPackage? current = currentPackages.FirstOrDefault(item =>
				string.Equals(item.Id, id, StringComparison.OrdinalIgnoreCase));
			string incoming = Path.Combine(stagingRoot, $"incoming-{id}-{Guid.NewGuid():N}");
			try
			{
				CopyDirectory(manifestRoot, incoming);
				File.WriteAllText(Path.Combine(incoming, "manifest.json"), manifest.ToJsonString(), new UTF8Encoding(false));
				BrowserExtensionPackage installed = PackageFromManifest(
					manifest,
					id,
					destination,
					forceEnabled || current?.Enabled != false,
					current?.InstalledAt ?? DateTimeOffset.UtcNow.ToString("O"));
				List<BrowserExtensionPackage> candidate = currentPackages.Where(item => item.Id != id).ToList();
				candidate.Add(installed);
				CommitMutation("install", id, candidate, incoming);
				packages = candidate;
				return installed;
			}
			finally { TryDeleteDirectory(incoming); }
		}
	}

	private void ReuseExistingManifestKey(JsonObject manifest, List<BrowserExtensionPackage> currentPackages)
	{
		if (Text(manifest["key"], 16_384).Length > 0) return;
		string name = Text(manifest["name"], 160);
		if (name.Length == 0) return;
		lock (gate)
		{
			BrowserExtensionPackage[] matches = currentPackages
				.Where(item => string.Equals(item.Name, name, StringComparison.Ordinal))
				.Take(2)
				.ToArray();
			if (matches.Length != 1) return;
			try
			{
				JsonObject existing = ReadManifest(Path.Combine(matches[0].InstallDirectory, "manifest.json"));
				string key = Text(existing["key"], 16_384);
				if (key.Length > 0) manifest["key"] = key;
			}
			catch { }
		}
	}

	private static BrowserExtensionPackage PackageFromManifest(
		JsonObject manifest,
		string id,
		string installDirectory,
		bool enabled,
		string installedAt)
	{
		string name = Text(manifest["name"], 160);
		string version = Text(manifest["version"], 60);
		int manifestVersion = Integer(manifest["manifest_version"]);
		if (name.Length == 0 || version.Length == 0 || manifestVersion is not 2 and not 3)
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_MANIFEST_INVALID");
		string uiPath = Text((manifest["action"] as JsonObject)?["default_popup"], 500);
		if (uiPath.Length == 0) uiPath = Text((manifest["browser_action"] as JsonObject)?["default_popup"], 500);
		if (uiPath.Length == 0) uiPath = Text((manifest["options_ui"] as JsonObject)?["page"], 500);
		if (uiPath.Length == 0) uiPath = Text(manifest["options_page"], 500);
		uiPath = SafeRelativePath(uiPath);
		List<string> permissions = new();
		foreach (JsonNode? value in (manifest["permissions"] as JsonArray) ?? new JsonArray())
		{
			string permission = Text(value, 160);
			if (permission.Length > 0) permissions.Add(permission);
		}
		foreach (JsonNode? value in (manifest["host_permissions"] as JsonArray) ?? new JsonArray())
		{
			string permission = Text(value, 160);
			if (permission.Length > 0) permissions.Add(permission);
		}
		string now = DateTimeOffset.UtcNow.ToString("O");
		return new BrowserExtensionPackage(
			id,
			name,
			version,
			Text(manifest["description"], 800),
			enabled,
			installDirectory,
			uiPath,
			manifestVersion,
			permissions.Distinct(StringComparer.Ordinal).Take(200).ToArray(),
			installedAt,
			now) { CompatibilityCode = CompatibilityCode(manifest) };
	}

	private List<BrowserExtensionPackage> ReadRegistry()
	{
		if (!File.Exists(registryPath)) return new List<BrowserExtensionPackage>();
		JsonObject document;
		try
		{
			document = JsonNode.Parse(File.ReadAllText(registryPath, Encoding.UTF8)) as JsonObject
				?? throw new InvalidOperationException();
			if (Integer(document["version"]) != RegistryVersion || document["plugins"] is not JsonArray)
				throw new InvalidOperationException();
		}
		catch (Exception error) when (error is JsonException or InvalidOperationException)
		{
			// A corrupt registry is not an empty registry. Preserve it verbatim.
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_REGISTRY_INVALID", error);
		}
		List<BrowserExtensionPackage> result = new();
		foreach (JsonObject value in ((JsonArray)document["plugins"]!).OfType<JsonObject>())
		{
			string id = Text(value["id"], 40);
			if (!ValidId(id) || result.Any(item => item.Id == id)) continue;
			string directory = Path.Combine(packagesRoot, id);
			BrowserExtensionPackage parsed;
			try
			{
				EnsureOwnedPackagePath(directory, id);
				JsonObject manifest = ReadManifest(Path.Combine(directory, "manifest.json"));
				if (!string.Equals(ExtensionId(manifest), id, StringComparison.Ordinal))
					throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_ID_INVALID");
				parsed = PackageFromManifest(manifest, id, directory, Boolean(value["enabled"], true), Text(value["installedAt"], 80));
			}
			catch (Exception error)
			{
				// Keep the individual package visible and its files untouched.
				parsed = new BrowserExtensionPackage(id,
					Text(value["name"], 160) is string name && name.Length > 0 ? name : $"插件 {id[..8]}",
					Text(value["packageVersion"], 60), string.Empty, Boolean(value["enabled"], true),
					directory, string.Empty, 0, Array.Empty<string>(), Text(value["installedAt"], 80), Text(value["updatedAt"], 80))
				{ CompatibilityCode = "PURCHASE_BROWSER_PLUGIN_PACKAGE_UNAVAILABLE" };
				_ = error; // Details never replace or clear the entire registry.
			}
			if (recoveryBlockedIds.Contains(id))
				parsed = parsed with { CompatibilityCode = "PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED" };
			result.Add(parsed with
			{
				InstalledAt = parsed.InstalledAt.Length > 0 ? parsed.InstalledAt : DateTimeOffset.UtcNow.ToString("O"),
				UpdatedAt = Text(value["updatedAt"], 80) is string updated && updated.Length > 0 ? updated : parsed.UpdatedAt
			});
		}
		return result;
	}

	private string NewStage()
	{
		string stage = Path.Combine(stagingRoot, $"install-{Guid.NewGuid():N}");
		Directory.CreateDirectory(stage);
		return stage;
	}

	private static Stream OpenArchiveStream(string path, string extension)
	{
		FileStream file = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
		if (extension == ".zip") return file;
		try
		{
			using BinaryReader reader = new(file, Encoding.UTF8, leaveOpen: true);
			byte[] magic = reader.ReadBytes(4);
			if (!magic.SequenceEqual("Cr24"u8.ToArray())) throw new InvalidOperationException();
			uint version = reader.ReadUInt32();
			long offset;
			if (version == 2)
			{
				uint publicKeyLength = reader.ReadUInt32();
				uint signatureLength = reader.ReadUInt32();
				offset = 16L + publicKeyLength + signatureLength;
			}
			else if (version == 3)
			{
				uint headerLength = reader.ReadUInt32();
				offset = 12L + headerLength;
			}
			else throw new InvalidOperationException();
			if (offset < 12 || offset >= file.Length) throw new InvalidOperationException();
			file.Position = offset;
			MemoryStream archive = new();
			file.CopyTo(archive);
			archive.Position = 0;
			file.Dispose();
			return archive;
		}
		catch
		{
			file.Dispose();
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_ARCHIVE_INVALID");
		}
	}

	private static void ExtractArchive(Stream archiveStream, string destinationRoot)
	{
		using ZipArchive archive = new(archiveStream, ZipArchiveMode.Read, leaveOpen: false);
		if (archive.Entries.Count == 0 || archive.Entries.Count > MaximumFileCount)
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_ARCHIVE_INVALID");
		long expanded = 0;
		string prefix = Path.GetFullPath(destinationRoot) + Path.DirectorySeparatorChar;
		foreach (ZipArchiveEntry entry in archive.Entries)
		{
			expanded += Math.Max(0, entry.Length);
			if (expanded > MaximumArchiveBytes) throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_ARCHIVE_INVALID");
			string target = Path.GetFullPath(Path.Combine(destinationRoot, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
			if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
				throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_ARCHIVE_INVALID");
			if (string.IsNullOrEmpty(entry.Name))
			{
				Directory.CreateDirectory(target);
				continue;
			}
			Directory.CreateDirectory(Path.GetDirectoryName(target)!);
			entry.ExtractToFile(target, overwrite: true);
		}
	}

	private static void CopyDirectory(string source, string destination)
	{
		string sourceRoot = Path.GetFullPath(source);
		AssertPlainAncestors(sourceRoot);
		Directory.CreateDirectory(destination);
		int count = 0;
		long total = 0;
		foreach (string directory in Directory.EnumerateDirectories(sourceRoot, "*", SearchOption.AllDirectories))
		{
			FileAttributes attributes = File.GetAttributes(directory);
			if ((attributes & FileAttributes.ReparsePoint) != 0)
				throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_DIRECTORY_INVALID");
			Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(sourceRoot, directory)));
		}
		foreach (string file in Directory.EnumerateFiles(sourceRoot, "*", SearchOption.AllDirectories))
		{
			FileInfo info = new(file);
			if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
				throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_DIRECTORY_INVALID");
			count += 1;
			total += info.Length;
			if (count > MaximumFileCount || total > MaximumArchiveBytes)
				throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_DIRECTORY_INVALID");
			string target = Path.Combine(destination, Path.GetRelativePath(sourceRoot, file));
			Directory.CreateDirectory(Path.GetDirectoryName(target)!);
			File.Copy(file, target, overwrite: true);
		}
	}

	private static string FindManifestRoot(string stage)
	{
		string direct = Path.Combine(stage, "manifest.json");
		if (File.Exists(direct)) return stage;
		string[] candidates = Directory.EnumerateFiles(stage, "manifest.json", SearchOption.AllDirectories)
			.Where(path => !path.Contains($"{Path.DirectorySeparatorChar}_metadata{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase))
			.OrderBy(path => Path.GetRelativePath(stage, path).Count(character => character == Path.DirectorySeparatorChar))
			.Take(2)
			.ToArray();
		if (candidates.Length == 0) throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_MANIFEST_MISSING");
		return Path.GetDirectoryName(candidates[0])!;
	}

	private static JsonObject ReadManifest(string path)
	{
		try
		{
			return JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8)) as JsonObject
				?? throw new InvalidOperationException();
		}
		catch
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_MANIFEST_INVALID");
		}
	}

	private static void EnsureStableManifestKey(JsonObject manifest)
	{
		string existing = Text(manifest["key"], 16_384);
		if (existing.Length > 0)
		{
			try { _ = Convert.FromBase64String(existing); return; }
			catch { throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_MANIFEST_INVALID"); }
		}
		using RSA rsa = RSA.Create(2048);
		manifest["key"] = Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo());
	}

	private static string ExtensionId(JsonObject manifest)
	{
		byte[] key;
		try { key = Convert.FromBase64String(Text(manifest["key"], 16_384)); }
		catch { throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_MANIFEST_INVALID"); }
		byte[] digest = SHA256.HashData(key);
		StringBuilder result = new(32);
		for (int index = 0; index < 16; index += 1)
		{
			result.Append((char)('a' + (digest[index] >> 4)));
			result.Append((char)('a' + (digest[index] & 0x0f)));
		}
		return result.ToString();
	}

	private static string SafeRelativePath(string value)
	{
		string normalized = value.Replace('\\', '/').TrimStart('/');
		if (normalized.Length == 0) return string.Empty;
		if (normalized.Split('/').Any(part => part is "" or "." or "..")) return string.Empty;
		return normalized;
	}

	private void EnsureOwnedPackagePath(string candidate, string id)
	{
		if (!ValidId(id)) throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_ID_INVALID");
		string expected = Path.GetFullPath(Path.Combine(packagesRoot, id));
		if (!string.Equals(Path.GetFullPath(candidate), expected, StringComparison.OrdinalIgnoreCase))
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_PATH_INVALID");
		AssertPlainAncestors(candidate);
	}

	private static void TryDeleteDirectory(string path)
	{
		try { AssertPlainAncestors(path); if (Directory.Exists(path)) Directory.Delete(path, recursive: true); }
		catch { }
	}

	private static bool ValidId(string value) => value.Length == 32 && value.All(character => character is >= 'a' and <= 'p');

	private static string Text(JsonNode? value, int maximum)
	{
		try
		{
			string text = value?.GetValue<string>()?.Trim() ?? string.Empty;
			return text[..Math.Min(text.Length, maximum)];
		}
		catch { return string.Empty; }
	}

	private static int Integer(JsonNode? value)
	{
		try { return value?.GetValue<int>() ?? 0; }
		catch { return 0; }
	}

	private static bool Boolean(JsonNode? value, bool fallback)
	{
		try { return value?.GetValue<bool>() ?? fallback; }
		catch { return fallback; }
	}
}
