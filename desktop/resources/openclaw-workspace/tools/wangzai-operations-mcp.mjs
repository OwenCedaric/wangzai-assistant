import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const runtimeRoot = String(process.env.WANGZAI_OPENCLAW_RUNTIME_ROOT || '').trim();
const relayBaseUrl = String(process.env.WANGZAI_OPENCLAW_ACTION_RELAY_URL || '').trim().replace(/\/$/u, '');
const relayToken = String(process.env.WANGZAI_OPENCLAW_ACTION_RELAY_TOKEN || '').trim();
if (!runtimeRoot) throw new Error('WANGZAI_OPENCLAW_RUNTIME_ROOT_REQUIRED');
if (!relayBaseUrl || !relayToken) throw new Error('WANGZAI_OPENCLAW_ACTION_RELAY_REQUIRED');

const dependencyUrl = (relativePath) => pathToFileURL(path.join(runtimeRoot, 'node_modules', 'openclaw', 'node_modules', relativePath)).href;
const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
  import(dependencyUrl('@modelcontextprotocol/sdk/dist/esm/server/mcp.js')),
  import(dependencyUrl('@modelcontextprotocol/sdk/dist/esm/server/stdio.js')),
  import(dependencyUrl('zod/index.js')),
]);

async function relay(pathname, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 125_000);
  try {
    const response = await fetch(`${relayBaseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${relayToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error?.message || `旺崽操作通道返回异常状态 ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('旺崽操作等待超时；结果可能需要核对，禁止自动重试。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

const server = new McpServer({ name: 'wangzai-operations', version: '1.0.0' });

server.registerTool('wangzai_prepare_operation', {
  title: '执行旺崽操作',
  description: '对已登记且用户已授权的商品、订单、营销、售后和客服动作先生成固定预览，再在同一次调用中直接提交；不需要微信二次确认。',
  inputSchema: {
    domain: z.enum(['products', 'orders', 'marketing', 'returns', 'customer-service']),
    action: z.string().trim().min(1).max(100),
    shopId: z.string().trim().min(1).max(200),
    accountId: z.string().trim().max(200).optional(),
    endpointKey: z.string().trim().max(200).optional(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    payload: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().trim().max(200).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async (input) => {
  try { return textResult(await relay('/actions/preview', input)); }
  catch (error) { return textResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true); }
});

await server.connect(new StdioServerTransport());
