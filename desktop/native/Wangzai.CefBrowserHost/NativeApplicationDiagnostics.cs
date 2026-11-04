using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Wangzai.CefBrowserHost;

// Application diagnostics share the desktop's bounded stderr log destination.
// There is intentionally no native application log file or secondary fallback.
internal static class NativeApplicationDiagnostics
{
    private static readonly Lazy<NativeDiagnosticWriter> Writer = new(() => new NativeDiagnosticWriter(Console.Error));

    public static void ReportCommandFailure(string command, Exception error)
    {
        try { Writer.Value.TryReport(command, error); }
        catch { /* Diagnostics must never replace the command's own response. */ }
    }

    // Final host shutdown only: complete the queue, then make a bounded attempt
    // to drain it. The caller can exit if stderr is blocked or unavailable.
    public static Task<bool> FlushAsync(TimeSpan timeout)
    {
        return Writer.IsValueCreated ? Writer.Value.FlushAsync(timeout) : Task.FromResult(true);
    }
}

internal sealed class NativeDiagnosticWriter
{
    private static readonly HashSet<string> KnownCommands = new(StringComparer.Ordinal)
    {
        "launch", "shutdown", "health", "state", "activate", "navigate", "back", "forward", "reload",
        "ozon-open-order", "restore", "hide", "inspect", "capture-purchase", "inspect-pinduoduo-order",
        "inspect-1688-order", "set-target", "target-recovery", "get-target", "clear-target", "execute",
        "purchase-auto-order", "purchase-wait-pay-scan", "export-purchase-session-cookies",
        "import-purchase-session-cookies", "approve-download", "cross-border-ping", "cross-border-sync",
        "cross-border-orders", "cross-border-status", "cross-border-login-status", "cross-border-charges-status",
        "cross-border-charges", "ozon-login-status", "ozon-support-status", "follow-seller-verification-status",
        "ozon-support-open", "purchase-login-status", "purchase-login-fixture", "ozon-data-status", "ozon-data-read",
        "ozon-data-catalog", "ozon-data-normalize", "ozon-data-payload", "ozon-data-search", "ozon-data-probe",
        "ozon-data-follow-sellers", "ozon-submit-follow-seller-complaint", "ozon-prepare-follow-seller-scheme2-evidence",
        "ozon-submit-follow-seller-quick-complaint", "ozon-data-paginate", "ozon-data-cancel-pagination",
        "close", "force-close", "bounds", "workbench", "parent", "show-follow-seller-quick-browser",
        "show-follow-seller-verification-browser", "hide-follow-seller-verification-browser", "open-extension-manager"
    };

    // Only reviewed literal codes are printable. Exception.Message can include
    // remote pages, tokens or business data even when it starts with a familiar
    // prefix. Unknown codes still produce type/HResult/source-method evidence.
    private static readonly HashSet<string> KnownFailureCodes = new(StringComparer.Ordinal)
    {
        "PURCHASE_BROWSER_COMMAND_INVALID", "PURCHASE_BROWSER_COMMAND_TIMEOUT", "PURCHASE_BROWSER_CEF_FAILED",
        "PURCHASE_BROWSER_CEF_SESSION_NOT_FOUND", "PURCHASE_BROWSER_CEF_SESSION_CLOSED",
        "PURCHASE_BROWSER_CEF_NAVIGATION_NOT_READY", "PURCHASE_BROWSER_CEF_PROTOCOL_INVALID",
        "PURCHASE_BROWSER_CEF_HOST_ACTION_FAILED", "PURCHASE_BROWSER_CEF_DISCONNECTED",
        "PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY", "PURCHASE_BROWSER_CAPTURE_EMPTY",
        "PURCHASE_BROWSER_NAVIGATION_FORBIDDEN", "PURCHASE_BROWSER_OWNER_REF_INVALID",
        "PURCHASE_BROWSER_STORAGE_REF_INVALID", "PURCHASE_BROWSER_PARENT_WINDOW_INVALID",
        "PURCHASE_BROWSER_EMBED_PARENT_FAILED", "PURCHASE_BROWSER_SESSION_STALE",
        "PURCHASE_BROWSER_1688_ORDER_NOT_FOUND", "PURCHASE_BROWSER_FIXTURE_RECEIPT_TIMEOUT",
        "PURCHASE_BROWSER_REAL_SITE_EXECUTION_DISABLED", "PURCHASE_BROWSER_TASK_CONTEXT_REQUIRED",
        "CROSS_BORDER_API_FAILED", "CROSS_BORDER_REQUEST_TIMEOUT", "CROSS_BORDER_CHARGE_READBACK_FAILED",
        "CROSS_BORDER_CHARGE_CONFIRMATION_REQUIRED", "CROSS_BORDER_CHARGE_LOCAL_MATCH_INCOMPLETE",
        "OZON_DATA_OBSERVER_NOT_READY", "OZON_DATA_PAGINATION_UNAVAILABLE", "OZON_DATA_PAGINATION_NOT_SAFE",
        "OZON_DATA_PAYLOAD_NOT_FOUND", "FOLLOW_SELLER_VERIFICATION_BROWSER_TARGET_INVALID",
        "FOLLOW_SELLER_VERIFICATION_WINDOW_NOT_VISIBLE"
    };

