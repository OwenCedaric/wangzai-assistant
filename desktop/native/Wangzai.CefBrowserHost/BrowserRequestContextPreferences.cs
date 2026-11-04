using System.Security.Cryptography;
using System.Text;
using CefSharp;
using CefSharp.Handler;

namespace Wangzai.CefBrowserHost;

// RequestContext preferences are not writable until CEF initializes its
// underlying BrowserContext. The first network-capable browser is admitted
// only after this callback and a verified preference write, off the Forms UI.
internal sealed class BrowserRequestContextPreferences : RequestContextHandler
{
    private readonly TaskCompletionSource<IRequestContext> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource initializationFinished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object initializationGate = new();
    private bool initializationStarted;
    private readonly BrowserProfile initialProfile;
    private string appliedFingerprint = string.Empty;
    private volatile bool closed;
    public bool IsClosed => closed;

    public BrowserRequestContextPreferences(BrowserProfile profile) { initialProfile = profile; }

    protected override void OnRequestContextInitialized(IRequestContext requestContext)
    {
        lock (initializationGate)
        {
            if (closed) return;
            initializationStarted = true;
        }
        try
        {
            Apply(requestContext, initialProfile);
            ready.TrySetResult(requestContext);
        }
        catch (Exception error) { ready.TrySetException(error); }
        finally { initializationFinished.TrySetResult(); }
    }

    public async Task EnsureAppliedAsync(BrowserProfile profile, CancellationToken cancellation = default)
    {
        IRequestContext context;
        try { context = await ready.Task.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false); }
        catch (TimeoutException)
        {
            Close();
            await initializationFinished.Task.ConfigureAwait(false);
            throw new InvalidOperationException("PURCHASE_BROWSER_CONTEXT_INITIALIZE_TIMEOUT");
        }
        cancellation.ThrowIfCancellationRequested();
        if (closed) throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_CLOSED");
        // Reused storageRefs retain the original account-level update behavior,
        // but unchanged settings do not incur redundant preference writes.
        // Once submitted, cancellation is not an exit receipt for this CEF
        // work item. Drain it before a caller may dispose the shared context.
        await Cef.UIThreadTaskFactory.StartNew(() => { cancellation.ThrowIfCancellationRequested(); Apply(context, profile); }).ConfigureAwait(false);
        cancellation.ThrowIfCancellationRequested();
    }

    private void Apply(IRequestContext context, BrowserProfile profile)
    {
        if (closed) throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_CLOSED");
        string fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            profile.CefAcceptLanguageList + "\0" + profile.WebRtcPolicy + "\0" + profile.Proxy.ToJsonString())));
        if (fingerprint == appliedFingerprint) return;
        Dictionary<string, object> proxy = ProxyPreferences(profile);
        if (!context.SetPreference("proxy", proxy, out _))
            throw new InvalidOperationException("PURCHASE_BROWSER_PROXY_CONFIGURATION_FAILED");
        var actual = context.GetPreference("proxy") as IDictionary<string, object>;
        if (actual == null || proxy.Any(pair => !actual.TryGetValue(pair.Key, out object? value)
            || !string.Equals(Convert.ToString(value), Convert.ToString(pair.Value), StringComparison.Ordinal)))
            throw new InvalidOperationException("PURCHASE_BROWSER_PROXY_READBACK_FAILED");
        // AcceptLanguageList is also set in RequestContextSettings. Keep the
        // existing runtime preferences, and don't silently accept a failed one.
        if (!context.SetPreference("intl.accept_languages", profile.CefAcceptLanguageList, out _)
            || !context.SetPreference("webrtc.ip_handling_policy", profile.WebRtcPolicy, out _))
            throw new InvalidOperationException("PURCHASE_BROWSER_CONTEXT_PREFERENCES_FAILED");
        appliedFingerprint = fingerprint;
    }

    internal static Dictionary<string, object> ProxyPreferences(BrowserProfile profile)
    {
        string mode = BrowserProfile.Text(profile.Proxy, "mode", "direct", 40);
        if (mode == "fixed_servers")
        {
            string server = BrowserProfile.Text(profile.Proxy, "rules", string.Empty, 500);
            if (server.Length == 0) throw new InvalidOperationException("PURCHASE_BROWSER_PROXY_RULES_REQUIRED");
            return new() { ["mode"] = mode, ["server"] = server,
                ["bypass_list"] = BrowserProfile.Text(profile.Proxy, "bypassRules", "<-loopback>", 500) };
        }
        if (mode is not ("direct" or "system")) throw new InvalidOperationException("PURCHASE_BROWSER_PROXY_MODE_INVALID");
        return new() { ["mode"] = mode };
    }

    public void Close()
    {
        lock (initializationGate)
        {
            closed = true;
            if (!initializationStarted) initializationFinished.TrySetResult();
        }
        ready.TrySetException(new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_CLOSED"));
        // A context can be retired before anyone waits on its initialization.
        _ = ready.Task.Exception;
    }
}
