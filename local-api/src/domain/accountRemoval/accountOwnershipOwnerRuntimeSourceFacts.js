import { createHash } from 'node:crypto';

// These six task registries were added after the immutable B0 inventory. They
// contain owner-bearing asynchronous work, not system-only subscriptions. This
// supplemental source proof neither adds deletion resources nor changes B0.
export const ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS_VERSION = 'account-ownership-owner-runtime-source-facts-v1';

const rendererBinding = Object.freeze({
  sourceFile: 'frontend/src/features/settings/accountRemoval/services/accountRemovalRuntime.js',
  sourceSHA256: '8A770D8922FB4C5509667DB8E6179A9FD00BDF4AB38689CDAE1B3C5268F72E42',
  requiredSourceStatements: Object.freeze([
    'const owner = normalizeOwner(preview.owner);',
    'rendererFenceLeases.register(preview, { ownerScope, identifiers, diagnostics });',
    'return rendererFenceLeases.release(preview, proof, (lease, { completed, protectedIdentifiers }) => {',
    'const { owner, ownerScope, identifiers = [] } = lease;',
  ]),
});

function sourceLinkFact(prefix, sourceSHA256, drainStatements, releaseStatement) {
  const capitalized = prefix[0].toUpperCase() + prefix.slice(1);
  const sourceSymbol = `${prefix}SourceLinkTasks`;
  return {
    sourceFile: `frontend/src/services/${prefix}SourceLinkStore.js`, sourceSymbol, sourceSHA256,
    ownerType: 'ozon_shop',
    ownerResourceId: `logical:local-data-${prefix}-source-links-shop-records`,
    barrierEntryPoint: `fenceAndDrain${capitalized}SourceLinkMigration`,
    releaseEntryPoint: `release${capitalized}SourceLinkOwnerFence`,
    ownerSelector: 'exact canonical shopId; legacy aliases must resolve unambiguously; each task retains its excludedOwnerIds',
    requiredSourceStatements: [
      `const ${prefix}SourceLinkFencedShopIds = new Set();`,
      `const task = { excludedOwnerIds: new Set(${prefix}SourceLinkFencedShopIds), ${prefix === 'product' ? 'globalSnapshot, ' : ''}promise: null };`,
      `${sourceSymbol}.add(task);`,
      '.then(() => work(task))',
      `if (globalSnapshot && [...task.excludedOwnerIds].some((id) => !${prefix}SourceLinkFencedShopIds.has(id))) {`,
      "throw Object.assign(new Error('ACCOUNT_REMOVAL_STALE_HYDRATION'), { code: 'ACCOUNT_REMOVAL_STALE_HYDRATION' });",
      `.finally(() => ${sourceSymbol}.delete(task));`,
      'if (task.excludedOwnerIds.has(rawScope) || task.excludedOwnerIds.has(identity?.shopId)) return false;',
      `const ownerId = normalize${capitalized}SourceOwnerId(shopId);`,
      "if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');",
      `${prefix}SourceLinkFencedShopIds.add(ownerId);`,
      `const pending = [...${sourceSymbol}];`,
      'pending.forEach((task) => task.excludedOwnerIds.add(ownerId));',
      ...drainStatements,
      'return { ownerId, fenced: true, ...drain };',
      releaseStatement,
    ],
  };
}

