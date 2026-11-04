import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('production package binds and verifies only the protected-compute public release tuple', async () => {
  const packageJson = JSON.parse(
    await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const resource = packageJson.build.extraResources.find(
    (entry) => entry.to === 'license/protected-compute',
  );
  assert.deepEqual(resource, {
    from: 'resources/protected-compute',
    to: 'license/protected-compute',
    filter: [
      'protected-compute.signed-public.json',
      'configuration-public.pem',
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(packageJson.build.extraResources),
    /(?:private|\.secrets|license-center\/deploy\/secrets)/iu,
  );

  const [configureSource, sealSource, verifierSource] = await Promise.all([
    fs.readFile(new URL('./configure-distribution.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('./seal-license-manifest.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('./verify-package.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(configureSource, /enforce 模式必须提供 --protected-bundle/u);
  assert.match(configureSource, /stageProtectedComputeBundle/u);
  assert.match(configureSource, /assertPublicOnlyBundle/u);
  assert.match(configureSource, /--allow-test-fixture-urls/u);
  assert.match(configureSource, /isProtectedComputeTestFixtureHostname/u);
  for (const source of [sealSource, verifierSource]) {
    assert.match(source, /loadProtectedComputeDistribution/u);
    assert.match(source, /required:\s*true/u);
    assert.match(source, /minimumRemainingMs:\s*24 \* 60 \* 60 \* 1000/u);
    assert.match(source, /isProtectedComputeTestFixtureHostname/u);
    assert.match(source, /isProtectedComputeTestFixtureCampaign/u);
    assert.doesNotMatch(source, /allowTestFixtureUrls\s*:\s*true/u);
    assert.doesNotMatch(source, /--allow-test-fixture-urls/u);
  }
  assert.match(verifierSource, /expectedProtectedComputeFiles/u);

  for (const scriptName of ['pack:win', 'dist:win', 'dist:win:installer', 'dist:win:portable']) {
    assert.match(packageJson.scripts[scriptName], /seal:distribution/u, scriptName);
    assert.match(packageJson.scripts[scriptName], /verify:package/u, scriptName);
  }
});
