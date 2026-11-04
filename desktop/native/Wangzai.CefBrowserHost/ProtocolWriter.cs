using System.IO;
using System.Text.Json;

namespace Wangzai.CefBrowserHost;

internal static class ProtocolWriter
{
	private static readonly object Gate = new object();

	private static TextWriter output = TextWriter.Null;

	public static void SetWriter(TextWriter writer)
	{
		lock (Gate)
		{
			output = writer;
		}
	}

	public static void Write(object value)
	{
		string value2 = JsonSerializer.Serialize(value, JsonDefaults.Options);
		lock (Gate)
		{
			output.WriteLine(value2);
			output.Flush();
		}
	}

	public static bool TryWrite(object value)
	{
		try
		{
			Write(value);
			return true;
		}
		catch (IOException)
		{
			return false;
		}
		catch (ObjectDisposedException)
		{
			return false;
		}
	}

	public static void WriteFault(string code)
	{
		Write(new
		{
			type = "fault",
			error = new { code }
		});
	}
}
