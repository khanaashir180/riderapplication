import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("Firebase callable export surface", () => {
  test("obsolete mutable callables are not exported", async () => {
    const functionsModule = await import("../functions/src/index.ts");

    assert.equal("assignPackage" in functionsModule, false);
    assert.equal("transferAssignment" in functionsModule, false);
    assert.equal("recordDeliveryAttempt" in functionsModule, false);

    assert.equal("approveCodAllocation" in functionsModule, true);
    assert.equal("recalculateActiveShipmentAgeing" in functionsModule, true);
  });
});
