import test from "node:test";
import assert from "node:assert/strict";
import { SHOPIFY_OUTBOUND_EVENT_TYPES, enqueueShopifyOutboundEvent, enqueueShopifyPackageEvent } from "../src/services/shopifyOutbound.js";

function fakeDb() {
  const docs = new Map<string, any>();
  return {
    docs,
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              const value = docs.get(`${name}/${id}`);
              return { exists: Boolean(value), data: () => value };
            },
            async set(value: any, options?: { merge?: boolean }) {
              const key = `${name}/${id}`;
              docs.set(key, options?.merge ? { ...(docs.get(key) || {}), ...value } : value);
            }
          };
        }
      };
    }
  };
}

test("outbound status coverage includes the complete package lifecycle", () => {
  assert.deepEqual([...SHOPIFY_OUTBOUND_EVENT_TYPES], [
    "PACKAGE_ASSIGNED",
    "DISPATCH_RUN_CREATED",
    "PACKAGE_TRANSFERRED",
    "DELIVERY_STATUS_CHANGED",
    "RETURN_STATUS_CHANGED"
  ]);
});

test("outbound enqueue is idempotent and ignores non-Shopify packages", async () => {
  const db: any = fakeDb();
  const input = { packageId: "pkg-1", shopifyOrderId: "50001", eventType: "PACKAGE_ASSIGNED", payload: { riderId: "zahid" }, idempotencyKey: "assign-1" };
  const first = await enqueueShopifyOutboundEvent(db, input);
  const second = await enqueueShopifyOutboundEvent(db, input);
  assert.equal(first, second);
  assert.equal(db.docs.size, 1);

  await db.collection("packages").doc("pkg-2").set({ source: "csv" });
  assert.equal(await enqueueShopifyPackageEvent(db, { packageId: "pkg-2", eventType: "PACKAGE_ASSIGNED", payload: {}, idempotencyKey: "assign-2" }), null);
});
