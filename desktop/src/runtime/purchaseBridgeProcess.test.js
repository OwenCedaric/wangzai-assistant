import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("purchase bridge did not become healthy");
}

test("protected purchase bridge requires capability and hides context from health", async () => {
  const port = await availablePort();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-bridge-process-"));
  const statePath = path.join(directory, "state.json");
  const token = "test-purchase-capability";
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      mode: "enforce",
      authorized: true,
      permissions: ["purchase.manage"],
      expire: "2030-01-01T00:00:00Z",
      offline_until: "2030-01-01T00:00:00Z",
    }),
  );
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.resolve(here, "../../../frontend/scripts/purchase-search-bridge.mjs");
  const child = spawn(process.execPath, [script], {
    stdio: "ignore",
    env: {
      ...process.env,
      PURCHASE_SEARCH_BRIDGE_PORT: String(port),
      PURCHASE_BRIDGE_AUTH_TOKEN: token,
      PURCHASE_BRIDGE_LICENSE_STATE_PATH: statePath,
    },
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForHealth(`${baseUrl}/health`);
    assert.equal(health.authorizationRequired, true);
    assert.equal("pluginContext" in health, false);

    assert.equal((await fetch(`${baseUrl}/api/purchase/plugin-context`)).status, 403);
    const allowed = await fetch(`${baseUrl}/api/purchase/plugin-context`, {
      headers: { "X-Wangzai-Purchase-Token": token },
    });
    assert.equal(allowed.status, 200);
    const contextHeaders = {
      "Content-Type": "application/json",
      "X-Wangzai-Purchase-Token": token,
    };
    const savedContext = await fetch(`${baseUrl}/api/purchase/plugin-context`, {
      method: "POST",
      headers: contextHeaders,
      body: JSON.stringify({ orderKey: "order-1", productKey: "product-1" }),
    });
    assert.equal(savedContext.status, 200);
    const savedCapture = await fetch(`${baseUrl}/api/purchase/plugin-capture`, {
      method: "POST",
      headers: contextHeaders,
      body: JSON.stringify({
        type: "source",
        context: { orderKey: "order-1", productKey: "product-1" },
        link: "https://detail.1688.com/offer/123456789.html",
        title: "test source",
      }),
    });
    assert.equal(savedCapture.status, 200);
    const captures = await fetch(`${baseUrl}/api/purchase/plugin-captures`, {
      headers: { "X-Wangzai-Purchase-Token": token },
    }).then((response) => response.json());
    assert.equal(captures.captures[0].productId, "123456789");
    const rejectedOrigin = await fetch(`${baseUrl}/api/purchase/plugin-context`, {
      headers: {
        Origin: "https://untrusted.example",
        "X-Wangzai-Purchase-Token": token,
      },
    });
    assert.equal(rejectedOrigin.status, 403);
    const privateImage = await fetch(
      `${baseUrl}/api/purchase/image-proxy?url=${encodeURIComponent("http://172.16.0.1/secret")}`,
      { headers: { "X-Wangzai-Purchase-Token": token } },
    );
    assert.equal(privateImage.status, 400);
    const extensionRequest = await fetch(`${baseUrl}/api/purchase/plugin-context`, {
      headers: { Origin: "chrome-extension://jkbnfmdnjfbiamkokbpijimlohjancdl" },
    });
    assert.equal(extensionRequest.status, 200);
    const unknownExtension = await fetch(`${baseUrl}/api/purchase/plugin-context`, {
      headers: { Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    assert.equal(unknownExtension.status, 403);

    fs.writeFileSync(statePath, JSON.stringify({ mode: "enforce", authorized: false }));
    assert.equal(
      (
        await fetch(`${baseUrl}/api/purchase/plugin-context`, {
          headers: { "X-Wangzai-Purchase-Token": token },
        })
      ).status,
      403,
    );
  } finally {
    child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
