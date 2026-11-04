namespace Wangzai.CefBrowserHost;

/// <summary>
/// Product-page readers that prefer each marketplace's structured runtime state.
/// DOM selectors remain a fallback in <see cref="PurchaseCaptureScript"/>; they are
/// not trusted as the primary product data source because review/seller widgets can
/// use the same generic title and price class names as the product itself.
/// </summary>
internal static class PurchaseProductPlatformExtractors
{
	public static readonly string Value = PurchaseCaptureNumberScript.Value + """
  const platformImageUrl = (value) => {
    try {
      const raw = clean(typeof value === 'object'
        ? value?.url || value?.imageUrl || value?.image || value?.src || value?.contentUrl
        : value, 3000);
      if (!raw) return '';
      const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      return url.toString();
    } catch { return ''; }
  };
  const platformRows = (value) => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    // Pinduoduo exposes its SKU/spec collections as MobX observable arrays.
    // They deliberately report Array.isArray=false and have no enumerable
    // numeric keys, but keep the normal iterator/length contract. Object.values
    // therefore turns a complete 18-SKU matrix into an empty array. Consume the
    // iterable first and retain Object.values only for ordinary keyed maps.
    try {
      if (typeof value[Symbol.iterator] === 'function') return [...value];
    } catch { /* fall through to array-like/keyed-object handling */ }
    const length = Number(value.length);
    if (Number.isInteger(length) && length >= 0 && length <= 5000) {
      try {
        return Array.from({ length }, (_, index) => value[index]).filter(item => item != null);
      } catch { /* fall through */ }
    }
    return Object.values(value);
  };
  const platformUnique = (values, maximum = 200) => [...new Set((values || []).map(platformImageUrl).filter(Boolean))].slice(0, maximum);
  const platformFetch = async (url, options = {}, responseType = 'json') => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        credentials: 'include', redirect: 'follow', ...options, signal: controller.signal,
        headers: { accept: responseType === 'json' ? 'application/json' : 'text/html,*/*', ...(options.headers || {}) },
      });
      if (!response.ok) return null;
      return responseType === 'text' ? await response.text() : await response.json();
    } catch { return null; }
    finally { clearTimeout(timeout); }
  };
  const platformNumber = (value, cents = false) => {
    const direct = Array.isArray(value) ? value : typeof value === 'object' && value !== null
      ? value.price ?? value.value ?? value.amount ?? value.current ?? value.minPrice ?? value.priceText
      : value;
    const values = Array.isArray(direct) ? direct.flat(Infinity) : [direct];
    const matches = values.flatMap(item => clean(item, 180).replace(/\s/gu, '').match(/-?\d+(?:[.,]\d+)*/gu) || []);
    const numbers = matches.map(parseCaptureNumber).filter(number => number !== null && number > 0);
    if (!numbers.length) return '';
    const number = Math.min(...numbers) / (cents ? 100 : 1);
    return Number(number.toFixed(3)).toString();
  };
  const platformCurrency = (...values) => {
    const source = values.flat(Infinity).map(value => clean(
      value && typeof value === 'object'
        ? value.currencyCode || value.currency || value.currency_code || value.formatted || value.priceText || value.text
        : value,
      240,
    )).filter(Boolean).join(' ').toUpperCase();
    const explicit = source.match(/(?:^|[^A-Z])(CNY|RMB|RUB|USD|EUR|GBP|JPY|KRW|CAD|AUD|INR|TRY|BRL|MXN|PLN|AED|SAR)(?:[^A-Z]|$)/u)?.[1];
    if (explicit) return explicit === 'RMB' ? 'CNY' : explicit;
    if (/[¥￥]|\bCN¥\b/u.test(source)) return 'CNY';
    if (/₽|РУБ|РУБЛ/u.test(source)) return 'RUB';
    if (/€|ЕВРО/u.test(source)) return 'EUR';
    if (/£/u.test(source)) return 'GBP';
    if (/₹/u.test(source)) return 'INR';
    if (/₩/u.test(source)) return 'KRW';
    if (/\bUS\s*\$|\$/u.test(source)) return 'USD';
    return '';
  };
  const amazonHostCurrency = () => {
    const host = String(location.hostname || '').toLowerCase();
    if (/amazon\.(?:de|fr|it|es|nl|be)$/u.test(host)) return 'EUR';
    if (/amazon\.co\.uk$/u.test(host)) return 'GBP';
    if (/amazon\.co\.jp$/u.test(host)) return 'JPY';
    if (/amazon\.ca$/u.test(host)) return 'CAD';
    if (/amazon\.com\.au$/u.test(host)) return 'AUD';
    if (/amazon\.in$/u.test(host)) return 'INR';
    return 'USD';
  };
  const platformObjectSearch = (root, predicate, maximumDepth = 9) => {
    const seen = new WeakSet();
    const queue = [{ value: root, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      const value = current?.value;
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      try { if (predicate(value)) return value; } catch { /* keep searching */ }
      if (current.depth >= maximumDepth) continue;
      for (const child of Array.isArray(value) ? value : Object.values(value)) {
        if (child && typeof child === 'object') queue.push({ value: child, depth: current.depth + 1 });
      }
    }
    return null;
  };
  const platformJsonRoots = () => {
    const rows = [];
    const add = value => { if (value && typeof value === 'object') rows.push(value); };
    for (const name of ['__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', 'rawData', 'g_config', '__PRELOADED_STATE__']) {
      try { add(window[name]); } catch { /* inaccessible global */ }
    }
    for (const script of document.querySelectorAll('script[type="application/json"], script[id*="state" i], script[id*="data" i]')) {
      add(safeJson(script.textContent || ''));
    }
    return rows;
  };
  const balancedObjectAfter = (text, marker) => {
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return null;
    const start = text.indexOf('{', markerIndex + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '{') depth += 1;
      if (char === '}' && --depth === 0) return looseJson(text.slice(start, index + 1));
    }
    return null;
  };
  const balancedArrayAfter = (text, marker) => {
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return null;
    const start = text.indexOf('[', markerIndex + marker.length);
    if (start < 0) return null;
    let depth = 0, quote = '', escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '[') depth += 1;
      if (char === ']' && --depth === 0) return looseJson(text.slice(start, index + 1));
    }
    return null;
  };
  const scriptObject = (...markers) => {
    for (const script of document.scripts) {
      const source = script.textContent || '';
      if (!source || source.length > 8_000_000) continue;
      for (const marker of markers) {
        const value = balancedObjectAfter(source, marker);
        if (value) return value;
      }
    }
    return null;
  };
  const contextPathWrapper = source => {
    const text = String(source || '');
    // The page bundle can mention `window.contextPath` before the actual
    // bootstrap call. Prefer the exact `window.contextPath, {...});` payload;
    // only then use the generic balanced-object fallback.
    const exact = text.match(/window\.contextPath\s*,\s*(\{[\s\S]*\})\s*\)\s*;/u)?.[1];
    return exact ? looseJson(exact) : balancedObjectAfter(text, 'window.contextPath');
  };
  const attributesFromObject = (value) => {
    const output = [];
    const seen = new WeakSet();
    const visit = (row, depth = 0) => {
      if (!row || typeof row !== 'object' || seen.has(row) || depth > 6 || output.length >= 200) return;
      seen.add(row);
      const name = clean(row?.name || row?.key || row?.attrName || row?.attributeName || row?.propertyName || row?.title, 180);
      const rawValue = row?.value ?? row?.values ?? row?.attrValue ?? row?.valueName ?? row?.attributeValue ?? row?.propertyValue ?? row?.text;
      const itemValue = clean(Array.isArray(rawValue) ? rawValue.join(' / ') : rawValue, 500);
      if (name && itemValue && itemValue !== '[object Object]') output.push({ name, value: itemValue });
      for (const child of Array.isArray(row) ? row : Object.values(row)) visit(child, depth + 1);
    };
    visit(value);
    return output.slice(0, 200);
  };
  const htmlImageUrls = (value) => platformUnique([
    ...String(value || '').matchAll(/(?:src|data-src)=["']([^"']+)["']/giu),
  ].map(match => match[1]), 120);
  const platformTextContent = (selector, root = document) => {
    try { return clean(root?.querySelector?.(selector)?.textContent, 1200); } catch { return ''; }
  };
  const platformHtmlText = value => clean(String(value || '').replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/giu, ' ').replace(/<[^>]+>/gu, ' '), 8000);
  // 1688's `window.contextPath` is JSON-shaped, but skuInfoMap can contain
  // bare numeric keys (for example `123456:{...}`). JSON.parse rejects those.
  // Shangpinbang repairs those keys before parsing; keep the same state-machine
  // behaviour here instead of silently dropping to a one-SKU DOM fallback.
  const quoteNumericObjectKeys = value => {
    const source = String(value || '');
    let output = '', index = 0, quote = '', escaped = false;
    while (index < source.length) {
      const char = source[index];
      if (quote) {
        output += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        index += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        output += char;
        index += 1;
        continue;
      }
      if (/\d/u.test(char)) {
        let end = index;
        while (/\d/u.test(source[end] || '')) end += 1;
        if (source[end] === ':') {
          output += `"${source.slice(index, end)}":`;
          index = end + 1;
          continue;
        }
      }
      output += char;
      index += 1;
    }
    return output;
  };
  const looseJson = value => {
    const source = String(value || '').trim().slice(0, 12_000_000);
    const direct = safeJson(source);
    if (direct) return direct;
    const numericKeysQuoted = quoteNumericObjectKeys(source);
    const numericResult = safeJson(numericKeysQuoted);
    if (numericResult) return numericResult;
    try {
      return JSON.parse(numericKeysQuoted.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/gu, '$1"$2":')
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/gu, (_, text) => JSON.stringify(text.replace(/\\'/gu, "'"))));
    } catch { return null; }
  };
  const productIdFromLocation = (kind) => {
    const params = new URLSearchParams(location.search);
    if (kind === '1688') return clean(location.pathname.match(/\/offer\/(\d+)\.html/iu)?.[1] || params.get('offerId'), 260);
    if (kind === '淘宝' || kind === '天猫') return clean(params.get('id') || params.get('itemId'), 260);
    if (kind === '拼多多') return clean(params.get('goods_id') || params.get('goodsId'), 260);
    if (kind === 'Ozon买家') return clean(location.pathname.match(/(?:-|\/)(\d{5,})(?:\/|$)/u)?.[1], 260);
    if (kind === '京东') return clean(location.pathname.match(/\/(\d+)\.html/iu)?.[1] || params.get('sku'), 260);
    if (kind === 'Wildberries') return clean(location.pathname.match(/\/catalog\/(\d+)\/detail\.aspx/iu)?.[1] || params.get('nm'), 260);
    if (kind === 'Amazon') return clean(location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{8,16})/iu)?.[1] || params.get('asin'), 260);
    if (kind === 'Temu') return clean(params.get('goods_id') || params.get('goodsId') || location.pathname.match(/-g-(\d+)\.html/iu)?.[1], 260);
    if (kind === 'AliExpress') return clean(location.pathname.match(/\/item\/(\d+)\.html/iu)?.[1] || params.get('productId'), 260);
    return '';
  };
  const platformDimensionCm = (value, keyHint = '') => {
    const direct = value && typeof value === 'object'
      ? value.value ?? value.amount ?? value.number ?? value.size ?? value.text
      : value;
    const raw = clean(direct, 180).replace(/,/gu, '.');
    const match = raw.match(/\d+(?:\.\d+)?/u);
    if (!match) return '';
    const number = Number(match[0]);
    if (!Number.isFinite(number) || number <= 0) return '';
    const hint = `${clean(keyHint, 120)} ${raw}`.toLowerCase();
    let multiplier = 1;
    if (/(?:毫米|millimet(?:er|re)s?|mm(?:$|[^a-z]))/iu.test(hint)) multiplier = 0.1;
    else if (/(?:厘米|centimet(?:er|re)s?|cm(?:$|[^a-z]))/iu.test(hint)) multiplier = 1;
    else if (/(?:米|met(?:er|re)s?|m(?:$|[^a-z]))/iu.test(hint)) multiplier = 100;
    const centimetres = number * multiplier;
    return Number.isFinite(centimetres) && centimetres <= 100_000
      ? Number(centimetres.toFixed(3)).toString()
      : '';
  };
  const mergePlatformDimensions = (...rows) => {
    const result = { lengthCm: '', widthCm: '', heightCm: '' };
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const key of Object.keys(result)) {
        if (!result[key] && row[key]) result[key] = platformDimensionCm(row[key], 'cm');
      }
    }
    return result;
  };
  const platformDimensionTriplet = (value, keyHint = '') => {
    if (!value) return { lengthCm: '', widthCm: '', heightCm: '' };
    if (Array.isArray(value) && value.length >= 3) {
      return {
        lengthCm: platformDimensionCm(value[0], keyHint),
        widthCm: platformDimensionCm(value[1], keyHint),
        heightCm: platformDimensionCm(value[2], keyHint),
      };
    }
    if (typeof value !== 'object') {
      const raw = clean(value, 800).replace(/,/gu, '.');
      const match = raw.match(/(\d+(?:\.\d+)?)\s*(毫米|mm|厘米|cm|米|m)?\s*[xX×*＊✕]\s*(\d+(?:\.\d+)?)\s*(毫米|mm|厘米|cm|米|m)?\s*[xX×*＊✕]\s*(\d+(?:\.\d+)?)\s*(毫米|mm|厘米|cm|米|m)?/iu);
      if (!match) return { lengthCm: '', widthCm: '', heightCm: '' };
      const sharedUnit = match[6] || match[4] || match[2] || keyHint;
      return {
        lengthCm: platformDimensionCm(`${match[1]}${match[2] || sharedUnit}`, keyHint),
        widthCm: platformDimensionCm(`${match[3]}${match[4] || sharedUnit}`, keyHint),
        heightCm: platformDimensionCm(`${match[5]}${match[6] || sharedUnit}`, keyHint),
      };
    }
    const entries = new Map(Object.entries(value).map(([key, item]) => [
      String(key).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/gu, ''), item,
    ]));
    const read = aliases => aliases.map(alias => entries.get(alias)).find(item => item !== undefined && item !== null && item !== '');
    const readDimension = aliases => {
      for (const alias of aliases) {
        const item = entries.get(alias);
        if (item !== undefined && item !== null && item !== '') return [alias, item];
      }
      return ['', ''];
    };
    const unitHint = clean(read(['dimensionunit', 'sizeunit', 'packageunit', 'packunit', 'unit']), 40) || keyHint;
    const dimension = aliases => {
      const [matchedKey, item] = readDimension(aliases);
      return platformDimensionCm(item, `${matchedKey} ${unitHint}`);
    };
    const direct = {
      lengthCm: dimension([
        'packagelengthmm', 'packagelengthcm', 'packagelength', 'packlengthmm', 'packlengthcm', 'packlength',
        'packinglength', 'boxlength', 'cartonlength', 'outerlength', 'outerboxlength', 'logisticslength',
        'transportlength', 'volumelength', 'lengthmm', 'lengthcm', 'length',
        '包装长度', '包装长', '包裹长度', '外箱长度', '外箱长', '装箱长度',
      ]),
      widthCm: dimension([
        'packagewidthmm', 'packagewidthcm', 'packagewidth', 'packwidthmm', 'packwidthcm', 'packwidth',
        'packingwidth', 'boxwidth', 'cartonwidth', 'outerwidth', 'outerboxwidth', 'logisticswidth',
        'transportwidth', 'volumewidth', 'widthmm', 'widthcm', 'width',
        '包装宽度', '包装宽', '包裹宽度', '外箱宽度', '外箱宽', '装箱宽度',
      ]),
      heightCm: dimension([
        'packageheightmm', 'packageheightcm', 'packageheight', 'packheightmm', 'packheightcm', 'packheight',
        'packingheight', 'boxheight', 'cartonheight', 'outerheight', 'outerboxheight', 'logisticsheight',
        'transportheight', 'volumeheight', 'heightmm', 'heightcm', 'height', 'depthmm', 'depthcm', 'depth',
        '包装高度', '包装高', '包裹高度', '外箱高度', '外箱高', '装箱高度',
      ]),
    };
    const combinedAliases = [
      'packagedimensions', 'packagedimension', 'packagesize', 'packsize', 'packingsize', 'boxsize',
      'cartonsize', 'outerboxsize', 'dimensions', 'dimension', 'sizeinfo', 'size',
      '包装尺寸', '包裹尺寸', '外箱尺寸', '装箱尺寸', '箱规',
    ];
    let combined = { lengthCm: '', widthCm: '', heightCm: '' };
    for (const alias of combinedAliases) {
      const candidate = entries.get(alias);
      if (candidate === undefined || candidate === value) continue;
      combined = mergePlatformDimensions(combined, platformDimensionTriplet(candidate, unitHint));
    }
    for (const alias of ['packageinfo', 'packinfo', 'packinginfo', 'boxinfo', 'cartoninfo', 'volumeinfo', 'volume']) {
      const candidate = entries.get(alias);
      if (!candidate || typeof candidate !== 'object' || candidate === value) continue;
      combined = mergePlatformDimensions(combined, platformDimensionTriplet(candidate, unitHint));
    }
    return mergePlatformDimensions(direct, combined);
  };
  const packageDimensionsFromAttributes = value => {
    const result = { lengthCm: '', widthCm: '', heightCm: '' };
    for (const row of platformRows(value)) {
      const name = clean(row?.name || row?.key || row?.attrName || row?.attributeName || row?.propertyName || row?.title, 180);
      const rawValue = row?.value ?? row?.values ?? row?.attrValue ?? row?.valueName ?? row?.attributeValue ?? row?.propertyValue ?? row?.text;
      const itemValue = clean(Array.isArray(rawValue) ? rawValue.join(' / ') : rawValue, 800);
      if (!/(?:包装|包裹|外箱|装箱|箱规|物流|运输|package|packing|parcel|carton)/iu.test(name)) continue;
      const combined = platformDimensionTriplet(itemValue, name);
      Object.assign(result, mergePlatformDimensions(result, combined));
      if (/(?:长度|长|length)/iu.test(name)) result.lengthCm ||= platformDimensionCm(itemValue, name);
      if (/(?:宽度|宽|width)/iu.test(name)) result.widthCm ||= platformDimensionCm(itemValue, name);
      if (/(?:高度|高|厚|height|depth)/iu.test(name)) result.heightCm ||= platformDimensionCm(itemValue, name);
    }
    return result;
  };
  const packageDimensionsFromText = value => {
    const source = String(value || '').replace(/\s+/gu, ' ').slice(0, 200_000);
    const result = { lengthCm: '', widthCm: '', heightCm: '' };
    const marker = /(?:包装尺寸|包裹尺寸|外箱尺寸|装箱尺寸|包装规格|箱规|package\s*(?:dimensions?|size)|carton\s*size)/giu;
    for (const match of source.matchAll(marker)) {
      const combined = platformDimensionTriplet(source.slice(match.index, match.index + 260), match[0]);
      Object.assign(result, mergePlatformDimensions(result, combined));
    }
    const singles = [
      ['lengthCm', /(?:包装|包裹|外箱|装箱)(?:长度|长)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*(毫米|mm|厘米|cm|米|m)?/iu],
      ['widthCm', /(?:包装|包裹|外箱|装箱)(?:宽度|宽)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*(毫米|mm|厘米|cm|米|m)?/iu],
      ['heightCm', /(?:包装|包裹|外箱|装箱)(?:高度|高|厚度|厚)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*(毫米|mm|厘米|cm|米|m)?/iu],
    ];
    for (const [key, pattern] of singles) {
      const match = source.match(pattern);
      if (match) result[key] ||= platformDimensionCm(`${match[1]}${match[2] || ''}`, match[0]);
    }
    return result;
  };
  const productResult = (value = {}) => {
    const priceNumbers = value => {
      const rows = Array.isArray(value) ? value.flat(Infinity) : [value];
      return rows.flatMap(item => {
        const direct = item && typeof item === 'object'
          ? item.price ?? item.value ?? item.amount ?? item.current ?? item.minPrice ?? item.maxPrice ?? item.priceText
          : item;
        return (clean(direct, 1000).replace(/\s/gu, '').match(/-?\d+(?:[.,]\d+)*/gu) || [])
          .map(parseCaptureNumber).filter(number => number !== null && number > 0);
      });
    };
    const inputPrices = priceNumbers([
      value.purchasePriceMin, value.purchasePriceMax, value.purchasePrice,
      ...(Array.isArray(value.priceTiers) ? value.priceTiers : []),
    ]);
    const purchasePrice = inputPrices.length ? Number(Math.min(...inputPrices).toFixed(3)).toString() : '';
    const skuAttribute = item => {
      if (item && typeof item === 'object') {
        const name = clean(item?.name || item?.key || item?.label || item?.property, 180);
        const rawValue = Array.isArray(item?.value || item?.values)
          ? (item.value || item.values).join(' / ')
          : item?.value || item?.values || item?.valueName || item?.text;
        const attributeValue = clean(rawValue, 300);
        if (name && attributeValue) return { name, value: attributeValue };
        return attributeValue;
      }
      return clean(item, 300);
    };
    const skus = (value.skus || []).map((row, index) => ({
      id: clean(row?.id || row?.skuId || `sku-${index + 1}`, 260),
      name: clean(row?.name || row?.skuName || row?.variant, 500),
      attributes: (row?.attributes || []).map(skuAttribute).filter(Boolean).slice(0, 30),
      price: platformNumber(row?.price || purchasePrice), imageUrl: platformImageUrl(row?.imageUrl || row?.image),
      weightG: platformNumber(row?.weightG), weightKg: platformNumber(row?.weightKg),
      lengthCm: platformNumber(row?.lengthCm), widthCm: platformNumber(row?.widthCm), heightCm: platformNumber(row?.heightCm),
      option: row?.option && typeof row.option === 'object' ? row.option : undefined,
    })).filter(row => row.id && (row.price || purchasePrice)).slice(0, 800);
    const allPrices = [...inputPrices, ...skus.flatMap(row => priceNumbers(row.price))];
    const purchasePriceMin = allPrices.length ? Number(Math.min(...allPrices).toFixed(3)).toString() : '';
    const purchasePriceMax = allPrices.length ? Number(Math.max(...allPrices).toFixed(3)).toString() : '';
    const nonNegativeNumber = input => {
      const raw = clean(input, 180).replace(/\s/gu, '').replace(/,/gu, '.');
      if (/^(?:0|0\.0+)$/u.test(raw)) return '0';
      return platformNumber(input);
    };
    const currency = platformCurrency(
      value.currency,
      value.purchasePrice,
      value.purchasePriceMin,
      value.purchasePriceMax,
      (value.skus || []).map(row => row?.price),
    );
    return {
      productTitle: clean(value.productTitle, 1000),
      purchasePrice: purchasePriceMin || purchasePrice || platformNumber(skus.map(row => row.price).filter(Boolean)),
      purchasePriceMin, purchasePriceMax,
      sourceProductId: clean(value.sourceProductId, 260),
      mainImages: platformUnique(value.mainImages, 60),
      skuImages: (value.skuImages || []).map((row) => ({
      skuId: clean(row?.skuId || row?.id, 260), skuName: clean(row?.skuName || row?.name, 500),
      imageUrl: platformImageUrl(row?.imageUrl || row?.image),
    })).filter(row => row.imageUrl).slice(0, 800),
      detailImages: platformUnique(value.detailImages, 300), skus,
      description: clean(value.description, 8000), attributes: attributesFromObject(value.attributes),
      brand: clean(value.brand, 180), category: clean(value.category || value.sourceCategoryName, 500),
      sourceCategoryId: clean(value.sourceCategoryId, 180),
      sourceCategoryName: clean(value.sourceCategoryName || value.category, 500),
      sourceCategoryPath: clean(value.sourceCategoryPath || value.sourceCategoryName || value.category, 1000),
      videoUrl: platformImageUrl(value.videoUrl),
      currency,
      weightG: platformNumber(value.weightG), weightKg: platformNumber(value.weightKg),
      weightMinG: platformNumber(value.weightMinG), weightMaxG: platformNumber(value.weightMaxG),
      lengthCm: platformNumber(value.lengthCm), widthCm: platformNumber(value.widthCm), heightCm: platformNumber(value.heightCm),
      shippingStatus: clean(value.shippingStatus || 'unknown', 40),
      shippingFeeMin: nonNegativeNumber(value.shippingFeeMin), shippingFeeMax: nonNegativeNumber(value.shippingFeeMax),
      shippingCurrency: clean(value.shippingCurrency || currency, 12),
      shippingRuleText: clean(value.shippingRuleText, 500),
      minimumOrderQuantity: platformNumber(value.minimumOrderQuantity),
      minimumOrderUnit: clean(value.minimumOrderUnit, 40),
      mixedBatchStatus: clean(value.mixedBatchStatus || 'unknown', 20),
      perSkuMinimumQuantity: platformNumber(value.perSkuMinimumQuantity),
      purchaseMultiple: platformNumber(value.purchaseMultiple),
      deliveryLeadTimeHours: platformNumber(value.deliveryLeadTimeHours),
      deliveryText: clean(value.deliveryText, 300),
      sourceMethod: clean(value.sourceMethod, 100),
    };
  };

  const read1688Product = async () => {
    const offerId = productIdFromLocation('1688');
    const original1688Image = (value) => {
      const url = platformImageUrl(value);
      if (!url) return '';
      return url
        .replace(/_[0-9]+x[0-9]+(?:q\d+)?\.[a-z]+(?=$|\?)/iu, '')
        .replace(/_[a-z]{1,6}\.[a-z]{3,5}(?=$|\?)/iu, '');
    };
    const collectRenderedImages = () => {
      const pageImages = { main: [], detail: [] };
      const addPageImages = (selector, target) => {
      try {
        for (const element of document.querySelectorAll(selector)) {
            const sourceSet = clean(element?.getAttribute?.('srcset'), 8000).split(/\s*,\s*/u)
              .map(row => row.trim().split(/\s+/u)[0]).filter(Boolean).reverse();
            const candidates = [
              element?.getAttribute?.('data-ks-lazyload'), element?.getAttribute?.('data-lazy-src'),
              element?.getAttribute?.('data-original'), element?.getAttribute?.('data-src'),
              ...sourceSet, element?.currentSrc, element?.src,
            ];
            const url = candidates.map(original1688Image).find(Boolean);
            if (url) target.push(url);
          }
        } catch { /* optional rendered image lane */ }
      };
      addPageImages('.detail-gallery-img, .preview-img, .od-gallery-img', pageImages.main);
      addPageImages('.desc-img-loaded, #desc-lazyload-container img, [class*="html-description"] img', pageImages.detail);
      try {
        for (const host of document.querySelectorAll('.html-description')) {
          for (const image of host.shadowRoot?.querySelectorAll?.('#detail img, img') || []) {
            const url = original1688Image(image?.getAttribute?.('data-ks-lazyload') || image?.getAttribute?.('data-lazy-src')
              || image?.getAttribute?.('data-src') || image?.currentSrc || image?.src);
            if (url) pageImages.detail.push(url);
          }
        }
      } catch { /* closed or absent shadow root */ }
      return pageImages;
    };
    let pageImages = collectRenderedImages();
    // Shangpinbang forces the page to the bottom when 1688 has not materialised
    // `.desc-img-loaded` yet. CEF needs a little longer than the extension's
    // 50 ms, otherwise the capture wins the race against lazy image loading.
    if (!pageImages.detail.length && typeof window.scrollTo === 'function') {
      const originalScrollY = Number(window.scrollY || document.documentElement?.scrollTop || 0);
      try {
        window.scrollTo(0, Math.max(99_999, Number(document.body?.scrollHeight || 0)));
        await new Promise(resolve => setTimeout(resolve, 550));
        const loadedImages = collectRenderedImages();
        pageImages = {
          main: [...new Set([...pageImages.main, ...loadedImages.main])],
          detail: [...new Set([...pageImages.detail, ...loadedImages.detail])],
        };
      } finally {
        window.scrollTo(0, originalScrollY);
      }
    }

    const roots = [];
    let canonicalLoaded = false;
    if (offerId) {
      const html = await platformFetch(`https://detail.1688.com/offer/${offerId}.html?version=default`, {}, 'text');
      if (html) {
        for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)) {
          const source = match[1] || '';
          if (!source.includes('window.contextPath') || !source.includes('result')) continue;
          const wrapper = contextPathWrapper(source);
          if (wrapper?.result) { roots.push(wrapper.result); canonicalLoaded = true; break; }
        }
      }
    }
    for (const script of document.scripts || []) {
      const source = script.textContent || '';
      if (!source.includes('window.contextPath') || !source.includes('result')) continue;
      const wrapper = contextPathWrapper(source);
      if (wrapper?.result) roots.push(wrapper.result);
    }
    roots.push(...platformJsonRoots());
    const embedded = scriptObject('"skuInfoMap":', '"skuModel":', '"offerImgList":', '"featureAttributes":');
    if (embedded) roots.push(embedded);

    let root = roots.find(value => value?.data?.Root?.fields?.dataJson?.skuModel?.skuInfoMap) || null;
    let model = root?.data?.Root?.fields?.dataJson || null;
    if (!model) {
      for (const candidate of roots) {
        model = platformObjectSearch(candidate, value => Boolean(value?.skuInfoMap || value?.skuModel?.skuInfoMap || value?.offerImgList), 12);
        if (model) { root = candidate; break; }
      }
    }
    if (!model) return productResult({ sourceProductId: offerId, sourceMethod: '1688-structured-missing' });

    const skuModel = model.skuModel || model;
    const skuMap = skuModel.skuInfoMap || model.skuInfoMap || {};
    const firstPropValues = platformRows(platformRows(skuModel.skuProps || model.skuProps)[0]?.value
      || platformRows(skuModel.skuProps || model.skuProps)[0]?.values);
    const propertyImages = firstPropValues.map(row => ({
      name: clean(row?.name || row?.valueName || row?.text || row?.label, 180),
      imageUrl: platformImageUrl(row?.imageUrl || row?.image || row?.picture),
    })).filter(row => row.name && row.imageUrl).sort((a, b) => b.name.length - a.name.length);
    const fallbackImage = propertyImages[0]?.imageUrl || platformImageUrl(root?.data?.gallery?.fields?.offerImgList?.[0]);
    const priceScale = clean(skuModel.skuPriceScale || model.skuPriceScale, 180);
    const scaleParts = priceScale.split('-').map(value => platformNumber(value)).filter(Boolean);
    const fallbackPrice = scaleParts[0] || platformNumber(model.price || model.priceText);
    const packFields = root?.data?.productPackInfo?.fields || model?.productPackInfo?.fields || {};
    const structuredPackDimensions = platformDimensionTriplet(packFields);
    const weights = platformRows(packFields?.pieceWeightScale?.pieceWeightScaleInfo || packFields?.pieceWeightScaleInfo);
    const defaultUnitWeight = Number(packFields?.unitWeight || model?.unitWeight || 0);
    const skus = Object.entries(skuMap).map(([key, row], index) => {
      const specText = clean(row?.specAttrs || row?.skuName || key, 500).replace(/&gt;/giu, '-');
      const imageMatch = propertyImages.find(item => specText.includes(item.name));
      const weightRow = weights.find(item => String(item?.skuId || item?.specId) === String(row?.skuId || row?.specId));
      const unitWeightKg = Number(weightRow?.unitWeight || defaultUnitWeight || 0);
      const directWeightG = Number(weightRow?.weight || 0);
      const skuPackFields = row?.productPackInfo?.fields || row?.packageInfo || row?.packInfo || row?.packingInfo || row?.package || {};
      const skuDimensions = mergePlatformDimensions(
        platformDimensionTriplet(weightRow || {}),
        platformDimensionTriplet(skuPackFields),
      );
      return {
        id: row?.skuId || row?.specId || row?.id || specText || `sku-${index + 1}`,
        name: specText, attributes: specText.split(/\s*[;&>|]\s*/u).filter(Boolean),
        price: row?.price || row?.discountPrice || row?.priceText || row?.consignPrice || fallbackPrice,
        imageUrl: row?.imageUrl || imageMatch?.imageUrl || fallbackImage,
        weightG: unitWeightKg > 0 ? unitWeightKg * 1000 : directWeightG > 0 ? directWeightG : '',
        lengthCm: skuDimensions.lengthCm, widthCm: skuDimensions.widthCm, heightCm: skuDimensions.heightCm,
        option: weightRow || (defaultUnitWeight ? { unitWeight: defaultUnitWeight } : undefined),
      };
    });
    const galleryFields = root?.data?.gallery?.fields || {};
    const featureAttributes = root?.global?.globalData?.model?.offerDetail?.featureAttributes
      || model.featureAttributes || model.attributes || model.offerDetail?.featureAttributes || [];
    const firstStructuredValue = (source, aliases, maximumDepth = 9) => {
      const wanted = new Set(aliases.map(alias => String(alias).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/gu, '')));
      const seen = new WeakSet();
      const queue = [{ value: source, depth: 0 }];
      while (queue.length) {
        const current = queue.shift();
        const value = current?.value;
        if (!value || typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value);
        for (const [key, item] of Object.entries(value)) {
          const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/gu, '');
          if (wanted.has(normalizedKey) && item !== null && item !== undefined && item !== '') return item;
        }
        if (current.depth >= maximumDepth) continue;
        for (const child of Array.isArray(value) ? value : Object.values(value)) {
          if (child && typeof child === 'object') queue.push({ value: child, depth: current.depth + 1 });
        }
      }
      return '';
    };
    const attributeValue = pattern => {
      const row = platformRows(featureAttributes).find(item => pattern.test(clean(
        item?.name || item?.key || item?.attrName || item?.attributeName || item?.propertyName,
        180
      )));
      const value = row?.value ?? row?.values ?? row?.attrValue ?? row?.attributeValue ?? row?.propertyValue ?? '';
      return clean(Array.isArray(value) ? value.join(' / ') : value, 800);
    };
    const pageText = clean(
      document.body?.innerText || document.documentElement?.innerText || document.documentElement?.textContent || '',
      200_000
    );
    const sourceCategoryName = clean(
      firstStructuredValue(model, ['leafCategoryName', 'categoryName', 'catName', 'category'])
        || attributeValue(/^(?:产品类别|商品类别|产品分类|商品分类|品类|类别)$/iu),
      500
    );
    const sourceCategoryId = clean(firstStructuredValue(model, [
      'leafCategoryId', 'categoryId', 'catId', 'categoryID', 'leafCatId',
    ]), 180);
    const sourceCategoryPath = clean(firstStructuredValue(model, [
      'categoryPathName', 'categoryPath', 'categoryNamePath', 'categoryFullName', 'categoryBreadcrumb',
    ]) || sourceCategoryName, 1000);

    const structuredFreight = firstStructuredValue(model, [
      'shippingFee', 'freightPrice', 'postFee', 'logisticsFee', 'deliveryFee', 'freight', 'carriage',
    ]);
    const startingFreightMatch = pageText.match(/运费\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*起/iu);
    const fixedFreightMatch = pageText.match(/运费\s*[¥￥]?\s*(\d+(?:\.\d+)?)/iu);
    const freeShipping = /(?:^|[\s，,；;])(?:运费)?包邮(?:[\s，,；;。]|$)/iu.test(pageText);
    let shippingStatus = 'unknown';
    let shippingFeeMin = '';
    let shippingFeeMax = '';
    let shippingRuleText = '';
    if (startingFreightMatch) {
      shippingStatus = 'starting';
      shippingFeeMin = startingFreightMatch[1];
      shippingRuleText = `运费 ¥${shippingFeeMin} 起，按收货地区结算`;
    } else if (freeShipping) {
      shippingStatus = 'free';
      shippingFeeMin = '0';
      shippingFeeMax = '0';
      shippingRuleText = '包邮';
    } else if (fixedFreightMatch) {
      shippingStatus = /(?:按地区|地区不同|配送地|收货地|起)/u.test(pageText) ? 'destination' : 'fixed';
      shippingFeeMin = fixedFreightMatch[1];
      shippingFeeMax = shippingStatus === 'fixed' ? shippingFeeMin : '';
      shippingRuleText = shippingStatus === 'fixed'
        ? `运费 ¥${shippingFeeMin}`
        : `运费 ¥${shippingFeeMin}，最终金额按收货地区结算`;
    } else if (structuredFreight !== '') {
      shippingFeeMin = platformNumber(structuredFreight);
      shippingStatus = shippingFeeMin ? 'destination' : 'unknown';
      shippingRuleText = shippingFeeMin ? `页面返回运费 ¥${shippingFeeMin}，核价时需复核收货地区` : '';
    } else if (/(?:运费待议|运费面议|按地区计费|到付)/u.test(pageText)) {
      shippingStatus = 'destination';
      shippingRuleText = '运费按收货地区或卖家规则结算';
    }

    const minimumOrderMatch = pageText.match(/(\d+(?:\.\d+)?)\s*(件|个|副|套|盒|箱|包|只|双|组|张|条|台|支|瓶|卷|米)\s*(?:起批|起订|起购)/u);
    const structuredMinimumOrder = firstStructuredValue(model, [
      'minimumOrderQuantity', 'minOrderQuantity', 'beginAmount', 'beginQuantity', 'minQuantity', 'batchNum', 'moq',
    ]);
    const minimumOrderQuantity = minimumOrderMatch?.[1] || platformNumber(structuredMinimumOrder);
    const minimumOrderUnit = minimumOrderMatch?.[2] || clean(firstStructuredValue(model, [
      'saleUnit', 'amountUnit', 'quantityUnit', 'unitName', 'offerUnit',
    ]), 40);
    const mixedBatchStatus = /不支持混批/u.test(pageText)
      ? 'no'
      : /(?:支持混批|可混批)/u.test(pageText) ? 'yes' : 'unknown';
    const perSkuMinimumQuantity = platformNumber(firstStructuredValue(model, [
      'perSkuMinimumQuantity', 'skuMinimumQuantity', 'minSkuQuantity', 'singleSkuMinQuantity',
    ]));
    const purchaseMultiple = platformNumber(firstStructuredValue(model, [
      'purchaseMultiple', 'orderMultiple', 'batchMultiple', 'quantityMultiple',
    ]));
    const deliveryMatch = pageText.match(/(?:承诺)?\s*(\d+(?:\.\d+)?)\s*(小时|天)\s*(?:内)?发货/u);
    const deliveryLeadTimeHours = deliveryMatch
      ? Number((Number(deliveryMatch[1]) * (deliveryMatch[2] === '天' ? 24 : 1)).toFixed(3)).toString()
      : platformNumber(firstStructuredValue(model, ['deliveryLeadTimeHours', 'deliveryHours', 'shipWithinHours']));
    const deliveryText = deliveryMatch
      ? `${/承诺/u.test(deliveryMatch[0]) ? '承诺' : ''}${deliveryMatch[1]}${deliveryMatch[2]}内发货`
      : clean(firstStructuredValue(model, ['deliveryText', 'deliveryPromise', 'shipPromise']), 300);
    const description = platformRows(featureAttributes).map(row => {
      const value = Array.isArray(row?.value || row?.values) ? (row.value || row.values).join(' / ') : row?.value || row?.values;
      return `${clean(row?.name || row?.key, 180)}:${clean(value, 500)}`;
    }).filter(row => row !== ':').join('\n');
    const attributePackDimensions = packageDimensionsFromAttributes(featureAttributes);
    const renderedPackDimensions = packageDimensionsFromText(document.body?.innerText || document.documentElement?.innerText || '');
    const completeSkuDimensions = skus.filter(row => row.lengthCm && row.widthCm && row.heightCm);
    const commonSkuDimensions = completeSkuDimensions.length && completeSkuDimensions.length === skus.length
      && completeSkuDimensions.every(row => row.lengthCm === completeSkuDimensions[0].lengthCm
        && row.widthCm === completeSkuDimensions[0].widthCm && row.heightCm === completeSkuDimensions[0].heightCm)
      ? completeSkuDimensions[0]
      : {};
    const productPackDimensions = mergePlatformDimensions(
      structuredPackDimensions,
      attributePackDimensions,
      renderedPackDimensions,
      commonSkuDimensions,
    );
    const completedSkus = skus.map(row => ({
      ...row,
      lengthCm: row.lengthCm || productPackDimensions.lengthCm,
      widthCm: row.widthCm || productPackDimensions.widthCm,
      heightCm: row.heightCm || productPackDimensions.heightCm,
    }));
    const mainImages = [
      ...platformRows(galleryFields.offerImgList || model.offerImgList || model.imageList || model.images)
        .map(row => row?.fullPathImageURI || row?.imageUrl || row?.url || row),
      ...pageImages.main,
    ];
    const skuWeights = completedSkus.map(row => platformNumber(row.weightG)).filter(Boolean).map(Number);
    const weightMinG = skuWeights.length ? Number(Math.min(...skuWeights).toFixed(3)).toString() : '';
    const weightMaxG = skuWeights.length ? Number(Math.max(...skuWeights).toFixed(3)).toString() : '';
    const consensusWeightG = weightMinG && weightMinG === weightMaxG ? weightMinG : '';
    return productResult({
      productTitle: galleryFields.subject || root?.data?.productTitle?.fields?.title || model.subject || model.title || model.offerTitle,
      purchasePrice: completedSkus.map(row => row.price).filter(Boolean),
      purchasePriceMin: scaleParts[0], purchasePriceMax: scaleParts[1] || scaleParts[0],
      sourceProductId: model.offerId || model.productId || offerId, mainImages,
      skuImages: completedSkus.map(row => ({ skuId: row.id, skuName: row.name, imageUrl: row.imageUrl })),
      detailImages: [...pageImages.detail, ...htmlImageUrls(model.detailContent || model.description || '')],
      skus: completedSkus, description, attributes: featureAttributes,
      brand: model.brandName || model.brand, category: sourceCategoryName,
      sourceCategoryId, sourceCategoryName, sourceCategoryPath,
      videoUrl: galleryFields.video?.videoUrl,
      weightG: consensusWeightG || (defaultUnitWeight > 0 ? (defaultUnitWeight < 100 ? defaultUnitWeight * 1000 : defaultUnitWeight) : ''),
      weightMinG, weightMaxG,
      lengthCm: productPackDimensions.lengthCm,
      widthCm: productPackDimensions.widthCm,
      heightCm: productPackDimensions.heightCm,
      shippingStatus, shippingFeeMin, shippingFeeMax, shippingCurrency: 'CNY', shippingRuleText,
      minimumOrderQuantity, minimumOrderUnit, mixedBatchStatus, perSkuMinimumQuantity, purchaseMultiple,
      deliveryLeadTimeHours, deliveryText,
      currency: 'CNY',
      sourceMethod: canonicalLoaded ? '1688-default-structured' : '1688-structured-state',
    });
  };

  const requestMtop = async (api, data) => {
    const request = window.lib?.mtop?.request;
    if (typeof request !== 'function') return null;
    return await new Promise((resolve) => {
      let settled = false;
      const done = value => { if (!settled) { settled = true; resolve(value || null); } };
      const timer = setTimeout(() => done(null), 7000);
      try {
        const output = request({ api, v: api.includes('getdesc') ? '7.0' : '1.0', data: JSON.stringify(data), type: 'get', dataType: 'json' },
          value => { clearTimeout(timer); done(value); }, () => { clearTimeout(timer); done(null); });
        if (output?.then) output.then(value => { clearTimeout(timer); done(value); }).catch(() => { clearTimeout(timer); done(null); });
      } catch { clearTimeout(timer); done(null); }
    });
  };
  const readTaobaoProduct = async (kind) => {
    const itemId = productIdFromLocation(kind);
    let payload = null;
    let sourceMethod = 'taobao-structured-state';
    if (itemId) {
      const response = await requestMtop('mtop.taobao.pcdetail.data.get', {
        id: itemId, itemNumId: itemId, detail_v: '3.3.2',
        exParams: JSON.stringify({ id: itemId, queryParams: `id=${itemId}` }),
      });
      payload = response?.data?.data || response?.data || null;
      if (payload) sourceMethod = 'taobao-mtop';
    }
    if (!payload) {
      for (const root of platformJsonRoots()) {
        payload = platformObjectSearch(root, value => Boolean(value?.item?.title && (value?.skuBase || value?.skuCore)), 12);
        if (payload) break;
      }
    }
    if (!payload) return productResult({ sourceProductId: itemId, currency: 'CNY', sourceMethod: 'taobao-structured-missing' });
    const item = payload.item || payload.itemInfo || {};
    const skuBase = payload.skuBase || {};
    const skuCore = payload.skuCore || {};
    const priceMap = skuCore.sku2info || skuCore.sku2Info || {};
    const props = platformRows(skuBase.props);
    const propNames = new Map();
    const propGroups = new Map();
    const propImages = new Map();
    for (const group of props) {
      const groupName = clean(group?.name || group?.propName || group?.title || group?.label || '规格', 180);
      for (const option of platformRows(group?.values)) {
        const key = clean(option?.vid || option?.valueId || option?.id, 120);
        const label = clean(option?.name || option?.valueName, 180);
        if (key && label) propNames.set(key, label);
        if (key && label) propGroups.set(key, groupName);
        const image = platformImageUrl(option?.image || option?.imageUrl);
        if (key && image) propImages.set(key, image);
      }
    }
    const skus = platformRows(skuBase.skus).map((row, index) => {
      const propPath = clean(row?.propPath || row?.prop_path, 500);
      const ids = [...propPath.matchAll(/:(\d+)/gu)].map(match => match[1]);
      const info = priceMap[row?.skuId] || priceMap[String(row?.skuId)] || {};
      const price = info?.price?.priceText || info?.price?.priceMoney || info?.priceText || info?.price || row?.price;
      return {
        id: row?.skuId || row?.id || `sku-${index + 1}`,
        name: ids.map(id => propNames.get(id)).filter(Boolean).join(' / ') || row?.skuName || propPath,
        attributes: ids.map(id => propNames.get(id) ? ({ name: propGroups.get(id) || '规格', value: propNames.get(id) }) : null).filter(Boolean), price,
        imageUrl: ids.map(id => propImages.get(id)).find(Boolean),
      };
    });
    const defaultPrice = priceMap['0'] || priceMap.default || {};
    let descriptionHtml = payload.desc || payload.description || '';
    let detailImages = htmlImageUrls(descriptionHtml);
    if (itemId) {
      const descResponse = await requestMtop('mtop.taobao.detail.getdesc', { id: itemId, type: '0', f: 'json' });
      const componentData = descResponse?.data?.components?.componentData || descResponse?.data?.data?.components?.componentData || {};
      const richText = componentData?.desc_richtext_pc?.model?.text || componentData?.desc_richtext?.model?.text
        || descResponse?.data?.pcDescContent || descResponse?.data?.wdescContent || descResponse?.data?.desc || '';
      const componentImages = Object.values(componentData || {}).flatMap(component => {
        const model = component?.model || component;
        return [model?.picUrl, model?.image, model?.imageUrl, ...platformRows(model?.images)].filter(Boolean);
      });
      if (richText) descriptionHtml = richText;
      detailImages = platformUnique([...htmlImageUrls(descriptionHtml), ...componentImages], 120);
    }
    const mainImages = item.images || item.image || item.picsPath || payload.images || [];
    const baseProps = platformRows(payload?.componentsVO?.extensionInfoVO?.infos)
      .find(row => row?.type === 'BASE_PROPS')?.items;
    return productResult({
      productTitle: item.title || item.shortTitle || payload.title,
      purchasePrice: defaultPrice?.price?.priceText || defaultPrice?.priceText || defaultPrice?.price || skus[0]?.price,
      sourceProductId: item.itemId || item.id || itemId, mainImages,
      skuImages: skus.map(row => ({ skuId: row.id, skuName: row.name, imageUrl: row.imageUrl })),
      detailImages, skus,
      description: descriptionHtml.replace(/<[^>]+>/gu, ' '),
      attributes: baseProps || payload.props || payload.params || item.props,
      brand: item.brand || payload.brand, category: item.category || payload.category,
      videoUrl: item?.videos?.[0]?.url,
      currency: 'CNY',
      sourceMethod,
    });
  };

  const readPddProduct = async () => {
    const productId = productIdFromLocation('拼多多');
    const snapshotStoreKey = '__wangzaiPddProductSnapshotV1';
    const snapshotStore = (() => {
      const current = window[snapshotStoreKey];
      if (current?.version === 1 && current.records && typeof current.records === 'object') return current;
      const created = { version: 1, records: {}, order: [] };
      try { window[snapshotStoreKey] = created; } catch { /* page can still be read without persistent cache */ }
      return created;
    })();
    const cloneGoods = value => {
      try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
    };
    const goodsIdentity = value => clean(value?.goodsID || value?.goodsId || value?.goods_id || productId, 260);
    const goodsSkuRows = value => platformRows(
      value?.skus
      || value?.sku?.skus
      || (Array.isArray(value?.sku) ? value.sku : null)
      || value?.skuList
      || value?.sku_list
    );
    const goodsImages = value => platformRows(value?.topGallery || value?.top_gallery || value?.viewImageData || value?.view_image_data || value?.gallery || value?.goodsGalleryUrls || value?.goods_gallery_urls || value?.images);
    const pddSkuId = row => clean(row?.sku_id || row?.skuId || row?.skuID || row?.id, 260);
    const pddSkuAttributes = row => platformRows(row?.specs || row?.specifications).map(item => clean(
      item?.spec_value || item?.specValue || item?.value || item?.name,
      180,
    )).filter(Boolean);
    const pddSkuLabel = row => clean(row?.label || row?.showContent || row?.show_content || row?.specValue || row?.spec_value || row?.skuName || row?.specName, 500);
    const pddSkuPrice = row => platformNumber(row?.groupPrice || row?.normalPrice)
      || platformNumber(row?.group_price || row?.normal_price, true)
      || platformNumber(row?.group_price_in_cent || row?.groupPriceInCent || row?.normal_price_in_cent || row?.normalPriceInCent || row?.skuPrice, true)
      || platformNumber(row?.priceDisplay?.price || row?.price_display?.price);
    const goodsValidSkuRows = value => {
      const rows = goodsSkuRows(value);
      return rows.filter(row => pddSkuId(row) && (
        pddSkuAttributes(row).length
        || pddSkuLabel(row)
        || pddSkuPrice(row)
        || rows.length === 1
      ));
    };
    const goodsComplete = value => Boolean(
      value && typeof value === 'object'
      && goodsIdentity(value)
      && (!productId || goodsIdentity(value) === productId)
      && clean(value?.goodsName || value?.goods_name || value?.name, 1000)
      // MobX rows expose their fields through observable getters. On current
      // Pinduoduo builds those getters can be unavailable while the array is
      // being snapshotted even though JSON serialization already contains the
      // complete rows. The non-empty product-owned collection is the readiness
      // fence; the cloned plain array is validated again by productResult.
      && goodsSkuRows(value).length
      && goodsImages(value).length
    );
    const goodsReady = value => {
      if (!goodsComplete(value)) return false;
      const rows = goodsSkuRows(value);
      return rows.length === 1 || rows.some(row => pddSkuAttributes(row).length || pddSkuLabel(row));
    };
    const pddGoodsScore = value => {
      if (!value || typeof value !== 'object') return -1;
      if (productId && goodsIdentity(value) !== productId) return -1;
      const rows = goodsSkuRows(value);
      return (clean(value?.goodsName || value?.goods_name || value?.name, 1000) ? 500 : 0)
        + goodsImages(value).length * 200
        + rows.length * 20
        + rows.reduce((score, row) => score
          + pddSkuAttributes(row).length * 60
          + (pddSkuPrice(row) ? 30 : 0)
          + (platformImageUrl(row?.thumb_url || row?.thumbUrl || row?.image) ? 10 : 0), 0);
    };
    const richestPddGoods = values => values
      .filter(value => value && typeof value === 'object')
      .sort((left, right) => pddGoodsScore(right) - pddGoodsScore(left))[0] || null;
    const runtimeGoods = () => {
      const candidates = [];
      try {
        candidates.push(
          window.rawData?.store?.initDataObj?.goods,
          window.store?.initDataObj?.goods,
          window.__INITIAL_STATE__?.store?.initDataObj?.goods,
          window.__NEXT_DATA__?.props?.pageProps?.store?.initDataObj?.goods,
        );
      } catch { /* inaccessible runtime global */ }
      return candidates.find(value => goodsComplete(value))
        || candidates.find(value => value && typeof value === 'object')
        || null;
    };
    const reactProductState = () => {
      const seen = new WeakSet();
      const skuById = new Map();
      const scoreSku = row => pddSkuAttributes(row).length * 100
        + (pddSkuPrice(row) ? 30 : 0)
        + (platformImageUrl(row?.thumb_url || row?.thumbUrl || row?.image) ? 20 : 0)
        + (row?.goodsId || row?.goodsID || row?.goods_id ? 10 : 0)
        + Math.min(20, Object.keys(row || {}).length);
      let product = null;
      let productScore = -1;
      let productCandidates = 0;
      const visit = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || seen.has(value) || depth > 10) return;
        seen.add(value);
        const identity = clean(value?.goodsID || value?.goodsId || value?.goods_id, 260);
        if (identity === productId && clean(value?.goodsName || value?.goods_name || value?.name, 1000)) {
          productCandidates += 1;
          const score = goodsImages(value).length * 100
            + goodsSkuRows(value).length * 20
            + Math.min(100, Object.keys(value).length)
            + (value?.minGroupPrice || value?.minOnSaleGroupPrice || value?.minOnSaleGroupPriceInCent ? 10 : 0);
          if (score > productScore) {
            product = value;
            productScore = score;
          }
        }
        // Clone each observable row separately. Pinduoduo's product-level MobX
        // serializer can intentionally omit child observable fields while an
        // individual SKU serializer still exposes specs, price and stock.
        const plainValue = cloneGoods(value);
        const skuId = clean(plainValue?.skuId || plainValue?.skuID || plainValue?.sku_id || value?.skuId || value?.skuID || value?.sku_id, 260);
        const skuGoodsId = clean(plainValue?.goodsId || plainValue?.goodsID || plainValue?.goods_id || value?.goodsId || value?.goodsID || value?.goods_id, 260);
        const explicitSpecs = platformRows(plainValue?.specs || plainValue?.specifications);
        const compactLabel = clean(plainValue?.label || plainValue?.showContent || plainValue?.show_content || plainValue?.specValue || plainValue?.spec_value, 500);
        const compactImage = platformImageUrl(plainValue?.url || plainValue?.thumbUrl || plainValue?.imageUrl || plainValue?.image);
        if (skuId && (!skuGoodsId || !productId || skuGoodsId === productId) && (explicitSpecs.length || compactLabel)) {
          const candidate = explicitSpecs.length ? plainValue : {
            ...plainValue,
            goodsId: skuGoodsId || productId,
            thumbUrl: compactImage,
            specs: [{
              spec_key: clean(value?.specKeyName || value?.spec_key_name || '规格', 180),
              spec_value: compactLabel,
            }],
          };
          const current = skuById.get(skuId);
          if (!current || scoreSku(candidate) > scoreSku(current)) skuById.set(skuId, candidate);
        }
        let visited = 0;
        const children = Array.isArray(value)
          ? value
          : (() => {
            try {
              if (typeof value[Symbol.iterator] === 'function') return platformRows(value);
            } catch { /* use enumerable children */ }
            return Object.values(value);
          })();
        for (const child of children) {
          if (visited++ >= 500) break;
          if (child && typeof child === 'object') visit(child, depth + 1);
        }
      };
      let elementCount = 0;
      for (const element of document.querySelectorAll('*')) {
        if (elementCount++ >= 8000) break;
        for (const key of Object.keys(element)) {
          if (key.startsWith('__reactProps$')) visit(element[key]);
        }
      }
      if (!product || !skuById.size) {
        let fiberElementCount = 0;
        for (const element of document.querySelectorAll('*')) {
          if (fiberElementCount++ >= 8000) break;
          for (const key of Object.keys(element)) {
            if (key.startsWith('__reactFiber$')) visit(element[key]);
          }
        }
      }
      const existingSkus = goodsSkuRows(product).map(cloneGoods);
      try {
        window.__wangzaiPddLastReactProbeV1 = {
          productCandidates,
          skuCandidates: skuById.size,
          existingSkus: existingSkus.length,
          validSkus: goodsValidSkuRows(product).length,
          productImages: goodsImages(product).length,
          productIdentity: goodsIdentity(product),
          elementCount: document.querySelectorAll('*').length,
          hidden: document.hidden === true,
          visibilityState: String(document.visibilityState || ''),
        };
      } catch { /* diagnostics are optional */ }
      if (!product) return null;
      const mergedSkus = new Map();
      for (const row of existingSkus) {
        const id = pddSkuId(row);
        if (id) mergedSkus.set(id, row);
      }
      for (const [id, row] of skuById) {
        const current = mergedSkus.get(id);
        if (!current || scoreSku(row) > scoreSku(current)) mergedSkus.set(id, row);
      }
      return mergedSkus.size
        ? { ...cloneGoods(product), skus: [...mergedSkus.values()].slice(0, 800) }
        : product;
    };
    const warmPddLazyState = async () => {
      if (typeof window.scrollTo !== 'function') return;
      const originalY = Number(window.scrollY || document.documentElement?.scrollTop || 0);
      try {
        const semanticLabel = [...document.querySelectorAll('*')].find(element => {
          const label = clean(element?.textContent, 80);
          return /^(?:颜色款式|颜色分类|规格|选择规格|选择款式)$/u.test(label);
        });
        const semanticTarget = semanticLabel?.closest?.('button, [role="button"], [class*="sku" i], [class*="spec" i]')
          || semanticLabel?.parentElement;
        if (typeof semanticTarget?.click === 'function') semanticTarget.click();
        await new Promise(resolve => setTimeout(resolve, 220));
      } catch { /* optional SKU selector activation */ }
      try {
        const currentGoods = runtimeGoods();
        const currentRows = goodsSkuRows(currentGoods);
        const hasNamedSku = currentRows.some(row => pddSkuAttributes(row).length || pddSkuLabel(row));
        const pageButtons = [...document.querySelectorAll('button, [role="button"]')];
        const pageText = clean(document.body?.innerText, 120000);
        window.__wangzaiPddSelectorProbeV1 = {
          found: false,
          clicked: false,
          dialog: Boolean(document.querySelector('[role="dialog"], dialog')),
          currentRows: currentRows.length,
          hasNamedSku,
          buttonCount: pageButtons.length,
          hasPurchaseText: /(?:发起拼单|单独购买|去拼单|立即购买|选择规格|选择款式)/u.test(pageText),
        };
        if (currentRows.length > 1 && !hasNamedSku) {
          const selectorButton = [...document.querySelectorAll('button, [role="button"], div')]
            .filter(element => {
              const label = clean(element?.textContent, 40);
              return /(?:发起拼单|单独购买|选择规格|选择款式)$/u.test(label);
            })
            .sort((left, right) => {
              const leftChildren = Number(left?.children?.length) || 0;
              const rightChildren = Number(right?.children?.length) || 0;
              return leftChildren - rightChildren;
            })[0];
          if (typeof selectorButton?.click === 'function') selectorButton.click();
          await new Promise(resolve => setTimeout(resolve, 420));
          try {
            window.__wangzaiPddSelectorProbeV1 = {
              ...window.__wangzaiPddSelectorProbeV1,
              found: Boolean(selectorButton),
              clicked: typeof selectorButton?.click === 'function',
              label: clean(selectorButton?.textContent, 80),
              dialog: Boolean(document.querySelector('[role="dialog"], dialog')),
            };
          } catch { /* diagnostics are optional */ }
        }
      } catch { /* opening the selector is optional and never submits an order */ }
      const maximum = Math.max(0, Number(document.documentElement?.scrollHeight || 0) - Number(window.innerHeight || 0));
      const positions = [
        Math.min(maximum, Math.max(0, Number(window.innerHeight || 0) * 0.75)),
        Math.min(maximum, Math.max(0, Number(window.innerHeight || 0) * 1.75)),
        maximum,
      ];
      for (const position of positions) {
        window.scrollTo(0, position);
        await new Promise(resolve => setTimeout(resolve, 180));
        try {
          const candidates = document.querySelectorAll(
            '[class*="sku" i], [class*="spec" i], [class*="gallery" i], [class*="swiper" i]'
          );
          let activated = 0;
          for (const element of [...candidates].slice(0, 30)) {
            const label = clean(element?.textContent, 220);
            if (/(?:立即购买|去拼单|支付|下单|收藏|客服)/u.test(label)) continue;
            const rect = element?.getBoundingClientRect?.();
            if (rect && (rect.width <= 0 || rect.height <= 0)) continue;
            if (typeof element?.click === 'function') element.click();
            else element?.dispatchEvent?.(new Event('click', { bubbles: true, cancelable: true }));
            activated += 1;
            if (activated >= 5) break;
            await new Promise(resolve => setTimeout(resolve, 80));
          }
        } catch { /* optional lazy-state activation */ }
      }
      await new Promise(resolve => setTimeout(resolve, 350));
      window.scrollTo(0, originalY);
    };
    const saveSnapshot = value => {
      if (!goodsReady(value)) return value;
      const key = goodsIdentity(value);
      snapshotStore.records[key] = {
        goods: cloneGoods(value),
        capturedAt: Date.now(),
        pageUrl: location.href,
      };
      snapshotStore.order = [key, ...platformRows(snapshotStore.order).filter(item => String(item) !== key)].slice(0, 50);
      for (const staleKey of Object.keys(snapshotStore.records)) {
        if (!snapshotStore.order.includes(staleKey)) delete snapshotStore.records[staleKey];
      }
      return snapshotStore.records[key].goods;
    };

    const initialRuntimeGoods = cloneGoods(runtimeGoods());
    const initialReactGoods = cloneGoods(reactProductState());
    // Once React owns the current exact goods_id it is the authoritative
    // hydrated SKU graph. rawData is created earlier and can retain discount
    // amounts plus placeholder SKU rows even after the page reports loaded.
    let goods = goodsReady(initialReactGoods)
      ? initialReactGoods
      : richestPddGoods([initialRuntimeGoods, initialReactGoods]);
    let sourceMethod = goods === initialReactGoods && initialReactGoods
      ? 'pdd-react-props'
      : 'pdd-runtime-state';
    if (goodsReady(goods)) {
      goods = saveSnapshot(goods);
    } else if (productId && goodsReady(snapshotStore.records[productId]?.goods)) {
      goods = richestPddGoods([goods, snapshotStore.records[productId].goods]);
      sourceMethod = 'pdd-runtime-cache';
    } else {
      await warmPddLazyState();
      const deadline = Date.now() + 8000;
      let nextReactProbeAt = Date.now() + 200;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const runtimeCandidate = cloneGoods(runtimeGoods());
        let reactCandidate = null;
        if (Date.now() >= nextReactProbeAt) {
          reactCandidate = cloneGoods(reactProductState());
          nextReactProbeAt = Date.now() + 500;
        }
        const candidate = goodsReady(reactCandidate)
          ? reactCandidate
          : richestPddGoods([runtimeCandidate, reactCandidate]);
        if (candidate && pddGoodsScore(candidate) > pddGoodsScore(goods)) goods = candidate;
        if (goodsReady(candidate)) {
          goods = saveSnapshot(candidate);
          sourceMethod = candidate === reactCandidate && reactCandidate
            ? 'pdd-react-props'
            : 'pdd-runtime-wait';
          break;
        }
      }
    }
    if (!goodsReady(goods)) {
      const roots = platformJsonRoots();
      for (const root of roots) {
        const candidate = platformObjectSearch(root, value => goodsReady(value), 12);
        if (candidate) {
          goods = saveSnapshot(cloneGoods(candidate));
          sourceMethod = 'pdd-structured-state';
          break;
        }
      }
    }
    if (!goodsReady(goods)) {
      const watcherState = window.__wangzaiPddSnapshotWatcherV1?.version === 1 ? 'watcher' : 'no-watcher';
      const cacheState = productId && snapshotStore.records[productId]?.goods ? 'cache-partial' : 'cache-empty';
      const reactProbe = window.__wangzaiPddLastReactProbeV1 || {};
      const selectorProbe = window.__wangzaiPddSelectorProbeV1 || {};
      return productResult({
        sourceProductId: productId,
        sourceMethod: `pdd-missing-rp${Number(reactProbe.productCandidates) || 0}-rs${Number(reactProbe.skuCandidates) || 0}-es${Number(reactProbe.existingSkus) || 0}-vs${Number(reactProbe.validSkus) || 0}-cr${Number(selectorProbe.currentRows) || 0}-hn${selectorProbe.hasNamedSku ? 1 : 0}-bt${Number(selectorProbe.buttonCount) || 0}-pt${selectorProbe.hasPurchaseText ? 1 : 0}-sb${selectorProbe.clicked ? 1 : 0}-dg${selectorProbe.dialog ? 1 : 0}-structured-missing`,
      });
    }
    const specifications = new Map(platformRows(goods.specs || goods.specifications).map(row => [
      String(row?.spec_key_id || row?.specKeyId || row?.id),
      {
        name: clean(row?.spec_key || row?.specKey || row?.key || row?.name || '规格', 180),
        value: clean(row?.spec_value || row?.specValue || row?.value, 180),
      },
    ]));
    const visiblePriceText = clean(document.body?.innerText || '', 120000).match(
      /(?:大促价|券后|补贴价|拼单价|单买价|到手价|限量价|首件价|首件|价格)\s*[¥￥]?\s*(\d+(?:\s*\.\s*\d{1,3})?)/u
    )?.[1] || '';
    const visiblePddPrice = platformNumber(visiblePriceText);
    const goodsPriceCandidates = [
      platformNumber(goods.priceDisplay?.price || goods.price_display?.price),
      platformNumber(goods.minGroupPrice || goods.minOnSaleGroupPrice || goods.groupPrice),
      platformNumber(goods.minNormalPrice || goods.maxNormalPrice),
      platformNumber(goods.min_group_price || goods.min_on_sale_group_price || goods.group_price, true),
      platformNumber(goods.min_normal_price || goods.max_normal_price, true),
      platformNumber(goods.minOnSaleGroupPriceInCent || goods.minGroupPriceInCent || goods.min_on_sale_group_price_in_cent || goods.min_group_price_in_cent, true),
    ].map(Number).filter(number => Number.isFinite(number) && number > 0);
    const largestGoodsPrice = goodsPriceCandidates.length ? Math.max(...goodsPriceCandidates) : 0;
    const plausibleGoodsPrices = largestGoodsPrice > 0
      ? goodsPriceCandidates.filter(number => number >= largestGoodsPrice * 0.2)
      : [];
    const goodsPddPrice = plausibleGoodsPrices.length
      ? Number(Math.min(...plausibleGoodsPrices).toFixed(3)).toString()
      : '';
    const rawSkuRows = goodsSkuRows(goods);
    const skus = rawSkuRows.map((row, index) => {
      const attributes = platformRows(row?.specs || row?.specifications).map(item => {
        const fallback = specifications.get(String(item?.spec_key_id || item?.specKeyId || item?.id)) || {};
        const value = clean(item?.spec_value || item?.specValue || item?.value || item?.name || fallback.value, 180);
        const name = clean(item?.spec_key || item?.specKey || item?.specName || item?.key || item?.label || fallback.name || '规格', 180);
        return value ? { name, value } : null;
      }).filter(Boolean);
      const candidatePrice = pddSkuPrice(row);
      const candidateNumber = Number(candidatePrice);
      const anchorPrice = Number(visiblePddPrice || goodsPddPrice);
      const price = anchorPrice > 0 && candidateNumber > 0 && candidateNumber < anchorPrice * 0.2
        ? String(anchorPrice)
        : candidatePrice || (rawSkuRows.length === 1 ? visiblePddPrice || goodsPddPrice : '');
      const stockValue = Number(row?.quantity ?? row?.stock ?? row?.inventory ?? row?.initQuantity);
      return {
        id: row?.sku_id || row?.skuId || row?.skuID || row?.id || `sku-${index + 1}`,
        name: attributes.map(item => item.value).join(' / ') || row?.skuName || row?.specName
          || (rawSkuRows.length === 1 ? '默认规格' : `规格 ${index + 1}`),
        attributes,
        price,
        imageUrl: row?.thumb_url || row?.thumbUrl || row?.image,
        option: {
          stock: Number.isFinite(stockValue) && stockValue >= 0 ? stockValue : null,
          isOnsale: row?.isOnsale == null ? null : row.isOnsale === true || row.isOnsale === 1 || row.isOnsale === '1',
          originalPrice: platformNumber(row?.old_group_price || row?.oldGroupPrice || row?.market_price || row?.marketPrice, true)
            || platformNumber(row?.normal_price || row?.normalPrice),
          soldQuantity: Number.isFinite(Number(row?.soldQuantity)) ? Number(row.soldQuantity) : null,
        },
      };
    });
    const mainGallery = goods.topGallery || goods.top_gallery || goods.viewImageData || goods.view_image_data || goods.gallery || goods.goodsGalleryUrls || goods.goods_gallery_urls || goods.images || [];
    const detailGallery = goods.detailGallery || goods.detail_gallery || goods.detailGalleryUrls || goods.detail_gallery_urls || goods.detailImages || goods.detail_images || [];
    const purchasePrice = visiblePddPrice
      || goodsPddPrice
      || skus.map(row => Number(row.price)).filter(number => number > 0).sort((a, b) => a - b)[0]
      || platformNumber(visiblePriceText);
    return productResult({
      productTitle: goods.goodsName || goods.goods_name || goods.name, purchasePrice,
      sourceProductId: goods.goodsID || goods.goodsId || goods.goods_id || productId,
      mainImages: platformRows(mainGallery).map(row => row?.url || row?.imageUrl || row),
      skuImages: skus.map(row => ({ skuId: row.id, skuName: row.name, imageUrl: row.imageUrl })),
      detailImages: platformRows(detailGallery).map(row => row?.url || row?.imageUrl || row), skus,
      description: goods.goodsDesc || goods.goods_desc || goods.description, attributes: goods.goodsProperty || goods.goods_property || goods.properties,
      brand: goods.brandName || goods.brand_name || goods.brand, category: goods.categoryName || goods.category_name || goods.category,
      videoUrl: platformRows(goods.videoGallery || goods.descVideoGallery)[0]?.url || goods?.video?.videoUrl,
      currency: 'CNY',
      sourceMethod,
    });
  };

  const readJdProduct = async () => {
    const skuId = productIdFromLocation('京东');
    const currentHtml = await platformFetch(location.href, {}, 'text') || document.documentElement?.outerHTML || '';
    const colorSize = balancedArrayAfter(currentHtml, 'colorSize') || [];
    const currentImages = balancedArrayAfter(currentHtml, 'imageList') || [];
    const jdImage = (value, host = 'img30.360buyimg.com/sku') => {
      const raw = clean(typeof value === 'object' ? value?.imgUrl || value?.image || value?.url : value, 2000);
      if (!raw) return '';
      if (/^https?:/iu.test(raw) || raw.startsWith('//')) return platformImageUrl(raw);
      return platformImageUrl(`https://${host}/${raw.replace(/^\/+/, '')}`);
    };
    const pageForSku = async (row, index) => {
      const id = clean(row?.skuId || row?.sku || row?.id || row, 260);
      if (!id) return null;
      const html = id === skuId ? currentHtml : await platformFetch(`https://item.jd.com/${id}.html`, {}, 'text');
      if (!html) return { id, name: clean(row?.name || row?.color || row?.size, 500) };
      const images = balancedArrayAfter(html, 'imageList') || [];
      const priceText = html.match(/summary-price-wrap[\s\S]{0,2000}?class=["'][^"']*(?:price|p-price)[^"']*["'][^>]*>([^<]+)/iu)?.[1]
        || html.match(/class=["'][^"']*price[^"']*["'][^>]*>[\s\S]{0,200}?([0-9]+(?:\.[0-9]+)?)/iu)?.[1];
      const attributes = [
        ['颜色', row?.color || row?.颜色],
        ['尺寸', row?.size || row?.尺寸],
        ['版本', row?.version || row?.版本],
      ].map(([name, value]) => clean(value, 180) ? ({ name, value: clean(value, 180) }) : null).filter(Boolean);
      return {
        id, name: attributes.map(item => item.value).join(' / ') || clean(row?.name || row?.skuName, 500) || `SKU ${index + 1}`,
        attributes, price: priceText, imageUrl: jdImage(images[0], 'img14.360buyimg.com/n0'),
        images: images.map(image => jdImage(image, 'img14.360buyimg.com/n0')),
      };
    };
    const variantRows = platformRows(colorSize).slice(0, 100);
    const skus = (await Promise.all((variantRows.length ? variantRows : [skuId]).map(pageForSku))).filter(Boolean);
    const domMain = [];
    for (const selector of ['#spec-list img', '#preview img', '.spec-items img']) {
      try { for (const image of document.querySelectorAll(selector)) domMain.push(image?.getAttribute?.('data-url') || image?.getAttribute?.('data-origin') || image?.src); } catch { /* optional */ }
    }
    const detailImages = [];
    for (const selector of ['#graphic-content img', '#detail-main img', '.detail-content img']) {
      try { for (const image of document.querySelectorAll(selector)) detailImages.push(image?.getAttribute?.('data-lazyload') || image?.getAttribute?.('data-src') || image?.src); } catch { /* optional */ }
    }
    const attributes = [];
    try {
      for (const row of document.querySelectorAll('#product-attribute .item, .p-parameter li')) {
        const value = clean(row?.textContent, 500);
        const parts = value.split(/[:：]/u);
        if (parts.length > 1) attributes.push({ name: parts.shift(), value: parts.join(':') });
      }
    } catch { /* optional */ }
    const title = platformTextContent('.itemInfo-wrap .sku-title-name') || platformTextContent('.sku-title-name')
      || platformTextContent('#name h1') || currentHtml.match(/<title[^>]*>([^<]+)/iu)?.[1];
    const domPrice = platformTextContent('.summary-price-wrap .price') || platformTextContent('.p-price .price');
    return productResult({
      productTitle: title, purchasePrice: skus.map(row => row.price).filter(Boolean).concat(domPrice), sourceProductId: skuId,
      mainImages: [...platformRows(currentImages).map(image => jdImage(image)), ...domMain],
      skuImages: skus.map(row => ({ skuId: row.id, skuName: row.name, imageUrl: row.imageUrl })),
      detailImages, skus, attributes, description: attributes.map(row => `${row.name}:${row.value}`).join('\n'),
      currency: 'CNY',
      sourceMethod: variantRows.length ? 'jd-color-size-pages' : 'jd-product-html',
    });
  };

  const readTemuProduct = () => {
    const store = window.rawData?.store || window.__NEXT_DATA__?.props?.pageProps?.store || window.__INITIAL_STATE__?.store;
    const goods = store?.goods || platformObjectSearch(store, value => Boolean(value?.goodsName && (value?.gallery || value?.goodsProperty)), 10);
    const skuRows = platformRows(store?.sku || goods?.sku || goods?.skus);
    if (!goods) return productResult({ sourceProductId: productIdFromLocation('Temu'), sourceMethod: 'temu-structured-missing' });
    const skus = skuRows.map((row, index) => {
      const attributes = platformRows(row?.specs || row?.specList || row?.skuSpecList)
        .map(item => {
          if (!item || typeof item !== 'object') return clean(item, 180) ? { name: '规格', value: clean(item, 180) } : null;
          const value = clean(item?.specValue || item?.valueName || item?.value || item?.name || item?.specName, 180);
          const name = clean(item?.specKey || item?.key || item?.label || (item?.value ? item?.specName || item?.name : '') || '规格', 180);
          return value ? { name, value } : null;
        }).filter(Boolean);
      return { id: row?.skuId || row?.sku_id || row?.id || `sku-${index + 1}`,
        name: attributes.map(item => item.value).join(' / ') || row?.skuName || row?.specName, attributes,
        price: row?.normalPriceStr || row?.salePriceStr || row?.price, imageUrl: row?.thumbUrl || row?.thumb_url || row?.imageUrl };
    });
    return productResult({
      productTitle: goods.goodsName, purchasePrice: skus.map(row => row.price).filter(Boolean),
      sourceProductId: goods.goodsId || goods.goods_id || productIdFromLocation('Temu'),
      mainImages: platformRows(goods.gallery).map(row => row?.url || row?.imageUrl || row),
      skuImages: skus.map(row => ({ skuId: row.id, skuName: row.name, imageUrl: row.imageUrl })), skus,
      detailImages: platformRows(goods.detailGallery || goods.detailImages).map(row => row?.url || row?.imageUrl || row),
      description: platformRows(goods.goodsProperty).map(row => `${clean(row?.key || row?.name, 180)}:${clean(row?.values || row?.value, 500)}`).join('\n'),
      attributes: goods.goodsProperty, videoUrl: goods?.video?.videoUrl, sourceMethod: 'temu-raw-data',
      currency: platformCurrency(goods.currencyCode, goods.currency, store?.currencyCode, store?.currency, skus.map(row => row.price)),
    });
  };

  const requestAliExpressMtop = async (productId) => {
    const request = window.lib?.mtop?.request;
    if (typeof request !== 'function') return null;
    const cookieValue = document.cookie?.match(/(?:^|;\s*)aep_usuc_f=([^;]+)/u)?.[1] || '';
    const cookieParams = new URLSearchParams(decodeURIComponent(cookieValue));
    const locale = cookieParams.get('b_locale') || 'en_US';
    const data = { productId, _lang: `${locale.slice(0, 2)}_${cookieParams.get('region') || locale.slice(-2)}`,
      _currency: cookieParams.get('c_tp') || 'USD', country: cookieParams.get('region') || locale.slice(-2), clientType: 'pc', sourceType: 'query' };
    return await new Promise(resolve => {
      let done = false;
      const finish = value => { if (!done) { done = true; resolve(value || null); } };
      const timer = setTimeout(() => finish(null), 8000);
      try {
        const output = request({ api: 'mtop.aliexpress.pdp.pc.query', v: '1.0', data: JSON.stringify(data), dataType: 'originaljsonp' },
          value => { clearTimeout(timer); finish(value); }, () => { clearTimeout(timer); finish(null); });
        if (output?.then) output.then(value => { clearTimeout(timer); finish(value); }).catch(() => { clearTimeout(timer); finish(null); });
      } catch { clearTimeout(timer); finish(null); }
    });
  };
  const readAliExpressProduct = async () => {
    const productId = productIdFromLocation('AliExpress');
    let payload = await requestAliExpressMtop(productId);
    let kind = 1;
    payload = payload?.data?.result || payload?.data?.data?.result || payload?.data || payload;
    if (typeof payload === 'string') payload = safeJson(payload) || payload;
    if (!payload || typeof payload !== 'object') {
      payload = await platformFetch(`${new URL(location.href).origin}/aer-jsonapi/v1/bx/pdp/web/productData?productId=${encodeURIComponent(productId)}`);
      payload = payload?.data || payload;
      kind = 2;
    }
    if (!payload || typeof payload !== 'object') return productResult({ sourceProductId: productId, sourceMethod: 'aliexpress-structured-missing' });
    if (kind === 1) {
      const modules = payload?.result || payload;
      const title = modules.PRODUCT_TITLE || modules.productTitle || {};
      const header = modules.HEADER_IMAGE_PC || modules.headerImage || {};
      const props = modules.PRODUCT_PROP_PC || modules.productProp || {};
      const sku = modules.SKU || modules.sku || {};
      const price = modules.PRICE || modules.price || {};
      const skus = platformRows(sku.skuPaths || sku.skus).filter(row => row?.salable !== false).map((row, index) => {
        const id = clean(row?.skuIdStr || row?.skuId || row?.id || row?.skuAttr || `sku-${index + 1}`, 260);
        const attributes = platformRows(row?.skuPropertyValues || row?.properties || row?.skuAttr)
          .map(item => {
            if (!item || typeof item !== 'object') return clean(item, 180) ? { name: '规格', value: clean(item, 180) } : null;
            const value = clean(item?.propertyValueDisplayName || item?.propertyValueName || item?.value || item?.name, 180);
            const name = clean(item?.skuPropertyName || item?.propertyName || item?.nameLabel || '规格', 180);
            return value ? { name, value } : null;
          }).filter(Boolean);
        const info = price?.skuPriceInfoMap?.[id] || price?.skuPriceInfoMap?.[row?.skuIdStr] || {};
        return { id, name: attributes.map(item => item.value).join(' / ') || row?.skuAttr, attributes,
          price: info?.salePriceString || info?.salePrice?.formattedPrice || info?.salePrice,
          imageUrl: header?.skuImagesMap?.[row?.skuIdStr || id]?.[0] };
      });
      return productResult({ productTitle: title?.text || title?.title, purchasePrice: skus.map(row => row.price).filter(Boolean), sourceProductId: productId,
        mainImages: platformRows(header.imgList).map(row => row?.imageUrl || row?.url || row),
        skuImages: skus.map(row => ({ skuId: row.id, skuName: row.name, imageUrl: row.imageUrl })), skus,
        attributes: props.showedProps, description: platformRows(props.showedProps).map(row => `${row?.attrName}:${row?.attrValue}`).join('\n'),
        videoUrl: header?.productVideo?.videoPlayInfo?.webUrl,
        currency: platformCurrency(price?.currencyCode, price?.currency, skus.map(row => row.price)),
        sourceMethod: 'aliexpress-mtop' });
    }
    const skuInfo = payload.skuInfo || {};
    const properties = platformRows(skuInfo.propertyList);
    const propertyValues = new Map(properties.flatMap(group => platformRows(group?.values).map(value => [
      String(value?.id || value?.propertyValueId),
      { ...value, __groupName: clean(group?.name || group?.propertyName || group?.title || '规格', 180) },
    ])));
    const skus = platformRows(skuInfo.priceList || skuInfo.skuList).map((row, index) => {
      const rawIds = row?.skuPropIds || row?.propertyValueIds || [];
      const ids = (typeof rawIds === 'string' ? rawIds.split(',') : platformRows(rawIds)).map(String);
      const values = ids.map(id => propertyValues.get(id)).filter(Boolean);
      const attributes = values.map(value => {
        const attributeValue = clean(value?.name || value?.propertyValueName, 180);
        return attributeValue ? { name: value?.__groupName || '规格', value: attributeValue } : null;
      }).filter(Boolean);
      return { id: row?.skuId || row?.id || `sku-${index + 1}`, name: attributes.map(item => item.value).join(' / '), attributes,
        price: row?.activityAmount?.formatted || row?.salePrice?.formatted || row?.price,
        imageUrl: values.map(value => value?.imageMainUrl || value?.imageUrl).find(Boolean) };
    });
    return productResult({ productTitle: payload.name || payload.title, purchasePrice: skus.map(row => row.price).filter(Boolean),
      sourceProductId: payload.id || payload.productId || productId, mainImages: platformRows(payload.gallery).map(row => row?.imageUrl || row?.url || row),
      skuImages: skus.map(row => ({ skuId: row.id, skuName: row.name, imageUrl: row.imageUrl })), skus,
      detailImages: htmlImageUrls(payload.description), description: platformHtmlText(payload.description),
      attributes: payload.properties || payload.productProperties,
      currency: platformCurrency(payload.currencyCode, payload.currency, skus.map(row => row.price)),
      sourceMethod: 'aliexpress-json-api' });
  };

  const readAmazonProduct = async () => {
    const asin = productIdFromLocation('Amazon');
    const roots = platformJsonRoots();
    const dimensionState = roots.map(root => platformObjectSearch(root, value => Boolean(value?.dimensionToAsinMap || value?.dimensionValuesDisplayData), 12)).find(Boolean) || {};
    let colorImages = {};
    let colorToAsin = {};
    for (const script of document.scripts || []) {
      const source = script.textContent || '';
      colorImages = colorImages && Object.keys(colorImages).length ? colorImages : balancedObjectAfter(source, 'colorImages') || colorImages;
      colorToAsin = colorToAsin && Object.keys(colorToAsin).length ? colorToAsin : balancedObjectAfter(source, 'colorToAsin') || colorToAsin;
    }
    const dynamicImages = safeJson(document.querySelector?.('#landingImage')?.getAttribute?.('data-a-dynamic-image') || '') || {};
    const mainImages = [
      ...Object.keys(dynamicImages),
      ...Object.values(colorImages || {}).flatMap(value => platformRows(value)).map(row => row?.hiRes || row?.large || row?.mainUrl || row),
    ];
    const variants = [];
    for (const [name, value] of Object.entries(dimensionState.dimensionToAsinMap || colorToAsin || {})) {
      const id = clean(typeof value === 'object' ? value?.asin || value?.ASIN : value, 260);
      if (!id) continue;
      variants.push({ id, name, attributes: [{ name: '规格', value: name }], imageUrl: platformRows(colorImages?.[name])[0]?.hiRes || platformRows(colorImages?.[name])[0]?.large });
    }
    const price = platformTextContent('.twisterSwatchPrice') || platformTextContent('.a-price .a-offscreen') || platformTextContent('#priceblock_ourprice');
    const descriptionParts = [];
    try { for (const row of document.querySelectorAll('#feature-bullets .a-list-item, #productDescription, .a-expander-content .a-list-item')) descriptionParts.push(clean(row?.textContent, 1000)); } catch { /* optional */ }
    const detailImages = [];
    try { for (const row of document.querySelectorAll('.background-image img, .aplus-card-image img, .aplus-module-wrapper img')) detailImages.push(row?.getAttribute?.('data-src') || row?.src); } catch { /* optional */ }
    const skus = (variants.length ? variants : [{ id: asin, name: clean(dimensionState?.dimensionValuesDisplayData?.[asin], 500) || asin }])
      .map(row => ({ ...row, price }));
    return productResult({ productTitle: platformTextContent('#productTitle'), purchasePrice: price, sourceProductId: asin,
      mainImages, skuImages: skus.map(row => ({ skuId: row.id, skuName: row.name, imageUrl: row.imageUrl })),
      detailImages, skus, description: descriptionParts.join('\n'),
      currency: platformCurrency(price) || amazonHostCurrency(), sourceMethod: 'amazon-page-structure' });
  };

  const wbBasket = (volume) => {
    const limits = [143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601, 1655, 1919, 2045, 2189, 2405, 2621, 2837, 3059, 3271, 3483, 3705, 3927, 4149];
    const index = limits.findIndex(limit => volume <= limit);
    return String(index < 0 ? limits.length + 1 : index + 1).padStart(2, '0');
  };
  const readWildberriesProduct = async () => {
    const id = productIdFromLocation('Wildberries');
    const payload = await platformFetch(`https://www.wildberries.ru/__internal/u-card/cards/v4/detail?appType=1&curr=rub&dest=-1257786&spp=30&lang=ru&nm=${encodeURIComponent(id)}`);
    const product = payload?.data?.products?.[0] || payload?.products?.[0]
      || platformJsonRoots().map(root => platformObjectSearch(root, value => String(value?.id || value?.nmId) === id && value?.name, 12)).find(Boolean);
    if (!product) return productResult({ sourceProductId: id, sourceMethod: 'wildberries-structured-missing' });
    const numericId = Number(product.id || product.nmId || id);
    const volume = Math.floor(numericId / 100000);
    const part = Math.floor(numericId / 1000);
    const base = `https://basket-${wbBasket(volume)}.wbbasket.ru/vol${volume}/part${part}/${numericId}/`;
    const mainImages = platformRows(product.mediaFiles || product.images).length
      ? platformRows(product.mediaFiles || product.images).map(row => row?.url || row?.big || row)
      : Array.from({ length: Math.min(Number(product.pics || 1), 30) }, (_, index) => `${base}images/big/${index + 1}.webp`);
    const color = clean(platformRows(product.colors)[0]?.name, 180);
    const skus = platformRows(product.sizes).map((row, index) => {
      const size = clean(row?.origName || row?.name, 180);
      const name = [color, size && size !== '0' ? size : ''].filter(Boolean).join(' / ');
      return { id: row?.chrtId || row?.optionId || `${id}-${index + 1}`, name, attributes: [
        color ? { name: '颜色', value: color } : null,
        size && size !== '0' ? { name: '尺寸', value: size } : null,
      ].filter(Boolean),
        price: Number(row?.price?.product || row?.salePriceU || row?.priceU || 0) / 100, imageUrl: mainImages[0] };
    });
    return productResult({ productTitle: product.name, purchasePrice: skus.map(row => row.price).filter(Boolean),
      sourceProductId: id, mainImages, skuImages: skus.map(row => ({ skuId: row.id, skuName: row.name, imageUrl: row.imageUrl })),
      skus, description: product.description, attributes: product.options,
      brand: product.brand, category: product.entity || product.subjectName,
      currency: 'RUB', sourceMethod: 'wildberries-card-api' });
  };

  const parseOzonWidgets = (payload) => {
    const states = payload?.widgetStates || payload?.widget_states || payload?.data?.widgetStates || {};
    const parsed = {};
    for (const [key, raw] of Object.entries(states)) {
      const value = typeof raw === 'string' ? safeJson(raw) : raw;
      if (value) parsed[key] = value;
    }
    const pick = pattern => Object.entries(parsed).find(([key]) => pattern.test(key))?.[1] || {};
    const heading = pick(/webProductHeading/iu);
    const price = pick(/webPrice/iu);
    const gallery = pick(/webGallery/iu);
    const description = pick(/webDescription/iu);
    const characteristics = pick(/webCharacteristics|webShortCharacteristics/iu);
    const aspects = pick(/webAspects|webAddToCart/iu);
    const galleryRows = gallery?.items || gallery?.images || gallery?.coverImage ? [...platformRows(gallery.items || gallery.images), gallery.coverImage] : [];
    const variants = aspects?.variants || aspects?.items || platformRows(aspects?.aspects).flatMap(row => platformRows(row?.variants));
    let seoDescription = '';
    try { seoDescription = safeJson(payload?.seo?.script?.[0]?.innerHTML)?.description || ''; } catch { seoDescription = ''; }
    return productResult({
      productTitle: heading?.title || heading?.text || heading?.name,
      purchasePrice: price?.price || price?.finalPrice || price?.cardPrice || price?.originalPrice,
      sourceProductId: heading?.sku || heading?.productId || productIdFromLocation('Ozon买家'),
      mainImages: galleryRows.map(row => row?.image || row?.url || row?.src || row),
      detailImages: htmlImageUrls(description?.content || description?.text || description?.description || seoDescription),
      skus: platformRows(variants).map((row, index) => ({
        id: row?.sku || row?.id || `sku-${index + 1}`, name: row?.title || row?.name,
        attributes: [row?.title || row?.name].filter(Boolean), price: row?.price || price?.price,
        imageUrl: row?.image || row?.imageUrl,
      })),
      description: description?.content || description?.text || description?.description || seoDescription,
      attributes: characteristics?.characteristics || characteristics?.items || characteristics?.attributes,
      brand: heading?.brand || characteristics?.brand, category: heading?.category,
      currency: 'RUB',
      sourceMethod: 'ozon-widget-state',
    });
  };
  const readOzonProduct = async () => {
    for (const endpoint of ['/api/entrypoint-api.bx/page/json/v2', '/api/composer-api.bx/page/json/v2']) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 7000);
        const response = await fetch(`${endpoint}?url=${encodeURIComponent(location.pathname + location.search)}`, {
          credentials: 'include', headers: { accept: 'application/json' }, signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) return parseOzonWidgets(await response.json());
      } catch { /* try the compatible Ozon endpoint */ }
    }
    for (const root of platformJsonRoots()) {
      const state = platformObjectSearch(root, value => Boolean(value?.widgetStates || value?.widget_states), 10);
      if (state) return parseOzonWidgets(state);
    }
    return productResult({
      sourceProductId: productIdFromLocation('Ozon买家'),
      currency: 'RUB',
      sourceMethod: 'ozon-structured-missing',
    });
  };

  const extractPlatformProduct = async (kind) => {
    try {
      if (kind === '1688') return await read1688Product();
      if (kind === '淘宝' || kind === '天猫') return await readTaobaoProduct(kind);
      if (kind === '拼多多') return await readPddProduct();
      if (kind === '京东') return await readJdProduct();
      if (kind === 'Wildberries') return await readWildberriesProduct();
      if (kind === 'Amazon') return await readAmazonProduct();
      if (kind === 'Temu') return readTemuProduct();
      if (kind === 'AliExpress') return await readAliExpressProduct();
      if (kind === 'Ozon买家') return await readOzonProduct();
    } catch (error) {
      console.warn('[wangzai-capture] structured product reader failed', kind, error?.message || error);
    }
    return productResult({ sourceProductId: productIdFromLocation(kind), sourceMethod: 'dom-fallback' });
  };
""";
}
