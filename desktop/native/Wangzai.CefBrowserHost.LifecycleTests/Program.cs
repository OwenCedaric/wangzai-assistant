using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Wangzai.CefBrowserHost;

// The actual production protocol and renderer-health classes are linked above.
// CEF and the window coordinator are test doubles; this suite does not launch a
// browser, open websites, or read any account/profile data.
int passed = 0;
int failed = 0;
foreach (var scenario in new (string Name, TextReader Input)[] {
    ("normal-eof-closes-host", new StringReader("")),
    ("broken-pipe-closes-host", new FaultReader(new IOException("isolated broken pipe"))),
    ("disposed-pipe-closes-host", new FaultReader(new ObjectDisposedException("isolated pipe"))),
    ("cancelled-pipe-closes-host", new FaultReader(new OperationCanceledException())),
    ("invalid-envelope-type-does-not-abandon-host", new StringReader("{\"type\":42}\n")),
    ("invalid-json-does-not-abandon-host", new StringReader("{invalid\n")),
}) {
    await Run(scenario.Name, async () => {
        var coordinator = new BrowserHostCoordinator();
        using var protocol = new ProtocolServer(coordinator, scenario.Input);
        await Invoke(protocol, "ReadLoopAsync").WaitAsync(TimeSpan.FromSeconds(3));
        Check(coordinator.ShutdownCount == 1, "shutdown must run exactly once");
    });
}

await Run("stop-rejects-pending-host-action-without-timeout", async () => {
    using var protocol = new ProtocolServer(new(), new StringReader(""));
    var action = protocol.RequestHostActionAsync("owner-a", "isolated-read");
    protocol.Stop();
    await Rejects(action, "PURCHASE_BROWSER_CEF_DISCONNECTED");
    await Rejects(protocol.RequestHostActionAsync("owner-a", "isolated-read"), "PURCHASE_BROWSER_CEF_DISCONNECTED");
});

await Run("broken-write-rejects-host-action-and-removes-pending", async () => {
    ProtocolWriter.SetWriter(new FaultWriter());
    try {
        using var protocol = new ProtocolServer(new(), new StringReader(""));
        await Rejects(protocol.RequestHostActionAsync("owner-a", "isolated-read"), "PURCHASE_BROWSER_CEF_DISCONNECTED");
        var pending = typeof(ProtocolServer).GetField("hostActionResponses", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(protocol)!;
        Check((int)pending.GetType().GetProperty("Count")!.GetValue(pending)! == 0, "pending callback must be removed");
    } finally { ProtocolWriter.SetWriter(TextWriter.Null); }
});

await Run("dispose-during-active-command-does-not-fault-gate-release", async () => {
    var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var coordinator = new BrowserHostCoordinator {
        OnExecute = async (_, _) => { entered.SetResult(); await finish.Task; return new { ok = true }; }
    };
    var protocol = new ProtocolServer(coordinator, new StringReader(""));
    Task command = Invoke(protocol, "DispatchAsync", new JsonObject {
        ["id"] = "isolated-command", ["command"] = "state",
        ["payload"] = new JsonObject { ["ownerRef"] = "owner-a" }
    });
    await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
    protocol.Dispose();
    finish.SetResult();
    await command.WaitAsync(TimeSpan.FromSeconds(3));
});

await Run("window-and-health-commands-are-not-blocked-by-a-long-page-script", async () => {
    // Reproduces the field failure: a capture script holds the owner's page lane,
    // then bounds/health for the same owner must still answer immediately instead
    // of queuing until the script ends (the desktop times health out after 5s).
    var scriptEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var finishScript = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var coordinator = new BrowserHostCoordinator {
        OnExecute = async (command, _) => {
            if (command == "capture-purchase") { scriptEntered.SetResult(); await finishScript.Task; }
            return new { ok = true, command };
        }
    };
    using var protocol = new ProtocolServer(coordinator, new StringReader(""));
    JsonObject Message(string id, string command) => new() {
        ["id"] = id, ["command"] = command, ["payload"] = new JsonObject { ["ownerRef"] = "owner-a" }
    };
    Task script = Invoke(protocol, "DispatchAsync", Message("script", "capture-purchase"));
    await scriptEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
    foreach (string command in new[] { "bounds", "workbench", "parent", "hide", "restore", "health", "state" }) {
        await Invoke(protocol, "DispatchAsync", Message($"presentation-{command}", command))
            .WaitAsync(TimeSpan.FromSeconds(2));
    }
    Check(!script.IsCompleted, "the page script must still be running while window commands complete");
    // Page commands keep their strict one-at-a-time order behind the running script.
    Task navigate = Invoke(protocol, "DispatchAsync", Message("navigate", "navigate"));
    await Task.Delay(100);
    Check(!navigate.IsCompleted, "a second page command must still wait for the running script");
    finishScript.SetResult();
    await Task.WhenAll(script, navigate).WaitAsync(TimeSpan.FromSeconds(3));
});

await Run("window-commands-stay-ordered-among-themselves", async () => {
    var firstBoundsEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseFirstBounds = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var order = new List<string>();
    var coordinator = new BrowserHostCoordinator {
        OnExecute = async (command, payload) => {
            string id = payload["tag"]?.ToString() ?? command;
            if (id == "bounds-1") { firstBoundsEntered.SetResult(); await releaseFirstBounds.Task; }
            lock (order) order.Add(id);
            return new { ok = true };
        }
    };
    using var protocol = new ProtocolServer(coordinator, new StringReader(""));
    JsonObject Bounds(string tag) => new() {
        ["id"] = tag, ["command"] = "bounds",
        ["payload"] = new JsonObject { ["ownerRef"] = "owner-a", ["tag"] = tag }
    };
    Task first = Invoke(protocol, "DispatchAsync", Bounds("bounds-1"));
    await firstBoundsEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
    Task second = Invoke(protocol, "DispatchAsync", Bounds("bounds-2"));
    await Task.Delay(100);
    Check(!second.IsCompleted, "a later bounds update must not overtake an earlier one");
    releaseFirstBounds.SetResult();
    await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(3));
    Check(string.Join(",", order) == "bounds-1,bounds-2", "window updates must apply in send order");
});

