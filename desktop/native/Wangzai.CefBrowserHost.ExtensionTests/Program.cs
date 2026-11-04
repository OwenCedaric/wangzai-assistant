using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Wangzai.CefBrowserHost;

string root = Path.Combine(Path.GetTempPath(), "wangzai-extension-transaction-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
List<object> results = new(); int failures = 0;
void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
void Check(string name, Action<string> action)
{
    string fixture = Path.Combine(root, name); Directory.CreateDirectory(fixture);
    try { action(fixture); results.Add(new { name, passed = true }); }
    catch (Exception error) { failures++; results.Add(new { name, passed = false, error = error.ToString() }); }
}
string Source(string fixture, string name, string version, int manifestVersion = 3, string? key = null)
{
    string source = Path.Combine(fixture, "source-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(source);
    JsonObject manifest = new() { ["name"] = name, ["version"] = version, ["manifest_version"] = manifestVersion,
        ["action"] = new JsonObject { ["default_popup"] = "popup.html" } };
    if (key != null) manifest["key"] = key;
    File.WriteAllText(Path.Combine(source, "manifest.json"), manifest.ToJsonString());
    File.WriteAllText(Path.Combine(source, "popup.html"), "<!doctype html><title>synthetic fixture</title>");
    File.WriteAllText(Path.Combine(source, "version.txt"), version);
    return source;
}
Exception Failed(Action action)
{
    try { action(); } catch (Exception error) { return error; }
    throw new Exception("expected failure was not exercised");
}
string Registry(string fixture) => Path.Combine(fixture, "extensions");

Check("mv3-install-upgrade-and-restart", f => {
    var manager = new BrowserExtensionPackageManager(Registry(f));
    var first = manager.InstallDirectory(Source(f, "normal MV3", "1.0.0"));
    var next = manager.InstallDirectory(Source(f, "normal MV3", "2.0.0"));
    Require(next.Id == first.Id && next.CanLoad && manager.List().Count == 1, "stable identity/compatibility changed");
    var restarted = new BrowserExtensionPackageManager(Registry(f));
    Require(restarted.List().Single().Version == "2.0.0" && restarted.EnabledDirectories().Length == 1, "upgrade not persistent");
});
Check("enable-disable-remove-restart", f => {
    var manager = new BrowserExtensionPackageManager(Registry(f));
    var item = manager.InstallDirectory(Source(f, "toggle fixture", "1.0.0"));
    manager.SetEnabled(item.Id, false);
    var second = new BrowserExtensionPackageManager(Registry(f));
    Require(!second.List().Single().Enabled && second.EnabledDirectories().Length == 0, "disable was not persisted");
    second.SetEnabled(item.Id, true);
    Require(new BrowserExtensionPackageManager(Registry(f)).List().Single().Enabled, "enable was not persisted");
    Require(second.Remove(item.Id) && !Directory.Exists(item.InstallDirectory), "uninstall active files remain");
    Require(new BrowserExtensionPackageManager(Registry(f)).List().Count == 0, "uninstall was not persisted");
});
foreach (string operation in new[] { "toggle", "upgrade", "remove", "new-install" })
Check("registry-lock-" + operation, f => {
    string registryRoot = Registry(f);
    var manager = new BrowserExtensionPackageManager(registryRoot);
    var original = manager.InstallDirectory(Source(f, "locked fixture", "1.0.0"));
    string before = File.ReadAllText(Path.Combine(registryRoot, "registry.json"));
    using (FileStream registryLock = File.Open(Path.Combine(registryRoot, "registry.json"), FileMode.Open, FileAccess.Read, FileShare.Read))
    {
        Failed(() => {
            if (operation == "toggle") manager.SetEnabled(original.Id, false);
            if (operation == "upgrade") manager.InstallDirectory(Source(f, "locked fixture", "2.0.0"));
            if (operation == "remove") manager.Remove(original.Id);
            if (operation == "new-install") manager.InstallDirectory(Source(f, "another fixture", "1.0.0"));
        });
        Require(manager.List().Count == 1 && manager.List()[0].Version == "1.0.0" && manager.List()[0].Enabled, "failure published unpersisted memory");
        Require(File.ReadAllText(Path.Combine(original.InstallDirectory, "version.txt")) == "1.0.0", "failure lost old files");
        Require(File.ReadAllText(Path.Combine(registryRoot, "registry.json")) == before, "failure changed old registry");
    }
    Require(new BrowserExtensionPackageManager(registryRoot).List().Single().Version == "1.0.0", "restart differs after failed mutation");
});
Check("rollback-failure-is-retained-and-recovered-on-restart", f => {
    string registryRoot = Registry(f);
    var manager = new BrowserExtensionPackageManager(registryRoot);
    var item = manager.InstallDirectory(Source(f, "recover fixture", "1.0.0"));
    string legacy = Path.Combine(registryRoot, ".staging", "previous-unrelated-evidence");
    Directory.CreateDirectory(legacy); File.WriteAllText(Path.Combine(legacy, "keep.txt"), "preserve old evidence");
    var failing = new BrowserExtensionPackageManager(registryRoot, step => {
        if (step is "files-swapped" or "before-rollback") throw new IOException("synthetic failure");
    });
    Exception error = Failed(() => failing.InstallDirectory(Source(f, "recover fixture", "2.0.0")));
    Require(error.Message.Contains("RECOVERY_REQUIRED") && failing.EnabledDirectories().Length == 0, "unverified recovery was hidden or allowed to load");
    Require(Directory.GetDirectories(Path.Combine(registryRoot, ".transactions")).Length == 1, "recovery journal disappeared");
    var restarted = new BrowserExtensionPackageManager(registryRoot);
    Require(restarted.List().Single().Version == "1.0.0" && File.ReadAllText(Path.Combine(item.InstallDirectory, "version.txt")) == "1.0.0", "restart did not recover old files");
    Require(restarted.RecoveryStatus.Length == 0 && restarted.EnabledDirectories().Length == 1, "successful recovery did not clear the fence");
    Require(File.ReadAllText(Path.Combine(legacy, "keep.txt")) == "preserve old evidence", "legacy staging evidence was swept");
});
Check("uninstall-rollback-failure-recovers-old-directory", f => {
    string registryRoot = Registry(f);
    var manager = new BrowserExtensionPackageManager(registryRoot);
    var item = manager.InstallDirectory(Source(f, "remove recovery", "1.0.0"));
    var failing = new BrowserExtensionPackageManager(registryRoot, step => {
        if (step is "files-swapped" or "before-rollback") throw new IOException("synthetic failure");
    });
    Require(Failed(() => failing.Remove(item.Id)).Message.Contains("RECOVERY_REQUIRED"), "remove rollback failure not exposed");
    var restarted = new BrowserExtensionPackageManager(registryRoot);
    Require(restarted.List().Single().Id == item.Id && Directory.Exists(item.InstallDirectory), "uninstall recovery lost installed package");
});
Check("corrupt-recovery-snapshot-is-not-swept-and-does-not-hide-healthy-plugin", f => {
    string registryRoot = Registry(f);
    var manager = new BrowserExtensionPackageManager(registryRoot);
    var bad = manager.InstallDirectory(Source(f, "pending fixture", "1.0.0"));
    var healthy = manager.InstallDirectory(Source(f, "healthy fixture", "1.0.0"));
    var failing = new BrowserExtensionPackageManager(registryRoot, step => {
        if (step is "files-swapped" or "before-rollback") throw new IOException("synthetic failure");
    });
    Failed(() => failing.InstallDirectory(Source(f, "pending fixture", "2.0.0")));
    string transaction = Directory.GetDirectories(Path.Combine(registryRoot, ".transactions")).Single();
    File.WriteAllText(Path.Combine(transaction, "registry.previous.json"), "corrupted synthetic snapshot");
    var restarted = new BrowserExtensionPackageManager(registryRoot);
    Require(restarted.RecoveryStatus.Contains("RECOVERY_REQUIRED") && Directory.Exists(transaction), "corrupt recovery was swallowed");
    Require(restarted.List().Count == 2 && restarted.EnabledDirectories().SequenceEqual(new[] { healthy.InstallDirectory }), "healthy plugin disappeared or pending plugin loaded");
    Require(Directory.Exists(Path.Combine(transaction, "previous")), "rollback backup was deleted");
});
Check("failure-after-registry-write-restores-both-files-and-registry", f => {
    string registryRoot = Registry(f);
    var manager = new BrowserExtensionPackageManager(registryRoot);
    var item = manager.InstallDirectory(Source(f, "readback fixture", "1.0.0"));
    string before = File.ReadAllText(Path.Combine(registryRoot, "registry.json"));
    var failing = new BrowserExtensionPackageManager(registryRoot, step => { if (step == "registry-written") throw new IOException("synthetic readback failure"); });
    Failed(() => failing.InstallDirectory(Source(f, "readback fixture", "2.0.0")));
    Require(File.ReadAllText(Path.Combine(registryRoot, "registry.json")) == before && File.ReadAllText(Path.Combine(item.InstallDirectory, "version.txt")) == "1.0.0", "partial commit escaped rollback");
});
Check("new-mv2-rejected-without-rewriting-source-or-registry", f => {
    var manager = new BrowserExtensionPackageManager(Registry(f));
    string source = Source(f, "MV2 fixture", "1.0.0", 2);
    string before = File.ReadAllText(Path.Combine(source, "manifest.json"));
    Require(Failed(() => manager.InstallDirectory(source)).Message.Contains("MV2_UNSUPPORTED"), "MV2 was not rejected before loading");
    Require(File.ReadAllText(Path.Combine(source, "manifest.json")) == before && manager.List().Count == 0, "MV2 was rewritten or published");
    Require(!File.Exists(Path.Combine(Registry(f), "registry.json")), "rejected package created a registry entry");
});
Check("existing-incompatible-and-malformed-packages-preserve-normal-registry", f => {
    string registryRoot = Registry(f);
    var manager = new BrowserExtensionPackageManager(registryRoot);
    var legacy = manager.InstallDirectory(Source(f, "legacy installed", "1.0.0"));
    var broken = manager.InstallDirectory(Source(f, "broken installed", "1.0.0"));
    var healthy = manager.InstallDirectory(Source(f, "normal installed", "1.0.0"));
    string manifestPath = Path.Combine(legacy.InstallDirectory, "manifest.json");
    JsonObject manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsObject(); manifest["manifest_version"] = 2;
    File.WriteAllText(manifestPath, manifest.ToJsonString());
    File.WriteAllText(Path.Combine(broken.InstallDirectory, "manifest.json"), "{ malformed fixture");
    string registryBefore = File.ReadAllText(Path.Combine(registryRoot, "registry.json"));
    var restarted = new BrowserExtensionPackageManager(registryRoot);
    Require(restarted.List().Count == 3 && restarted.List().Single(x => x.Id == legacy.Id).CompatibilityCode.Contains("MV2_UNSUPPORTED"), "incompatible entry disappeared");
    Require(restarted.EnabledDirectories().SequenceEqual(new[] { healthy.InstallDirectory }), "known incompatible files reached CEF load list");
    Require(File.ReadAllText(Path.Combine(registryRoot, "registry.json")) == registryBefore, "read destructively changed registry");
    Require(Failed(() => restarted.SetEnabled(legacy.Id, true)).Message.Contains("MV2_UNSUPPORTED"), "legacy MV2 enable accepted");
    restarted.SetEnabled(healthy.Id, false);
    Require(new BrowserExtensionPackageManager(registryRoot).List().Count == 3, "normal mutation dropped unrelated broken entries");
    Require(Directory.Exists(legacy.InstallDirectory) && Directory.Exists(broken.InstallDirectory), "incompatible files were removed");
});
Check("corrupt-top-level-registry-is-never-renamed-into-an-empty-success", f => {
    string registryRoot = Registry(f); Directory.CreateDirectory(registryRoot);
    File.WriteAllText(Path.Combine(registryRoot, "registry.json"), "{ broken registry fixture");
    Require(Failed(() => new BrowserExtensionPackageManager(registryRoot)).Message.Contains("REGISTRY_INVALID"), "corrupt registry became empty success");
    Require(File.ReadAllText(Path.Combine(registryRoot, "registry.json")) == "{ broken registry fixture", "corrupt registry was moved or replaced");
});
Check("independent-managers-rebase-on-persisted-state", f => {
    var first = new BrowserExtensionPackageManager(Registry(f));
    var a = first.InstallDirectory(Source(f, "one", "1.0.0"));
    var stale = new BrowserExtensionPackageManager(Registry(f));
    first.InstallDirectory(Source(f, "two", "1.0.0"));
    stale.SetEnabled(a.Id, false);
    Require(new BrowserExtensionPackageManager(Registry(f)).List().Count == 2, "stale in-memory snapshot dropped another package");
});
Check("opaque-existing-base64-key-contract-is-not-tightened-without-evidence", f => {
    var manager = new BrowserExtensionPackageManager(Registry(f));
    var item = manager.InstallDirectory(Source(f, "opaque key fixture", "1.0.0", key: "AQ=="));
    Require(JsonNode.Parse(File.ReadAllText(Path.Combine(item.InstallDirectory, "manifest.json")))!["key"]!.GetValue<string>() == "AQ==", "unconfirmed public-key constraint changed existing acceptance");
    // Never launch this synthetic key fixture in CEF; runtime support is not asserted.
});
Check("healthy-replacement-is-not-shadowed-by-a-preserved-unreadable-same-name-entry", f => {
    string registryRoot = Registry(f);
    var first = new BrowserExtensionPackageManager(registryRoot);
    var broken = first.InstallDirectory(Source(f, "same-name built-in fixture", "1.0.0"));
    File.WriteAllText(Path.Combine(broken.InstallDirectory, "manifest.json"), "{ broken old manifest");
    var restarted = new BrowserExtensionPackageManager(registryRoot);
    var repaired = restarted.InstallDirectory(Source(f, "same-name built-in fixture", "2.0.0"));
    Require(restarted.List().Count == 2 && restarted.List().First().Id == repaired.Id && restarted.List().First().CanLoad,
        "preserved broken entry hides the compatible installed package from name-based readers");
    Require(Directory.Exists(broken.InstallDirectory), "old unreadable package was removed");
});
foreach (string kind in new[] { "zip", "crx2", "crx3" })
Check("container-extraction-" + kind, f => {
    var manager = new BrowserExtensionPackageManager(Registry(f));
    string zip = Path.Combine(f, "fixture.zip"); ZipFile.CreateFromDirectory(Source(f, "container fixture", "1.0.0"), zip);
    string archive = zip;
    if (kind != "zip")
    {
        archive = Path.Combine(f, "fixture.crx");
        using var output = new BinaryWriter(File.Create(archive));
        output.Write(Encoding.ASCII.GetBytes("Cr24")); output.Write(kind == "crx2" ? 2u : 3u);
        output.Write(0u); if (kind == "crx2") output.Write(0u);
        output.Write(File.ReadAllBytes(zip));
    }
    Require(manager.InstallArchive(archive).CanLoad && manager.List().Count == 1, "existing supported container extraction failed");
});
Check("zip-traversal-cannot-reach-neighbor", f => {
    string zip = Path.Combine(f, "bad.zip");
    using (var file = File.Create(zip)) using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
    using (var writer = new StreamWriter(archive.CreateEntry("../../escape.txt").Open())) writer.Write("must not escape");
    var manager = new BrowserExtensionPackageManager(Registry(f)); Failed(() => manager.InstallArchive(zip));
    Require(!File.Exists(Path.Combine(Registry(f), "escape.txt")), "archive escaped staging");
});

Check("runtime-state-does-not-claim-updated-files-are-loaded", f => {
    var manager = new BrowserExtensionPackageManager(Registry(f));
    var loaded = manager.InstallDirectory(Source(f, "runtime status fixture", "1.0.0"));
    Require(loaded.RuntimeState(loaded) == "已启用", "unchanged loaded package should stay enabled");
    var upgraded = manager.InstallDirectory(Source(f, "runtime status fixture", "2.0.0"));
    Require(upgraded.RuntimeState(loaded) == "待重启更新", "upgrade was incorrectly reported live");
    Require((loaded with { UpdatedAt = "different-install" }).RuntimeState(loaded) == "待重启更新", "same-version content replacement requires restart");
    Require((loaded with { Enabled = false }).RuntimeState(loaded) == "待重启停用", "loaded content may still run until restart");
    Require(upgraded.RuntimeState(null) == "待重启启用", "new install is not already loaded");
});

Check("wait-pay-failure-keeps-its-actionable-code", _ => {
    Require(ErrorCode.From(new InvalidOperationException("PURCHASE_WAIT_PAY_SCAN_FAILED")) == "PURCHASE_WAIT_PAY_SCAN_FAILED", "scan failure was masked as generic CEF failure");
    Require(ErrorCode.From(new InvalidOperationException("PURCHASE_WAIT_PAY_BROWSER_NOT_READY")) == "PURCHASE_WAIT_PAY_BROWSER_NOT_READY", "readiness failure was masked");
});

Console.WriteLine(JsonSerializer.Serialize(new { tests = results.Count, passed = results.Count - failures, failed = failures, results }));
// Only this process-created, validated temporary fixture tree is removed.
string validated = Path.GetFullPath(root);
if (!validated.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)
    || !Path.GetFileName(validated).StartsWith("wangzai-extension-transaction-tests-", StringComparison.Ordinal))
    throw new InvalidOperationException("fixture cleanup target invalid");
Directory.Delete(validated, recursive: true);
Environment.ExitCode = failures == 0 ? 0 : 1;
