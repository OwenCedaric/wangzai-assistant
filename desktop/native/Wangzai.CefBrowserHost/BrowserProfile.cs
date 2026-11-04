using System.Text.Json.Nodes;

namespace Wangzai.CefBrowserHost;

internal sealed record BrowserProfile(
    string OwnerRef,
    string StorageRef,
    string BrowserRole,
    bool Background,
    string ProfileDirectory,
    string DownloadsDirectory,
    string UserAgent,
    string AcceptLanguage,
    string Locale,
    string Timezone,
    string FingerprintSeed,
    string PlatformKey,
    int ViewportWidth,
    int ViewportHeight,
    double DeviceScaleFactor,
    string WebRtcPolicy,
    JsonObject Proxy)
{
	public string CefAcceptLanguageList => string.Join(",", AcceptLanguage
		.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
		.Select(value => value.Split(';', 2)[0].Trim())
		.Where(value => value.Length > 0)
		.Distinct(StringComparer.OrdinalIgnoreCase));

    public static BrowserProfile From(JsonObject payload)
    {
        var profile = payload["profile"] as JsonObject ?? payload;
        var ownerRef = Required(profile, "ownerRef", 64);
        if (ownerRef.Length != 40 || ownerRef.Any(c => !Uri.IsHexDigit(c)))
            throw new InvalidOperationException("PURCHASE_BROWSER_OWNER_REF_INVALID");
        var storageRef = Text(profile, "storageRef", ownerRef, 64);
        if (storageRef.Length != 40 || storageRef.Any(c => !Uri.IsHexDigit(c)))
            throw new InvalidOperationException("PURCHASE_BROWSER_STORAGE_REF_INVALID");
        var browserRole = Text(profile, "browserRole", "interactive", 80);
        var background = Boolean(profile, "background")
            || browserRole is "market-collector" or "follow-seller-collector" or "product-link-parser";
		var platformKey = Text(profile, "platformKey", "unknown", 80);
		var webRtcPolicy = NormalizeWebRtcPolicy(profile);
		if (platformKey.Equals("pinduoduo", StringComparison.OrdinalIgnoreCase))
		{
			webRtcPolicy = "disable_non_proxied_udp";
		}
        return new BrowserProfile(
            ownerRef,
            storageRef,
            browserRole,
            background,
            Required(payload, "profileDirectory", 1200),
            Required(payload, "downloadsDirectory", 1200),
            Text(profile, "userAgent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36", 600),
            Text(profile, "acceptLanguage", "zh-CN,zh;q=0.9,en;q=0.6", 300),
            Text(profile, "locale", "zh-CN", 80),
            Text(profile, "timezone", "Asia/Shanghai", 100),
            Text(profile["fingerprint"] as JsonObject, "seed", ownerRef, 200),
            platformKey,
            Integer(profile["viewport"] as JsonObject, "width", 1366, 960, 2560),
            Integer(profile["viewport"] as JsonObject, "height", 768, 600, 1600),
            Number(profile, "deviceScaleFactor", 1, 0.75, 2),
            webRtcPolicy,
            profile["proxy"] as JsonObject ?? new JsonObject { ["mode"] = "direct" });
    }

	private static string NormalizeWebRtcPolicy(JsonObject profile)
	{
		string value = Text(profile, "webrtcPolicy", "default", 80);
		return value is "default" or "default_public_interface_only" or "disable_non_proxied_udp"
			? value
			: "default";
	}

    public static string Required(JsonObject? source, string name, int maximum)
    {
        var value = Text(source, name, string.Empty, maximum);
        if (string.IsNullOrWhiteSpace(value))
            throw new InvalidOperationException($"PURCHASE_BROWSER_{name.ToUpperInvariant()}_REQUIRED");
        return value;
    }

    public static string Text(JsonObject? source, string name, string fallback, int maximum)
    {
        string? value = null;
        try { value = source?[name]?.GetValue<string>(); } catch { }
        value = value?.Trim();
        return string.IsNullOrWhiteSpace(value) ? fallback : value[..Math.Min(value.Length, maximum)];
    }

    private static int Integer(JsonObject? source, string name, int fallback, int minimum, int maximum)
    {
        try { return Math.Clamp(source?[name]?.GetValue<int>() ?? fallback, minimum, maximum); }
        catch { return fallback; }
    }

    private static double Number(JsonObject? source, string name, double fallback, double minimum, double maximum)
    {
        try { return Math.Clamp(source?[name]?.GetValue<double>() ?? fallback, minimum, maximum); }
        catch { return fallback; }
    }

    private static bool Boolean(JsonObject? source, string name)
    {
        try { return source?[name]?.GetValue<bool>() == true; }
        catch { return false; }
    }
}
