import { describe, expect, it } from 'vitest';
import { settingsModuleTabs, visibleSettingsModuleTabs } from './appConfigCore.jsx';

describe('settings module visibility', () => {
  it('keeps data maintenance internally addressable without showing it as a normal settings tab', () => {
    expect(settingsModuleTabs.find((module) => module.id === 'dataMaintenance')).toMatchObject({
      hidden: true,
    });
    expect(visibleSettingsModuleTabs.some((module) => module.id === 'dataMaintenance')).toBe(false);
  });
});
