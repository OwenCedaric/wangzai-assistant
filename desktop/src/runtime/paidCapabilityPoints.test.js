import assert from "node:assert/strict";
import test from "node:test";

import { createPaidCapabilityPointsReader } from "./paidCapabilityPoints.js";

test("points reader localizes reservation counter failures without exposing internal English", async () => {
  const readWallet = createPaidCapabilityPointsReader({
    licenseRuntime: {
      request: async () => ({
        ok: false,
        status: 409,
        error: "Point lot reservation counter is inconsistent",
      }),
    },
  });

  await assert.rejects(readWallet(), (error) => {
    assert.equal(error.code, "POINTS_RESERVATION_COUNTER_INCONSISTENT");
    assert.match(error.message, /积分预留账校验不一致/u);
    assert.doesNotMatch(error.message, /Point lot/u);
    return true;
  });
});
