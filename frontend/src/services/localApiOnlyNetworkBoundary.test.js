import { readProjectSource } from '../test/appSource';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const isProductionSource = (name) => /\.(js|jsx|ts|tsx)$/u.test(name) && !/\.(test|spec)\.(js|jsx|ts|tsx)$/u.test(name);

function readProjectFile(relativePath) {
  return readProjectSource(relativePath);
}

function listSourceFiles(dir) {
  const root = resolve(projectRoot, dir);
  const output = [];
  for (const name of readdirSync(root)) {
    const filePath = join(root, name);
    const stat = statSync(filePath);
    if (stat.isDirectory()) output.push(...listSourceFiles(`${dir}/${name}`));
    else if (isProductionSource(name)) output.push(filePath);
  }
  return output;
}

describe('local-api network boundary', () => {
  it('excludes only test/spec modules, not similarly named production helpers', () => {
    expect(['localApiClient.test.js', 'boundary.spec.tsx', 'component.test.jsx'].filter(isProductionSource)).toEqual([]);
    expect(['localApiClient.js', 'testSupport.js', 'boundary.testHelper.ts'].filter(isProductionSource)).toHaveLength(3);
  });
  it('does not restore legacy Vite proxy entries', () => {
    const viteConfig = readProjectFile('vite.config.js');
    expect(viteConfig).not.toMatch(/\/ozon-api/u);
    expect(viteConfig).not.toMatch(/\/cross-border-api/u);
    expect(viteConfig).not.toMatch(/\/legacy-kuajing84-api/u);
    expect(viteConfig).not.toMatch(/api-seller\.ozon\.ru/u);
    expect(viteConfig).not.toMatch(/\bproxy\s*:/u);
  });

  it('keeps localApiClient as the frontend network boundary and exposes only the real local-api Ozon bridge there', () => {
    const localApiClient = readProjectFile('src/api/localApiClient.js');
    expect(localApiClient).toMatch(/http:\/\/127\.0\.0\.1:3790/u);
    expect(localApiClient).toMatch(/getDomainCache/u);
    expect(localApiClient).toMatch(/startDomainSync/u);
    expect(localApiClient).toMatch(/requestRegisteredOzonViaLocalApi/u);
    expect(localApiClient).toMatch(/\/api\/ozon\/request/u);
    expect(localApiClient).not.toMatch(/api-seller\.ozon\.ru/u);
    expect(localApiClient).not.toMatch(/\/ozon-api/u);
  });

  it('does not leave business calls to /api/ozon/request outside the local-api client', () => {
    const offenders = listSourceFiles('src')
      .map((file) => [file, readFileSync(file, 'utf8')])
      .filter(
        ([file, source]) =>
          source.includes('/api/ozon/request') &&
          !file.endsWith('localApiClient.js')
      );
    expect(offenders.map(([file]) => file.replace(projectRoot, ''))).toEqual([]);
  });

  it('keeps product service main path off the old ozon-local-data-layer cache', () => {
    const productListSyncClient = readProjectFile('src/services/productListSyncClient.js');
    const productModuleClient = readProjectFile('src/services/productModuleClient.js');
    const localApiClient = readProjectFile('src/api/localApiClient.js');
    const combined = `${productListSyncClient}\n${productModuleClient}\n${localApiClient}`;

    expect(combined).toMatch(/\/api\/cache\/products|products/);
    expect(combined).not.toMatch(/ozon-local-data-layer/u);
    expect(combined).not.toMatch(/LOCAL_OZON_DATA_LAYER_FILE_KEY/u);
    expect(combined).not.toMatch(/readLocalDataFile/u);
    expect(combined).not.toMatch(/writeLocalDataFile/u);
  });
});
