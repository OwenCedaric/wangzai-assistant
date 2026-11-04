using CefSharp;
using CefSharp.WinForms;
using System.IO.Pipes;
using System.Text;

namespace Wangzai.CefBrowserHost;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        // Keep the standalone purchase browser as a separate taskbar group so
        // it can always be restored after minimizing the main desktop app.
        _ = NativeMethods.SetCurrentProcessExplicitAppUserModelID("com.wangzai.assistant.purchase-browser");

        var subprocessExitCode = CefSharp.BrowserSubprocess.SelfHost.Main(args);
        if (subprocessExitCode >= 0) return subprocessExitCode;

        var pipeName = args
            .FirstOrDefault(value => value.StartsWith("--wangzai-ipc-pipe=", StringComparison.Ordinal))?
            .Split('=', 2)[1];
        if (string.IsNullOrWhiteSpace(pipeName)) return 21;
        var rootCachePath = args
            .FirstOrDefault(value => value.StartsWith("--wangzai-root-cache=", StringComparison.Ordinal))?
            .Split('=', 2)[1];
        if (string.IsNullOrWhiteSpace(rootCachePath)) return 22;
        rootCachePath = Path.GetFullPath(rootCachePath);
        Directory.CreateDirectory(rootCachePath);
        var extensionsRoot = args
            .FirstOrDefault(value => value.StartsWith("--wangzai-extensions-root=", StringComparison.Ordinal))?
            .Split('=', 2)[1];
        extensionsRoot = string.IsNullOrWhiteSpace(extensionsRoot)
            ? Path.Combine(Path.GetDirectoryName(rootCachePath)!, "extensions")
            : Path.GetFullPath(extensionsRoot);
        var builtInExtensionDirectories = args
            .Where(value => value.StartsWith("--wangzai-built-in-extension=", StringComparison.Ordinal))
            .Select(value => value.Split('=', 2)[1])
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(Path.GetFullPath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        pipe.Connect(15_000);
        using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 64 * 1024, leaveOpen: true);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 64 * 1024, leaveOpen: true)
        {
            AutoFlush = true,
            NewLine = "\n",
        };
        ProtocolWriter.SetWriter(writer);

        BrowserExtensionPackageManager extensionManager;
        try { extensionManager = new BrowserExtensionPackageManager(extensionsRoot); }
        catch (Exception error)
        {
            // A corrupt/locked registry must not produce an unhandled native
            // dialog before the desktop can receive its real failure reason.
            NativeApplicationDiagnostics.ReportCommandFailure("open-extension-manager", error);
            ProtocolWriter.WriteFault(ErrorCode.From(error));
            _ = NativeApplicationDiagnostics.FlushAsync(TimeSpan.FromMilliseconds(250)).GetAwaiter().GetResult();
            return 23;
        }

        try
        {
            foreach (var directory in builtInExtensionDirectories)
            {
                extensionManager.InstallDirectory(directory, forceEnabled: true);
            }
        }
        catch
        {
            ProtocolWriter.WriteFault("PURCHASE_BROWSER_BUILTIN_EXTENSION_INVALID");
            return 23;
        }

        var executable = Environment.ProcessPath
            ?? throw new InvalidOperationException("PURCHASE_BROWSER_CEF_EXECUTABLE_UNAVAILABLE");
        var runtimeRoot = AppContext.BaseDirectory;
        var browserSubprocess = Path.Combine(runtimeRoot, "CefSharp.BrowserSubprocess.exe");
        var settings = new CefSettings
        {
            BrowserSubprocessPath = File.Exists(browserSubprocess) ? browserSubprocess : executable,
            RootCachePath = rootCachePath,
            CachePath = Path.Combine(rootCachePath, "_global"),
            WindowlessRenderingEnabled = false,
            PersistSessionCookies = true,
            Locale = "zh-CN",
			UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        };
        NativeCefLogPolicy.Apply(settings);
        settings.CefCommandLineArgs["use-angle"] = "d3d11";
        settings.CefCommandLineArgs["use-gl"] = "angle";
        settings.CefCommandLineArgs["disable-component-update"] = "1";
        settings.CefCommandLineArgs["disable-default-apps"] = "1";
        settings.CefCommandLineArgs["disable-features"] = "OptimizationGuideOnDeviceModel,MediaRouter,Translate";
        settings.CefCommandLineArgs["disable-sync"] = "1";
        settings.CefCommandLineArgs["no-first-run"] = "1";
        settings.CefCommandLineArgs["no-default-browser-check"] = "1";
        var enabledExtensions = extensionManager.EnabledDirectories();
        if (enabledExtensions.Length > 0)
        {
            settings.CefCommandLineArgs["enable-extensions"] = "1";
            settings.CefCommandLineArgs["load-extension"] = string.Join(',', enabledExtensions);
        }

		// Follow CEF's recommended shutdown sequence so browser/renderer/GPU
		// subprocesses finish before the native host exits. This prevents the
		// next launch from inheriting a half-flushed profile or stale locks.
		Cef.EnableWaitForBrowsersToClose();
		if (!Cef.Initialize(settings, performDependencyCheck: true, browserProcessHandler: null))
        {
            ProtocolWriter.WriteFault("PURCHASE_BROWSER_CEF_INITIALIZE_FAILED");
            return 20;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using var form = new BrowserHostForm(extensionManager);
        using var pinduoduoForm = new BrowserHostForm(extensionManager);
        _ = form.Handle;
        _ = pinduoduoForm.Handle;
        var coordinator = new BrowserHostCoordinator(form, pinduoduoForm);
        using var server = new ProtocolServer(coordinator, reader);
        coordinator.BindProtocol(server);
        server.Start();
		Application.Run(form);
		server.Stop();
		Cef.WaitForBrowsersToClose();
		Cef.Shutdown();
        _ = NativeApplicationDiagnostics.FlushAsync(TimeSpan.FromMilliseconds(250)).GetAwaiter().GetResult();
        return 0;
    }

}
