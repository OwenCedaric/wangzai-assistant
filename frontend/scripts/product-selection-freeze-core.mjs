import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function sha256Text(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function sha256File(filePath) {
  return sha256Text(readFileSync(filePath));
}

function readSource(root, relativePath, violations) {
  const filePath = resolve(root, relativePath);
  if (!existsSync(filePath)) {
    violations.push({
      kind: 'missing-file',
      file: relativePath,
      message: 'Ozon 选品助手冻结文件被删除、移动或路径失效。',
    });
    return null;
  }
  return readFileSync(filePath, 'utf8');
}

function readMarkedSegment(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  const unique = start >= 0
    && end >= 0
    && source.lastIndexOf(startMarker) === start
    && source.lastIndexOf(endMarker) === end;
  if (!unique) return null;
  return source.slice(start, end + endMarker.length);
}

export function auditProductSelectionFreeze({ root, manifest }) {
  const violations = [];
  const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {};
  const segments = Array.isArray(manifest?.segments) ? manifest.segments : [];
  const contracts = Array.isArray(manifest?.contracts) ? manifest.contracts : [];
  const featureVersion = String(manifest?.featureVersion || '');

  if (manifest?.schemaVersion !== 1) {
    violations.push({ kind: 'manifest-schema', message: 'Ozon 选品助手冻结清单版本必须为1。' });
  }
  if (!featureVersion.startsWith('ozon-product-selection-v2-')) {
    violations.push({ kind: 'feature-version', message: 'Ozon 选品助手冻结版本不正确。' });
  }
  if (!Object.keys(files).length) {
    violations.push({ kind: 'empty-manifest', message: 'Ozon 选品助手冻结文件不能为空。' });
  }

  Object.entries(files).forEach(([relativePath, expectedHash]) => {
    const filePath = resolve(root, relativePath);
    if (!existsSync(filePath)) {
      violations.push({
        kind: 'missing-file',
        file: relativePath,
        message: 'Ozon 选品助手冻结文件被删除、移动或路径失效。',
      });
      return;
    }
    const actualHash = sha256File(filePath);
    if (actualHash !== expectedHash) {
      violations.push({
        kind: 'hash-mismatch',
        file: relativePath,
        expectedHash,
        actualHash,
        message: 'Ozon 选品助手实现已变化；必须显式复核真实数据、模型分析、1688 找货链路并升级冻结版本。',
      });
    }
  });

  segments.forEach((segment) => {
    const source = readSource(root, segment.file, violations);
    if (source === null) return;
    const value = readMarkedSegment(source, segment.startMarker, segment.endMarker);
    if (value === null) {
      violations.push({
        kind: 'segment-marker',
        file: segment.file,
        message: `冻结样式段 ${segment.name || ''} 的起止标记缺失或重复。`,
      });
      return;
    }
    const actualHash = sha256Text(value);
    if (actualHash !== segment.sha256) {
      violations.push({
        kind: 'segment-hash-mismatch',
        file: segment.file,
        expectedHash: segment.sha256,
        actualHash,
        message: `冻结样式段 ${segment.name || ''} 已变化。`,
      });
    }
  });

  contracts.forEach((contract) => {
    const source = readSource(root, contract.file, violations);
    if (source === null) return;
    (Array.isArray(contract.required) ? contract.required : []).forEach((requiredText) => {
      if (!source.includes(requiredText)) {
        violations.push({
          kind: 'missing-required-contract',
          file: contract.file,
          message: `关键链路缺少：${requiredText}`,
        });
      }
    });
    (Array.isArray(contract.forbidden) ? contract.forbidden : []).forEach((forbiddenText) => {
      if (source.includes(forbiddenText)) {
        violations.push({
          kind: 'forbidden-legacy-code',
          file: contract.file,
          message: `检测到已废弃实现：${forbiddenText}`,
        });
      }
    });
  });

  const versionFile = 'src/features/promptLibrary/constants/productSelectionFreezeContract.js';
  const versionSource = readSource(root, versionFile, violations);
  if (versionSource !== null
    && !versionSource.includes(`PRODUCT_SELECTION_FREEZE_VERSION = '${featureVersion}'`)) {
    violations.push({
      kind: 'version-source-mismatch',
      file: versionFile,
      message: 'Ozon 选品助手源码版本与冻结清单不一致。',
    });
  }

  return {
    ok: violations.length === 0,
    featureVersion,
    protectedFileCount: Object.keys(files).length,
    protectedSegmentCount: segments.length,
    contractCount: contracts.length,
    violations,
  };
}
