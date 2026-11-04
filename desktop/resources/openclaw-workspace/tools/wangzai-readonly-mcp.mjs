import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const runtimeRoot = String(process.env.WANGZAI_OPENCLAW_RUNTIME_ROOT || '').trim();
const relayText = String(process.env.WANGZAI_OPENCLAW_READONLY_RELAY_URL || '').trim().replace(/\/$/u, '');
const relayToken = String(process.env.WANGZAI_OPENCLAW_READONLY_RELAY_TOKEN || '').trim();
if (!runtimeRoot) throw new Error('WANGZAI_OPENCLAW_RUNTIME_ROOT_REQUIRED');
if (!relayText || !relayToken) throw new Error('WANGZAI_OPENCLAW_READONLY_RELAY_REQUIRED');
const relayUrl = new URL(relayText);
if (relayUrl.protocol !== 'http:' || relayUrl.hostname !== '127.0.0.1' || relayUrl.pathname !== '/v1'
  || relayUrl.username || relayUrl.password || relayUrl.search || relayUrl.hash) throw new Error('WANGZAI_OPENCLAW_READONLY_RELAY_INVALID');
const dependencyUrl = relativePath => pathToFileURL(path.join(runtimeRoot, 'node_modules/openclaw/node_modules', relativePath)).href;
const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
  import(dependencyUrl('@modelcontextprotocol/sdk/dist/esm/server/mcp.js')),
  import(dependencyUrl('@modelcontextprotocol/sdk/dist/esm/server/stdio.js')),
  import(dependencyUrl('zod/index.js')),
]);

async function read(operation, input = {}) {
  const query = new URLSearchParams();
  for (const key of ['shop', 'days', 'date']) if (input[key] !== undefined) query.set(key, String(input[key]));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(relayText + '/readonly/' + operation + '?' + query, {
      method: 'GET', headers: { Authorization: 'Bearer ' + relayToken, Accept: 'application/json' },
      redirect: 'error', signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok || result?.ok !== true) throw Object.assign(new Error(result?.error?.message || '权威只读数据暂不可用。'), { code: result?.error?.code });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false,
      error: error?.name === 'AbortError' ? '权威只读数据等待超时，请稍后重试。' : error.message,
      ...(error.code ? { code: error.code } : {}) }) }] };
  } finally { clearTimeout(timer); }
}

// No SQLite path or fallback: the main-process bridge uses the exact same
// authorized aggregate route as the normal dashboard, including shop stores.
const server = new McpServer({ name: 'wangzai-readonly', version: '1.1.0' });
server.registerTool('wangzai_list_shops', {
  title: '列出旺崽店铺', description: '只读列出旺崽中的启用店铺。',
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => read('shops'));
server.registerTool('wangzai_shop_summary', {
  title: '分析旺崽店铺数据',
  description: '只读调用旺崽首页同一权威读模型，返回销售金额及币种、订单、利润、库存和经营待办。',
  inputSchema: { shop: z.string().trim().max(200).optional(), days: z.number().int().min(1).max(365).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async input => read('summary', input));
await server.connect(new StdioServerTransport());
