import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function sha256DataAnalysisMarketCaptureText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function sha256DataAnalysisMarketCaptureFile(filePath) {
  return sha256DataAnalysisMarketCaptureText(readFileSync(filePath));
}

function readSource(root, relativePath, violations) {
  const filePath = resolve(root, relativePath);
  if (!existsSync(filePath)) {
    violations.push({
      kind: 'missing-file',
      file: relativePath,
      message: 'Ozon 市场数据采集冻结文件被删除、移动或路径失效。',
    });
    return null;
  }
  return readFileSync(filePath, 'utf8');
}

export function auditDataAnalysisMarketCaptureFreeze({ root, manifest }) {
  const violations = [];
  const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {};
  const contracts = Array.isArray(manifest?.contracts) ? manifest.contracts : [];
  const featureVersion = String(manifest?.featureVersion || '');

  if (manifest?.schemaVersion !== 1) {
    violations.push({ kind: 'manifest-schema', message: 'Ozon 市场数据采集冻结清单版本必须为1。' });
  }
  if (!featureVersion.startsWith('data-analysis-market-capture-v2-')) {
    violations.push({ kind: 'feature-version', message: 'Ozon 市场数据采集冻结版本不正确。' });
  }
  if (!Object.keys(files).length) {
    violations.push({ kind: 'empty-manifest', message: 'Ozon 市场数据采集冻结文件不能为空。' });
  }

  Object.entries(files).forEach(([relativePath, expectedHash]) => {
    const filePath = resolve(root, relativePath);
    if (!existsSync(filePath)) {
      violations.push({
        kind: 'missing-file',
        file: relativePath,
        message: 'Ozon 市场数据采集冻结文件被删除、移动或路径失效。',
      });
      return;
    }
    const actualHash = sha256DataAnalysisMarketCaptureFile(filePath);
    if (actualHash !== expectedHash) {
      violations.push({
        kind: 'hash-mismatch',
        file: relativePath,
        expectedHash,
        actualHash,
        message: 'Ozon 市场采集实现已变化；必须显式复核单采集器、30分钟轮询、完整分页、缓存保护和多店操作浏览器隔离后升级冻结版本。',
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

  const versionFile = 'src/features/dataAnalysis/constants/dataAnalysisMarketCaptureFreezeContract.js';
  const versionSource = readSource(root, versionFile, violations);
  if (versionSource !== null
    && !versionSource.includes(`'${featureVersion}'`)) {
    violations.push({
      kind: 'version-source-mismatch',
      file: versionFile,
      message: 'Ozon 市场数据采集源码版本与冻结清单不一致。',
    });
  }

  return {
    ok: violations.length === 0,
    featureVersion,
    protectedFileCount: Object.keys(files).length,
    contractCount: contracts.length,
    violations,
  };
}
