import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listModelApiAccounts: vi.fn() }));

vi.mock('../../../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listModelApiAccounts: mocks.listModelApiAccounts,
}));

import {
  listSmartToolModelOptions,
  loadSmartToolModelState,
  resolveSmartToolModelSelection,
  SMART_TOOL_AUTO_MODEL_ID,
  SMART_TOOL_IMAGE_MODEL_CAPABILITY,
} from './smartToolModelService.js';

describe('smartToolModelService', () => {
  const state = {
    activeId: 'relay-main',
    interfaces: [
      {
        id: 'relay-main',
        apiAlias: '统一中转站',
        provider: 'relay',
        baseUrl: 'https://relay.example/v1',
        apiKey: 'secret',
        discoveryVerified: true,
        defaultModel: 'gpt-5.5',
        usageScene: '通用文本',
      },
      {
        id: 'image-model',
        apiAlias: '图片模型',
        provider: 'relay',
        baseUrl: 'https://relay.example/v1',
        apiKey: '',
        defaultModel: 'gpt-image-2',
        usageScene: '图片方案',
      },
    ],
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists sanitized model options without exposing api keys', () => {
    const options = listSmartToolModelOptions(state);

    expect(options[0].id).toBe(SMART_TOOL_AUTO_MODEL_ID);
    expect(options[0].label).toBe('Chat-GPT-5.5');
    expect(options[0].displayName).toBe('Chat-GPT-5.5');
    expect(options[0].statusLabel).toBe('自有优先，积分兜底');
    expect(options[1]).toMatchObject({
      id: 'relay-main',
      model: 'gpt-5.5',
      label: 'Chat-GPT-5.5',
      ready: true,
      statusLabel: '可用',
    });
    expect(JSON.stringify(options)).not.toContain('secret');
    expect(JSON.stringify(options)).not.toContain('统一中转站');
    expect(JSON.stringify(options)).not.toContain('https://relay.example');
  });

  it('resolves selected model and falls back to auto', () => {
    const options = listSmartToolModelOptions(state);

    expect(resolveSmartToolModelSelection('image-model', options).model).toBe('gpt-image-2');
    expect(resolveSmartToolModelSelection('missing', options).id).toBe(SMART_TOOL_AUTO_MODEL_ID);
  });

  it('only exposes models from the dedicated text interface to smart tools', () => {
    const options = listSmartToolModelOptions({
      activeId: 'mixed-image-interface',
      interfaces: [
        {
          id: 'mixed-image-interface',
          baseUrl: 'https://mixed.example/v1',
          hasApiKey: true,
          discoveryVerified: true,
          defaultModel: 'gpt-image-2',
          capabilities: ['image-edit', 'image-generation', 'text-generation', 'unknown'],
          availableModels: [
            { id: 'gpt-5-mini', capabilities: ['text-generation'] },
            { id: 'gpt-image-2', capabilities: ['image-edit', 'image-generation', 'text-generation'] },
            { id: 'grok-video', capabilities: ['unknown'] },
          ],
        },
        {
          id: 'text-interface',
          baseUrl: 'https://text.example/v1',
          hasApiKey: true,
          discoveryVerified: true,
          defaultModel: 'gpt-5.5',
          capabilities: ['text-generation'],
          availableModels: [
            { id: 'gpt-5.4', label: 'GPT-5.4', capabilities: ['text-generation'] },
            { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', capabilities: ['text-generation'] },
            { id: 'gpt-5.5', label: 'GPT-5.5', capabilities: ['text-generation'] },
            { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', capabilities: ['text-generation'] },
            { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', capabilities: ['text-generation'] },
            { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', capabilities: ['text-generation'] },
          ],
        },
      ],
    });

    expect(options[0]).toMatchObject({
      model: 'gpt-5.5',
      label: 'Chat-GPT-5.5',
      statusLabel: '自有优先，积分兜底',
    });
    expect(options.slice(1).map((item) => item.model)).toEqual([
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'builtin-points-text',
    ]);
    expect(options.every((item) => !item.label.includes('配置 1'))).toBe(true);
    expect(JSON.stringify(options)).not.toContain('gpt-image-2');
    expect(JSON.stringify(options)).not.toContain('grok-video');
  });

  it('only exposes image-generation models to the image-generation skill', () => {
    const options = listSmartToolModelOptions(
      {
        activeId: 'mixed-image-interface',
        interfaces: [
          {
            id: 'mixed-image-interface',
            baseUrl: 'https://images.example.invalid/v1',
            hasApiKey: true,
            discoveryVerified: true,
            defaultModel: 'gpt-image-2',
            capabilities: ['image-edit', 'image-generation', 'text-generation', 'unknown'],
            availableModels: [
              { id: 'gpt-5-mini', capabilities: ['text-generation'] },
              { id: 'gpt-image-2', capabilities: ['image-edit', 'image-generation', 'text-generation'] },
              { id: 'gemini-banana-2.0-pro', capabilities: ['text-generation'] },
              { id: 'grok-video', capabilities: ['unknown'] },
            ],
          },
          {
            id: 'text-interface',
            baseUrl: 'https://text.example/v1',
            hasApiKey: true,
            discoveryVerified: true,
            defaultModel: 'gpt-5.5',
            capabilities: ['text-generation'],
            availableModels: [{ id: 'gpt-5.5', capabilities: ['text-generation'] }],
          },
        ],
      },
      { capability: SMART_TOOL_IMAGE_MODEL_CAPABILITY }
    );

    expect(options[0]).toMatchObject({ model: 'gpt-image-2', label: 'Chat-GPT-Image-2', statusLabel: '可用' });
    expect(options.slice(1).map((item) => item.model)).toEqual([
      'gpt-image-2',
      'gpt-image-2',
    ]);
    expect(options.at(-1)).toMatchObject({
      id: 'builtin-points-image',
      accountId: 'builtin-points',
      model: 'gpt-image-2',
      provider: '已配置的图片服务（服务端）',
      ready: true,
    });
    expect(JSON.stringify(options)).not.toContain('gemini-banana-2.0-pro');
    expect(JSON.stringify(options)).not.toContain('gpt-5-mini');
    expect(JSON.stringify(options)).not.toContain('gpt-5.5');
    expect(JSON.stringify(options)).not.toContain('grok-video');
  });

  it('uses only the managed images.example.invalid model when local image accounts use another endpoint', () => {
    const options = listSmartToolModelOptions(
      {
        activeId: 'legacy-image-relay',
        interfaces: [
          {
            id: 'legacy-image-relay',
            baseUrl: 'https://model.example.invalid/v1',
            hasApiKey: true,
            discoveryVerified: true,
            defaultModel: 'gpt-image-2',
            capabilities: ['image-generation', 'image-edit'],
            availableModels: [{ id: 'gpt-image-2', capabilities: ['image-generation', 'image-edit'] }],
          },
        ],
      },
      { capability: SMART_TOOL_IMAGE_MODEL_CAPABILITY }
    );

    expect(options[0]).toMatchObject({
      id: SMART_TOOL_AUTO_MODEL_ID,
      accountId: 'builtin-points',
      model: 'gpt-image-2',
      label: '内置图片生成模型',
      provider: '已配置的图片服务（服务端）',
      ready: true,
    });
    expect(options.at(-1)).toMatchObject({
      id: 'builtin-points-image',
      label: '内置图片生成模型',
    });
    expect(options).toHaveLength(2);
    expect(JSON.stringify(options)).not.toContain('model.example.invalid');
  });

  it('loads only public model account metadata from local-api for a page opened before settings', async () => {
    mocks.listModelApiAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'model-a',
          apiAlias: '模型主接口',
          provider: 'relay',
          baseUrl: 'https://relay.example/v1',
          hasApiKey: true,
          discoveryVerified: true,
          defaultModel: 'gpt-5.5',
          usageScene: '通用文本',
          isDefault: true,
        },
      ],
    });

    const loadedState = await loadSmartToolModelState();
    const options = listSmartToolModelOptions(loadedState);

    expect(mocks.listModelApiAccounts).toHaveBeenCalledWith({ timeoutMs: 10000, signal: undefined });
    expect(options[0]).toMatchObject({ model: 'gpt-5.5', ready: true, statusLabel: '自有优先，积分兜底' });
    expect(loadedState.interfaces[0]).toMatchObject({ apiKey: '', hasApiKey: true, loginPassword: '' });
  });
});
