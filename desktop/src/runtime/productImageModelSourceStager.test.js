import assert from "node:assert/strict";
import test from "node:test";

import { createProductImageModelSourceStager } from "./productImageModelSourceStager.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function sourceResponse(data = PNG_1X1, contentType = "image/png") {
  return new Response(data, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(data.byteLength),
    },
  });
}

test("external image is validated locally and handed to management as bytes", async () => {
  const stager = createProductImageModelSourceStager({
    fetchImpl: async () => sourceResponse(),
    lookupImpl: async () => [{ address: "8.8.8.8", family: 4 }],
  });

  const staged = await stager.stage({
    sourceImages: ["https://cbu01.alicdn.com/source.png"],
    shopId: "shop-1",
  });

  assert.deepEqual(staged.sourceImages, [
    `data:image/png;base64,${PNG_1X1.toString("base64")}`,
  ]);
});

test("a file whose declared MIME does not match its bytes is rejected", async () => {
  const stager = createProductImageModelSourceStager({
    fetchImpl: async () => sourceResponse(PNG_1X1, "image/jpeg"),
    lookupImpl: async () => [{ address: "8.8.8.8", family: 4 }],
  });

  await assert.rejects(
    stager.stage({
      sourceImages: ["https://cbu01.alicdn.com/source.jpg"],
      shopId: "shop-1",
    }),
    (error) => error?.code === "IMAGE_MODEL_SOURCE_INVALID",
  );
});

test("private network source URLs are rejected before download", async () => {
  let fetched = false;
  const stager = createProductImageModelSourceStager({
    fetchImpl: async () => {
      fetched = true;
      return sourceResponse();
    },
    lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
  });

  await assert.rejects(
    stager.stage({
      sourceImages: ["https://internal.example/source.png"],
      shopId: "shop-1",
    }),
    (error) => error?.code === "IMAGE_MODEL_SOURCE_INVALID",
  );
  assert.equal(fetched, false);
});
