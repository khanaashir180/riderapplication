import { Router } from "express";
import crypto from "crypto";
import {
  sanitizePhone,
  cleanExcelFormulaString,
  buildPackageDocumentId,
  encodeDocId,
  classifyDeliveryChannel
} from "../services/csvImporter";

export interface ShopifyRouterOptions {
  db: any;
  requireAuth: any;
  requireRole: any;
  requireAnyRole: any;
}

export function createShopifyRouter({ db, requireAuth, requireAnyRole }: ShopifyRouterOptions): Router {
  const router = Router();

  function timingSafeSecretMatch(actualHeader: unknown, configuredSecret: string) {
    if (typeof actualHeader !== "string") return false;
    const presented = actualHeader.trim();
    if (!presented || !configuredSecret) return false;
    const presentedBuffer = Buffer.from(presented);
    const configuredBuffer = Buffer.from(configuredSecret);
    if (presentedBuffer.length !== configuredBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(presentedBuffer, configuredBuffer);
  }

  function getShopifyConfig() {
    const rawDomain = (process.env.SHOPIFY_STORE_DOMAIN || "").trim();
    const cleanDomain = rawDomain
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");
    const accessToken = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
    const apiVersion = (process.env.SHOPIFY_API_VERSION || "2024-04").trim();

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

  // Helper to fetch and normalize Shopify orders
  async function fetchAndNormalizeShopifyOrders(config: { storeDomain: string; accessToken: string; apiVersion: string }, options: { limit?: number; status?: string; fulfillmentStatus?: string } = {}) {
    const limit = Math.min(Math.max(Number(options.limit || 50), 1), 250);
    const status = options.status || "open";
    const fulfillmentStatus = options.fulfillmentStatus !== undefined ? options.fulfillmentStatus : "unfulfilled";

    let url = `https://${config.storeDomain}/admin/api/${config.apiVersion}/orders.json?status=${status}&limit=${limit}`;
    if (fulfillmentStatus) {
      url += `&fulfillment_status=${fulfillmentStatus}`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": config.accessToken
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Shopify API error (HTTP ${response.status}): ${errorText}`);
    }

    const json = await response.json();
    const rawOrders: any[] = Array.isArray(json.orders) ? json.orders : [];

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

      const totalAmount = Math.round(Number(ord.total_price || 0));
      const financialStatus = ord.financial_status || "pending";
      const isPrepaid = financialStatus === "paid";

      let codExpected = 0;
      let paymentMethod = "cod";
      let paymentStatus = "unpaid";

      if (isPrepaid) {
        paymentMethod = "paid";
        paymentStatus = "paid";
        codExpected = 0;
      } else {
        paymentMethod = "cod";
        paymentStatus = "unpaid";
        codExpected = Math.round(Number(ord.total_outstanding || ord.current_total_price || ord.total_price || 0));
      }

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
        paymentMethod,
        paymentStatus,
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
        tags: ord.tags || "",
        hasException,
        exceptionReason,
        addressIncomplete: hasException
      };
    });

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

  // 5. POST /api/shopify/order - Direct webhook / single order ingestion (SECURE)
  router.post("/order", async (req: any, res: any) => {
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
        const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));
        const expectedHmac = crypto.createHmac("sha256", configuredShopifyWebhookSecret).update(rawBody).digest("base64");
        if (!timingSafeSecretMatch(shopifyHmacHeader, expectedHmac)) {
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
        if (!timingSafeSecretMatch(makeSecretHeader, configuredMakeSecret)) {
          return res.status(401).json({
            success: false,
            error: {
              code: "UNAUTHORIZED_INTEGRATION_REQUEST",
              message: "Missing or invalid Gomila integration secret. Webhook rejected."
            }
          });
        }
      }

      const rawOrder = req.body?.order || req.body;
      if (!rawOrder || (!rawOrder.id && !rawOrder.order_number && !rawOrder.name)) {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_ORDER_PAYLOAD", message: "Missing valid Shopify order payload" }
        });
      }

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

      const totalAmount = Math.round(Number(rawOrder.total_price || 0));
      const financialStatus = (rawOrder.financial_status || "").toLowerCase().trim();
      const rawPaymentGateway = (rawOrder.payment_gateway_names?.[0] || rawOrder.gateway || "").toLowerCase().trim();

      // Canonical Payment Normalization (Gate 16)
      const isPaidStatus = financialStatus === "paid";
      const isPartiallyPaid = financialStatus === "partially_paid";
      const isPrepaidGateway = rawPaymentGateway.includes("card") || rawPaymentGateway.includes("prepaid") || rawPaymentGateway.includes("bank") || rawPaymentGateway.includes("stripe");

      let paymentType: "COD" | "PREPAID" | "PARTIALLY_PAID" = "COD";
      let paymentMethod = "COD";
      let paymentStatus = "unpaid";
      let codExpected = 0;

      if (isPaidStatus || (!financialStatus && isPrepaidGateway)) {
        paymentType = "PREPAID";
        paymentMethod = "PREPAID";
        paymentStatus = "paid";
        codExpected = 0;
      } else if (isPartiallyPaid) {
        paymentType = "PARTIALLY_PAID";
        paymentMethod = "COD";
        paymentStatus = "partially_paid";
        codExpected = Math.round(Number(rawOrder.total_outstanding || 0));
      } else {
        paymentType = "COD";
        paymentMethod = "COD";
        paymentStatus = "unpaid";
        codExpected = Math.round(Number(rawOrder.total_outstanding || rawOrder.current_total_price || rawOrder.total_price || 0));
      }

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
        operationalStatus: "imported_review",
        current_status: "Imported",
        activeAssignmentId: null,
        assignedRiderId: null,
        itemSummary,
        totalQuantity: items.reduce((acc: number, item: any) => acc + item.quantity, 0),
        hasException: isMissingCity || isMissingAddress,
        exceptionReason: isMissingCity ? "ADDRESS_REVIEW_REQUIRED (Missing City)" : (isMissingAddress ? "ADDRESS_REVIEW_REQUIRED (Incomplete Address)" : null),
        addressIncomplete: isMissingCity || isMissingAddress,
        source: "shopify",
        shopifyId: rawOrder.id,
        createdAt: timestamp,
        updatedAt: timestamp
      };

      await db.collection("packages").doc(packageId).set(pkgDoc, { merge: true });
      await db.collection("orders").doc(packageId).set(pkgDoc, { merge: true });

      return res.json({ success: true, data: pkgDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "ORDER_INGESTION_FAILED", message: err.message } });
    }
  });

  return router;
}
