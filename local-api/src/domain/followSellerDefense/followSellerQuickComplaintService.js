import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 3;
const MAX_EVIDENCE_FOLLOWERS = 3;
const MAX_OZON_MESSAGE_CHARS = 1000;

function text(value) {
  return String(value ?? '').trim();
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function exactHttpsUrl(value, code) {
  try {
    const url = new URL(text(value));
    if (url.protocol !== 'https:' || !url.hostname || /^(?:localhost|127\.|0\.|\[?::1\]?)/iu.test(url.hostname)) throw new Error(code);
    return url.toString();
  } catch {
    throw failure(code, '商品证据链接不是可验证的 HTTPS 地址，请重新同步商品后重试。');
  }
}

function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: '.png', mimeType: 'image/png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: '.jpg', mimeType: 'image/jpeg' };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: '.webp', mimeType: 'image/webp' };
  }
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) {
    return { extension: '.gif', mimeType: 'image/gif' };
  }
  throw failure('FOLLOW_SELLER_SCHEME1_IMAGE_INVALID', 'Ozon 当前商品图返回的不是有效图片。');
}

async function downloadImage(fetchImpl, url, signal) {
  const requestSignal = signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined);
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    signal: requestSignal,
    headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' },
  });
  if (!response?.ok) throw failure('FOLLOW_SELLER_SCHEME1_IMAGE_DOWNLOAD_FAILED', `当前商品图下载失败（HTTP ${Number(response?.status) || 0}）。`);
  const contentLength = Number(response.headers?.get?.('content-length')) || 0;
  if (contentLength > MAX_IMAGE_BYTES) throw failure('FOLLOW_SELLER_SCHEME1_IMAGE_TOO_LARGE', '当前商品图超过 20MB，已停止提交。');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw failure('FOLLOW_SELLER_SCHEME1_IMAGE_TOO_LARGE', '当前商品图为空或超过 20MB。');
  return { bytes, ...imageType(bytes) };
}

function followerRows(caseRecord) {
  const bySku = new Map();
  for (const source of rows(caseRecord?.sellers)) {
    const sku = text(source?.sku || source?.productSku || source?.product_id || source?.productId);
    if (!/^\d{5,20}$/u.test(sku)) continue;
    bySku.set(sku, {
      sku,
      sellerId: text(source?.sellerId || source?.seller_id || source?.id),
      sellerName: text(source?.sellerName || source?.seller_name || source?.name),
      sellerLink: text(source?.sellerLink || source?.link),
      productLink: text(source?.productLink || source?.product_link),
      price: Number.isFinite(Number(source?.price)) ? Number(source.price) : null,
      observedAt: text(source?.observedAt),
      sourceDigest: text(source?.sourceDigest),
      sourceProductUrl: text(source?.sourceProductUrl),
    });
  }
  return [...bySku.values()];
}

function ozonProductUrl(
  value,
  sku,
  code = 'FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID',
  message = '跟卖商品链接不是对应 SKU 的 Ozon 商品页面，请重新巡查后重试。',
) {
  const fallback = `https://www.ozon.ru/product/product-${sku}/`;
	  const parsed = new URL(exactHttpsUrl(value || fallback, code));
  const host = parsed.hostname.toLowerCase();
	  if ((host !== 'ozon.ru' && !host.endsWith('.ozon.ru')) || !parsed.toString().includes(sku)) {
	    throw failure(code, message);
  }
  return parsed.toString();
}

function boundedMessage(lines, code) {
  const value = lines.filter(Boolean).join('\n').trim();
  if (!value || value.length > MAX_OZON_MESSAGE_CHARS) {
    throw failure(code, '方案1单条消息超过 Ozon 输入上限，已停止提交，避免拆分后触发机器人提前回复。');
  }
  return value;
}

function compactOzonProductUrl(sku) {
  return `https://www.ozon.ru/product/${text(sku)}/`;
}