const reviewedFacts = [
  sourceLinkFact('product', '1754CA34A2A75839914500A627C1AF48DD51699F5007CE167CAF373FC4A02172', [
    'const drain = await settleOwnerWriteDrain([activeProductSourceLinkMigration, ...pending.map((task) => task.promise)]);',
  ], 'return productSourceLinkFencedShopIds.delete(normalizeProductSourceOwnerId(shopId));'),
  sourceLinkFact('purchase', '726DE8AA87528B4D5843F678F825F310000C5C10AD38560B1BF3C327D285AF94', [
    'const drain = await settleOwnerWriteDrain([',
    'purchaseSourceLinkMigrationCoordinator.drain(),',
    '...pending.map((task) => task.promise),',
  ], 'return purchaseSourceLinkFencedShopIds.delete(normalizePurchaseSourceOwnerId(shopId));'),
  sourceLinkFact('sales', '9CE5BE71EBD60F8FEBA9E1AF6A1B94B262A1267CCE1D0221410F2F4399D684D5', [
    'const drain = await settleOwnerWriteDrain([',
    'salesSourceLinkMigrationCoordinator.drain(),',
    '...pending.map((task) => task.promise),',
  ], "return salesSourceLinkFencedShopIds.delete(String(shopId || '').trim());"),
  {
    sourceFile: 'frontend/src/services/productMaterialProfileStore.js',
    sourceSymbol: 'productMaterialHydrations',
    sourceSHA256: 'D2F5B06F3DA34C2CFD6CF7E6ABE5982BDBF0D3EEF60D92AE025BEAAF7B9CAD66',
    ownerType: 'ozon_shop',
    ownerResourceId: 'logical:local-data-product-material-profiles-shop-records',
    barrierEntryPoint: 'fenceAndDrainProductMaterialProfileWrites',
    releaseEntryPoint: 'releaseProductMaterialProfileOwnerFence',
    ownerSelector: 'normalizeProductMaterialOwnerId(profile.shopId or profile.shop_id)',
    requiredSourceStatements: [
      'const productMaterialProfileFencedShopIds = new Set();',
      'const ownerId = normalizeProductMaterialOwnerId(shopId);',
      "if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');",
      'productMaterialProfileFencedShopIds.add(ownerId);',
      'const pendingHydrations = [...productMaterialHydrations];',
      'pendingHydrations.forEach(task => task.excludedOwnerIds.add(ownerId));',
      'const drain = await settleOwnerWriteDrain([',
      'productMaterialProfileLocalApiWriteQueue, ...pendingHydrations.map(task => task.promise),',
      'return { ownerId, fenced: true, ...drain };',
      'return productMaterialProfileFencedShopIds.delete(normalizeProductMaterialOwnerId(shopId));',
      'const ownerId = normalizeProductMaterialOwnerId(profile?.shopId ?? profile?.shop_id);',
      'return !task.excludedOwnerIds.has(ownerId) && !isProductMaterialOwnerFenced(ownerId);',
      'task.excludedOwnerIds.has(normalizeProductMaterialOwnerId(profile?.shopId ?? profile?.shop_id))',
      'saveProductMaterialProfiles({ ...eligibleHydrationProfiles(mergedProfiles, task), ...preserved });',
      'const migration = await saveProductMaterialProfilesToLocalApi(eligibleHydrationProfiles(migrationProfiles, task));',
      'if (canonicalReadbackMatches && task.excludedOwnerIds.size === 0) {',
      'const task = { excludedOwnerIds: new Set(productMaterialProfileFencedShopIds), promise: null };',
      'productMaterialHydrations.add(task);',
      'task.promise = Promise.resolve().then(() => hydrateProductMaterialProfiles(task))',
      '.finally(() => productMaterialHydrations.delete(task));',
    ],
  },
  {
    sourceFile: 'frontend/src/services/purchaseOrderRuntime.js',
    sourceSymbol: 'purchaseOrderOverrideReads',
    sourceSHA256: 'B46C58476D750641396AFBF6E45DB02A9CC8DF6E87588A187E772E40886D10E1',
    ownerType: 'ozon_shop',
    ownerResourceId: 'logical:local-data-purchase-order-overrides-shop-records',
    barrierEntryPoint: 'fenceAndDrainPurchaseOrderOverrideWrites',
    releaseEntryPoint: 'releasePurchaseOrderOverrideOwnerFence',
    ownerSelector: 'normalizePurchaseOverrideOwnerId(value.shopId or value.shop_id)',
    requiredSourceStatements: [
      'const purchaseOrderOverrideFencedShopIds = new Set();',
      'const ownerId = normalizePurchaseOverrideOwnerId(shopId);',
      "if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');",
      'purchaseOrderOverrideFencedShopIds.add(ownerId);',
      'const pendingReads = [...purchaseOrderOverrideReads];',
      'pendingReads.forEach(task => task.excludedOwnerIds.add(ownerId));',
      'const drain = await settleOwnerWriteDrain([',
      'purchaseOrderOverrideLocalApiWriteQueue,',
      '...pendingReads.map(task => task.promise),',
      'return { ownerId, fenced: true, ...drain };',
      'return purchaseOrderOverrideFencedShopIds.delete(normalizePurchaseOverrideOwnerId(shopId));',
      'const task = { excludedOwnerIds: new Set(purchaseOrderOverrideFencedShopIds), promise: null };',
      'purchaseOrderOverrideReads.add(task);',
      'task.promise = Promise.resolve().then(() => reader(task)).finally(() => purchaseOrderOverrideReads.delete(task));',
      'const ownerId = normalizePurchaseOverrideOwnerId(value?.shopId ?? value?.shop_id);',
      'return !task.excludedOwnerIds.has(ownerId) && !purchaseOrderOverrideFencedShopIds.has(ownerId);',
      'task.excludedOwnerIds.has(normalizePurchaseOverrideOwnerId(value?.shopId ?? value?.shop_id))',
      'purchaseOrderLocalOverridesMemory = { ...eligiblePurchaseOverrideRead(normalizedOverrides, task), ...preserved };',
      'if (task.excludedOwnerIds.has(normalizePurchaseOverrideOwnerId(legacyOverride?.shopId ?? legacyOverride?.shop_id))) continue;',
      'if (!task.excludedOwnerIds.size) await writeLocalDataFile(LOCAL_PURCHASE_ORDER_OVERRIDES_FILE_KEY, {});',
    ],
  },
  {
    sourceFile: 'frontend/src/shared/ozon/ozonRuntime.jsx',
    sourceSymbol: 'crossBorderSettingsReads',
    sourceSHA256: '76386289E5AA9141FC625D6D54F32FBDB8D55E882070FEAF9EA591260E060451',
    ownerType: 'cross_border_bus',
    ownerResourceId: 'logical:renderer-cross-border-settings-account-slice',
    barrierEntryPoint: 'fenceAndDrainCrossBorderSettingsWrites',
    releaseEntryPoint: 'releaseCrossBorderSettingsWriteFence',
    ownerSelector: 'normalizeCrossBorderAccountOwnerId(getCrossBorderLocalApiAccountId(settings))',
    requiredSourceStatements: [
      'const crossBorderSettingsFencedAccountIds = new Set();',
      'const ownerId = normalizeCrossBorderAccountOwnerId(accountId);',
      "if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');",
      'crossBorderSettingsFencedAccountIds.add(ownerId);',
      'const pendingReads = [...crossBorderSettingsReads];',
      'pendingReads.forEach(task => task.excludedOwnerIds.add(ownerId));',
      'const drain = await settleOwnerWriteDrain([crossBorderSettingsWriteQueue, crossBorderSettingsLastWrite, ...pendingReads.map(task => task.promise)]);',
      'return { ownerId, fenced: true, ...drain };',
      'return { ownerId, released: crossBorderSettingsFencedAccountIds.delete(ownerId) };',
      'const task = { excludedOwnerIds: new Set(crossBorderSettingsFencedAccountIds), memoryAtStart: crossBorderSettingsMemory, promise: null };',
      'crossBorderSettingsReads.add(task);',
      'task.promise = Promise.resolve().then(() => reader(task)).finally(() => crossBorderSettingsReads.delete(task));',
      'const id = normalizeCrossBorderAccountOwnerId(accountId);',
      'return task.excludedOwnerIds.has(id) || crossBorderSettingsFencedAccountIds.has(id);',
      "error.code = 'CROSS_BORDER_SETTINGS_READ_SUPERSEDED';",
      'assertCrossBorderReadCurrent(task, accountId);',
      'assertCrossBorderReadCurrent(task, getCrossBorderLocalApiAccountId(canonicalSettings));',
      'if (crossBorderSettingsMemory === task.memoryAtStart) crossBorderSettingsMemory = canonicalSettings;',
    ],
  },
];

