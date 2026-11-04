import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function sha256DataAnalysisInsightText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function sha256DataAnalysisInsightFile(filePath) {
  return sha256DataAnalysisInsightText(readFileSync(filePath));
}

function readSource(root, relativePath, violations) {
  const filePath = resolve(root, relativePath);
  if (!existsSync(filePath)) {
    violations.push({
      kind: 'missing-file',
      file: relativePath,
      message: '店铺经营分析报告冻结文件被删除、移动或路径失效。',
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

export function auditDataAnalysisInsightFreeze({ root, manifest }) {
  const violations = [];
  const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {};
  const segments = Array.isArray(manifest?.segments) ? manifest.segments : [];
  const contracts = Array.isArray(manifest?.contracts) ? manifest.contracts : [];
  const featureVersion = String(manifest?.featureVersion || '');

  if (manifest?.schemaVersion !== 1) {
    violations.push({ kind: 'manifest-schema', message: '店铺经营分析报告冻结清单版本必须为1。' });
  }
  if (!featureVersion.startsWith('data-analysis-insight-v2-')) {
    violations.push({ kind: 'feature-version', message: '店铺经营分析报告冻结版本不正确。' });
  }
  if (!Object.keys(files).length) {
    violations.push({ kind: 'empty-manifest', message: '店铺经营分析报告冻结文件不能为空。' });
  }

  Object.entries(files).forEach(([relativePath, expectedHash]) => {
    const filePath = resolve(root, relativePath);
    if (!existsSync(filePath)) {
      violations.push({
        kind: 'missing-file',
        file: relativePath,
        message: '店铺经营分析报告冻结文件被删除、移动或路径失效。',
      });
      return;
    }
    const actualHash = sha256DataAnalysisInsightFile(filePath);
    if (actualHash !== expectedHash) {
      violations.push({
        kind: 'hash-mismatch',
        file: relativePath,
        expectedHash,
        actualHash,
        message: '店铺经营分析报告实现已变化；必须显式复核数据读取、模型调用、报告排版和错误恢复后升级冻结版本。',
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
    const actualHash = sha256DataAnalysisInsightText(value);
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

  const versionFile = 'src/features/dataAnalysis/constants/dataAnalysisInsightFreezeContract.js';
  const versionSource = readSource(root, versionFile, violations);
  if (versionSource !== null
    && !versionSource.includes(`DATA_ANALYSIS_INSIGHT_FREEZE_VERSION = '${featureVersion}'`)) {
    violations.push({
      kind: 'version-source-mismatch',
      file: versionFile,
      message: '店铺经营分析报告源码版本与冻结清单不一致。',
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
