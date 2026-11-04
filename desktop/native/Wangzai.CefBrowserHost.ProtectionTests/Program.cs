using System.Net;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class ProtectionProgram
{
    private static async Task<int> Main(string[] args)
    {
        string native = Path.GetFullPath(args[0]), isolated = Path.GetFullPath(args[1]); Directory.CreateDirectory(isolated);
        AssemblyLoadContext.Default.Resolving += (_, n) => File.Exists(Path.Combine(native, n.Name + ".dll")) ? AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(native, n.Name + ".dll")) : null;
        return await ProtectionCases.Run(native, isolated);
    }
}
internal static class ProtectionCases
{
    private static readonly List<object> Results = new(); private static int failed;
    private static Type Runtime = null!, Profile = null!; private static string Root = "";
    public static async Task<int> Run(string native, string isolated)
    {
        Root = isolated; var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(native, "Wangzai.CefBrowserHost.dll"));
        Runtime = assembly.GetType("Wangzai.CefBrowserHost.CrossBorderBuiltInRuntime", true)!; Profile = assembly.GetType("Wangzai.CefBrowserHost.BrowserProfile", true)!;
        foreach (bool lengthKnown in new[] { true, false }) await Test("oversized-bus-response-" + lengthKnown, async () => {
            var stream = new ProbeStream(8L * 1024 * 1024 + 500000);
            using var f = New((_, _) => Task.FromResult(Response(stream, lengthKnown)));
            await Reject(() => f.Execute("cross-border-orders", new()), "CROSS_BORDER_RESPONSE_TOO_LARGE");
            Check(stream.ReadBytes <= (lengthKnown ? 0 : 8L * 1024 * 1024 + 1), "response was buffered beyond the byte budget");
            Check(stream.Closed, "response stream leaked");
        });
        await Test("http-timeout-keeps-its-real-reason", async () => {
            using var f = New(async (_, token) => { await Task.Delay(Timeout.Infinite, token); return Json(new()); }, timeout: 80);
            await Reject(() => f.Execute("cross-border-charges", Ledger()), "CROSS_BORDER_REQUEST_TIMEOUT");
        });
        await Test("server-failure-is-not-reported-as-logged-out", async () => {
            using var f = New((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new StringContent("failed") }));
            await Reject(() => f.Execute("cross-border-charges", Ledger()), "CROSS_BORDER_API_FAILED");
        });
        await Test("auth-failure-still-requires-login", async () => {
            using var f = New((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("expired") }));
            await Reject(() => f.Execute("cross-border-charges", Ledger()), "CROSS_BORDER_LOGIN_REQUIRED");
        });
        await Test("cancellation-before-dispatch-does-not-start-network", async () => {
            int requests = 0;
            using var f = New((_, _) => { requests++; return Task.FromResult(Login()); });
            await f.Execute("cross-border-cancel", new() { ["operationId"] = "fixture-before-dispatch" });
            await Reject(() => f.Execute("cross-border-orders", new() { ["operationId"] = "fixture-before-dispatch" }), "CROSS_BORDER_OPERATION_CANCELLED");
            Check(requests == 0, "pre-cancelled operation still reached the network");
        });
        await Test("cancel-after-headers-stops-body-and-releases-command", async () => {
            var stream = new ProbeStream(1, hanging: true); using var f = New((_, _) => Task.FromResult(Response(stream, false)));
            Task<JsonObject> pending = f.Execute("cross-border-orders", new() { ["operationId"] = "fixture-cancel-a" });
            await stream.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
            try {
                var cancel = await f.Execute("cross-border-cancel", new() { ["operationId"] = "fixture-cancel-a" });
                Check(cancel["cancelled"]?.GetValue<bool>() == true, "cancel was not acknowledged");
                await Reject(() => pending.WaitAsync(TimeSpan.FromSeconds(1)), "CROSS_BORDER_OPERATION_CANCELLED");
                Check(stream.Closed, "cancel did not close response body");
            } finally { stream.Release.TrySetResult(); try { await pending; } catch { } }
        });
        await Test("disposing-account-stops-a-hanging-response-body", async () => {
            var stream = new ProbeStream(1, hanging: true); var f = New((_, _) => Task.FromResult(Response(stream, false)));
            Task<JsonObject> pending = f.Execute("cross-border-orders", new()); await stream.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
            try { f.Dispose(); await Reject(() => pending.WaitAsync(TimeSpan.FromSeconds(1)), "CROSS_BORDER_OPERATION_CANCELLED"); }
            finally { stream.Release.TrySetResult(); try { await pending; } catch { } }
        });
        await Test("cancelling-one-account-does-not-cancel-another", async () => {
            var stream = new ProbeStream(1, hanging: true);
            using var a = New((_, _) => Task.FromResult(Response(stream, false)));
            using var b = New(async (_, token) => { await Task.Delay(80, token); return Json(new() { ["code"] = 1, ["data"] = new JsonArray() }); }, owner: "b");
            var readA = a.Execute("cross-border-orders", new() { ["operationId"] = "same-id" });
            var readB = b.Execute("cross-border-orders", new() { ["operationId"] = "same-id" });
            await stream.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
            try { await a.Execute("cross-border-cancel", new() { ["operationId"] = "same-id" }); await Reject(() => readA, "CROSS_BORDER_OPERATION_CANCELLED"); Check((await readB)["ok"]?.GetValue<bool>() == true, "another account was cancelled"); }
            finally { stream.Release.TrySetResult(); }
        });
        foreach (bool failOne in new[] { false, true }) await Test("details-beyond-100-with-coverage-" + failOne, async () => {
            int active = 0, peak = 0, calls = 0;
            using var f = New(async (request, token) => {
                string route = request.RequestUri!.AbsolutePath;
                if (route.EndsWith("get_login_status")) return Login();
                if (route == "/index/finance/record_consume.html") return Table(new(), 0);
                if (route == "/index/Accountorder/order_list_submit/order_type/all") {
                    var form = await Form(request); int p = int.Parse(form["page"]), size = int.Parse(form["limit"]);
                    return Table(new JsonArray(Enumerable.Range((p - 1) * size, Math.Max(0, Math.Min(size, 205 - (p - 1) * size))).Select(i => (JsonNode)new JsonObject { ["id"] = "id-" + i, ["order_id"] = "COL-" + i }).ToArray()), 205);
                }
                if (route.StartsWith("/index/Accountordersubmit/order_price/oid/")) {
                    Interlocked.Increment(ref calls); int a = Interlocked.Increment(ref active);
                    int before; do { before = peak; if (before >= a) break; } while (Interlocked.CompareExchange(ref peak, a, before) != before);
                    try { await Task.Delay(2, token); if (failOne && route.EndsWith("id-150")) return new(HttpStatusCode.InternalServerError) { Content = new StringContent("fixture failed") }; return Json(new JsonObject { ["code"] = 0, ["data"] = new JsonObject { ["total"] = 1.5 } }); }
                    finally { Interlocked.Decrement(ref active); }
                }
                throw new Exception("UNEXPECTED_ROUTE:" + route);
            });
            var input = Ledger(); input["includeDetails"] = true; var r = await f.Execute("cross-border-charges", input);
            Check(calls == 205, $"detail calls={calls}, coverage={r["detailCoverage"]}"); Check(peak <= 4, "detail concurrency exceeded four");
            var coverage = r["detailCoverage"]!.AsObject();
            Check(coverage["total"]?.GetValue<int>() == 205 && coverage["failed"]?.GetValue<int>() == (failOne ? 1 : 0), "detail completeness not reported");
            Check(coverage["complete"]?.GetValue<bool>() == !failOne, "failed detail reported complete");
            Check(r["orders"]!.AsArray()[150]!["detailReadStatus"]!.ToString() == (failOne ? "failed" : "complete"), "per-order detail status missing");
        });
        foreach (string mode in new[] { "exact", "wrong-tracking", "wrong-carrier", "missing-fields", "wrong-package" }) await Test("package-field-readback-" + mode, async () => {
            using var f = New(async (request, _) => {
                string route = request.RequestUri!.AbsolutePath;
                if (route.EndsWith("get_login_status")) return Login();
                if (route.EndsWith("updatePackage")) return Json(new() { ["code"] = 1 });
                if (route.EndsWith("get_order")) return Json(new() { ["code"] = 1, ["count"] = 0, ["data"] = new JsonArray() });
                if (route == "/index/Accountorder/order_list_search/order_type/all") {
                    var form = await Form(request); Check(form["order_id"] == "COL-1", "readback queried an unrelated collection");
                    var row = new JsonObject { ["order_id"] = "COL-1", ["from_order"] = "9000000000001", ["pack_id"] = mode == "wrong-package" ? "PACK-OTHER" : "PACK-1" };
                    if (mode != "missing-fields") { row["express_number_value"] = mode == "wrong-tracking" ? "ZT9999999999" : "ZT1234567890"; row["express_number_title"] = mode == "wrong-carrier" ? "申通快递" : "中通快递"; }
                    return Table(new JsonArray(row), 1);
                }
                throw new Exception("UNEXPECTED_ROUTE:" + route);
            }, platform: "cross-border");
            var result = await f.Execute("cross-border-sync", new() { ["mode"] = "package-update",
                ["order"] = new JsonObject { ["orderId"] = "9000000000001", ["packId"] = "PACK-1", ["collectionNumber"] = "COL-1", ["fromName"] = "1688" },
                ["logistics"] = new JsonObject { ["carrier"] = "中通快递", ["trackingNumber"] = "ZT1234567890" } });
            Check(result["readbackVerified"]?.GetValue<bool>() == (mode == "exact"), "queue disappearance was accepted without exact field equality");
            Check(result["writeAccepted"]?.GetValue<bool>() == true, "accepted write was hidden");
        });
        Console.WriteLine(JsonSerializer.Serialize(new { passed = Results.Count - failed, failed, actualCompiledRuntime = true, cefInitialized = false, externalNetworkRequests = 0,
            nativeDllSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(native, "Wangzai.CefBrowserHost.dll")))).ToLowerInvariant(), cases = Results }, new JsonSerializerOptions { WriteIndented = true }));
        return failed == 0 ? 0 : 1;
    }
    private static Fixture New(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> reply, int timeout = 5000, string platform = "taobao", string owner = "a") => new(Runtime, Profile, Path.Combine(Root, Guid.NewGuid().ToString("N")), owner, "protection", platformKey: platform, cancellableTransport: reply, timeoutMs: timeout);
    private static HttpResponseMessage Json(JsonObject value) => new(HttpStatusCode.OK) { Content = new StringContent(value.ToJsonString(), Encoding.UTF8, "application/json") };
    private static HttpResponseMessage Login() => Json(new() { ["code"] = 1, ["data"] = new JsonObject { ["user_code"] = "fixture-a" } });
    private static HttpResponseMessage Table(JsonArray rows, int count) => Json(new() { ["code"] = 0, ["count"] = count, ["data"] = rows });
    private static HttpResponseMessage Response(ProbeStream stream, bool declared) { var content = new StreamContent(stream); if (declared) content.Headers.ContentLength = stream.Total; return new(HttpStatusCode.OK) { Content = content }; }
    private static async Task<Dictionary<string, string>> Form(HttpRequestMessage request) => (await request.Content!.ReadAsStringAsync()).Split('&').Select(p => p.Split('=', 2)).ToDictionary(p => WebUtility.UrlDecode(p[0]), p => WebUtility.UrlDecode(p.ElementAtOrDefault(1) ?? ""));
    private static JsonObject Ledger() => new() { ["pageUrl"] = "https://www.kuajing84.com/index/finance/record_consume.html", ["pageSize"] = 100, ["maxPages"] = 5, ["includeDetails"] = false };
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static async Task Reject(Func<Task<JsonObject>> task, string code) { try { await task(); } catch (Exception e) { Exception actual = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e; Check(actual.Message == code, "wrong failure: " + actual.Message); return; } throw new Exception("expected " + code + " but got success"); }
    private static async Task Test(string name, Func<Task> action) { try { await action(); Results.Add(new { name, passed = true }); } catch (Exception e) { failed++; Results.Add(new { name, passed = false, error = e.GetBaseException().Message }); } }
}
internal sealed class ProbeStream(long total, bool hanging = false) : Stream
{
    public long Total => total; public long ReadBytes; public bool Closed;
    public TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously), Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
    public override long Length => total; public override long Position { get => ReadBytes; set => throw new NotSupportedException(); }
    public override int Read(byte[] b, int offset, int count) => ReadAsync(b.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) {
        Started.TrySetResult(); if (hanging) { await Release.Task.WaitAsync(token); return 0; }
        int n = (int)Math.Min(buffer.Length, total - ReadBytes); buffer.Span[..n].Fill((byte)' '); ReadBytes += n; return n;
    }
    public override Task<int> ReadAsync(byte[] b, int offset, int count, CancellationToken token) => ReadAsync(b.AsMemory(offset, count), token).AsTask();
    protected override void Dispose(bool disposing) { Closed = true; base.Dispose(disposing); }
    public override void Flush() { } public override long Seek(long o, SeekOrigin s) => throw new NotSupportedException(); public override void SetLength(long n) => throw new NotSupportedException(); public override void Write(byte[] b, int o, int n) => throw new NotSupportedException();
}