await Run("renderer-crash-only-changes-exact-session-health", () => {
    var first = new BrowserRendererHealth();
    var second = new BrowserRendererHealth();
    first.MarkTerminated("ProcessWasKilled", 9);
    Check(first.Snapshot.Crashed, "crashed renderer must not be healthy");
    Check(first.Snapshot.TerminationStatus == "ProcessWasKilled" && first.Snapshot.ExitCode == 9, "retain bounded typed diagnostics");
    Check(!second.Snapshot.Crashed, "unrelated renderer remains healthy");
    Check(first.MarkReady(), "first recovery publishes ready");
    Check(!first.MarkReady(), "duplicate ready must not invent a recovery");
    Check(!first.Snapshot.Crashed && first.Snapshot.TerminationStatus == "" && first.Snapshot.ExitCode == 0, "ready resets stale diagnostics");
    return Task.CompletedTask;
});

await Run("renderer-state-snapshots-never-mix-crash-fields", async () => {
    var renderer = new BrowserRendererHealth();
    await Task.WhenAll(Enumerable.Range(0, 4).Select(index => Task.Run(() => {
        for (int attempt = 0; attempt < 10000; attempt++) {
            if ((index & 1) == 0) renderer.MarkTerminated("ProcessCrashed", 17);
            else renderer.MarkReady();
            var snapshot = renderer.Snapshot;
            Check(snapshot.Crashed
                ? snapshot.TerminationStatus == "ProcessCrashed" && snapshot.ExitCode == 17
                : snapshot.TerminationStatus == "" && snapshot.ExitCode == 0,
                "snapshot fields must belong to one atomic state");
        }
    })));
});

await Run("first-navigation-waits-for-initialized-and-initial-load", async () => {
    var readiness = new BrowserNavigationReadiness();
    int submitted = 0;
    Task navigation = readiness.ExecuteAsync(() => submitted++, TimeSpan.FromSeconds(3));
    Check(submitted == 0 && !navigation.IsCompleted, "must not navigate or advance sequence before initialization");
    readiness.MarkInitialized();
    Check(submitted == 0 && !navigation.IsCompleted, "browser creation alone must not release navigation");
    readiness.MarkInitialLoadCompleted();
    await navigation.WaitAsync(TimeSpan.FromSeconds(3));
    Check(submitted == 1, "single requested navigation must submit exactly once");
    await readiness.ExecuteAsync(() => submitted++, TimeSpan.FromSeconds(3));
    Check(submitted == 2, "ready browser must allow later navigation without a new initial wait");
});

