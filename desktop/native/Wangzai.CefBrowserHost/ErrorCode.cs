using System;

namespace Wangzai.CefBrowserHost;

internal static class ErrorCode
{
	private static readonly string[] ExpectedObserverMisses =
	{
		"OZON_DATA_OBSERVER_NOT_READY",
		"OZON_DATA_PAGINATION_UNAVAILABLE",
		"OZON_DATA_PAGINATION_NOT_SAFE",
		"OZON_DATA_PAYLOAD_NOT_FOUND"
	};

	public static string From(Exception error)
	{
		string text = ((error is AggregateException ex) ? ex.GetBaseException().Message : error.Message);
		if (text.StartsWith("PURCHASE_BROWSER_", StringComparison.Ordinal)
			|| text.StartsWith("PURCHASE_WAIT_PAY_", StringComparison.Ordinal)
			|| text.StartsWith("CROSS_BORDER_", StringComparison.Ordinal)
			|| text.StartsWith("OZON_DATA_", StringComparison.Ordinal)
			|| text.StartsWith("FOLLOW_SELLER_", StringComparison.Ordinal))
		{
			return text;
		}
		return "PURCHASE_BROWSER_CEF_FAILED";
	}

	public static bool IsExpectedObserverMiss(Exception error)
	{
		string code = From(error);
		foreach (string expected in ExpectedObserverMisses)
		{
			if (string.Equals(code, expected, StringComparison.Ordinal)) return true;
		}
		return false;
	}
}
