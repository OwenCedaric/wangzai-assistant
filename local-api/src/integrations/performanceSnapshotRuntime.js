import { createPerformanceSnapshotRepository } from '../db/repositories/performanceSnapshotRepository.js';

let repository = null;

export function configurePerformanceSnapshotRuntime(db) {
  if (!db) return null;
  repository = createPerformanceSnapshotRepository(db);
  return repository;
}

export function readPerformanceSnapshot(payload = {}) {
  return repository?.readBestSnapshot(payload) || null;
}

export function savePerformanceSnapshot(payload = {}, overview = {}) {
  try {
    return repository?.saveSnapshot(payload, overview) || null;
  } catch {
    // Snapshot persistence accelerates the next screen only. A busy/readonly
    // SQLite cache must never turn a successful live Performance read into an
    // API failure.
    return null;
  }
}