await Run("initial-load-before-initialized-still-waits-for-both", async () => {
    var readiness = new BrowserNavigationReadiness();
    int submitted = 0;
    readiness.MarkInitialLoadCompleted();
    Task navigation = readiness.ExecuteAsync(() => submitted++, TimeSpan.FromSeconds(3));
    Check(submitted == 0 && !navigation.IsCompleted, "completion callback alone must not release navigation");
    readiness.MarkInitialized();
    await navigation.WaitAsync(TimeSpan.FromSeconds(3));
    Check(submitted == 1, "reversed callback order must submit exactly once");
});

await Run("close-cancels-waiting-navigation-with-no-late-submit", async () => {
    var readiness = new BrowserNavigationReadiness();
    int submitted = 0;
    Task navigation = readiness.ExecuteAsync(() => submitted++, TimeSpan.FromSeconds(3));
    readiness.Close();
    await Rejects(navigation, "PURCHASE_BROWSER_CEF_SESSION_CLOSED");
    readiness.MarkInitialized();
    readiness.MarkInitialLoadCompleted();
    Check(submitted == 0, "late readiness callbacks must not resurrect a closed session");
});

await Run("close-of-ready-browser-rejects-new-navigation", async () => {
    var readiness = new BrowserNavigationReadiness();
    int submitted = 0;
    readiness.MarkInitialized();
    readiness.MarkInitialLoadCompleted();
    readiness.Close();
    await Rejects(readiness.ExecuteAsync(() => submitted++, TimeSpan.FromSeconds(3)), "PURCHASE_BROWSER_CEF_SESSION_CLOSED");
    Check(submitted == 0, "ready-before-close must not permit late submission");
});

await Run("readiness-timeout-does-not-advance-or-later-replay-navigation", async () => {
    var readiness = new BrowserNavigationReadiness();
    int submitted = 0;
    await Rejects(readiness.ExecuteAsync(() => submitted++, TimeSpan.FromMilliseconds(20)), "PURCHASE_BROWSER_CEF_NAVIGATION_NOT_READY");
    readiness.MarkInitialized();
    readiness.MarkInitialLoadCompleted();
    Check(submitted == 0, "timed-out navigation must not commit when the page eventually becomes ready");
    await readiness.ExecuteAsync(() => submitted++, TimeSpan.FromSeconds(3));
    Check(submitted == 1, "a new explicit request may proceed once ready");
});

await Run("protocol-error-diagnostics-use-stderr-without-native-local-file-growth", async () => {
    var originalError = Console.Error;
    var stderr = new StringWriter();
    var protocolOutput = new StringWriter();
    Console.SetError(stderr);
    ProtocolWriter.SetWriter(protocolOutput);
    try {
        var coordinator = new BrowserHostCoordinator {
            OnExecute = (_, _) => throw new InvalidOperationException("PURCHASE_BROWSER_COMMAND_INVALID")
        };
        using var protocol = new ProtocolServer(coordinator, new StringReader(""));
        for (int index = 0; index < 5; index++) await Invoke(protocol, "DispatchAsync", new JsonObject {
            ["id"] = $"isolated-error-{index}", ["command"] = "inspect", ["payload"] = new JsonObject()
        });
        var diagnosticType = typeof(ProtocolServer).Assembly.GetType("Wangzai.CefBrowserHost.NativeApplicationDiagnostics");
        if (diagnosticType?.GetMethod("FlushAsync") is MethodInfo flush)
            await ((Task)flush.Invoke(null, [TimeSpan.FromSeconds(2)])!);
        Check(!File.Exists(Path.Combine(AppContext.BaseDirectory, "cef-host-error.log")), "native command errors must not append a second unbounded application log");
        Check(stderr.ToString().Contains("cef-command-error", StringComparison.Ordinal), "unexpected errors must reach controlled stderr diagnostics");
        string[] responses = protocolOutput.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Check(responses.Length == 5, "every failed command must still receive exactly one response");
        foreach (string response in responses) {
            JsonObject message = JsonNode.Parse(response)!.AsObject();
            Check(message["ok"]?.GetValue<bool>() == false && message["error"]?["code"]?.ToString() == "PURCHASE_BROWSER_COMMAND_INVALID", "logging must not change business failure responses");
        }
    } finally { Console.SetError(originalError); ProtocolWriter.SetWriter(TextWriter.Null); }
});

