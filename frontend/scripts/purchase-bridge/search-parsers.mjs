import {
  asArray,
  cleanUrl,
  collectUnique,
  decodeHtmlEntities,
  decodeJsonString,
  firstPresent,
  normalizeSearchResultTitle,
  stripHtml,
} from './search-utils.mjs';

export function extract1688ResultsFromHtml(html = '', searchUrl = '') {
  const candidates = [];
  const patterns = [
    /"title"\s*:\s*"([^"]{4,220})"/g,
    /"subject"\s*:\s*"([^"]{4,220})"/g,
    /"offerTitle"\s*:\s*"([^"]{4,220})"/g,
    /"simpleSubject"\s*:\s*"([^"]{4,220})"/g,
    /data-title=["']([^"']{4,220})["']/g,
    /title=["']([^"']{4,220})["']/g,
  ];
  patterns.forEach((pattern) => {
    let match = pattern.exec(html);
    while (match) {
      candidates.push({ title: match[1], url: searchUrl, platformLabel: '1688' });
      match = pattern.exec(html);
    }
  });
  return collectUnique(candidates, 20).map((item, index) => ({
    id: `${index}-${item.title}`,
    title: item.title,
    url: item.url,
    link: item.url,
    imageUrl: '',
    priceText: '',
    platformLabel: item.platformLabel,
    hint: '来自 1688 图片搜索，请人工核对规格和价格',
  }));
}

export function normalize1688SearchResult(item, index = 0) {
  const data = item?.data && typeof item.data === 'object' ? item.data : item || {};
  const offerId = firstPresent(data.offerId, data.id, data.itemId);
  const imageUrl = cleanUrl(firstPresent(data.offerPicUrl, data.odPicUrl, data.picUrl, data.imageUrl, data.imgUrl));
  const price = stripHtml(firstPresent(
    data.priceInfo?.price,
    data.priceInfo?.priceText,
    data.priceInfo?.priceUnderLine,
    data.price,
    data.showPrice
  ));
  const sales = stripHtml(firstPresent(
    data.afterPrice?.text,
    asArray(data.afterPriceList).find((entry) => /sale|销量|件/i.test(String(entry?.matKey || entry?.text || '')))?.text,
    data.saleQuantity ? `${data.saleQuantity} 件` : '',
    data.bookedCount ? `${data.bookedCount} 件起批` : ''
  ));
  const minOrder = stripHtml(firstPresent(
    asArray(data.afterPriceList).find((entry) => {
      const metricKey = String(entry?.matKey || '').trim();
      const metricText = String(entry?.text || '').trim();
      return /^(?:quantity|minquantity|min_order_quantity|bookedcount)$/i.test(metricKey) || /起批/u.test(metricText);
    })?.text,
    data.bookedCount ? `${data.bookedCount} 件起批` : ''
  ));
  return {
    id: offerId || `${Date.now()}-${index}`,
    offerId,
    platform: '1688',
    platformLabel: '1688',
    title: stripHtml(firstPresent(data.title, data.subject, data.name)) || '未命名商品',
    imageUrl,
    price,
    priceText: price,
    sales,
    minOrder,
    shopName: stripHtml(firstPresent(data.shop?.text, data.shopName, data.loginId)),
    url: offerId ? `https://detail.1688.com/offer/${encodeURIComponent(offerId)}.html` : cleanUrl(firstPresent(data.linkUrl, data.sameDesignUrl)),
    link: offerId ? `https://detail.1688.com/offer/${encodeURIComponent(offerId)}.html` : cleanUrl(firstPresent(data.linkUrl, data.sameDesignUrl)),
    isAd: Boolean(data.isAd || data.isP4P || data.type === 'p4p'),
    hint: '来自 1688 以图搜款，请人工核对规格和价格',
  };
}

function normalizeTaobaoSearchResult(item = {}, index = 0, searchUrl = '') {
  const title = normalizeSearchResultTitle(firstPresent(item.title, item.rawTitle, item.raw_title, item.name));
  const itemId = firstPresent(item.nid, item.itemId, item.item_id, item.id);
  const rawLink = cleanUrl(firstPresent(item.detailUrl, item.detail_url, item.url, item.link));
  const link = rawLink || (itemId ? `https://item.taobao.com/item.htm?id=${encodeURIComponent(itemId)}` : searchUrl);
  const imageUrl = cleanUrl(firstPresent(item.picUrl, item.pic_url, item.imageUrl, item.imgUrl, item.image));
  const price = stripHtml(firstPresent(item.viewPrice, item.view_price, item.price, item.priceText));
  const shopName = stripHtml(firstPresent(item.nick, item.shopName, item.shop));
  return {
    id: itemId || `${index}-${title}`,
    title,
    url: link,
    link,
    imageUrl,
    price,
    priceText: price,
    shopName,
    platform: 'taobao',
    platformLabel: '淘宝',
    hint: [price, shopName, '淘宝以图搜款'].filter(Boolean).join(' · ') || '来自淘宝以图搜款，请人工核对规格和价格',
  };
}

function extractContextValue(context = '', patterns = []) {
  for (const pattern of patterns) {
    const match = context.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(decodeJsonString(match[1]));
  }
  return '';
}

export function extractTaobaoResults(html = '', searchUrl = '') {
  const candidates = [];
  const titlePatterns = [
    /"raw_title"\s*:\s*"([^"]{4,260})"/g,
    /"title"\s*:\s*"([^"]{4,260})"/g,
    /"itemTitle"\s*:\s*"([^"]{4,260})"/g,
    /data-title=["']([^"']{4,260})["']/g,
  ];
  titlePatterns.forEach((pattern) => {
    let match = pattern.exec(html);
    while (match) {
      const start = Math.max(0, match.index - 1200);
      const end = Math.min(html.length, match.index + 1800);
      const context = html.slice(start, end);
      candidates.push(normalizeTaobaoSearchResult({
        title: match[1],
        nid: extractContextValue(context, [/"nid"\s*:\s*"?(\\?\d{5,})"?/i, /[?&]id=(\d{5,})/i]),
        detailUrl: extractContextValue(context, [
          /"detail_url"\s*:\s*"([^"]+)"/i,
          /"detailUrl"\s*:\s*"([^"]+)"/i,
          /(https?:\\?\/\\?\/item\.taobao\.com\\?\/item\.htm\?[^"'<>\s]+)/i,
          /(\\?\/\\?\/item\.taobao\.com\\?\/item\.htm\?[^"'<>\s]+)/i,
        ]),
        picUrl: extractContextValue(context, [/"pic_url"\s*:\s*"([^"]+)"/i, /"picUrl"\s*:\s*"([^"]+)"/i]),
        viewPrice: extractContextValue(context, [/"view_price"\s*:\s*"([^"]+)"/i, /"viewPrice"\s*:\s*"([^"]+)"/i]),
        nick: extractContextValue(context, [/"nick"\s*:\s*"([^"]+)"/i, /"shopName"\s*:\s*"([^"]+)"/i]),
      }, candidates.length, searchUrl));
      match = pattern.exec(html);
    }
  });
  return collectUnique(candidates, 24).map((item, index) => normalizeTaobaoSearchResult(item, index, searchUrl));
}
