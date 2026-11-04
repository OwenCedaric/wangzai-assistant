using System;

namespace Wangzai.CefBrowserHost;

internal static class BrowserUrlPolicy
{
	private static readonly string[] PinduoduoAppLaunchHosts =
	{
		"a11.app.qq.com",
		"sj.qq.com"
	};

	public static bool IsWebUrl(string? value)
	{
		return Uri.TryCreate(value, UriKind.Absolute, out var result)
			&& (result.Scheme == Uri.UriSchemeHttp || result.Scheme == Uri.UriSchemeHttps)
			&& string.IsNullOrEmpty(result.UserInfo)
			&& !string.IsNullOrWhiteSpace(result.Host);
	}

	public static bool IsAllowed(string? value, BrowserExtensionPackageManager? extensions = null)
	{
		if (string.Equals(value, "about:blank", StringComparison.OrdinalIgnoreCase))
		{
			return true;
		}
		if (IsWebUrl(value))
		{
			return true;
		}
		if (Uri.TryCreate(value, UriKind.Absolute, out var extensionUrl)
			&& string.Equals(extensionUrl.Scheme, "chrome-extension", StringComparison.OrdinalIgnoreCase)
			&& string.IsNullOrEmpty(extensionUrl.UserInfo)
			&& extensions?.IsEnabledExtensionId(extensionUrl.Host) == true)
		{
			return true;
		}
		return false;
	}

	public static bool IsAllowedInteractiveNavigation(string? value, BrowserExtensionPackageManager? extensions = null)
	{
		return IsAllowed(value, extensions) && !IsPinduoduoAppInstallRedirect(value);
	}

	public static string NormalizePinduoduoTopLevelUrl(string? value)
	{
		string original = value?.Trim() ?? string.Empty;
		if (!Uri.TryCreate(original, UriKind.Absolute, out Uri? uri)
			|| (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
		{
			return original;
		}

		string host = uri.Host.ToLowerInvariant();
		bool baseBuyerHost = host is "yangkeduo.com" or "www.yangkeduo.com"
			or "pinduoduo.com" or "www.pinduoduo.com";
		bool mobileBuyerHost = host.Equals("mobile.yangkeduo.com", StringComparison.Ordinal);
		if (!baseBuyerHost && !mobileBuyerHost) return original;

		UriBuilder normalized = new(uri)
		{
			Scheme = Uri.UriSchemeHttps,
			Port = -1,
			Host = "mobile.yangkeduo.com"
		};
		return normalized.Uri.AbsoluteUri;
	}

	public static bool IsPinduoduoAppInstallRedirect(string? value)
	{
		if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
			|| (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
		{
			return false;
		}

		if (PinduoduoAppLaunchHosts.Any(host => uri.Host.Equals(host, StringComparison.OrdinalIgnoreCase)))
		{
			return true;
		}

		if (!uri.Host.Equals("mobile.yangkeduo.com", StringComparison.OrdinalIgnoreCase)
			&& !uri.Host.EndsWith(".yangkeduo.com", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		string path = uri.AbsolutePath.TrimEnd('/').ToLowerInvariant();
		if (path is "/down_download.html" or "/undefined.html")
		{
			return true;
		}

		string query = uri.Query.ToLowerInvariant();
		return query.Contains("add_download_task=1", StringComparison.Ordinal)
			|| query.Contains("android_browser_download=1", StringComparison.Ordinal)
			|| query.Contains("campaign=goods_download", StringComparison.Ordinal)
			|| query.Contains("is_market_download=1", StringComparison.Ordinal);
	}
}
