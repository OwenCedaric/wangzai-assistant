import { requestLocalApi } from '../../../api/localApiClient.js';

function text(value) {
  return String(value ?? '').trim();
}

function normalizeReferenceFiles(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({ path: text(item?.path), content: String(item?.content || '') }))
    .filter((item) => item.path && item.content)
    .slice(0, 24);
}

export async function resolveSmartToolSkillInstallUrl(url, options = {}) {
  const sourceUrl = text(url);
  if (!/^https:\/\//iu.test(sourceUrl)) throw new Error('Skill 链接必须使用 HTTPS。');
  const requester = options.requester || requestLocalApi;
  const payload = await requester('/api/prompt-library/skill-source/resolve', {
    method: 'POST',
    body: { url: sourceUrl },
    timeoutMs: options.timeoutMs || 60_000,
    signal: options.signal,
  });
  const source = payload?.source;
  if (!source || !text(source.markdown)) throw new Error('这个链接没有读取到有效的 SKILL.md。');
  return {
    fileName: text(source.fileName) || 'SKILL.md',
    installType: text(source.installType) || 'github-skill',
    sourceUrl: text(source.sourceUrl) || sourceUrl,
    repository: text(source.repository),
    ref: text(source.ref),
    packagePath: text(source.packagePath),
    markdown: String(source.markdown),
    referenceFiles: normalizeReferenceFiles(source.referenceFiles),
    manifest: Array.isArray(source.manifest) ? source.manifest.slice(0, 100) : [],
    executableFiles: (Array.isArray(source.executableFiles) ? source.executableFiles : []).map(text).filter(Boolean),
    sourceHash: text(source.sourceHash),
  };
}
