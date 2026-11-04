import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../test/appSource.js';

const retiredProviderToken = ['mp', 'stats'].join('');

const frontendRuntimeFiles = [
  'src/features/promptLibrary/lib/externalOzonSkillCatalog.js',
  'src/features/promptLibrary/lib/smartToolSkillCatalog.js',
  'src/features/promptLibrary/lib/smartToolOzonBrowserDataProfiles.js',
  'src/features/promptLibrary/lib/smartToolRuntime.js',
  'src/features/promptLibrary/lib/smartToolServerTemplates.js',
  'src/features/promptLibrary/lib/smartToolSkillAdapters.js',
  'src/features/promptLibrary/services/smartToolIntegrationProfileService.js',
  'src/shared/config/appConfigCore.jsx',
  'src/shared/config/appConfigRuntime.jsx',
];

function listFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function tokenCount(source) {
  return source.toLowerCase().split(retiredProviderToken).length - 1;
}

describe('retired paid analytics provider', () => {
  it('is absent from active frontend, backend and bundled Skill sources', () => {
    frontendRuntimeFiles.forEach((file) => {
      expect(readProjectSource(file).toLowerCase(), file).not.toContain(retiredProviderToken);
    });

    const backendSource = readFileSync(
      resolve(process.cwd(), '..', 'local-api/src/integrations/externalDataApiClient.js'),
      'utf8',
    );
    expect(backendSource.toLowerCase()).not.toContain(retiredProviderToken);

    const skillRoot = resolve(process.cwd(), '..', 'skill-sources');
    listFiles(skillRoot).forEach((file) => {
      expect(file.toLowerCase(), file).not.toContain(retiredProviderToken);
      expect(readFileSync(file, 'utf8').toLowerCase(), file).not.toContain(retiredProviderToken);
    });
  });

  it('keeps exactly one inert migration filter for saved tools and saved interfaces', () => {
    const storeSource = readProjectSource('src/features/promptLibrary/lib/promptLibraryStore.jsx');
    const settingsSource = readProjectSource('src/features/settings/lib/platformIntegrationRecords.js');

    expect(tokenCount(storeSource)).toBe(1);
    expect(tokenCount(settingsSource)).toBe(1);
    expect(storeSource).toContain('retiredPaidAnalyticsProvider');
    expect(settingsSource).toContain('isRetiredPlatformIntegration');
  });
});
