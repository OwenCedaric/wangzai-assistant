import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSmartReplyRuntimeStatus: vi.fn(),
  listSmartReplyCredentials: vi.fn(),
  listSmartReplyRules: vi.fn(),
  listSmartReplyTasks: vi.fn(),
  retrySmartReplyTask: vi.fn(),
  saveSmartReplyRule: vi.fn(),
  setSmartReplyRuleEnabled: vi.fn(),
  syncBoundSmartReplyShopCredential: vi.fn(),
  requestLocalApi: vi.fn(),
}));

vi.mock('../../licensing/services/licenseCenterClient.js', () => mocks);
vi.mock('../../../api/localApiClient.js', () => ({ requestLocalApi: mocks.requestLocalApi }));

import {
  changeSmartReplyExecutionMode,
  connectSmartReplyShop,
  loadSmartReplyAutomation,
  persistSmartReplyRule,
  readSmartReplyExecutionMode,
} from './smartReplyAutomationService.js';

describe('smartReplyAutomationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSmartReplyRuntimeStatus.mockResolvedValue({
      mode: 'server',
      worker_running: true,
      callback_configured: true,
      configured_shop_count: 1,
      enabled_rule_count: 1,
      pending_task_count: 2,
    });
    mocks.listSmartReplyCredentials.mockResolvedValue([
      { client_id: '10001', shop_name: '一店', configured: true, status: 'active' },
    ]);
    mocks.listSmartReplyRules.mockResolvedValue([
      {
        rule_id: 'rule-1',
        scene: 'pickupReminder',
        shop_client_ids: ['10001'],
        send_time_type: 'immediate',
        delay_hours: 0,
        template_id: 'pickup-reminder-1',
        message_template: '俄语',
        enabled: true,
      },
    ]);
    mocks.listSmartReplyTasks.mockResolvedValue({
      items: [{ task_id: 'task-1', posting_number: 'POST-1', status: 'sent' }],
      total: 1,
    });
  });

  it('loads server runtime, credentials, rules and send records together', async () => {
    const payload = await loadSmartReplyAutomation();
    expect(payload.runtime).toMatchObject({ workerRunning: true, pendingTaskCount: 2 });
    expect(payload.credentials[0]).toMatchObject({ clientId: '10001', configured: true });
    expect(payload.rules[0]).toMatchObject({ ruleId: 'rule-1', enabled: true });
    expect(payload.tasks[0]).toMatchObject({ taskId: 'task-1', postingNumber: 'POST-1' });
  });

  it('saves the selected fixed template with exact shops and delay contract', async () => {
    mocks.saveSmartReplyRule.mockImplementation(async (payload) => ({
      ...payload,
      rule_id: 'rule-2',
      created_at: '2026-08-23T00:00:00Z',
      updated_at: '2026-08-23T00:00:00Z',
    }));
    await persistSmartReplyRule({
      scene: 'reviewRequest',
      shopClientIds: ['10001'],
      sendTimeType: 'delayed',
      delayHours: 3,
      templateId: 'review-request-1',
      messageTemplate: 'Спасибо, {{买家昵称}}',
      messageTemplateZh: '谢谢',
      enabled: true,
    });
    expect(mocks.saveSmartReplyRule).toHaveBeenCalledWith({
      scene: 'reviewRequest',
      shop_client_ids: ['10001'],
      send_time_type: 'delayed',
      delay_hours: 3,
      content_generate_type: 'template',
      template_id: 'review-request-1',
      message_template: 'Спасибо, {{买家昵称}}',
      message_template_zh: '谢谢',
      enabled: true,
    });
  });

  it('syncs the existing local shop authorization without accepting an API key from the page', async () => {
    mocks.syncBoundSmartReplyShopCredential.mockResolvedValue({
      client_id: '10001',
      shop_name: '一店',
      configured: true,
      status: 'active',
    });

    const credential = await connectSmartReplyShop({ shopId: 'local-shop-1', clientId: '10001' });

    expect(mocks.syncBoundSmartReplyShopCredential).toHaveBeenCalledWith({
      shopId: 'local-shop-1',
      clientId: '10001',
    });
    expect(credential).toMatchObject({ clientId: '10001', configured: true, status: 'active' });
  });

  it('loads the local worker, bound local shops, local rules and local records without cloud calls', async () => {
    mocks.requestLocalApi.mockImplementation(async (path) => ({
      '/api/smart-reply/local/status': {
        mode: 'local', worker_running: true, polling_active: true, configured_shop_count: 1,
      },
      '/api/smart-reply/local/credentials': [
        { client_id: '20001', shop_name: '本地店', configured: true, status: 'active' },
      ],
      '/api/smart-reply/local/rules': [
        { rule_id: 'local-rule', scene: 'shipmentNotice', shop_client_ids: ['20001'], enabled: true },
      ],
      '/api/smart-reply/local/tasks?limit=100': {
        items: [{ task_id: 'local-task', posting_number: 'LOCAL-1', status: 'sent' }], total: 1,
      },
    })[path]);

    const payload = await loadSmartReplyAutomation('local');

    expect(payload.runtime).toMatchObject({ mode: 'local', workerRunning: true, pollingActive: true });
    expect(payload.credentials[0]).toMatchObject({ clientId: '20001', configured: true });
    expect(payload.rules[0]).toMatchObject({ ruleId: 'local-rule', scene: 'shipmentNotice' });
    expect(mocks.getSmartReplyRuntimeStatus).not.toHaveBeenCalled();
  });

  it('switches modes only after disabling every enabled rule in the previous mode', async () => {
    mocks.listSmartReplyRules.mockResolvedValue([
      { rule_id: 'cloud-on', enabled: true },
      { rule_id: 'cloud-off', enabled: false },
    ]);
    mocks.setSmartReplyRuleEnabled.mockResolvedValue({});
    mocks.requestLocalApi.mockResolvedValue({ ok: true, mode: 'local' });

    await expect(changeSmartReplyExecutionMode('local', 'cloud')).resolves.toEqual({
      mode: 'local',
      warning: '',
    });
    expect(mocks.setSmartReplyRuleEnabled).toHaveBeenCalledTimes(1);
    expect(mocks.setSmartReplyRuleEnabled).toHaveBeenCalledWith('cloud-on', false);
    expect(mocks.requestLocalApi).toHaveBeenLastCalledWith('/api/smart-reply/mode', {
      method: 'POST', body: { mode: 'local' },
    });
  });

  it('switches to local monitoring even when License Center is unavailable', async () => {
    mocks.listSmartReplyRules.mockRejectedValue(new Error('License Center 返回了无效响应'));
    mocks.requestLocalApi.mockResolvedValue({ ok: true, mode: 'local' });

    await expect(changeSmartReplyExecutionMode('local', 'cloud')).resolves.toEqual({
      mode: 'local',
      warning: expect.stringMatching(/本地监听已启动/u),
    });
    expect(mocks.requestLocalApi).toHaveBeenCalledWith('/api/smart-reply/mode', {
      method: 'POST', body: { mode: 'local' },
    });
    expect(mocks.setSmartReplyRuleEnabled).not.toHaveBeenCalled();
  });

  it('persists and reads the selected execution mode on the customer computer', async () => {
    mocks.requestLocalApi.mockResolvedValue({ ok: true, mode: 'local' });
    await expect(readSmartReplyExecutionMode()).resolves.toBe('local');
    expect(mocks.requestLocalApi).toHaveBeenCalledWith('/api/smart-reply/mode');
  });
});
