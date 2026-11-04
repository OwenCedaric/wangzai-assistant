using System.Text.Json;
using System.Text.Json.Nodes;
using Wangzai.CefBrowserHost;

// Links the real coordinator. Only the WinForms execution surface is a double;
// it allows exact asynchronous close/launch interleavings without real accounts.
int passed = 0, failed = 0;
await Run("late-graceful-close-cannot-erase-reopened-owner-route", async () => {
    var closing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var general = new BrowserHostForm {
        Execute = async (command, _) => {
            if (command == "close") { closing.TrySetResult(); await finish.Task; }
            return new { ok = true };
        }
    };
    var coordinator = new BrowserHostCoordinator(general, new());
    await coordinator.ExecuteAsync("launch", Owner("owner-a"));
    Task<object?> previousClose = coordinator.ExecuteAsync("close", Owner("owner-a"));
    await closing.Task;
    await coordinator.ExecuteAsync("force-close", Owner("owner-a"));
    await coordinator.ExecuteAsync("launch", Owner("owner-a"));
    finish.SetResult();
    await previousClose;
    await coordinator.ExecuteAsync("state", Owner("owner-a"));
});

await Run("late-force-close-cannot-erase-reopened-owner-route", async () => {
    var closing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var general = new BrowserHostForm {
        Execute = async (command, _) => {
            if (command == "force-close") { closing.TrySetResult(); await finish.Task; }
            return new { ok = true };
        }
    };
    var coordinator = new BrowserHostCoordinator(general, new());
    await coordinator.ExecuteAsync("launch", Owner("owner-a"));
    Task<object?> previousClose = coordinator.ExecuteAsync("force-close", Owner("owner-a"));
    await closing.Task;
    await coordinator.ExecuteAsync("launch", Owner("owner-a"));
    finish.SetResult();
    await previousClose;
    await coordinator.ExecuteAsync("state", Owner("owner-a"));
});

await Run("old-failed-launch-cannot-erase-new-successful-launch-route", async () => {
    var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var failFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    int launches = 0;
    var general = new BrowserHostForm {
        Execute = async (command, _) => {
            if (command == "launch" && Interlocked.Increment(ref launches) == 1) {
                firstEntered.SetResult(); await failFirst.Task;
                throw new InvalidOperationException("isolated launch failure");
            }
            return new { ok = true };
        }
    };
    var coordinator = new BrowserHostCoordinator(general, new());
    Task<object?> firstLaunch = coordinator.ExecuteAsync("launch", Owner("owner-a"));
    await firstEntered.Task;
    await coordinator.ExecuteAsync("launch", Owner("owner-a"));
    failFirst.SetResult();
    try { await firstLaunch; throw new Exception("first launch must fail"); }
    catch (InvalidOperationException error) when (error.Message == "isolated launch failure") { }
    await coordinator.ExecuteAsync("state", Owner("owner-a"));
});

await Run("closing-current-owner-removes-only-that-owner", async () => {
    var coordinator = new BrowserHostCoordinator(new(), new());
    await coordinator.ExecuteAsync("launch", Owner("owner-a"));
    await coordinator.ExecuteAsync("launch", Owner("owner-b"));
    await coordinator.ExecuteAsync("close", Owner("owner-a"));
    try { await coordinator.ExecuteAsync("state", Owner("owner-a")); throw new Exception("closed owner must be absent"); }
    catch (InvalidOperationException error) when (error.Message == "PURCHASE_BROWSER_CEF_SESSION_NOT_FOUND") { }
    await coordinator.ExecuteAsync("state", Owner("owner-b"));
});

Console.WriteLine(JsonSerializer.Serialize(new { passed, failed, realCoordinator = true, realBrowser = false, realProfiles = false }));
return failed == 0 ? 0 : 1;

static JsonObject Owner(string ownerRef) => new() { ["ownerRef"] = ownerRef };
async Task Run(string scenario, Func<Task> test) {
    try { await test().WaitAsync(TimeSpan.FromSeconds(3)); passed++; Console.WriteLine(JsonSerializer.Serialize(new { scenario, passed = true })); }
    catch (Exception error) { failed++; Console.WriteLine(JsonSerializer.Serialize(new { scenario, passed = false, error = error.Message })); }
}

namespace Wangzai.CefBrowserHost {
    internal sealed class ProtocolServer { }
    internal sealed class BrowserHostForm {
        public Func<string, JsonObject, Task<object?>>? Execute { get; init; }
        public void BindProtocol(ProtocolServer protocol) { }
        public Task<object?> ExecuteAsync(string command, JsonObject payload) => Execute?.Invoke(command, payload) ?? Task.FromResult<object?>(new { ok = true });
    }
}
