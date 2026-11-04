import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { getAccountOwnershipCatalog } from './accountOwnershipCatalog.js';
import {
  ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY,
  ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_CATALOG_BASELINE_SHA256,
  ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_V2_LEDGER_SHA256,
  ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_VERSION,
  ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_COMPATIBILITY,
  currentAccountOwnershipPrimarySourceCompatibility,
} from './accountOwnershipAnchorOverlay.js';
import {
  ACCOUNT_OWNERSHIP_CERTIFICATE_CURRENT_COUNT,
  ACCOUNT_OWNERSHIP_CERTIFICATE_FROZEN_RESOURCE_COUNT,
  ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_COUNT,
  assertCatalogBaseline,
  assertOverlayMatchesFrozenV2,
  collectAnchorMismatches,
  compareCodePointStrings,
  createAccountOwnershipCertificate,
  createDefaultAccountOwnershipCertificate,
  readFrozenB0V2Ledger,
  verifyPrimaryAnchorAgainstSource,
} from './accountOwnershipCertificate.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const localApiRoot = resolve(moduleDirectory, '../../..');
const workspaceRoot = resolve(localApiRoot, '..');
const catalogFile = resolve(moduleDirectory, 'accountOwnershipCatalog.js');
const certificateFile = resolve(moduleDirectory, 'accountOwnershipCertificate.js');

function sortedIds(values) {
  return [...values].sort(compareCodePointStrings);
}

function clone(value) {
  return structuredClone(value);
}

function readCurrentSourceText({ absoluteSourceFile }) {
  return readFileSync(absoluteSourceFile, 'utf8');
}

function withPrimaryAnchor(entry, changes) {
  const next = clone(entry);
  Object.assign(next.primaryAnchor, changes);
  return next;
}

test('B0 local overlay exactly replaces the 76 strict v2 anchor failures', () => {
  const catalog = getAccountOwnershipCatalog();
  const current = catalog.filter((entry) => entry.availability === 'current');
  const frozen = readFrozenB0V2Ledger();
  const evidence = assertOverlayMatchesFrozenV2({ catalog, overlay: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY });
  const overlayIds = sortedIds(ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY.map((entry) => entry.id));

  assert.equal(current.length, ACCOUNT_OWNERSHIP_CERTIFICATE_CURRENT_COUNT);
  assert.equal(ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY.length, ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_COUNT);
  assert.equal(current.length - ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY.length, 267, 'current unchanged count includes reviewed versioned registry and system-resource extensions and remains distinct from repo-wide frozen unchanged count');
  assert.equal(frozen.resources.length, ACCOUNT_OWNERSHIP_CERTIFICATE_FROZEN_RESOURCE_COUNT);
  assert.equal(frozen.resources.length - ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY.length, 257, 'repo-wide frozen unchanged count is distinct from current unchanged count');
  assert.equal(evidence.strictV2AnchorFailureCount, 76);
  assert.equal(evidence.currentUnchangedCount, 267);
  assert.equal(evidence.repoWideFrozenUnchangedCount, 257);
  assert.deepEqual(overlayIds, [...new Set(overlayIds)], 'overlay IDs must be unique');
  assert.deepEqual(overlayIds, evidence.strictV2AnchorFailureIds, 'overlay IDs must equal strict local v2 failures in both directions');
  assert.ok(overlayIds.every((id) => current.some((entry) => entry.id === id)), 'every overlay ID must be current Catalog');
  assert.equal(ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_V2_LEDGER_SHA256, 'EDFF68B271830BFEFE320D19774B3DE2B1FC61DF640FED1224D8C61D593B737C');
  assert.equal(assertCatalogBaseline(), ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_CATALOG_BASELINE_SHA256);
  assert.equal(
    createHash('sha256').update(readFileSync(catalogFile)).digest('hex').toUpperCase(),
    ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_CATALOG_BASELINE_SHA256,
  );
});