await Run("native-diagnostic-format-excludes-arbitrary-message-data-and-command-text", () => {
    const string sentinel = "fixture-private-cookie-token-and-account";
    var exception = new InvalidOperationException("PURCHASE_BROWSER_COMMAND_INVALID cookie=" + sentinel + new string('x', 1_000_000));
    exception.Data["cookie"] = sentinel;
    exception.Data["payload"] = new { account = sentinel };
    string line = NativeDiagnosticWriter.Format("inspect\ncookie=" + sentinel, exception);
    Check(line.Length <= 512, "individual native diagnostics must be short and bounded");
    Check(!line.Contains(sentinel, StringComparison.Ordinal), "arbitrary exception/command data must not enter the log");
    Check(!line.Contains('\n') && !line.Contains('\r'), "untrusted metadata cannot inject lines");
    Check(line.Contains("command=unknown-command", StringComparison.Ordinal)
        && line.Contains("code=UNCLASSIFIED_NATIVE_ERROR", StringComparison.Ordinal)
        && line.Contains("type=InvalidOperationException", StringComparison.Ordinal)
        && line.Contains("hresult=0x", StringComparison.Ordinal), "typed error evidence must remain available");
    string disguisedCode = NativeDiagnosticWriter.Format("inspect", new InvalidOperationException("PURCHASE_BROWSER_SECRET_PRIVATE_UPPERCASE_VALUE"));
    Check(!disguisedCode.Contains("SECRET_PRIVATE_UPPERCASE_VALUE", StringComparison.Ordinal), "a familiar prefix must not make arbitrary content printable");
    return Task.CompletedTask;
});

await Run("long-exception-keeps-exact-command-response-while-diagnostics-stay-redacted", async () => {
    const string sentinel = "fixture-only-private-response-sentinel";
    string originalCode = "PURCHASE_BROWSER_COMMAND_INVALID: " + sentinel + new string('q', 100_000);
    var stderr = new StringWriter();
    var diagnostics = new NativeDiagnosticWriter(stderr);
    var protocolOutput = new StringWriter();
    ProtocolWriter.SetWriter(protocolOutput);
    try {
        var coordinator = new BrowserHostCoordinator {
            OnExecute = (_, _) => throw new InvalidOperationException(originalCode)
        };
        using var protocol = new ProtocolServer(coordinator, new StringReader(""), (command, error) => { diagnostics.TryReport(command, error); });
        await Invoke(protocol, "DispatchAsync", FailureCommand("long-response"));
        Check(await diagnostics.FlushAsync(TimeSpan.FromSeconds(2)), "diagnostic worker should flush normally");
        JsonObject response = JsonNode.Parse(protocolOutput.ToString())!.AsObject();
        Check(response["id"]?.ToString() == "long-response" && response["ok"]?.GetValue<bool>() == false,
            "failed command response identity/outcome must be retained");
        Check(response["error"]?["code"]?.ToString() == originalCode, "logging must not normalize or alter the business error response");
        Check(!stderr.ToString().Contains(sentinel, StringComparison.Ordinal) && stderr.ToString().Length <= 512,
            "long private exception data must not be copied into diagnostics");
    } finally { ProtocolWriter.SetWriter(TextWriter.Null); }
});

