import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccountOwnershipCatalog } from './accountOwnershipCatalog.js';
import {
  ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY,
  ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_CATALOG_BASELINE_SHA256,
  ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_V2_LEDGER_SHA256,
  ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_VERSION,
  ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_VERSION,
  currentAccountOwnershipPrimarySourceCompatibility,
  missingAccountOwnershipPrimarySourceStatements,
} from './accountOwnershipAnchorOverlay.js';

const { readFileSync, realpathSync } = process.getBuiltinModule('fs');

export const ACCOUNT_OWNERSHIP_CERTIFICATE_VERSION = 'phase-b-account-ownership-certificate-v15';
export const ACCOUNT_OWNERSHIP_CERTIFICATE_RULES_VERSION = 'phase-b-account-ownership-anchor-rules-v6';
export const ACCOUNT_OWNERSHIP_CERTIFICATE_CURRENT_COUNT = 343;
export const ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_COUNT = 76;
export const ACCOUNT_OWNERSHIP_CERTIFICATE_FROZEN_RESOURCE_COUNT = 333;
export const ACCOUNT_OWNERSHIP_CERTIFICATE_FROZEN_FAILURE_ID_SHA256 = '208DE6EDB61FB94E83AD31EFCA7D6C6807DD8CBB1BA2795D82049A5A7B80F135';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(moduleDirectory, '../../../..');
const catalogFile = resolve(moduleDirectory, 'accountOwnershipCatalog.js');
const frozenLedgerFile = resolve(moduleDirectory, 'accountOwnershipCatalog.test.js');
const PRIMARY_SOURCE_ROOTS = new Set(['desktop', 'frontend', 'local-api']);
const PRIMARY_SOURCE_EXTENSION = /\.(?:js|jsx|json)$/u;
const PRIMARY_SOURCE_TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'fixture', 'fixtures', '__fixtures__']);
const PRIMARY_SOURCE_TEST_FILE = /\.(?:test|spec|fixture)\.(?:js|jsx|json)$/u;

function certificateError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function assertCertificate(condition, code) {
  if (!condition) throw certificateError(code);
}

function isNonEmptyText(value) {
  return typeof value === 'string' && value.length > 0;
}

export function compareCodePointStrings(left, right) {
  const leftPoints = Array.from(String(left));
  const rightPoints = Array.from(String(right));
  const limit = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < limit; index += 1) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function sortedCodePoint(values) {
  return [...values].sort(compareCodePointStrings);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function canonicalString(value) {
  return JSON.stringify(value);
}

function canonicalStringArray(values) {
  return `[${values.map((value) => canonicalString(value)).join(',')}]`;
}

export function normalizeSourceFile(value) {
  assertCertificate(isNonEmptyText(value), 'ACCOUNT_OWNERSHIP_CERTIFICATE_SOURCE_FILE_INVALID');
  return value.replaceAll('\\', '/').replace(/^G:\/桌面端\//iu, '');
}

function isDescendantPath(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot.length > 0
    && pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot)
  );
}

