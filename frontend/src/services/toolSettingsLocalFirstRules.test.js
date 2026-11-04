import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const mainSource = readFileSync(join(process.cwd(), 'src', 'main.jsx'), 'utf8');
const pluginSource = readFileSync(join(process.cwd(), 'localDataPlugin.js'), 'utf8');
const catalogSource = readFileSync(join(process.cwd(), 'src', 'services', 'localDataDomainCatalog.js'), 'utf8');

describe('tool settings local-first rules', () => {
  it('keeps watermark settings SQLite-only after both browser/file readers retire', () => {
    expect(appSource).not.toContain('LOCAL_WATERMARK_SETTINGS_FILE_KEY');
    expect(appSource).not.toContain('WATERMARK_TEMPLATE_STORAGE_KEY');
    expect(appSource).not.toContain('WATERMARK_ACTIVE_TEMPLATE_STORAGE_KEY');
    expect(pluginSource).not.toContain("'watermark-settings'");
    expect(pluginSource).not.toContain("fileName: 'watermark-settings.json'");
    expect(catalogSource).toContain("'watermarkSettings'");
    expect(catalogSource).not.toContain("'settings/watermark-settings.json'");
    expect(appSource).not.toContain('LOCAL_PROMPT_LIBRARY_FILE_KEY');
    expect(pluginSource).not.toContain("'prompt-library'");
    expect(pluginSource).not.toContain("fileName: 'prompt-library.json'");
    expect(catalogSource).not.toContain("'settings/prompt-library.json'");
  });

  it('keeps prompt tools SQLite-only after both browser keys retire', () => {
    const watermarkSaveStart = appSource.indexOf('function saveWatermarkTemplates(templates, activeTemplateId)');
    const watermarkSaveEnd = appSource.indexOf('async function loadWatermarkSettingsFromLocalApi()', watermarkSaveStart);
    const watermarkSaveSource = appSource.slice(watermarkSaveStart, watermarkSaveEnd);
    const promptSaveStart = appSource.indexOf('function savePromptLibraryStore(store)');
    const promptSaveEnd = appSource.indexOf('function savePromptLibraryItems(items)', promptSaveStart);
    const promptSaveSource = appSource.slice(promptSaveStart, promptSaveEnd);

    expect(appSource).not.toContain('readSavedActiveWatermarkTemplateIdFromBrowser');
    expect(appSource).not.toContain('readSavedWatermarkTemplatesFromBrowser');
    expect(appSource).not.toContain('getLegacyWatermarkBrowserStore');
    expect(appSource).not.toContain('readLocalDataFile(LOCAL_WATERMARK_SETTINGS_FILE_KEY)');
    expect(appSource).not.toContain('readLegacyBrowserValue(WATERMARK_ACTIVE_TEMPLATE_STORAGE_KEY)');
    expect(watermarkSaveSource).toContain('prepareWatermarkProfileSetting(nextStore, normalizeWatermarkSettingsStore)');
    expect(watermarkSaveSource).toContain('saveWatermarkProfileSetting(prepared.persistedValue)');
    expect(appSource).toContain("const PROFILE_PROMPT_LIBRARY_NAMESPACE = 'prompt-library';");
    expect(appSource).toContain('Canonical runtime load: profile-settings is the sole durable source.');
    expect(appSource).not.toContain('readPromptLibraryCategoriesFromBrowser');
    expect(appSource).not.toContain('readPromptLibraryItemsFromBrowser');
    expect(appSource).not.toContain('readPromptLibraryStoreFromBrowser');
    expect(appSource).not.toContain('scrubLegacyPromptLibrarySources');
    expect(appSource).not.toContain('PROMPT_LIBRARY_STORAGE_KEY');
    expect(appSource).not.toContain('PROMPT_LIBRARY_CATEGORY_STORAGE_KEY');
    expect(promptSaveSource).toContain('saveProfileSetting(PROFILE_PROMPT_LIBRARY_NAMESPACE, nextStore');
    expect(promptSaveSource).toContain('getProfileSetting(PROFILE_PROMPT_LIBRARY_NAMESPACE');
    expect(promptSaveSource).not.toContain('writeLocalDataFile');
    expect(appSource).not.toContain('window.localStorage.setItem(WATERMARK_TEMPLATE_STORAGE_KEY');
    expect(appSource).not.toContain('window.localStorage.setItem(WATERMARK_ACTIVE_TEMPLATE_STORAGE_KEY');
    expect(mainSource).not.toContain('BROWSER_LOCAL_STORAGE_MIRROR_KEYS');
  });
});
