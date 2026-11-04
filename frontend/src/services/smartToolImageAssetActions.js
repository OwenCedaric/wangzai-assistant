function text(value) {
  return String(value ?? '').trim();
}

function dataUrlToBlob(value) {
  const match = text(value).match(/^data:([^;,]+)(?:;base64)?,(.*)$/isu);
  if (!match) return null;
  const [, mimeType, payload] = match;
  const bytes = /;base64,/iu.test(text(value))
    ? Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));
  return new Blob([bytes], { type: mimeType || 'image/png' });
}

async function readImageBlob(imageUrl) {
  const value = text(imageUrl);
  if (!value) throw new Error('图片地址为空，无法操作。');
  const dataBlob = dataUrlToBlob(value);
  if (dataBlob) return dataBlob;
  const response = await fetch(value, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`图片读取失败（${response.status}）。`);
  return response.blob();
}

export async function copySmartToolImage(imageUrl) {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    throw new Error('当前环境不支持复制图片，请使用下载。');
  }
  const blob = await readImageBlob(imageUrl);
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
  return true;
}

export async function downloadSmartToolImage(imageUrl, fileName = 'smart-tool-image.png') {
  const value = text(imageUrl);
  let objectUrl = '';
  try {
    const blob = await readImageBlob(value);
    objectUrl = URL.createObjectURL(blob);
  } catch {
    // A third-party CDN may disallow CORS. The browser's native download
    // navigation is still useful in that case, while data/local images use
    // the blob path above.
    const anchor = document.createElement('a');
    anchor.setAttribute('href', value);
    anchor.setAttribute('download', fileName);
    anchor.rel = 'noopener';
    anchor.click();
    return true;
  }
  try {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', objectUrl);
    anchor.setAttribute('download', fileName);
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  return true;
}
