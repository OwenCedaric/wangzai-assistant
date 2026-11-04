const ALIBABA_1688_OFFER_ID_PATTERN = /^\d{5,30}$/u;

function clean(value, maximum = 1800) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function failSource() {
  const error = new Error('PURCHASE_BROWSER_1688_ORDER_NOT_FOUND');
  error.code = 'PURCHASE_BROWSER_1688_ORDER_NOT_FOUND';
  throw error;
}

function trusted1688Host(hostname) {
  const value = clean(hostname, 260).toLowerCase();
  return value === '1688.com' || value.endsWith('.1688.com');
}

function offerIdFromUrl(value) {
  const text = clean(value);
  if (!text) return { provided: false, offerId: '' };
  let url;
  try {
    url = new URL(text);
  } catch {
    failSource();
  }
  if (
    !['https:', 'http:'].includes(url.protocol)
    || url.username
    || url.password
    || !trusted1688Host(url.hostname)
  ) failSource();
  const offerId = clean(
    url.pathname.match(/\/offer\/(\d+)(?:\.html)?(?:\/|$)/iu)?.[1]
      || url.searchParams.get('offerId')
      || url.searchParams.get('offer_id'),
    80,
  );
  if (!ALIBABA_1688_OFFER_ID_PATTERN.test(offerId)) failSource();
  return { provided: true, offerId };
}

/**
 * Read-only source identity adapter for a selected 1688 order line.
 *
 * It deliberately consumes the existing order reader's evidence instead of
 * navigating or mutating that reader.  The output is the stable offer
 * identity used by local persistence: numeric offer id + canonical detail URL.
 */
export function readAlibaba1688SourceRecord(capture = {}) {
  const explicitOfferId = clean(capture.sourceProductId, 80);
  if (explicitOfferId && !ALIBABA_1688_OFFER_ID_PATTERN.test(explicitOfferId)) failSource();

  const sourceEvidence = offerIdFromUrl(capture.sourceUrl);
  if (
    explicitOfferId
    && sourceEvidence.offerId
    && explicitOfferId !== sourceEvidence.offerId
  ) failSource();

  const offerId = explicitOfferId || sourceEvidence.offerId;
  if (!offerId) failSource();

  return Object.freeze({
    sourceProductId: offerId,
    sourceUrl: `https://detail.1688.com/offer/${offerId}.html`,
    productTitle: clean(capture.productTitle, 600),
    variant: clean(capture.variant, 260),
    quantity: capture.quantity ?? null,
    purchasePrice: capture.purchasePrice ?? null,
    sourceMethod: '1688-source-reader',
    sourceConfidence: 1,
  });
}