export const ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS = Object.freeze(reviewedFacts.map((fact) => Object.freeze({
  ...fact,
  id: `owner-runtime-source:${fact.sourceSymbol}`,
  kind: 'set',
  declaration: `const ${fact.sourceSymbol} = new Set();`,
  disposition: 'quiesce exact owner and preserve other owners',
  preserveSystem: false,
  lifetime: 'pending work only; settled tasks leave the Set; task exclusions survive owner-fence release',
  requiredSourceStatements: Object.freeze(fact.requiredSourceStatements),
  rendererBinding: Object.freeze({
    ...rendererBinding,
    requiredSourceStatements: Object.freeze([
      ...rendererBinding.requiredSourceStatements,
      ...(fact.ownerType === 'ozon_shop' ? [
        "if (owner.ownerType === 'ozon_shop') {",
        `${fact.barrierEntryPoint}(owner.ownerId),`,
        `${fact.releaseEntryPoint}(owner.ownerId);`,
      ] : [
        "} else if (owner.ownerType === 'cross_border_bus') {",
        `drains = [await ${fact.barrierEntryPoint}(owner.ownerId)];`,
        `} else if (owner.ownerType === 'cross_border_bus') ${fact.releaseEntryPoint}(owner.ownerId);`,
      ]),
    ]),
  }),
})));

