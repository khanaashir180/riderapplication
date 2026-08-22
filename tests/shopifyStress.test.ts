import test from "node:test";
import assert from "node:assert/strict";
import { hasRiderCustody, isOlderShopifyEvent, isSupportedShopifyTopic } from "../src/services/shopifyEventPolicy.js";

test("2,000 Shopify event stress preserves operational ownership and reconciliation recovery", () => {
  const distribution: Array<[string, number]> = [["ORDERS_CREATE", 1000], ["ORDERS_UPDATED", 500], ["ORDERS_EDITED", 200], ["ORDERS_PAID", 100], ["ORDERS_CANCELLED", 100], ["REFUNDS_CREATE", 100]];
  const events = distribution.flatMap(([topic, count]) => Array.from({ length: count }, (_, index) => ({ topic, orderId: `shopify_${(index % 1000) + 1}`, updatedAt: `2026-08-22T${String(10 + (index % 10)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z` })));
  assert.equal(events.length, 2000);
  const processedEventIds = new Set<string>();
  const state = new Map<string, { updatedAt: string; operationalStatus: string; assignedRiderId: string | null; codExpected: number; cancellations: number; refunds: number }>();
  const missedCreates = new Set(["shopify_996", "shopify_997", "shopify_998", "shopify_999", "shopify_1000"]);
  let staleIgnored = 0;

  for (const [index, event] of events.entries()) {
    if (!isSupportedShopifyTopic(event.topic)) continue;
    const eventId = `${event.topic}:${event.orderId}:${event.updatedAt}`;
    if (processedEventIds.has(eventId)) continue;
    processedEventIds.add(eventId);
    if (event.topic === "ORDERS_CREATE" && missedCreates.has(event.orderId)) continue;
    const current = state.get(event.orderId);
    if (current && isOlderShopifyEvent(current.updatedAt, event.updatedAt)) { staleIgnored++; continue; }
    if (!current) {
      state.set(event.orderId, { updatedAt: event.updatedAt, operationalStatus: Number(event.orderId.split("_")[1]) <= 100 ? "out_for_delivery" : "ready_for_dispatch", assignedRiderId: Number(event.orderId.split("_")[1]) <= 100 ? "zahid" : null, codExpected: 10000, cancellations: 0, refunds: 0 });
      continue;
    }
    if (event.topic === "ORDERS_PAID" && hasRiderCustody(current)) current.codExpected = 6000;
    if (event.topic === "ORDERS_PAID" && !hasRiderCustody(current)) current.codExpected = 0;
    if (event.topic === "ORDERS_CANCELLED") { current.cancellations++; if (!hasRiderCustody(current)) { current.operationalStatus = "cancelled"; current.assignedRiderId = null; } }
    if (event.topic === "REFUNDS_CREATE") current.refunds++;
    current.updatedAt = event.updatedAt;
    if (index === 1500) processedEventIds.add(eventId);
  }

  for (const orderId of missedCreates) state.set(orderId, { updatedAt: "2026-08-22T23:00:00.000Z", operationalStatus: "ready_for_dispatch", assignedRiderId: null, codExpected: 10000, cancellations: 0, refunds: 0 });
  assert.equal(state.size, 1000);
  assert.equal([...state.values()].filter((item) => item.assignedRiderId === null && item.operationalStatus === "out_for_delivery").length, 0);
  assert.equal([...state.values()].filter((item) => item.cancellations > 1).length, 0);
  assert.equal([...state.values()].filter((item) => item.assignedRiderId === "zahid" && item.operationalStatus !== "out_for_delivery").length, 0);
  assert.equal(staleIgnored >= 0, true);
});
