using System.Net;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CefSharp;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        string native = Path.GetFullPath(args[0]), isolated = Path.GetFullPath(args[1]);
        Directory.CreateDirectory(isolated);
        AssemblyLoadContext.Default.Resolving += (_, name) => {
            string file = Path.Combine(native, name.Name + ".dll");
            return File.Exists(file) ? AssemblyLoadContext.Default.LoadFromAssemblyPath(file) : null;
        };
        return await Tests.Run(native, isolated);
    }
}

internal static class Tests
{
    private static readonly List<object> Results = new();
    private static int failures;
    private static string Root = "";
    private static Type Runtime = null!, Profile = null!;
    public static async Task<int> Run(string native, string isolated)
    {
        Root = isolated;
        Assembly assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(native, "Wangzai.CefBrowserHost.dll"));
        Runtime = assembly.GetType("Wangzai.CefBrowserHost.CrossBorderBuiltInRuntime", true)!;
        Profile = assembly.GetType("Wangzai.CefBrowserHost.BrowserProfile", true)!;
        await Test("two-account-cookie-and-readback-isolation", async () => {
            using var a = New("a", "normal"); using var b = New("b", "normal");
            var replies = await Task.WhenAll(a.Execute("cross-border-charges", Ledger()), b.Execute("cross-border-charges", Ledger()));
            for (int i = 0; i < replies.Length; i++) {
                var r = replies[i]; string owner = i == 0 ? "a" : "b";
                Check(r["userCode"]?.ToString() == "fixture-" + owner, "wrong remote account");
                Check(r["browserAccountRef"]?.ToString() == new string(owner[0], 40), "wrong storage owner");
                Check(r["charges"] is JsonArray rows && rows.Count == 24, "normal complete ledger lost rows");
                Check(r["pagination"]?["complete"]?.GetValue<bool>() == true, "complete fixture not recognized");
            }
            Check(a.CookieReads > 0 && b.CookieReads > 0, "native cookie callbacks were not executed");
            Check(a.Requests.All(r => r.Cookie == "fixture_session=fixture-a") && b.Requests.All(r => r.Cookie == "fixture_session=fixture-b"), "cookie leaked across accounts");
        });
        foreach (int status in new[] { 401, 403 }) await Test("http-auth-expiry-" + status, async () => {
            using var f = New("a", "http-" + status);
            var login = await f.Execute("cross-border-login-status", new());
            Check(login["loggedIn"]?.GetValue<bool>() == false && login["ok"]?.GetValue<bool>() == false, "expired auth reported ready");
            await Reject(() => f.Execute("cross-border-orders", new()), "CROSS_BORDER_LOGIN_REQUIRED");
        });
        await Test("login-html-is-not-a-successful-empty-order-list", async () => {
            using var f = New("a", "login-html");
            await Reject(() => f.Execute("cross-border-orders", new()), "CROSS_BORDER_LOGIN_REQUIRED");
        });
        await Test("invalid-response-is-not-a-successful-empty-order-list", async () => {
            using var f = New("a", "invalid-body");
            await Reject(() => f.Execute("cross-border-orders", new()), "CROSS_BORDER_API_FAILED");
        });
        await Test("successful-empty-order-list-remains-supported", async () => {
            using var f = New("a", "empty"); var r = await f.Execute("cross-border-orders", new());
            Check(r["ok"]?.GetValue<bool>() == true && r["orders"] is JsonArray a && a.Count == 0, "valid empty list rejected");
        });
        await Test("auth-expired-during-table-read-cannot-clear-a-ledger", async () => {
            using var f = New("a", "table-login");
            await Reject(() => f.Execute("cross-border-charges", Ledger()), "CROSS_BORDER_LOGIN_REQUIRED");
        });
        await Test("explicit-failure-flag-cannot-be-an-empty-success", async () => {
            using var f = New("a", "table-failure");
            await Reject(() => f.Execute("cross-border-charges", Ledger()), "CROSS_BORDER_API_FAILED");
        });
        await Test("positive-login-success-message-is-not-expiry", async () => {
            using var f = New("a", "login-success-message");
            var r = await f.Execute("cross-border-charges", Ledger());
            Check(r["ok"]?.GetValue<bool>() == true, "positive login success was rejected");
        });
        await Test("overlapping-charge-pages-read-all-unique-rows", async () => {
            using var f = New("a", "overlap-charge"); var r = await f.Execute("cross-border-charges", Ledger());
            Check(r["charges"] is JsonArray a && a.Count == 40, "raw-row count hid missing charge records");
            Check(r["pagination"]?["chargePagesRead"]?.GetValue<int>() == 3, "stopped before last unique page");
        });
        await Test("overlapping-order-pages-read-all-unique-rows", async () => {
            using var f = New("a", "overlap-order"); var r = await f.Execute("cross-border-charges", Ledger());
            Check(r["orders"] is JsonArray a && a.Count == 40, "raw-row count hid missing order records");
        });
        await Test("exact-repeat-page-is-a-typed-failure", async () => {
            using var f = New("a", "repeat-page");
            await Reject(() => f.Execute("cross-border-charges", Ledger()), "CROSS_BORDER_CHARGE_PAGINATION_REPEATED_PAGE");
        });
        await Test("empty-page-before-total-is-incomplete", async () => {
            using var f = New("a", "early-empty");
            await Reject(() => f.Execute("cross-border-charges", Ledger()), "CROSS_BORDER_CHARGE_PAGINATION_INCOMPLETE");
        });
        await Test("short-page-is-not-the-end-before-total", async () => {
            using var f = New("a", "short-page"); var r = await f.Execute("cross-border-charges", Ledger());
            Check(r["charges"] is JsonArray a && a.Count == 25, "short page incorrectly stopped pagination");
        });
        foreach (string kind in new[] { "null", "blank", "invalid", "false" }) await Test("unknown-charge-money-is-not-zero-" + kind, async () => {
            using var f = New("a", "money-" + kind);
            await Reject(() => f.Execute("cross-border-charges", Ledger()), "CROSS_BORDER_CHARGE_AMOUNT_INVALID");
        });
        await Test("explicit-zero-charge-remains-zero", async () => {
            using var f = New("a", "money-zero"); var r = await f.Execute("cross-border-charges", Ledger());
            Check(r["charges"]?[0]?["amountCny"]?.ToString() == "0", "known zero changed");
        });
        await Test("formatted-cny-charge-keeps-the-real-amount", async () => {
            using var f = New("a", "money-formatted"); var r = await f.Execute("cross-border-charges", Ledger());
            Check(r["charges"]?[0]?["amountCny"]?.ToString() == "1299.9", "formatted CNY amount became zero or changed");
        });
        await Test("selected-filters-and-trusted-paging-survive-http-encoding", async () => {
            using var f = New("a", "normal"); var input = Ledger();
            input["pageFilters"] = new JsonObject { ["reason"] = "发货费用", ["warehouse"] = "fixture-warehouse", ["page"] = 999, ["limit"] = 999 };
            await f.Execute("cross-border-charges", input);
            var first = f.Requests.First(r => r.Path == "/index/finance/record_consume.html");
            Check(first.Form["page"] == "1" && first.Form["limit"] == "20", "untrusted pagination forwarded");
            Check(first.Form["reason"] == "发货费用" && first.Form["warehouse"] == "fixture-warehouse", "selected filters lost");
        });
        Console.WriteLine(JsonSerializer.Serialize(new {
            passed = Results.Count - failures, failed = failures, actualCompiledRuntime = true, runtimeConstructed = true,
            cefInitialized = false, externalNetworkRequests = 0, nativeInputUsed = false, realProfilesUsed = false,
            transport = "owned HttpMessageHandler; synthetic per-owner CEF cookie callbacks",
            nativeDllSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(native, "Wangzai.CefBrowserHost.dll")))).ToLowerInvariant(), cases = Results
        }, new JsonSerializerOptions { WriteIndented = true }));
        return failures == 0 ? 0 : 1;
    }
    private static JsonObject Ledger() => new() { ["pageUrl"] = "https://www.kuajing84.com/index/finance/record_consume.html", ["pageSize"] = 20, ["maxPages"] = 5, ["includeDetails"] = false };
    private static async Task Test(string name, Func<Task> action) {
        try { await action(); Results.Add(new { name, passed = true }); }
        catch (Exception e) { failures++; Results.Add(new { name, passed = false, error = e.GetBaseException().Message }); }
    }
    private static async Task Reject(Func<Task<JsonObject>> action, string code) {
        try { await action(); } catch (Exception error) { Check(error.GetBaseException().Message == code, "wrong failure: " + error.GetBaseException().Message); return; }
        throw new Exception("expected " + code + ", but got success");
    }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static Fixture New(string owner, string scenario) => new(Runtime, Profile, Path.Combine(Root, Guid.NewGuid().ToString("N")), owner, scenario);
}

