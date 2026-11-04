const FORBIDDEN_ADDRESSES = new net.BlockList();
const PROXY_SYNTHETIC_ADDRESSES = new net.BlockList();
PROXY_SYNTHETIC_ADDRESSES.addSubnet('198.18.0.0', 15, 'ipv4');
for (const [address, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
]) {
  FORBIDDEN_ADDRESSES.addSubnet(address, prefix, type);
}

function normalizeProxyImageUrl(value = '') {
  return normalizeImageUrl(cleanUrl(value));
}

export function isBlockedPurchaseImageAddress(address = '', family = 0, options = {}) {
  const cleanAddress = String(address || '').split('%')[0].toLowerCase();
  const cleanFamily = Number(family);
  if (![4, 6].includes(cleanFamily) || !cleanAddress) return true;
  const type = cleanFamily === 4 ? 'ipv4' : 'ipv6';
  if (
    cleanFamily === 4 &&
    options.allowProxySynthetic === true &&
    PROXY_SYNTHETIC_ADDRESSES.check(cleanAddress, type)
  ) {
    return false;
  }
  return (
    (cleanFamily === 6 && cleanAddress.startsWith('::ffff:')) ||
    FORBIDDEN_ADDRESSES.check(cleanAddress, type)
  );
}

export function isLocalImageUrl(imageUrl = '') {
  try {
    const hostname = new URL(imageUrl).hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    const family = net.isIP(hostname);
    if (!family) return hostname === 'localhost' || hostname.endsWith('.localhost');
    return isBlockedPurchaseImageAddress(hostname, family);
  } catch {
    return true;
  }
}

async function resolvePublicImageAddress(imageUrl) {
  const parsed = new URL(imageUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('图片地址协议不可用');
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('图片域名没有可用地址');
  for (const entry of addresses) {
    const family = Number(entry.family);
    const address = String(entry.address || '').split('%')[0].toLowerCase();
    if (isBlockedPurchaseImageAddress(address, family, { allowProxySynthetic: !literalFamily })) {
      throw new Error('图片地址指向了本机或内网');
    }
  }
  return addresses[0];
}

async function downloadPublicImage(imageUrl, { headers = {}, timeoutMs = 25_000, redirects = 0 } = {}) {
  if (redirects > 4) throw new Error('图片地址重定向次数过多');
  const parsed = new URL(imageUrl);
  const resolved = await resolvePublicImageAddress(parsed.href);
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = transport.request(parsed, {
      method: 'GET',
      headers,
      family: Number(resolved.family),
      autoSelectFamily: false,
      lookup: (_hostname, _options, callback) => {
        callback(null, resolved.address, Number(resolved.family));
      },
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('图片读取超时')));
    request.on('error', (error) => finish(reject, error));
    request.on('response', (response) => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsed).href;
        downloadPublicImage(nextUrl, { headers, timeoutMs, redirects: redirects + 1 })
          .then((value) => finish(resolve, value), (error) => finish(reject, error));
        return;
      }
      const announcedSize = Number(response.headers['content-length'] || 0);
      if (announcedSize > IMAGE_MAX_BYTES) {
        response.destroy();
        finish(reject, new Error('图片过大'));
        return;
      }
      const chunks = [];
      let totalBytes = 0;
      response.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > IMAGE_MAX_BYTES) {
          response.destroy(new Error('图片过大'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', (error) => finish(reject, error));
      response.on('end', () => finish(resolve, {
        ok: status >= 200 && status < 300,
        status,
        headers: response.headers,
        buffer: Buffer.concat(chunks),
      }));
    });
    request.end();
  });
}

function getImageProxyReferer(imageUrl = '') {
  try {
    const hostname = new URL(imageUrl).hostname.toLowerCase();
    if (hostname.includes('taobao') || hostname.includes('tmall')) return 'https://www.taobao.com/';
    if (hostname.includes('alicdn') || hostname.includes('1688') || hostname.includes('alibaba')) return 'https://s.1688.com/';
    if (hostname.includes('yangkeduo') || hostname.includes('pinduoduo')) return 'https://mobile.yangkeduo.com/';
    if (hostname.includes('ozon')) return 'https://www.ozon.ru/';
  } catch {
    return 'https://www.1688.com/';
  }
  return 'https://www.1688.com/';
}

export async function handleImageProxy(url, res) {
  const imageUrl = normalizeProxyImageUrl(url.searchParams.get('url'));
  if (!imageUrl || isLocalImageUrl(imageUrl)) {
    sendJson(res, 400, { ok: false, message: '图片地址不可用' });
    return;
  }

  try {
    const response = await downloadPublicImage(imageUrl, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: getImageProxyReferer(imageUrl),
        'User-Agent': PURCHASE_SEARCH_USER_AGENT,
      },
      timeoutMs: 20_000,
    });
    if (!response.ok) {
      sendJson(res, response.status, { ok: false, message: '图片读取失败' });
      return;
    }

    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (contentType && !contentType.startsWith('image/')) {
      sendJson(res, 415, { ok: false, message: '返回内容不是图片' });
      return;
    }

    const buffer = response.buffer;
    if (!buffer.length) {
      sendJson(res, 404, { ok: false, message: '图片为空' });
      return;
    }
    if (buffer.length > IMAGE_MAX_BYTES) {
      sendJson(res, 413, { ok: false, message: '图片过大' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType || 'image/jpeg',
      'Content-Length': String(buffer.length),
      ...(res.wangzaiCorsOrigin ? { 'Access-Control-Allow-Origin': res.wangzaiCorsOrigin } : {}),
      Vary: 'Origin',
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(buffer);
  } catch {
    sendJson(res, 502, { ok: false, message: '图片读取失败' });
  }
}


export async function loadPurchaseSearchImage(imageUrl, options = {}) {
  const clean = normalizeImageUrl(imageUrl);
  if (!clean) throw new Error('当前商品没有可用于搜款的公网图片。');
  if (isLocalImageUrl(clean)) throw new Error('当前图片是本地地址，采购平台无法直接识图，请使用 Ozon 返回的公网商品图。');

  const response = await downloadPublicImage(clean, {
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      Referer: 'https://s.1688.com/',
      'User-Agent': PURCHASE_SEARCH_USER_AGENT,
    },
    timeoutMs: Math.max(3_000, Math.min(Number(options.timeoutMs) || 25_000, 25_000)),
  });
  if (!response.ok) throw new Error(`订单图片下载失败，状态码 ${response.status}。`);
  const contentType = String(response.headers['content-type'] || 'image/jpeg').toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('下载到的内容不是图片。');
  const buffer = response.buffer;
  if (!buffer.length) throw new Error('图片内容为空。');
  if (buffer.length > IMAGE_MAX_BYTES) throw new Error('图片过大，请换一张小于 8MB 的图片。');
  return { buffer, contentType };
}
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { sendJson } from './auth.mjs';
import { IMAGE_MAX_BYTES, PURCHASE_SEARCH_USER_AGENT } from './config.mjs';
import { cleanUrl, normalizeImageUrl } from './search-utils.mjs';
