using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace Wangzai.CefBrowserHost;

/// <summary>
/// Routes every purchase platform through the original general Form so an order
/// workbench can keep its fixed left context and embed the active CEF page on the
/// right. The auxiliary Form remains only for bounded shutdown compatibility.
/// </summary>
internal sealed class BrowserHostCoordinator
{
	private readonly BrowserHostForm generalForm;
	private readonly BrowserHostForm pinduoduoForm;
	private sealed class OwnerRoute(BrowserHostForm form)
	{
		public BrowserHostForm Form { get; } = form;
	}

	private readonly ConcurrentDictionary<string, OwnerRoute> ownerForms = new(StringComparer.Ordinal);

	public BrowserHostCoordinator(BrowserHostForm generalForm, BrowserHostForm pinduoduoForm)
	{
		this.generalForm = generalForm;
		this.pinduoduoForm = pinduoduoForm;
	}

	public void BindProtocol(ProtocolServer protocol)
	{
		generalForm.BindProtocol(protocol);
		pinduoduoForm.BindProtocol(protocol);
	}

	public async Task<object?> ExecuteAsync(string command, JsonObject payload)
	{
		if (command == "shutdown")
		{
			// Close the auxiliary Form first. Closing the main Form ends the
			// WinForms message loop, so it must always be the final operation.
			await pinduoduoForm.ExecuteAsync(command, Clone(payload)).ConfigureAwait(false);
			return await generalForm.ExecuteAsync(command, Clone(payload)).ConfigureAwait(false);
		}

		string ownerRef = OwnerRef(payload);
		if (command == "launch")
		{
			BrowserHostForm target = generalForm;
			JsonObject routed = Clone(payload);
			OwnerRoute route = new(target);
			ownerForms[ownerRef] = route;
			try
			{
				return await target.ExecuteAsync(command, routed).ConfigureAwait(false);
			}
			catch
			{
				RemoveRoute(ownerRef, route);
				throw;
			}
		}

		if (!ownerForms.TryGetValue(ownerRef, out OwnerRoute? currentRoute))
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_CEF_SESSION_NOT_FOUND");
		}

		JsonObject commandPayload = Clone(payload);
		object? result = await currentRoute.Form.ExecuteAsync(command, commandPayload).ConfigureAwait(false);
		if (command is "close" or "force-close") RemoveRoute(ownerRef, currentRoute);
		return result;
	}

	private void RemoveRoute(string ownerRef, OwnerRoute route)
	{
		// Identity-sensitive removal: an earlier asynchronous close/failure must
		// not erase the route installed by a newer launch for the same owner.
		((ICollection<KeyValuePair<string, OwnerRoute>>)ownerForms)
			.Remove(new KeyValuePair<string, OwnerRoute>(ownerRef, route));
	}

	private static string OwnerRef(JsonObject payload)
	{
		string ownerRef = payload["ownerRef"]?.ToString()?.Trim()
			?? payload["profile"]?["ownerRef"]?.ToString()?.Trim()
			?? string.Empty;
		if (ownerRef.Length == 0 || ownerRef.Length > 64)
		{
			throw new InvalidOperationException("PURCHASE_BROWSER_OWNER_REF_INVALID");
		}
		return ownerRef;
	}

	private static JsonObject Clone(JsonObject payload)
	{
		return JsonNode.Parse(payload.ToJsonString()) as JsonObject ?? new JsonObject();
	}
}
