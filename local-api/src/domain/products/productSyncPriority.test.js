import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("full product hydration stays below interactive chat reads", async () => {
  const source = await readFile(new URL("./productSyncService.js", import.meta.url), "utf8");
  const hydrationCall = source.match(
    /hydration = await hydrateProducts\(\{[\s\S]*?changedCount \+= hydration\.changedCount;/u,
  )?.[0] || "";

  assert.match(hydrationCall, /priority:\s*input\.priority \|\| "P2"/u);
  assert.doesNotMatch(hydrationCall, /priority:\s*input\.priority \|\| "P1"/u);
});
