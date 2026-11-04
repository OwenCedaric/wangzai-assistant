using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using CefSharp;

namespace Wangzai.CefBrowserHost;

internal sealed class ProtocolServer : IDisposable
{
	private readonly BrowserHostCoordinator coordinator;

	private readonly TextReader input;
	private readonly Action<string, Exception> reportCommandError;

	private readonly CancellationTokenSource stop = new CancellationTokenSource();

	private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonNode?>> hostActionResponses = new();

	private readonly ConcurrentDictionary<string, SemaphoreSlim> ownerCommandGates = new();

	// Window placement and cached-state reads never touch page content, so they get
	// their own per-owner lane. Sharing the page lane let a long capture/auto-order
	// script (up to 55s) hold back bounds/health past the desktop's short timeouts,
	// which the desktop then treats as a hung browser and force-terminates.
	private static readonly HashSet<string> PresentationCommands = new(StringComparer.Ordinal)
	{
		"bounds", "workbench", "parent", "hide", "restore", "health", "state"
	};

	private readonly ConcurrentDictionary<string, SemaphoreSlim> ownerPresentationGates = new();

	private Task? reader;

	public ProtocolServer(BrowserHostCoordinator coordinator, TextReader input,
		Action<string, Exception>? reportCommandError = null)
	{
		this.coordinator = coordinator;
		this.input = input;
		this.reportCommandError = reportCommandError ?? NativeApplicationDiagnostics.ReportCommandFailure;
	}

	public void Start()
	{
		reader = Task.Run(ReadLoopAsync);
		ProtocolWriter.Write(new
		{
			type = "ready",
			engine = "cef",
			runtimeVersion = Cef.CefSharpVersion,
			chromiumVersion = Cef.ChromiumVersion
		});
	}

	public void Stop()
	{
		stop.Cancel();
		FailHostActions();
	}

