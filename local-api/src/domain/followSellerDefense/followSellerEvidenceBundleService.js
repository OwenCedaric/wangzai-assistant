import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { readPsd } from 'ag-psd';
import sharp from 'sharp';
import {
  compareWatermarkPayload,
  extractDctWatermark,
} from '../imageProvenance/watermarkDct.js';

const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;
const PSD_MIME_TYPE = 'image/vnd.adobe.photoshop';
const PDF_MIME_TYPE = 'application/pdf';

function text(value) {
  return String(value ?? '').trim();
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function normalizedScope(scope = {}, caseRecord = {}) {
  const result = {
    tenantId: text(scope.tenantId),
    userId: text(scope.userId),
    shopId: text(caseRecord.shopId || scope.shopId),
  };
  if (!result.tenantId || !result.userId || !result.shopId) {
    throw failure('FOLLOW_SELLER_EVIDENCE_SCOPE_REQUIRED', '跟卖证据包缺少用户或店铺作用域。');
  }
  if (text(scope.shopId) && text(caseRecord.shopId) && text(scope.shopId) !== text(caseRecord.shopId)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_SCOPE_MISMATCH', '跟卖案件与当前店铺作用域不一致。');
  }
  return result;
}

function normalizeSeller(value = {}) {
  const sku = text(value.sku || value.productSku || value.product_id || value.productId);
  if (!/^\d{5,20}$/u.test(sku)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_SELLER_SKU_REQUIRED', '跟卖证据缺少有效的跟卖商品 SKU。');
  }
  return {
    sku,
    sellerId: text(value.sellerId || value.seller_id || value.id),
    sellerName: text(value.sellerName || value.seller_name || value.name),
    price: Number.isFinite(Number(value.price)) ? Number(value.price) : null,
    link: text(value.productLink || value.product_link || value.link),
    credentials: unique(rows(value.credentials)).sort(),
    coverImage: text(value.coverImage || value.cover_image),
    observedAt: text(value.observedAt || value.capturedAt),
    sourceProductUrl: text(value.sourceProductUrl || value.source_product_url),
    offersRoute: text(value.offersRoute || value.offers_route),
    captureSource: text(value.captureSource || value.capture_source),
    sourceDigest: text(value.sourceDigest || value.source_digest),
  };
}

function normalizeCaseRecord(caseRecord = {}, scope = {}) {
  const id = text(caseRecord.id || caseRecord.caseId);
  const shopId = text(caseRecord.shopId || scope.shopId);
  const sku = text(caseRecord.sku || caseRecord.originalSku || caseRecord.writePayload?.originalSku);
  const offerId = text(caseRecord.offerId || caseRecord.offer_id || caseRecord.sourceProduct?.offerId
    || caseRecord.writePayload?.sourceProduct?.offerId);
  const productId = text(caseRecord.productId || caseRecord.product_id || caseRecord.sourceProduct?.productId
    || caseRecord.writePayload?.sourceProduct?.productId);
  const sourceSellers = rows(caseRecord.sellers).length
    ? caseRecord.sellers
    : rows(caseRecord.followSellers).length
      ? caseRecord.followSellers
      : caseRecord.writePayload?.sellers;
  const sellers = rows(sourceSellers).map(normalizeSeller)
    .sort((left, right) => left.sku.localeCompare(right.sku, 'en'));
  if (!id || !shopId || !sku || (!offerId && !productId)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_CASE_REQUIRED', '跟卖证据包缺少案件、店铺、原商品 SKU 或商品标识。');
  }
  if (!sellers.length) {
    throw failure('FOLLOW_SELLER_EVIDENCE_SELLERS_REQUIRED', '跟卖证据包至少需要一条完整的跟卖商品记录。');
  }
  const sellerSkus = sellers.map((seller) => seller.sku);
  if (new Set(sellerSkus).size !== sellerSkus.length) {
    throw failure('FOLLOW_SELLER_EVIDENCE_SELLER_DUPLICATED', '跟卖证据中存在重复的跟卖商品 SKU。');
  }
  const expectedCountValue = caseRecord.followSellerCount ?? caseRecord.follow_seller_count
    ?? caseRecord.competitorCount ?? caseRecord.sellerCount;
  const expectedCount = Number(expectedCountValue);
  if (Number.isSafeInteger(expectedCount) && expectedCount > 0 && expectedCount !== sellers.length) {
    throw failure(
      'FOLLOW_SELLER_EVIDENCE_SELLER_COUNT_MISMATCH',
      `巡查显示 ${expectedCount} 个跟卖商品，但证据仅包含 ${sellers.length} 个，已阻止生成不完整证据包。`,
    );
  }
  return {
    id,
    shopId,
    sku,
    offerId,
    productId,
    productName: text(caseRecord.productName || caseRecord.product_name || caseRecord.sourceProduct?.productName
      || caseRecord.writePayload?.sourceProduct?.productName),
    productUrl: text(caseRecord.productUrl || caseRecord.product_url || sellers[0]?.sourceProductUrl),
    capturedAt: text(caseRecord.capturedAt || caseRecord.lastCapturedAt || sellers[0]?.observedAt || caseRecord.updatedAt),
    sellers,
  };
}

function caseFingerprint(caseData) {
  return sha256(JSON.stringify({
    shopId: caseData.shopId,
    sku: caseData.sku,
    offerId: caseData.offerId,
    productId: caseData.productId,
    productName: caseData.productName,
    productUrl: caseData.productUrl,
    sellers: caseData.sellers,
  }));
}

function productFingerprint(caseData) {
  return sha256(JSON.stringify({
    shopId: caseData.shopId,
    sku: caseData.sku,
    offerId: caseData.offerId,
    productId: caseData.productId,
  }));
}

function sourceFingerprint(verifiedSources) {
  return sha256(JSON.stringify(verifiedSources.map((source) => ({
    jobId: source.id,
    sourceAssetId: source.sourceAssetId,
    assetToken: source.assetToken,
    algorithm: source.algorithm,
    algorithmVersion: source.algorithmVersion,
    hashes: source.hashes,
    watermark: {
      exact: source.watermark.exact,
      matchingBits: source.watermark.matchingBits,
      totalBits: source.watermark.totalBits,
    },
  }))));
}

function inputFingerprint(caseData, verifiedSources) {
  return sha256(JSON.stringify({
    caseFingerprint: caseFingerprint(caseData),
    sourceFingerprint: sourceFingerprint(verifiedSources),
  }));
}

function revisionChange(previous = {}, caseData, verifiedSources) {
  const previousSkus = new Set(rows(previous.case?.sellers).map((seller) => text(seller?.sku)).filter(Boolean));
  const currentSkus = new Set(caseData.sellers.map((seller) => seller.sku));
  return {
    addedFollowerSkus: [...currentSkus].filter((sku) => !previousSkus.has(sku)),
    removedFollowerSkus: [...previousSkus].filter((sku) => !currentSkus.has(sku)),
    sourceChanged: Boolean(previous.sourceFingerprint)
      && previous.sourceFingerprint !== sourceFingerprint(verifiedSources),
  };
}

function requestedProvenance(caseRecord = {}) {
  const evidence = caseRecord.evidence || caseRecord.writePayload?.evidence || {};
  const jobIds = unique([
    caseRecord.provenanceJobId,
    caseRecord.imageProvenanceJobId,
    evidence.provenanceJobId,
    ...rows(caseRecord.provenanceJobIds),
    ...rows(caseRecord.imageProvenanceJobIds),
    ...rows(evidence.provenanceJobIds),
  ]);
  const sourceAssetIds = unique([
    caseRecord.sourceAssetId,
    caseRecord.imageAssetId,
    evidence.sourceAssetId,
    ...rows(caseRecord.sourceAssetIds),
    ...rows(caseRecord.imageAssetIds),
    ...rows(evidence.sourceAssetIds),
  ]);
  return { jobIds, sourceAssetIds };
}

async function writeAtomic(path, value, encoding = null) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, encoding || undefined);
  await rename(temporary, path);
}

