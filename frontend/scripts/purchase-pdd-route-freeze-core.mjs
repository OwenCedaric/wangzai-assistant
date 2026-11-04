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
      message: '拍单 PDD 固定搜款链路文件被删除、移动或路径失效。',
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

export function auditPurchasePddRouteFreeze({ root, manifest }) {
  const violations = [];
  const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {};
  const segments = Array.isArray(manifest?.segments) ? manifest.segments : [];
  const contracts = Array.isArray(manifest?.contracts) ? manifest.contracts : [];
  const featureVersion = String(manifest?.featureVersion || '');

  if (manifest?.schemaVersion !== 1) {
    violations.push({ kind: 'manifest-schema', message: '拍单 PDD 固定搜款链路冻结清单版本必须为1。' });
  }
  if (!featureVersion.startsWith('purchase-pdd-1688-route-v2-')) {
    violations.push({ kind: 'feature-version', message: '拍单 PDD 固定搜款链路冻结版本不正确。' });
  }
  if (!Object.keys(files).length || !segments.length || !contracts.length) {
    violations.push({ kind: 'empty-manifest', message: '拍单 PDD 固定搜款链路冻结清单不完整。' });
  }

  Object.entries(files).forEach(([relativePath, expectedHash]) => {
    const filePath = resolve(root, relativePath);
    if (!existsSync(filePath)) {
      violations.push({
        kind: 'missing-file',
        file: relativePath,
        message: '拍单 PDD 固定搜款链路冻结文件被删除、移动或路径失效。',
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
        message: '拍单 PDD 固定搜款实现已变化；必须由操作员明确解除冻结并复核真实 1688→PDD 全链路。',
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
        message: `冻结代码段 ${segment.name || ''} 的起止标记缺失或重复。`,
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
        message: `冻结代码段 ${segment.name || ''} 已变化。`,
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
          message: `固定链路缺少：${requiredText}`,
        });
      }
    });
    (Array.isArray(contract.forbidden) ? contract.forbidden : []).forEach((forbiddenText) => {
      if (source.includes(forbiddenText)) {
        violations.push({
          kind: 'forbidden-legacy-code',
          file: contract.file,
          message: `检测到已废弃或禁止恢复的实现：${forbiddenText}`,
        });
      }
    });
  });

  const versionFile = 'src/features/orders/purchase/constants/purchasePddRouteFreezeContract.js';
  const versionSource = readSource(root, versionFile, violations);
  if (versionSource !== null
    && !versionSource.includes(`PURCHASE_PDD_1688_ROUTE_FREEZE_VERSION = '${featureVersion}'`)) {
    violations.push({
      kind: 'version-source-mismatch',
      file: versionFile,
      message: '拍单 PDD 固定搜款链路源码版本与冻结清单不一致。',
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