function buildSpeech({ caseRecord, followers, evidenceFollowers, sourceProductUrl, files, generatedAt }) {
  const originalSku = text(caseRecord?.sku);
  const offerId = text(caseRecord?.offerId);
  const initialLines = [
    'Здравствуйте.',
    `Наш контент: Ozon SKU ${originalSku}; артикул ${offerId}.`,
    `Вложение 1 — наша карточка: ${compactOzonProductUrl(originalSku)}`,
    ...files.map((file, index) => `Вложение ${index + 2} — наше фото: ${file.sourceUrl}`),
    ...evidenceFollowers.map((item, index) => (
      `Вложение ${files.length + index + 2} — карточка продавца, SKU ${item.sku}: ${compactOzonProductUrl(item.sku)}`
    )),
    'Наши изображения используют без разрешения. Просим проверить авторство.',
  ];
  const initialEvidenceRu = boundedMessage(initialLines, 'FOLLOW_SELLER_SCHEME1_INITIAL_MESSAGE_TOO_LONG');
  const supplementRu = boundedMessage([
    'Предоставляем дополнительное подтверждение.',
    'Вложение 1 — скриншот списка товаров из нашего кабинета продавца.',
	    `На скриншоте видны артикул ${offerId}, Ozon SKU ${originalSku}, изображение товара и статус карточки.`,
	    'Дата размещения карточки: {{LISTING_DATE}}.',
    'Это карточка нашего магазина. Контент и изображения карточки были подготовлены и опубликованы нами. Просим повторно проверить материалы.',
  ], 'FOLLOW_SELLER_SCHEME1_SUPPLEMENT_MESSAGE_TOO_LONG');
  const followerBatchRu = boundedMessage([
    ...followers.map((item) => item.sku),
    '',
    `Прошу принять жалобу на перечисленные выше ${followers.length} SKU.`,
  ], 'FOLLOW_SELLER_SCHEME1_FOLLOWER_BATCH_TOO_LONG');
  const followerZh = followers.map((item, index) => `${index + 1}. 跟卖 SKU ${item.sku}${item.sellerName ? `；卖家：${item.sellerName}` : ''}${item.sellerId ? `；卖家ID：${item.sellerId}` : ''}${item.productLink ? `；链接：${item.productLink}` : ''}`);
  const zh = [
    '方案1严格按 Ozon 回复推进：我方 SKU → 单个跟卖 SKU → 首次整批证据 → 材料不足补证 → Ozon 允许后批量 SKU。',
    `我方 Ozon SKU：${originalSku}`,
    `我方货号：${offerId}`,
    `我方商品链接：${sourceProductUrl}`,
    `取证时间：${generatedAt}`,
    '跟卖明细：',
    ...followerZh,
  ].join('\n');
  return {
    ru: initialEvidenceRu,
    initialEvidenceRu,
    supplementRu,
    followerBatchRu,
    zh,
  };
}

