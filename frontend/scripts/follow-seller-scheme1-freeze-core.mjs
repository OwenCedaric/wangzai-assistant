import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function sha256FollowSellerScheme1File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readSource(root, relativePath, violations) {
  const filePath = resolve(root, relativePath);
  if (!existsSync(filePath)) {
    violations.push({ kind: 'missing-file', file: relativePath, message: '剔除跟卖方案1冻结文件缺失。' });
    return null;
  }
  return readFileSync(filePath, 'utf8');
}

export function auditFollowSellerScheme1Freeze({ root, manifest }) {
  const violations = [];
  const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {};
  const contracts = Array.isArray(manifest?.contracts) ? manifest.contracts : [];
  const sequences = Array.isArray(manifest?.sequences) ? manifest.sequences : [];
  const route = Array.isArray(manifest?.route) ? manifest.route : [];
  const featureVersion = String(manifest?.featureVersion || '');

  if (manifest?.schemaVersion !== 1) violations.push({ kind: 'manifest-schema', message: '冻结清单版本必须为 1。' });
  if (!/^follow-seller-scheme1-v\d+-/u.test(featureVersion)) violations.push({ kind: 'feature-version', message: '方案1冻结版本不正确。' });
  if (!Object.keys(files).length) violations.push({ kind: 'empty-manifest', message: '方案1冻结文件不能为空。' });
  if (route.length !== 9 || route.some((step) => !String(step || '').trim())) {
    violations.push({ kind: 'route-contract', message: '方案1固定流程必须完整保留九个阶段。' });
  }

  Object.entries(files).forEach(([relativePath, expectedHash]) => {
    const source = readSource(root, relativePath, violations);
    if (source === null) return;
    const actualHash = sha256FollowSellerScheme1File(resolve(root, relativePath));
    if (actualHash !== expectedHash) {
      violations.push({
        kind: 'hash-mismatch',
        file: relativePath,
        expectedHash,
        actualHash,
        message: '剔除跟卖方案1实现已变化；必须逐项复核材料、原工单、发送回读、重复提示、复查数量和零积分合同后升级冻结版本。',
      });
    }
  });

  contracts.forEach((contract) => {
    const source = readSource(root, contract.file, violations);
    if (source === null) return;
    (contract.required || []).forEach((value) => {
      if (!source.includes(value)) {
        violations.push({ kind: 'missing-required-contract', file: contract.file, message: `关键链路缺少：${value}` });
      }
    });
    (contract.forbidden || []).forEach((value) => {
      if (source.includes(value)) {
        violations.push({ kind: 'forbidden-legacy-code', file: contract.file, message: `检测到已废弃的方案1实现：${value}` });
      }
    });
  });

  sequences.forEach((sequence) => {
    const source = readSource(root, sequence.file, violations);
    if (source === null) return;
    let cursor = -1;
    for (const marker of sequence.markers || []) {
      const index = source.indexOf(marker, cursor + 1);
      if (index < 0) {
        violations.push({ kind: 'missing-sequence-step', file: sequence.file, message: `固定顺序缺少：${marker}` });
        break;
      }
      cursor = index;
    }
  });

  const versionSource = readSource(root, 'src/features/followSellerDefense/services/followSellerDefenseService.js', violations);
  if (versionSource !== null && !versionSource.includes(`FOLLOW_SELLER_SCHEME1_FREEZE_VERSION = '${featureVersion}'`)) {
    violations.push({ kind: 'version-source-mismatch', file: 'src/features/followSellerDefense/services/followSellerDefenseService.js', message: '方案1源码冻结版本与清单不一致。' });
  }

  return {
    ok: violations.length === 0,
    featureVersion,
    protectedFileCount: Object.keys(files).length,
    contractCount: contracts.length,
    sequenceCount: sequences.length,
    violations,
  };
}