async function readInside(path, root, label) {
  if (!text(path) || !isAbsolute(path)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_FILE_PATH_INVALID', `${label}缺少有效的绝对路径。`);
  }
  let rootPath;
  let filePath;
  try {
    [rootPath, filePath] = await Promise.all([realpath(root), realpath(path)]);
  } catch (error) {
    throw failure('FOLLOW_SELLER_EVIDENCE_FILE_MISSING', `${label}不存在或无法读取：${error?.message || error}`);
  }
  const relation = relative(rootPath, filePath);
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_FILE_OUTSIDE_ROOT', `${label}不在受信任的本地证据目录内。`);
  }
  return { path: filePath, bytes: await readFile(filePath) };
}

async function canonicalEvidencePath(path, label) {
  if (!text(path) || !isAbsolute(path)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_FILE_PATH_MISMATCH', `${label}在证据 JSON 中缺少有效路径。`);
  }
  try {
    return await realpath(path);
  } catch (error) {
    throw failure('FOLLOW_SELLER_EVIDENCE_FILE_PATH_MISMATCH', `${label}在证据 JSON 中的路径无效：${error?.message || error}`);
  }
}

function assertPsd(bytes, label = 'PSD 文件') {
  if (bytes.byteLength < 26 || bytes.subarray(0, 4).toString('ascii') !== '8BPS') {
    throw failure('FOLLOW_SELLER_EVIDENCE_PSD_MAGIC_INVALID', `${label}不是有效的 PSD 文件。`);
  }
  const version = bytes.readUInt16BE(4);
  if (![1, 2].includes(version)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_PSD_MAGIC_INVALID', `${label}的 PSD 版本头无效。`);
  }
  try {
    const parsed = readPsd(bytes, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
    });
    const names = rows(parsed.children).map((layer) => text(layer.name));
    if (!names.includes('02 暗水印发布图')) {
      throw new Error('缺少暗水印发布图层');
    }
  } catch (error) {
    throw failure('FOLLOW_SELLER_EVIDENCE_PSD_STRUCTURE_INVALID', `${label}结构校验失败：${error?.message || error}`);
  }
}

function assertPdf(bytes, label = 'PDF 文件') {
  const header = bytes.subarray(0, 8).toString('ascii');
  const trailer = bytes.subarray(Math.max(0, bytes.byteLength - 2048)).toString('latin1');
  if (!header.startsWith('%PDF-') || !/%%EOF\s*$/u.test(trailer)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_PDF_MAGIC_INVALID', `${label}不是完整的 PDF 文件。`);
  }
}

function assertPng(bytes, label = '暗水印图') {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.byteLength < 8 || !bytes.subarray(0, 8).equals(signature)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_WATERMARK_IMAGE_INVALID', `${label}不是有效的 PNG 文件。`);
  }
}

function requiredHash(value, label) {
  const result = text(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_HASH_REQUIRED', `${label}缺少有效的 SHA-256。`);
  }
  return result;
}

function assertHash(bytes, expected, label) {
  const actual = sha256(bytes);
  if (actual !== requiredHash(expected, label)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_HASH_MISMATCH', `${label}的 SHA-256 与证据账本不一致。`);
  }
  return actual;
}

function assertSourceProduct(evidence, caseData) {
  const source = evidence.source || {};
  const offerMatches = caseData.offerId && text(source.offerId) && caseData.offerId === text(source.offerId);
  const productMatches = caseData.productId && text(source.productId) && caseData.productId === text(source.productId);
  if (!offerMatches && !productMatches) {
    throw failure('FOLLOW_SELLER_EVIDENCE_PRODUCT_MISMATCH', '图片权属证据与当前跟卖案件不是同一商品。');
  }
}

async function verifyWatermark(bytes, payloadHex, declared = {}) {
  if (declared?.exact !== true) {
    throw failure('FOLLOW_SELLER_EVIDENCE_WATERMARK_NOT_EXACT', '图片证据任务没有通过 exact 暗水印校验。');
  }
  const normalizedPayloadHex = text(payloadHex).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalizedPayloadHex)) {
    throw failure('FOLLOW_SELLER_EVIDENCE_WATERMARK_PAYLOAD_INVALID', '图片证据任务缺少完整的 256-bit 暗水印载荷。');
  }
  let decoded;
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    decoded = extractDctWatermark({ data, width: info.width, height: info.height, channels: info.channels });
  } catch (error) {
    throw failure('FOLLOW_SELLER_EVIDENCE_WATERMARK_READ_FAILED', `暗水印重新提取失败：${error?.message || error}`);
  }
  const comparison = compareWatermarkPayload(decoded.payload, Buffer.from(normalizedPayloadHex, 'hex'));
  if (!comparison.exact) {
    throw failure('FOLLOW_SELLER_EVIDENCE_WATERMARK_NOT_EXACT', '暗水印重新提取结果不是 exact，已阻止生成投诉证据包。');
  }
  return {
    ...comparison,
    confidence: decoded.confidence,
    minimumBitConfidence: decoded.minimumBitConfidence,
  };
}

function canonicalSame(left, right) {
  return text(left).toLowerCase() === text(right).toLowerCase();
}