export function createFollowSellerQuickComplaintService({
  repository,
  root,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!repository) throw new Error('FOLLOW_SELLER_SCHEME1_REPOSITORY_REQUIRED');
  if (!root) throw new Error('FOLLOW_SELLER_SCHEME1_ROOT_REQUIRED');
  if (typeof fetchImpl !== 'function') throw new Error('FOLLOW_SELLER_SCHEME1_FETCH_REQUIRED');

  async function prepare({ caseRecord } = {}) {
    const capturedFollowers = followerRows(caseRecord);
    if (!capturedFollowers.length || capturedFollowers.length < Math.max(1, Number(caseRecord?.followCountBefore) || 0)) {
      throw failure('FOLLOW_SELLER_SCHEME1_FOLLOWER_DATA_INCOMPLETE', '跟卖数量与跟卖 SKU 明细不一致，请重新巡查后再提交。');
    }
    const followers = capturedFollowers.map((item) => ({
      ...item,
      productLink: ozonProductUrl(item.productLink, item.sku),
    }));
    const material = repository.getProductComplaintMaterial({
      shopId: caseRecord?.shopId,
      productId: caseRecord?.productId,
      sku: caseRecord?.sku,
    });
    if (!material || text(material.sku) !== text(caseRecord?.sku)) {
      throw failure('FOLLOW_SELLER_SCHEME1_PRODUCT_MISMATCH', '本地商品资料与巡查 SKU 不一致，请重新同步商品。');
    }
    const capturedProductUrl = followers.map((item) => item.sourceProductUrl).find(Boolean);
	    const sourceProductUrl = ozonProductUrl(
	      capturedProductUrl || `https://www.ozon.ru/product/${text(caseRecord?.sku)}/`,
	      text(caseRecord?.sku),
	      'FOLLOW_SELLER_SCHEME1_PRODUCT_URL_INVALID',
	      '我方商品链接不是对应 SKU 的 Ozon 商品页面，请重新巡查后重试。',
	    );
    const imageUrls = [...new Set(rows(material.imageUrls).map((url) => exactHttpsUrl(url, 'FOLLOW_SELLER_SCHEME1_IMAGE_URL_INVALID')))].slice(0, MAX_IMAGES);
    if (!imageUrls.length) throw failure('FOLLOW_SELLER_SCHEME1_CURRENT_IMAGE_REQUIRED', '当前商品没有可提交的 Ozon 图片，请先同步商品。');
    const evidenceFollowers = followers.slice(0, MAX_EVIDENCE_FOLLOWERS);

    const evidenceId = `scheme1_${randomUUID()}`;
    const directory = path.resolve(root, 'scheme1', evidenceId);
    await mkdir(directory, { recursive: true });
    const settled = await Promise.allSettled(imageUrls.map(async (url, index) => {
      const downloaded = await downloadImage(fetchImpl, url);
      const filePath = path.join(directory, `current-image-${String(index + 1).padStart(2, '0')}${downloaded.extension}`);
      await writeFile(filePath, downloaded.bytes, { flag: 'wx' });
      return {
        kind: 'current_image',
        name: path.basename(filePath),
        path: filePath,
        mimeType: downloaded.mimeType,
        size: downloaded.bytes.length,
        sha256: sha256(downloaded.bytes),
        sourceUrl: url,
      };
    }));
    const files = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    if (!files.length) throw failure('FOLLOW_SELLER_SCHEME1_CURRENT_IMAGE_DOWNLOAD_FAILED', '当前商品图片全部下载失败，未提交空材料工单。');

    const generatedAt = new Date().toISOString();
    const speech = buildSpeech({
      caseRecord,
      followers,
      evidenceFollowers,
      sourceProductUrl,
      files,
      generatedAt,
    });
    const manifest = {
      version: 2,
      scheme: 'scheme1-seller-backend',
      workflow: 'ozon-seller-backend-content-complaint-v2',
      evidenceId,
      generatedAt,
      shopId: text(caseRecord?.shopId),
      caseId: text(caseRecord?.id),
      originalSku: text(caseRecord?.sku),
      offerId: text(caseRecord?.offerId),
      productId: text(caseRecord?.productId),
      sourceProductUrl,
      followers,
      evidenceFollowers,
      files: files.map((file) => ({ ...file, path: file.path })),
      failedImageCount: settled.length - files.length,
      speech,
    };
    const manifestPath = path.join(directory, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    const manifestBytes = await readFile(manifestPath);
    return {
      scheme: 'scheme1-seller-backend',
      evidenceId,
      manifestPath,
      manifestSha256: sha256(manifestBytes),
      materialDirectory: directory,
      sourceProductUrl,
      files,
      speech,
      followers,
      evidenceFollowers,
      followerCount: followers.length,
      failedImageCount: settled.length - files.length,
      status: 'ready',
    };
  }

  async function validate(bundle, { caseRecord } = {}) {
    if (text(bundle?.scheme) !== 'scheme1-seller-backend'
      || text(bundle?.evidenceId) === ''
      || text(bundle?.manifestPath) === ''
      || text(bundle?.sourceProductUrl) === ''
      || !rows(bundle?.files).length
      || text(bundle?.speech?.initialEvidenceRu) === ''
      || text(bundle?.speech?.supplementRu) === ''
      || text(bundle?.speech?.followerBatchRu) === ''
      || !rows(bundle?.evidenceFollowers).length) {
      throw failure('FOLLOW_SELLER_SCHEME1_MATERIAL_INVALID', '方案1材料不完整，已停止后台提交。');
    }
    const manifestPath = path.resolve(bundle.manifestPath);
    if (!manifestPath.startsWith(path.resolve(root)) || path.basename(manifestPath) !== 'manifest.json') {
      throw failure('FOLLOW_SELLER_SCHEME1_MANIFEST_PATH_FORBIDDEN', '方案1材料清单路径无效。');
    }
    const manifestBytes = await readFile(manifestPath);
    if (bundle.manifestSha256 && sha256(manifestBytes) !== text(bundle.manifestSha256)) {
      throw failure('FOLLOW_SELLER_SCHEME1_MANIFEST_TAMPERED', '方案1材料清单校验失败。');
    }
    for (const file of rows(bundle.files)) {
      const filePath = path.resolve(text(file?.path));
      if (!filePath.startsWith(path.resolve(root))) throw failure('FOLLOW_SELLER_SCHEME1_FILE_PATH_FORBIDDEN', '方案1图片材料路径无效。');
      const bytes = await readFile(filePath);
      imageType(bytes);
      if (sha256(bytes) !== text(file?.sha256)) throw failure('FOLLOW_SELLER_SCHEME1_FILE_TAMPERED', '方案1图片材料校验失败。');
    }
    if (text(caseRecord?.shopId) !== text(JSON.parse(manifestBytes.toString('utf8')).shopId)) {
      throw failure('FOLLOW_SELLER_SCHEME1_SHOP_MISMATCH', '方案1材料与当前店铺不一致。');
    }
    return bundle;
  }

  return { prepare, validate };
}
