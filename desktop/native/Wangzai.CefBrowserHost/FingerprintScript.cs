using System;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Wangzai.CefBrowserHost;

internal static class FingerprintScript
{
	public static string Build(BrowserProfile profile)
	{
		string userAgentJson = JsonSerializer.Serialize(profile.UserAgent);
		string localeJson = JsonSerializer.Serialize(profile.Locale);
		string languagesJson = JsonSerializer.Serialize(profile.AcceptLanguage.Split(',')
			.Select(text => text.Split(';')[0].Trim())
			.Where(text => text.Length > 0)
			.ToArray());
		string timezoneJson = JsonSerializer.Serialize(profile.Timezone);
		uint seed = BitConverter.ToUInt32(
			SHA256.HashData(Encoding.UTF8.GetBytes(profile.FingerprintSeed)),
			0);
		int cores = (int)(4 + seed % 5);
		int memory = new[] { 4, 8, 16 }[seed % 3];
		int viewportWidth = profile.ViewportWidth;
		int viewportHeight = profile.ViewportHeight;
		string deviceScaleFactor = profile.DeviceScaleFactor.ToString(CultureInfo.InvariantCulture);
		int majorVersion = ChromeMajor(profile.UserAgent);
		string brands = JsonSerializer.Serialize(new object[]
		{
			new { brand = "Not=A?Brand", version = "99" },
			new { brand = "Google Chrome", version = majorVersion.ToString(CultureInfo.InvariantCulture) },
			new { brand = "Chromium", version = majorVersion.ToString(CultureInfo.InvariantCulture) }
		});
		(string webglVendor, string webglRenderer) = WebGlProfile(seed);
		string vendorJson = JsonSerializer.Serialize(webglVendor);
		string rendererJson = JsonSerializer.Serialize(webglRenderer);
		return $"(() => {{\n  if (globalThis.__wangzaiCefFingerprintV2) return;\n  Object.defineProperty(globalThis, '__wangzaiCefFingerprintV2', {{ value: true }});\n  const define = (target, name, value) => {{\n    try {{ Object.defineProperty(target, name, {{ configurable: true, get: () => value }}); }} catch {{}}\n  }};\n  define(Navigator.prototype, 'userAgent', {userAgentJson});\n  define(Navigator.prototype, 'appVersion', {userAgentJson}.replace(/^Mozilla\\//, ''));\n  define(Navigator.prototype, 'language', {localeJson});\n  define(Navigator.prototype, 'languages', Object.freeze({languagesJson}));\n  define(Navigator.prototype, 'hardwareConcurrency', {cores});\n  define(Navigator.prototype, 'deviceMemory', {memory});\n  define(Navigator.prototype, 'platform', 'Win32');\n  define(Navigator.prototype, 'webdriver', undefined);\n  const brands = Object.freeze({brands}.map(entry => Object.freeze(entry)));\n  const uaData = Object.freeze({{\n    brands, mobile: false, platform: 'Windows',\n    getHighEntropyValues: async hints => {{\n      const values = {{ architecture: 'x86', bitness: '64', mobile: false, model: '', platform: 'Windows', platformVersion: '15.0.0', uaFullVersion: '{majorVersion}.0.0.0', fullVersionList: brands }};\n      return Object.fromEntries(['brands','mobile','platform',...(Array.isArray(hints) ? hints : [])].filter(key => key in values || key in uaData).map(key => [key, values[key] ?? uaData[key]]));\n    }},\n    toJSON: () => ({{ brands, mobile: false, platform: 'Windows' }})\n  }});\n  define(Navigator.prototype, 'userAgentData', uaData);\n  define(Screen.prototype, 'width', {viewportWidth});\n  define(Screen.prototype, 'height', {viewportHeight});\n  define(Screen.prototype, 'availWidth', {viewportWidth});\n  define(Screen.prototype, 'availHeight', {Math.Max(600, viewportHeight - 40)});\n  define(globalThis, 'devicePixelRatio', {deviceScaleFactor});\n  const configuredTimeZone = {timezoneJson};\n  const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;\n  Intl.DateTimeFormat.prototype.resolvedOptions = function() {{\n    const result = realResolved.call(this);\n    try {{ Object.defineProperty(result, 'timeZone', {{ value: configuredTimeZone, enumerable: true }}); }} catch {{}}\n    return result;\n  }};\n  const realTimezoneOffset = Date.prototype.getTimezoneOffset;\n  Date.prototype.getTimezoneOffset = function() {{\n    try {{\n      const parts = new Intl.DateTimeFormat('en-US', {{ timeZone: configuredTimeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }}).formatToParts(this);\n      const part = name => Number(parts.find(entry => entry.type === name)?.value);\n      let hour = part('hour'); if (hour === 24) hour = 0;\n      const represented = Date.UTC(part('year'), part('month') - 1, part('day'), hour, part('minute'), part('second'));\n      return Math.round((this.getTime() - represented) / 60000);\n    }} catch {{ return realTimezoneOffset.call(this); }}\n  }};\n  const patchWebGl = prototype => {{\n    if (!prototype?.getParameter) return;\n    const real = prototype.getParameter;\n    prototype.getParameter = function(parameter) {{\n      if (parameter === 37445) return {vendorJson};\n      if (parameter === 37446) return {rendererJson};\n      return real.call(this, parameter);\n    }};\n  }};\n  patchWebGl(globalThis.WebGLRenderingContext?.prototype);\n  patchWebGl(globalThis.WebGL2RenderingContext?.prototype);\n  const canvasSeed = {seed % 13 + 1};\n  const realToDataURL = HTMLCanvasElement.prototype.toDataURL;\n  HTMLCanvasElement.prototype.toDataURL = function(...args) {{\n    let context; let original;\n    try {{ context = this.getContext('2d'); if (context && this.width && this.height) {{ original = context.getImageData(0, 0, 1, 1); const pixel = new ImageData(new Uint8ClampedArray(original.data), 1, 1); pixel.data[0] = (pixel.data[0] + canvasSeed) & 255; context.putImageData(pixel, 0, 0); }} }} catch {{}}\n    try {{ return realToDataURL.apply(this, args); }} finally {{ try {{ if (context && original) context.putImageData(original, 0, 0); }} catch {{}} }}\n  }};\n}})();";
	}

	private static int ChromeMajor(string userAgent)
	{
		const string marker = "Chrome/";
		int start = userAgent.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
		if (start < 0) return 150;
		start += marker.Length;
		int end = userAgent.IndexOf('.', start);
		return int.TryParse(userAgent[start..(end > start ? end : userAgent.Length)], out int value)
			? value
			: 151;
	}

	private static (string Vendor, string Renderer) WebGlProfile(uint seed)
	{
		return (seed % 3) switch
		{
			0 => ("Google Inc. (Intel)", "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)"),
			1 => ("Google Inc. (NVIDIA)", "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)"),
			_ => ("Google Inc. (AMD)", "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)")
		};
	}
}
