import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function sha256ProductImageOssFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readSource(root, relativePath, violations) {
  const filePath = resolve(root, relativePath);
  if (!existsSync(filePath)) {
    violations.push({ kind: 'missing-file', file: relativePath, message: '商品图 OSS 闭环冻结文件缺失。' });
    return null;
  }
  return readFileSync(filePath, 'utf8');
}

export function auditProductImageOssFreeze({ root, manifest }) {
  const violations = [];
  const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {};
  const contracts = Array.isArray(manifest?.contracts) ? manifest.contracts : [];
  const featureVersion = String(manifest?.featureVersion || '');
  if (manifest?.schemaVersion !== 1) violations.push({ kind: 'manifest-schema', message: '冻结清单版本必须为 1。' });
  if (!/^product-image-oss-v(?:[3-9]|[1-9]\d+)-/u.test(featureVersion)) violations.push({ kind: 'feature-version', message: '冻结版本不正确。' });
  if (!Object.keys(files).length) violations.push({ kind: 'empty-manifest', message: '冻结文件不能为空。' });

  Object.entries(files).forEach(([relativePath, expectedHash]) => {
    const source = readSource(root, relativePath, violations);
    if (source === null) return;
    const actualHash = sha256ProductImageOssFile(resolve(root, relativePath));
    if (actualHash !== expectedHash) {
      violations.push({ kind: 'hash-mismatch', file: relativePath, expectedHash, actualHash,
        message: '商品图 OSS 闭环实现已变化；必须复核账号隔离、临时转永久、Ozon 回读、限额和签名权限后升级冻结版本。' });
    }
  });

  contracts.forEach((contract) => {
    const source = readSource(root, contract.file, violations);
    if (source === null) return;
    (contract.required || []).forEach((value) => {
      if (!source.includes(value)) violations.push({ kind: 'missing-required-contract', file: contract.file, message: `关键链路缺少：${value}` });
    });
    (contract.forbidden || []).forEach((value) => {
      if (source.includes(value)) violations.push({ kind: 'forbidden-legacy-code', file: contract.file, message: `检测到废弃或越权实现：${value}` });
    });
  });

  const versionSource = readSource(root, 'src/features/products/services/productImageAssetService.js', violations);
  if (versionSource !== null && !versionSource.includes(`PRODUCT_IMAGE_OSS_FREEZE_VERSION = '${featureVersion}'`)) {
    violations.push({ kind: 'version-source-mismatch', file: 'src/features/products/services/productImageAssetService.js', message: '源码冻结版本与清单不一致。' });
  }
  return { ok: violations.length === 0, featureVersion, protectedFileCount: Object.keys(files).length,
    contractCount: contracts.length, violations };
}