await Run("broken-stderr-cannot-change-or-block-native-command-failure-responses", async () => {
    var diagnostics = new NativeDiagnosticWriter(new FaultWriter());
    var protocolOutput = new StringWriter();
    ProtocolWriter.SetWriter(protocolOutput);
    try {
        var coordinator = new BrowserHostCoordinator {
            OnExecute = (_, _) => throw new InvalidOperationException("PURCHASE_BROWSER_COMMAND_INVALID")
        };
        using var protocol = new ProtocolServer(coordinator, new StringReader(""), (command, error) => { diagnostics.TryReport(command, error); });
        for (int index = 0; index < 20; index++) await Invoke(protocol, "DispatchAsync", FailureCommand($"broken-stderr-{index}"));
        Check(!await diagnostics.FlushAsync(TimeSpan.FromSeconds(2)), "unavailable stderr must not masquerade as a successful flush");
        Check(diagnostics.WriteFailureCount > 0, "stderr failure must be counted");
        Check(protocolOutput.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries).Length == 20,
            "stderr failure must not drop protocol responses");
        Check(!File.Exists(Path.Combine(AppContext.BaseDirectory, "cef-host-error.log")), "there must not be an unbounded fallback log");
    } finally { ProtocolWriter.SetWriter(TextWriter.Null); }
});

await Run("blocked-stderr-is-off-the-command-thread-and-final-flush-is-bounded", async () => {
    using var stderr = new BlockedDiagnosticWriter();
    var diagnostics = new NativeDiagnosticWriter(stderr);
    var protocolOutput = new StringWriter();
    ProtocolWriter.SetWriter(protocolOutput);
    try {
        diagnostics.TryReport("inspect", new InvalidOperationException("PURCHASE_BROWSER_COMMAND_INVALID"));
        await stderr.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var coordinator = new BrowserHostCoordinator {
            OnExecute = (_, _) => throw new InvalidOperationException("PURCHASE_BROWSER_COMMAND_INVALID")
        };
        using var protocol = new ProtocolServer(coordinator, new StringReader(""), (command, error) => { diagnostics.TryReport(command, error); });
        await Invoke(protocol, "DispatchAsync", FailureCommand("blocked-stderr")).WaitAsync(TimeSpan.FromSeconds(1));
        Check(JsonNode.Parse(protocolOutput.ToString())?["id"]?.ToString() == "blocked-stderr", "command response must not wait for stderr");
        Check(!await diagnostics.FlushAsync(TimeSpan.FromMilliseconds(30)), "blocked sink cannot claim to have flushed");
    } finally {
        stderr.Release();
        Check(await diagnostics.FlushAsync(TimeSpan.FromSeconds(2)), "released sink must drain the bounded backlog");
        ProtocolWriter.SetWriter(TextWriter.Null);
    }
});

await Run("diagnostic-storm-retains-only-bounded-records-and-reports-loss-summary", async () => {
    using var stderr = new BlockedDiagnosticWriter();
    var diagnostics = new NativeDiagnosticWriter(stderr, capacity: 4);
    try {
        diagnostics.TryReport("inspect", new InvalidOperationException("PURCHASE_BROWSER_COMMAND_INVALID"));
        await stderr.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var error = new InvalidOperationException("PURCHASE_BROWSER_CEF_FAILED");
        for (int index = 0; index < 5000; index++) diagnostics.TryReport("inspect", error);
        Check(diagnostics.QueuedCount <= 4, "blocked stderr must not create an unbounded memory queue");
        Check(diagnostics.DroppedCount >= 4996, "overflow must be counted instead of silently disappearing");
    } finally { stderr.Release(); }
    Check(await diagnostics.FlushAsync(TimeSpan.FromSeconds(2)), "bounded queue and loss summary should drain");
    Check(stderr.Lines.Count <= 6, "output after a blocked burst is limited to in-flight + capacity + summary");
    Check(stderr.Lines.Any(line => line.Contains("cef-command-error-summary", StringComparison.Ordinal)
        && line.Contains("dropped=", StringComparison.Ordinal)), "operator must be told that diagnostic entries were dropped");
    Check(stderr.Lines.All(line => line.Length <= 512), "every burst entry is individually bounded");
});