test('B0 certificate is byte-deterministic and compact', () => {
  const catalog = getAccountOwnershipCatalog();
  const first = createAccountOwnershipCertificate({ catalog, overlay: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY });
  const second = createAccountOwnershipCertificate({ catalog, overlay: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY });
  const json = JSON.stringify(first);

  assert.equal(json, JSON.stringify(second));
  assert.equal(first.catalogCurrentCount, ACCOUNT_OWNERSHIP_CERTIFICATE_CURRENT_COUNT);
  assert.equal(first.overlayCount, 76);
  assert.equal(first.literalPassCount, 76);
  assert.equal(first.mismatchCount, collectAnchorMismatches(catalog, ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY).length);
  assert.equal(first.mismatchCount, 0);
  assert.deepEqual(first.duplicateIds, []);
  assert.deepEqual(first.missingIds, []);
  assert.deepEqual(first.unresolved, []);
  assert.equal(first.verdict, 'CONFIRMED');
  for (const sha of [first.catalogIdSHA256, first.overlayIdSHA256, first.anchorSHA256, first.mismatchSHA256]) {
    assert.match(sha, /^[A-F0-9]{64}$/u);
  }
  assert.doesNotMatch(json, /registry:shops|memory:local-api-hot-cache-shop-tag/u);
});

test('B0 verifies all 76 primary anchors against only their current source windows', () => {
  const results = ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY.map((entry) => (
    verifyPrimaryAnchorAgainstSource(entry.primaryAnchor, { readSourceText: readCurrentSourceText })
  ));

  assert.equal(results.length, ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_COUNT);
  assert.equal(results.filter((result) => result.exactLiteralFound).length, 76);
  assert.ok(results.every((result, index) => {
    const original = ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY[index].primaryAnchor;
    const reviewed = currentAccountOwnershipPrimarySourceCompatibility(original);
    return result.normalizedSourceFile === original.sourceFile
      && result.matchedLiteral === (reviewed?.currentSourceAnchor.sourceSymbol || original.sourceSymbol)
      && result.sourceCompatibilityVersion === (reviewed ? ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_VERSION : null)
      && result.parsedLines.length > 0
      && /^[A-F0-9]{64}$/u.test(result.sourceWindowSHA256);
  }));
  assert.equal(results.filter((result) => result.sourceCompatibilityVersion).length, 1);
});

test('B0 current-source compatibility binds the exact original identity and concrete owner checks without changing the 76 anchors', () => {
  const [reviewed] = ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_COMPATIBILITY;
  assert.equal(ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_COMPATIBILITY.length, 1);
  const entry = ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY.find((candidate) => candidate.id === reviewed.id);
  const original = clone(entry);
  const source = readCurrentSourceText({ absoluteSourceFile: resolve(workspaceRoot, reviewed.currentSourceAnchor.sourceFile) });
  const verification = verifyPrimaryAnchorAgainstSource(entry.primaryAnchor, { resourceId: entry.id });
  assert.deepEqual(entry, original);
  assert.equal(verification.matchedLiteral, reviewed.currentSourceAnchor.sourceSymbol);
  assert.equal(verification.sourceCompatibilityVersion, ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_VERSION);
  assert.equal(createDefaultAccountOwnershipCertificate().binding.currentPrimarySourceVersion, ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_VERSION);
  assert.equal(collectAnchorMismatches(getAccountOwnershipCatalog(), ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY).length, 0);
  for (const field of ['sourceFile', 'sourceSymbol', 'line', 'ownerBasis']) {
    assert.equal(currentAccountOwnershipPrimarySourceCompatibility({ ...entry.primaryAnchor, [field]: `${entry.primaryAnchor[field]}:unreviewed` }), null);
  }
  assert.equal(currentAccountOwnershipPrimarySourceCompatibility(entry.primaryAnchor, { resourceId: 'logical:another-owner-resource' }), null);
  for (const changedAnchor of [
    { ...entry.primaryAnchor, line: '1' },
    { ...entry.primaryAnchor, ownerBasis: 'a different owner selector' },
  ]) {
    assert.throws(() => verifyPrimaryAnchorAgainstSource(changedAnchor), /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LITERAL_MISSING/u);
  }
  for (const statement of [reviewed.currentSourceAnchor.sourceSymbol, ...reviewed.requiredSourceStatements]) {
    assert.ok(source.includes(statement));
    for (const replacement of [`/* ${statement} */`, `// ${statement}`]) {
      assert.throws(() => verifyPrimaryAnchorAgainstSource(entry.primaryAnchor, {
        readSourceText: () => source.replace(statement, replacement),
      }), /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_CURRENT_SOURCE_BEHAVIOR_MISSING/u, statement);
    }
  }
});