async function verifyJob(job, { scope, caseData, sourceRoot }) {
  if (!job || job.status !== 'completed') {
    throw failure('FOLLOW_SELLER_EVIDENCE_JOB_NOT_COMPLETED', '图片权属证据任务尚未完成。');
  }
  if (text(job.tenantId) !== scope.tenantId || text(job.userId) !== scope.userId || text(job.shopId) !== scope.shopId) {
    throw failure('FOLLOW_SELLER_EVIDENCE_JOB_SCOPE_MISMATCH', '图片权属证据任务不属于当前用户和店铺。');
  }
  if (job.result?.uploadPolicy !== 'watermarked-only') {
    throw failure('FOLLOW_SELLER_EVIDENCE_UPLOAD_POLICY_INVALID', '图片权属任务未执行“仅暗水印图上传”策略。');
  }
  const files = job.result?.files || {};
  const evidenceFile = await readInside(files.evidence, sourceRoot, '图片证据 JSON');
  let evidence;
  try {
    evidence = JSON.parse(evidenceFile.bytes.toString('utf8'));
  } catch (error) {
    throw failure('FOLLOW_SELLER_EVIDENCE_JSON_INVALID', `图片证据 JSON 无法解析：${error?.message || error}`);
  }
  if (text(evidence.owner?.tenantId) !== scope.tenantId
    || text(evidence.owner?.userId) !== scope.userId
    || text(evidence.source?.shopId) !== scope.shopId) {
    throw failure('FOLLOW_SELLER_EVIDENCE_JOB_SCOPE_MISMATCH', '图片证据 JSON 的用户或店铺作用域不一致。');
  }
  if (!canonicalSame(evidenceFile.path, await canonicalEvidencePath(evidence.files?.evidence, '图片证据 JSON'))) {
    throw failure('FOLLOW_SELLER_EVIDENCE_FILE_PATH_MISMATCH', '图片证据 JSON 的自身文件路径与任务记录不一致。');
  }
  assertSourceProduct(evidence, caseData);
  if (text(evidence.payloadHex).toLowerCase() !== text(job.payloadHex).toLowerCase()) {
    throw failure('FOLLOW_SELLER_EVIDENCE_WATERMARK_PAYLOAD_INVALID', '图片证据 JSON 与任务记录的暗水印载荷不一致。');
  }
  const loaded = {};
  for (const key of ['original', 'watermarked', 'psd', 'pdf']) {
    loaded[key] = await readInside(files[key], sourceRoot, `图片证据 ${key}`);
    if (!canonicalSame(loaded[key].path, await canonicalEvidencePath(evidence.files?.[key], `图片证据 ${key}`))) {
      throw failure('FOLLOW_SELLER_EVIDENCE_FILE_PATH_MISMATCH', `图片证据 ${key} 的文件路径与证据 JSON 不一致。`);
    }
  }
  assertPsd(loaded.psd.bytes, '来源分层 PSD');
  assertPdf(loaded.pdf.bytes, '来源权属 PDF');
  assertPng(loaded.watermarked.bytes);
  const hashes = {};
  for (const key of ['original', 'watermarked', 'psd', 'pdf']) {
    const evidenceHash = requiredHash(evidence.hashes?.[`${key}Sha256`], `图片证据 ${key}`);
    const jobHash = requiredHash(job.result?.hashes?.[`${key}Sha256`], `图片任务 ${key}`);
    if (evidenceHash !== jobHash) {
      throw failure('FOLLOW_SELLER_EVIDENCE_HASH_MISMATCH', `图片证据 ${key} 在任务与 JSON 中的 SHA-256 不一致。`);
    }
    hashes[`${key}Sha256`] = assertHash(loaded[key].bytes, evidenceHash, `图片证据 ${key}`);
  }
  const declaredExact = job.result?.watermark?.localVerification?.exact === true
    && evidence.watermark?.localVerification?.exact === true;
  const watermark = await verifyWatermark(loaded.watermarked.bytes, evidence.payloadHex, { exact: declaredExact });
  return {
    id: text(job.id),
    sourceAssetId: text(job.sourceAssetId),
    assetToken: text(job.assetToken),
    algorithm: text(job.algorithm),
    algorithmVersion: text(job.algorithmVersion),
    rightsOwner: text(evidence.owner?.rightsOwner || evidence.owner?.userId),
    createdAt: text(evidence.createdAt || job.completedAt),
    source: evidence.source,
    generation: evidence.generation,
    hashes,
    watermark,
    files: loaded,
  };
}

function buildRussianSpeech({ caseData, rightsOwner, generatedAt, attachmentNames }) {
  const sellerLines = caseData.sellers.map((seller, index) => {
    const fields = [`SKU ${seller.sku}`];
    if (seller.sellerId) fields.push(`ID продавца ${seller.sellerId}`);
    if (seller.sellerName) fields.push(`продавец «${seller.sellerName}»`);
    if (seller.link) fields.push(`ссылка ${seller.link}`);
    return `${index + 1}. ${fields.join(', ')}.`;
  });
  return [
    'Здравствуйте.',
    '',
    'Прошу провести проверку и удалить предложения сторонних продавцов, которые используют принадлежащий мне контент карточки товара без разрешения.',
    `Правообладатель: ${rightsOwner || 'указан в приложенных материалах'}.`,
    `Магазин: ${caseData.shopId}.`,
    `Мой артикул: ${caseData.offerId || 'не указан'}.`,
    `Мой Ozon SKU: ${caseData.sku}.`,
    caseData.productId ? `ID моего товара: ${caseData.productId}.` : '',
    caseData.productName ? `Наименование товара: ${caseData.productName}.` : '',
    '',
    'Предложения, требующие проверки:',
    ...sellerLines,
    '',
    `К заявлению приложены два файла: ${attachmentNames[0]} (исходник со слоями PSD) и ${attachmentNames[1]} (многостраничный PDF-отчёт с хешами SHA-256, проверкой скрытого водяного знака и перечнем нарушающих предложений).`,
    `Пакет доказательств сформирован автоматически ${generatedAt} UTC.`,
    'Прошу сообщить номер обращения и результат проверки в этом диалоге.',
  ].filter((line) => line !== '').join('\n');
}

function buildWorkflowSpeech({ caseData, rightsOwner, generatedAt, attachmentNames }) {
  const initialEvidenceRu = buildRussianSpeech({ caseData, rightsOwner, generatedAt, attachmentNames });
  return {
    ru: initialEvidenceRu,
    initialEvidenceRu,
    supplementRu: [
      'Дополняю материалы подтверждением даты первой публикации.',
      'Карточка нашего товара была размещена {{LISTING_DATE}}.',
      `Мой Ozon SKU: ${caseData.sku}.`,
      `Мой артикул: ${caseData.offerId || 'не указан'}.`,
      'Во вложении — новый снимок списка товаров из кабинета продавца с карточкой и датой размещения.',
      'Ранее отправленные PSD и PDF повторно не прикладываю.',
    ].join('\n'),
    followerBatchRu: [
      'Прошу также проверить и удалить предложения со следующими SKU:',
      ...caseData.sellers.map((seller) => seller.sku),
      'Жалуюсь на все SKU, перечисленные выше.',
    ].join('\n'),
  };
}

function wrapLine(value, maximum = 76) {
  const source = text(value);
  if (!source) return [''];
  const words = source.split(/\s+/u);
  const output = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= maximum) {
      current = `${current} ${word}`;
    } else {
      output.push(current);
      current = word;
    }
  }
  if (current) output.push(current);
  return output.flatMap((line) => line.length <= maximum
    ? [line]
    : Array.from({ length: Math.ceil(line.length / maximum) }, (_, index) => line.slice(index * maximum, (index + 1) * maximum)));
}

function expandedLines(lines) {
  return lines.flatMap((line) => wrapLine(line));
}

async function renderTextPage({ title, subtitle, lines, pageNumber }) {
  const displayed = expandedLines(lines).slice(0, 31);
  const tspans = displayed.map((line, index) => (
    `<tspan x="82" y="${270 + index * 43}">${escapeXml(line || ' ')}</tspan>`
  )).join('');
  const svg = Buffer.from(`
    <svg width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" fill="#f8fafc"/>
      <rect x="42" y="42" width="1156" height="1670" rx="24" fill="#ffffff" stroke="#d0d5dd" stroke-width="2"/>
      <text x="82" y="114" font-family="Microsoft YaHei, Arial, sans-serif" font-size="38" font-weight="700" fill="#101828">${escapeXml(title)}</text>
      <text x="82" y="164" font-family="Microsoft YaHei, Arial, sans-serif" font-size="21" fill="#667085">${escapeXml(subtitle)}</text>
      <line x1="82" y1="204" x2="1158" y2="204" stroke="#eaecf0" stroke-width="2"/>
      <text font-family="Microsoft YaHei, Arial, sans-serif" font-size="22" fill="#344054">${tspans}</text>
      <text x="1080" y="1668" font-family="Arial, sans-serif" font-size="18" fill="#98a2b3">${pageNumber}</text>
    </svg>
  `);
  return sharp(svg).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
}

