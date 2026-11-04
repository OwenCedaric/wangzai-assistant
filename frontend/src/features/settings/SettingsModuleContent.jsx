import { settingsModulePanels } from '../../shared/config/appConfigCore.jsx';
import { structuredSettingsLayouts } from '../../shared/config/appConfigRuntime.jsx';
import React from 'react';
import { ModelApiSettingsPanel } from './ModelApiSettingsPanel.jsx';
import { StructuredSettingsLayout } from './StructuredSettingsLayout.jsx';
import { DataMaintenancePanel } from './ui/DataMaintenancePanel.jsx';
import { FeeSettingsPanel } from './ui/FeeSettingsPanel.jsx';
import { SettingsModulePanel } from './ui/SettingsModulePanel.jsx';
import { WatermarkSettingsPanel } from './ui/WatermarkSettingsPanel.jsx';
import { WechatAssistantSettingsPanel } from './ui/WechatAssistantSettingsPanel.jsx';

function SettingsModuleContent({
  activeSettingsModule,
  actionNote,
  onAction,
  saveRequestId = 0,
  shops = [],
}) {
  const structuredModule = structuredSettingsLayouts[activeSettingsModule];
  const activeModule = settingsModulePanels[activeSettingsModule];

  if (activeSettingsModule === 'watermark') return <WatermarkSettingsPanel onAction={onAction} saveRequestId={saveRequestId} />;
  if (activeSettingsModule === 'modelApi') return <ModelApiSettingsPanel onAction={onAction} saveRequestId={saveRequestId} />;
  if (activeSettingsModule === 'feeSetting') {
    return <FeeSettingsPanel onAction={onAction} saveRequestId={saveRequestId} shops={shops} />;
  }
  if (activeSettingsModule === 'dataMaintenance') return <DataMaintenancePanel />;
  if (activeSettingsModule === 'wechatAssistant') {
    return <WechatAssistantSettingsPanel saveRequestId={saveRequestId} />;
  }
  if (structuredModule) {
    return (
      <StructuredSettingsLayout
        config={structuredModule}
        actionNote={actionNote}
        onAction={onAction}
        saveRequestId={saveRequestId}
        shops={shops}
      />
    );
  }
  if (activeModule) return <SettingsModulePanel module={activeModule} actionNote={actionNote} onAction={onAction} />;
  return null;
}

export { SettingsModuleContent };
export default SettingsModuleContent;