test('B0 fails closed for a wrong literal and injected source drift while relocating a unique literal', () => {
  const catalog = getAccountOwnershipCatalog();
  const target = ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY[0];

  const wrongLiteral = clone(ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY);
  wrongLiteral[0] = withPrimaryAnchor(target, { sourceSymbol: 'literal-that-does-not-exist-in-source' });
  assert.throws(
    () => createAccountOwnershipCertificate({ catalog, overlay: wrongLiteral }),
    /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LITERAL_MISSING/u,
  );

  const wrongLine = clone(ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY);
  wrongLine[0] = withPrimaryAnchor(target, { line: '1' });
  assert.ok(readFileSync(resolve(workspaceRoot, target.primaryAnchor.sourceFile), 'utf8').includes(target.primaryAnchor.sourceSymbol));
  assert.doesNotThrow(() => createAccountOwnershipCertificate({ catalog, overlay: wrongLine }));

  const driftedSourceReader = ({ normalizedSourceFile, absoluteSourceFile }) => {
    const source = readFileSync(absoluteSourceFile, 'utf8');
    return normalizedSourceFile === target.primaryAnchor.sourceFile
      ? source.replace(target.primaryAnchor.sourceSymbol, 'function databaseFamilyDrifted(databasePath) {')
      : source;
  };
  assert.throws(
    () => createDefaultAccountOwnershipCertificate({ readSourceText: driftedSourceReader }),
    /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LITERAL_MISSING/u,
  );
});

test('B0 rejects matching Catalog and Overlay tampering when the literal is absent from source', () => {
  const catalog = clone(getAccountOwnershipCatalog());
  const overlay = clone(ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY);
  const id = overlay[0].id;
  const wrongLiteral = 'catalog-and-overlay-agree-but-source-does-not';
  overlay[0].primaryAnchor.sourceSymbol = wrongLiteral;
  catalog.find((entry) => entry.id === id).sourceEvidence.sourceSymbol = wrongLiteral;

  assert.throws(
    () => createAccountOwnershipCertificate({ catalog, overlay, readSourceText: readCurrentSourceText }),
    /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LITERAL_MISSING/u,
  );
});

