import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('integration profile routes keep direct secrets out of profiles and encrypt nested credentials', async () => {
  const db = createMigratedTestDb();
  let server;
  const externalRequests = [];
  try {
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
      externalIntegrationFetchImpl: async (url, init) => {
        externalRequests.push({ url, init });
        const payload = url.includes('qyapi.weixin.qq.com/cgi-bin/webhook/send')
          ? { errcode: 0, errmsg: 'ok' }
          : url.endsWith('/open-api/quota')
            ? { code: 200, data: { remain: 10000 } }
            : { code: 200, data: { products: [] } };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const saveResponse = await fetch(`${baseUrl}/api/integrations/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'integration-a', integrationType: 'custom', platformName: 'Internal Tool',
        apiType: '工具服务', note: 'profile note',
      }),
    });
    const saved = await saveResponse.json();
    assert.equal(saveResponse.status, 200);
    assert.equal(saved.profile.id, 'integration-a');
    assert.equal(saved.profile.note, 'profile note');

    const forbiddenResponse = await fetch(`${baseUrl}/api/integrations/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ integrationType: 'custom', platformName: 'bad', accessToken: 'must-not-store' }),
    });
    assert.equal(forbiddenResponse.status, 400);
    assert.match((await forbiddenResponse.json()).error.message, /secret field is forbidden/);

    const credentialResponse = await fetch(`${baseUrl}/api/integrations/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'seerfar-a',
        integrationType: 'seerfar-open-api',
        platformName: 'Seerfar A',
        credentials: {
          baseUrl: 'https://api.seerfar.cn',
          apiKey: 'seerfar-secret',
        },
      }),
    });
    const credentialSaved = await credentialResponse.json();
    assert.equal(credentialResponse.status, 200);
    assert.equal(credentialSaved.profile.hasApiKey, true);
    assert.equal(credentialSaved.profile.apiKeyHint, '••••••••••');
    assert.doesNotMatch(JSON.stringify(credentialSaved), /seerfar-secret/u);

    const testResponse = await fetch(`${baseUrl}/api/integrations/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ integrationType: 'seerfar-open-api', profileId: 'seerfar-a' }),
    });
    const tested = await testResponse.json();
    assert.equal(testResponse.status, 200);
    assert.equal(tested.status, 'connected');
    assert.equal(tested.profile.lastTestStatus, 'connected');
    assert.equal(externalRequests[0].url, 'https://api.seerfar.cn/open-api/quota');
    assert.equal(externalRequests[0].init.headers.Authorization, 'Bearer seerfar-secret');

    const wecomSaveResponse = await fetch(`${baseUrl}/api/integrations/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'wecom-bot-a',
        integrationType: 'wecom-group-bot',
        platformName: '日报通知群',
        credentials: {
          apiKey: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=group-bot-key',
        },
      }),
    });
    const wecomSaved = await wecomSaveResponse.json();
    assert.equal(wecomSaveResponse.status, 200);
    assert.equal(wecomSaved.profile.hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(wecomSaved), /group-bot-key/u);

    const wecomTestResponse = await fetch(`${baseUrl}/api/integrations/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ integrationType: 'wecom-group-bot', profileId: 'wecom-bot-a' }),
    });
    const wecomTested = await wecomTestResponse.json();
    assert.equal(wecomTestResponse.status, 200);
    assert.equal(wecomTested.status, 'connected');
    assert.equal(wecomTested.profile.lastTestStatus, 'connected');
    assert.equal(externalRequests[1].url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=group-bot-key');
    assert.deepEqual(JSON.parse(externalRequests[1].init.body), {
      msgtype: 'text',
      text: { content: '旺崽助手：企业微信机器人已连接，后续日报和异常提醒会发送到这个群。' },
    });

    const readResponse = await fetch(`${baseUrl}/api/integrations/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: 'seerfar-a',
        operation: 'ozon-shop-search',
        input: {
          id: 123,
          page: { page: 1, pageSize: 5, orders: [{ field: 'sales', direction: 'DESC' }] },
        },
      }),
    });
    const readPayload = await readResponse.json();
    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.ok, true);
    assert.equal(externalRequests[2].url, 'https://api.seerfar.cn/open-api/shop/detail/search/ozon');
    assert.equal(externalRequests[2].init.headers.Authorization, 'Bearer seerfar-secret');
    assert.deepEqual(JSON.parse(externalRequests[2].init.body), {
      id: 123,
      page: { pageNumber: 1, pageSize: 5, orders: [{ field: 'sales', direction: 'DESC' }] },
    });

    const listResponse = await fetch(`${baseUrl}/api/integrations/profiles`);
    const list = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.deepEqual(list.profiles.map((profile) => profile.id), ['wecom-bot-a', 'seerfar-a', 'integration-a']);
    assert.equal(list.profiles.find((profile) => profile.id === 'seerfar-a').hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(list), /seerfar-secret/u);

    const deleteResponse = await fetch(`${baseUrl}/api/integrations/profiles/integration-a`, { method: 'DELETE' });
    const deletePayload = await deleteResponse.json();
    assert.equal(deleteResponse.status, 409);
    assert.equal(deletePayload.error.code, 'ACCOUNT_REMOVAL_LEGACY_ROUTE_PREVIEW_REQUIRED');
    assert.equal(deletePayload.canonicalRoute, '/api/account-removal/preview');
    const afterRejectedDelete = await (await fetch(`${baseUrl}/api/integrations/profiles`)).json();
    assert.ok(afterRejectedDelete.profiles.some((profile) => profile.id === 'integration-a'));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
