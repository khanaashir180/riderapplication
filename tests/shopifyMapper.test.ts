import test from "node:test";
import assert from "node:assert/strict";
import { applyShopifyCommerceUpdate, evaluateShopifyReadiness, normalizeShopifyPayment } from "../src/services/shopifyMapper.js";

test("Shopify mapper calculates partial-payment outstanding COD", () => {
  const payment = normalizeShopifyPayment({ total_price: 10000, amount_paid: 4000, financial_status: "partially_paid" });
  assert.equal(payment.paymentType, "PARTIALLY_PAID");
  assert.equal(payment.codExpected, 6000);
});

test("Shopify commerce update cannot mutate operational custody fields", () => {
  const update = applyShopifyCommerceUpdate({ operationalStatus: "out_for_delivery", assignedRiderId: "zahid" }, { customerPhone: "03001234567", operationalStatus: "imported_review" } as any);
  assert.deepEqual(update, { customerPhone: "03001234567" });
});

test("readiness returns explicit operational holds", () => {
  const result = evaluateShopifyReadiness({ phone: "", address: "", city: "", deliveryChannel: "external_courier", paymentType: "COD", tags: "MTO" });
  assert.equal(result.ready, false);
  assert.deepEqual(result.holds, ["INVALID_PHONE", "ADDRESS_REVIEW_REQUIRED", "UNSUPPORTED_REGION", "MTO_HOLD"]);
});
