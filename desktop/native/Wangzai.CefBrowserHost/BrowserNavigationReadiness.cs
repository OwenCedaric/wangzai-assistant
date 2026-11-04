using System;
using System.Threading.Tasks;

namespace Wangzai.CefBrowserHost;

// CEF creates the browser and finishes its constructor-supplied navigation
// asynchronously. A later LoadUrl must not race that initial navigation.
internal sealed class BrowserNavigationReadiness
{
    private readonly object gate = new();
    private readonly TaskCompletionSource ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool initialized;
    private bool initialLoadCompleted;
    private bool closed;

    public void MarkInitialized()
    {
        lock (gate)
        {
            if (closed) return;
            initialized = true;
            if (initialLoadCompleted) ready.TrySetResult();
        }
    }

    public void MarkInitialLoadCompleted()
    {
        lock (gate)
        {
            if (closed) return;
            initialLoadCompleted = true;
            if (initialized) ready.TrySetResult();
        }
    }

    public async Task ExecuteAsync(Action commitNavigation, TimeSpan timeout)
    {
        try
        {
            await ready.Task.WaitAsync(timeout).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            throw new InvalidOperationException("PURCHASE_BROWSER_CEF_NAVIGATION_NOT_READY");
        }
        catch (OperationCanceledException)
        {
            throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_CLOSED");
        }
        lock (gate)
        {
            if (closed) throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_CLOSED");
            // This short synchronous submission and Close share one admission
            // gate: an async waiter can never issue a late LoadUrl after close.
            commitNavigation();
        }
    }

    public void Close()
    {
        lock (gate)
        {
            closed = true;
            ready.TrySetCanceled();
        }
    }
}
