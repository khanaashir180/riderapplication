import crypto from "crypto";

export type ShopifyOutboundStatus = "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "DEAD_LETTER";

export const SHOPIFY_OUTBOUND_EVENT_TYPES = [
  "PACKAGE_ASSIGNED",
  "DISPATCH_RUN_CREATED",
  "PACKAGE_TRANSFERRED",
  "DELIVERY_STATUS_CHANGED",
  "RETURN_STATUS_CHANGED"
] as const;

export async function enqueueShopifyOutboundEvent(db: any, input: { packageId: string; shopifyOrderId: string; eventType: string; payload: Record<string, unknown>; idempotencyKey: string }) {
  const id = crypto.createHash("sha256").update(`${input.shopifyOrderId}:${input.eventType}:${input.idempotencyKey}`).digest("hex");
  await db.collection("shopifyOutboundEvents").doc(id).set({ id, ...input, status: "PENDING" as ShopifyOutboundStatus, retryCount: 0, createdAt: new Date().toISOString(), lastError: null }, { merge: true });
  return id;
}

export async function enqueueShopifyPackageEvent(db: any, input: { packageId: string; eventType: string; payload: Record<string, unknown>; idempotencyKey: string }) {
  const packageSnapshot = await db.collection("packages").doc(input.packageId).get();
  const packageData = packageSnapshot.exists ? packageSnapshot.data() : null;
  if (!packageData?.shopifyId || String(packageData.source || "").toLowerCase() !== "shopify") return null;
  return enqueueShopifyOutboundEvent(db, { ...input, shopifyOrderId: String(packageData.shopifyId) });
}