public class CallbackProxy : DispatchProxy
{
    public Func<MethodInfo, object?[], object?> Handler = null!;
    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => Handler(targetMethod!, args ?? []);
    public static T Make<T>(Func<MethodInfo, object?[], object?> callback) where T : class {
        T proxy = Create<T, CallbackProxy>(); ((CallbackProxy)(object)proxy).Handler = callback; return proxy;
    }
}

internal sealed class Fixture : IDisposable
{
    private readonly object runtime;
    private readonly MethodInfo execute;
    private readonly string owner, scenario;
    public int CookieReads;
    public sealed record Call(string Path, string Method, string Cookie, Dictionary<string, string> Form);
    public readonly List<Call> Requests = new();
    public Fixture(Type runtimeType, Type profileType, string directory, string owner, string scenario,
        Func<HttpRequestMessage, Task<HttpResponseMessage>>? transport = null,
        Func<string, string, Task<string>>? logisticsReader = null, string platformKey = "taobao",
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? cancellableTransport = null, int timeoutMs = 5000)
    {
        this.owner = owner; this.scenario = scenario;
        ICookieManager cookies = CallbackProxy.Make<ICookieManager>((method, args) => {
            if (method.Name == "VisitUrlCookies") {
                CookieReads++;
                var visitor = (ICookieVisitor)args[2]!; bool delete = false;
                visitor.Visit(new CefSharp.Cookie { Name = "fixture_session", Value = "fixture-" + owner, Domain = new Uri((string)args[0]!).Host, Path = "/", Secure = true }, 0, 1, ref delete);
                visitor.Dispose(); return true;
            }
            if (method.Name == "Dispose") return null;
            if (method.Name == "get_IsDisposed") return false;
            throw new Exception("UNEXPECTED_COOKIE_CALL:" + method.Name);
        });
        IRequestContext requestContext = CallbackProxy.Make<IRequestContext>((method, args) => {
            if (method.Name == "GetCookieManager") { ((ICompletionCallback?)args.FirstOrDefault())?.OnComplete(); return cookies; }
            if (method.Name == "Dispose") return null;
            if (method.Name == "get_IsDisposed") return false;
            throw new Exception("UNEXPECTED_CONTEXT_CALL:" + method.Name);
        });
        var payload = new JsonObject { ["profile"] = new JsonObject { ["ownerRef"] = new string(owner[0], 40), ["platformKey"] = platformKey },
            ["profileDirectory"] = directory, ["downloadsDirectory"] = Path.Combine(directory, "downloads") };
        object profile = profileType.GetMethod("From")!.Invoke(null, [payload])!;
        Func<string, string, Task<string>> logistics = logisticsReader ?? ((_, _) => throw new Exception("UNEXPECTED_BROWSER_CALL"));
        Func<string, Task<string>> supplier = _ => throw new Exception("UNEXPECTED_BROWSER_CALL");
        Func<string, Task<JsonObject?>> alibaba = _ => throw new Exception("UNEXPECTED_BROWSER_CALL");
        Action<string> authorization = _ => throw new Exception("UNEXPECTED_AUTH_WINDOW");
        runtime = Activator.CreateInstance(runtimeType, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, null,
            [profile, requestContext, logistics, supplier, alibaba, authorization], null)!;
        FieldInfo field = runtimeType.GetField("http", BindingFlags.NonPublic | BindingFlags.Instance)!;
        ((HttpClient)field.GetValue(runtime)!).Dispose();
        field.SetValue(runtime, new HttpClient(new Handler(transport ?? Reply, cancellableTransport)) { Timeout = TimeSpan.FromMilliseconds(timeoutMs) });
        execute = runtimeType.GetMethod("ExecuteAsync")!;
    }
    public async Task<JsonObject> Execute(string command, JsonObject payload) {
        object? result = await (Task<object?>)execute.Invoke(runtime, [command, payload])!;
        return JsonSerializer.SerializeToNode(result)!.AsObject();
    }
    private async Task<HttpResponseMessage> Reply(HttpRequestMessage request) {
        string body = request.Content == null ? "" : await request.Content.ReadAsStringAsync();
        var form = body.Split('&', StringSplitOptions.RemoveEmptyEntries).Select(s => s.Split('=', 2)).ToDictionary(p => WebUtility.UrlDecode(p[0]), p => WebUtility.UrlDecode(p.Length == 2 ? p[1] : ""));
        string cookie = request.Headers.TryGetValues("Cookie", out var cookieValues) ? string.Join("; ", cookieValues) : "";
        string pathname = request.RequestUri!.AbsolutePath;
        Requests.Add(new(pathname, request.Method.ToString(), cookie, form));
        if (request.RequestUri.Host != "www.kuajing84.com" || cookie != "fixture_session=fixture-" + owner) throw new Exception("FIXTURE_REQUEST_SCOPE_MISMATCH");
        if (scenario.StartsWith("http-")) return new HttpResponseMessage((HttpStatusCode)int.Parse(scenario[5..])) { Content = new StringContent("expired") };
        if (pathname == "/index/plugin/get_login_status") return Json(new JsonObject { ["code"] = 1, ["msg"] = scenario == "login-success-message" ? "重新登录成功" : "ok", ["data"] = new JsonObject { ["user_code"] = "fixture-" + owner } });
        if (pathname == "/index/plugin/get_order") {
            if (scenario is "login-html" or "invalid-body") return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(scenario == "login-html" ? "<html><title>请先登录</title><form>登录</form></html>" : "not-json-response", Encoding.UTF8, "text/html") };
            return Json(new JsonObject { ["code"] = 1, ["data"] = new JsonArray() });
        }
        bool charges = pathname == "/index/finance/record_consume.html";
        bool orders = pathname == "/index/Accountorder/order_list_submit/order_type/all";
        if (!charges && !orders) throw new Exception("UNEXPECTED_FIXTURE_ROUTE:" + pathname);
        int page = int.Parse(form["page"]), total = 0; IEnumerable<int> indices = [];
        if (charges && scenario == "table-login") return Json(new JsonObject { ["code"] = 0, ["msg"] = "请先登录", ["data"] = new JsonArray() });
        if (charges && scenario == "table-failure") return Json(new JsonObject { ["code"] = 0, ["success"] = false, ["msg"] = "读取失败", ["data"] = new JsonArray() });
        if (charges && scenario.StartsWith("money-")) {
            JsonNode? money = scenario switch { "money-zero" => JsonValue.Create(0), "money-formatted" => JsonValue.Create("1,299.90"), "money-blank" => JsonValue.Create(" "), "money-false" => JsonValue.Create(false), "money-invalid" => JsonValue.Create("unknown"), _ => null };
            return Json(new JsonObject { ["code"] = 0, ["count"] = 1, ["data"] = new JsonArray(new JsonObject { ["id"] = "fixture-money", ["money"] = money, ["reason"] = "发货费用" }) });
        }
        if (charges && scenario == "normal") { total = 24; indices = Enumerable.Range((page - 1) * 20, Math.Max(0, Math.Min(20, total - (page - 1) * 20))); }
        if ((charges && scenario == "overlap-charge") || (orders && scenario == "overlap-order")) {
            total = 40; indices = page switch { 1 => Enumerable.Range(0, 20), 2 => Enumerable.Range(10, 20), 3 => Enumerable.Range(30, 10), _ => [] };
        }
        if (charges && scenario == "repeat-page") { total = 40; indices = Enumerable.Range(0, 20); }
        if (charges && scenario == "early-empty") { total = 40; indices = page == 1 ? Enumerable.Range(0, 10) : []; }
        if (charges && scenario == "short-page") { total = 25; indices = page == 1 ? Enumerable.Range(0, 10) : page == 2 ? Enumerable.Range(10, 15) : []; }
        JsonArray rows = new(indices.Select(i => (JsonNode)(charges
            ? new JsonObject { ["id"] = $"{owner}-charge-{i}", ["money"] = 1.5, ["reason"] = "发货费用" }
            : new JsonObject { ["id"] = $"{owner}-internal-{i}", ["order_id"] = $"{owner}-collection-{i}", ["from_order"] = $"{owner}-purchase-{i}" })).ToArray());
        return Json(new JsonObject { ["code"] = 0, ["count"] = total, ["data"] = rows });
    }
    private static HttpResponseMessage Json(JsonNode value) => new(HttpStatusCode.OK) { Content = new StringContent(value.ToJsonString(), Encoding.UTF8, "application/json") };
    public void Dispose() => ((IDisposable)runtime).Dispose();
    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> reply,
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? cancellableReply = null) : HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => cancellableReply == null ? reply(request) : cancellableReply(request, cancellationToken);
    }
}
