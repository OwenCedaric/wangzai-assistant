namespace Wangzai.CefBrowserHost;

internal static class PurchaseCaptureNumberScript
{
    public static readonly string Value = ReadScript();

    private static string ReadScript()
    {
        using Stream stream = typeof(PurchaseCaptureNumberScript).Assembly.GetManifestResourceStream(
            "Wangzai.PurchaseCaptureNumber.js")
            ?? throw new InvalidOperationException("PURCHASE_CAPTURE_NUMBER_SCRIPT_MISSING");
        using StreamReader reader = new(stream);
        // The shared module exports only pure functions. CEF evaluates them
        // inside the existing capture IIFE, not in the page's global namespace.
        return reader.ReadToEnd().Replace("export function ", "function ", StringComparison.Ordinal) + "\n";
    }
}
