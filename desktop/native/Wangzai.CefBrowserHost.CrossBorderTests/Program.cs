using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Nodes;
using Wangzai.CefBrowserHost;

internal static class Program
{
    private static int Main(string[] args)
    {
        string runtimeRoot = Path.GetFullPath(args[0]);
        AssemblyLoadContext.Default.Resolving += (_, name) => {
            string file = Path.Combine(runtimeRoot, name.Name + ".dll");
            return File.Exists(file) ? AssemblyLoadContext.Default.LoadFromAssemblyPath(file) : null;
        };
        return Tests.Run();
    }
}

internal static class Tests
{
    private const string Wanted = "1234567890123";
    private static readonly Type Runtime = typeof(CrossBorderBuiltInRuntime);
    private static readonly List<object> Results = new();
    private static int failed;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static int Run()
    {
        foreach (var variant in new[] { Wanted + "4", "9" + Wanted, "x" + Wanted, Wanted + "-4" })
            Test("foreign-prefix-or-suffix-" + variant, () => Reject($"<div>订单号：{variant} 实付款：￥99.90 待发货</div>"));
        Test("missing-order-id-does-not-borrow-request-url", () => Reject("<main>实付款：￥99.90 待发货</main>"));
        Test("url-echo-alone-is-not-order-evidence", () => Reject($"<a href='?bizOrderId={Wanted}'>返回</a><main>实付款：99.90 待发货</main>"));
        Test("mixed-order-page-does-not-take-first-amount", () => Reject($"<article>订单号：9876543210123 实付款：99.90 已发货</article><article>订单号：{Wanted} 实付款：12.34 待付款</article>"));
        Test("parent-and-child-order-identities-are-not-one-payment", () => Reject($"主订单编号：{Wanted} 子订单号：9876543210123 实付款：99.90 待发货"));
        Test("explicit-foreign-capture-cannot-fall-through-to-unrelated-amount", () => Reject(new JsonObject {
            ["pageType"] = "order-detail", ["orderIdentityVerified"] = true, ["platform"] = "taobao",
            ["purchaseOrderNumber"] = Wanted + "4", ["purchaseOrderStatus"] = "待发货", ["purchasePrice"] = 99.9,
            ["totalAmount"] = 99.9, ["requestedUrl"] = "?bizOrderId=" + Wanted
        }.ToJsonString()));

        foreach (var html in new[] {
            $"<main>订单号：{Wanted} 实付款：￥12.34 当前订单状态：待发货</main>",
            $"<table><tr><td>订单编号</td><td>{Wanted}</td></tr><tr><td>实付款(含运费)：￥12.34</td><td>已发货</td></tr></table>",
            $"<div>交易编号: {Wanted}<br/>订单实付：￥12.34 买家已付款</div>",
            $"<main>Order ID: {Wanted} 实付金额: 12.34 待发货</main>",
            $"<main data-order-id=\"{Wanted}\">实付款：￥12.34 待发货</main>"
        }) Test("valid-single-order-html-" + Results.Count, () => {
            JsonObject snapshot = Parse(html) ?? throw new Exception("legitimate single-order fallback was disabled");
            Check(snapshot["purchaseOrderNumber"]?.ToString() == Wanted, "wrong order");
            Check(snapshot["purchasePrice"]?.GetValue<double>() == 12.34, "existing paid amount changed");
        });

        Test("exact-structured-capture-keeps-payment-and-refund-fields", () => {
            var raw = new JsonObject {
                ["pageType"] = "order-detail", ["orderIdentityVerified"] = true, ["platform"] = "taobao",
                ["purchaseOrderNumber"] = Wanted, ["purchaseOrderStatus"] = "退款成功", ["purchasePrice"] = 12.34,
                ["paymentConfirmed"] = false, ["refundConfirmed"] = true
            }.ToJsonString();
            JsonObject snapshot = Parse(raw) ?? throw new Exception("exact capture rejected");
            Check(snapshot["purchasePrice"]?.GetValue<double>() == 12.34 && snapshot["refundConfirmed"]?.GetValue<bool>() == true
                && snapshot["paymentConfirmed"]?.GetValue<bool>() == false, "existing amount/refund semantics changed");
        });
        Test("legitimate-json-order-record-keeps-numeric-order-id", () => {
            var raw = new JsonObject { ["orderId"] = long.Parse(Wanted), ["orderStatus"] = "PAID", ["totalAmount"] = 12.34 }.ToJsonString();
            Check(Parse(raw)?["purchasePrice"]?.GetValue<double>() == 12.34, "typed single-order JSON fallback must work");
        });
        Test("pdd-hyphen-order-and-existing-cent-conversion-stay-supported", () => {
            const string pddOrder = "260905-123456789012345";
            var raw = new JsonObject { ["order_sn"] = pddOrder, ["orderStatus"] = "PAID", ["pay_amount"] = 1234 }.ToJsonString();
            Check(Parse(raw, "pdd", pddOrder)?["purchasePrice"]?.GetValue<double>() == 12.34, "PDD integer cents semantics changed");
        });
        Test("unknown-json-multiple-orders-do-not-mix-price-and-status", () => Reject(new JsonArray {
            new JsonObject { ["orderId"] = Wanted, ["orderStatus"] = "UNPAID", ["totalAmount"] = 12.34 },
            new JsonObject { ["orderId"] = Wanted + "4", ["orderStatus"] = "PAID", ["totalAmount"] = 99.9 }
        }.ToJsonString()));

        Test("complete-order-token-is-not-a-substring", () => {
            foreach (string foreign in new[] { Wanted + "4", "9" + Wanted, "x" + Wanted, Wanted + "-4" })
                Check(!(bool)Invoke("ContainsExactSupplierOrderToken", foreign, Wanted)!, "caller accepted a partial order token");
            Check((bool)Invoke("ContainsExactSupplierOrderToken", "订单号：" + Wanted + " 实付款", Wanted)!, "complete adjacent-Chinese token rejected");
        });
        Test("html-entity-and-escaped-json-order-ids-remain-readable", () => {
            string entityId = string.Concat(Wanted.Select(character => "&#" + (int)character + ";"));
            Check(Parse("<div>订单编号：" + entityId + " 实付款：12.34 待发货</div>")?["purchasePrice"]?.GetValue<double>() == 12.34,
                "HTML entity order identity failed");
            string escapedId = string.Concat(Wanted.Select(character => "\\u" + ((int)character).ToString("x4")));
            string raw = "{\"orderId\":\"" + escapedId + "\",\"orderStatus\":\"PAID\",\"totalAmount\":12.34}";
            Check(Parse(raw)?["purchasePrice"]?.GetValue<double>() == 12.34, "escaped JSON order identity failed");
        });
        Test("payment-transaction-id-does-not-become-a-second-purchase-order", () => {
            string html = $"订单号：{Wanted} 支付宝交易号：202609059999999999 实付款：12.34 待发货";
            Check(Parse(html)?["purchasePrice"]?.GetValue<double>() == 12.34, "payment transaction number was confused with order number");
        });
        foreach (string label in new[] { "实付款含运费", "实付款(含运费)", "实付款（含运费）", "实付款( 含运费 )" })
            Test("equivalent-freight-inclusive-label-" + label, () => {
                Check(Parse($"订单号：{Wanted} {label}：12.34 待发货")?["purchasePrice"]?.GetValue<double>() == 12.34,
                    "equivalent label must not change the actual amount");
            });
        foreach (string label in new[] { "实付款(不含运费)", "实付款（运费另计）", "商品总价" })
            Test("non-equivalent-label-does-not-invent-paid-total-" + label, () => Reject($"订单号：{Wanted} {label}：12.34 待发货"));
        foreach (string missing in new[] { $"订单号：{Wanted} 待发货", $"订单号：{Wanted} 实付款：12.34" })
            Test("missing-price-or-state-stays-incomplete-" + Results.Count, () => Reject(missing));
        Test("invalid-structured-money-does-not-fall-through-to-another-amount", () => Reject(new JsonObject {
            ["pageType"] = "order-detail", ["orderIdentityVerified"] = true, ["platform"] = "taobao",
            ["purchaseOrderNumber"] = Wanted, ["purchaseOrderStatus"] = "待发货", ["purchasePrice"] = "NaN", ["totalAmount"] = 99.9
        }.ToJsonString()));
        Test("unverified-normalized-capture-cannot-borrow-its-requested-url", () => Reject(new JsonObject {
            ["pageType"] = "order-detail", ["orderIdentityVerified"] = false, ["platform"] = "taobao",
            ["purchaseOrderNumber"] = Wanted, ["purchaseOrderStatus"] = "待发货", ["purchasePrice"] = 12.34,
            ["pageUrl"] = "https://fixture.invalid/?orderId=" + Wanted
        }.ToJsonString()));
        Test("1688-structured-multiple-orders-still-selects-exact-target", () => {
            JsonObject Order(string id, int cents, string status) => new() {
                ["idStr"] = id, ["status"] = status, ["sumPayment"] = cents,
                ["orderEntries"] = new JsonArray(new JsonObject { ["productName"] = "fixture product", ["quantity"] = 1 })
            };
            string raw = new JsonObject { ["orders"] = new JsonArray(
                Order(Wanted + "4", 9990, "waitbuyerpay"), Order(Wanted, 1234, "waitsellersend")) }.ToJsonString();
            JsonObject snapshot = Parse(raw, "1688") ?? throw new Exception("existing structured multi-order support was disabled");
            Check(snapshot["purchaseOrderNumber"]?.ToString() == Wanted && snapshot["purchasePrice"]?.GetValue<double>() == 12.34,
                "selected a neighboring order or changed the 1688 cents amount");
            Check(snapshot["paymentConfirmed"]?.GetValue<bool>() == true, "target payment status was mixed with other order");
        });
        Test("existing-8MiB-raw-response-bound-is-enforced-before-parsing", () =>
            ExpectCode(() => Invoke("SupplierDocumentText", new string('x', 8 * 1024 * 1024 + 1)), "CROSS_BORDER_PURCHASE_PAGE_TOO_LARGE"));
        Test("normalized-text-bound-never-silently-removes-later-order-evidence", () =>
            ExpectCode(() => Invoke("SupplierDocumentText", $"订单号：{Wanted} 实付款12.34 待发货 " + new string('x', 500001) + " 订单号：9876543210123"),
                "CROSS_BORDER_PURCHASE_PAGE_TOO_LARGE"));
        Test("large-legal-single-order-html-remains-supported", () => {
            string raw = "<main>" + string.Concat(Enumerable.Repeat("<span>商品说明</span>", 10000))
                + $"订单号：{Wanted} 实付款：12.34 待发货</main>";
            Check(Parse(raw)?["purchasePrice"]?.GetValue<double>() == 12.34, "large legal page became unreadable");
        });
        Test("malformed-long-markup-finishes-or-fails-typed-within-bounded-time", () => {
            var task = Task.Run(() => {
                try { Invoke("SupplierDocumentText", new string('<', 200000)); }
                catch (InvalidOperationException error) when (error.Message == "CROSS_BORDER_PURCHASE_PAGE_TOO_COMPLEX") { }
            });
            task.WaitAsync(TimeSpan.FromSeconds(2)).GetAwaiter().GetResult();
        });
        Test("supplier-body-content-length-overflow-fails-before-stream-read", () => {
            using var content = new ByteArrayContent(new byte[8 * 1024 * 1024 + 1]);
            ExpectCode(() => ((Task<byte[]>)Invoke("ReadBoundedSupplierResponseAsync", content, CancellationToken.None)!).GetAwaiter().GetResult(),
                "CROSS_BORDER_PURCHASE_PAGE_TOO_LARGE");
        });
        Test("supplier-chunked-body-stops-at-one-byte-over-existing-limit", () => {
            using var source = new SizedFixtureStream(8 * 1024 * 1024 + 100000);
            using var content = new StreamContent(source);
            ExpectCode(() => ((Task<byte[]>)Invoke("ReadBoundedSupplierResponseAsync", content, CancellationToken.None)!).GetAwaiter().GetResult(),
                "CROSS_BORDER_PURCHASE_PAGE_TOO_LARGE");
            Check(source.BytesRead <= 8 * 1024 * 1024 + 1, "oversize supplier stream was consumed unboundedly");
        });
        Test("supplier-small-body-and-cancellation-keep-normal-contract", () => {
            using var content = new StringContent("fixture-only-body");
            byte[] bytes = ((Task<byte[]>)Invoke("ReadBoundedSupplierResponseAsync", content, CancellationToken.None)!).GetAwaiter().GetResult();
            Check(System.Text.Encoding.UTF8.GetString(bytes) == "fixture-only-body", "normal body bytes changed");
            using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
            using var second = new StreamContent(new SizedFixtureStream(10));
            bool rejected = false;
            try { ((Task<byte[]>)Invoke("ReadBoundedSupplierResponseAsync", second, cancelled.Token)!).GetAwaiter().GetResult(); }
            catch (OperationCanceledException) { rejected = true; }
            Check(rejected, "cancelled body read was ignored");
        });

        Console.WriteLine(JsonSerializer.Serialize(new { passed = Results.Count - failed, failed, productionSourceLinked = true,
            cefInitialized = false, runtimeConstructed = false, networkRequests = 0, realProfilesUsed = false,
            cases = Results }, new JsonSerializerOptions { WriteIndented = true }));
        return failed == 0 ? 0 : 1;
    }

