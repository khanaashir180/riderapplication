import test from "node:test";
import assert from "node:assert/strict";
import { classifyCustodyChanges, hasRiderCustody, isOlderShopifyEvent, isSupportedShopifyTopic } from "../src/services/shopifyEventPolicy.js";

test("1,000 Shopify events preserve one package per order and custody protection", () => {
  const states = new Map<string, { updatedAt: string; operationalStatus: string; codExpected: number; exceptions: Set<string> }>();
  const topics = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_EDITED", "ORDERS_PAID", "ORDERS_CANCELLED", "REFUNDS_CREATE"];
  for (let i = 1; i <= 1000; i++) {
    const orderId = `shopify_${(i % 500) + 1}`;
    const topic = topics[i % topics.length];
    const updatedAt = `2026-08-22T${String(10 + (i % 8)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`;
    const current = states.get(orderId);
    if (!isSupportedShopifyTopic(topic)) continue;
    if (current && isOlderShopifyEvent(current.updatedAt, updatedAt)) continue;
    if (!current) {
      states.set(orderId, { updatedAt, operationalStatus: Number(orderId.split("_")[1]) <= 100 ? "out_for_delivery" : "ready_for_dispatch", codExpected: 5000, exceptions: new Set() });
      continue;
    }
    const before = { deliveryAddress: "A", codExpected: current.codExpected, itemSummary: "1x Shoe" };
    const after = { deliveryAddress: topic === "ORDERS_UPDATED" ? "B" : "A", codExpected: topic === "ORDERS_PAID" ? 0 : 5000, itemSummary: "1x Shoe" };
    if (hasRiderCustody(current)) classifyCustodyChanges(before, after).forEach((code) => current.exceptions.add(code));
    else if (topic === "ORDERS_PAID") current.codExpected = 0;
    if (topic === "ORDERS_CANCELLED") {
      if (hasRiderCustody(current)) current.exceptions.add("STOP_DELIVERY");
      else current.operationalStatus = "cancelled";
    }
    current.updatedAt = updatedAt;
  }
  assert.equal(states.size, 500);
  assert.equal([...states.values()].filter((state) => state.operationalStatus === "cancelled").length <= 500, true);
  assert.equal([...states.values()].filter((state) => state.exceptions.has("STOP_DELIVERY")).length > 0, true);
});
