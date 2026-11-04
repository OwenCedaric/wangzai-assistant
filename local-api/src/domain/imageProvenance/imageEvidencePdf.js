import sharp from 'sharp';

const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function short(value, maximum = 100) {
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum)}…` : normalized;
}

function metadataSvg(metadata = {}) {
  const verification = metadata.watermarkVerification || {};
  const lines = [
    '证据类型：AI 生成图本地技术证据链',
    `Asset Token：${short(metadata.assetToken, 80)}`,
    `生成时间：${short(metadata.createdAt, 80)}`,
    `权利主体：${short(metadata.rightsOwner || metadata.userId, 80)}`,
    `店铺：${short(metadata.shopId, 80)}  商品：${short(metadata.productId || metadata.offerId, 80)}`,
    `生成模式：${short(metadata.generationMode || 'standard', 40)}  模型：${short(metadata.model, 80)}`,
    `原图 SHA-256：${short(metadata.originalSha256, 72)}`,
    `暗水印图 SHA-256：${short(metadata.watermarkedSha256, 72)}`,
    `PSD SHA-256：${short(metadata.psdSha256, 72)}`,
    `暗水印本地验证：${verification.exact === true ? '完全匹配' : '未通过'}  置信度：${Number(verification.confidence || 0).toFixed(4)}`,
    `PSNR：${Number(metadata.psnr || 0).toFixed(4)} dB  签名状态：${short(metadata.signatureStatus || 'pending_server_claim', 60)}`,
    '说明：本 PDF 记录本地原图、暗水印图、PSD 及校验摘要；专利/著作权证书需另行绑定。',
  ];
  const tspans = lines.map((line, index) => (
    `<tspan x="74" y="${1060 + index * 49}">${escapeXml(line)}</tspan>`
  )).join('');
  return Buffer.from(`
    <svg width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" fill="#f8fafc"/>
      <rect x="48" y="48" width="1144" height="1658" rx="24" fill="#ffffff" stroke="#d0d5dd" stroke-width="2"/>
      <text x="74" y="112" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="38" font-weight="700" fill="#101828">旺崽图片权属证据报告</text>
      <text x="74" y="160" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="21" fill="#667085">Local provenance evidence report · generated on customer device</text>
      <rect x="70" y="214" width="530" height="760" rx="16" fill="#f2f4f7" stroke="#d0d5dd"/>
      <rect x="640" y="214" width="530" height="760" rx="16" fill="#f2f4f7" stroke="#d0d5dd"/>
      <text x="92" y="250" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="24" font-weight="700" fill="#344054">原始生成图</text>
      <text x="662" y="250" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="24" font-weight="700" fill="#344054">暗水印校验图</text>
      <line x1="74" y1="1018" x2="1166" y2="1018" stroke="#eaecf0" stroke-width="2"/>
      <text font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="20" fill="#344054">${tspans}</text>
    </svg>
  `);
}

function buildPdfWithJpeg(jpeg, width = PAGE_WIDTH, height = PAGE_HEIGHT) {
  const mediaWidth = 620;
  const mediaHeight = 877;
  const content = Buffer.from(`q\n${mediaWidth} 0 0 ${mediaHeight} 0 0 cm\n/Im0 Do\nQ\n`, 'ascii');
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaWidth} ${mediaHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`, 'ascii'),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`, 'ascii'),
      jpeg,
      Buffer.from('\nendstream', 'ascii'),
    ]),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.byteLength} >>\nstream\n`, 'ascii'),
      content,
      Buffer.from('endstream', 'ascii'),
    ]),
  ];
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
  const xrefRows = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ']
    .concat(offsets.slice(1).map((value) => `${String(value).padStart(10, '0')} 00000 n `))
    .join('\n');
  parts.push(Buffer.from(`${xrefRows}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'ascii'));
  return Buffer.concat(parts);
}

async function evidenceThumbnail(value) {
  return sharp(value, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(486, 680, { fit: 'contain', background: '#ffffff', kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function createImageEvidencePdf({ original, watermarked, metadata = {} } = {}) {
  if (!original || !watermarked) throw new Error('Image evidence PDF requires original and watermarked images.');
  const [originalThumbnail, watermarkedThumbnail] = await Promise.all([
    evidenceThumbnail(original),
    evidenceThumbnail(watermarked),
  ]);
  const page = await sharp({
    create: { width: PAGE_WIDTH, height: PAGE_HEIGHT, channels: 3, background: '#f8fafc' },
  }).composite([
    { input: metadataSvg(metadata), left: 0, top: 0 },
    { input: originalThumbnail, left: 92, top: 270 },
    { input: watermarkedThumbnail, left: 662, top: 270 },
  ]).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  return buildPdfWithJpeg(page);
}

export { buildPdfWithJpeg };