    private static JsonObject? Parse(string raw, string platform = "taobao", string orderId = Wanted)
    {
        string text = (string)Invoke("SupplierDocumentText", raw)!;
        object?[] arguments = [raw, text, "https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=" + orderId,
            platform, orderId, null];
        return (bool)Invoke("TryParseSupplierOrderSnapshot", arguments)! ? (JsonObject?)arguments[^1] : null;
    }
    private static void Reject(string raw)
    {
        try { Check(Parse(raw) == null, "unsafe supplier evidence was accepted"); }
        catch (InvalidOperationException error) when (error.Message.StartsWith("CROSS_BORDER_PURCHASE_ORDER_", StringComparison.Ordinal)) { }
    }
    private static object? Invoke(string name, params object?[] arguments)
    {
        try { return Runtime.GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, arguments); }
        catch (TargetInvocationException error) when (error.InnerException != null) {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw(); throw;
        }
    }
    private static void Check(bool valid, string message) { if (!valid) throw new Exception(message); }
    private static void ExpectCode(Action action, string code)
    {
        try { action(); }
        catch (InvalidOperationException error) when (error.Message == code) { return; }
        throw new Exception("expected typed failure " + code);
    }
    private static void Test(string name, Action action)
    {
        var clock = Stopwatch.StartNew();
        try { action(); Results.Add(new { name, passed = true, elapsedMs = clock.Elapsed.TotalMilliseconds }); }
        catch (Exception error) { failed++; Results.Add(new { name, passed = false, elapsedMs = clock.Elapsed.TotalMilliseconds, error = error.Message }); }
    }
}

internal sealed class SizedFixtureStream(long length) : Stream
{
    public long BytesRead { get; private set; }
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => BytesRead; set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) {
        int selected = (int)Math.Min(count, length - BytesRead);
        Array.Clear(buffer, offset, selected); BytesRead += selected; return selected;
    }
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
        cancellationToken.ThrowIfCancellationRequested();
        int selected = (int)Math.Min(buffer.Length, length - BytesRead);
        buffer.Span[..selected].Clear(); BytesRead += selected; return ValueTask.FromResult(selected);
    }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