test('B0 rejects malformed line declarations and relocates a unique current literal', () => {
  const target = ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY[0].primaryAnchor;
  const cases = [
    ['0', 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LINE_INVALID'],
    ['2-1', 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LINE_INVALID'],
    ['3,2', 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LINE_INVALID'],
    ['1-2,2-3', 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LINE_INVALID'],
    ['1;2', 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LINE_INVALID'],
    ['1,,2', 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LINE_INVALID'],
  ];
  for (const [line, code] of cases) {
    assert.throws(
      () => verifyPrimaryAnchorAgainstSource({ ...target, line }, { readSourceText: readCurrentSourceText }),
      new RegExp(code, 'u'),
      line,
    );
  }
  assert.throws(
    () => verifyPrimaryAnchorAgainstSource({ ...target, line: '' }, { readSourceText: readCurrentSourceText }),
    /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_FIELDS_INVALID/u,
  );
  assert.doesNotThrow(
    () => verifyPrimaryAnchorAgainstSource({ ...target, line: '999999' }, { readSourceText: readCurrentSourceText }),
  );
  assert.doesNotThrow(
    () => verifyPrimaryAnchorAgainstSource({ ...target, line: '3' }, { readSourceText: readCurrentSourceText }),
  );
});

test('B0 rejects absolute, escaping, SQL, test-fixture, outside-root, and missing source paths', () => {
  const target = ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY[0].primaryAnchor;
  const invalidSourceFiles = [
    '../outside.js',
    'frontend/../../outside.js',
    'G:\\桌面端\\desktop\\src\\runtime\\recoveryDatabaseActivator.js',
    'C:\\outside\\source.js',
    '/outside/source.js',
    'local-api/src/db/migrations/004_create_ozon_scheduler_tables.sql',
    'local-api/src/domain/accountRemoval/accountOwnershipCertificate.test.js',
    'fixtures/fake-source.js',
  ];
  for (const sourceFile of invalidSourceFiles) {
    assert.throws(
      () => verifyPrimaryAnchorAgainstSource({ ...target, sourceFile }, { readSourceText: readCurrentSourceText }),
      /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_FILE_INVALID/u,
      sourceFile,
    );
  }
  assert.throws(
    () => verifyPrimaryAnchorAgainstSource(
      { ...target, sourceFile: 'local-api/src/definitely-missing-account-ownership-source.js' },
      { readSourceText: readCurrentSourceText },
    ),
    /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_READ_FAILED/u,
  );
});

test('B0 anchor evidence hash includes the actual source window and remains deterministic', () => {
  const catalog = getAccountOwnershipCatalog();
  const target = ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY[0].primaryAnchor;
  const baseline = createAccountOwnershipCertificate({ catalog, overlay: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY });
  const changedWindowReader = ({ normalizedSourceFile, absoluteSourceFile }) => {
    const source = readFileSync(absoluteSourceFile, 'utf8');
    return normalizedSourceFile === target.sourceFile
      ? source.replace(target.sourceSymbol, `${target.sourceSymbol} /* simulated non-literal drift */`)
      : source;
  };
  const drifted = createAccountOwnershipCertificate({
    catalog,
    overlay: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY,
    readSourceText: changedWindowReader,
  });

  assert.notEqual(drifted.anchorSHA256, baseline.anchorSHA256);
  assert.equal(
    JSON.stringify(drifted),
    JSON.stringify(createAccountOwnershipCertificate({
      catalog,
      overlay: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY,
      readSourceText: changedWindowReader,
    })),
  );
});

test('B0 certificate fails closed for duplicate, missing, illegal, and drifted anchors', () => {
  const catalog = getAccountOwnershipCatalog();
  const duplicate = clone(ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY);
  duplicate[duplicate.length - 1] = clone(duplicate[0]);
  assert.throws(
    () => createAccountOwnershipCertificate({ catalog, overlay: duplicate }),
    /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_DUPLICATE_ID/u,
  );

  assert.throws(
    () => createAccountOwnershipCertificate({ catalog, overlay: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY.slice(1) }),
    /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_COUNT_INVALID/u,
  );

  const missingFrozenOverlay = clone(ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY);
  const overlayIds = new Set(missingFrozenOverlay.map((entry) => entry.id));
  const replacement = catalog.find((entry) => entry.availability === 'current' && !overlayIds.has(entry.id));
  const replacementSourceLines = readFileSync(resolve(workspaceRoot, replacement.sourceEvidence.sourceFile), 'utf8').split(/\r?\n/u);
  const replacementLine = replacementSourceLines.findIndex((line) => line.includes(replacement.sourceEvidence.sourceSymbol)) + 1;
  assert.ok(replacementLine > 0, 'replacement anchor must otherwise be a valid exact source literal');
  missingFrozenOverlay[0] = {
    id: replacement.id,
    primaryAnchor: {
      ...clone(replacement.sourceEvidence),
      line: String(replacementLine),
    },
    secondaryAnchors: [],
  };
  assert.equal(collectAnchorMismatches(catalog, missingFrozenOverlay).length, 0, 'only the frozen bidirectional ID gate should reject this otherwise-valid replacement');
  assert.throws(
    () => assertOverlayMatchesFrozenV2({ catalog, overlay: missingFrozenOverlay }),
    /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_FROZEN_ID_MISMATCH/u,
  );
  assert.throws(
    () => createAccountOwnershipCertificate({ catalog, overlay: missingFrozenOverlay }),
    /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_FROZEN_ID_MISMATCH/u,
  );

  const illegalPrimary = clone(ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY);
  illegalPrimary[0].primaryAnchor.sourceFile = 'local-api/src/db/migrations/004_create_ozon_scheduler_tables.sql';
  assert.throws(
    () => createAccountOwnershipCertificate({ catalog, overlay: illegalPrimary }),
    /ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_FILE_INVALID/u,
  );

  const driftedCatalog = clone(catalog);
  driftedCatalog.find((entry) => entry.id === ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY[0].id).sourceEvidence.sourceSymbol = 'drifted source symbol';
  assert.throws(
    () => createAccountOwnershipCertificate({ catalog: driftedCatalog, overlay: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY }),
    /ACCOUNT_OWNERSHIP_CERTIFICATE_ANCHOR_MISMATCH/u,
  );
});

test('B0 certificate CLI emits one compact certificate line only', () => {
  const result = spawnSync(process.execPath, [certificateFile, '--certificate'], {
    cwd: localApiRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trimEnd().split(/\r?\n/gu);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), createDefaultAccountOwnershipCertificate());
  assert.doesNotMatch(lines[0], /registry:shops|memory:local-api-hot-cache-shop-tag/u);
  assert.ok(lines[0].length < 1200, 'CLI must not leak the overlay or mappings');
});
