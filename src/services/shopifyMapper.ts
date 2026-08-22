export type ShopifyPaymentType = "COD" | "PREPAID" | "PARTIALLY_PAID";

export interface ShopifyReadinessResult {
  ready: boolean;
  reason: string | null;
  holds: string[];
}

export interface ShopifyCommerceUpdate {
  customerName?: string;
  customerEmail?: string | null;
  customerPhone?: string;
  deliveryAddress?: string;
  city?: string;
  province?: string;
  paymentType?: ShopifyPaymentType;
  paymentMethod?: string;
  paymentStatus?: string;
  codExpected?: number;
  expectedCod?: number;
  cod_expected?: number;
  orderAmount?: number;
  collectionInstruction?: string;
  shopifyOrderId?: string;
  shopifyUpdatedAt?: string | null;
};

const OPERATIONAL_FIELDS = new Set([
  "operationalStatus", "assignedRiderId", "activeAssignmentId", "dispatchRunId", "custodyStage",
  "routeSequence", "deliveryAttempts", "returnState", "warehouseReceipt", "codSettlementState", "riderCash"
]);

export function applyShopifyCommerceUpdate(_existingPackage: any, update: ShopifyCommerceUpdate) {
  const safeUpdate: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    if (!OPERATIONAL_FIELDS.has(key) && value !== undefined) safeUpdate[key] = value;
  }
  return safeUpdate;
}

export function normalizeShopifyPayment(rawOrder: any): { paymentType: ShopifyPaymentType; paymentMethod: string; paymentStatus: string; total: number; amountPaid: number; amountOutstanding: number; codExpected: number } {
  const total = Math.round(Number(rawOrder.total_price ?? rawOrder.totalPrice ?? rawOrder.current_total_price ?? 0));
  const amountPaid = Math.max(0, Math.round(Number(rawOrder.amount_paid ?? rawOrder.total_paid ?? rawOrder.current_total_price_paid ?? 0)));
  const explicitOutstanding = rawOrder.total_outstanding ?? rawOrder.amount_outstanding;
  const amountOutstanding = Math.max(0, Math.round(Number(explicitOutstanding ?? Math.max(total - amountPaid, 0))));
  const financialStatus = String(rawOrder.financial_status || rawOrder.financialStatus || "").toLowerCase();
  const gateway = String(rawOrder.payment_gateway_names?.[0] || rawOrder.gateway || "").toLowerCase();
  if (amountOutstanding === 0 || financialStatus === "paid") return { paymentType: "PREPAID", paymentMethod: "PREPAID", paymentStatus: "paid", total, amountPaid: Math.max(amountPaid, total), amountOutstanding: 0, codExpected: 0 };
  if (amountPaid > 0 || financialStatus === "partially_paid") return { paymentType: "PARTIALLY_PAID", paymentMethod: "COD", paymentStatus: "partially_paid", total, amountPaid, amountOutstanding, codExpected: amountOutstanding };
  if (gateway.includes("card") || gateway.includes("prepaid") || gateway.includes("bank") || gateway.includes("stripe")) return { paymentType: "PREPAID", paymentMethod: "PREPAID", paymentStatus: "paid", total, amountPaid: total, amountOutstanding: 0, codExpected: 0 };
  return { paymentType: "COD", paymentMethod: "COD", paymentStatus: "unpaid", total, amountPaid: 0, amountOutstanding: amountOutstanding || total, codExpected: amountOutstanding || total };
}

export function evaluateShopifyReadiness(input: {
  phone?: string;
  address?: string;
  city?: string;
  deliveryChannel?: string;
  paymentType?: string;
  cancelled?: boolean;
  duplicate?: boolean;
  tags?: string[] | string;
}): ShopifyReadinessResult {
  const holds: string[] = [];
  if (!input.phone || input.phone.replace(/\D/g, "").length < 10) holds.push("INVALID_PHONE");
  if (!input.address) holds.push("ADDRESS_REVIEW_REQUIRED");
  if (!input.city) holds.push("ADDRESS_REVIEW_REQUIRED");
  if (input.deliveryChannel !== "internal_rider") holds.push("UNSUPPORTED_REGION");
  if (!input.paymentType) holds.push("PAYMENT_REVIEW");
  if (input.cancelled) holds.push("CANCELLED_ORDER");
  const normalizedTags = Array.isArray(input.tags) ? input.tags : String(input.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
  if (normalizedTags.some((tag) => /(^|:)mto|made.to.order/i.test(tag))) holds.push("MTO_HOLD");
  if (normalizedTags.some((tag) => /pre.?order/i.test(tag))) holds.push("PREORDER_HOLD");
  return { ready: holds.length === 0, reason: holds[0] || null, holds: Array.from(new Set(holds)) };
}
