using System.Net;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class WorkflowProgram
{
    private static async Task<int> Main(string[] args)
    {
        string native = Path.GetFullPath(args[0]), isolated = Path.GetFullPath(args[1]);
        Directory.CreateDirectory(isolated);
        AssemblyLoadContext.Default.Resolving += (_, name) => {
            string file = Path.Combine(native, name.Name + ".dll");
            return File.Exists(file) ? AssemblyLoadContext.Default.LoadFromAssemblyPath(file) : null;
        };
        return await WorkflowTests.Run(native, isolated, Path.GetFullPath(args[2]));
    }
}

internal static class WorkflowTests
{
    private static readonly List<object> Results = new();
    private static int failed;
    public static async Task<int> Run(string native, string isolated, string exports)
    {
        var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(native, "Wangzai.CefBrowserHost.dll"));
        var runtime = assembly.GetType("Wangzai.CefBrowserHost.CrossBorderBuiltInRuntime", true)!;
        var profile = assembly.GetType("Wangzai.CefBrowserHost.BrowserProfile", true)!;
        Fixture Open(DurableMarketplace server) => new(runtime, profile, Path.Combine(isolated, Guid.NewGuid().ToString("N")), server.Owner, "workflow",
            server.Reply, server.Logistics, "cross-border");
        var accounts = new JsonArray();
        foreach (string owner in new[] { "a", "b" }) {
            var server = new DurableMarketplace(Path.Combine(isolated, "market-" + owner + ".json"), owner, 2);
            using var client = Open(server);
            await Test(owner + "-preview-does-not-write", async () => {
                var preview = await client.Execute("cross-border-sync", Batch(false));
                Check(preview["total"]?.GetValue<int>() == 2 && preview["synced"]?.GetValue<int>() == 0, "preview result changed");
                Check(server.Updates == 0 && server.Rows().All(r => r["pending"]!.GetValue<bool>()), "preview wrote data");
            });
            await Test(owner + "-commit-persist-and-reopen", async () => {
                int readsBefore = server.PendingReads;
                var committed = await client.Execute("cross-border-sync", Batch(true));
                Check(committed["ok"]?.GetValue<bool>() == true && committed["synced"]?.GetValue<int>() == 2, "normal commit failed");
                Check(server.PendingReads - readsBefore == 2, "batch should share one readback, not re-read separately for each package");
                var rows = server.Rows();
                Check(rows.Count == 2 && rows.All(r => !r["pending"]!.GetValue<bool>() && r["savedTracking"]?.ToString() == r["wantedTracking"]?.ToString()), "server did not persist exact logistics");
                using var reopened = Open(server);
                var pending = await reopened.Execute("cross-border-orders", new());
                Check(pending["orders"] is JsonArray p && p.Count == 0, "reopened runtime sees stale pending orders");
            });
            var ledger = await client.Execute("cross-border-charges", Ledger());
            Check(ledger["charges"] is JsonArray charges && charges.Count == 6, "generated ledger missing source rows");
            var exported = new JsonObject { ["owner"] = owner, ["generatedOrders"] = new JsonArray(server.Rows().Select(r => r.DeepClone()).ToArray()), ["ledger"] = ledger };
            if (owner == "a") { server.RefundFirst(); exported["refundedLedger"] = await client.Execute("cross-border-charges", Ledger()); }
            accounts.Add(exported);
        }
        await Test("single-tail-order-is-not-hidden-by-the-100-row-display-limit", async () => {
            var server = new DurableMarketplace(Path.Combine(isolated, "tail.json"), "a", 120) { AcceptWithoutSaving = true };
            using var client = Open(server);
            var result = await client.Execute("cross-border-sync", Single(server.Rows()[119]));
            Check(result["ok"]?.GetValue<bool>() == false && result["readbackVerified"]?.GetValue<bool>() == false,
                "ack-only target beyond first 100 was incorrectly confirmed");
            Check(server.Rows()[119]["pending"]!.GetValue<bool>(), "fixture unexpectedly saved target");
        });
        await Test("partial-pending-list-is-not-complete-readback", async () => {
            var server = new DurableMarketplace(Path.Combine(isolated, "partial-list.json"), "a", 120) { AcceptWithoutSaving = true, VisibleLimit = 100 };
            using var client = Open(server);
            var result = await client.Execute("cross-border-sync", Single(server.Rows()[119]));
            Check(result["readbackVerified"]?.GetValue<bool>() == false, "partial API list falsely verified disappearance");
        });
        await Test("batch-ack-without-persistence-is-not-synced", async () => {
            var server = new DurableMarketplace(Path.Combine(isolated, "ack-only.json"), "a", 2) { AcceptWithoutSaving = true };
            using var client = Open(server);
            var result = await client.Execute("cross-border-sync", Batch(true));
            Check(result["ok"]?.GetValue<bool>() == false && result["synced"]?.GetValue<int>() == 0, "batch reported success without server persistence");
        });
        await Test("saved-but-unreadable-response-remains-pending-not-retried", async () => {
            var server = new DurableMarketplace(Path.Combine(isolated, "unreadable.json"), "a", 2) { CorruptReadback = true };
            using var client = Open(server);
            var result = await client.Execute("cross-border-sync", Batch(true));
            Check(result["ok"]?.GetValue<bool>() == false && result["synced"]?.GetValue<int>() == 0, "unknown readback became success");
            Check(server.Updates == 2 && server.Rows().All(r => !r["pending"]!.GetValue<bool>()), "readback failure retried writes or lost persistence");
            Check(result["results"]!.AsArray().OfType<JsonObject>().All(r => r["writeAccepted"]?.GetValue<bool>() == true), "accepted writes lost their uncertain outcome");
        });
        await Test("partial-batch-reports-one-success-not-complete", async () => {
            var server = new DurableMarketplace(Path.Combine(isolated, "partial-batch.json"), "a", 2) { RejectSecond = true };
            using var client = Open(server);
            var result = await client.Execute("cross-border-sync", Batch(true));
            Check(result["ok"]?.GetValue<bool>() == false && result["synced"]?.GetValue<int>() == 1, "partial batch reported complete");
            Check(!server.Rows()[0]["pending"]!.GetValue<bool>() && server.Rows()[1]["pending"]!.GetValue<bool>(), "wrong package persisted");
        });
        await Test("cross-account-records-stay-in-independent-files", () => {
            var a = accounts[0]!["generatedOrders"]!.AsArray(); var b = accounts[1]!["generatedOrders"]!.AsArray();
            Check(a[0]!["orderId"]!.ToString() == b[0]!["orderId"]!.ToString(), "fixture must reuse an order identity across accounts");
            Check(a[0]!["savedTracking"]!.ToString() != b[0]!["savedTracking"]!.ToString(), "account data was mixed");
            return Task.CompletedTask;
        });
        Directory.CreateDirectory(Path.GetDirectoryName(exports)!);
        File.WriteAllText(exports, new JsonObject { ["syntheticOnly"] = true, ["accounts"] = accounts }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine(JsonSerializer.Serialize(new { passed = Results.Count - failed, failed, actualCompiledRuntime = true,
            cefInitialized = false, externalNetworkRequests = 0, generatedAccounts = 2, generatedBusinessOrders = 4,
            fixtureStorage = "owned durable JSON files; state read again for every API request", exported = exports,
            nativeDllSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(native, "Wangzai.CefBrowserHost.dll")))).ToLowerInvariant(), cases = Results }, new JsonSerializerOptions { WriteIndented = true }));
        return failed == 0 ? 0 : 1;
    }
    private static JsonObject Ledger() => new() { ["pageUrl"] = "https://www.kuajing84.com/index/finance/record_consume.html", ["pageSize"] = 20, ["maxPages"] = 3, ["includeDetails"] = false };
    private static JsonObject Batch(bool commit) => new() { ["platform"] = "1688", ["commit"] = commit };
    private static JsonObject Single(JsonObject row) => new() { ["mode"] = "package-update", ["order"] = new JsonObject { ["orderId"] = row["orderId"]!.ToString(), ["packId"] = row["packId"]!.ToString(), ["collectionNumber"] = row["collection"]!.ToString(), ["fromName"] = "1688" },
        ["logistics"] = new JsonObject { ["carrier"] = "中通快递", ["trackingNumber"] = row["wantedTracking"]!.ToString() } };
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static async Task Test(string name, Func<Task> callback) { try { await callback(); Results.Add(new { name, passed = true }); } catch (Exception ex) { failed++; Results.Add(new { name, passed = false, error = ex.GetBaseException().Message }); } }
}

