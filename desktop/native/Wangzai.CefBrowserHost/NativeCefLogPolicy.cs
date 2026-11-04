using CefSharp;
using CefSharp.WinForms;

namespace Wangzai.CefBrowserHost;

internal static class NativeCefLogPolicy
{
    public static void Apply(CefSettings settings)
    {
        // Chrome's stderr-only destination avoids a second unbounded file.
        // The desktop owner drains it through the bounded diagnostic relay.
        // Keep ERROR/FATAL diagnostics; never truncate a live CEF log file.
        settings.LogSeverity = LogSeverity.Error;
        settings.CefCommandLineArgs["enable-logging"] = "stderr";
    }
}
