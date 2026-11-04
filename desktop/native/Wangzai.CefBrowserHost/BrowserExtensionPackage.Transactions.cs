using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Wangzai.CefBrowserHost;

internal sealed partial class BrowserExtensionPackageManager
{
	private sealed record PackageTransaction(int Version, string Operation, string Id, string State,
		bool HadRegistry, bool HadFiles, string PreviousRegistryHash, string NextRegistryHash,
		string PreviousFilesHash, string NextFilesHash);

	private FileStream AcquireMutationLock()
	{
		AssertPlainAncestors(root);
		string lockPath = Path.Combine(root, ".registry-mutation.lock");
		if (File.Exists(lockPath) && (File.GetAttributes(lockPath) & FileAttributes.ReparsePoint) != 0)
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_PATH_INVALID");
		return new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
	}

	private static string BytesHash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
	private static byte[] ReadPlainBytes(string file)
	{
		if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_PATH_INVALID");
		return File.ReadAllBytes(file);
	}

	private static void WriteDurable(string file, byte[] bytes)
	{
		using FileStream stream = new(file, FileMode.CreateNew, FileAccess.Write, FileShare.None);
		stream.Write(bytes);
		stream.Flush(flushToDisk: true);
	}

	private static void AtomicWrite(string file, byte[] bytes)
	{
		AssertPlainAncestors(Path.GetDirectoryName(file)!);
		string temporary = file + $".{Guid.NewGuid():N}.tmp";
		try
		{
			WriteDurable(temporary, bytes);
			if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
				throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_PATH_INVALID");
			File.Move(temporary, file, overwrite: true);
			if (!ReadPlainBytes(file).SequenceEqual(bytes))
				throw new IOException("PURCHASE_BROWSER_PLUGIN_REGISTRY_READBACK_FAILED");
		}
		finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch { /* owned write fragment only */ } }
	}

	private byte[] RegistryBytes(List<BrowserExtensionPackage> candidate, byte[]? previous)
	{
		JsonArray existing = previous == null ? new JsonArray()
			: (JsonNode.Parse(previous) as JsonObject)?["plugins"] as JsonArray
				?? throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_REGISTRY_INVALID");
		JsonArray items = new();
		// Preserve unrecognized registry metadata; never silently erase a row
		// merely because an individual package cannot currently be parsed.
		foreach (JsonNode? value in existing)
			if (value is not JsonObject entry || !ValidId(Text(entry["id"], 40))) items.Add(value?.DeepClone());
		foreach (BrowserExtensionPackage item in candidate.OrderBy(static item => item.Id, StringComparer.Ordinal))
		{
			JsonObject row = existing.OfType<JsonObject>().FirstOrDefault(entry => Text(entry["id"], 40) == item.Id)?.DeepClone() as JsonObject ?? new();
			row["id"] = item.Id; row["enabled"] = item.Enabled;
			row["installedAt"] = item.InstalledAt; row["updatedAt"] = item.UpdatedAt;
			row["name"] = item.Name; row["packageVersion"] = item.Version;
			items.Add(row);
		}
		return Encoding.UTF8.GetBytes(new JsonObject { ["version"] = RegistryVersion, ["plugins"] = items }.ToJsonString());
	}

	private static string DirectoryHash(string directory)
	{
		if (!Directory.Exists(directory)) return string.Empty;
		AssertPlainAncestors(directory);
		List<string> entries = new();
		Stack<string> pending = new(); pending.Push(directory);
		long bytes = 0;
		while (pending.Count > 0)
		{
			foreach (string entry in Directory.EnumerateFileSystemEntries(pending.Pop()).OrderBy(static value => value, StringComparer.Ordinal))
			{
				FileAttributes attributes = File.GetAttributes(entry);
				if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_PATH_INVALID");
				if ((attributes & FileAttributes.Directory) != 0) { pending.Push(entry); continue; }
				FileInfo file = new(entry); bytes += file.Length;
				if (entries.Count >= MaximumFileCount || bytes > MaximumArchiveBytes) throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_DIRECTORY_INVALID");
				using FileStream stream = File.OpenRead(entry);
				entries.Add(Path.GetRelativePath(directory, entry).Replace('\\', '/') + "\0" + Convert.ToHexString(SHA256.HashData(stream)));
			}
		}
		entries.Sort(StringComparer.Ordinal);
		return BytesHash(Encoding.UTF8.GetBytes(string.Join('\n', entries)));
	}

	private void WriteTransaction(string directory, PackageTransaction journal) =>
		AtomicWrite(Path.Combine(directory, "journal.json"), JsonSerializer.SerializeToUtf8Bytes(journal));

	private void CommitMutation(string operation, string id, List<BrowserExtensionPackage> candidate, string? incoming = null)
	{
		string destination = Path.Combine(packagesRoot, id);
		EnsureOwnedPackagePath(destination, id);
		byte[]? previous = File.Exists(registryPath) ? ReadPlainBytes(registryPath) : null;
		byte[] next = RegistryBytes(candidate, previous);
		string directory = Path.Combine(transactionsRoot, Guid.NewGuid().ToString("N"));
		PackageTransaction journal = new(1, operation, id, "prepared", previous != null,
			operation != "settings" && Directory.Exists(destination), BytesHash(previous ?? []), BytesHash(next),
			operation == "settings" ? string.Empty : DirectoryHash(destination), incoming == null ? string.Empty : DirectoryHash(incoming));
		Directory.CreateDirectory(directory);
		bool prepared = false, committed = false;
		try
		{
			WriteDurable(Path.Combine(directory, "registry.previous.json"), previous ?? []);
			WriteDurable(Path.Combine(directory, "registry.next.json"), next);
			WriteTransaction(directory, journal); prepared = true;
			transactionCheckpoint?.Invoke("prepared");
			if (journal.HadFiles) Directory.Move(destination, Path.Combine(directory, "previous"));
			if (operation == "install") Directory.Move(incoming!, destination);
			transactionCheckpoint?.Invoke("files-swapped");
			if (operation == "install" && DirectoryHash(destination) != journal.NextFilesHash)
				throw new IOException("PURCHASE_BROWSER_PLUGIN_FILES_READBACK_FAILED");
			transactionCheckpoint?.Invoke("before-registry-commit");
			AtomicWrite(registryPath, next);
			transactionCheckpoint?.Invoke("registry-written");
			WriteTransaction(directory, journal with { State = "committed" }); committed = true;
			CleanupTransaction(directory);
		}
		catch (Exception error)
		{
			if (committed) { RecoveryStatus = "PURCHASE_BROWSER_PLUGIN_CLEANUP_PENDING"; return; }
			if (!prepared) { TryDeleteDirectory(directory); throw; }
			try
			{
				transactionCheckpoint?.Invoke("before-rollback");
				RollbackTransaction(directory, journal);
				WriteTransaction(directory, journal with { State = "rolled-back" });
			}
			catch (Exception recoveryError)
			{
				recoveryBlockedIds.Add(id); RecoveryStatus = "PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED";
				throw new InvalidOperationException(RecoveryStatus, new AggregateException(error, recoveryError));
			}
			try { CleanupTransaction(directory); }
			catch { RecoveryStatus = "PURCHASE_BROWSER_PLUGIN_CLEANUP_PENDING"; }
			throw new IOException("PURCHASE_BROWSER_PLUGIN_PERSISTENCE_FAILED", error);
		}
	}

	private void RollbackTransaction(string directory, PackageTransaction journal)
	{
		byte[] previous = ReadPlainBytes(Path.Combine(directory, "registry.previous.json"));
		byte[] next = ReadPlainBytes(Path.Combine(directory, "registry.next.json"));
		if (BytesHash(previous) != journal.PreviousRegistryHash || BytesHash(next) != journal.NextRegistryHash)
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_RECOVERY_SNAPSHOT_INVALID");
		byte[]? actual = File.Exists(registryPath) ? ReadPlainBytes(registryPath) : null;
		if (actual != null && BytesHash(actual) != journal.PreviousRegistryHash && BytesHash(actual) != journal.NextRegistryHash)
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_RECOVERY_CONFLICT");
		string destination = Path.Combine(packagesRoot, journal.Id), backup = Path.Combine(directory, "previous");
		EnsureOwnedPackagePath(destination, journal.Id);
		if (journal.Operation != "settings")
		{
			if (Directory.Exists(backup))
			{
				if (!journal.HadFiles || DirectoryHash(backup) != journal.PreviousFilesHash)
					throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_RECOVERY_FILES_INVALID");
				if (Directory.Exists(destination)) QuarantineIncoming(directory, destination, journal);
				Directory.Move(backup, destination);
			}
			else if (journal.HadFiles)
			{
				if (DirectoryHash(destination) != journal.PreviousFilesHash)
					throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_RECOVERY_FILES_MISSING");
			}
			else if (Directory.Exists(destination)) QuarantineIncoming(directory, destination, journal);
		}
		if (journal.HadRegistry)
		{
			if (actual == null || !actual.SequenceEqual(previous)) AtomicWrite(registryPath, previous);
			if (!ReadPlainBytes(registryPath).SequenceEqual(previous)) throw new IOException("PURCHASE_BROWSER_PLUGIN_RECOVERY_UNVERIFIED");
		}
		else if (File.Exists(registryPath)) File.Delete(registryPath);
	}

	private static void QuarantineIncoming(string transaction, string destination, PackageTransaction journal)
	{
		if (journal.Operation != "install" || DirectoryHash(destination) != journal.NextFilesHash)
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_RECOVERY_CONFLICT");
		Directory.Move(destination, Path.Combine(transaction, "failed-incoming-" + Guid.NewGuid().ToString("N")));
	}

	private void CleanupTransaction(string directory)
	{
		AssertTransactionPath(directory);
		// Only a verified committed/rolled-back journal authorizes disposal.
		PackageTransaction journal = ReadTransaction(directory);
		if (journal.State is not "committed" and not "rolled-back") throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED");
		AssertPlainTransactionTree(directory);
		Directory.Delete(directory, recursive: true);
	}

	private static void AssertPlainTransactionTree(string directory)
	{
		Stack<string> pending = new(); pending.Push(directory);
		int count = 0;
		while (pending.Count > 0)
		{
			foreach (string entry in Directory.EnumerateFileSystemEntries(pending.Pop()))
			{
				if (++count > MaximumFileCount * 3 + 20 || (File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0)
					throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED");
				if (Directory.Exists(entry)) pending.Push(entry);
			}
		}
	}

	private void AssertTransactionPath(string directory)
	{
		if (Path.GetDirectoryName(Path.GetFullPath(directory)) != transactionsRoot || !Guid.TryParseExact(Path.GetFileName(directory), "N", out _))
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_PATH_INVALID");
		AssertPlainAncestors(directory);
	}

	private PackageTransaction ReadTransaction(string directory)
	{
		AssertTransactionPath(directory);
		PackageTransaction journal = JsonSerializer.Deserialize<PackageTransaction>(ReadPlainBytes(Path.Combine(directory, "journal.json")))
			?? throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED");
		if (journal.Version != 1 || !ValidId(journal.Id) || journal.Operation is not "install" and not "remove" and not "settings"
			|| journal.State is not "prepared" and not "committed" and not "rolled-back")
			throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED");
		return journal;
	}

	private void RecoverTransactions()
	{
		recoveryBlockedIds.Clear(); RecoveryStatus = string.Empty;
		foreach (string directory in Directory.EnumerateDirectories(transactionsRoot))
		{
			PackageTransaction? journal = null;
			try
			{
				journal = ReadTransaction(directory);
				if (journal.State == "prepared")
				{
					RollbackTransaction(directory, journal);
					journal = journal with { State = "rolled-back" };
					WriteTransaction(directory, journal);
				}
				CleanupTransaction(directory);
			}
			catch
			{
				if (journal?.State is "committed" or "rolled-back")
				{
					if (RecoveryStatus.Length == 0) RecoveryStatus = "PURCHASE_BROWSER_PLUGIN_CLEANUP_PENDING";
				}
				else
				{
					recoveryBlockedIds.Add(journal?.Id ?? "*"); RecoveryStatus = "PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED";
				}
			}
		}
	}

	private void RequireRecoveredTransactions()
	{
		RecoverTransactions();
		if (recoveryBlockedIds.Count > 0) throw new InvalidOperationException("PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED");
	}
}