    private readonly BlockingCollection<string> queue;
    private readonly TextWriter output;
    private readonly Task consumer;
    private long pendingDrops;
    private long pendingWriteFailures;
    private long totalDrops;
    private long totalWriteFailures;

    public int Capacity { get; }
    public int QueuedCount => queue.Count;
    public long DroppedCount => Volatile.Read(ref totalDrops);
    public long WriteFailureCount => Volatile.Read(ref totalWriteFailures);

    public NativeDiagnosticWriter(TextWriter output, int capacity = 64)
    {
        ArgumentNullException.ThrowIfNull(output);
        if (capacity < 1 || capacity > 4096) throw new ArgumentOutOfRangeException(nameof(capacity));
        this.output = output;
        Capacity = capacity;
        queue = new BlockingCollection<string>(capacity);
        // Console.Error may be a synchronous writer. Only this background
        // thread can block on it; it cannot starve protocol thread-pool work.
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        consumer = completion.Task;
        var thread = new Thread(() => {
            try { Consume(); }
            catch { Interlocked.Increment(ref pendingWriteFailures); Interlocked.Increment(ref totalWriteFailures); }
            finally { completion.TrySetResult(); }
        }) { IsBackground = true, Name = "Wangzai.NativeDiagnostics" };
        thread.Start();
    }

    public bool TryReport(string command, Exception error)
    {
        string line;
        try { line = Format(command, error); }
        catch { line = "[cef-command-error] command=unknown-command code=DIAGNOSTIC_FORMAT_UNAVAILABLE"; }
        try { if (queue.TryAdd(line)) return true; }
        catch (InvalidOperationException) { /* Final shutdown completed the queue. */ }
        Interlocked.Increment(ref pendingDrops);
        Interlocked.Increment(ref totalDrops);
        return false;
    }

    public async Task<bool> FlushAsync(TimeSpan timeout)
    {
        try
        {
            queue.CompleteAdding();
            await consumer.WaitAsync(timeout).ConfigureAwait(false);
            return Volatile.Read(ref pendingDrops) == 0 && Volatile.Read(ref pendingWriteFailures) == 0;
        }
        catch { return false; }
    }

    private void Consume()
    {
        foreach (string line in queue.GetConsumingEnumerable())
        {
            WriteLossSummary();
            if (!TryWrite(line)) Interlocked.Increment(ref pendingWriteFailures);
        }
        WriteLossSummary();
    }

    private bool TryWrite(string line)
    {
        try { output.WriteLine(line); output.Flush(); return true; }
        catch { Interlocked.Increment(ref totalWriteFailures); return false; }
    }

    private void WriteLossSummary()
    {
        long dropped = Interlocked.Exchange(ref pendingDrops, 0);
        long failures = Interlocked.Exchange(ref pendingWriteFailures, 0);
        if (dropped == 0 && failures == 0) return;
        if (TryWrite($"{DateTimeOffset.UtcNow:O} [cef-command-error-summary] dropped={dropped} stderrWriteFailures={failures}")) return;
        Interlocked.Add(ref pendingDrops, dropped);
        Interlocked.Add(ref pendingWriteFailures, failures + 1);
    }

    internal static string Format(string command, Exception error)
    {
        Exception actual = error is AggregateException aggregate ? aggregate.GetBaseException() : error;
        string safeCommand = command is { Length: <= 80 } && KnownCommands.Contains(command) ? command : "unknown-command";
        string message = actual.Message;
        string code = message.Length <= 128 && KnownFailureCodes.Contains(message) ? message : "UNCLASSIFIED_NATIVE_ERROR";
        string errorType = SourceIdentifier(actual.GetType().Name);
        var method = actual.TargetSite;
        string sourceMethod = method == null ? "unavailable"
            : SourceIdentifier(method.DeclaringType?.Name) + "." + SourceIdentifier(method.Name);
        string numericCode = unchecked((uint)actual.HResult).ToString("X8", CultureInfo.InvariantCulture);
        return $"{DateTimeOffset.UtcNow:O} [cef-command-error] command={safeCommand} code={code} type={errorType} hresult=0x{numericCode} site={sourceMethod}";
    }

    private static string SourceIdentifier(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 64) return "unknown";
        foreach (char character in value)
            if (!(char.IsAsciiLetterOrDigit(character) || character is '_' or '.' or '<' or '>' or '`')) return "unknown";
        return value;
    }
}
