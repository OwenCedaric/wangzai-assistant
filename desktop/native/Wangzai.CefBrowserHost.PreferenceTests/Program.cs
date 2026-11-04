using System.Text.Json.Nodes;
using CefSharp;
using Wangzai.CefBrowserHost;

int passed = 0;
BrowserProfile Profile(string mode = "fixed_servers", string rules = "http=127.0.0.1:1234;https=127.0.0.1:1234") => BrowserProfile.From(new JsonObject {
    ["profileDirectory"] = "isolated-profile", ["downloadsDirectory"] = "isolated-downloads",
    ["profile"] = new JsonObject { ["ownerRef"] = new string('a', 40), ["proxy"] = new JsonObject { ["mode"] = mode, ["rules"] = rules } }
});
void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
async Task Check(string name, Func<Task> work) { await work(); passed++; Console.WriteLine("PASS " + name); }
async Task Reject(Task operation, string code) {
    try { await operation; throw new Exception("expected failure:" + code); }
    catch (InvalidOperationException error) { Require(error.Message == code, "wrong error: " + error.Message); }
}
await Check("preferences wait for actual context initialization without blocking caller", async () => {
    var profile = Profile(); var preferences = new BrowserRequestContextPreferences(profile); var context = new Context();
    var waiting = preferences.EnsureAppliedAsync(profile);
    Require(!waiting.IsCompleted && context.Writes == 0, "preferences were attempted before initialization");
    context.Initialized = true; preferences.InitializeFixture(context); await waiting;
    Require(context.Writes == 3 && context.Values.ContainsKey("proxy"), "missing preference writes");
});
await Check("unchanged profiles do not repeatedly rewrite browser preferences", async () => {
    var profile = Profile(); var preferences = new BrowserRequestContextPreferences(profile); var context = new Context { Initialized = true };
    preferences.InitializeFixture(context);
    for (int i = 0; i < 100; i++) await preferences.EnsureAppliedAsync(profile);
    Require(context.Writes == 3, "redundant writes");
});
await Check("proxy rejection cannot be announced as ready", async () => {
    var profile = Profile(); var preferences = new BrowserRequestContextPreferences(profile); var context = new Context { Initialized = true, Fail = "proxy" };
    preferences.InitializeFixture(context);
    await Reject(preferences.EnsureAppliedAsync(profile), "PURCHASE_BROWSER_PROXY_CONFIGURATION_FAILED");
});
await Check("proxy readback mismatch cannot be announced as ready", async () => {
    var profile = Profile(); var preferences = new BrowserRequestContextPreferences(profile); var context = new Context { Initialized = true, WrongProxyReadback = true };
    preferences.InitializeFixture(context);
    await Reject(preferences.EnsureAppliedAsync(profile), "PURCHASE_BROWSER_PROXY_READBACK_FAILED");
});
await Check("missing fixed proxy rule never silently falls back to direct", async () => {
    var profile = Profile(rules: ""); var preferences = new BrowserRequestContextPreferences(profile); var context = new Context { Initialized = true };
    preferences.InitializeFixture(context);
    await Reject(preferences.EnsureAppliedAsync(profile), "PURCHASE_BROWSER_PROXY_RULES_REQUIRED");
    Require(context.Writes == 0, "invalid rule changed context");
});
await Check("direct and system configurations remain supported", async () => {
    foreach (string mode in new[] { "direct", "system" }) {
        var profile = Profile(mode); var preferences = new BrowserRequestContextPreferences(profile); var context = new Context { Initialized = true };
        preferences.InitializeFixture(context); await preferences.EnsureAppliedAsync(profile);
        Require(((Dictionary<string, object>)context.Values["proxy"])["mode"].Equals(mode), "proxy mode changed");
    }
});
await Check("same-account configuration updates remain supported after initialization", async () => {
    var preferences = new BrowserRequestContextPreferences(Profile()); var context = new Context { Initialized = true };
    preferences.InitializeFixture(context); await preferences.EnsureAppliedAsync(Profile(rules: "127.0.0.1:4321"));
    Require(((Dictionary<string, object>)context.Values["proxy"])["server"].Equals("127.0.0.1:4321"), "updated proxy ignored");
});
await Check("retired initialization cannot write preferences later", async () => {
    var profile = Profile(); var preferences = new BrowserRequestContextPreferences(profile); var context = new Context { Initialized = true };
    preferences.Close(); preferences.InitializeFixture(context);
    await Reject(preferences.EnsureAppliedAsync(profile), "PURCHASE_BROWSER_CEF_SESSION_CLOSED");
    Require(context.Writes == 0, "late callback wrote after retirement");
});
await Check("failed privacy preferences preserve an actionable failure", async () => {
    var profile = Profile(); var preferences = new BrowserRequestContextPreferences(profile); var context = new Context { Initialized = true, Fail = "webrtc.ip_handling_policy" };
    preferences.InitializeFixture(context);
    await Reject(preferences.EnsureAppliedAsync(profile), "PURCHASE_BROWSER_CONTEXT_PREFERENCES_FAILED");
});
await Check("owner close fences initialization still waiting without a browser session", async () => {
    var admission = new BrowserPendingLaunches();
    var ticket = admission.Begin("owner-a");
    Require(admission.Cancel("owner-a") != null, "pending owner not cancelled");
    await Reject(Task.Run(() => admission.Verify("owner-a", ticket)), "PURCHASE_BROWSER_SESSION_STALE");
    admission.Complete("owner-a", ticket);
    Require(admission.Count == 0, "cancelled ticket retained");
});
await Check("old completion cannot erase a new launch or another owner", () => {
    var admission = new BrowserPendingLaunches();
    var old = admission.Begin("owner-a"); var current = admission.Begin("owner-a"); var other = admission.Begin("owner-b");
    admission.Complete("owner-a", old); admission.Verify("owner-a", current); admission.Verify("owner-b", other);
    admission.Complete("owner-a", current); admission.Complete("owner-b", other);
    Require(admission.Count == 0, "completed tickets retained"); return Task.CompletedTask;
});
await Check("shutdown invalidates every pending owner and leaves no growing ticket history", async () => {
    var admission = new BrowserPendingLaunches();
    var ticket = admission.Begin("owner-a"); _ = admission.CancelAll();
    await Reject(Task.Run(() => admission.Verify("owner-a", ticket)), "PURCHASE_BROWSER_SESSION_STALE");
    admission.Complete("owner-a", ticket);
    for (int i = 0; i < 10000; i++) { var next = admission.Begin("owner-a"); admission.Complete("owner-a", next); }
    Require(admission.Count == 0, "ticket history grew");
});
await Check("cancelled launch completion waits for its resource-release receipt", async () => {
    var profile = Profile(); var preferences = new BrowserRequestContextPreferences(profile); var admission = new BrowserPendingLaunches();
    var ticket = admission.Begin("owner-a"); var waiting = preferences.EnsureAppliedAsync(profile, ticket.Token);
    var cancelled = admission.Cancel("owner-a");
    Require(cancelled != null && !cancelled.Released.IsCompleted, "cancel was misreported as release");
    preferences.InitializeFixture(new Context { Initialized = true });
    try { await waiting; throw new Exception("cancel did not fence post-initialization admission"); } catch (OperationCanceledException) { }
    preferences.Close(); admission.Complete("owner-a", ticket); await cancelled!.Released;
});
await Check("close waits for every superseded reservation, not just the newest ticket", async () => {
    var admission = new BrowserPendingLaunches(); var first = admission.Begin("owner-a"); var second = admission.Begin("owner-a");
    var closing = admission.Cancel("owner-a")!; admission.Complete("owner-a", second);
    Require(!closing.Released.IsCompleted, "new ticket completion erased a still-owned old reservation");
    admission.Complete("owner-a", first); await closing.Released;
    Require(admission.Count == 0, "released history retained");
});
await Check("cancellation drains an already-running preference write before context release", async () => {
    var profile = Profile(); var preferences = new BrowserRequestContextPreferences(profile); var context = new Context { Initialized = true };
    preferences.InitializeFixture(context);
    var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    using var release = new ManualResetEventSlim(); using var cancellation = new CancellationTokenSource();
    context.BeforeWrite = () => { entered.TrySetResult(); if (!release.Wait(TimeSpan.FromSeconds(3))) throw new Exception("fixture release timed out"); };
    var applying = preferences.EnsureAppliedAsync(Profile(rules: "127.0.0.1:4321"), cancellation.Token);
    await entered.Task.WaitAsync(TimeSpan.FromSeconds(2)); cancellation.Cancel();
    await Task.Delay(25); Require(!applying.IsCompleted, "cancellation pretended the active CEF write had ended");
    release.Set();
    try { await applying; throw new Exception("cancelled admission succeeded"); } catch (OperationCanceledException) { }
    preferences.Close(); Require(context.Writes == 6, "write task was not drained before release");
});
Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { passed, failed = 0, realCef = false }));

sealed class Context : IRequestContext
{
    public bool Initialized, WrongProxyReadback;
    public string Fail = string.Empty;
    public int Writes;
    public Action? BeforeWrite;
    public Dictionary<string, object> Values = new();
    public bool SetPreference(string name, object value, out string error) {
        if (!Initialized) throw new Exception("preference set too early");
        BeforeWrite?.Invoke();
        Writes++; error = name == Fail ? "synthetic failure" : string.Empty;
        if (error.Length != 0) return false;
        Values[name] = value; return true;
    }
    public object GetPreference(string name) => WrongProxyReadback && name == "proxy" ? new Dictionary<string, object> { ["mode"] = "direct" } : Values[name];
}
