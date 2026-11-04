import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyModelApiSettings,
  getDefaultModelApiState,
  readSavedModelApiState,
  setModelApiStateMemory,
  toModelApiStateFromAccounts,
} from './modelApiSettings.jsx';

const legacyRaw = JSON.stringify({
  activeId: 'old-browser-model',
  interfaces: [{ id: 'old-browser-model', apiAlias: '旧浏览器接口', apiKey: 'must-not-be-read' }],
});

afterEach(() => {
  vi.unstubAllGlobals();
  setModelApiStateMemory(getDefaultModelApiState());
});

describe('model API settings canonical memory boundary', () => {
  it('does not consult a retired browser value when rendering canonical account metadata', () => {
    const getItem = vi.fn(() => legacyRaw);
    vi.stubGlobal('localStorage', { getItem });
    const canonical = setModelApiStateMemory({
      activeId: 'sqlite-model',
      interfaces: [{ id: 'sqlite-model', apiAlias: 'SQLite 模型接口', hasApiKey: true }],
    });

    expect(readSavedModelApiState()).toEqual(canonical);
    expect(readSavedModelApiState().interfaces[0].apiAlias).toBe('SQLite 模型接口');
    expect(getItem).not.toHaveBeenCalled();
  });

  it('uses the default placeholder only until canonical local-api metadata has loaded', () => {
    const defaultState = getDefaultModelApiState();
    setModelApiStateMemory(defaultState);

    expect(readSavedModelApiState()).toEqual(defaultState);
  });

  it('uses a fresh draft id when local-api has no saved model accounts', () => {
    const first = toModelApiStateFromAccounts([]);
    const second = toModelApiStateFromAccounts([]);

    expect(first.activeId).not.toBe(emptyModelApiSettings.id);
    expect(second.activeId).not.toBe(emptyModelApiSettings.id);
    expect(second.activeId).not.toBe(first.activeId);
  });
});
