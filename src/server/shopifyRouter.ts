import { Router } from "express";
import crypto from "crypto";
import {
  sanitizePhone,
  cleanExcelFormulaString,
  buildPackageDocumentId,
  encodeDocId,
  classifyDeliveryChannel
} from "../services/csvImporter";
import { classifyCustodyChanges, hasRiderCustody, isOlderShopifyEvent, isSupportedShopifyTopic } from "../services/shopifyEventPolicy";
import { applyShopifyCommerceUpdate, evaluateShopifyReadiness, normalizeShopifyPayment } from "../services/shopifyMapper";
import { verifyGomilaIntegrationSecret, verifyShopifyWebhookHmac } from "../services/shopifySecurity";

export interface ShopifyRouterOptions {
  db: any;
  requireAuth: any;
  requireRole: any;
  requireAnyRole: any;
}

export function createShopifyRouter({ db, requireAuth, requireAnyRole }: ShopifyRouterOptions): Router {
  const router = Router();

  function getShopifyConfig() {
    const rawDomain = (process.env.SHOPIFY_STORE_DOMAIN || "").trim();
    const cleanDomain = rawDomain
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");
    const accessToken = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
    const apiVersion = (process.env.SHOPIFY_API_VERSION || "2026-07").trim();

    return {
      configured: Boolean(cleanDomain && accessToken),
      storeDomain: cleanDomain || null,
      accessToken: accessToken || null,
      apiVersion
    };
  }

  // 1. GET /api/shopify/status
  router.get("/status", requireAuth, async (_req: any, res: any) => {
    const config = getShopifyConfig();
    return res.json({
      success: true,
      data: {
        configured: config.configured,
        storeDomain: config.storeDomain,
        apiVersion: config.apiVersion,
        message: config.configured
          ? `Shopify connected for ${config.storeDomain}`
          : "Shopify credentials not configured. Please set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN in environment variables."
      }
    });
  });

  router.get("/health", requireAuth, requireAnyRole("super_admin"), async (_req: any, res: any) => {
    try { return res.json({ success: true, data: await getShopifyHealth() }); }
    catch (err: any) { return res.status(500).json({ success: false, error: { code: "SHOPIFY_HEALTH_FAILED", message: err.message } }); }
  });

  router.get("/webhook-subscriptions", requireAuth, requireAnyRole("super_admin"), async (_req: any, res: any) => {
    const config = getShopifyConfig();
    if (!config.configured) return res.status(400).json({ success: false, error: { code: "SHOPIFY_NOT_CONFIGURED", message: "Shopify credentials are not configured." } });
    try {
      const result = await shopifyGraphQL(config, "query WebhookSubscriptions { webhookSubscriptions(first: 100) { nodes { id topic } } }");
      const expectedTopics = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_EDITED", "ORDERS_CANCELLED", "ORDERS_PAID", "REFUNDS_CREATE"];
      const subscriptions = result.data?.webhookSubscriptions?.nodes || [];
      return res.json({ success: true, data: { expectedTopics, subscriptions, missingTopics: expectedTopics.filter((topic) => !subscriptions.some((subscription: any) => subscription.topic === topic)), healthy: expectedTopics.every((topic) => subscriptions.some((subscription: any) => subscription.topic === topic)) } });
    } catch (err: any) { return res.status(502).json({ success: false, error: { code: "SHOPIFY_SUBSCRIPTION_CHECK_FAILED", message: err.message } }); }
  });

  router.post("/webhook-subscriptions/repair", requireAuth, requireAnyRole("super_admin"), async (_req: any, res: any) => {
    const config = getShopifyConfig();
    const callbackUrl = String(process.env.SHOPIFY_WEBHOOK_CALLBACK_URL || "").trim();
    if (!config.configured || !callbackUrl) return res.status(400).json({ success: false, error: { code: "SHOPIFY_WEBHOOK_CALLBACK_NOT_CONFIGURED", message: "Set SHOPIFY_WEBHOOK_CALLBACK_URL before repairing subscriptions." } });
    try {
      const expectedTopics = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_EDITED", "ORDERS_CANCELLED", "ORDERS_PAID", "REFUNDS_CREATE"];
      const results = [];
      for (const topic of expectedTopics) {
        const topicCallbackUrl = `${callbackUrl.replace(/\/+$/, "")}/${topic}`;
        results.push(await shopifyGraphQL(config, "mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $callbackUrl }) { userErrors { field message } webhookSubscription { id topic } } }", { topic, callbackUrl: topicCallbackUrl }));
      }
      return res.json({ success: true, data: { repaired: results.length, results } });
    } catch (err: any) { return res.status(502).json({ success: false, error: { code: "SHOPIFY_SUBSCRIPTION_REPAIR_FAILED", message: err.message } }); }
  });

  // 2. POST /api/shopify/test-connection
  router.post("/test-connection", requireAuth, requireAnyRole("super_admin", "dispatch_manager"), async (_req: any, res: any) => {
    const config = getShopifyConfig();
    if (!config.configured || !config.storeDomain || !config.accessToken) {
      return res.status(400).json({
        success: false,
        error: {
          code: "SHOPIFY_NOT_CONFIGURED",
          message: "Shopify API credentials missing in environment variables (SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN)."
        }
      });
    }

    try {
      const url = `https://${config.storeDomain}/admin/api/${config.apiVersion}/shop.json`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": config.accessToken
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        return res.status(response.status).json({
          success: false,
          error: {
            code: "SHOPIFY_AUTH_FAILED",
            message: `Shopify API rejected connection (HTTP ${response.status}): ${errorText}`
          }
        });
      }

      const data = await response.json();
      return res.json({
        success: true,
        data: {
          shopName: data.shop?.name,
          email: data.shop?.email,
          currency: data.shop?.currency || "PKR",
          domain: data.shop?.myshopify_domain || config.storeDomain,
          country: data.shop?.country_name
        }
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: {
          code: "SHOPIFY_CONNECTION_ERROR",
          message: `Network failure connecting to Shopify: ${err.message}`
        }
      });
    }
  });

  async function shopifyGraphQL(config: { storeDomain: string; accessToken: string; apiVersion: string }, query: string, variables: Record<string, unknown> = {}) {
    let lastError = "Shopify GraphQL request failed";
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`https://${config.storeDomain}/admin/api/${config.apiVersion}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": config.accessToken },
        body: JSON.stringify({ query, variables })
      });
      if (response.ok) {
        const json = await response.json();
        if (Array.isArray(json.errors) && json.errors.length > 0) {
          lastError = json.errors.map((error: any) => error.message).join("; ");
          const throttled = json.errors.some((error: any) => String(error.extensions?.code || "").toUpperCase().includes("THROTTL"));
          if (!throttled) throw new Error(lastError);
        } else return json;
      } else {
        lastError = `Shopify GraphQL API error (HTTP ${response.status})`;
        if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`${lastError}: ${await response.text()}`);
      }
      const retryAfter = Math.min(2000, Math.max(100, Number(response.headers.get("retry-after") || 0) * 1000 || 250 * (attempt + 1)));
      await new Promise((resolve) => setTimeout(resolve, retryAfter));
    }
    throw new Error(lastError);
  }

  async function processShopifyOutboundQueue() {
    const config = getShopifyConfig();
    if (!config.configured) return { skipped: true, processed: 0 };
    const [pendingSnapshot, failedSnapshot] = await Promise.all([
      db.collection("shopifyOutboundEvents").where("status", "==", "PENDING").limit(25).get(),
      db.collection("shopifyOutboundEvents").where("status", "==", "FAILED").limit(25).get()
    ]);
    const events = [...pendingSnapshot.docs, ...failedSnapshot.docs].filter((doc: any) => Number(doc.data()?.retryCount || 0) < 5);
    let processed = 0;
    for (const eventDoc of events) {
      const event = eventDoc.data() || {};
      const processingAt = new Date().toISOString();
      await eventDoc.ref.set({ status: "PROCESSING", processingAt }, { merge: true });
      try {
        const result = await shopifyGraphQL(config, "mutation SetRiderControlMetafields($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }", {
          metafields: [{ ownerId: `gid://shopify/Order/${event.shopifyOrderId}`, namespace: "rider_control", key: "last_event", type: "json", value: JSON.stringify({ eventType: event.eventType, ...event.payload }) }]
        });
        const userErrors = result.data?.metafieldsSet?.userErrors || [];
        if (userErrors.length > 0) throw new Error(userErrors.map((error: any) => error.message).join("; "));
        await eventDoc.ref.set({ status: "SENT", sentAt: new Date().toISOString(), lastError: null }, { merge: true });
        processed++;
      } catch (error: any) {
        const retryCount = Number(event.retryCount || 0) + 1;
        await eventDoc.ref.set({ status: retryCount >= 5 ? "DEAD_LETTER" : "FAILED", retryCount, lastError: error.message, lastAttemptAt: new Date().toISOString() }, { merge: true });
      }
    }
    return { skipped: false, processed };
  }

  async function recordShopifySuccess(topic: string, shopifyUpdatedAt: string | null, timestamp: string) {
    await db.collection("integrationCheckpoints").doc("shopify").set({ lastWebhookAt: timestamp, lastSuccessfulWebhookAt: timestamp, lastShopifyUpdatedAtCheckpoint: shopifyUpdatedAt || null, updatedAt: timestamp }, { merge: true });
    await db.collection("auditEvents").doc(`shopify_${crypto.createHash("sha256").update(`${topic}:${timestamp}:${shopifyUpdatedAt || ""}`).digest("hex")}`).set({ actorType: "SYSTEM", source: "SHOPIFY", topic, shopifyUpdatedAt, processedAt: timestamp, createdAt: timestamp }, { merge: true });
  }

  async function countShopifyEvents(status: string) {
    const query = db.collection("shopifyWebhookEvents").where("status", "==", status);
    if (typeof (query as any).count === "function") return Number((await (query as any).count().get()).data().count || 0);
    return (await query.get()).size;
  }

  async function getShopifyHealth() {
    const checkpoint = (await db.collection("integrationCheckpoints").doc("shopify").get()).data() || {};
    const config = getShopifyConfig();
    const [received, processed, retry, failed, deadLetter] = await Promise.all([
      countShopifyEvents("RECEIVED"), countShopifyEvents("PROCESSED"), countShopifyEvents("RETRY"), countShopifyEvents("FAILED"), countShopifyEvents("DEAD_LETTER")
    ]);
    return { connected: config.configured, apiVersion: config.apiVersion, ...checkpoint, eventCounts: { received, processed, retry, failed, deadLetter } };
  }

  // Helper to fetch and normalize Shopify orders
  async function fetchAndNormalizeShopifyOrders(config: { storeDomain: string; accessToken: string; apiVersion: string }, options: { limit?: number; status?: string; fulfillmentStatus?: string; updatedSince?: string; after?: string | null } = {}) {
    const limit = Math.min(Math.max(Number(options.limit || 50), 1), 250);
    const status = options.status || "open";
    const fulfillmentStatus = options.fulfillmentStatus !== undefined ? options.fulfillmentStatus : "unfulfilled";

    const queryParts = [`status:${status}`];
    if (fulfillmentStatus) queryParts.push(`fulfillment_status:${fulfillmentStatus}`);
    if (options.updatedSince) queryParts.push(`updated_at:>=${options.updatedSince}`);
    const json = await shopifyGraphQL(config, `query Orders($first: Int!, $after: String, $query: String) { orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) { nodes { id legacyResourceId name orderNumber createdAt updatedAt cancelledAt financialStatus currentTotalPriceSet { shopMoney { amount currencyCode } } totalPriceSet { shopMoney { amount currencyCode } } totalOutstandingSet { shopMoney { amount currencyCode } } email phone note tags paymentGatewayNames customer { id firstName lastName email phone } shippingAddress { firstName lastName phone address1 address2 city province country zip } lineItems(first: 100) { nodes { title name quantity sku variantTitle variant { id } originalUnitPriceSet { shopMoney { amount } } } } } pageInfo { hasNextPage endCursor } } }`, { first: limit, after: options.after || null, query: queryParts.join(" ") });
    const rawOrders: any[] = (json.data?.orders?.nodes || []).map((order: any) => ({
      ...order,
      id: order.legacyResourceId || String(order.id || "").split("/").pop(),
      created_at: order.createdAt,
      updated_at: order.updatedAt,
      cancelled_at: order.cancelledAt,
      total_price: order.totalPriceSet?.shopMoney?.amount,
      current_total_price: order.currentTotalPriceSet?.shopMoney?.amount,
      total_outstanding: order.totalOutstandingSet?.shopMoney?.amount,
      amount_paid: Math.max(0, Number(order.currentTotalPriceSet?.shopMoney?.amount || order.totalPriceSet?.shopMoney?.amount || 0) - Number(order.totalOutstandingSet?.shopMoney?.amount || 0)),
      financial_status: String(order.financialStatus || "").toLowerCase(),
      payment_gateway_names: order.paymentGatewayNames || [],
      line_items: (order.lineItems?.nodes || []).map((item: any) => ({ ...item, variant_id: item.variant?.id, variant_title: item.variantTitle, price: item.originalUnitPriceSet?.shopMoney?.amount })),
      customer: order.customer ? { first_name: order.customer.firstName, last_name: order.customer.lastName, email: order.customer.email, phone: order.customer.phone } : null,
      shipping_address: order.shippingAddress ? { first_name: order.shippingAddress.firstName, last_name: order.shippingAddress.lastName, phone: order.shippingAddress.phone, address1: order.shippingAddress.address1, address2: order.shippingAddress.address2, city: order.shippingAddress.city, province: order.shippingAddress.province, country: order.shippingAddress.country } : null
    }));

    const normalizedOrders = rawOrders.map((ord: any) => {
      const displayOrderNumber = ord.name ? cleanExcelFormulaString(ord.name) : `#${ord.order_number || ord.id}`;
      const cleanOrderNumber = displayOrderNumber.replace(/^#+/, "").trim();
      const parentOrderNumber = cleanOrderNumber;
      const packageNumber = cleanOrderNumber;

      const shippingAddress = ord.shipping_address || ord.billing_address || {};
      const customer = ord.customer || {};

      const customerName = [
        shippingAddress.first_name || customer.first_name || "",
        shippingAddress.last_name || customer.last_name || ""
      ].join(" ").trim() || "Customer";

      const rawPhone = shippingAddress.phone || customer.phone || ord.phone || "";
      const customerPhone = sanitizePhone(rawPhone);
      const fallbackPhone = customer.phone && customer.phone !== rawPhone ? sanitizePhone(customer.phone) : "";

      const address = [
        shippingAddress.address1 || "",
        shippingAddress.address2 || ""
      ].filter(Boolean).join(", ").trim();

      // SAFETY: Never default missing city to Karachi.
      const rawCity = (shippingAddress.city || "").trim();
      const city = rawCity || "";
      const province = shippingAddress.province || "";
      const isMissingCity = !rawCity;
      const isMissingAddress = !address;

      const payment = normalizeShopifyPayment(ord);
      const totalAmount = payment.total;
      const financialStatus = ord.financial_status || "pending";
      const isPrepaid = payment.paymentType === "PREPAID";
      const codExpected = payment.codExpected;

      // Delivery channel classification - if missing city, flag for review
      let deliveryChannel = "unassigned";
      if (isMissingCity) {
        deliveryChannel = "unassigned";
      } else {
        const cityLower = city.toLowerCase();
        const isKarachi = cityLower.includes("karachi") || cityLower.includes("khi");
        deliveryChannel = isKarachi ? "internal_rider" : "external_courier";
      }

      // Line items mapping
      const lineItems = Array.isArray(ord.line_items) ? ord.line_items : [];
      const items = lineItems.map((li: any, idx: number) => ({
        itemId: `item_${encodeDocId(packageNumber)}_${idx + 1}`,
        packageId: buildPackageDocumentId(packageNumber),
        packageNumber,
        itemTitle: li.title || "Item",
        variantTitle: li.variant_title || "",
        barcode: li.sku || (li.variant_id ? String(li.variant_id) : ""),
        quantity: Math.max(1, Number(li.quantity || 1)),
        unitPrice: Math.round(Number(li.price || 0)),
        itemNotes: li.name || ""
      }));

      const itemSummary = items.map((i: any) => `${i.quantity}x ${i.itemTitle}${i.variantTitle ? ` (${i.variantTitle})` : ""}`).join("; ") || "Gomila Footwear";

      const hasException = isMissingCity || isMissingAddress;
      const exceptionReason = isMissingCity ? "ADDRESS_REVIEW_REQUIRED (Missing City)" : (isMissingAddress ? "ADDRESS_REVIEW_REQUIRED (Incomplete Address)" : undefined);

      return {
        shopifyId: ord.id,
        externalOrderId: displayOrderNumber,
        normalizedOrderKey: cleanOrderNumber.toUpperCase(),
        displayOrderNumber,
        parentOrderNumber,
        packageNumber,
        packageId: buildPackageDocumentId(packageNumber),
        customerName,
        customerPhone,
        alternatePhone: fallbackPhone || null,
        deliveryAddress: address || "Address not provided",
        city,
        province,
        email: customer.email || ord.email || null,
        deliveryInstructions: ord.note || null,
        paymentMethod: payment.paymentMethod,
        paymentType: payment.paymentType,
        paymentStatus: payment.paymentStatus,
        amountPaid: payment.amountPaid,
        amountOutstanding: payment.amountOutstanding,
        financialStatus,
        orderAmount: totalAmount,
        codExpected,
        currency: "PKR" as const,
        courierType: deliveryChannel,
        deliveryChannel,
        itemSummary,
        totalQuantity: items.reduce((acc: number, item: any) => acc + item.quantity, 0),
        items,
        shopifyCreatedAt: ord.created_at,
        shopifyUpdatedAt: ord.updated_at || null,
        tags: ord.tags || "",
        hasException,
        exceptionReason,
        addressIncomplete: hasException
      };
    });

    (normalizedOrders as any).pageInfo = json.data?.orders?.pageInfo || { hasNextPage: false, endCursor: null };
    return normalizedOrders;
  }

  // 3. POST /api/shopify/preview
  router.post("/preview", requireAuth, requireAnyRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    const config = getShopifyConfig();
    if (!config.configured || !config.storeDomain || !config.accessToken) {
      return res.status(400).json({
        success: false,
        error: {
          code: "SHOPIFY_NOT_CONFIGURED",
          message: "Shopify API credentials missing in environment variables."
        }
      });
    }

    try {
      const { limit, status, fulfillmentStatus } = req.body || {};
      const normalizedOrders = await fetchAndNormalizeShopifyOrders(config, { limit, status, fulfillmentStatus });

      // Check existing packages in Firestore to classify duplicates vs new
      const packageIds = normalizedOrders.map(o => o.packageId);
      const existingSnaps = await Promise.all(
        packageIds.map(pkgId => db.collection("packages").doc(pkgId).get())
      );

      const existingMap = new Map<string, any>();
      existingSnaps.forEach((snap, idx) => {
        if (snap.exists) {
          existingMap.set(packageIds[idx], snap.data());
        }
      });

      let newCount = 0;
      let duplicateCount = 0;
      let conflictCount = 0;
      let totalAmount = 0;
      let totalExpectedCod = 0;
      let prepaidCount = 0;
      let codCount = 0;
      let internalRiderCount = 0;
      let externalCourierCount = 0;

      const previewOrders = normalizedOrders.map(ord => {
        totalAmount += ord.orderAmount;
        totalExpectedCod += ord.codExpected;
        if (ord.paymentStatus === "paid") prepaidCount++;
        else codCount++;

        if (ord.courierType === "internal_rider") internalRiderCount++;
        else externalCourierCount++;

        const existing = existingMap.get(ord.packageId);
        let importStatus: "new" | "update_candidate" | "operational_conflict" = "new";

        if (existing) {
          duplicateCount++;
          const currentOpStatus = existing.operationalStatus || existing.status || "unassigned";
          if (["out_for_delivery", "delivered", "returned", "returning_to_warehouse"].includes(currentOpStatus)) {
            importStatus = "operational_conflict";
            conflictCount++;
          } else {
            importStatus = "update_candidate";
          }
        } else {
          newCount++;
        }

        return {
          ...ord,
          importStatus,
          existingStatus: existing?.operationalStatus || null
        };
      });

      return res.json({
        success: true,
        data: {
          totalShopifyOrders: normalizedOrders.length,
          newOrdersCount: newCount,
          duplicateOrdersCount: duplicateCount,
          conflictCount,
          totalOrderAmount: totalAmount,
          totalExpectedCod,
          prepaidCount,
          codCount,
          internalRiderCount,
          externalCourierCount,
          storeDomain: config.storeDomain,
          orders: previewOrders
        }
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: {
          code: "SHOPIFY_PREVIEW_ERROR",
          message: err.message
        }
      });
    }
  });

  // 4. POST /api/shopify/sync
  router.post("/sync", requireAuth, requireAnyRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    const config = getShopifyConfig();
    if (!config.configured || !config.storeDomain || !config.accessToken) {
      return res.status(400).json({
        success: false,
        error: {
          code: "SHOPIFY_NOT_CONFIGURED",
          message: "Shopify API credentials missing in environment variables."
        }
      });
    }

    const { limit, status, fulfillmentStatus } = req.body || {};
    const syncRunId = `sync-shopify-${Date.now()}`;
    const startedAt = new Date().toISOString();

    try {
      const normalizedOrders = await fetchAndNormalizeShopifyOrders(config, { limit, status, fulfillmentStatus });

      if (normalizedOrders.length === 0) {
        return res.json({
          success: true,
          data: {
            syncRunId,
            totalFetched: 0,
            created: 0,
            updated: 0,
            skippedDuplicates: 0,
            conflicts: 0,
            message: "No open unfulfilled orders found in Shopify."
          }
        });
      }

      // Check existing records in Firestore
      const packageIds = normalizedOrders.map(o => o.packageId);
      const existingSnaps = await Promise.all(
        packageIds.map(pkgId => db.collection("packages").doc(pkgId).get())
      );

      const existingMap = new Map<string, any>();
      existingSnaps.forEach((snap, idx) => {
        if (snap.exists) {
          existingMap.set(packageIds[idx], snap.data());
        }
      });

      let createdCount = 0;
      let updatedCount = 0;
      let skippedDuplicatesCount = 0;
      let conflictCount = 0;

      const operations: Array<{ ref: any; data: any; mode: "set" | "update" }> = [];
      const auditEvents: any[] = [];
      const timestamp = new Date().toISOString();

      normalizedOrders.forEach(ord => {
        const existing = existingMap.get(ord.packageId);
        const pkgRef = db.collection("packages").doc(ord.packageId);
        const encParent = encodeURIComponent(ord.parentOrderNumber).replace(/\./g, "%2E");
        const parentRef = db.collection("parentOrders").doc(`parent_${encParent}`);
        const orderRef = db.collection("orders").doc(ord.packageId);

        if (existing) {
          const currentOpStatus = existing.operationalStatus || existing.status || "unassigned";
          // Operational Status Protection: Do not overwrite active operational records
          if (["out_for_delivery", "delivered", "returned", "returning_to_warehouse"].includes(currentOpStatus)) {
            conflictCount++;
            // Create operational exception record
            const excRef = db.collection("exceptions").doc(`exc_shopify_${ord.packageId}_${Date.now()}`);
            operations.push({
              ref: excRef,
              data: {
                id: excRef.id,
                code: "SHOPIFY_SYNC_OPERATIONAL_CONFLICT",
                severity: "warning",
                packageId: ord.packageId,
                packageNumber: ord.packageNumber,
                orderNumber: ord.displayOrderNumber,
                message: `Shopify re-import attempted on active/delivered package in status '${currentOpStatus}'. Operational fields preserved.`,
                syncRunId,
                createdAt: timestamp,
                resolutionStatus: "pending"
              },
              mode: "set"
            });
            return;
          }

          // Safe source update for unassigned/staged orders
          updatedCount++;
          operations.push({
            ref: pkgRef,
            data: {
              customerName: ord.customerName,
              customerPhone: ord.customerPhone,
              deliveryAddress: ord.deliveryAddress,
              city: ord.city,
              deliveryInstructions: ord.deliveryInstructions,
              paymentMethod: ord.paymentMethod,
              paymentStatus: ord.paymentStatus,
              orderAmount: ord.orderAmount,
              codExpected: ord.codExpected,
              itemSummary: ord.itemSummary,
              syncRunId,
              updatedAt: timestamp
            },
            mode: "update"
          });

          auditEvents.push({
            eventId: `evt_${crypto.randomUUID()}`,
            entityType: "package",
            entityId: ord.packageId,
            eventType: "SHOPIFY_SOURCE_UPDATED",
            previousState: { operationalStatus: currentOpStatus },
            newState: { operationalStatus: currentOpStatus, updatedSource: "shopify" },
            performedByUid: req.auth?.uid || "system_shopify_sync",
            performedByRole: req.auth?.role || "dispatch_manager",
            reason: `Direct Shopify synchronization update (Shopify Order ID: ${ord.shopifyId})`,
            importRunId: syncRunId,
            createdAt: timestamp
          });
        } else {
          // New Package & Order Creation
          createdCount++;

          const packageDoc = {
            id: ord.packageId,
            packageId: ord.packageId,
            packageNumber: ord.packageNumber,
            package_number: ord.packageNumber,
            displayOrderNumber: ord.displayOrderNumber,
            externalOrderId: ord.externalOrderId,
            normalizedOrderKey: ord.normalizedOrderKey,
            parentOrderNumber: ord.parentOrderNumber,
            parent_order_number: ord.parentOrderNumber,
            packageSequence: 1,
            customerName: ord.customerName,
            customer_name: ord.customerName,
            customerPhone: ord.customerPhone,
            contact_number: ord.customerPhone,
            primaryPhone: ord.customerPhone,
            alternatePhone: ord.alternatePhone,
            deliveryAddress: ord.deliveryAddress,
            address: ord.deliveryAddress,
            city: ord.city,
            province: ord.province,
            deliveryInstructions: ord.deliveryInstructions,
            paymentMethod: ord.paymentMethod,
            payment_method: ord.paymentMethod,
            paymentStatus: ord.paymentStatus,
            orderAmount: ord.orderAmount,
            order_amount: ord.orderAmount,
            packageTotal: ord.orderAmount,
            codExpected: ord.codExpected,
            expectedCod: ord.codExpected,
            cod_expected: ord.codExpected,
            expected_cod: ord.codExpected,
            currency: ord.currency,
            courierType: ord.courierType,
            deliveryChannel: ord.deliveryChannel,
            delivery_channel: ord.deliveryChannel,
            externalCourierName: ord.courierType === "external_courier" ? "Unassigned Courier" : null,
            importState: "committed",
            operationalStatus: "imported_review",
            current_status: "Imported",
            activeAssignmentId: null,
            assignedRiderId: null,
            itemSummary: ord.itemSummary,
            totalQuantity: ord.totalQuantity,
            hasException: ord.hasException || false,
            exceptionReason: ord.exceptionReason || null,
            addressIncomplete: ord.addressIncomplete || false,
            source: "shopify",
            shopifyId: ord.shopifyId,
            syncRunId,
            importRunId: syncRunId,
            createdAt: timestamp,
            updatedAt: timestamp
          };

          operations.push({ ref: pkgRef, data: packageDoc, mode: "set" });
          operations.push({ ref: orderRef, data: packageDoc, mode: "set" });

          // Parent order record
          operations.push({
            ref: parentRef,
            data: {
              id: parentRef.id,
              parentOrderNumber: ord.parentOrderNumber,
              customerName: ord.customerName,
              customerPhone: ord.customerPhone,
              address: ord.deliveryAddress,
              city: ord.city,
              orderTotal: ord.orderAmount,
              expectedCod: ord.codExpected,
              source: "shopify",
              createdAt: timestamp,
              updatedAt: timestamp
            },
            mode: "set"
          });

          // Package Line Items
          ord.items.forEach((item: any) => {
            const itemRef = db.collection("packageItems").doc(item.itemId);
            operations.push({
              ref: itemRef,
              data: {
                ...item,
                source: "shopify",
                syncRunId,
                createdAt: timestamp
              },
              mode: "set"
            });
          });

          auditEvents.push({
            eventId: `evt_${crypto.randomUUID()}`,
            entityType: "package",
            entityId: ord.packageId,
            eventType: "SHOPIFY_PACKAGE_CREATED",
            previousState: null,
            newState: { operationalStatus: "imported_review", codExpected: ord.codExpected, importState: "committed" },
            performedByUid: req.auth?.uid || "system_shopify_sync",
            performedByRole: req.auth?.role || "dispatch_manager",
            reason: `Direct Shopify order ingestion (Shopify Order ID: ${ord.shopifyId})`,
            importRunId: syncRunId,
            createdAt: timestamp
          });
        }
      });

      // Write in chunked batches (<= 450 items per Firestore batch)
      const CHUNK_SIZE = 400;
      for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
        const chunk = operations.slice(i, i + CHUNK_SIZE);
        const batch = db.batch();
        chunk.forEach(op => {
          if (op.mode === "update") {
            batch.update(op.ref, op.data);
          } else {
            batch.set(op.ref, op.data, { merge: true });
          }
        });
        await batch.commit();
      }

      // Record audit operational events in batches
      for (let i = 0; i < auditEvents.length; i += CHUNK_SIZE) {
        const eventChunk = auditEvents.slice(i, i + CHUNK_SIZE);
        const batch = db.batch();
        eventChunk.forEach(evt => {
          const evtRef = db.collection("operationalEvents").doc(evt.eventId);
          batch.set(evtRef, evt);
        });
        await batch.commit();
      }

      // Record sync run batch
      const syncRecordRef = db.collection("importRuns").doc(syncRunId);
      await syncRecordRef.set({
        id: syncRunId,
        importRunId: syncRunId,
        source: "shopify",
        storeDomain: config.storeDomain,
        startedAt,
        completedAt: new Date().toISOString(),
        startedByUid: req.auth?.uid || "system",
        totalRows: normalizedOrders.length,
        validRows: normalizedOrders.length,
        createdRows: createdCount,
        updatedRows: updatedCount,
        skippedDuplicateRows: skippedDuplicatesCount,
        conflictRows: conflictCount,
        failedRows: 0,
        status: conflictCount > 0 ? "completed_with_errors" : "completed"
      });

      return res.json({
        success: true,
        data: {
          syncRunId,
          totalFetched: normalizedOrders.length,
          created: createdCount,
          updated: updatedCount,
          skippedDuplicates: skippedDuplicatesCount,
          conflicts: conflictCount,
          storeDomain: config.storeDomain,
          status: "completed"
        }
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: {
          code: "SHOPIFY_SYNC_FAILED",
          message: err.message
        }
      });
    }
  });

  // Shopify webhooks and the recovery endpoint share the same guarded ingestion path.
  async function handleShopifyOrder(req: any, res: any) {
    try {
      const makeSecretHeader = req.headers["x-gomila-integration-secret"] || req.headers["x-integration-secret"];
      const shopifyHmacHeader = req.headers["x-shopify-hmac-sha256"];
      const configuredMakeSecret = (process.env.SHOPIFY_INTEGRATION_SECRET || "").trim();
      const configuredShopifyWebhookSecret = (process.env.SHOPIFY_WEBHOOK_SECRET || "").trim();

      if (typeof shopifyHmacHeader === "string" && shopifyHmacHeader.trim()) {
        if (!configuredShopifyWebhookSecret) {
          return res.status(503).json({
            success: false,
            error: {
              code: "SHOPIFY_WEBHOOK_SECRET_NOT_CONFIGURED",
              message: "SHOPIFY_WEBHOOK_SECRET is not configured. Shopify webhook ingestion is disabled."
            }
          });
        }
        if (!Buffer.isBuffer(req.rawBody) || !verifyShopifyWebhookHmac(req.rawBody, shopifyHmacHeader, configuredShopifyWebhookSecret)) {
          return res.status(401).json({
            success: false,
            error: {
              code: "INVALID_SHOPIFY_HMAC",
              message: "Shopify webhook HMAC verification failed."
            }
          });
        }
      } else {
        if (!configuredMakeSecret) {
          return res.status(503).json({
            success: false,
            error: {
              code: "SHOPIFY_SECRET_NOT_CONFIGURED",
              message: "SHOPIFY_INTEGRATION_SECRET is not configured. Make ingestion is disabled."
            }
          });
        }
        if (!verifyGomilaIntegrationSecret(makeSecretHeader, configuredMakeSecret)) {
          return res.status(401).json({
            success: false,
            error: {
              code: "UNAUTHORIZED_INTEGRATION_REQUEST",
              message: "Missing or invalid Gomila integration secret. Webhook rejected."
            }
          });
        }
      }

      const topic = String(req.shopifyTopic || req.headers["x-shopify-topic"] || "ORDERS_CREATE").toUpperCase();
      const rawOrder = { ...(req.body?.order || req.body) };
      if (topic === "REFUNDS_CREATE" && !rawOrder.id && rawOrder.order_id) rawOrder.id = rawOrder.order_id;
      if (!rawOrder || (!rawOrder.id && !rawOrder.order_number && !rawOrder.name)) {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_ORDER_PAYLOAD", message: "Missing valid Shopify order payload" }
        });
      }

      if (!isSupportedShopifyTopic(topic)) return res.status(400).json({ success: false, error: { code: "UNSUPPORTED_SHOPIFY_TOPIC", message: `Unsupported Shopify topic: ${topic}` } });
      const eventId = String(req.headers["x-shopify-webhook-id"] || `evt_${crypto.createHash("sha256").update(JSON.stringify(rawOrder)).digest("hex")}`);
      const shopDomain = String(req.headers["x-shopify-shop-domain"] || process.env.SHOPIFY_STORE_DOMAIN || "unknown");
      const shopifyUpdatedAt = rawOrder.updated_at || rawOrder.updatedAt || rawOrder.cancelled_at || rawOrder.created_at || null;
      const payloadHash = crypto.createHash("sha256").update(Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}))).digest("hex");
      const inboxRef = db.collection("shopifyWebhookEvents").doc(eventId);
      const reservation = await db.runTransaction(async (transaction: any) => {
        const existing = await transaction.get(inboxRef);
        const existingEvent = existing.exists ? existing.data() || {} : {};
        if (["PROCESSED", "PROCESSING"].includes(String(existingEvent.status || ""))) return { duplicate: true, status: existingEvent.status };
        const processingStartedAt = new Date().toISOString();
        transaction.set(inboxRef, { eventId, topic, shopDomain, shopifyOrderId: String(rawOrder.id || rawOrder.order_number || rawOrder.name), shopifyUpdatedAt, receivedAt: existingEvent.receivedAt || processingStartedAt, processingStartedAt, processedAt: null, status: "PROCESSING", retryCount: Number(existingEvent.retryCount || 0) + 1, errorCode: null, errorMessage: null, payloadHash, payload: req.body }, { merge: true });
        return { duplicate: false, status: "PROCESSING" };
      });
      await db.collection("integrationCheckpoints").doc("shopify").set({ lastWebhookAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true });
      if (reservation.duplicate) return res.json({ success: true, data: { duplicate: true, eventId, status: reservation.status } });

      const displayOrderNumber = rawOrder.name ? cleanExcelFormulaString(rawOrder.name) : `#${rawOrder.order_number || rawOrder.id}`;
      const cleanOrderNumber = displayOrderNumber.replace(/^#+/, "").trim();
      const parentOrderNumber = cleanOrderNumber;
      const packageNumber = cleanOrderNumber;
      const packageId = buildPackageDocumentId(packageNumber);

      const shippingAddress = rawOrder.shipping_address || rawOrder.billing_address || {};
      const customer = rawOrder.customer || {};

      const customerName = [
        shippingAddress.first_name || customer.first_name || "",
        shippingAddress.last_name || customer.last_name || ""
      ].join(" ").trim() || "Customer";

      const rawPhone = shippingAddress.phone || customer.phone || rawOrder.phone || "";
      const customerPhone = sanitizePhone(rawPhone);

      const address = [
        shippingAddress.address1 || "",
        shippingAddress.address2 || ""
      ].filter(Boolean).join(", ").trim();

      const rawCity = (shippingAddress.city || "").trim();
      const city = rawCity || "";
      const province = shippingAddress.province || "";
      const isMissingCity = !rawCity;
      const isMissingAddress = !address;

      const payment = normalizeShopifyPayment(rawOrder);
      const totalAmount = payment.total;
      const paymentType = payment.paymentType;
      const paymentMethod = payment.paymentMethod;
      const paymentStatus = payment.paymentStatus;
      const codExpected = payment.codExpected;

      let deliveryChannel = "unassigned";
      if (!isMissingCity) {
        const cityLower = city.toLowerCase();
        const isKarachi = cityLower.includes("karachi") || cityLower.includes("khi");
        deliveryChannel = isKarachi ? "internal_rider" : "external_courier";
      }

      const lineItems = Array.isArray(rawOrder.line_items) ? rawOrder.line_items : [];
      const items = lineItems.map((li: any, idx: number) => ({
        itemId: `item_${encodeDocId(packageNumber)}_${idx + 1}`,
        packageId,
        packageNumber,
        itemTitle: li.title || "Item",
        variantTitle: li.variant_title || "",
        barcode: li.sku || (li.variant_id ? String(li.variant_id) : ""),
        quantity: Math.max(1, Number(li.quantity || 1)),
        unitPrice: Math.round(Number(li.price || 0)),
        itemNotes: li.name || ""
      }));

      const itemSummary = items.map((i: any) => `${i.quantity}x ${i.itemTitle}${i.variantTitle ? ` (${i.variantTitle})` : ""}`).join("; ") || "Gomila Footwear";
      const timestamp = new Date().toISOString();
      const readiness = evaluateShopifyReadiness({
        phone: customerPhone,
        address,
        city,
        deliveryChannel,
        paymentType,
        cancelled: topic === "ORDERS_CANCELLED" || Boolean(rawOrder.cancelled_at),
        tags: rawOrder.tags
      });

      const packageRef = db.collection("packages").doc(packageId);
      const existingPackageSnap = await packageRef.get();
      const existingPackage = existingPackageSnap.exists ? existingPackageSnap.data() || {} : null;
      const existingStatus = String(existingPackage?.operationalStatus || existingPackage?.status || "unassigned").toLowerCase();
      const hasCustody = ["out_for_delivery", "delivered", "returned", "returning_to_warehouse", "rider_handed_back", "warehouse_received"].includes(existingStatus) || Boolean(existingPackage?.activeAssignmentId || existingPackage?.assignedRiderId);
      const commerceMirror = {
        shopifyOrderId: String(rawOrder.id || rawOrder.order_number || rawOrder.name),
        externalOrderId: displayOrderNumber,
        shopDomain,
        customerName,
        customerPhone,
        deliveryAddress: address || "Address not provided",
        city,
        province,
        orderAmount: totalAmount,
        orderNumber: displayOrderNumber,
        customerId: customer.id || rawOrder.customer_id || null,
        customerEmail: customer.email || rawOrder.email || null,
        shippingName: customerName,
        address1: shippingAddress.address1 || "",
        address2: shippingAddress.address2 || "",
        postalCode: shippingAddress.zip || shippingAddress.postal_code || null,
        country: shippingAddress.country || null,
        subtotal: Number(rawOrder.subtotal_price || rawOrder.subtotal || 0),
        discount: Number(rawOrder.total_discounts || rawOrder.discount || 0),
        total: payment.total,
        amountPaid: payment.amountPaid,
        amountOutstanding: payment.amountOutstanding,
        fulfillmentStatus: rawOrder.fulfillment_status || rawOrder.fulfillmentStatus || null,
        cancelledAt: rawOrder.cancelled_at || null,
        refunds: rawOrder.refunds || [],
        tags: rawOrder.tags || [],
        notes: rawOrder.note || rawOrder.notes || null,
        readinessStatus: readiness.ready ? "READY_FOR_DISPATCH" : "IMPORTED_REVIEW",
        readinessHolds: readiness.holds,
        paymentType,
        paymentMethod,
        paymentStatus,
        financialStatus: String(rawOrder.financial_status || rawOrder.financialStatus || "").toLowerCase(),
        codExpected,
        items,
        itemSummary,
        shopifyCreatedAt: rawOrder.created_at || null,
        shopifyUpdatedAt,
        updatedAt: timestamp,
        source: "shopify"
      };

      if (topic === "REFUNDS_CREATE") {
        await db.collection("shopifyRefunds").doc(eventId).set({ id: eventId, eventId, shopifyOrderId: commerceMirror.shopifyOrderId, refundId: rawOrder.refund_id || rawOrder.id, amount: Number(rawOrder.amount || rawOrder.refunds?.[0]?.transactions?.[0]?.amount || 0), currency: rawOrder.currency || "PKR", status: "RECORDED", receivedAt: timestamp, payloadHash }, { merge: true });
        if (existingPackage) await db.collection("exceptions").doc(`shopify_refund_${eventId}`).set({ id: `shopify_refund_${eventId}`, code: "SHOPIFY_REFUND_REVERSE_LOGISTICS_REVIEW", topic, packageId, shopifyOrderId: commerceMirror.shopifyOrderId, status: "OPEN", resolutionStatus: "pending", severity: "MEDIUM", message: "Commercial refund recorded. Physical package return requires separate reverse-logistics decision.", createdAt: timestamp }, { merge: true });
        await recordShopifySuccess(topic, shopifyUpdatedAt, timestamp);
        await inboxRef.set({ status: "PROCESSED", processedAt: timestamp, error: null }, { merge: true });
        return res.json({ success: true, data: { eventId, refundRecorded: true, packageId: existingPackage ? packageId : null } });
      }

      if (existingPackage) {
        const mirrorRef = db.collection("shopifyOrders").doc(String(rawOrder.id || rawOrder.order_number || rawOrder.name));
        const existingMirrorSnap = await mirrorRef.get();
        const previousUpdatedAt = existingMirrorSnap.data()?.shopifyUpdatedAt;
        if (isOlderShopifyEvent(previousUpdatedAt, shopifyUpdatedAt)) {
          await inboxRef.set({ status: "IGNORED_STALE", processedAt: timestamp, processingStartedAt: timestamp, errorCode: "STALE_SHOPIFY_EVENT", errorMessage: "Ignored because a newer Shopify mirror version already exists." }, { merge: true });
          return res.json({ success: true, data: { eventId, stale: true, packageId } });
        }
        await mirrorRef.set({ ...commerceMirror, createdAt: existingMirrorSnap.data()?.createdAt || timestamp }, { merge: true });
        const changedFields = classifyCustodyChanges(existingPackage, { deliveryAddress: address, codExpected, itemSummary });
        if (topic === "ORDERS_CANCELLED" && hasCustody) changedFields.push("STOP_DELIVERY");
        if (hasCustody && changedFields.length > 0) {
          await db.collection("exceptions").doc(`shopify_${eventId}`).set({ id: `shopify_${eventId}`, code: changedFields[0], codes: changedFields, topic, packageId, shopifyOrderId: commerceMirror.shopifyOrderId, status: "OPEN", resolutionStatus: "pending", severity: "HIGH", message: topic === "ORDERS_CANCELLED" ? "Shopify cancellation requires stop delivery and return to hub." : "Shopify changed commerce data after rider custody; operational package state was preserved.", createdAt: timestamp, updatedAt: timestamp }, { merge: true });
          if (topic === "ORDERS_CANCELLED") await packageRef.set({ stopDeliveryInstruction: true, returnInstruction: "RETURN_TO_HUB", operationalExceptionCode: "STOP_DELIVERY", updatedAt: timestamp }, { merge: true });
          if (changedFields.includes("PAYMENT_CHANGED_DURING_CUSTODY") && paymentStatus === "paid") await packageRef.set({ codExpected: 0, expectedCod: 0, cod_expected: 0, collectionInstruction: "DO_NOT_COLLECT_COD_ONLINE_PAID", updatedAt: timestamp }, { merge: true });
        } else if (!hasCustody && topic !== "ORDERS_CANCELLED") {
          await packageRef.set(applyShopifyCommerceUpdate(existingPackage, { customerName, customerPhone, deliveryAddress: address || "Address not provided", city, province, paymentType, paymentMethod, paymentStatus, codExpected, expectedCod: codExpected, cod_expected: codExpected, orderAmount: totalAmount, shopifyOrderId: commerceMirror.shopifyOrderId, shopifyUpdatedAt }), { merge: true });
        } else if (!hasCustody && topic === "ORDERS_CANCELLED") {
          await packageRef.set({ operationalStatus: "cancelled", current_status: "Cancelled", cancellationSource: "shopify", activeAssignmentId: null, assignedRiderId: null, updatedAt: timestamp }, { merge: true });
          const assignmentSnapshot = await db.collection("assignments").where("packageId", "==", packageId).where("active", "==", true).get();
          if (assignmentSnapshot.size > 0) {
            const assignmentBatch = db.batch();
            assignmentSnapshot.docs.forEach((assignment: any) => assignmentBatch.set(assignment.ref, { active: false, cancelledAt: timestamp, cancellationSource: "shopify" }, { merge: true }));
            await assignmentBatch.commit();
          }
        }
        await recordShopifySuccess(topic, shopifyUpdatedAt, timestamp);
        await inboxRef.set({ status: "PROCESSED", processedAt: timestamp, error: null }, { merge: true });
        return res.json({ success: true, data: { eventId, duplicate: false, updated: true, packageId, custodyProtected: hasCustody } });
      }

      const pkgDoc = {
        id: packageId,
        packageId,
        packageNumber,
        package_number: packageNumber,
        displayOrderNumber,
        externalOrderId: displayOrderNumber,
        normalizedOrderKey: cleanOrderNumber.toUpperCase(),
        parentOrderNumber,
        parent_order_number: parentOrderNumber,
        packageSequence: 1,
        customerName,
        customer_name: customerName,
        customerPhone,
        contact_number: customerPhone,
        primaryPhone: customerPhone,
        deliveryAddress: address || "Address not provided",
        address: address || "Address not provided",
        city,
        province,
        paymentType,
        paymentMethod,
        payment_method: paymentMethod,
        paymentStatus,
        orderAmount: totalAmount,
        order_amount: totalAmount,
        packageTotal: totalAmount,
        codExpected,
        expectedCod: codExpected,
        cod_expected: codExpected,
        expected_cod: codExpected,
        currency: "PKR",
        courierType: deliveryChannel,
        deliveryChannel,
        delivery_channel: deliveryChannel,
        importState: "committed",
        operationalStatus: readiness.ready ? "ready_for_dispatch" : "imported_review",
        current_status: readiness.ready ? "Ready for Dispatch" : "Imported",
        activeAssignmentId: null,
        assignedRiderId: null,
        itemSummary,
        totalQuantity: items.reduce((acc: number, item: any) => acc + item.quantity, 0),
        hasException: !readiness.ready,
        exceptionReason: readiness.reason,
        addressIncomplete: isMissingCity || isMissingAddress,
        source: "shopify",
        shopifyId: rawOrder.id,
        createdAt: timestamp,
        updatedAt: timestamp
      };

      if (topic === "ORDERS_CANCELLED") pkgDoc.operationalStatus = "cancelled";
      await packageRef.set(pkgDoc, { merge: true });
      await db.collection("orders").doc(packageId).set(pkgDoc, { merge: true });
      await db.collection("shopifyOrders").doc(String(rawOrder.id || rawOrder.order_number || rawOrder.name)).set({ ...commerceMirror, createdAt: timestamp }, { merge: true });
      await recordShopifySuccess(topic, shopifyUpdatedAt, timestamp);
      await inboxRef.set({ status: "PROCESSED", processedAt: timestamp, error: null }, { merge: true });

      return res.json({ success: true, data: { ...pkgDoc, eventId } });
    } catch (err: any) {
      const eventId = req.headers["x-shopify-webhook-id"];
      if (eventId) {
        const failedRef = db.collection("shopifyWebhookEvents").doc(String(eventId));
        const failedSnap = await failedRef.get();
        const retryCount = Number(failedSnap.data()?.retryCount || 0);
        await failedRef.set({ status: retryCount >= 5 ? "DEAD_LETTER" : "RETRY", errorCode: "ORDER_INGESTION_FAILED", errorMessage: err.message, lastAttemptAt: new Date().toISOString() }, { merge: true });
      }
      return res.status(500).json({ success: false, error: { code: "ORDER_INGESTION_FAILED", message: err.message } });
    }
  }

  async function runShopifyReconciliation() {
    const config = getShopifyConfig();
    if (!config.configured || !config.storeDomain || !config.accessToken) return { skipped: true, reason: "SHOPIFY_NOT_CONFIGURED" };
    const checkpointRef = db.collection("integrationCheckpoints").doc("shopify");
    const checkpoint = (await checkpointRef.get()).data() || {};
    const reconciliationStartedAt = new Date().toISOString();
    await checkpointRef.set({ lastReconciliationAt: reconciliationStartedAt }, { merge: true });
    const orders: any[] = [];
    let after: string | null = null;
    let pageCount = 0;
    do {
      const page: any = await fetchAndNormalizeShopifyOrders(config, { limit: 250, status: "any", fulfillmentStatus: "", updatedSince: checkpoint.lastShopifyUpdatedAtCheckpoint || checkpoint.updatedSince, after });
      orders.push(...page);
      after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      pageCount++;
    } while (after && pageCount < 100);
    const timestamp = new Date().toISOString();
    let missingLocal = 0;
    let mirrorsRepaired = 0;
    let custodyExceptions = 0;
    for (const order of orders) {
      const packageRef = db.collection("packages").doc(order.packageId);
      const packageSnap = await packageRef.get();
      const mirrorRef = db.collection("shopifyOrders").doc(String(order.shopifyId));
      await mirrorRef.set({ ...order, shopifyOrderId: String(order.shopifyId), updatedAt: timestamp, reconciliationAt: timestamp }, { merge: true });
      mirrorsRepaired++;
      if (!packageSnap.exists) {
        missingLocal++;
        const recoveryReadiness = evaluateShopifyReadiness({ phone: order.customerPhone, address: order.deliveryAddress === "Address not provided" ? "" : order.deliveryAddress, city: order.city, deliveryChannel: order.deliveryChannel, paymentType: order.paymentType, tags: order.tags });
        const recoveredPackage = {
          id: order.packageId, packageId: order.packageId, packageNumber: order.packageNumber, package_number: order.packageNumber,
          displayOrderNumber: order.displayOrderNumber, externalOrderId: order.externalOrderId, customerName: order.customerName,
          customerPhone: order.customerPhone, deliveryAddress: order.deliveryAddress, address: order.deliveryAddress, city: order.city,
          province: order.province, paymentType: order.paymentType, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus,
          orderAmount: order.orderAmount, codExpected: order.codExpected, expectedCod: order.codExpected, cod_expected: order.codExpected,
          currency: order.currency, courierType: order.courierType, deliveryChannel: order.deliveryChannel, itemSummary: order.itemSummary,
          totalQuantity: order.totalQuantity, hasException: !recoveryReadiness.ready, exceptionReason: recoveryReadiness.reason,
          addressIncomplete: !order.city || order.deliveryAddress === "Address not provided", source: "shopify", shopifyId: order.shopifyId,
          operationalStatus: recoveryReadiness.ready ? "ready_for_dispatch" : "imported_review", current_status: recoveryReadiness.ready ? "Ready for Dispatch" : "Imported",
          activeAssignmentId: null, assignedRiderId: null, importState: "committed", createdAt: timestamp, updatedAt: timestamp
        };
        await packageRef.set(recoveredPackage, { merge: true });
        await db.collection("orders").doc(order.packageId).set(recoveredPackage, { merge: true });
        if (!recoveryReadiness.ready) await db.collection("exceptions").doc(`shopify_recovery_${order.shopifyId}`).set({ id: `shopify_recovery_${order.shopifyId}`, code: recoveryReadiness.reason, shopifyOrderId: String(order.shopifyId), packageId: order.packageId, status: "OPEN", resolutionStatus: "pending", severity: "HIGH", message: "Recovered Shopify order requires readiness review.", createdAt: timestamp }, { merge: true });
        continue;
      }
      const pkg = packageSnap.data() || {};
      const status = String(pkg.operationalStatus || pkg.status || "").toLowerCase();
      const custody = hasRiderCustody(pkg);
      const paymentChanged = String(pkg.codExpected ?? pkg.expectedCod ?? "") !== String(order.codExpected);
      const addressChanged = String(pkg.deliveryAddress || pkg.address || "") !== String(order.deliveryAddress || "");
      if (custody && (paymentChanged || addressChanged)) {
        custodyExceptions++;
        await db.collection("exceptions").doc(`shopify_reconcile_${order.shopifyId}`).set({ id: `shopify_reconcile_${order.shopifyId}`, code: paymentChanged ? "PAYMENT_CHANGED_DURING_CUSTODY" : "ADDRESS_CHANGED_DURING_CUSTODY", shopifyOrderId: String(order.shopifyId), packageId: order.packageId, status: "OPEN", resolutionStatus: "pending", severity: "HIGH", message: "Periodic Shopify reconciliation found a commerce change after custody; package state was preserved.", createdAt: timestamp }, { merge: true });
      }
    }
    await checkpointRef.set({ updatedSince: timestamp, lastReconciliationAt: timestamp, lastSuccessfulReconciliationAt: timestamp, lastSuccessfulShopifyUpdatedAtCheckpoint: timestamp, lastShopifyUpdatedAtCheckpoint: timestamp, lastRunAt: timestamp, fetched: orders.length, pages: pageCount, missingLocal, mirrorsRepaired, custodyExceptions }, { merge: true });
    return { skipped: false, fetched: orders.length, pages: pageCount, missingLocal, mirrorsRepaired, custodyExceptions, lastRunAt: timestamp };
  }

  router.get("/webhooks/dead-letter", requireAuth, requireAnyRole("super_admin", "dispatch_manager"), async (_req: any, res: any) => {
    const snapshot = await db.collection("shopifyWebhookEvents").where("status", "==", "DEAD_LETTER").limit(100).get();
    return res.json({ success: true, data: snapshot.docs.map((doc: any) => doc.data()) });
  });

  router.post("/reconcile", requireAuth, requireAnyRole("super_admin"), async (_req: any, res: any) => {
    try {
      return res.json({ success: true, data: await runShopifyReconciliation() });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SHOPIFY_RECONCILIATION_FAILED", message: err.message } });
    }
  });

  const reconciliationIntervalMs = Math.max(15, Math.min(30, Number(process.env.SHOPIFY_RECONCILIATION_MINUTES || 30))) * 60 * 1000;
  const reconciliationTimer = setInterval(() => {
    runShopifyReconciliation().catch((error) => console.error("Shopify reconciliation job failed", error));
  }, reconciliationIntervalMs);
  reconciliationTimer.unref?.();
  const outboundTimer = setInterval(() => {
    processShopifyOutboundQueue().catch((error) => console.error("Shopify outbound queue failed", error));
  }, 60 * 1000);
  outboundTimer.unref?.();

  router.post("/webhooks/:eventId/replay", requireAuth, requireAnyRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    const eventRef = db.collection("shopifyWebhookEvents").doc(String(req.params.eventId));
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) return res.status(404).json({ success: false, error: { code: "WEBHOOK_EVENT_NOT_FOUND", message: "Shopify webhook event not found." } });
    const event = eventSnap.data() || {};
    await eventRef.set({ status: "RECEIVED", error: null, replayedAt: new Date().toISOString() }, { merge: true });
    return res.json({ success: true, data: { eventId: event.eventId, status: "RECEIVED", message: "Replay queued for the next webhook processing pass." } });
  });

  router.post("/order", handleShopifyOrder);
  router.post("/webhooks/:topic", (req: any, res: any) => {
    req.shopifyTopic = String(req.params.topic || "").toUpperCase().replace(/[.\/-]+/g, "_");
    return handleShopifyOrder(req, res);
  });

  return router;
}