function normalizePrimarySourceFile(value) {
  assertCertificate(isNonEmptyText(value), 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_FILE_INVALID');
  assertCertificate(value === value.trim(), 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_FILE_INVALID');
  assertCertificate(!isAbsolute(value), 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_FILE_INVALID');
  const normalized = value.replaceAll('\\', '/');
  assertCertificate(!/^(?:[A-Za-z]:|\/)/u.test(normalized), 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_FILE_INVALID');
  const segments = normalized.split('/');
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  assertCertificate(
    PRIMARY_SOURCE_ROOTS.has(segments[0])
    && segments.length > 1
    && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    && PRIMARY_SOURCE_EXTENSION.test(normalized)
    && !lowerSegments.some((segment) => PRIMARY_SOURCE_TEST_SEGMENTS.has(segment))
    && !PRIMARY_SOURCE_TEST_FILE.test(lowerSegments.at(-1)),
    'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_FILE_INVALID',
  );
  const allowedRoot = resolve(workspaceRoot, segments[0]);
  const absoluteSourceFile = resolve(workspaceRoot, ...segments);
  assertCertificate(
    isDescendantPath(allowedRoot, absoluteSourceFile),
    'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_FILE_INVALID',
  );
  return { normalizedSourceFile: normalized, absoluteSourceFile, allowedRoot };
}

function parsePrimaryAnchorLineRanges(value) {
  assertCertificate(
    typeof value === 'string' && /^(?:[1-9]\d*)(?:-(?:[1-9]\d*))?(?:,(?:[1-9]\d*)(?:-(?:[1-9]\d*))?)*$/u.test(value),
    'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LINE_INVALID',
  );
  const ranges = [];
  let previousLast = 0;
  for (const part of value.split(',')) {
    const [firstText, lastText = firstText] = part.split('-');
    const first = Number(firstText);
    const last = Number(lastText);
    assertCertificate(
      Number.isSafeInteger(first)
        && Number.isSafeInteger(last)
        && first > previousLast
        && last >= first,
      'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LINE_INVALID',
    );
    ranges.push(Object.freeze({ first, last }));
    previousLast = last;
  }
  return Object.freeze(ranges);
}

function splitSourceLines(sourceText) {
  if (sourceText.length === 0) return [];
  const lines = sourceText.split(/\r\n|\n|\r/u);
  if (lines.at(-1) === '' && /(?:\r\n|\n|\r)$/u.test(sourceText)) lines.pop();
  return lines;
}

function defaultReadSourceText({ absoluteSourceFile }) {
  return readFileSync(absoluteSourceFile, 'utf8');
}

export function verifyPrimaryAnchorAgainstSource(primaryAnchor, { readSourceText = defaultReadSourceText, resourceId } = {}) {
  assertCertificate(
    primaryAnchor
      && !Array.isArray(primaryAnchor)
      && isNonEmptyText(primaryAnchor.sourceFile)
      && isNonEmptyText(primaryAnchor.sourceSymbol)
      && isNonEmptyText(primaryAnchor.line)
      && isNonEmptyText(primaryAnchor.ownerBasis),
    'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_FIELDS_INVALID',
  );
  assertCertificate(typeof readSourceText === 'function', 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_READER_INVALID');
  // Validate the immutable input before consulting an exact reviewed binding.
  normalizePrimarySourceFile(primaryAnchor.sourceFile);
  parsePrimaryAnchorLineRanges(primaryAnchor.line);
  const compatibility = currentAccountOwnershipPrimarySourceCompatibility(primaryAnchor, { resourceId });
  const sourceAnchor = compatibility?.currentSourceAnchor || primaryAnchor;
  const sourceLocation = normalizePrimarySourceFile(sourceAnchor.sourceFile);
  const ranges = parsePrimaryAnchorLineRanges(sourceAnchor.line);
  let realSourceFile;
  try {
    const realAllowedRoot = realpathSync(sourceLocation.allowedRoot);
    realSourceFile = realpathSync(sourceLocation.absoluteSourceFile);
    assertCertificate(
      isDescendantPath(realAllowedRoot, realSourceFile),
      'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_FILE_INVALID',
    );
  } catch (error) {
    if (error?.code?.startsWith('ACCOUNT_OWNERSHIP_CERTIFICATE_')) throw error;
    throw certificateError('ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_READ_FAILED');
  }

  let sourceText;
  try {
    sourceText = readSourceText(Object.freeze({
      normalizedSourceFile: sourceLocation.normalizedSourceFile,
      absoluteSourceFile: realSourceFile,
    }));
  } catch {
    throw certificateError('ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_READ_FAILED');
  }
  assertCertificate(
    typeof sourceText === 'string',
    'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_READ_FAILED',
  );

  const sourceLines = splitSourceLines(sourceText);
  const configuredInRange = ranges.every(({ last }) => last <= sourceLines.length);
  const configuredLines = configuredInRange
    ? ranges.flatMap(({ first, last }) => (
        Array.from({ length: last - first + 1 }, (_, index) => first + index)
      ))
    : [];
  const configuredSourceWindow = configuredLines.map((line) => sourceLines[line - 1]).join('\n');
  let parsedLines = configuredLines;
  let sourceWindow = configuredSourceWindow;

  if (!sourceWindow.includes(sourceAnchor.sourceSymbol)) {
    const firstIndex = sourceText.indexOf(sourceAnchor.sourceSymbol);
    const uniqueLiteral = firstIndex >= 0
      && sourceText.indexOf(sourceAnchor.sourceSymbol, firstIndex + sourceAnchor.sourceSymbol.length) < 0;
    if (uniqueLiteral) {
      const relocatedLine = sourceText.slice(0, firstIndex).split(/\r\n|\n|\r/u).length;
      parsedLines = [relocatedLine];
      sourceWindow = sourceLines[relocatedLine - 1] || sourceAnchor.sourceSymbol;
    } else {
      assertCertificate(
        configuredInRange,
        'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LINE_OUT_OF_RANGE',
      );
      assertCertificate(
        configuredSourceWindow.split('\n').some((line) => line.trim().length > 0),
        'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_SOURCE_WINDOW_EMPTY',
      );
      throw certificateError('ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_LITERAL_MISSING');
    }
  }
  if (compatibility) {
    assertCertificate(
      missingAccountOwnershipPrimarySourceStatements(compatibility, sourceWindow).length === 0,
      'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_CURRENT_SOURCE_BEHAVIOR_MISSING',
    );
  }
  return Object.freeze({
    normalizedSourceFile: sourceLocation.normalizedSourceFile,
    parsedLines: Object.freeze(parsedLines),
    sourceWindowSHA256: sha256(sourceWindow),
    matchedLiteral: sourceAnchor.sourceSymbol,
    sourceCompatibilityVersion: compatibility ? ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_VERSION : null,
    exactLiteralFound: true,
  });
}

function canonicalAnchor(anchor) {
  return `{"sourceFile":${canonicalString(normalizeSourceFile(anchor.sourceFile))},"sourceSymbol":${canonicalString(anchor.sourceSymbol)},"line":${canonicalString(anchor.line)},"ownerBasis":${canonicalString(anchor.ownerBasis)}}`;
}

function canonicalVerifiedAnchor({ entry, verification }) {
  return `{"id":${canonicalString(entry.id)},"primaryAnchor":${canonicalAnchor(entry.primaryAnchor)},"matchedLiteral":${canonicalString(verification.matchedLiteral)},"sourceCompatibilityVersion":${canonicalString(verification.sourceCompatibilityVersion)},"parsedLines":[${verification.parsedLines.join(',')}],"sourceWindowSHA256":${canonicalString(verification.sourceWindowSHA256)}}`;
}

function canonicalMismatchRecord(record) {
  const actual = record.actual;
  const target = record.target;
  return `{"id":${canonicalString(record.id)},"actual":{"sourceFile":${canonicalString(actual.sourceFile)},"sourceSymbol":${canonicalString(actual.sourceSymbol)},"ownerBasis":${canonicalString(actual.ownerBasis)}},"target":{"sourceFile":${canonicalString(target.sourceFile)},"sourceSymbol":${canonicalString(target.sourceSymbol)},"ownerBasis":${canonicalString(target.ownerBasis)}}}`;
}

function canonicalObjectArray(values, canonicalize) {
  return `[${values.map((value) => canonicalize(value)).join(',')}]`;
}

function extractCurrentCatalog(catalog) {
  assertCertificate(Array.isArray(catalog), 'ACCOUNT_OWNERSHIP_CERTIFICATE_CATALOG_INVALID');
  const current = catalog.filter((entry) => entry?.availability === 'current');
  assertCertificate(current.length === ACCOUNT_OWNERSHIP_CERTIFICATE_CURRENT_COUNT, 'ACCOUNT_OWNERSHIP_CERTIFICATE_CURRENT_COUNT_INVALID');

  const byId = new Map();
  for (const entry of current) {
    assertCertificate(isNonEmptyText(entry?.id), 'ACCOUNT_OWNERSHIP_CERTIFICATE_CATALOG_INVALID');
    assertCertificate(!byId.has(entry.id), 'ACCOUNT_OWNERSHIP_CERTIFICATE_CATALOG_DUPLICATE_ID');
    const evidence = entry.sourceEvidence;
    assertCertificate(
      evidence
        && !Array.isArray(evidence)
        && isNonEmptyText(evidence.sourceFile)
        && isNonEmptyText(evidence.sourceSymbol)
        && isNonEmptyText(evidence.ownerBasis),
      'ACCOUNT_OWNERSHIP_CERTIFICATE_CATALOG_SOURCE_EVIDENCE_INVALID',
    );
    byId.set(entry.id, entry);
  }
  return { current, byId };
}

function validatePrimaryAnchor(primaryAnchor) {
  assertCertificate(
    primaryAnchor
      && !Array.isArray(primaryAnchor)
      && isNonEmptyText(primaryAnchor.sourceFile)
      && isNonEmptyText(primaryAnchor.sourceSymbol)
      && isNonEmptyText(primaryAnchor.line)
      && isNonEmptyText(primaryAnchor.ownerBasis),
    'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_FIELDS_INVALID',
  );
  normalizePrimarySourceFile(primaryAnchor.sourceFile);
  parsePrimaryAnchorLineRanges(primaryAnchor.line);
}

function extractOverlay(overlay, currentById) {
  assertCertificate(Array.isArray(overlay), 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_INVALID');
  const byId = new Map();
  for (const entry of overlay) {
    assertCertificate(isNonEmptyText(entry?.id), 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_INVALID');
    assertCertificate(!byId.has(entry.id), 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_DUPLICATE_ID');
    validatePrimaryAnchor(entry.primaryAnchor);
    assertCertificate(Array.isArray(entry.secondaryAnchors) && entry.secondaryAnchors.length === 0, 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_SECONDARY_ANCHORS_INVALID');
    assertCertificate(currentById.has(entry.id), 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_UNKNOWN_ID');
    byId.set(entry.id, entry);
  }
  assertCertificate(byId.size === ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_COUNT, 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_COUNT_INVALID');
  return byId;
}

function verifyOverlayPrimaryAnchorsAgainstSource(overlayById, { readSourceText } = {}) {
  const verifiedAnchors = sortedCodePoint(overlayById.keys()).map((id) => {
    const entry = overlayById.get(id);
    try {
      return Object.freeze({
        entry,
        verification: verifyPrimaryAnchorAgainstSource(entry.primaryAnchor, { readSourceText, resourceId: id }),
      });
    } catch (error) {
      if (error && typeof error === 'object' && !error.resourceId) error.resourceId = id;
      throw error;
    }
  });
  const unresolvedIds = verifiedAnchors
    .filter(({ verification }) => !verification.exactLiteralFound)
    .map(({ entry }) => entry.id);
  assertCertificate(
    unresolvedIds.length === 0 && verifiedAnchors.length === overlayById.size,
    'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_UNRESOLVED',
  );
  return Object.freeze({
    verifiedAnchors: Object.freeze(verifiedAnchors),
    unresolvedIds: Object.freeze(unresolvedIds),
  });
}

function sourceEvidenceTriple(sourceEvidence) {
  return {
    sourceFile: normalizeSourceFile(sourceEvidence.sourceFile),
    sourceSymbol: sourceEvidence.sourceSymbol,
    ownerBasis: sourceEvidence.ownerBasis,
  };
}

function primaryAnchorTriple(primaryAnchor) {
  return {
    sourceFile: normalizeSourceFile(primaryAnchor.sourceFile),
    sourceSymbol: primaryAnchor.sourceSymbol,
    ownerBasis: primaryAnchor.ownerBasis,
  };
}

export function collectAnchorMismatches(catalog, overlay) {
  const { current, byId: currentById } = extractCurrentCatalog(catalog);
  const overlayById = extractOverlay(overlay, currentById);
  return sortedCodePoint(current.map((entry) => entry.id)).flatMap((id) => {
    const entry = currentById.get(id);
    const actual = sourceEvidenceTriple(entry.sourceEvidence);
    const target = overlayById.has(id)
      ? primaryAnchorTriple(overlayById.get(id).primaryAnchor)
      : actual;
    return (
      actual.sourceFile === target.sourceFile
      && actual.sourceSymbol === target.sourceSymbol
      && actual.ownerBasis === target.ownerBasis
    )
      ? []
      : [{ id, actual, target }];
  });
}

export function createAccountOwnershipCertificate({ catalog, overlay, readSourceText } = {}) {
  const { current, byId: currentById } = extractCurrentCatalog(catalog);
  const overlayById = extractOverlay(overlay, currentById);
  const catalogIds = sortedCodePoint(current.map((entry) => entry.id));
  const overlayEntries = sortedCodePoint([...overlayById.values()].map((entry) => entry.id)).map((id) => overlayById.get(id));
  const overlayIds = overlayEntries.map((entry) => entry.id);
  const sourceEvidence = verifyOverlayPrimaryAnchorsAgainstSource(overlayById, { readSourceText });
  const mismatches = collectAnchorMismatches(current, overlay);
  const mismatchCanonicalJson = canonicalObjectArray(mismatches, canonicalMismatchRecord);
  const literalPassCount = sourceEvidence.verifiedAnchors
    .filter(({ verification }) => verification.exactLiteralFound)
    .length;

  assertCertificate(literalPassCount === overlayEntries.length, 'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_PRIMARY_UNRESOLVED');
  assertCertificate(mismatches.length === 0, 'ACCOUNT_OWNERSHIP_CERTIFICATE_ANCHOR_MISMATCH');
  assertOverlayFrozenIdSet(overlayById);

  return Object.freeze({
    certificateVersion: ACCOUNT_OWNERSHIP_CERTIFICATE_VERSION,
    rulesVersion: ACCOUNT_OWNERSHIP_CERTIFICATE_RULES_VERSION,
    binding: Object.freeze({
      v2LedgerSHA256: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_V2_LEDGER_SHA256,
      catalogBaselineSHA256: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_CATALOG_BASELINE_SHA256,
      overlayVersion: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_VERSION,
      currentPrimarySourceVersion: ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_VERSION,
    }),
    catalogCurrentCount: current.length,
    catalogIdSHA256: sha256(canonicalStringArray(catalogIds)),
    overlayCount: overlayEntries.length,
    overlayIdSHA256: sha256(canonicalStringArray(overlayIds)),
    anchorSHA256: sha256(canonicalObjectArray(sourceEvidence.verifiedAnchors, canonicalVerifiedAnchor)),
    literalPassCount,
    mismatchCount: mismatches.length,
    mismatchSHA256: sha256(mismatchCanonicalJson),
    duplicateIds: Object.freeze([]),
    missingIds: Object.freeze([]),
    unresolved: sourceEvidence.unresolvedIds,
    verdict: 'CONFIRMED',
  });
}

export function readFrozenB0V2Ledger() {
  const source = readFileSync(frozenLedgerFile, 'utf8');
  const beginMarker = '<BEGIN_B0_LEDGER_JSON>';
  const endMarker = '<END_B0_LEDGER_JSON>';
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker, begin + beginMarker.length);
  assertCertificate(begin >= 0 && end > begin, 'ACCOUNT_OWNERSHIP_CERTIFICATE_FROZEN_LEDGER_MARKERS_INVALID');
  const rawLedger = source.slice(begin + beginMarker.length, end);
  assertCertificate(sha256(rawLedger) === ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_V2_LEDGER_SHA256, 'ACCOUNT_OWNERSHIP_CERTIFICATE_FROZEN_LEDGER_SHA256_INVALID');
  let ledger;
  try {
    ledger = JSON.parse(rawLedger);
  } catch {
    throw certificateError('ACCOUNT_OWNERSHIP_CERTIFICATE_FROZEN_LEDGER_INVALID');
  }
  assertCertificate(
    ledger?.ledgerVersion === 'phase-b-b0-frozen-ledger-v2'
      && Array.isArray(ledger.resources)
      && ledger.resources.length === ACCOUNT_OWNERSHIP_CERTIFICATE_FROZEN_RESOURCE_COUNT,
    'ACCOUNT_OWNERSHIP_CERTIFICATE_FROZEN_LEDGER_INVALID',
  );
  return ledger;
}

function assertOverlayFrozenIdSet(overlayById) {
  const ledger = readFrozenB0V2Ledger();
  const overlayIds = sortedCodePoint(overlayById.keys());
  const frozenResourceIds = new Set(ledger.resources.map((resource) => resource.id));
  assertCertificate(
    overlayIds.length === ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_COUNT
      && overlayIds.every((id) => frozenResourceIds.has(id))
      && sha256(canonicalStringArray(overlayIds)) === ACCOUNT_OWNERSHIP_CERTIFICATE_FROZEN_FAILURE_ID_SHA256,
    'ACCOUNT_OWNERSHIP_CERTIFICATE_OVERLAY_FROZEN_ID_MISMATCH',
  );
  return Object.freeze({ ledger, frozenFailureIds: Object.freeze(overlayIds) });
}

export function assertOverlayMatchesFrozenV2({
  catalog = getAccountOwnershipCatalog(),
  overlay = ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY,
  readSourceText,
} = {}) {
  const { current, byId: currentById } = extractCurrentCatalog(catalog);
  const overlayById = extractOverlay(overlay, currentById);
  const { ledger, frozenFailureIds } = assertOverlayFrozenIdSet(overlayById);
  const sourceEvidence = verifyOverlayPrimaryAnchorsAgainstSource(overlayById, { readSourceText });
  return Object.freeze({
    frozenResourceCount: ledger.resources.length,
    catalogCurrentCount: current.length,
    strictV2AnchorFailureCount: frozenFailureIds.length,
    currentUnchangedCount: current.length - overlayById.size,
    repoWideFrozenUnchangedCount: ledger.resources.length - frozenFailureIds.length,
    strictV2AnchorFailureIds: Object.freeze(frozenFailureIds),
    literalPassCount: sourceEvidence.verifiedAnchors.length,
    unresolved: sourceEvidence.unresolvedIds,
  });
}

export function assertCatalogBaseline() {
  const catalogSha256 = sha256Bytes(readFileSync(catalogFile));
  assertCertificate(catalogSha256 === ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_CATALOG_BASELINE_SHA256, 'ACCOUNT_OWNERSHIP_CERTIFICATE_CATALOG_BASELINE_DRIFT');
  return catalogSha256;
}

export function createDefaultAccountOwnershipCertificate({ readSourceText } = {}) {
  assertCatalogBaseline();
  const catalog = getAccountOwnershipCatalog();
  assertOverlayMatchesFrozenV2({ catalog, overlay: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY, readSourceText });
  return createAccountOwnershipCertificate({ catalog, overlay: ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY, readSourceText });
}

function runCertificateCli() {
  if (process.argv.length !== 3 || process.argv[2] !== '--certificate') {
    throw certificateError('ACCOUNT_OWNERSHIP_CERTIFICATE_CLI_ARGUMENT_INVALID');
  }
  process.stdout.write(`${JSON.stringify(createDefaultAccountOwnershipCertificate())}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCertificateCli();
  } catch (error) {
    const code = error?.code || error?.message || 'ACCOUNT_OWNERSHIP_CERTIFICATE_CLI_FAILURE';
    const resource = isNonEmptyText(error?.resourceId) ? `:${error.resourceId}` : '';
    process.stderr.write(`${code}${resource}\n`);
    process.exitCode = 1;
  }
}
