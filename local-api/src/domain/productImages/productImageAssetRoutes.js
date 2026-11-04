import { createJsonResponse, readJsonRequestBody } from '../../utils/http.js';

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error?.code || 'PRODUCT_IMAGE_ASSET_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function statusForError(error) {
  if (Number(error?.statusCode) >= 400) return Number(error.statusCode);
  if (error?.code === 'PRODUCT_IMAGE_SCOPE_FORBIDDEN') return 403;
  return 400;
}

export function createProductImageAssetRoutes({ service, resolveRequestContext = async () => ({}) } = {}) {
  return {
    handleRequest({ req, res, requestUrl, corsHeaders }) {
      const localPreviewMatch = requestUrl.pathname.match(/^\/api\/product-images\/preview\/([^/]+)$/u);
      if (req.method === 'GET' && localPreviewMatch) {
        Promise.resolve(resolveRequestContext({ req, requestUrl, body: null }))
          .then((context) => service.readLocalAsset(decodeURIComponent(localPreviewMatch[1]), context))
          .then((asset) => {
            if (!asset?.dataBase64) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
              res.end('image not found');
              return;
            }
            const data = Buffer.from(asset.dataBase64, 'base64');
            res.writeHead(200, {
              'content-type': asset.mimeType,
              'content-length': String(data.byteLength),
              'cache-control': 'private, no-store',
              ...corsHeaders,
            });
            res.end(data);
          })
          .catch((error) => createJsonResponse(res, statusForError(error), errorPayload(error), corsHeaders));
        return true;
      }

      const signedPreviewMatch = requestUrl.pathname.match(/^\/api\/product-images\/assets\/([^/]+)\/preview$/u);
      if (req.method === 'GET' && signedPreviewMatch) {
        Promise.resolve(resolveRequestContext({ req, requestUrl, body: null }))
          .then((context) => service.readAssetPreview(decodeURIComponent(signedPreviewMatch[1]), context))
          .then((asset) => createJsonResponse(
            res,
            asset ? 200 : 404,
            asset
              ? { ok: true, asset }
              : { ok: false, error: { code: 'PRODUCT_IMAGE_ASSET_NOT_FOUND', message: '图片资产不存在或不属于当前店铺。' } },
            corsHeaders,
          ))
          .catch((error) => createJsonResponse(res, statusForError(error), errorPayload(error), corsHeaders));
        return true;
      }

      const thumbnailMatch = requestUrl.pathname.match(/^\/api\/product-images\/assets\/([^/]+)\/thumbnail$/u);
      if (req.method === 'GET' && thumbnailMatch) {
        Promise.resolve(resolveRequestContext({ req, requestUrl, body: null }))
          .then((context) => service.readAssetThumbnail(decodeURIComponent(thumbnailMatch[1]), context))
          .then((asset) => {
            if (!asset?.data) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
              res.end('thumbnail not found');
              return;
            }
            res.writeHead(200, {
              'content-type': asset.mimeType || 'image/webp',
              'content-length': String(asset.data.byteLength),
              'cache-control': 'private, max-age=86400, immutable',
              etag: `"${asset.id}-thumb-v1"`,
              ...corsHeaders,
            });
            res.end(asset.data);
          })
          .catch((error) => createJsonResponse(res, statusForError(error), errorPayload(error), corsHeaders));
        return true;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/api/product-images/assets/previews') {
        readJsonRequestBody(req, { maxBytes: 64 * 1024 })
          .then(async (body) => ({ body, context: await resolveRequestContext({ req, requestUrl, body }) }))
          .then(({ body, context }) => service.readAssetPreviews(body, context))
          .then((payload) => createJsonResponse(res, 200, payload, corsHeaders))
          .catch((error) => createJsonResponse(res, statusForError(error), errorPayload(error), corsHeaders));
        return true;
      }

      const publicMatch = requestUrl.pathname.match(/^\/public\/product-images\/([^/]+)$/u);
      if (req.method === 'GET' && publicMatch) {
        const asset = service.readPublicAsset(decodeURIComponent(publicMatch[1]), Object.fromEntries(requestUrl.searchParams));
        if (!asset) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('image not found');
          return true;
        }
        const data = Buffer.from(asset.dataBase64, 'base64');
        res.writeHead(200, {
          'content-type': asset.mimeType,
          'content-length': String(data.byteLength),
          'cache-control': 'public, max-age=86400, immutable',
        });
        res.end(data);
        return true;
      }

      const taskMatch = requestUrl.pathname.match(/^\/api\/product-images\/tasks\/([^/]+)$/u);
      if (req.method === 'GET' && taskMatch) {
        Promise.resolve(resolveRequestContext({ req, requestUrl, body: null }))
          .then((context) => service.readPersistenceTask(decodeURIComponent(taskMatch[1]), context))
          .then((payload) => createJsonResponse(
            res,
            payload ? 200 : 404,
            payload || { ok: false, error: { code: 'PRODUCT_IMAGE_TASK_NOT_FOUND', message: '图片保存任务不存在或不属于当前店铺。' } },
            corsHeaders,
          ))
          .catch((error) => createJsonResponse(res, statusForError(error), errorPayload(error), corsHeaders));
        return true;
      }

      const actions = {
        '/api/product-images/import': service.importImage,
        '/api/product-images/edit': service.editImage,
        '/api/product-images/generate': service.generateImage,
        '/api/product-images/promote': service.promoteAsset,
        '/api/product-images/release': service.releaseAsset,
      };
      const action = actions[requestUrl.pathname];
      if (req.method === 'GET' && requestUrl.pathname === '/api/product-images/status') {
        Promise.resolve(resolveRequestContext({ req, requestUrl, body: null }))
          .then((context) => service.getStatus(context))
          .then((payload) => createJsonResponse(res, 200, payload, corsHeaders))
          .catch((error) => createJsonResponse(res, statusForError(error), errorPayload(error), corsHeaders));
        return true;
      }
      if (req.method === 'GET' && requestUrl.pathname === '/api/product-images/usage') {
        Promise.resolve(resolveRequestContext({ req, requestUrl, body: null }))
          .then((context) => service.getUsageStatus(context))
          .then((payload) => createJsonResponse(res, 200, payload, corsHeaders))
          .catch((error) => createJsonResponse(res, statusForError(error), errorPayload(error), corsHeaders));
        return true;
      }
      if (req.method !== 'POST' || !action) return false;
      readJsonRequestBody(req, { maxBytes: 15 * 1024 * 1024 })
        .then(async (body) => ({ body, context: await resolveRequestContext({ req, requestUrl, body }) }))
        .then(({ body, context }) => action(body, context))
        .then((payload) => createJsonResponse(res, 200, payload, corsHeaders))
        .catch((error) => createJsonResponse(res, statusForError(error), errorPayload(error), corsHeaders));
      return true;
    },
  };
}
