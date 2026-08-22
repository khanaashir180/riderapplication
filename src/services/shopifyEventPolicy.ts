export const SHOPIFY_WEBHOOK_TOPICS = [
  "ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_EDITED", "ORDERS_CANCELLED", "ORDERS_PAID", "REFUNDS_CREATE"
] as const;

export type ShopifyWebhookTopic = typeof SHOPIFY_WEBHOOK_TOPICS[number];

export function isSupportedShopifyTopic(topic: string): topic is ShopifyWebhookTopic {
  return (SHOPIFY_WEBHOOK_TOPICS as readonly string[]).includes(topic);
}

export function isOlderShopifyEvent(previousUpdatedAt: string | null | undefined, incomingUpdatedAt: string | null | undefined) {
  if (!previousUpdatedAt || !incomingUpdatedAt) return false;
  const previous = Date.parse(previousUpdatedAt);
  const incoming = Date.parse(incomingUpdatedAt);
  return Number.isFinite(previous) && Number.isFinite(incoming) && incoming < previous;
}

export function hasRiderCustody(packageData: any) {
  const status = String(packageData?.operationalStatus || packageData?.status || "").toLowerCase();
  return Boolean(packageData?.activeAssignmentId || packageData?.assignedRiderId) || [
    "out_for_delivery", "delivered", "returned", "returning_to_warehouse", "rider_handed_back", "warehouse_received"
  ].includes(status);
}

export function classifyCustodyChanges(packageData: any, commerceData: { deliveryAddress?: string; codExpected?: number; itemSummary?: string }) {
  return [
    packageData?.deliveryAddress !== commerceData.deliveryAddress ? "ADDRESS_CHANGED_DURING_CUSTODY" : null,
    String(packageData?.codExpected ?? packageData?.expectedCod ?? "") !== String(commerceData.codExpected ?? "") ? "PAYMENT_CHANGED_DURING_CUSTODY" : null,
    packageData?.itemSummary && packageData.itemSummary !== commerceData.itemSummary ? "ITEMS_CHANGED_DURING_CUSTODY" : null
  ].filter(Boolean) as string[];
}
