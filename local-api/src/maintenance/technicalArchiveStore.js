import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deriveScopedEncryptionKey } from '../security/secretCrypto.js';
import {
  buildTechnicalArchivePackage,
  decryptTechnicalArchivePackage,
  parseTechnicalArchivePackage,
  serializeTechnicalArchivePackage,
} from './technicalArchivePackage.js';

const ARCHIVE_EXTENSION = '.wzta';
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function ensureDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function syncDirectory(directory) {
  let descriptor = null;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is not exposed by every Windows filesystem. The archive
    // file itself is always fsynced before its hard-link is published.
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function archiveIdFromFileName(fileName) {
  const base = basename(String(fileName || ''));
  if (!base.endsWith(ARCHIVE_EXTENSION)) return null;
  const archiveId = base.slice(0, -ARCHIVE_EXTENSION.length);
  return ARCHIVE_ID_PATTERN.test(archiveId) ? archiveId : null;
}

function readAndVerify(filePath, encryptionKey) {
  const bytes = readFileSync(filePath);
  const archivePackage = parseTechnicalArchivePackage(bytes);
  const restored = decryptTechnicalArchivePackage({ archivePackage, encryptionKey });
  const fileArchiveId = archiveIdFromFileName(filePath);
  if (fileArchiveId && fileArchiveId !== restored.metadata.archiveId) {
    throw new Error('TECHNICAL_ARCHIVE_FILE_ID_MISMATCH');
  }
  return { filePath, bytes: bytes.length, ...restored };
}

export function createTechnicalArchiveStore({
  archiveDirectory,
  encryptionKey = deriveScopedEncryptionKey('technical-archive/encryption/v1'),
  dedupeKey = deriveScopedEncryptionKey('technical-archive/dedupe/v1'),
  logger = console,
} = {}) {
  const directory = String(archiveDirectory || '').trim();
  if (!directory) throw new Error('TECHNICAL_ARCHIVE_DIRECTORY_REQUIRED');
  ensureDirectory(directory);

  function pathForArchive(archiveId) {
    if (!ARCHIVE_ID_PATTERN.test(String(archiveId || ''))) throw new Error('TECHNICAL_ARCHIVE_ID_INVALID');
    return join(directory, `${archiveId}${ARCHIVE_EXTENSION}`);
  }

  function read(archiveId) {
    return readAndVerify(pathForArchive(archiveId), encryptionKey);
  }

  function archiveFilePaths() {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && archiveIdFromFileName(entry.name))
      .map((entry) => join(directory, entry.name));
  }

  function publish(input) {
    const archivePackage = buildTechnicalArchivePackage({ ...input, encryptionKey, dedupeKey });
    const finalPath = pathForArchive(archivePackage.archiveId);
    if (existsSync(finalPath)) {
      const existing = readAndVerify(finalPath, encryptionKey);
      if (existing.plainCanonicalSha256 !== archivePackage.encrypted.plainCanonicalSha256) {
        throw new Error('TECHNICAL_ARCHIVE_EXISTING_CONTENT_MISMATCH');
      }
      return { ok: true, created: false, archiveId: archivePackage.archiveId, filePath: finalPath, metadata: existing.metadata };
    }

    const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
    let descriptor = null;
    let linked = false;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, serializeTechnicalArchivePackage(archivePackage));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;

      const staged = readAndVerify(temporaryPath, encryptionKey);
      if (staged.metadata.archiveId !== archivePackage.archiveId) {
        throw new Error('TECHNICAL_ARCHIVE_STAGED_READBACK_FAILED');
      }
      try {
        // The completed inode becomes visible atomically and never overwrites
        // an archive published by a concurrent/restarted maintenance cycle.
        linkSync(temporaryPath, finalPath);
        linked = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      const published = readAndVerify(finalPath, encryptionKey);
      if (published.plainCanonicalSha256 !== staged.plainCanonicalSha256) {
        throw new Error('TECHNICAL_ARCHIVE_PUBLISHED_READBACK_FAILED');
      }
      syncDirectory(directory);
      return {
        ok: true,
        created: linked,
        archiveId: archivePackage.archiveId,
        filePath: finalPath,
        metadata: published.metadata,
      };
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  function inspectDirectory({ includeRecords = false } = {}) {
    const packages = [];
    const errors = [];
    for (const filePath of archiveFilePaths()) {
      try {
        const verified = readAndVerify(filePath, encryptionKey);
        packages.push(includeRecords
          ? verified
          : {
            filePath: verified.filePath,
            bytes: verified.bytes,
            metadata: verified.metadata,
            plainCanonicalSha256: verified.plainCanonicalSha256,
          });
      } catch (error) {
        errors.push({ filePath, code: String(error?.message || error) });
      }
    }
    packages.sort((left, right) => right.metadata.sourceTo.localeCompare(left.metadata.sourceTo));
    return { packages, errors };
  }

  function list({ archiveType, includeRecords = false } = {}) {
    const normalizedType = String(archiveType || '').trim();
    const inspected = inspectDirectory({ includeRecords });
    return inspected.packages.filter((item) => !normalizedType || item.metadata.archiveType === normalizedType);
  }

  function findRecords({ archiveType, predicate = () => true, limit = 500 } = {}) {
    const maximum = Math.max(1, Math.min(Number(limit) || 500, 2_000));
    const matches = [];
    const candidates = [];
    for (const filePath of archiveFilePaths()) {
      try {
        const archivePackage = parseTechnicalArchivePackage(readFileSync(filePath));
        if (!archiveType || archivePackage.archiveType === archiveType) {
          candidates.push({ filePath, metadata: archivePackage });
        }
      } catch (error) {
        logger.warn?.('[local-api][maintenance] invalid technical archive preserved', {
          filePath,
          code: String(error?.message || error),
        });
      }
    }
    candidates.sort((left, right) => right.metadata.sourceTo.localeCompare(left.metadata.sourceTo));
    for (const candidate of candidates) {
      try {
        const archivePackage = readAndVerify(candidate.filePath, encryptionKey);
        for (const record of archivePackage.records) {
          if (predicate(record.value, record, archivePackage.metadata)) matches.push(record.value);
          if (matches.length >= maximum) return matches;
        }
      } catch (error) {
        logger.warn?.('[local-api][maintenance] invalid technical archive preserved', {
          filePath: candidate.filePath,
          code: String(error?.message || error),
        });
      }
    }
    return matches;
  }

  function pruneExpired(referenceNow = new Date(), options = {}) {
    const reference = new Date(referenceNow);
    const nowIso = reference.toISOString();
    const maximumSourceAgeDays = Number(options.maxSourceAgeDays);
    const sourceCutoffMs = Number.isFinite(maximumSourceAgeDays) && maximumSourceAgeDays >= 0
      ? reference.getTime() - maximumSourceAgeDays * 86_400_000
      : Number.NEGATIVE_INFINITY;
    const requestedMaximumBytes = Number(options.maxTotalBytes);
    const maximumBytes = Number.isFinite(requestedMaximumBytes) && requestedMaximumBytes >= 0
      ? requestedMaximumBytes
      : Number.POSITIVE_INFINITY;
    const deleted = [];
    const errors = [];
    const retained = [];
    let retainedBytes = 0;
    for (const filePath of archiveFilePaths()) {
      try {
        const publicPackage = parseTechnicalArchivePackage(readFileSync(filePath));
        const sourceToMs = new Date(publicPackage.sourceTo).getTime();
        const expiredByPackage = publicPackage.expiresAt <= nowIso;
        const expiredByRetention = Number.isFinite(sourceToMs) && sourceToMs < sourceCutoffMs;
        if (expiredByPackage || expiredByRetention) {
          // Public metadata is only a prefilter. Every deletion still requires
          // authenticated decrypt/readback of the exact candidate package.
          const item = readAndVerify(filePath, encryptionKey);
          unlinkSync(item.filePath);
          deleted.push({
            archiveId: item.metadata.archiveId,
            bytes: item.bytes,
            expiresAt: item.metadata.expiresAt,
            reason: expiredByPackage ? 'expired' : 'retention-window',
          });
          continue;
        }
        const bytes = statSync(filePath).size;
        retained.push({ filePath, metadata: publicPackage, bytes });
        retainedBytes += bytes;
      } catch (error) {
        try { retainedBytes += statSync(filePath).size; } catch { /* missing file */ }
        errors.push({ filePath, code: String(error?.message || error) });
      }
    }

    retained.sort((left, right) =>
      left.metadata.sourceTo.localeCompare(right.metadata.sourceTo)
      || left.filePath.localeCompare(right.filePath));
    for (const candidate of retained) {
      if (retainedBytes <= maximumBytes) break;
      try {
        const item = readAndVerify(candidate.filePath, encryptionKey);
        unlinkSync(item.filePath);
        retainedBytes = Math.max(0, retainedBytes - item.bytes);
        deleted.push({
          archiveId: item.metadata.archiveId,
          bytes: item.bytes,
          expiresAt: item.metadata.expiresAt,
          reason: 'capacity',
        });
      } catch (error) {
        errors.push({ filePath: candidate.filePath, code: String(error?.message || error) });
      }
    }
    if (deleted.length) syncDirectory(directory);
    for (const error of errors) {
      logger.warn?.('[local-api][maintenance] invalid technical archive preserved', error);
    }
    return {
      deleted,
      errors,
      remainingBytes: retainedBytes,
      maximumBytes: Number.isFinite(maximumBytes) ? maximumBytes : null,
      capacitySatisfied: retainedBytes <= maximumBytes,
    };
  }

  return Object.freeze({
    directory,
    publish,
    read,
    list,
    findRecords,
    inspectDirectory,
    pruneExpired,
  });
}