internal sealed class DurableMarketplace
{
    private readonly string file;
    public string Owner { get; }
    public bool AcceptWithoutSaving, RejectSecond, CorruptReadback;
    public int VisibleLimit = int.MaxValue, Updates, PendingReads;
    public DurableMarketplace(string file, string owner, int count) {
        this.file = file; Owner = owner;
        Save(new JsonArray(Enumerable.Range(0, count).Select(i => (JsonNode)new JsonObject {
            ["orderId"] = (9000000000000L + i).ToString(), ["packId"] = "pack-" + i, ["collection"] = "COL-" + i,
            ["posting"] = "GENERATED-POSTING-" + i, ["wantedTracking"] = "ZT" + owner.ToUpperInvariant() + (9000000000L + i),
            ["price"] = owner == "a" ? 52.71 : 83.42, ["pending"] = true, ["savedTracking"] = "", ["refunded"] = false
        }).ToArray()));
    }
    public List<JsonObject> Rows() => JsonNode.Parse(File.ReadAllText(file))!.AsArray().OfType<JsonObject>().ToList();
    private void Save(JsonArray rows) {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        string temp = file + ".pending"; File.WriteAllText(temp, rows.ToJsonString()); File.Move(temp, file, true);
    }
    public void RefundFirst() { var rows = Rows(); rows[0]["refunded"] = true; Save(new JsonArray(rows.Select(r => r.DeepClone()).ToArray())); }
    public Task<string> Logistics(string url, string platform) {
        if (platform != "1688") throw new Exception("UNEXPECTED_FIXTURE_PLATFORM");
        string id = new Uri(url).Query.Split('&', '?').First(p => p.StartsWith("orderId=")).Split('=')[1];
        var row = Rows().Single(r => r["orderId"]!.ToString() == id);
        return Task.FromResult(new JsonObject { ["carrier"] = "中通快递", ["trackingNumber"] = row["wantedTracking"]!.ToString() }.ToJsonString());
    }
    public async Task<HttpResponseMessage> Reply(HttpRequestMessage request) {
        if (request.RequestUri!.Host != "www.kuajing84.com" || !request.Headers.TryGetValues("Cookie", out var cookie) || string.Join("; ", cookie) != "fixture_session=fixture-" + Owner) throw new Exception("WRONG_FIXTURE_ACCOUNT");
        var rows = Rows(); string route = request.RequestUri.AbsolutePath;
        if (route == "/index/plugin/get_login_status") return Json(new JsonObject { ["code"] = 1, ["data"] = new JsonObject { ["user_code"] = "fixture-" + Owner } });
        if (route == "/index/plugin/get_order") {
            PendingReads++;
            if (CorruptReadback && Updates > 0) return Json(new JsonObject { ["code"] = 1, ["data"] = new JsonObject { ["notice"] = "fixture readback unavailable" } });
            var pending = rows.Where(r => r["pending"]!.GetValue<bool>()).ToList();
            return Json(new JsonObject { ["code"] = 1, ["count"] = pending.Count,
                ["data"] = new JsonArray(pending.Take(VisibleLimit).Select(r => (JsonNode)new JsonObject { ["order_id"] = r["orderId"]!.ToString(), ["pack_id"] = r["packId"]!.ToString(), ["from_name"] = "1688", ["collection_number"] = r["collection"]!.ToString() }).ToArray()) });
        }
        string body = request.Content == null ? "" : await request.Content.ReadAsStringAsync();
        var form = body.Split('&', StringSplitOptions.RemoveEmptyEntries).Select(p => p.Split('=', 2)).ToDictionary(p => WebUtility.UrlDecode(p[0]), p => WebUtility.UrlDecode(p.ElementAtOrDefault(1) ?? ""));
        if (route == "/index/plugin/updatePackage") {
            Updates++;
            var row = rows.Single(r => r["orderId"]!.ToString() == form["orderId"] && r["packId"]!.ToString() == form["packId"]);
            if (RejectSecond && row["packId"]!.ToString() == "pack-1") return Json(new JsonObject { ["code"] = 0, ["msg"] = "fixture rejected package" });
            if (!AcceptWithoutSaving) { row["pending"] = false; row["savedTracking"] = form["express_number_value"]; row["savedCarrier"] = form["express_number_title"]; Save(new JsonArray(rows.Select(r => r.DeepClone()).ToArray())); }
            return Json(new JsonObject { ["code"] = 1, ["data"] = "fixture acknowledged" });
        }
        var output = new JsonArray();
        if (route == "/index/Accountorder/order_list_search/order_type/all") {
            foreach (var row in rows.Where(r => r["collection"]!.ToString() == form["order_id"])) output.Add(new JsonObject {
                ["order_id"] = row["collection"]!.ToString(), ["from_order"] = row["orderId"]!.ToString(), ["pack_id"] = row["packId"]!.ToString(),
                ["express_number_title"] = row["savedCarrier"]?.ToString(), ["express_number_value"] = row["savedTracking"]!.ToString()
            });
        } else if (route == "/index/Accountorder/order_list_submit/order_type/all") {
            foreach (var row in rows) output.Add(new JsonObject { ["id"] = row["packId"]!.ToString(), ["order_id"] = row["collection"]!.ToString(), ["order_number"] = row["posting"]!.ToString(), ["from_order"] = row["orderId"]!.ToString(), ["tracking_number"] = row["savedTracking"]!.ToString() });
        } else if (route == "/index/finance/record_consume.html") {
            foreach (var row in rows.Where(r => !r["pending"]!.GetValue<bool>())) {
                var amounts = row["refunded"]!.GetValue<bool>() ? new[] { 0.1, -0.1, 1.5, -1.5 } : new[] { 0.1, -0.1, 1.5 };
                for (int i = 0; i < amounts.Length; i++) output.Add(new JsonObject { ["id"] = $"{Owner}-{row["collection"]}-{i}", ["oid"] = row["collection"]!.ToString(), ["money"] = Math.Abs(amounts[i]), ["type"] = amounts[i] < 0 ? "收入" : "支出", ["reason"] = amounts[i] < 0 ? "发货返还" : "发货费用", ["time"] = $"2026-09-06 10:00:0{i}" });
            }
        } else throw new Exception("UNEXPECTED_FIXTURE_ROUTE:" + route);
        int page = int.Parse(form["page"]), limit = int.Parse(form["limit"]);
        return Json(new JsonObject { ["code"] = 0, ["count"] = output.Count, ["data"] = new JsonArray(output.Skip((page - 1) * limit).Take(limit).Select(r => r!.DeepClone()).ToArray()) });
    }
    private static HttpResponseMessage Json(JsonNode value) => new(HttpStatusCode.OK) { Content = new StringContent(value.ToJsonString(), Encoding.UTF8, "application/json") };
}