// The supplemental discovery scope is deliberately these six reviewed symbols,
// not a blanket exemption for names containing task/read, or for arbitrary Sets.
export function discoverAccountOwnershipOwnerRuntimeSourceFacts(sourceByFile) {
  const symbols = new Set(ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS.map((fact) => fact.sourceSymbol));
  const facts = [];
  for (const [sourceFile, source] of sourceByFile || []) {
    if (/\.(?:test|spec)\.[cm]?jsx?$/iu.test(sourceFile)) continue;
    if (typeof source !== 'string') continue;
    const pattern = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+(Set|Map)\([^\r\n]*\);[^\S\r\n]*$/gmu;
    for (const match of source.matchAll(pattern)) {
      if (!symbols.has(match[1])) continue;
      facts.push(Object.freeze({ sourceFile, sourceSymbol: match[1], kind: match[2].toLowerCase(), declaration: match[0].trim() }));
    }
  }
  return Object.freeze(facts);
}

function sourceMatchesBinding(source, binding, requiredSourceStatements) {
  if (typeof source !== 'string' || createHash('sha256').update(source, 'utf8').digest('hex').toUpperCase() !== binding.sourceSHA256) return false;
  const lines = source.replace(/\/\*[\s\S]*?\*\//gu, '').split(/\r\n|\n|\r/u).map((line) => line.trim());
  return requiredSourceStatements.every((statement) => {
    const index = lines.indexOf(statement);
    if (index < 0) return false;
    lines.splice(index, 1);
    return true;
  });
}

export function verifyAccountOwnershipOwnerRuntimeSourceFacts({ sourceByFile, discoveredStateFacts, catalog } = {}) {
  const discoveries = discoveredStateFacts || discoverAccountOwnershipOwnerRuntimeSourceFacts(sourceByFile);
  const reviewed = ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS;
  if (discoveries.length !== reviewed.length) {
    throw new Error('ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACT_DRIFT:discovery-count');
  }
  return Object.freeze(reviewed.map((fact) => {
    const matching = discoveries.filter((discovery) => discovery.sourceFile === fact.sourceFile
      && discovery.sourceSymbol === fact.sourceSymbol && discovery.kind === fact.kind && discovery.declaration === fact.declaration);
    const ownerResource = catalog?.find((entry) => entry.id === fact.ownerResourceId);
    if (matching.length !== 1 || !ownerResource || ownerResource.ownerType !== fact.ownerType
      || ownerResource.availability !== 'current'
      || !sourceMatchesBinding(sourceByFile?.get(fact.sourceFile), fact, [fact.declaration, ...fact.requiredSourceStatements])
      || !sourceMatchesBinding(sourceByFile?.get(fact.rendererBinding.sourceFile), fact.rendererBinding, fact.rendererBinding.requiredSourceStatements)) {
      const error = new Error(`ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACT_DRIFT:${fact.id}`);
      error.code = 'ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACT_DRIFT';
      error.resourceId = fact.id;
      throw error;
    }
    return Object.freeze({ ...fact, discovery: matching[0], version: ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS_VERSION });
  }));
}
