import { useCallback, useMemo, useRef, useState } from 'react';
import { smartReplyScenes } from '../constants/smartReplyScenes.js';
import { getSmartReplyTemplates } from '../constants/smartReplyTemplateCatalog.js';
import {
  createSmartReplySampleValues,
  findMissingSmartReplyVariables,
  renderSmartReplyTemplate,
} from '../lib/smartReplyTemplateRenderer.js';

const defaultScene = smartReplyScenes[0];

function defaultTemplateSelection() {
  return Object.fromEntries(
    smartReplyScenes.map((scene) => [scene.value, getSmartReplyTemplates(scene.value)[0]?.id || ''])
  );
}

function createTemplateWorkspace() {
  return Object.fromEntries(
    smartReplyScenes.map((scene) => [
      scene.value,
      getSmartReplyTemplates(scene.value).map((template) => ({ ...template })),
    ])
  );
}

export function useSmartReplyTemplateWorkspace() {
  const [selectedSceneValue, setSelectedSceneValue] = useState(defaultScene.value);
  const [selectedTemplateByScene, setSelectedTemplateByScene] = useState(defaultTemplateSelection);
  const [templatesByScene, setTemplatesByScene] = useState(createTemplateWorkspace);
  const [sampleValues, setSampleValues] = useState(createSmartReplySampleValues);
  const customTemplateSequence = useRef(0);

  const selectedScene = smartReplyScenes.find((scene) => scene.value === selectedSceneValue) || defaultScene;
  const templates = templatesByScene[selectedScene.value] || [];
  const selectedTemplateId = selectedTemplateByScene[selectedScene.value] || templates[0]?.id;
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) || templates[0];

  const preview = useMemo(
    () => renderSmartReplyTemplate(selectedTemplate?.messageRu, sampleValues),
    [sampleValues, selectedTemplate]
  );
  const missingVariables = useMemo(
    () => findMissingSmartReplyVariables(selectedTemplate?.messageRu, sampleValues),
    [sampleValues, selectedTemplate]
  );

  const selectTemplate = (templateId) => {
    setSelectedTemplateByScene((current) => ({
      ...current,
      [selectedScene.value]: templateId,
    }));
  };

  const updateSampleValue = (code, value) => {
    setSampleValues((current) => ({ ...current, [code]: value }));
  };

  const saveTemplate = (draft) => {
    let templateId = String(draft.id || '').trim();
    if (!templateId) {
      customTemplateSequence.current += 1;
      templateId = `${selectedScene.value}-custom-${customTemplateSequence.current}`;
    }
    const nextTemplate = {
      id: templateId,
      scene: selectedScene.value,
      source: 'session-draft',
      messageRu: String(draft.messageRu || '').trim(),
      messageZh: String(draft.messageZh || '').trim(),
    };
    setTemplatesByScene((current) => {
      const sceneTemplates = current[selectedScene.value] || [];
      const existingIndex = sceneTemplates.findIndex((template) => template.id === templateId);
      const nextSceneTemplates = [...sceneTemplates];
      if (existingIndex >= 0) nextSceneTemplates[existingIndex] = nextTemplate;
      else nextSceneTemplates.push(nextTemplate);
      return { ...current, [selectedScene.value]: nextSceneTemplates };
    });
    setSelectedTemplateByScene((current) => ({
      ...current,
      [selectedScene.value]: templateId,
    }));
  };

  const hydrateSavedTemplate = useCallback((saved = {}) => {
    const scene = String(saved.scene || '').trim();
    const templateId = String(saved.id || saved.templateId || '').trim();
    if (!scene || !templateId) return;
    const nextTemplate = {
      id: templateId,
      scene,
      source: 'saved-rule',
      messageRu: String(saved.messageRu || saved.messageTemplate || '').trim(),
      messageZh: String(saved.messageZh || saved.messageTemplateZh || '').trim(),
    };
    setTemplatesByScene((current) => {
      const sceneTemplates = current[scene] || [];
      const existingIndex = sceneTemplates.findIndex((template) => template.id === templateId);
      const nextSceneTemplates = [...sceneTemplates];
      if (existingIndex >= 0) nextSceneTemplates[existingIndex] = nextTemplate;
      else nextSceneTemplates.push(nextTemplate);
      return { ...current, [scene]: nextSceneTemplates };
    });
    setSelectedTemplateByScene((current) => ({ ...current, [scene]: templateId }));
  }, []);

  const templateCounts = Object.fromEntries(
    smartReplyScenes.map((scene) => [scene.value, templatesByScene[scene.value]?.length || 0])
  );

  return {
    hydrateSavedTemplate,
    missingVariables,
    preview,
    sampleValues,
    selectedScene,
    selectedTemplate,
    saveTemplate,
    selectScene: setSelectedSceneValue,
    selectTemplate,
    templateCounts,
    templates,
    updateSampleValue,
  };
}
