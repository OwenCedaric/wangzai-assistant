function clean(value, maximum = 1200) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalizedTitle(value) {
  return clean(value, 600)
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, '');
}

function titleBigrams(value) {
  const text = normalizedTitle(value);
  if (text.length < 2) return new Set(text ? [text] : []);
  return new Set(Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)));
}

function titleCharacters(value) {
  return new Set(normalizedTitle(value));
}

function diceCoefficient(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return {
    score: (2 * intersection) / (left.size + right.size),
    intersection,
  };
}

export function purchaseTitleSimilarity(left, right) {
  const a = normalizedTitle(left);
  const b = normalizedTitle(right);
  if (!a || !b) return 0;
  if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 6) return 1;
  const aPairs = titleBigrams(a);
  const bPairs = titleBigrams(b);
  if (!aPairs.size || !bPairs.size) return 0;
  const pairScore = diceCoefficient(aPairs, bPairs);
  const characterScore = diceCoefficient(titleCharacters(a), titleCharacters(b));
  // 1688 的订单标题经常与搜款标题重新排序、替换同义词。单纯按连续
  // 二元组会把“花盆支架/花盆架、可移动/带轮”这类同款误判为无关。
  // 字符重合只作为连续词组证据的补强；没有足够共享词组时仍然无法过线。
  const reorderedScore = pairScore.intersection >= 4
    ? characterScore.score * 0.7 + Math.min(1, pairScore.intersection / 8) * 0.3
    : 0;
  return Math.max(pairScore.score, reorderedScore);
}

function sourceProductIdFromUrl(value) {
  const text = clean(value, 1800);
  if (!text) return '';
  try {
    const url = new URL(text);
    return clean(
      url.pathname.match(/\/offer\/(\d+)\.html/iu)?.[1]
      || url.searchParams.get('offerId')
      || url.searchParams.get('offer_id'),
      260,
    );
  } catch {
    return clean(text.match(/\/offer\/(\d+)\.html/iu)?.[1], 260);
  }
}

function candidateTitles(candidate = {}) {
  return [...new Set([
    candidate.productTitle,
    ...(Array.isArray(candidate.productTitles) ? candidate.productTitles : []),
  ].map((value) => clean(value, 600)).filter(Boolean))];
}

function candidateScore(candidate, {
  expectedOrderNumber = '',
  expectedSourceUrl = '',
  targetProductTitle = '',
  targetQuantity = null,
} = {}) {
  const orderNumber = clean(candidate.purchaseOrderNumber || candidate.orderNumber, 260);
  if (expectedOrderNumber) return orderNumber === clean(expectedOrderNumber, 260) ? 100 : -1;
  const expectedSourceProductId = sourceProductIdFromUrl(expectedSourceUrl);
  const candidateSourceProductId = clean(candidate.sourceProductId, 260)
    || sourceProductIdFromUrl(candidate.sourceUrl);
  let score = 0;
  if (expectedSourceProductId && candidateSourceProductId) {
    if (expectedSourceProductId !== candidateSourceProductId) return -1;
    score += 80;
  }
  const similarity = candidateTitles(candidate)
    .reduce((best, title) => Math.max(best, purchaseTitleSimilarity(targetProductTitle, title)), 0);
  if (similarity >= 0.5) score += 45 + similarity * 20;
  else if (!expectedSourceProductId && similarity < 0.34) return -1;
  const expectedQuantity = Number(targetQuantity);
  const actualQuantity = Number(candidate.quantity);
  if (Number.isFinite(expectedQuantity) && expectedQuantity > 0 && Number.isFinite(actualQuantity) && actualQuantity > 0) {
    if (expectedQuantity !== actualQuantity) return -1;
    score += 5;
  }
  return score;
}

export function selectAlibaba1688OrderCandidate(inspection = {}, options = {}) {
  const rows = (Array.isArray(inspection.orderCandidates) ? inspection.orderCandidates : [])
    .filter((candidate) => candidate && typeof candidate === 'object');
  const candidates = rows.length ? rows : (
    inspection.purchaseOrderNumber || inspection.orderNumber ? [inspection] : []
  );
  const scored = candidates
    .map((candidate) => ({ candidate, score: candidateScore(candidate, options) }))
    .filter((row) => row.score >= 0)
    .sort((left, right) => right.score - left.score);
  if (!scored.length) {
    const error = new Error('PURCHASE_BROWSER_1688_ORDER_NOT_FOUND');
    error.code = 'PURCHASE_BROWSER_1688_ORDER_NOT_FOUND';
    throw error;
  }
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    const error = new Error('PURCHASE_BROWSER_1688_ORDER_AMBIGUOUS');
    error.code = 'PURCHASE_BROWSER_1688_ORDER_AMBIGUOUS';
    throw error;
  }
  const selected = scored[0].candidate;
  const sourceUrl = clean(selected.sourceUrl || options.expectedSourceUrl || inspection.sourceUrl || inspection.pageUrl, 1800);
  const purchaseOrderUrl = clean(selected.purchaseOrderUrl || selected.orderUrl || inspection.pageUrl, 1800);
  return Object.freeze({
    ...inspection,
    ...selected,
    platform: '1688',
    pageType: 'order-detail',
    pageUrl: clean(inspection.pageUrl || purchaseOrderUrl, 1800),
    sourceUrl,
    purchaseOrderUrl,
    productTitle: clean(selected.productTitle || candidateTitles(selected)[0] || options.targetProductTitle, 600),
    purchaseOrderNumber: clean(selected.purchaseOrderNumber || selected.orderNumber, 260),
    orderNumber: clean(selected.purchaseOrderNumber || selected.orderNumber, 260),
    purchaseOrderStatus: clean(
      selected.purchaseOrderStatus || selected.orderStatus || selected.statusText || selected.status,
      160,
    ),
    purchasePrice: Number(selected.purchasePrice ?? selected.amount),
    amount: clean(selected.amount ?? selected.purchasePrice, 80),
    currency: 'CNY',
    capturedAt: new Date().toISOString(),
  });
}
