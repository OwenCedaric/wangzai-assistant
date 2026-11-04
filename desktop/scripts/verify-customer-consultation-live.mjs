const debuggerListUrl = "http://127.0.0.1:9229/json/list";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPageTarget() {
  const response = await fetch(debuggerListUrl);
  if (!response.ok)
    throw new Error(`DevTools target list failed: ${response.status}`);
  const targets = await response.json();
  const target = targets.find(
    (row) => row.type === "page" && row.url === "app://wangzai/index.html",
  );
  if (!target?.webSocketDebuggerUrl)
    throw new Error("旺崽助手桌面页面未连接调试通道。");
  return target;
}

function createCdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("DevTools WebSocket 连接失败。")),
      { once: true },
    );
  });
  return {
    async send(method, params = {}) {
      await ready;
      sequence += 1;
      const id = sequence;
      const result = new Promise((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression, { awaitPromise = true } = {}) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text,
    );
  }
  return response.result?.value;
}

async function waitFor(client, expression, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(client, expression)) return true;
    await wait(200);
  }
  throw new Error(`等待桌面状态超时：${expression.slice(0, 120)}`);
}

async function clickByText(client, text, selector = 'button,[role="button"]') {
  const clicked = await evaluate(
    client,
    `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => (node.textContent || '').trim().includes(${JSON.stringify(text)}) && !node.disabled);
      if (!target) return false;
      target.scrollIntoView({ block: 'center' });
      target.click();
      return true;
    })()`,
  );
  if (!clicked) {
    const visibleText = await evaluate(
      client,
      `(document.body?.innerText || '').slice(0, 800)`,
    );
    throw new Error(`未找到可点击项：${text}；当前页面：${visibleText}`);
  }
}

