import React from 'react';

import {
  getDefaultCollectionProductImageSkill,
  loadCollectionProductImageSkill,
  saveCollectionProductImageSkillEditorForm,
} from '../services/collectionProductImageSkillService.js';

export function useCollectionProductImageSkill(enabled = false) {
  const [state, setState] = React.useState(() => ({
    status: 'ready',
    error: '',
    skill: getDefaultCollectionProductImageSkill(),
  }));

  const refresh = React.useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading', error: '' }));
    try {
      const skill = await loadCollectionProductImageSkill();
      setState({ status: 'ready', error: '', skill: skill || getDefaultCollectionProductImageSkill() });
      return skill;
    } catch (error) {
      setState((current) => ({
        ...current,
        status: current.skill ? 'ready' : 'error',
        error: error instanceof Error ? error.message : '图片 Skill 读取失败。',
      }));
      return null;
    }
  }, []);

  const save = React.useCallback(async (editorForm) => {
    setState((current) => ({ ...current, status: 'saving', error: '' }));
    try {
      const skill = await saveCollectionProductImageSkillEditorForm(editorForm);
      setState({ status: 'ready', error: '', skill });
      return skill;
    } catch (error) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : '图片 Skill 保存失败。',
      }));
      return null;
    }
  }, []);

  React.useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    if (typeof window === 'undefined') return undefined;
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled, refresh]);

  return { ...state, refresh, save };
}
