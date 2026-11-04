import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createCustomerChatFileRoutes } from './customerChatFileRoutes.js';

function createResponse() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.body = null;
  res.writableEnded = false;
  res.destroyed = false;
  let finish;
  res.finished = new Promise((resolve) => { finish = resolve; });
  res.writeHead = (statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers;
  };
  res.end = (body) => {
    res.body = body;
    res.writableEnded = true;
    finish();
  };
  return res;
}

test('customer chat file route returns authenticated binary image data', async () => {
  const req = new EventEmitter();
  req.method = 'GET';
  const res = createResponse();
  let captured;
  const routes = createCustomerChatFileRoutes({
    service: {
      async readChatFile(input) {
        captured = input;
        return { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
      },
    },
  });
  const fileUrl = 'https://api-seller.ozon.ru/v2/chat/file/messenger/a.jpg';
  const handled = routes.handleRequest({
    req,
    res,
    requestUrl: new URL(
      `http://127.0.0.1/api/customer-service/chat-file?shopId=shop-2&url=${encodeURIComponent(fileUrl)}`,
    ),
  });

  assert.equal(handled, true);
  await res.finished;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.deepEqual(res.body, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal(captured.shopId, 'shop-2');
  assert.equal(captured.fileUrl, fileUrl);
});