await Run("throwing-diagnostic-callback-cannot-mask-the-original-command-error", async () => {
    var protocolOutput = new StringWriter();
    ProtocolWriter.SetWriter(protocolOutput);
    try {
        var coordinator = new BrowserHostCoordinator {
            OnExecute = (_, _) => throw new InvalidOperationException("PURCHASE_BROWSER_COMMAND_INVALID")
        };
        using var protocol = new ProtocolServer(coordinator, new StringReader(""), (_, _) => throw new IOException("isolated diagnostic callback failure"));
        await Invoke(protocol, "DispatchAsync", FailureCommand("callback-failed"));
        Check(JsonNode.Parse(protocolOutput.ToString())?["error"]?["code"]?.ToString() == "PURCHASE_BROWSER_COMMAND_INVALID",
            "diagnostic exceptions must never replace the original response code");
    } finally { ProtocolWriter.SetWriter(TextWriter.Null); }
});

await Run("expected-observer-miss-response-and-existing-log-suppression-remain-unchanged", async () => {
    int diagnostics = 0;
    var protocolOutput = new StringWriter();
    ProtocolWriter.SetWriter(protocolOutput);
    try {
        var coordinator = new BrowserHostCoordinator {
            OnExecute = (_, _) => throw new InvalidOperationException("OZON_DATA_OBSERVER_NOT_READY")
        };
        using var protocol = new ProtocolServer(coordinator, new StringReader(""), (_, _) => diagnostics++);
        await Invoke(protocol, "DispatchAsync", FailureCommand("observer-miss"));
        Check(diagnostics == 0, "the existing expected-miss policy must not change");
        Check(JsonNode.Parse(protocolOutput.ToString())?["error"]?["code"]?.ToString() == "OZON_DATA_OBSERVER_NOT_READY",
            "expected misses must retain their exact native command response");
    } finally { ProtocolWriter.SetWriter(TextWriter.Null); }
});

Console.WriteLine(JsonSerializer.Serialize(new { passed, failed, realBrowser = false, realProfiles = false }));
return failed == 0 ? 0 : 1;

async Task Run(string name, Func<Task> action) {
    try { await action(); passed++; Console.WriteLine(JsonSerializer.Serialize(new { scenario = name, passed = true })); }
    catch (Exception error) { failed++; Console.WriteLine(JsonSerializer.Serialize(new { scenario = name, passed = false, error = error.ToString() })); }
}

static Task Invoke(ProtocolServer protocol, string method, params object[] arguments) =>
    (Task)typeof(ProtocolServer).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(protocol, arguments)!;

static void Check(bool passed, string error) { if (!passed) throw new Exception(error); }

static JsonObject FailureCommand(string id) => new() { ["id"] = id, ["command"] = "inspect", ["payload"] = new JsonObject() };

static async Task Rejects(Task task, string code) {
    try { await task.WaitAsync(TimeSpan.FromSeconds(3)); }
    catch (InvalidOperationException error) when (error.Message == code) { return; }
    throw new Exception($"expected rejection {code}");
}

sealed class FaultReader(Exception error) : TextReader {
    public override ValueTask<string?> ReadLineAsync(CancellationToken cancellationToken) => ValueTask.FromException<string?>(error);
}

sealed class FaultWriter : TextWriter {
    public override System.Text.Encoding Encoding => System.Text.Encoding.UTF8;
    public override void WriteLine(string? value) => throw new IOException("isolated write disconnect");
}

sealed class BlockedDiagnosticWriter : TextWriter {
    private readonly ManualResetEventSlim released = new(false);
    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public List<string> Lines { get; } = new();
    public override System.Text.Encoding Encoding => System.Text.Encoding.UTF8;
    public override void WriteLine(string? value) {
        Entered.TrySetResult();
        released.Wait();
        Lines.Add(value ?? "");
    }
    public void Release() => released.Set();
    protected override void Dispose(bool disposing) { if (disposing) released.Dispose(); base.Dispose(disposing); }
}

namespace CefSharp {
    internal static class Cef {
        public static string CefSharpVersion => "test-double";
        public static string ChromiumVersion => "test-double";
    }
}

namespace Wangzai.CefBrowserHost {
    internal sealed class BrowserHostCoordinator {
        public int ShutdownCount { get; private set; }
        public Func<string, JsonObject, Task<object?>>? OnExecute { get; init; }
        public Task<object?> ExecuteAsync(string command, JsonObject payload) {
            if (command == "shutdown") ShutdownCount++;
            return OnExecute?.Invoke(command, payload) ?? Task.FromResult<object?>(new { ok = true });
        }
    }
}
