import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".pytest_cache",
  ".ruff_cache",
  "node_modules",
  "__pycache__",
]);
const PRIVATE_KEY_MARKERS = Object.freeze(
  ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY"].map(
    (label) => `-----BEGIN ${label}-----`,
  ),
);
const LONG_TOKEN_PATTERN =
  /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?:$|[^A-Za-z0-9_-])/u;
const PROTECTED_TOKEN_ASSIGNMENT_PATTERN =
  /(?:PROTECTED_COMPUTE|LICENSE_CENTER)_(?:ACCESS|LONG_LIVED)_TOKEN\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{24,}/iu;

function isTestFixturePath(file) {
  return /(?:^|[\\/])(?:__tests__|test|tests|fixtures?)(?:[\\/]|$)|\.(?:test|spec)\.[^.]+$/iu.test(
    file,
  );
}

async function collectFiles(
  root,
  output,
  { excludeTestFixtures = false, includeIgnoredDirectories = false } = {},
) {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    return;
  }
  if (rootStat.isFile()) {
    if (!excludeTestFixtures || !isTestFixturePath(root)) {
      output.push(path.resolve(root));
    }
    return;
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !includeIgnoredDirectories &&
      entry.isDirectory() &&
      IGNORED_DIRECTORIES.has(entry.name)
    ) {
      continue;
    }
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!excludeTestFixtures || !isTestFixturePath(target)) {
        await collectFiles(target, output, {
          excludeTestFixtures,
          includeIgnoredDirectories,
        });
      }
    } else if (
      entry.isFile() &&
      (!excludeTestFixtures || !isTestFixturePath(target))
    ) {
      output.push(path.resolve(target));
    }
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readServerFingerprints(serverCoreRoot) {
  const files = [];
  await collectFiles(serverCoreRoot, files);
  const markers = new Set();
  const symbols = new Set();
  const hashes = new Set();
  for (const file of files) {
    const buffer = await readFile(file);
    hashes.add(sha256(buffer));
    const text = buffer.toString("utf8");
    for (const match of text.matchAll(/PROTECTED_CORE_ONLY::([^\s"']+)/gu)) {
      markers.add(`PROTECTED_CORE_ONLY::${match[1]}`);
    }
    for (const match of text.matchAll(/^(_POLICY_[A-Z0-9_]+)\s*=/gmu)) {
      symbols.add(match[1]);
    }
  }
  if (!markers.size || !symbols.size) {
    throw new Error(
      "Protected-compute server core is missing auditable confidentiality markers.",
    );
  }
  return { hashes, markers, symbols };
}

async function scanLargeFile(file, needles) {
  const digest = createHash("sha256");
  const found = new Set();
  const carryLength = Math.max(...needles.map((value) => value.length), 1) - 1;
  let carry = "";
  let longTokenFound = false;
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
    const text = carry + chunk.toString("latin1");
    for (const needle of needles) {
      if (!found.has(needle) && text.includes(needle)) found.add(needle);
    }
    if (
      !longTokenFound &&
      (LONG_TOKEN_PATTERN.test(text) ||
        PROTECTED_TOKEN_ASSIGNMENT_PATTERN.test(text))
    ) {
      longTokenFound = true;
    }
    carry = text.slice(-carryLength);
  }
  return { digest: digest.digest("hex"), found, longTokenFound };
}

export async function scanProtectedComputePackagingBoundary({
  clientRoots,
  serverCoreRoot,
  maxFileBytes = 50 * 1024 * 1024,
  includeIgnoredDirectories = false,
}) {
  const roots = [...new Set((clientRoots || []).map((value) => path.resolve(value)))];
  if (!roots.length) throw new Error("At least one client/package root is required.");
  const server = await readServerFingerprints(path.resolve(serverCoreRoot));
  const files = [];
  for (const root of roots) {
    const base = path.basename(root).toLowerCase();
    await collectFiles(root, files, {
      excludeTestFixtures: base === "src" || base === "standalone",
      includeIgnoredDirectories,
    });
  }
  const findings = [];
  for (const file of files) {
    const fileStat = await stat(file);
    if (fileStat.size > maxFileBytes) {
      const needles = [
        ...PRIVATE_KEY_MARKERS,
        ...server.markers,
        ...server.symbols,
      ];
      const scanned = await scanLargeFile(file, needles);
      for (const marker of PRIVATE_KEY_MARKERS) {
        if (scanned.found.has(marker)) {
          findings.push({
            code: "PROTECTED_COMPUTE_PRIVATE_KEY_LEAK",
            file,
            evidence: marker,
          });
        }
      }
      for (const marker of server.markers) {
        if (scanned.found.has(marker)) {
          findings.push({
            code: "PROTECTED_COMPUTE_CORE_MARKER_LEAK",
            file,
            evidence: marker,
          });
        }
      }
      for (const symbol of server.symbols) {
        if (scanned.found.has(symbol)) {
          findings.push({
            code: "PROTECTED_COMPUTE_CORE_SYMBOL_LEAK",
            file,
            evidence: symbol,
          });
        }
      }
      if (server.hashes.has(scanned.digest)) {
        findings.push({
          code: "PROTECTED_COMPUTE_CORE_FILE_LEAK",
          file,
          evidence: "exact server-core file fingerprint",
        });
      }
      if (scanned.longTokenFound) {
        findings.push({
          code: "PROTECTED_COMPUTE_LONG_TOKEN_LEAK",
          file,
          evidence: "JWT or protected-compute long-lived token literal",
        });
      }
      continue;
    }
    const buffer = await readFile(file);
    const text = buffer.toString("utf8");
    if (
      LONG_TOKEN_PATTERN.test(text) ||
      PROTECTED_TOKEN_ASSIGNMENT_PATTERN.test(text)
    ) {
      findings.push({
        code: "PROTECTED_COMPUTE_LONG_TOKEN_LEAK",
        file,
        evidence: "JWT or protected-compute long-lived token literal",
      });
    }
    for (const marker of PRIVATE_KEY_MARKERS) {
      if (text.includes(marker)) {
        findings.push({
          code: "PROTECTED_COMPUTE_PRIVATE_KEY_LEAK",
          file,
          evidence: marker,
        });
      }
    }
    for (const marker of server.markers) {
      if (text.includes(marker)) {
        findings.push({
          code: "PROTECTED_COMPUTE_CORE_MARKER_LEAK",
          file,
          evidence: marker,
        });
      }
    }
    for (const symbol of server.symbols) {
      if (text.includes(symbol)) {
        findings.push({
          code: "PROTECTED_COMPUTE_CORE_SYMBOL_LEAK",
          file,
          evidence: symbol,
        });
      }
    }
    if (server.hashes.has(sha256(buffer))) {
      findings.push({
        code: "PROTECTED_COMPUTE_CORE_FILE_LEAK",
        file,
        evidence: "exact server-core file fingerprint",
      });
    }
  }
  findings.sort((left, right) =>
    `${left.file}:${left.code}`.localeCompare(`${right.file}:${right.code}`),
  );
  return Object.freeze({
    ok: findings.length === 0,
    scannedFileCount: files.length,
    roots,
    serverCoreMarkerCount: server.markers.size,
    serverCoreSymbolCount: server.symbols.size,
    findings,
  });
}

export const protectedComputePackagePrivateKeyMarkers = PRIVATE_KEY_MARKERS;
