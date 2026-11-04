#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanProtectedComputePackagingBoundary } from "../src/domain/protectedCompute/packageBoundaryAudit.js";
import { scanProtectedComputeSemanticBoundary } from "../../desktop/scripts/protected-compute-semantic-audit.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "../..");
const managementSystemRoot = process.env.LICENSE_CENTER_ROOT
  ? path.resolve(process.env.LICENSE_CENTER_ROOT)
  : path.resolve(projectRoot, "../管理系统");
const argumentsList = process.argv.slice(2);
const forcePackageMode = argumentsList.includes("--package");
const forceSourceMode = argumentsList.includes("--source");
if (forcePackageMode && forceSourceMode) {
  throw new Error("--package and --source cannot be used together");
}
const explicitRoots = argumentsList
  .filter((value) => !value.startsWith("--"))
  .map((value) => path.resolve(value));

const defaultSourceRoots = [
  path.join(projectRoot, "frontend", "src"),
  path.join(projectRoot, "desktop", "src"),
  path.join(projectRoot, "local-api", "src"),
  path.join(projectRoot, "standalone"),
];
const defaultArtifactRoots = [
  path.join(projectRoot, "frontend", "dist"),
  path.join(projectRoot, "desktop", "dist"),
  path.join(projectRoot, "desktop", "release"),
];

function looksLikePackageArtifact(root) {
  const normalized = path.resolve(root).replace(/\\/gu, "/").toLowerCase();
  return (
    /\/(?:dist|release|resources|win-unpacked)(?:\/|$)/u.test(normalized)
    || /\.asar(?:\/|$)/u.test(normalized)
    || /\.wasm$/u.test(normalized)
    || normalized.includes("app.asar.unpacked")
  );
}

let sourceRoots;
let artifactRoots;
if (!explicitRoots.length) {
  sourceRoots = forcePackageMode ? [] : defaultSourceRoots;
  artifactRoots = forceSourceMode ? [] : defaultArtifactRoots;
} else if (forcePackageMode) {
  sourceRoots = [];
  artifactRoots = explicitRoots;
} else if (forceSourceMode) {
  sourceRoots = explicitRoots;
  artifactRoots = [];
} else {
  sourceRoots = explicitRoots.filter((root) => !looksLikePackageArtifact(root));
  artifactRoots = explicitRoots.filter((root) => looksLikePackageArtifact(root));
}
const clientRoots = [...sourceRoots, ...artifactRoots];

const fingerprintBoundary = await scanProtectedComputePackagingBoundary({
  clientRoots,
  includeIgnoredDirectories: true,
  serverCoreRoot: path.join(
    managementSystemRoot,
    "backend",
    "app",
    "protected_compute",
    "core",
  ),
});

const semanticResults = await Promise.all([
  sourceRoots.length
    ? scanProtectedComputeSemanticBoundary({
        clientRoots: sourceRoots,
        packageMode: false,
        excludeTestFixtures: true,
      })
    : null,
  artifactRoots.length
    ? scanProtectedComputeSemanticBoundary({
        clientRoots: artifactRoots,
        packageMode: true,
        excludeTestFixtures: false,
      })
    : null,
]);
const activeSemanticResults = semanticResults.filter(Boolean);
const semanticBoundary = {
  ok: activeSemanticResults.every((result) => result.ok),
  roots: clientRoots,
  packageMode: sourceRoots.length && artifactRoots.length ? "mixed" : artifactRoots.length > 0,
  scannedUnitCount: activeSemanticResults.reduce((sum, result) => sum + result.scannedUnitCount, 0),
  duplicateUnitCount: activeSemanticResults.reduce((sum, result) => sum + result.duplicateUnitCount, 0),
  prefilteredUnitCount: activeSemanticResults.reduce((sum, result) => sum + result.prefilteredUnitCount, 0),
  findings: activeSemanticResults
    .flatMap((result) => result.findings)
    .sort((left, right) => `${left.file}:${left.code}`.localeCompare(`${right.file}:${right.code}`)),
};
const result = {
  ok: fingerprintBoundary.ok && semanticBoundary.ok,
  roots: clientRoots,
  sourceRoots,
  artifactRoots,
  scannedFileCount: fingerprintBoundary.scannedFileCount,
  semanticScannedUnitCount: semanticBoundary.scannedUnitCount,
  semanticDuplicateUnitCount: semanticBoundary.duplicateUnitCount,
  semanticPrefilteredUnitCount: semanticBoundary.prefilteredUnitCount,
  findings: [...fingerprintBoundary.findings, ...semanticBoundary.findings],
  fingerprintBoundary,
  semanticBoundary,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
