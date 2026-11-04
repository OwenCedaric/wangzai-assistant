function text(value) {
  return String(value ?? '').trim();
}

function normalizedKeyword(value) {
  return text(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function keywordTokens(value) {
  return normalizedKeyword(value).split(' ').filter((item) => item.length > 1);
}

export function scoreSeerfarKeywordRelevance(record = {}, seedKeyword = '') {
  const seed = normalizedKeyword(seedKeyword);
  const query = normalizedKeyword(record?.query || record?.keyword || record?.name);
  if (!seed || !query) return 0;
  if (query === seed) return 100;
  if (query.includes(seed) || seed.includes(query)) return 88;

  const seedTokens = keywordTokens(seed);
  const queryTokens = new Set(keywordTokens(query));
  if (!seedTokens.length || !queryTokens.size) return 0;
  const matched = seedTokens.filter((token) => queryTokens.has(token)).length;
  if (!matched) return 0;
  return Math.max(1, Math.min(80, Math.round((matched / seedTokens.length) * 80)));
}

export function seerfarKeywordRecordMatches(record = {}, keywords = []) {
  const values = Array.isArray(keywords) ? keywords : [keywords];
  return values.map(text).filter(Boolean).some((keyword) => (
    scoreSeerfarKeywordRelevance(record, keyword) > 0
  ));
}

export function annotateSeerfarKeywordRecoveryRecords(
  records = [],
  seedKeyword = '',
  { strictMatch = false, source = 'market-keyword-recovery' } = {},
) {
  const seeds = (Array.isArray(seedKeyword) ? seedKeyword : [seedKeyword]).map(text).filter(Boolean);
  return (Array.isArray(records) ? records : [])
    .map((record) => {
      const recoveredRelevancy = Math.max(
        0,
        ...seeds.map((seed) => scoreSeerfarKeywordRelevance(record, seed)),
      );
      return {
        ...record,
        relevancy: Number.isFinite(Number(record?.relevancy))
          ? Number(record.relevancy)
          : recoveredRelevancy,
        sfRecoverySource: source,
      };
    })
    .filter((record) => !strictMatch || Number(record.relevancy) > 0)
    .sort((left, right) => (
      Number(right.relevancy || 0) - Number(left.relevancy || 0)
      || Number(right.searchVolume || 0) - Number(left.searchVolume || 0)
    ));
}
