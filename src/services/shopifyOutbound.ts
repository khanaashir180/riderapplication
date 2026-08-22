import crypto from "crypto";

export type ShopifyOutboundStatus = "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "DEAD_LETTER";

export async function enqueueShopifyOutboundEvent(db: any, input: { packageId: string; shopifyOrderId: string; eventType: string; payload: Record<string, unknown>; idempotencyKey: string }) {
  const id = crypto.createHash("sha256").update(`${input.shopifyOrderId}:${input.eventType}:${input.idempotencyKey}`).digest("hex");
  await db.collection("shopifyOutboundEvents").doc(id).set({ id, ...input, status: "PENDING" as ShopifyOutboundStatus, retryCount: 0, createdAt: new Date().toISOString(), lastError: null }, { merge: true });
  return id;
}
