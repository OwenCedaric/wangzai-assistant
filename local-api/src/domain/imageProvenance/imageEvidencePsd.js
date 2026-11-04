import sharp from 'sharp';
import { writePsdBuffer } from 'ag-psd';

function imageDataOf(data, width, height) {
  return {
    width,
    height,
    data: new Uint8ClampedArray(data),
  };
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function short(value, maximum = 120) {
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum)}…` : normalized;
}

async function createEvidenceOverlay(width, height, metadata = {}) {
  const panelWidth = Math.max(320, Math.min(width - 24, 760));
  const lines = [
    '旺崽图片权属证据层（默认隐藏）',
    `Asset Token: ${short(metadata.assetToken, 80)}`,
    `生成时间: ${short(metadata.createdAt, 80)}`,
    `权利主体: ${short(metadata.rightsOwner || metadata.userId, 80)}`,
    `模型: ${short(metadata.model, 100)}`,
    `原图 SHA-256: ${short(metadata.originalSha256, 80)}`,
    `签名状态: ${short(metadata.signatureStatus || 'pending_server_claim', 80)}`,
  ];
  const lineHeight = 28;
  const panelHeight = 32 + lines.length * lineHeight;
  const tspans = lines.map((line, index) => (
    `<tspan x="34" y="${54 + index * lineHeight}">${escapeXml(line)}</tspan>`
  )).join('');
  const svg = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="12" y="12" width="${panelWidth}" height="${panelHeight}" rx="14" fill="#101828" fill-opacity="0.94"/>
      <text font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="18" fill="#ffffff">${tspans}</text>
    </svg>
  `);
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: svg, left: 0, top: 0 }]).raw().toBuffer();
}

export async function createEvidencePsd({
  originalRgba,
  watermarkedRgba,
  width,
  height,
  metadata = {},
} = {}) {
  if (!originalRgba || !watermarkedRgba || !width || !height) {
    throw new Error('PSD evidence requires original and watermarked RGBA pixels.');
  }
  const evidenceOverlay = await createEvidenceOverlay(width, height, metadata);
  const originalLayer = imageDataOf(originalRgba, width, height);
  const watermarkedLayer = imageDataOf(watermarkedRgba, width, height);
  const evidenceLayer = imageDataOf(evidenceOverlay, width, height);
  return writePsdBuffer({
    width,
    height,
    imageData: watermarkedLayer,
    children: [
      {
        name: '00 原始生成图',
        imageData: originalLayer,
        hidden: true,
      },
      {
        name: '01 人工修改或处理结果（当前无独立修改层）',
        imageData: originalLayer,
        hidden: true,
      },
      {
        name: '02 暗水印发布图',
        imageData: watermarkedLayer,
      },
      {
        name: '03 图片编号与权属证据信息（默认隐藏）',
        imageData: evidenceLayer,
        hidden: true,
      },
    ],
  });
}
