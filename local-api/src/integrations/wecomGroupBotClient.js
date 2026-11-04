const WECOM_GROUP_BOT_HOST = 'qyapi.weixin.qq.com';
const WECOM_GROUP_BOT_PATH = '/cgi-bin/webhook/send';

function text(value) {
  return value == null ? '' : String(value).trim();
}

function createWecomError(message, code, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = options.statusCode || 400;
  error.remoteStatus = options.remoteStatus ?? null;
  return error;
}

export function normalizeWecomGroupBotWebhook(value) {
  const raw = text(value);
  if (!raw) {
    throw createWecomError('请粘贴企业微信群机器人 Webhook 地址。', 'WECOM_WEBHOOK_REQUIRED');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw createWecomError('企业微信机器人地址格式不正确。', 'WECOM_WEBHOOK_INVALID');
  }
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== WECOM_GROUP_BOT_HOST
    || url.pathname !== WECOM_GROUP_BOT_PATH
    || url.username
    || url.password
    || url.hash
    || !text(url.searchParams.get('key'))
  ) {
    throw createWecomError(
      '请使用企业微信群机器人生成的完整 Webhook 地址。',
      'WECOM_WEBHOOK_INVALID',
    );
  }
  return url.toString();
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function sendWecomGroupBotText(webhook, content, options = {}) {
  const endpoint = normalizeWecomGroupBotWebhook(webhook);
  const message = text(content);
  if (!message) throw createWecomError('机器人消息不能为空。', 'WECOM_MESSAGE_REQUIRED');
  const response = await (options.fetchImpl || fetch)(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: message } }),
    signal: options.signal,
  });
  const payload = await readJson(response);
  if (!response.ok || Number(payload?.errcode) !== 0) {
    throw createWecomError(
      text(payload?.errmsg) || `企业微信机器人返回 HTTP ${response.status}。`,
      'WECOM_SEND_FAILED',
      { statusCode: response.ok ? 502 : response.status, remoteStatus: response.status },
    );
  }
  return { ok: true, message: '测试消息已发送到企业微信群。', payload };
}

export async function testWecomGroupBotWebhook(webhook, options = {}) {
  return sendWecomGroupBotText(
    webhook,
    '旺崽助手：企业微信机器人已连接，后续日报和异常提醒会发送到这个群。',
    options,
  );
}