	public async Task<JsonNode?> RequestHostActionAsync(string ownerRef, string action, object? payload = null)
	{
		if (stop.IsCancellationRequested)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CEF_DISCONNECTED");
		}
		string id = $"cef_host_action_{Guid.NewGuid():N}";
		TaskCompletionSource<JsonNode?> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
		hostActionResponses[id] = completion;
		// A cold commodity page may spend up to 12 seconds waiting for the main
		// frame and then another 20 seconds evaluating the structured capture.
		// Leave enough room for the controller's single transient-context retry.
		using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
		timeout.CancelAfter(TimeSpan.FromSeconds(55.0));
		using (timeout.Token.Register(delegate
		{
			completion.TrySetException(new InvalidOperationException(stop.IsCancellationRequested
				? "PURCHASE_BROWSER_CEF_DISCONNECTED"
				: "PURCHASE_BROWSER_COMMAND_TIMEOUT"));
		}))
		{
			try
			{
				if (!ProtocolWriter.TryWrite(new
				{
					type = "host-action",
					id,
					ownerRef,
					action,
					payload
				}))
				{
					completion.TrySetException(new InvalidOperationException("PURCHASE_BROWSER_CEF_DISCONNECTED"));
				}
				return await completion.Task.ConfigureAwait(continueOnCapturedContext: false);
			}
			finally
			{
				hostActionResponses.TryRemove(id, out _);
			}
		}
	}

	private async Task ReadLoopAsync()
	{
		try
		{
			while (!stop.IsCancellationRequested)
			{
				string? text = await input.ReadLineAsync(stop.Token).ConfigureAwait(false);
				if (text == null) break;
				if (string.IsNullOrWhiteSpace(text)) continue;
				try
				{
					JsonObject? message = JsonNode.Parse(text) as JsonObject;
					if (message == null) throw new InvalidOperationException("PURCHASE_BROWSER_CEF_PROTOCOL_INVALID");
					if (string.Equals(message["type"]?.GetValue<string>(), "host-action-result", StringComparison.Ordinal))
					{
						string key = message["id"]?.GetValue<string>() ?? string.Empty;
						if (hostActionResponses.TryGetValue(key, out var value))
						{
							if (message["ok"]?.GetValue<bool>() ?? false)
							{
								value.TrySetResult(message["data"]?.DeepClone());
							}
							else
							{
								value.TrySetException(new InvalidOperationException(message["error"]?["code"]?.GetValue<string>() ?? "PURCHASE_BROWSER_CEF_HOST_ACTION_FAILED"));
							}
						}
					}
					else
					{
						_ = Task.Run(() => DispatchAsync(message));
					}
				}
				catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidOperationException or FormatException)
				{
					ProtocolWriter.TryWrite(new { type = "fault", error = new { code = "PURCHASE_BROWSER_CEF_PROTOCOL_INVALID" } });
				}
			}
		}
		catch (Exception ex) when (ex is IOException or ObjectDisposedException or OperationCanceledException)
		{
			// Broken and cancelled pipes are terminal connections, just like EOF.
		}
		finally
		{
			stop.Cancel();
			FailHostActions();
			try
			{
				await coordinator.ExecuteAsync("shutdown", new JsonObject()).ConfigureAwait(false);
			}
			catch
			{
				// The main form may already be disposed during explicit shutdown.
			}
		}
	}

	private void FailHostActions()
	{
		foreach (TaskCompletionSource<JsonNode?> completion in hostActionResponses.Values)
		{
			completion.TrySetException(new InvalidOperationException("PURCHASE_BROWSER_CEF_DISCONNECTED"));
		}
	}

	private async Task DispatchAsync(JsonObject message)
	{
		string id = string.Empty;
		string command = string.Empty;
		JsonObject payload = (message["payload"] as JsonObject) ?? new JsonObject();
		SemaphoreSlim? gate = null;
		bool gateAcquired = false;
		try
		{
			id = message["id"]?.GetValue<string>() ?? string.Empty;
			command = message["command"]?.GetValue<string>() ?? string.Empty;
			stop.Token.ThrowIfCancellationRequested();
			if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(command))
			{
				throw new InvalidOperationException("PURCHASE_BROWSER_COMMAND_INVALID");
			}
			bool lifecycleBypass = command is "force-close" or "shutdown";
			if (!lifecycleBypass)
			{
				string ownerRef = payload["ownerRef"]?.ToString()?.Trim() ?? string.Empty;
				if (ownerRef.Length > 0)
				{
					ConcurrentDictionary<string, SemaphoreSlim> lane = PresentationCommands.Contains(command)
						? ownerPresentationGates
						: ownerCommandGates;
					gate = lane.GetOrAdd(ownerRef, static _ => new SemaphoreSlim(1, 1));
					await gate.WaitAsync(stop.Token).ConfigureAwait(false);
					gateAcquired = true;
				}
			}
			object? data = await coordinator.ExecuteAsync(command, payload).ConfigureAwait(false);
			ProtocolWriter.TryWrite(new
			{
				type = "response",
				id = id,
				ok = true,
				command = command,
				data
			});
		}
		catch (Exception ex)
		{
			if (!ErrorCode.IsExpectedObserverMiss(ex))
			{
				try
				{
					reportCommandError(command, ex);
				}
				catch
				{
				}
			}
			string code = ErrorCode.From(ex);
			ProtocolWriter.TryWrite(new
			{
				type = "response",
				id = id,
				ok = false,
				command = command,
				error = new { code }
			});
		}
		finally
		{
			if (gateAcquired)
			{
				try { gate?.Release(); }
				catch (ObjectDisposedException) when (stop.IsCancellationRequested)
				{
					// Shutdown may dispose a gate while its already-running browser
					// command finishes. No future command can acquire it after Stop.
				}
			}
		}
	}

	public void Dispose()
	{
		Stop();
		try
		{
			reader?.Wait(TimeSpan.FromSeconds(1.0));
		}
		catch
		{
		}
		stop.Dispose();
		foreach (SemaphoreSlim gate in ownerCommandGates.Values) gate.Dispose();
		ownerCommandGates.Clear();
		foreach (SemaphoreSlim gate in ownerPresentationGates.Values) gate.Dispose();
		ownerPresentationGates.Clear();
	}
}
