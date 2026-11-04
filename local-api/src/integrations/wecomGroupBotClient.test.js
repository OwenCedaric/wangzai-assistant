import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWecomGroupBotWebhook,
  testWecomGroupBotWebhook,
} from './wecomGroupBotClient.js';

const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=11111111-2222-3333-4444-555555555555';

test('accepts only an enterprise WeChat group robot webhook with a key', () => {
  assert.equal(normalizeWecomGroupBotWebhook(webhook), webhook);
  assert.throws(
    () => normalizeWecomGroupBotWebhook('https://example.com/cgi-bin/webhook/send?key=test'),
    { code: 'WECOM_WEBHOOK_INVALID' },
  );
  assert.throws(
    () => normalizeWecomGroupBotWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send'),
    { code: 'WECOM_WEBHOOK_INVALID' },
  );
});

test('sends an explicit test message only when the user starts a connection test', async () => {
  const calls = [];
  const result = await testWecomGroupBotWebhook(webhook, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, webhook);
  assert.match(calls[0].init.body, /企业微信机器人已连接/u);
});