async function evidenceThumbnail(value) {
  return sharp(value, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(486, 760, { fit: 'contain', background: '#ffffff', kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function renderImagePage({ source, index, pageNumber }) {
  const [original, watermarked] = await Promise.all([
    evidenceThumbnail(source.files.original.bytes),
    evidenceThumbnail(source.files.watermarked.bytes),
  ]);
  const svg = Buffer.from(`
    <svg width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" fill="#f8fafc"/>
      <rect x="42" y="42" width="1156" height="1670" rx="24" fill="#ffffff" stroke="#d0d5dd" stroke-width="2"/>
      <text x="82" y="114" font-family="Microsoft YaHei, Arial, sans-serif" font-size="36" font-weight="700" fill="#101828">Изображение ${index + 1} · проверка происхождения</text>
      <text x="82" y="164" font-family="Arial, sans-serif" font-size="20" fill="#667085">Asset Token: ${escapeXml(source.assetToken)}</text>
      <rect x="72" y="222" width="520" height="850" rx="16" fill="#f2f4f7" stroke="#d0d5dd"/>
      <rect x="648" y="222" width="520" height="850" rx="16" fill="#f2f4f7" stroke="#d0d5dd"/>
      <text x="96" y="262" font-family="Microsoft YaHei, Arial, sans-serif" font-size="22" font-weight="700" fill="#344054">Исходное изображение</text>
      <text x="672" y="262" font-family="Microsoft YaHei, Arial, sans-serif" font-size="22" font-weight="700" fill="#344054">Опубликованное изображение</text>
      <text x="82" y="1150" font-family="Arial, sans-serif" font-size="19" fill="#344054">Original SHA-256: ${source.hashes.originalSha256}</text>
      <text x="82" y="1194" font-family="Arial, sans-serif" font-size="19" fill="#344054">Watermarked SHA-256: ${source.hashes.watermarkedSha256}</text>
      <text x="82" y="1238" font-family="Arial, sans-serif" font-size="19" fill="#344054">PSD SHA-256: ${source.hashes.psdSha256}</text>
      <text x="82" y="1282" font-family="Arial, sans-serif" font-size="19" fill="#344054">Source PDF SHA-256: ${source.hashes.pdfSha256}</text>
      <text x="82" y="1342" font-family="Microsoft YaHei, Arial, sans-serif" font-size="24" font-weight="700" fill="#12b76a">Скрытый водяной знак: EXACT (${source.watermark.matchingBits}/${source.watermark.totalBits})</text>
      <text x="1080" y="1668" font-family="Arial, sans-serif" font-size="18" fill="#98a2b3">${pageNumber}</text>
    </svg>
  `);
  return sharp(svg).composite([
    { input: original, left: 88, top: 288 },
    { input: watermarked, left: 664, top: 288 },
  ]).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
}

async function renderCapturedPage({ file, title, subtitle, pageNumber }) {
  const image = await sharp(file.bytes, { limitInputPixels: 80_000_000 })
    .rotate()
    .resize(1060, 1370, { fit: 'contain', background: '#ffffff', kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const svg = Buffer.from(`
    <svg width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" fill="#f8fafc"/>
      <rect x="42" y="42" width="1156" height="1670" rx="24" fill="#ffffff" stroke="#d0d5dd" stroke-width="2"/>
      <text x="82" y="114" font-family="Microsoft YaHei, Arial, sans-serif" font-size="34" font-weight="700" fill="#101828">${escapeXml(title)}</text>
      <text x="82" y="160" font-family="Microsoft YaHei, Arial, sans-serif" font-size="20" fill="#667085">${escapeXml(subtitle)}</text>
      <rect x="82" y="205" width="1076" height="1386" rx="16" fill="#f2f4f7" stroke="#d0d5dd"/>
      <text x="82" y="1640" font-family="Arial, sans-serif" font-size="17" fill="#667085">SHA-256: ${escapeXml(file.sha256)}</text>
      <text x="1080" y="1682" font-family="Arial, sans-serif" font-size="18" fill="#98a2b3">${pageNumber}</text>
    </svg>
  `);
  return sharp(svg).composite([{ input: image, left: 90, top: 213 }])
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
}

async function buildEvidencePages({
  evidenceId,
  rightsOwner,
  caseData,
  verifiedSources,
  speech,
  browserEvidence = null,
}) {
  const pages = [];
  const evidenceIndex = [];
  const appendSection = async (key, title, createPages) => {
    const firstPage = pages.length + 1;
    await createPages();
    evidenceIndex.push({ key, title, firstPage, pageCount: pages.length - firstPage + 1 });
  };
  const summaryLines = [
    `Evidence ID: ${evidenceId}`,
    `Владелец прав: ${rightsOwner}`,
    `Магазин: ${caseData.shopId}`,
    `Артикул: ${caseData.offerId || '—'}`,
    `Ozon SKU: ${caseData.sku}`,
    `Product ID: ${caseData.productId || '—'}`,
    `Товар: ${caseData.productName || '—'}`,
    `Страница товара: ${caseData.productUrl || '—'}`,
    `Время фиксации: ${caseData.capturedAt || '—'}`,
    `Зафиксировано предложений: ${caseData.sellers.length}`,
  ];
  await appendSection('case-summary', '案件与跟卖清单', async () => {
    pages.push(await renderTextPage({
      title: 'Доказательства использования контента',
      subtitle: 'Автоматически сформированный пакет · PSD + PDF · без архива',
      lines: summaryLines,
      pageNumber: pages.length + 1,
    }));
  });
  const sellerEvidenceLines = caseData.sellers.flatMap((seller, index) => [
    `${index + 1}. SKU ${seller.sku}; seller ID ${seller.sellerId || '—'}; ${seller.sellerName || '—'}; цена ${seller.price ?? '—'}`,
    `Ссылка предложения: ${seller.link || '—'}`,
    `Зафиксировано: ${seller.observedAt || caseData.capturedAt || '—'}; источник: ${seller.captureSource || '—'}; route: ${seller.offersRoute || '—'}`,
    `Source digest: ${seller.sourceDigest || '—'}; image: ${seller.coverImage || '—'}`,
    seller.credentials.length ? `Дополнительные признаки: ${seller.credentials.join('; ')}` : '',
    '',
  ]).filter((line) => line !== '');
  const expandedSellerEvidence = expandedLines(sellerEvidenceLines);
  await appendSection('seller-inventory', '全部跟卖SKU、链接与巡查来源', async () => {
    for (let index = 0; index < expandedSellerEvidence.length; index += 31) {
      pages.push(await renderTextPage({
        title: 'Зафиксированные сторонние предложения',
        subtitle: `Полный перечень без выборочного сокращения · часть ${Math.floor(index / 31) + 1}`,
        lines: expandedSellerEvidence.slice(index, index + 31),
        pageNumber: pages.length + 1,
      }));
    }
  });
  if (browserEvidence) {
    await appendSection('ozon-own-product-page', '我方Ozon商品页面截图', async () => {
      pages.push(await renderCapturedPage({
        file: browserEvidence.ownProductPage,
        title: 'Карточка нашего товара на Ozon',
        subtitle: `SKU ${caseData.sku} · снимок страницы перед подачей жалобы`,
        pageNumber: pages.length + 1,
      }));
    });
    await appendSection('ozon-follower-pages', '跟卖商品页面截图', async () => {
      for (let index = 0; index < browserEvidence.followerProductPages.length; index += 1) {
        const file = browserEvidence.followerProductPages[index];
        pages.push(await renderCapturedPage({
          file,
          title: `Карточка стороннего предложения · SKU ${file.sku}`,
          subtitle: `Снимок ${index + 1} из ${browserEvidence.followerProductPages.length} · ссылка ${file.productLink}`,
          pageNumber: pages.length + 1,
        }));
      }
    });
  }
  await appendSection('image-comparison', '原图、发布图与暗水印对照', async () => {
    for (let index = 0; index < verifiedSources.length; index += 1) {
      pages.push(await renderImagePage({ source: verifiedSources[index], index, pageNumber: pages.length + 1 }));
    }
  });
  const technicalLines = verifiedSources.flatMap((source, index) => [
    `Изображение ${index + 1}: job ${source.id}`,
    `Asset Token: ${source.assetToken}`,
    `Algorithm: ${source.algorithm} / ${source.algorithmVersion}`,
    `Original SHA-256: ${source.hashes.originalSha256}`,
    `Watermarked SHA-256: ${source.hashes.watermarkedSha256}`,
    `PSD SHA-256: ${source.hashes.psdSha256}`,
    `Source PDF SHA-256: ${source.hashes.pdfSha256}`,
    `Watermark: EXACT ${source.watermark.matchingBits}/${source.watermark.totalBits}; confidence ${Number(source.watermark.confidence || 0).toFixed(6)}`,
    '',
  ]);
  const technicalExpanded = expandedLines(technicalLines);
  await appendSection('technical-verification', '文件哈希与暗水印提取结果', async () => {
    for (let index = 0; index < technicalExpanded.length; index += 31) {
      pages.push(await renderTextPage({
        title: 'Техническая проверка целостности',
        subtitle: `SHA-256 и повторное извлечение скрытого водяного знака · часть ${Math.floor(index / 31) + 1}`,
        lines: technicalExpanded.slice(index, index + 31),
        pageNumber: pages.length + 1,
      }));
    }
  });
  const speechExpanded = expandedLines(speech.split('\n'));
  await appendSection('ozon-statement', 'Ozon投诉话术与附件说明', async () => {
    for (let index = 0; index < speechExpanded.length; index += 31) {
      pages.push(await renderTextPage({
        title: 'Текст обращения в поддержку Ozon',
        subtitle: `Фактические поля сформированы без генеративных дополнений · часть ${Math.floor(index / 31) + 1}`,
        lines: speechExpanded.slice(index, index + 31),
        pageNumber: pages.length + 1,
      }));
    }
  });
  return { pages, evidenceIndex };
}

function buildMultiPagePdf(pages) {
  if (!pages.length) throw new Error('Evidence PDF requires at least one page.');
  const mediaWidth = 620;
  const mediaHeight = 877;
  const pageObjects = [];
  const imageObjects = [];
  const contentObjects = [];
  const objectIds = [];
  pages.forEach((jpeg, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    objectIds.push({ pageId, imageId, contentId });
    const content = Buffer.from(`q\n${mediaWidth} 0 0 ${mediaHeight} 0 0 cm\n/Im${index} Do\nQ\n`, 'ascii');
    pageObjects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaWidth} ${mediaHeight}] /Resources << /XObject << /Im${index} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`, 'ascii'));
    imageObjects.push(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${PAGE_WIDTH} /Height ${PAGE_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`, 'ascii'),
      jpeg,
      Buffer.from('\nendstream', 'ascii'),
    ]));
    contentObjects.push(Buffer.concat([
      Buffer.from(`<< /Length ${content.byteLength} >>\nstream\n`, 'ascii'),
      content,
      Buffer.from('endstream', 'ascii'),
    ]));
  });
  const objectCount = 2 + pages.length * 3;
  const objects = new Array(objectCount);
  objects[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii');
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${objectIds.map(({ pageId }) => `${pageId} 0 R`).join(' ')}] /Count ${pages.length} >>`, 'ascii');
  objectIds.forEach(({ pageId, imageId, contentId }, index) => {
    objects[pageId - 1] = pageObjects[index];
    objects[imageId - 1] = imageObjects[index];
    objects[contentId - 1] = contentObjects[index];
  });
  const header = Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n', 'latin1');
  const parts = [header];
  const offsets = [0];
  let offset = header.byteLength;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const prefix = Buffer.from(`${index + 1} 0 obj\n`, 'ascii');
    const suffix = Buffer.from('\nendobj\n', 'ascii');
    parts.push(prefix, object, suffix);
    offset += prefix.byteLength + object.byteLength + suffix.byteLength;
  });
  const xrefOffset = offset;
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ']
    .concat(offsets.slice(1).map((value) => `${String(value).padStart(10, '0')} 00000 n `))
    .join('\n');
  parts.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'ascii'));
  return Buffer.concat(parts);
}

function attachmentDescriptor(kind, path, bytes) {
  const psd = kind === 'psd';
  return {
    kind,
    name: basename(path),
    path,
    mimeType: psd ? PSD_MIME_TYPE : PDF_MIME_TYPE,
    sha256: sha256(bytes),
    size: bytes.byteLength,
  };
}

function bundleSha({ caseFingerprint: fingerprint, sourceJobIds, attachments, speechSha256 }) {
  return sha256(JSON.stringify({
    caseFingerprint: fingerprint,
    sourceJobIds,
    attachments: attachments.map(({ kind, sha256: hash, size }) => ({ kind, sha256: hash, size })),
    speechSha256,
  }));
}

function publicBundle(manifest, manifestPath, manifestSha256, reuseMode = 'validated') {
  const caseData = manifest.case || {};
  const browserEvidence = manifest.browserEvidence || null;
  return {
    evidenceId: manifest.evidenceId,
    files: manifest.attachments,
    speech: manifest.speech.body,
    workflowSpeech: manifest.speech.workflow || { ru: manifest.speech.body, initialEvidenceRu: manifest.speech.body },
    manifestPath,
    materialDirectory: dirname(manifestPath),
    browserEvidence,
    browserEvidenceReady: browserEvidence?.status === 'ready',
    captureRequest: {
      evidenceId: manifest.evidenceId,
      materialDirectory: dirname(manifestPath),
      sourceProductUrl: text(caseData.productUrl),
      originalSku: text(caseData.sku),
      offerId: text(caseData.offerId),
      followerSkus: rows(caseData.sellers).map((seller) => text(seller?.sku)).filter(Boolean),
      evidenceFollowers: rows(caseData.sellers)
        .filter((seller) => text(seller?.sku) && text(seller?.link))
        .slice(0, 3)
        .map((seller) => ({ sku: text(seller.sku), productLink: text(seller.link) })),
    },
    hashes: {
      psdSha256: manifest.attachments.find((file) => file.kind === 'psd')?.sha256 || '',
      pdfSha256: manifest.attachments.find((file) => file.kind === 'pdf')?.sha256 || '',
      manifestSha256,
      bundleSha256: manifest.bundleSha256,
    },
    revision: Number(manifest.revision) || 1,
    reuse: {
      mode: reuseMode,
      reused: reuseMode === 'reused',
      inputFingerprint: text(manifest.inputFingerprint),
    },
    status: 'ready',
  };
}

export function createFollowSellerEvidenceBundleService({
  provenanceRepository,
  root,
  now = () => new Date(),
} = {}) {
  if (!provenanceRepository?.getJob) {
    throw new Error('Follow-seller evidence bundle requires an image provenance repository.');
  }
  const sourceRoot = text(provenanceRepository.evidenceRoot);
  const bundleRoot = text(root) || (text(provenanceRepository.root)
    ? join(provenanceRepository.root, 'follow-seller-evidence')
    : '');
  if (!sourceRoot || !bundleRoot) {
    throw new Error('Follow-seller evidence bundle roots are required.');
  }
  const prepareLocks = new Map();

  async function resolveJobs(caseRecord, caseData, scope) {
    const requested = requestedProvenance(caseRecord);
    const jobs = [];
    for (const jobId of requested.jobIds) {
      const job = await provenanceRepository.getJob(jobId, scope);
      if (!job) throw failure('FOLLOW_SELLER_EVIDENCE_JOB_NOT_FOUND', `图片权属证据任务不存在：${jobId}`);
      jobs.push(job);
    }
    for (const sourceAssetId of requested.sourceAssetIds) {
      if (!provenanceRepository.findLatestBySourceAssetId) {
        throw failure('FOLLOW_SELLER_EVIDENCE_SOURCE_LOOKUP_UNAVAILABLE', '图片权属仓储不支持按来源图片查找证据任务。');
      }
      const job = await provenanceRepository.findLatestBySourceAssetId(sourceAssetId, scope);
      if (!job) throw failure('FOLLOW_SELLER_EVIDENCE_JOB_NOT_FOUND', `来源图片没有已保存的权属证据任务：${sourceAssetId}`);
      jobs.push(job);
    }
    const byId = new Map(jobs.map((job) => [text(job.id), job]));
    if (!byId.size && provenanceRepository.findLatestCompletedForProduct) {
      const latest = await provenanceRepository.findLatestCompletedForProduct({
        shopId: caseData.shopId,
        productId: caseData.productId,
        offerId: caseData.offerId,
      }, scope);
      if (latest) byId.set(text(latest.id), latest);
    }
    if (!byId.size) {
      throw failure('FOLLOW_SELLER_EVIDENCE_PROVENANCE_REQUIRED', '跟卖案件没有关联已完成的图片权属证据任务。');
    }
    return [...byId.values()].sort((left, right) => text(left.id).localeCompare(text(right.id), 'en'));
  }

  async function loadBrowserCapture(capture = {}, manifest = {}, manifestPath = '') {
    const caseData = manifest.case || {};
    if (text(capture.evidenceId) !== text(manifest.evidenceId)
      || text(capture.originalSku) !== text(caseData.sku)
      || text(capture.offerId) !== text(caseData.offerId)
      || !text(capture.listingDate)) {
      throw failure('FOLLOW_SELLER_SCHEME2_CAPTURE_MISMATCH', '方案2浏览器证据与当前商品、货号或上架日期不一致。');
    }
    const trustedDirectory = await realpath(dirname(manifestPath));
    const loadFile = async (value, expectedName, label, png = true) => {
      const declaredPath = text(value?.path);
      const loaded = await readInside(declaredPath, bundleRoot, label);
      if (!canonicalSame(dirname(loaded.path), trustedDirectory)
        || basename(loaded.path) !== expectedName
        || text(value?.name || expectedName) !== expectedName) {
        throw failure('FOLLOW_SELLER_SCHEME2_CAPTURE_PATH_FORBIDDEN', `${label}不在当前证据包目录或文件名不匹配。`);
      }
      if (png) assertPng(loaded.bytes, label);
      const actualHash = assertHash(loaded.bytes, value?.sha256, label);
      return {
        name: expectedName,
        path: loaded.path,
        sha256: actualHash,
        size: loaded.bytes.byteLength,
        bytes: loaded.bytes,
      };
    };
    const ownProductPage = await loadFile(capture.ownProductPage, 'own-product-page.png', '我方 Ozon 商品页面截图');
    const ownSellerList = await loadFile(capture.ownSellerList, 'own-seller-list.png', '卖家后台商品列表截图');
    const expectedFollowers = rows(caseData.sellers)
      .filter((seller) => text(seller?.sku) && text(seller?.link))
      .slice(0, 3);
    const captureFollowers = rows(capture.followerProductPages);
    if (!expectedFollowers.length || captureFollowers.length !== expectedFollowers.length) {
      throw failure('FOLLOW_SELLER_SCHEME2_FOLLOWER_CAPTURE_INCOMPLETE', '方案2跟卖页面截图数量与当前跟卖证据不一致。');
    }
    const followerProductPages = [];
    for (let index = 0; index < expectedFollowers.length; index += 1) {
      const expected = expectedFollowers[index];
      const current = captureFollowers[index] || {};
      const expectedName = `follower-${String(index + 1).padStart(2, '0')}-${expected.sku}-page.png`;
      if (text(current.sku) !== text(expected.sku) || text(current.productLink) !== text(expected.link)) {
        throw failure('FOLLOW_SELLER_SCHEME2_FOLLOWER_CAPTURE_MISMATCH', `跟卖 SKU ${expected.sku} 的页面截图与巡查链接不一致。`);
      }
      followerProductPages.push({
        ...(await loadFile(current, expectedName, `跟卖 SKU ${expected.sku} 页面截图`)),
        sku: text(expected.sku),
        productLink: text(expected.link),
      });
    }
    const ledger = await loadFile(capture.ledger, 'scheme2-evidence-capture.json', '方案2浏览器证据账本', false);
    let ledgerJson;
    try {
      ledgerJson = JSON.parse(ledger.bytes.toString('utf8'));
    } catch (error) {
      throw failure('FOLLOW_SELLER_SCHEME2_CAPTURE_LEDGER_INVALID', `方案2浏览器证据账本无法解析：${error?.message || error}`);
    }
    if (text(ledgerJson.evidenceId) !== text(manifest.evidenceId)
      || text(ledgerJson.originalSku) !== text(caseData.sku)
      || text(ledgerJson.offerId) !== text(caseData.offerId)
      || text(ledgerJson.listingDate) !== text(capture.listingDate)) {
      throw failure('FOLLOW_SELLER_SCHEME2_CAPTURE_LEDGER_MISMATCH', '方案2浏览器证据账本与当前案件不一致。');
    }
    return {
      status: 'ready',
      capturedAt: text(capture.capturedAt),
      listingDate: text(capture.listingDate),
      ownProductPage,
      ownSellerList,
      followerProductPages,
      ledger,
    };
  }

  function storedBrowserEvidence(browserEvidence) {
    const descriptor = (file) => ({
      name: file.name,
      path: file.path,
      sha256: file.sha256,
      size: file.size,
    });
    return {
      status: 'ready',
      capturedAt: browserEvidence.capturedAt,
      listingDate: browserEvidence.listingDate,
      ownProductPage: descriptor(browserEvidence.ownProductPage),
      ownSellerList: descriptor(browserEvidence.ownSellerList),
      followerProductPages: browserEvidence.followerProductPages.map((file) => ({
        ...descriptor(file),
        sku: file.sku,
        productLink: file.productLink,
      })),
      ledger: descriptor(browserEvidence.ledger),
    };
  }

  async function prepareLocked({
    caseRecord,
    normalized,
    caseData,
    verifiedSources,
    evidenceId,
    baseFingerprint,
    currentInputFingerprint,
  }) {
    const fingerprint = caseFingerprint(caseData);
    const ownerDirectory = sha256(`${normalized.tenantId}\n${normalized.userId}`).slice(0, 32);
    const outputDirectory = join(bundleRoot, ownerDirectory, evidenceId);
    await mkdir(outputDirectory, { recursive: true });
    const psdPath = join(outputDirectory, `${evidenceId}-source.psd`);
    const pdfPath = join(outputDirectory, `${evidenceId}-report.pdf`);
    const manifestPath = join(outputDirectory, `${evidenceId}-manifest.json`);
    let previousManifest = null;
    let previousManifestBytes = null;
    try {
      previousManifestBytes = await readFile(manifestPath);
      previousManifest = JSON.parse(previousManifestBytes.toString('utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw failure('FOLLOW_SELLER_EVIDENCE_REUSE_MANIFEST_INVALID', `既有方案2证据清单无法复核：${error?.message || error}`);
      }
    }
    if (previousManifest) {
      if (text(previousManifest.evidenceId) !== evidenceId
        || previousManifest.scope?.tenantId !== normalized.tenantId
        || previousManifest.scope?.userId !== normalized.userId
        || previousManifest.scope?.shopId !== normalized.shopId
        || text(previousManifest.baseFingerprint) !== baseFingerprint) {
        throw failure('FOLLOW_SELLER_EVIDENCE_REUSE_SCOPE_MISMATCH', '既有方案2证据包与当前用户、店铺或商品不一致。');
      }
      const previousBundle = publicBundle(
        previousManifest,
        manifestPath,
        sha256(previousManifestBytes),
        'validated',
      );
      await validateBundle(previousBundle, { caseRecord }, normalized, {
        allowCaseRevision: previousManifest.inputFingerprint !== currentInputFingerprint,
        expectedBaseFingerprint: baseFingerprint,
      });
      if (previousManifest.inputFingerprint === currentInputFingerprint) {
        return publicBundle(previousManifest, manifestPath, sha256(previousManifestBytes), 'reused');
      }
    }
    const generatedAt = now().toISOString();
    const attachmentNames = [basename(psdPath), basename(pdfPath)];
    const rightsOwner = verifiedSources.map((item) => item.rightsOwner).find(Boolean) || normalized.userId;
    const workflowSpeech = buildWorkflowSpeech({ caseData, rightsOwner, generatedAt, attachmentNames });
    const speech = workflowSpeech.initialEvidenceRu;
    const { pages, evidenceIndex } = await buildEvidencePages({
      evidenceId,
      rightsOwner,
      caseData,
      verifiedSources,
      speech,
    });

    const psdBytes = verifiedSources[0].files.psd.bytes;
    const pdfBytes = buildMultiPagePdf(pages);
    assertPsd(psdBytes, '案件上传 PSD');
    assertPdf(pdfBytes, '案件多页 PDF');
    await Promise.all([
      writeAtomic(psdPath, psdBytes),
      writeAtomic(pdfPath, pdfBytes),
    ]);
    const attachments = [
      attachmentDescriptor('psd', psdPath, psdBytes),
      attachmentDescriptor('pdf', pdfPath, pdfBytes),
    ];
    const speechSha256 = sha256(Buffer.from(speech, 'utf8'));
    const sourceJobIds = verifiedSources.map((item) => item.id);
    const sourceEvidenceFingerprint = sourceFingerprint(verifiedSources);
    const revision = Math.max(0, Number(previousManifest?.revision) || 0) + 1;
    const manifest = {
      schemaVersion: 2,
      evidenceId,
      status: 'ready',
      scope: normalized,
      baseFingerprint,
      inputFingerprint: currentInputFingerprint,
      sourceFingerprint: sourceEvidenceFingerprint,
      caseFingerprint: fingerprint,
      case: caseData,
      rightsOwner,
      createdAt: text(previousManifest?.createdAt) || generatedAt,
      generatedAt,
      revision,
      parentRevision: previousManifest ? {
        revision: Number(previousManifest.revision) || 1,
        inputFingerprint: text(previousManifest.inputFingerprint),
        bundleSha256: text(previousManifest.bundleSha256),
      } : null,
      changeSummary: previousManifest
        ? revisionChange(previousManifest, caseData, verifiedSources)
        : { addedFollowerSkus: caseData.sellers.map((seller) => seller.sku), removedFollowerSkus: [], sourceChanged: false },
      evidenceIndex: {
        totalPages: pages.length,
        sections: evidenceIndex,
      },
      sourceProvenance: verifiedSources.map((source) => ({
        jobId: source.id,
        sourceAssetId: source.sourceAssetId,
        assetToken: source.assetToken,
        algorithm: source.algorithm,
        algorithmVersion: source.algorithmVersion,
        hashes: source.hashes,
        watermark: source.watermark,
        generation: source.generation,
        source: source.source,
      })),
      speech: {
        language: 'ru-RU',
        body: speech,
        workflow: workflowSpeech,
        sha256: speechSha256,
      },
      browserEvidence: null,
      attachments,
      uploadContract: {
        archive: false,
        attachmentCount: 2,
        requiredKinds: ['psd', 'pdf'],
      },
      bundleSha256: bundleSha({
        caseFingerprint: fingerprint,
        sourceJobIds,
        attachments,
        speechSha256,
      }),
    };
    const revisionEntry = {
      revision,
      generatedAt,
      inputFingerprint: currentInputFingerprint,
      caseFingerprint: fingerprint,
      sourceFingerprint: sourceEvidenceFingerprint,
      followerSkus: caseData.sellers.map((seller) => seller.sku),
      changeSummary: manifest.changeSummary,
      attachments: attachments.map(({ kind, sha256: hash, size }) => ({ kind, sha256: hash, size })),
      bundleSha256: manifest.bundleSha256,
    };
    manifest.revisionHistory = [
      ...rows(previousManifest?.revisionHistory),
      revisionEntry,
    ].slice(-20);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeAtomic(manifestPath, manifestBytes);
    return publicBundle(manifest, manifestPath, sha256(manifestBytes), previousManifest ? 'updated' : 'created');
  }

  async function validateBundle(bundle = {}, { caseRecord } = {}, scope = {}, options = {}) {
    const normalized = normalizedScope(scope, caseRecord);
    const caseData = normalizeCaseRecord(caseRecord, normalized);
    const manifestFile = await readInside(bundle.manifestPath, bundleRoot, '跟卖证据 manifest');
    let manifest;
    try {
      manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
    } catch (error) {
      throw failure('FOLLOW_SELLER_EVIDENCE_MANIFEST_INVALID', `跟卖证据 manifest 无法解析：${error?.message || error}`);
    }
    if (text(manifest.evidenceId) !== text(bundle.evidenceId)
      || manifest.status !== 'ready'
      || manifest.scope?.tenantId !== normalized.tenantId
      || manifest.scope?.userId !== normalized.userId
      || manifest.scope?.shopId !== normalized.shopId
      || (options.allowCaseRevision
        ? text(manifest.baseFingerprint) !== text(options.expectedBaseFingerprint || productFingerprint(caseData))
        : manifest.caseFingerprint !== caseFingerprint(caseData))) {
      throw failure('FOLLOW_SELLER_EVIDENCE_MANIFEST_MISMATCH', '跟卖证据 manifest 与当前案件或用户作用域不一致。');
    }
    if (rows(bundle.files).length !== 2 || rows(manifest.attachments).length !== 2) {
      throw failure('FOLLOW_SELLER_EVIDENCE_ATTACHMENT_COUNT_INVALID', '跟卖证据上传附件必须恰好为一个 PSD 和一个 PDF。');
    }
    const kinds = rows(manifest.attachments).map((item) => item.kind).sort();
    if (kinds.join(',') !== 'pdf,psd') {
      throw failure('FOLLOW_SELLER_EVIDENCE_ATTACHMENT_TYPES_INVALID', '跟卖证据上传附件必须恰好包含 PSD 和 PDF。');
    }
    const validatedAttachments = [];
    for (const expected of manifest.attachments) {
      const publicFile = rows(bundle.files).find((item) => item.kind === expected.kind);
      if (!publicFile || publicFile.path !== expected.path || publicFile.name !== expected.name
        || publicFile.mimeType !== expected.mimeType) {
        throw failure('FOLLOW_SELLER_EVIDENCE_ATTACHMENT_MISMATCH', '待上传附件与本地 manifest 不一致。');
      }
      const loaded = await readInside(expected.path, bundleRoot, `跟卖证据 ${expected.kind}`);
      if (expected.kind === 'psd') assertPsd(loaded.bytes, '待上传 PSD');
      if (expected.kind === 'pdf') assertPdf(loaded.bytes, '待上传 PDF');
      const actualHash = assertHash(loaded.bytes, expected.sha256, `待上传 ${expected.kind}`);
      if (loaded.bytes.byteLength !== Number(expected.size)) {
        throw failure('FOLLOW_SELLER_EVIDENCE_ATTACHMENT_SIZE_MISMATCH', `待上传 ${expected.kind} 文件大小与 manifest 不一致。`);
      }
      validatedAttachments.push({ ...expected, path: loaded.path, sha256: actualHash });
    }
    const manifestSpeech = text(manifest.speech?.body);
    if (!manifestSpeech || text(bundle.speech) !== manifestSpeech
      || sha256(Buffer.from(manifestSpeech, 'utf8')) !== requiredHash(manifest.speech?.sha256, '俄语投诉话术')) {
      throw failure('FOLLOW_SELLER_EVIDENCE_SPEECH_MISMATCH', '俄语投诉话术与本地 manifest 不一致。');
    }
    const recalculatedBundleHash = bundleSha({
      caseFingerprint: manifest.caseFingerprint,
      sourceJobIds: rows(manifest.sourceProvenance).map((item) => text(item.jobId)),
      attachments: validatedAttachments,
      speechSha256: manifest.speech.sha256,
    });
    if (recalculatedBundleHash !== requiredHash(manifest.bundleSha256, '跟卖证据包')) {
      throw failure('FOLLOW_SELLER_EVIDENCE_BUNDLE_HASH_MISMATCH', '跟卖证据包整体 SHA-256 校验失败。');
    }
    const result = publicBundle(
      { ...manifest, attachments: validatedAttachments },
      manifestFile.path,
      sha256(manifestFile.bytes),
      text(bundle.reuse?.mode) || 'validated',
    );
    if (bundle.hashes?.manifestSha256 && bundle.hashes.manifestSha256 !== result.hashes.manifestSha256) {
      throw failure('FOLLOW_SELLER_EVIDENCE_MANIFEST_HASH_MISMATCH', '跟卖证据 manifest 已发生变化。');
    }
    return result;
  }

  async function prepare({ caseRecord } = {}, scope = {}) {
    const normalized = normalizedScope(scope, caseRecord);
    const caseData = normalizeCaseRecord(caseRecord, normalized);
    const jobs = await resolveJobs(caseRecord, caseData, normalized);
    const verifiedSources = [];
    for (const job of jobs) {
      verifiedSources.push(await verifyJob(job, {
        scope: normalized,
        caseData,
        sourceRoot,
      }));
    }
    verifiedSources.sort((left, right) => left.id.localeCompare(right.id, 'en'));
    const baseFingerprint = productFingerprint(caseData);
    const currentInputFingerprint = inputFingerprint(caseData, verifiedSources);
    const evidenceId = `fse_${sha256(`${normalized.tenantId}\n${normalized.userId}\n${baseFingerprint}`).slice(0, 32)}`;
    const previous = prepareLocks.get(evidenceId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(() => prepareLocked({
      caseRecord,
      normalized,
      caseData,
      verifiedSources,
      evidenceId,
      baseFingerprint,
      currentInputFingerprint,
    }));
    prepareLocks.set(evidenceId, current);
    try {
      return await current;
    } finally {
      if (prepareLocks.get(evidenceId) === current) prepareLocks.delete(evidenceId);
    }
  }

  async function finalizeBrowserEvidence(bundle = {}, { caseRecord, capture } = {}, scope = {}) {
    const normalized = normalizedScope(scope, caseRecord);
    const caseData = normalizeCaseRecord(caseRecord, normalized);
    const validated = await validateBundle(bundle, { caseRecord }, normalized);
    const manifestFile = await readInside(validated.manifestPath, bundleRoot, '跟卖证据 manifest');
    let manifest;
    try {
      manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
    } catch (error) {
      throw failure('FOLLOW_SELLER_EVIDENCE_MANIFEST_INVALID', `跟卖证据 manifest 无法解析：${error?.message || error}`);
    }
    const browserEvidence = await loadBrowserCapture(capture, manifest, manifestFile.path);
    const jobs = await resolveJobs(caseRecord, caseData, normalized);
    const verifiedSources = [];
    for (const job of jobs) {
      verifiedSources.push(await verifyJob(job, {
        scope: normalized,
        caseData,
        sourceRoot,
      }));
    }
    verifiedSources.sort((left, right) => left.id.localeCompare(right.id, 'en'));
    if (sourceFingerprint(verifiedSources) !== text(manifest.sourceFingerprint)) {
      throw failure('FOLLOW_SELLER_SCHEME2_PROVENANCE_CHANGED', '浏览器证据采集期间图片权属来源发生变化，请重新生成方案2证据。');
    }
    const { pages, evidenceIndex } = await buildEvidencePages({
      evidenceId: manifest.evidenceId,
      rightsOwner: manifest.rightsOwner,
      caseData,
      verifiedSources,
      speech: manifest.speech.body,
      browserEvidence,
    });
    const pdfBytes = buildMultiPagePdf(pages);
    assertPdf(pdfBytes, '整合浏览器截图后的案件 PDF');
    const pdfPath = manifest.attachments.find((file) => file.kind === 'pdf')?.path;
    if (!pdfPath) throw failure('FOLLOW_SELLER_EVIDENCE_PDF_REQUIRED', '方案2证据包缺少待整合的 PDF。');
    await writeAtomic(pdfPath, pdfBytes);
    const attachments = manifest.attachments.map((file) => (
      file.kind === 'pdf' ? attachmentDescriptor('pdf', pdfPath, pdfBytes) : file
    ));
    const next = {
      ...manifest,
      assembledAt: now().toISOString(),
      browserEvidence: storedBrowserEvidence(browserEvidence),
      evidenceIndex: {
        totalPages: pages.length,
        sections: evidenceIndex,
      },
      attachments,
    };
    next.bundleSha256 = bundleSha({
      caseFingerprint: next.caseFingerprint,
      sourceJobIds: rows(next.sourceProvenance).map((item) => text(item.jobId)),
      attachments,
      speechSha256: next.speech.sha256,
    });
    const history = rows(next.revisionHistory);
    if (history.length) {
      history[history.length - 1] = {
        ...history[history.length - 1],
        browserEvidenceCapturedAt: browserEvidence.capturedAt,
        attachments: attachments.map(({ kind, sha256: hash, size }) => ({ kind, sha256: hash, size })),
        bundleSha256: next.bundleSha256,
      };
    }
    next.revisionHistory = history;
    const manifestBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await writeAtomic(manifestFile.path, manifestBytes);
    return publicBundle(next, manifestFile.path, sha256(manifestBytes), 'assembled');
  }

  async function validate(bundle = {}, input = {}, scope = {}) {
    return validateBundle(bundle, input, scope);
  }

  return { prepare, finalizeBrowserEvidence, validate };
}

export { buildMultiPagePdf };
