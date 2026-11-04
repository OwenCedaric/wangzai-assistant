using System.Threading;

namespace Wangzai.CefBrowserHost;

// Immutable snapshots keep the CEF UI callback and IPC reader consistent.
// Only enum names and numeric exit codes are retained; CEF's free-form error
// message can contain page details and must not enter diagnostics.
internal sealed record BrowserRendererHealthSnapshot(
    bool Crashed,
    string TerminationStatus,
    int ExitCode);

internal sealed class BrowserRendererHealth
{
    private static readonly BrowserRendererHealthSnapshot Healthy = new(false, string.Empty, 0);
    private BrowserRendererHealthSnapshot current = Healthy;

    public BrowserRendererHealthSnapshot Snapshot => Volatile.Read(ref current);

    public void MarkTerminated(string terminationStatus, int exitCode)
    {
        Interlocked.Exchange(ref current, new BrowserRendererHealthSnapshot(true, terminationStatus, exitCode));
    }

    public bool MarkReady()
    {
        return Interlocked.Exchange(ref current, Healthy).Crashed;
    }
}