async function setReactInput(client, selector, value) {
  const changed = await evaluate(
    client,
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  if (!changed) throw new Error(`未找到输入框：${selector}`);
}

const records = [];
function record(name, ok, detail = "") {
  records.push({ index: records.length + 1, name, ok, detail });
}

const target = await getPageTarget();
const client = createCdpClient(target.webSocketDebuggerUrl);

try {
  await client.send("Page.bringToFront");
  await client.send("Runtime.enable");
  await evaluate(
    client,
    `(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((node) => /LIVE-PREVIEW|未找到对应的客服数据/u.test(node.textContent || ''));
      const closeButton = [...(dialog?.querySelectorAll('button') || [])]
        .find((button) => (button.textContent || '').trim() === '关闭');
      closeButton?.click();
      return true;
    })()`,
  );
  const loginState = await evaluate(
    client,
    `(() => {
      const inputs = [...document.querySelectorAll('input')];
      const loginButton = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === '登录');
      return { visible: Boolean(loginButton), populated: inputs.filter((input) => input.type !== 'checkbox').filter((input) => input.value).length >= 2 };
    })()`,
  );
  if (loginState?.visible && loginState?.populated) {
    await clickByText(client, "登录");
    await waitFor(
      client,
      `[...document.querySelectorAll('button,[role="button"]')].some((node) => (node.textContent || '').trim().includes('客服咨询'))`,
      30000,
    );
  }
  // 等待桌面鉴权桥和 App 内的店铺状态都完成恢复。这里不能刷新 renderer，
  // 因为桌面登录态属于当前运行会话；真实用户也不会靠刷新网页进入工作台。
  await waitFor(
    client,
    `(async () => {
      const result = await window.wangzaiDesktop?.localApiRequest?.({ path: '/api/shops', method: 'GET', timeoutMs: 10000 });
      return Number(result?.data?.shops?.length ?? result?.data?.rows?.length ?? 0) > 0;
    })()`,
    30000,
  );
  await wait(5000);
  const alreadyOpen = await evaluate(
    client,
    `(() => { const page = document.querySelector('.customer-consultation-page'); return Boolean(page && page.getClientRects().length > 0 && !page.closest('[hidden]')); })()`,
  );
  if (!alreadyOpen) await clickByText(client, "客服咨询");
  await waitFor(
    client,
    `(() => { const page = document.querySelector('.customer-consultation-page'); return Boolean(page && page.getClientRects().length > 0 && !page.closest('[hidden]')); })()`,
    20000,
  );
  record("进入客服咨询模块", true);

  await waitFor(
    client,
    `document.querySelectorAll('.customer-chat-list-item').length >= 20`,
    60000,
  );
  const rowCount = await evaluate(
    client,
    `document.querySelectorAll('.customer-chat-list-item').length`,
  );
  if (rowCount < 20) {
    const pageText = await evaluate(
      client,
      `(document.querySelector('.customer-consultation-page')?.innerText || '').slice(0, 1200)`,
    );
    const shopProbe = await evaluate(
      client,
      `(async () => {
        const result = await window.wangzaiDesktop?.localApiRequest?.({ path: '/api/shops', method: 'GET', timeoutMs: 10000 });
        return { ok: result?.ok, status: result?.status, count: result?.data?.shops?.length ?? result?.data?.rows?.length ?? 0, error: result?.data?.error?.message || result?.error || '' };
      })()`,
    );
    throw new Error(
      `真实会话不足 20 条，当前仅 ${rowCount} 条，无法完成 20 次不同会话操作。店铺探测：${JSON.stringify(shopProbe)}。页面状态：${pageText}`,
    );
  }

  for (let index = 0; index < 20; index += 1) {
    const detail = await evaluate(
      client,
      `(async () => {
        const rows = [...document.querySelectorAll('.customer-chat-list-item')];
        const row = rows[${index}];
        const button = row?.querySelector('.customer-chat-list-select');
        if (!button) return { ok: false, error: '会话按钮不存在' };
        row.scrollIntoView({ block: 'center' });
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 650));
        const active = row.classList.contains('active');
        const thread = document.querySelector('.customer-chat-main-panel');
        const fatal = [...document.querySelectorAll('[role="alert"]')]
          .map((node) => node.textContent || '')
          .find((text) => /读取失败|加载失败|fetch failed/i.test(text));
        return {
          ok: active && Boolean(thread) && !fatal,
          title: (row.querySelector('.MuiTypography-subtitle2')?.textContent || '').trim(),
          fatal: fatal || '',
        };
      })()`,
    );
    if (!detail?.ok)
      throw new Error(
        `第 ${index + 1} 个会话打开失败：${detail?.fatal || detail?.error || "未知错误"}`,
      );
    record(`打开并读取第 ${index + 1} 个会话`, true, detail.title);
  }

  const searchSelector =
    '.customer-chat-list-head input[aria-label="搜索客服会话"]';
  await setReactInput(client, searchSelector, "0172237641");
  await wait(400);
  record(
    "搜索会话",
    true,
    `匹配 ${await evaluate(client, `document.querySelectorAll('.customer-chat-list-item').length`)} 条`,
  );
  await setReactInput(client, searchSelector, "");
  await wait(350);
  record("清空搜索恢复列表", true);

  await clickByText(client, "仅看未读");
  await wait(250);
  record("切换仅看未读", true);
  await clickByText(client, "仅看未读");
  await wait(250);
  record("恢复全部会话", true);

  const refreshClicked = await evaluate(
    client,
    `(() => { const button = document.querySelector('button[aria-label="刷新 Ozon 会话"]'); if (!button || button.disabled) return false; button.click(); return true; })()`,
  );
  if (!refreshClicked) throw new Error("刷新按钮当前不可用。");
  await waitFor(
    client,
    `!document.querySelector('button[aria-label="刷新 Ozon 会话"]')?.disabled`,
    45000,
  );
  record("手动刷新真实会话", true);

  const selectedConversationId = await evaluate(
    client,
    `document.querySelector('.customer-chat-list-item.active')?.getAttribute('data-customer-conversation-id') || ''`,
  );
  const draftText = `实机草稿恢复验证-${Date.now()}`;
  await setReactInput(client, ".customer-message-composer textarea", draftText);
  await wait(900);
  record("保存会话草稿", true, selectedConversationId);
  await clickByText(client, "旺崽汇总");
  await waitFor(
    client,
    `(() => { const page = document.querySelector('.customer-consultation-page'); return !page || page.getClientRects().length === 0 || Boolean(page.closest('[hidden]')); })()`,
    20000,
  );
  await clickByText(client, "客服咨询");
  await waitFor(
    client,
    `(() => { const page = document.querySelector('.customer-consultation-page'); return Boolean(page && page.getClientRects().length > 0 && !page.closest('[hidden]')); })()`,
    20000,
  );
  await waitFor(
    client,
    `document.querySelectorAll('.customer-chat-list-item').length >= 20`,
    45000,
  );
  const restoredDraft = await evaluate(
    client,
    `(() => {
      const row = document.querySelector('[data-customer-conversation-id="${selectedConversationId.replaceAll('"', '\\"')}"]');
      row?.querySelector('.customer-chat-list-select')?.click();
      return true;
    })()`,
  );
  if (!restoredDraft) throw new Error("无法重新选择草稿所属会话。");
  await wait(500);
  const draftValue = await evaluate(
    client,
    `document.querySelector('.customer-message-composer textarea')?.value || ''`,
  );
  if (draftValue !== draftText) throw new Error("重载后会话草稿未恢复。");
  record("重启页面后恢复草稿", true);
  await setReactInput(client, ".customer-message-composer textarea", "");
  await wait(700);
  record("清理实机测试草稿", true);

  await clickByText(client, "快捷回复");
  await waitFor(
    client,
    `Boolean(document.querySelector('.customer-quick-replies-panel'))`,
  );
  await evaluate(
    client,
    `[...document.querySelectorAll('.customer-quick-reply-row')]
      .filter((row) => (row.textContent || '').includes('测试短语-'))
      .forEach((row) => row.querySelector('.customer-quick-reply-delete')?.click())`,
  );
  await wait(400);
  const quickReply = `测试短语-${Date.now()}`;
  await setReactInput(
    client,
    ".customer-quick-reply-create textarea",
    quickReply,
  );
  await clickByText(client, "保存为快捷短语");
  await wait(700);
  const phraseSaved = await evaluate(
    client,
    `[...document.querySelectorAll('.customer-quick-reply-row')].some((row) => (row.textContent || '').includes(${JSON.stringify(quickReply)}))`,
  );
  if (!phraseSaved) throw new Error("快捷短语未出现在列表。");
  record("新增自定义快捷短语", true);
  await evaluate(
    client,
    `document.querySelector('button[aria-label="关闭快捷短语"]')?.click() || true`,
  );
  await waitFor(
    client,
    `!document.querySelector('.customer-quick-replies-panel')`,
  );
  await clickByText(client, "快捷回复");
  const phraseRestored = await evaluate(
    client,
    `[...document.querySelectorAll('.customer-quick-reply-row')].some((row) => (row.textContent || '').includes(${JSON.stringify(quickReply)}))`,
  );
  if (!phraseRestored) throw new Error("快捷短语重新打开后未保留。");
  record("重新打开后保留快捷短语", true);
  const removed = await evaluate(
    client,
    `(() => {
      const row = [...document.querySelectorAll('.customer-quick-reply-row')]
        .find((node) => (node.textContent || '').includes(${JSON.stringify(quickReply)}));
      row?.querySelector('.customer-quick-reply-delete')?.click();
      return Boolean(row);
    })()`,
  );
  if (!removed) throw new Error("实机测试快捷短语无法删除。");
  await wait(500);
  record("删除实机测试快捷短语", true);
  await evaluate(
    client,
    `document.querySelector('button[aria-label="关闭快捷短语"]')?.click() || true`,
  );
  await waitFor(
    client,
    `!document.querySelector('.customer-quick-replies-panel')`,
  );

  const documentNode = await client.send("DOM.getDocument", { depth: -1 });
  const fileInput = await client.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: '.customer-message-composer input[type="file"]',
  });
  if (!fileInput.nodeId) throw new Error("附件选择控件不存在。");
  await client.send("DOM.setFileInputFiles", {
    nodeId: fileInput.nodeId,
    files: [
      "C:\\WORKSPACE\\desktop\\scripts\\fixtures\\customer-consultation-live.txt",
    ],
  });
  await waitFor(
    client,
    `[...document.querySelectorAll('[role="dialog"]')].some((node) => (node.textContent || '').includes('发送附件确认') && (node.textContent || '').includes('确认发送'))`,
    15000,
  );
  const filePreviewReady = await evaluate(
    client,
    `[...document.querySelectorAll('[role="dialog"]')].some((node) => (node.textContent || '').includes('确认发送'))`,
  );
  if (!filePreviewReady) throw new Error("附件暂存后未进入确认预览。");
  record("附件暂存与预览可用（未向 Ozon 发送）", true);
  await clickByText(client, "返回修改", '[role="dialog"] button');

  const realOrderSelection = await evaluate(
    client,
    `(async () => {
      const rows = [...document.querySelectorAll('.customer-chat-list-item')];
      for (const row of rows) {
        row.querySelector('.customer-chat-list-select')?.click();
        await new Promise((resolve) => setTimeout(resolve, 350));
        const detail = document.querySelector('.customer-chat-context-panel')?.innerText || '';
        const match = detail.match(/发货单号\\s*([0-9]+(?:-[0-9]+)+)/u);
        if (match?.[1]) return { ok: true, postingNumber: match[1] };
      }
      return { ok: false, postingNumber: '' };
    })()`,
  );
  if (!realOrderSelection?.ok)
    throw new Error("当前真实会话中没有可用于新建会话预览的关联发货单。");
  await clickByText(client, "新建会话");
  await waitFor(
    client,
    `Boolean([...document.querySelectorAll('[role="dialog"]')].find((node) => (node.textContent || '').includes('新建买家会话')))`,
  );
  const startPostingNumber = await evaluate(
    client,
    `(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((node) => (node.textContent || '').includes('新建买家会话'));
      return dialog?.querySelector('input')?.value || '';
    })()`,
  );
  if (!/^\d+(?:-\d+)+$/u.test(startPostingNumber)) {
    throw new Error("新建会话没有带出当前真实关联发货单号。");
  }
  if (startPostingNumber !== realOrderSelection.postingNumber) {
    throw new Error(
      `新建会话带出的发货单号与当前关联订单不一致：详情 ${realOrderSelection.postingNumber}，弹窗 ${startPostingNumber}。`,
    );
  }
  await clickByText(client, "创建预览");
  await waitFor(
    client,
    `[...document.querySelectorAll('[role="dialog"]')].some((node) => (node.textContent || '').includes('确认新建'))`,
    15000,
  );
  record("新建会话预览可用（未向 Ozon 提交）", true);
  const closedStartDialog = await evaluate(
    client,
    `(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((node) => (node.textContent || '').includes('新建买家会话'));
      const closeButton = [...(dialog?.querySelectorAll('button') || [])]
        .find((button) => (button.textContent || '').trim() === '关闭');
      closeButton?.click();
      return Boolean(closeButton);
    })()`,
  );
  if (!closedStartDialog) throw new Error("新建会话测试弹窗未正确关闭。");
  await waitFor(
    client,
    `![...document.querySelectorAll('[role="dialog"]')].some((node) => (node.textContent || '').includes('新建买家会话'))`,
  );

  console.log(
    JSON.stringify(
      { ok: true, operationCount: records.length, records },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        operationCount: records.length,
        records,
        error: error.message,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  client.close();
}
