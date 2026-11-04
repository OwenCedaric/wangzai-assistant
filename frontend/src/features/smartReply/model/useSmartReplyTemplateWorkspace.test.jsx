import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSmartReplyTemplateWorkspace } from './useSmartReplyTemplateWorkspace.js';

describe('useSmartReplyTemplateWorkspace', () => {
  it('restores the exact template snapshot saved by the cloud rule', () => {
    const { result } = renderHook(() => useSmartReplyTemplateWorkspace());

    act(() => {
      result.current.hydrateSavedTemplate({
        scene: 'passportRequired',
        templateId: 'passport-custom-saved',
        messageTemplate: 'Здравствуйте, {{买家昵称}}.',
        messageTemplateZh: '您好，{{买家昵称}}。',
      });
    });

    expect(result.current.selectedTemplate).toMatchObject({
      id: 'passport-custom-saved',
      source: 'saved-rule',
      messageRu: 'Здравствуйте, {{买家昵称}}.',
      messageZh: '您好，{{买家昵称}}。',
    });
  });
});
