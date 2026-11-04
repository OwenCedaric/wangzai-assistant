const LINK_PATTERN = /\[([^\]\n]+)\]\(((?:https?:\/\/|www\.)[^\s)]+)\)|(?:https?:\/\/|www\.)[^\s<]+/giu;
const TRAILING_PUNCTUATION = /[.,!?;:，。！？；：、】》」』”’]+$/u;

function normalizeText(value) {
  return String(value ?? '');
}

function splitTrailingPunctuation(value) {
  let url = normalizeText(value);
  let trailing = '';

  const punctuationMatch = url.match(TRAILING_PUNCTUATION);
  if (punctuationMatch) {
    trailing = punctuationMatch[0];
    url = url.slice(0, -trailing.length);
  }

  while (url.endsWith(')')) {
    const openCount = (url.match(/\(/g) || []).length;
    const closeCount = (url.match(/\)/g) || []).length;
    if (closeCount <= openCount) break;
    url = url.slice(0, -1);
    trailing = `)${trailing}`;
  }

  return { url, trailing };
}

export function normalizeCustomerMessageHref(value) {
  const candidate = normalizeText(value).trim();
  if (!candidate) return '';
  const withProtocol = /^www\./iu.test(candidate) ? `https://${candidate}` : candidate;
  try {
    const parsed = new URL(withProtocol);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function appendText(tokens, value) {
  if (!value) return;
  const previous = tokens.at(-1);
  if (previous?.type === 'text') previous.text += value;
  else tokens.push({ type: 'text', text: value });
}

export function parseCustomerMessageLinks(value) {
  const text = normalizeText(value);
  const tokens = [];
  let cursor = 0;

  for (const match of text.matchAll(LINK_PATTERN)) {
    const index = match.index ?? 0;
    appendText(tokens, text.slice(cursor, index));

    const markdownLabel = match[1];
    const rawTarget = match[2] || match[0];
    const { url, trailing } = splitTrailingPunctuation(rawTarget);
    const href = normalizeCustomerMessageHref(url);

    if (href) {
      tokens.push({
        type: 'link',
        text: markdownLabel || url,
        href,
      });
      appendText(tokens, trailing);
    } else {
      appendText(tokens, match[0]);
    }

    cursor = index + match[0].length;
  }

  appendText(tokens, text.slice(cursor));
  return tokens.length ? tokens : [{ type: 'text', text }];
}
