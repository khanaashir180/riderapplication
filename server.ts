import express from "express";
import path from "path";
import fs from "fs";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { processOMSImportRows, calculateSHA256, buildPackageDocumentId } from "./src/services/csvImporter.js";
import { createLogisticsRouter } from "./src/server/logisticsRouter.js";
import { createAdminUserRouter, AdminUserTestHooks } from "./src/server/adminUserRouter.js";
import { createShopifyRouter } from "./src/server/shopifyRouter.js";

const PORT = 3000;

// Load Firebase Config
let firebaseConfig: any = {};
try {
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
} catch (e) {
  console.error("Failed loading firebase-applet-config.json", e);
}

// Initialize Firebase Admin SDK
if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId || "gen-lang-client-0398272509"
  });
}

const adminAuth = getAuth();

// Get Firestore DB instance using default database
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

// Central Authentication Middleware
const VALID_ROLES = [
  "super_admin",
  "dispatch_manager",
  "rider",
  "cashier",
  "customer_service",
  "warehouse_staff",
  "management_viewer"
];

async function requireAuth(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHENTICATED", message: "Missing or invalid authorization token" }
    });
  }

  const token = authHeader.replace("Bearer ", "").trim();
  try {
    const decodedToken = await adminAuth.verifyIdToken(token, true);
    const profileSnap = await db.collection("profiles").doc(decodedToken.uid).get();

    if (!profileSnap.exists) {
      return res.status(403).json({
        success: false,
        error: { code: "PROFILE_NOT_FOUND", message: "Your employee profile is not active. Contact an administrator." }
      });
    }

    const profile = profileSnap.data();
    if (!profile || profile.active === false) {
      return res.status(403).json({
        success: false,
        error: { code: "PROFILE_INACTIVE", message: "Your employee profile is not active. Contact an administrator." }
      });
    }

    if (!profile.role || !VALID_ROLES.includes(profile.role)) {
      return res.status(403).json({
        success: false,
        error: { code: "INVALID_ROLE", message: "Unknown or unauthorized role." }
      });
    }

    let riderId: string | null = null;
    if (profile.role === 'rider') {
      if (!profile.riderId) {
        return res.status(403).json({
          success: false,
          error: { code: "RIDER_PROFILE_NOT_LINKED", message: "No rider profile is linked to this account. Contact an administrator." }
        });
      }
      const riderSnap = await db.collection("riders").doc(profile.riderId).get();
      if (!riderSnap.exists) {
        return res.status(403).json({
          success: false,
          error: { code: "RIDER_PROFILE_NOT_LINKED", message: "No rider profile is linked to this account. Contact an administrator." }
        });
      }
      const riderData = riderSnap.data();
      if (
        typeof riderData?.profileId !== "string" ||
        riderData.profileId !== decodedToken.uid
      ) {
        return res.status(403).json({
          success: false,
          error: {
            code: "RIDER_PROFILE_NOT_LINKED",
            message:
              "No rider profile is linked to this account. Contact an administrator."
          }
        });
      }
      if (riderData?.active === false) {
        return res.status(403).json({
          success: false,
          error: { code: "RIDER_INACTIVE", message: "Rider account is inactive." }
        });
      }
      riderId = profile.riderId;
    }

    req.auth = {
      uid: decodedToken.uid,
      email: decodedToken.email || profile.email,
      role: profile.role,
      profileId: profile.id || decodedToken.uid,
      riderId: riderId
    };

    next();
  } catch (err: any) {
    return res.status(401).json({
      success: false,
      error: { code: "TOKEN_EXPIRED_OR_INVALID", message: "Authentication session expired or invalid" }
    });
  }
}

(requireAuth as any).securityMetadata = {
  type: "auth"
};

function requireRole(...roles: string[]) {
  const middleware = (req: any, res: any, next: any) => {
    if (!req.auth || (!roles.includes(req.auth.role) && req.auth.role !== 'super_admin')) {
      return res.status(403).json({
        success: false,
        error: { code: "FORBIDDEN", message: "Insufficient permissions for this operation." }
      });
    }
    next();
  };
  (middleware as any).securityMetadata = {
    type: "role",
    roles,
    superAdminBypass: true
  };
  return middleware;
}

function requireExactRole(...roles: string[]) {
  const middleware = (req: any, res: any, next: any) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({
        success: false,
        error: { code: "FORBIDDEN", message: "Insufficient permissions for this operation." }
      });
    }
    next();
  };
  (middleware as any).securityMetadata = {
    type: "exactRole",
    roles,
    superAdminBypass: false
  };
  return middleware;
}

function requireActiveProfile(req: any, res: any, next: any) {
  if (!req.auth || !req.auth.profileId) {
    return res.status(403).json({
      success: false,
      error: { code: "PROFILE_REQUIRED", message: "Your employee profile is not active. Contact an administrator." }
    });
  }
  next();
}

function requireAnyRole(...roles: string[]) {
  const middleware = (req: any, res: any, next: any) => {
    if (!req.auth || (!roles.includes(req.auth.role) && req.auth.role !== 'super_admin')) {
      return res.status(403).json({
        success: false,
        error: { code: "FORBIDDEN", message: "Insufficient permissions for this operation." }
      });
    }
    next();
  };
  (middleware as any).securityMetadata = {
    type: "role",
    roles,
    superAdminBypass: true
  };
  return middleware;
}

async function requirePackageOwnership(req: any, res: any, next: any) {
  if (req.auth.role === 'super_admin' || req.auth.role === 'dispatch_manager') return next();
  const packageId = req.params.packageId || req.params.id || req.body.packageId;
  if (req.auth.role === 'rider') {
    if (!packageId) {
      return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId" } });
    }
    const pkgSnap = await db.collection("packages").doc(packageId).get();
    if (!pkgSnap.exists) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Package not found" } });
    }
    const pkg = pkgSnap.data();
    if (pkg.assignedRiderId !== req.auth.riderId) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Package is not assigned to you." } });
    }
  }
  next();
}

async function seedFinancialAccounts(db: any) {
  const accounts = [
    { code: "CUSTOMER_COD_RECEIVABLE", name: "Customer COD Receivable", accountType: "clearing" },
    { code: "RIDER_CASH_WALLET", name: "Rider Cash Wallet", accountType: "asset" },
    { code: "CASHIER_CASH_CONTROL", name: "Cashier Cash Control", accountType: "asset" },
    { code: "BANK_CLEARING", name: "Bank Clearing", accountType: "clearing" },
    { code: "BANK_ACCOUNT", name: "Bank Account", accountType: "asset" },
    { code: "JAZZCASH_CLEARING", name: "JazzCash Clearing", accountType: "clearing" },
    { code: "EASYPAISA_CLEARING", name: "Easypaisa Clearing", accountType: "clearing" },
    { code: "BANK_TRANSFER_CLEARING", name: "Bank Transfer Clearing", accountType: "clearing" },
    { code: "EXTERNAL_COURIER_RECEIVABLE", name: "External Courier Receivable", accountType: "asset" },
    { code: "COD_DISCREPANCY", name: "COD Discrepancy", accountType: "expense" },
    { code: "APPROVED_WRITE_OFF", name: "Approved Write-Off", accountType: "expense" }
  ];

  const nowStr = new Date().toISOString();
  for (const acc of accounts) {
    const ref = db.collection("financialAccounts").doc(acc.code);
    const doc = await ref.get();
    if (!doc.exists) {
      await ref.set({
        ...acc,
        active: true,
        createdAt: nowStr,
        updatedAt: nowStr
      });
    }
  }
}

async function createDoubleEntryTransaction(db: any, params: {
  transactionType: string;
  sourceType: string;
  sourceId: string;
  packageId?: string | null;
  riderId?: string | null;
  cashierProfileId?: string | null;
  settlementId?: string | null;
  bankDepositId?: string | null;
  idempotencyKey: string;
  createdByUid: string;
  postings: Array<{
    accountCode: string;
    debitAmount: number;
    creditAmount: number;
    packageId?: string | null;
    riderId?: string | null;
    settlementId?: string | null;
    bankDepositId?: string | null;
  }>;
}) {
  if (!params.idempotencyKey || typeof params.idempotencyKey !== "string") {
    throw { status: 400, code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency key is required" };
  }

  const idemRef = db.collection("idempotencyKeys").doc(params.idempotencyKey);
  const idemDoc = await idemRef.get();
  if (idemDoc.exists) {
    throw { status: 409, code: "DUPLICATE_IDEMPOTENCY_KEY", message: `Duplicate idempotency key "${params.idempotencyKey}" rejected` };
  }

  if (!params.postings || !Array.isArray(params.postings) || params.postings.length === 0) {
    throw { status: 400, code: "INVALID_POSTINGS", message: "Transaction must contain at least one posting line" };
  }

  let totalDebit = 0;
  let totalCredit = 0;

  const validAccountCodes = [
    "CUSTOMER_COD_RECEIVABLE",
    "RIDER_CASH_WALLET",
    "CASHIER_CASH_CONTROL",
    "BANK_CLEARING",
    "BANK_ACCOUNT",
    "JAZZCASH_CLEARING",
    "EASYPAISA_CLEARING",
    "BANK_TRANSFER_CLEARING",
    "EXTERNAL_COURIER_RECEIVABLE",
    "COD_DISCREPANCY",
    "APPROVED_WRITE_OFF"
  ];

  for (const p of params.postings) {
    if (typeof p.debitAmount !== "number" || typeof p.creditAmount !== "number") {
      throw { status: 400, code: "INVALID_POSTING_AMOUNT", message: "Posting debitAmount and creditAmount must be numbers" };
    }
    if (p.debitAmount < 0 || p.creditAmount < 0) {
      throw { status: 400, code: "NEGATIVE_POSTING_REJECTED", message: "Negative debit or credit amounts rejected" };
    }
    if (p.debitAmount > 0 && p.creditAmount > 0) {
      throw { status: 400, code: "DUAL_POSTING_REJECTED", message: "Both debit and credit populated on one posting line rejected" };
    }
    if (p.debitAmount === 0 && p.creditAmount === 0) {
      throw { status: 400, code: "ZERO_POSTING_REJECTED", message: "Posting with zero debit and credit rejected" };
    }

    if (!validAccountCodes.includes(p.accountCode)) {
      throw { status: 400, code: "MISSING_OR_INACTIVE_ACCOUNT", message: `Account code "${p.accountCode}" is missing or inactive` };
    }

    totalDebit += p.debitAmount;
    totalCredit += p.creditAmount;
  }

  if (Math.abs(totalDebit - totalCredit) > 0.0001) {
    throw { status: 400, code: "UNBALANCED_TRANSACTION", message: `Unbalanced transaction rejected: Total debit (${totalDebit}) does not equal total credit (${totalCredit})` };
  }

  const txId = `tx_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const nowStr = new Date().toISOString();

  await db.runTransaction(async (t: any) => {
    t.set(idemRef, {
      key: params.idempotencyKey,
      action: params.transactionType,
      createdAt: nowStr
    });

    const txRef = db.collection("financialTransactions").doc(txId);
    t.set(txRef, {
      id: txId,
      transactionType: params.transactionType,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      packageId: params.packageId || null,
      riderId: params.riderId || null,
      cashierProfileId: params.cashierProfileId || null,
      settlementId: params.settlementId || null,
      bankDepositId: params.bankDepositId || null,
      status: "posted",
      currency: "PKR",
      totalDebit,
      totalCredit,
      idempotencyKey: params.idempotencyKey,
      createdByUid: params.createdByUid,
      createdAt: nowStr,
      reversedTransactionId: null,
      reversedByUid: null,
      reversedAt: null,
      reversalReason: null
    });

    for (const p of params.postings) {
      const pRef = db.collection("financialPostings").doc();
      t.set(pRef, {
        id: pRef.id,
        transactionId: txId,
        accountCode: p.accountCode,
        debitAmount: p.debitAmount,
        creditAmount: p.creditAmount,
        packageId: p.packageId || params.packageId || null,
        riderId: p.riderId || params.riderId || null,
        settlementId: p.settlementId || params.settlementId || null,
        bankDepositId: p.bankDepositId || params.bankDepositId || null,
        createdAt: nowStr
      });
    }
  });

  return { transactionId: txId, totalDebit, totalCredit };
}


export function createApp(adminUserTestHooks?: AdminUserTestHooks) {
  const app = express();

  // Baseline Security Headers
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      frameguard: false
    })
  );

  // Large payload parsers specifically for CSV / Batch Import routes
  const largeJsonParser = express.json({ limit: "50mb" });
  const largeUrlencodedParser = express.urlencoded({ extended: true, limit: "50mb" });
  app.use(
    ["/api/import", "/api/import-batches", "/api/logistics/import"],
    largeJsonParser,
    largeUrlencodedParser
  );

  // Default global body limits (2mb)
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));

  // Security Rate Limiters
  const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many authentication requests. Please try again later." }
    }
  });

  const financeRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many finance requests. Please try again later." }
    }
  });

  const deliveryRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many delivery requests. Please try again later." }
    }
  });

  app.use("/api/auth/me", authRateLimiter);
  app.use("/api/finance", financeRateLimiter);
  app.use("/api/delivery", deliveryRateLimiter);

  // Public Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // --- AUTHENTICATED USER IDENTITY ---
  app.get("/api/auth/me", requireAuth, async (req: any, res: any) => {
    try {
      const profileSnap = await db.collection("profiles").doc(req.auth.uid).get();
      if (!profileSnap.exists) {
        return res.status(403).json({
          success: false,
          error: { code: "NO_PROFILE", message: "Your employee profile is not active. Contact an administrator." }
        });
      }

      const profileData = profileSnap.data();
      let riderData = null;
      if (req.auth.riderId) {
        const riderSnap = await db.collection("riders").doc(req.auth.riderId).get();
        if (riderSnap.exists) riderData = riderSnap.data();
      }

      return res.json({
        success: true,
        data: {
          profile: profileData,
          rider: riderData
        }
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: { code: "SERVER_ERROR", message: err.message }
      });
    }
  });

  // --- PROFILES ---
  app.get("/api/profiles", requireAuth, requireRole("super_admin"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("profiles").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.post("/api/profiles", requireAuth, requireRole("super_admin"), async (req: any, res: any) => {
    try {
      const uid = req.body.authUserId || req.body.id || `prof-${Date.now()}`;
      const targetRole = req.body.role || "rider";
      
      const newProf = {
        id: uid,
        authUserId: uid,
        fullName: req.body.fullName || req.body.full_name,
        full_name: req.body.fullName || req.body.full_name,
        phone: req.body.phone,
        email: req.body.email,
        employeeCode: req.body.employeeCode || req.body.employee_code,
        employee_code: req.body.employeeCode || req.body.employee_code,
        role: targetRole,
        active: req.body.active !== undefined ? req.body.active : true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString()
      };

      await db.collection("profiles").doc(uid).set(newProf, { merge: true });
      return res.json({ success: true, data: newProf });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- RIDERS ---
  function normalizePackageRecord(pkg: any) {
    const pkgNum = pkg.packageNumber || pkg.package_number || pkg.id || "";
    const orderNum = pkg.parentOrderNumber || pkg.parent_order_number || pkg.original_order_number || pkg.order_number || pkgNum;
    const custName = pkg.customerName || pkg.customer_name || pkg.recipient_name || "Valued Customer";
    const phone = pkg.primaryPhone || pkg.contact_number || pkg.phone || "";
    const addr = pkg.shippingAddress || pkg.delivery_address || pkg.address || "";
    const city = pkg.city || "Lahore";
    const zone = pkg.zone || pkg.assignedZone || "";
    const payment = pkg.paymentMethod || pkg.payment_method || "COD";
    const cod = Number(pkg.expectedCod !== undefined ? pkg.expectedCod : (pkg.cod_expected !== undefined ? pkg.cod_expected : (pkg.totalAmount || 0)));
    const status = pkg.current_status || pkg.operationalStatus || "Assigned";
    const channel = pkg.deliveryChannel || pkg.delivery_channel || "Internal Rider";

    return {
      ...pkg,
      id: pkg.id,
      packageNumber: pkgNum,
      package_number: pkgNum,
      original_order_number: orderNum,
      parentOrderNumber: orderNum,
      parent_order_number: orderNum,
      order_number: orderNum,
      customerName: custName,
      customer_name: custName,
      recipient_name: custName,
      contact_number: phone,
      primaryPhone: phone,
      phone: phone,
      address: addr,
      delivery_address: addr,
      shippingAddress: addr,
      city: city,
      zone: zone,
      assignedZone: zone,
      paymentMethod: payment,
      payment_method: payment,
      expectedCod: cod,
      cod_expected: cod,
      total_amount: cod,
      current_status: status,
      operationalStatus: (pkg.operationalStatus || status).toLowerCase().replace(/[\s_]+/g, "_"),
      deliveryChannel: channel,
      delivery_channel: channel,
      custodyStage: pkg.custodyStage || pkg.custody_stage || "assigned_to_rider",
      customer_notes: pkg.customerNotes || pkg.customer_notes || pkg.specialInstructions || ""
    };
  }

  app.get("/api/riders/me", requireAuth, async (req: any, res: any) => {
    try {
      if (!req.auth.riderId) {
        return res.status(404).json({ success: false, error: { code: "RIDER_NOT_FOUND", message: "No rider record linked to profile." } });
      }
      const doc = await db.collection("riders").doc(req.auth.riderId).get();
      if (!doc.exists) {
        return res.status(404).json({ success: false, error: { code: "RIDER_NOT_FOUND", message: "Rider record not found." } });
      }
      return res.json({ success: true, data: doc.data() });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Dedicated Authenticated Rider Orders Route (Fixes Rider Route bug)
  const handleRiderOrdersRoute = async (req: any, res: any) => {
    try {
      let targetRiderId = req.auth.riderId;

      // If user is a manager or super admin debugging a rider, allow query parameter
      if (!targetRiderId && ['super_admin', 'dispatch_manager'].includes(req.auth.role) && req.query.riderId) {
        targetRiderId = req.query.riderId;
      }

      if (!targetRiderId) {
        return res.status(404).json({
          success: false,
          error: { code: "RIDER_NOT_FOUND", message: "No rider record linked to your authenticated session." }
        });
      }

      // Query packages assigned to this authenticated rider
      const snap = await db.collection("packages")
        .where("assignedRiderId", "==", targetRiderId)
        .get();

      const normalizedOrders = snap.docs.map(d => normalizePackageRecord(d.data()));

      // Prioritize active route packages first
      const statusPriority: Record<string, number> = {
        "out for delivery": 1,
        "assigned": 2,
        "picked up": 3,
        "rescheduled": 4,
        "customer unavailable": 5,
        "incorrect address": 6,
        "refused": 7,
        "returning to warehouse": 8,
        "delivered": 9,
        "returned": 10
      };

      normalizedOrders.sort((a, b) => {
        const pA = statusPriority[(a.current_status || "").toLowerCase()] || 99;
        const pB = statusPriority[(b.current_status || "").toLowerCase()] || 99;
        return pA - pB;
      });

      return res.json({
        success: true,
        orders: normalizedOrders,
        data: {
          orders: normalizedOrders,
          total: normalizedOrders.length,
          activeCount: normalizedOrders.filter(o => ['Assigned', 'Picked Up', 'Out for Delivery'].includes(o.current_status)).length,
          deliveredCount: normalizedOrders.filter(o => o.current_status === 'Delivered').length
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  };

  app.get("/api/riders/me/orders", requireAuth, handleRiderOrdersRoute);
  app.get("/api/rider/route", requireAuth, handleRiderOrdersRoute);

  app.get("/api/riders", requireAuth, async (req: any, res: any) => {
    try {
      if (req.auth.role === 'rider') {
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Riders must use /api/riders/me" } });
      }

      if (!['super_admin', 'dispatch_manager', 'management_viewer', 'cashier'].includes(req.auth.role)) {
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Insufficient permissions to list riders." } });
      }

      const snap = await db.collection("riders").get();
      let list = snap.docs.map(d => d.data());

      if (req.auth.role === 'cashier') {
        list = list.map((r: any) => ({
          id: r.id,
          profileId: r.profileId,
          fullName: r.fullName || r.full_name,
          phone: r.phone,
          vehicleType: r.vehicleType,
          active: r.active,
          city: r.city,
          assignedZone: r.assignedZone
        }));
      }

      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.post("/api/riders", requireAuth, requireRole("super_admin"), async (req: any, res: any) => {
    try {
      const id = req.body.id || `rider-${Date.now()}`;
      const riderData = {
        id,
        profileId: req.body.profileId || `prof-${Date.now()}`,
        fullName: req.body.fullName || req.body.full_name,
        full_name: req.body.fullName || req.body.full_name,
        phone: req.body.phone,
        email: req.body.email,
        vehicleType: req.body.vehicleType || "Motorbike",
        vehicleNumber: req.body.vehicleNumber || "",
        assignedZone: req.body.assignedZone || "Gulberg",
        city: req.body.city || "Lahore",
        active: req.body.active !== undefined ? req.body.active : true,
        createdAt: new Date().toISOString()
      };
      await db.collection("riders").doc(id).set(riderData, { merge: true });
      return res.json({ success: true, data: { rider: riderData } });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- ORDERS / PACKAGES ---
  app.get("/api/orders", requireAuth, async (req: any, res: any) => {
    try {
      if (!['super_admin', 'dispatch_manager', 'customer_service', 'warehouse_staff', 'management_viewer'].includes(req.auth.role)) {
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Insufficient permissions to access order directory." } });
      }

      const page = parseInt(req.query.page as string || "1", 10);
      const limit = parseInt(req.query.limit as string || "50", 10);
      const search = (req.query.search as string || "").toLowerCase().trim();
      const statusFilter = req.query.status as string;
      const cityFilter = req.query.city as string;
      let riderIdFilter = req.query.rider_id as string;
      const importBatchFilter = req.query.import_batch_id as string;

      const snap = await db.collection("packages").where("importState", "==", "committed").get();
      let orders = snap.docs.map(d => d.data());

      if (search) {
        orders = orders.filter((o: any) =>
          (o.package_number || o.packageNumber || "").toLowerCase().includes(search) ||
          (o.parent_order_number || o.parentOrderNumber || "").toLowerCase().includes(search) ||
          (o.customer_name || o.customerName || "").toLowerCase().includes(search) ||
          (o.contact_number || o.primaryPhone || "").includes(search) ||
          (o.city || "").toLowerCase().includes(search)
        );
      }

      if (statusFilter) {
        orders = orders.filter((o: any) =>
          o.current_status === statusFilter || o.operationalStatus === statusFilter
        );
      }

      if (cityFilter) {
        orders = orders.filter((o: any) => o.city === cityFilter);
      }

      if (riderIdFilter) {
        orders = orders.filter((o: any) =>
          o.assignedRiderId === riderIdFilter
        );
      }

      if (importBatchFilter) {
        orders = orders.filter((o: any) =>
          o.import_batch_id === importBatchFilter || o.importBatchId === importBatchFilter
        );
      }

      const total = orders.length;
      const startIndex = (page - 1) * limit;
      const paginatedOrders = orders.slice(startIndex, startIndex + limit);
      const totalPages = Math.ceil(total / limit) || 1;

      return res.json({
        success: true,
        data: {
          orders: paginatedOrders,
          pagination: {
            total,
            page,
            limit,
            totalPages
          }
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/orders/:id", requireAuth, async (req: any, res: any) => {
    try {
      if (!['super_admin', 'dispatch_manager', 'customer_service', 'warehouse_staff', 'management_viewer'].includes(req.auth.role)) {
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Insufficient permissions to view order details." } });
      }

      const doc = await db.collection("packages").doc(req.params.id).get();
      if (!doc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Package not found" } });
      }
      const data = doc.data();
      if (data?.importState !== "committed") {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Package is not committed yet" } });
      }
      return res.json({ success: true, data });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- OMS CSV PARSER & IMPORT ---
  const handleCsvValidation = async (req: any, res: any) => {
    const { csvContent, csv_data, rows: bodyRows, fileName, file_name } = req.body;
    let rows: any[] = bodyRows || csv_data;

    if (!rows && csvContent && typeof csvContent === 'string') {
      const lines = csvContent.split(/\r?\n/).filter(line => line.trim() !== '');
      if (lines.length > 1) {
        const headers = lines[0].split(',').map(h => h.trim().replace(/^"+|"+$/g, ''));
        rows = lines.slice(1).map(line => {
          const vals = line.split(',').map(v => v.trim().replace(/^"+|"+$/g, ''));
          const rowObj: any = {};
          headers.forEach((h, idx) => {
            rowObj[h] = vals[idx] !== undefined ? vals[idx] : '';
          });
          return rowObj;
        });
      }
    }

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_CSV", message: "No CSV content or rows provided for validation" }
      });
    }

    const nameToUse = fileName || file_name || "OMS_Import.csv";
    const fileContentStr = JSON.stringify(rows);
    const fileChecksum = calculateSHA256(fileContentStr);

    try {
      const existingSnap = await db.collection("importBatches")
        .where("fileChecksum", "==", fileChecksum)
        .limit(1)
        .get();

      if (!existingSnap.empty) {
        const existingBatch = existingSnap.docs[0].data();
        return res.status(409).json({
          success: false,
          error: {
            code: "DUPLICATE_IMPORT",
            message: `Duplicate file upload detected. File hash already imported under batch ${existingBatch.fileName}`
          }
        });
      }

      const batchId = `imp-${Date.now()}`;
      const batchRef = db.collection("importBatches").doc(batchId);

      // Step 1: Set uploaded
      await batchRef.set({
        id: batchId,
        batchId,
        fileName: nameToUse,
        file_name: nameToUse,
        fileChecksum,
        file_checksum: fileChecksum,
        uploadedByUid: req.auth.uid,
        status: "uploaded",
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      });

      // Step 2: Set validating
      await batchRef.update({ status: "validating" });

      // Run parser
      const result = processOMSImportRows(rows, batchId);

      // Write staging subcollections in batches <= 450
      const operations: Array<{ ref: any; data: any }> = [];

      // Staged Packages
      result.packages.forEach((pkg) => {
        const pkgRef = batchRef.collection("stagedPackages").doc(pkg.packageId);
        operations.push({ ref: pkgRef, data: pkg });
      });

      // Staged Items
      result.packages.forEach((pkg) => {
        pkg.items.forEach((item) => {
          const itemRef = batchRef.collection("stagedItems").doc(item.itemId);
          operations.push({ ref: itemRef, data: item });
        });
      });

      // Staged Parents
      result.parentGroups.forEach((parent) => {
        const encParentNum = encodeURIComponent(parent.parentOrderNumber).replace(/\./g, '%2E');
        const parentRef = batchRef.collection("stagedParents").doc(encParentNum);
        operations.push({ ref: parentRef, data: parent });
      });

      // Staged COD Reviews
      result.validationData.activeCodReviews.forEach((rev) => {
        const encParentNum = encodeURIComponent(rev.parentOrderNumber).replace(/\./g, '%2E');
        const revRef = batchRef.collection("stagedCodReviews").doc(encParentNum);
        operations.push({ ref: revRef, data: rev });
      });

      // Staged Errors & Warnings
      result.errors.forEach((err) => {
        const errRef = batchRef.collection("errors").doc(err.id);
        operations.push({ ref: errRef, data: err });
      });

      result.warnings.forEach((warn) => {
        const warnRef = batchRef.collection("warnings").doc(warn.id);
        operations.push({ ref: warnRef, data: warn });
      });

      const CHUNK_SIZE = 450;
      for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
        const chunk = operations.slice(i, i + CHUNK_SIZE);
        const writeBatch = db.batch();
        for (const op of chunk) {
          writeBatch.set(op.ref, op.data, { merge: true });
        }
        await writeBatch.commit();
      }

      // Step 3: Set validated summary document (below 100KB, NO raw arrays)
      const summaryData = {
        id: batchId,
        batchId,
        fileName: nameToUse,
        file_name: nameToUse,
        fileChecksum,
        file_checksum: fileChecksum,
        uploadedByUid: req.auth.uid,
        status: "validated",
        sourceRowCount: result.validationData.sourceRowCount,
        uniquePackageCount: result.validationData.uniquePackageCount,
        packageItemCount: result.validationData.packageItemCount,
        validPackageCount: result.validationData.validPackageCount,
        warningPackageCount: result.validationData.warningPackageCount,
        blockedPackageCount: result.validationData.blockedPackageCount,
        statusCounts: result.validationData.statusCounts,
        deliveryChannelCounts: result.validationData.deliveryChannelCounts,
        warningCount: result.validationData.warningCount,
        errorCount: result.validationData.errorCount,
        validatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await batchRef.set(summaryData, { merge: true });

      return res.json({
        success: true,
        data: result.validationData
      });
    } catch (err: any) {
      if (req.body.batchId) {
        await db.collection("importBatches").doc(req.body.batchId).update({
          status: "failed",
          failureReason: err.message
        }).catch(() => {});
      }
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  };

  app.post("/api/import/validate", requireAuth, requireRole("super_admin", "dispatch_manager"), handleCsvValidation);
  app.post("/api/import-batches/validate", requireAuth, requireRole("super_admin", "dispatch_manager"), handleCsvValidation);

  // Chunked Resumable Firestore Commit
  const handleCsvCommit = async (req: any, res: any) => {
    const { batchId } = req.body;
    if (!batchId) {
      return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing batchId" } });
    }

    try {
      const batchRef = db.collection("importBatches").doc(batchId);
      const batchSnap = await batchRef.get();

      if (!batchSnap.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Import batch record not found" } });
      }

      await batchRef.update({ status: "committing", startedAt: new Date().toISOString() });

      // Read staged records from subcollections
      const packagesSnap = await batchRef.collection("stagedPackages").get();
      const itemsSnap = await batchRef.collection("stagedItems").get();
      const parentsSnap = await batchRef.collection("stagedParents").get();
      const reviewsSnap = await batchRef.collection("stagedCodReviews").get();

      const stagedPackages = packagesSnap.docs.map(d => d.data());
      const stagedItems = itemsSnap.docs.map(d => d.data());
      const stagedParents = parentsSnap.docs.map(d => d.data());
      const stagedReviews = reviewsSnap.docs.map(d => d.data());

      const operations: Array<{ ref: any; data: any }> = [];

      // Build set of valid staged package IDs
      const stagedPackageIds = new Set(
        stagedPackages.map((pkg: any) => pkg.packageId)
      );

      // Production Packages
      stagedPackages.forEach((p: any) => {
        if (
          typeof p.packageId !== "string" ||
          p.packageId !== buildPackageDocumentId(p.packageNumber)
        ) {
          throw new Error(
            `Invalid staged package ID for package ${p.packageNumber}`
          );
        }

        const pkgDocId = p.packageId;
        const pkgRef = db.collection("packages").doc(pkgDocId);

        const encParentNum = encodeURIComponent(p.parentOrderNumber).replace(/\./g, '%2E');
        const parentOrderId = `parent_${encParentNum}`;
        const customerId = `cust_${encodeURIComponent(p.customerName).replace(/\./g, '%2E')}`;
        const deliveryAddressId = `addr_${encodeURIComponent((p.address || '') + '_' + (p.city || '')).replace(/\./g, '%2E')}`;

        const commitedPkg = {
          ...p,
          id: pkgDocId,
          packageId: pkgDocId,
          parentOrderId,
          customerId,
          deliveryAddressId,
          importState: "committed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        operations.push({ ref: pkgRef, data: commitedPkg });
      });

      // Production Items
      stagedItems.forEach((item: any) => {
        if (
          typeof item.packageId !== "string" ||
          typeof item.packageNumber !== "string" ||
          item.packageId !== buildPackageDocumentId(item.packageNumber)
        ) {
          throw new Error(
            `Invalid package relationship for item ${item.itemId}`
          );
        }

        if (!stagedPackageIds.has(item.packageId)) {
          throw new Error(
            `Parent package ${item.packageId} is missing for item ${item.itemId}`
          );
        }

        const itemRef = db.collection("packageItems").doc(item.itemId);
        operations.push({ ref: itemRef, data: item });
      });

      // Production Parent Orders
      stagedParents.forEach((parent: any) => {
        const encParentNum = encodeURIComponent(parent.parentOrderNumber).replace(/\./g, '%2E');
        const parentOrderId = `parent_${encParentNum}`;
        const parentRef = db.collection("parentOrders").doc(parentOrderId);
        operations.push({
          ref: parentRef,
          data: {
            id: parentOrderId,
            parentOrderNumber: parent.parentOrderNumber,
            customerName: parent.customerName,
            primaryPhone: parent.contactNumber,
            parentTotal: parent.parentTotal,
            parentCaptured: parent.parentCaptured,
            parentBalance: parent.parentBalance,
            createdAt: new Date().toISOString()
          }
        });
      });

      // Production COD Reviews (Created ONLY on completion!)
      stagedReviews.forEach((rev: any) => {
        const encParentNum = encodeURIComponent(rev.parentOrderNumber).replace(/\./g, '%2E');
        const revDocId = `rev_${encParentNum}`;
        const revRef = db.collection("codAllocationReviews").doc(revDocId);
        operations.push({
          ref: revRef,
          data: {
            id: revDocId,
            reviewId: revDocId,
            importBatchId: batchId,
            parentOrderNumber: rev.parentOrderNumber,
            parentTotal: rev.parentTotal,
            parentCaptured: rev.parentCaptured,
            remainingBalance: rev.parentBalance,
            activePackageNumbers: rev.activePackageNumbers,
            status: "Pending",
            createdAt: new Date().toISOString()
          }
        });
      });

      // Commit in batches of max 450
      const CHUNK_SIZE = 450;
      const totalChunks = Math.ceil(operations.length / CHUNK_SIZE) || 1;
      let completedChunks = 0;

      for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
        const chunk = operations.slice(i, i + CHUNK_SIZE);
        const writeBatch = db.batch();

        for (const op of chunk) {
          writeBatch.set(op.ref, op.data, { merge: true });
        }

        await writeBatch.commit();
        completedChunks++;

        await batchRef.update({
          completedChunks,
          totalChunks
        });
      }

      await batchRef.update({
        status: "completed",
        completedAt: new Date().toISOString(),
        completedChunks: totalChunks,
        totalChunks
      });

      return res.json({
        success: true,
        data: {
          batchId,
          status: "completed",
          createdPackages: stagedPackages.length,
          totalChunks
        }
      });
    } catch (err: any) {
      await db.collection("importBatches").doc(batchId).update({
        status: "failed",
        failureReason: err.message
      }).catch(() => {});

      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  };

  app.post("/api/import/commit", requireAuth, requireRole("super_admin", "dispatch_manager"), handleCsvCommit);
  app.post("/api/import-batches/commit", requireAuth, requireRole("super_admin", "dispatch_manager"), handleCsvCommit);

  app.get("/api/import-batches", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("importBatches").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- COD ALLOCATION REVIEW QUEUE ---
  app.get("/api/cod-allocation/reviews", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("codAllocationReviews").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Atomic COD Allocation Approval Transaction
  app.post("/api/cod-allocation/approve", requireAuth, requireRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    const { reviewId, allocations } = req.body;
    if (!reviewId || !allocations || !Array.isArray(allocations)) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_ARGUMENT", message: "Missing reviewId or allocations mapping" }
      });
    }

    try {
      await db.runTransaction(async (transaction) => {
        const revRef = db.collection("codAllocationReviews").doc(reviewId);
        const revDoc = await transaction.get(revRef);

        if (!revDoc.exists) {
          throw new Error("COD Allocation Review record not found");
        }

        const revData = revDoc.data();
        if (revData?.status === "Approved") {
          throw new Error("Review has already been approved");
        }

        const remainingBalance = revData?.remainingBalance ?? revData?.remaining_balance ?? 0;
        const activePkgNumbers: string[] = revData?.activePackageNumbers || [];

        // Validate allocations
        const seenPkgIds = new Set<string>();
        let totalAllocated = 0;

        for (const alloc of allocations) {
          const allocAmount = alloc.allocatedCod ?? alloc.allocated_cod ?? 0;
          if (allocAmount < 0) {
            throw new Error("Allocation amount cannot be negative");
          }
          totalAllocated += allocAmount;

          if (typeof alloc.packageId !== "string" || !alloc.packageId.trim()) {
            throw new Error("Every allocation must include a packageId.");
          }
          const pkgDocId = alloc.packageId.trim();

          if (seenPkgIds.has(pkgDocId)) {
            throw new Error(`Duplicate allocation for package ${pkgDocId}`);
          }
          seenPkgIds.add(pkgDocId);

          const pkgRef = db.collection("packages").doc(pkgDocId);
          const pkgDoc = await transaction.get(pkgRef);

          if (!pkgDoc.exists) {
            throw new Error(`Package ${pkgDocId} does not exist`);
          }

          const pkgData = pkgDoc.data();
          const docPkgId = pkgData?.packageId || pkgData?.id;
          if (docPkgId && docPkgId !== pkgDocId) {
            throw new Error(`Package document packageId mismatch for ${pkgDocId}`);
          }

          const allocPkgNum = alloc.packageNumber || alloc.package_number;
          if (allocPkgNum) {
            const docPkgNum = pkgData?.packageNumber || pkgData?.package_number;
            if (docPkgNum && docPkgNum !== allocPkgNum) {
              throw new Error(`Package number mismatch for package ${pkgDocId}`);
            }
          }
          const pkgNum = allocPkgNum || pkgData?.packageNumber || pkgData?.package_number || pkgDocId;
          if (pkgData?.parentOrderNumber !== revData?.parentOrderNumber && pkgData?.parent_order_number !== revData?.parent_order_number) {
            throw new Error(`Package ${pkgNum} does not belong to review parent order`);
          }

          if (pkgData?.operationalStatus !== "dispatched" && pkgData?.current_status !== "dispatched") {
            throw new Error(`Package ${pkgNum} is not in dispatched status`);
          }

          if (pkgData?.importState !== "committed") {
            throw new Error(`Package ${pkgNum} is not committed`);
          }

          transaction.update(pkgRef, {
            expectedCod: allocAmount,
            codExpected: allocAmount,
            cod_expected: allocAmount,
            requiresCodReview: false,
            requires_cod_review: false,
            updatedAt: new Date().toISOString()
          });

          const allocRef = db.collection("codAllocations").doc();
          transaction.set(allocRef, {
            id: allocRef.id,
            reviewId,
            packageId: pkgDocId,
            packageNumber: pkgNum,
            allocatedCod: allocAmount,
            createdByUid: req.auth.uid,
            createdAt: new Date().toISOString()
          });
        }

        if (Math.abs(totalAllocated - remainingBalance) > 0.01) {
          throw new Error(`Allocation sum (${totalAllocated}) does not equal parent balance (${remainingBalance})`);
        }

        if (activePkgNumbers.length > 0 && seenPkgIds.size !== activePkgNumbers.length) {
          throw new Error(`Incomplete allocations: expected ${activePkgNumbers.length} packages, got ${seenPkgIds.size}`);
        }

        transaction.update(revRef, {
          status: "Approved",
          approvedByUid: req.auth.uid,
          approvedAt: new Date().toISOString()
        });

        const auditRef = db.collection("auditEvents").doc();
        transaction.set(auditRef, {
          id: auditRef.id,
          action: "COD_ALLOCATION_APPROVED",
          reviewId,
          approvedByUid: req.auth.uid,
          timestamp: new Date().toISOString()
        });
      });

      return res.json({ success: true, data: { message: "COD allocation approved atomically" } });
    } catch (err: any) {
      return res.status(409).json({ success: false, error: { code: "TRANSACTION_FAILED", message: err.message } });
    }
  });

  // --- DISPATCH ASSIGNMENT CONTROLS ---
  app.post("/api/dispatch/assign", requireAuth, requireRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    const { packageId, riderId } = req.body;
    if (!packageId || !riderId) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_ARGUMENT", message: "Missing packageId or riderId" }
      });
    }

    try {
      await db.runTransaction(async (transaction) => {
        const pkgRef = db.collection("packages").doc(packageId);
        const pkgDoc = await transaction.get(pkgRef);

        if (!pkgDoc.exists) {
          throw { code: "NOT_FOUND", status: 404, message: `Package ${packageId} not found` };
        }

        const pkgData = pkgDoc.data();
        if (pkgData?.importState !== "committed") {
          throw { code: "FAILED_PRECONDITION", status: 400, message: "Package is not committed" };
        }

        const rawChannel = (pkgData?.deliveryChannel || pkgData?.delivery_channel || "").toLowerCase().replace(/[\s_]+/g, "");
        if (rawChannel && !rawChannel.includes("internalrider") && rawChannel !== "internal") {
          throw { code: "EXTERNAL_COURIER_ASSIGNMENT_REJECTED", status: 400, message: "External courier package cannot be assigned to internal rider." };
        }

        const currentStatus = (pkgData?.operationalStatus || pkgData?.current_status || "").toLowerCase();
        if (["delivered", "returned", "cancelled", "closed"].includes(currentStatus)) {
          throw { code: "INVALID_PACKAGE_STATUS", status: 400, message: `Delivered, returned, cancelled or closed package cannot be assigned. Status: ${currentStatus}` };
        }

        // Active assignment check on package
        if (pkgData?.assignedRiderId) {
          throw { code: "PACKAGE_ALREADY_ASSIGNED", status: 409, message: `Package ${packageId} is already assigned to rider ${pkgData.assignedRiderId}.` };
        }

        const riderRef = db.collection("riders").doc(riderId);
        const riderDoc = await transaction.get(riderRef);
        if (!riderDoc.exists) {
          throw { code: "RIDER_NOT_FOUND", status: 404, message: `Rider ${riderId} not found` };
        }

        const riderData = riderDoc.data();
        if (riderData?.active === false) {
          throw { code: "RIDER_INACTIVE", status: 400, message: `Rider ${riderId} is inactive` };
        }

        // Capacity check
        const activeSnap = await db.collection("assignments")
          .where("riderId", "==", riderId)
          .where("active", "==", true)
          .get();

        const maxCapacity = riderData?.maximum_daily_capacity || riderData?.maximumDailyCapacity || 50;
        if (activeSnap.size >= maxCapacity) {
          throw { code: "RIDER_CAPACITY_EXCEEDED", status: 400, message: `Rider ${riderId} maximum daily capacity of ${maxCapacity} reached` };
        }

        // Deterministic Active Lock Check
        const lockRef = db.collection("assignments").doc(packageId);
        const lockDoc = await transaction.get(lockRef);
        if (lockDoc.exists && lockDoc.data()?.active === true) {
          throw { code: "PACKAGE_ALREADY_ASSIGNED", status: 409, message: `Active assignment lock exists for package ${packageId}. Simultaneous double assignment rejected.` };
        }

        const nowStr = new Date().toISOString();
        transaction.set(lockRef, {
          id: packageId,
          packageId,
          riderId,
          assignedBy: req.auth.uid,
          assignedAt: nowStr,
          active: true
        });

        transaction.update(pkgRef, {
          assignedRiderId: riderId,
          current_status: "Assigned",
          operationalStatus: "assigned",
          custodyStage: "assigned_to_rider",
          custody_stage: "assigned_to_rider",
          updatedAt: nowStr
        });

        const auditRef = db.collection("auditEvents").doc();
        transaction.set(auditRef, {
          id: auditRef.id,
          action: "PACKAGE_ASSIGNED",
          packageId,
          riderId,
          assignedByUid: req.auth.uid,
          timestamp: nowStr
        });
      });

      return res.json({ success: true, data: { packageId, riderId, assignedAt: new Date().toISOString() } });
    } catch (err: any) {
      const status = err.status || 400;
      const code = err.code || "ASSIGNMENT_FAILED";
      return res.status(status).json({ success: false, error: { code, message: err.message || "Assignment failed" } });
    }
  });

  // --- CANONICAL BULK ASSIGNMENT (TRANSACTIONALLY PROTECTED) ---
  app.post("/api/dispatch/bulk-assign", requireAuth, requireRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    const { packageIds, riderId } = req.body;
    if (!packageIds || !Array.isArray(packageIds) || packageIds.length === 0 || !riderId) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_ARGUMENT", message: "packageIds array and riderId are required" }
      });
    }

    try {
      const riderRef = db.collection("riders").doc(riderId);
      const riderDoc = await riderRef.get();
      if (!riderDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "RIDER_NOT_FOUND", message: `Rider ${riderId} not found` } });
      }
      const riderData = riderDoc.data();
      if (riderData?.active === false) {
        return res.status(400).json({ success: false, error: { code: "RIDER_INACTIVE", message: `Rider ${riderId} is inactive` } });
      }

      const activeSnap = await db.collection("assignments")
        .where("riderId", "==", riderId)
        .where("active", "==", true)
        .get();
      const maxCapacity = riderData?.maximum_daily_capacity || riderData?.maximumDailyCapacity || 50;
      if (activeSnap.size + packageIds.length > maxCapacity) {
        return res.status(400).json({
          success: false,
          error: {
            code: "RIDER_CAPACITY_EXCEEDED",
            message: `Assigning ${packageIds.length} packages would exceed rider ${riderId} maximum capacity of ${maxCapacity} (currently has ${activeSnap.size} active)`
          }
        });
      }

      const nowStr = new Date().toISOString();
      const assignedResults: string[] = [];
      const errors: Array<{ packageId: string; error: string; code?: string }> = [];

      for (const packageId of packageIds) {
        try {
          await db.runTransaction(async (transaction) => {
            const pkgRef = db.collection("packages").doc(packageId);
            const pkgDoc = await transaction.get(pkgRef);
            if (!pkgDoc.exists) {
              throw { code: "NOT_FOUND", status: 404, message: "Package not found" };
            }
            const pkgData = pkgDoc.data();
            if (pkgData?.importState !== "committed") {
              throw { code: "FAILED_PRECONDITION", status: 400, message: "Package is not committed" };
            }
            const rawChannel = (pkgData?.deliveryChannel || pkgData?.delivery_channel || "").toLowerCase().replace(/[\s_]+/g, "");
            if (rawChannel && !rawChannel.includes("internalrider") && rawChannel !== "internal") {
              throw { code: "EXTERNAL_COURIER_REJECTED", status: 400, message: "External courier package cannot be assigned to internal rider" };
            }
            const currentStatus = (pkgData?.operationalStatus || pkgData?.current_status || "").toLowerCase();
            if (["delivered", "returned", "cancelled", "closed"].includes(currentStatus)) {
              throw { code: "INVALID_STATUS", status: 400, message: `Package in status ${currentStatus} cannot be assigned` };
            }

            if (pkgData?.assignedRiderId) {
              throw { code: "PACKAGE_ALREADY_ASSIGNED", status: 409, message: `Package is already assigned to rider ${pkgData.assignedRiderId}` };
            }

            const lockRef = db.collection("assignments").doc(packageId);
            const lockDoc = await transaction.get(lockRef);
            if (lockDoc.exists && lockDoc.data()?.active === true) {
              throw { code: "PACKAGE_ALREADY_ASSIGNED", status: 409, message: "Active assignment lock exists for package" };
            }

            transaction.set(lockRef, {
              id: packageId,
              packageId,
              riderId,
              assignedBy: req.auth.uid,
              assignedAt: nowStr,
              active: true
            });

            transaction.update(pkgRef, {
              assignedRiderId: riderId,
              current_status: "Assigned",
              operationalStatus: "assigned",
              custodyStage: "assigned_to_rider",
              custody_stage: "assigned_to_rider",
              updatedAt: nowStr
            });

            const auditRef = db.collection("auditEvents").doc();
            transaction.set(auditRef, {
              id: auditRef.id,
              action: "PACKAGE_ASSIGNED",
              packageId,
              riderId,
              assignedByUid: req.auth.uid,
              timestamp: nowStr
            });
          });

          assignedResults.push(packageId);
        } catch (err: any) {
          errors.push({ packageId, error: err.message || "Assignment failed", code: err.code || "ASSIGNMENT_FAILED" });
        }
      }

      const allFailed = assignedResults.length === 0 && errors.length > 0;
      const statusCode = allFailed && errors[0]?.code === "PACKAGE_ALREADY_ASSIGNED" ? 409 : (allFailed ? 400 : 200);

      return res.status(statusCode).json({
        success: errors.length === 0,
        data: {
          assignedCount: assignedResults.length,
          assignedPackageIds: assignedResults,
          errors: errors.length > 0 ? errors : undefined,
          riderId
        },
        error: allFailed ? { code: errors[0]?.code || "BULK_ASSIGNMENT_FAILED", message: errors[0]?.error || "All packages failed assignment" } : undefined
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "BULK_ASSIGNMENT_FAILED", message: err.message } });
    }
  });

  // --- DISPATCH TRANSFER CONTROLS ---
  app.post("/api/dispatch/transfer", requireAuth, requireAnyRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    const { packageId, sourceRiderId, destinationRiderId, transferReason, sourceConfirmed } = req.body;
    if (!packageId || !sourceRiderId || !destinationRiderId) {
      return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId, sourceRiderId, or destinationRiderId" } });
    }

    if (!transferReason || typeof transferReason !== "string" || !transferReason.trim()) {
      return res.status(400).json({ success: false, error: { code: "TRANSFER_REASON_REQUIRED", message: "Transfer reason is required" } });
    }

    try {
      await db.runTransaction(async (transaction) => {
        const lockRef = db.collection("assignments").doc(packageId);
        const lockDoc = await transaction.get(lockRef);

        if (!lockDoc.exists || lockDoc.data()?.active !== true) {
          throw { code: "NO_ACTIVE_ASSIGNMENT", status: 404, message: `No active assignment lock found for package ${packageId}` };
        }

        const currentLock = lockDoc.data();
        if (currentLock?.riderId !== sourceRiderId) {
          throw { code: "SOURCE_RIDER_MISMATCH", status: 403, message: "Source rider does not match current active assignment" };
        }

        const pkgRef = db.collection("packages").doc(packageId);
        const pkgDoc = await transaction.get(pkgRef);
        if (!pkgDoc.exists) {
          throw { code: "NOT_FOUND", status: 404, message: `Package ${packageId} not found` };
        }

        const pkgData = pkgDoc.data();
        const currentStatus = (pkgData?.operationalStatus || pkgData?.current_status || "").toLowerCase();
        if (["delivered", "returned", "cancelled", "closed"].includes(currentStatus)) {
          throw { code: "COMPLETED_PACKAGE", status: 400, message: "Completed package cannot be transferred" };
        }

        const destRiderRef = db.collection("riders").doc(destinationRiderId);
        const destRiderDoc = await transaction.get(destRiderRef);
        if (!destRiderDoc.exists || destRiderDoc.data()?.active === false) {
          throw { code: "RIDER_INACTIVE", status: 400, message: `Destination rider ${destinationRiderId} is inactive or does not exist` };
        }

        const nowStr = new Date().toISOString();
        // Atomic transfer: close old assignment, record transfer, update package
        transaction.update(lockRef, {
          active: false,
          closedAt: nowStr,
          closeReason: "transferred"
        });

        const newLockRef = db.collection("assignments").doc(`${packageId}_tr_${Date.now()}`);
        transaction.set(newLockRef, {
          id: newLockRef.id,
          packageId,
          riderId: destinationRiderId,
          previousRiderId: sourceRiderId,
          transferReason,
          assignedBy: req.auth.uid,
          assignedAt: nowStr,
          active: true
        });

        transaction.update(pkgRef, {
          assignedRiderId: destinationRiderId,
          updatedAt: nowStr
        });

        const auditRef = db.collection("auditEvents").doc();
        transaction.set(auditRef, {
          id: auditRef.id,
          action: "PACKAGE_TRANSFERRED",
          packageId,
          sourceRiderId,
          destinationRiderId,
          transferReason,
          transferredByUid: req.auth.uid,
          timestamp: nowStr
        });
      });

      return res.json({ success: true, data: { packageId, destinationRiderId, transferredAt: new Date().toISOString() } });
    } catch (err: any) {
      const status = err.status || 400;
      const code = err.code || "TRANSFER_FAILED";
      return res.status(status).json({ success: false, error: { code, message: err.message || "Transfer failed" } });
    }
  });

  // --- DISPATCH RUNS ---
  app.post("/api/dispatch/runs", requireAuth, requireRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const { riderId, vehicle, shift, dispatchDate, packageIds } = req.body;
      if (!riderId || !packageIds || !Array.isArray(packageIds) || packageIds.length === 0) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing riderId or packageIds array" } });
      }

      // 1. Validate Rider existence, role, and active state
      const riderRef = db.collection("riders").doc(riderId);
      const riderDoc = await riderRef.get();
      if (!riderDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "RIDER_NOT_FOUND", message: `Rider ${riderId} not found` } });
      }
      const riderData = riderDoc.data();
      if (riderData?.active === false || riderData?.status === "inactive") {
        return res.status(400).json({ success: false, error: { code: "RIDER_INACTIVE", message: `Rider ${riderId} is inactive` } });
      }
      if (riderData?.role && riderData.role !== "rider") {
        return res.status(400).json({ success: false, error: { code: "INVALID_RIDER_ROLE", message: `Rider role must be 'rider', found '${riderData.role}'` } });
      }

      // Check linked profile if present
      if (riderData?.profileId) {
        const profDoc = await db.collection("profiles").doc(riderData.profileId).get();
        if (profDoc.exists) {
          const prof = profDoc.data();
          if (prof?.role && prof.role !== "rider") {
            return res.status(400).json({ success: false, error: { code: "INVALID_RIDER_ROLE", message: `User profile linked to rider has role '${prof.role}', expected 'rider'` } });
          }
          if (prof?.active === false) {
            return res.status(400).json({ success: false, error: { code: "RIDER_INACTIVE", message: `Rider user profile is inactive` } });
          }
        }
      }

      // 2. Validate all packages: must exist, belong to this rider, not in active run, not completed
      const activeRunsSnap = await db.collection("dispatchRuns")
        .where("status", "in", ["draft", "ready_for_scan", "in_progress", "accepted_by_rider", "handoff_pending"])
        .get();
      const existingActivePackageIds = new Set<string>();
      activeRunsSnap.docs.forEach(d => {
        const rData = d.data();
        (rData.expectedPackages || []).forEach((pid: string) => existingActivePackageIds.add(pid));
      });

      let expectedCod = 0;
      for (const pkgId of packageIds) {
        const pkgDoc = await db.collection("packages").doc(pkgId).get();
        if (!pkgDoc.exists) {
          return res.status(404).json({ success: false, error: { code: "PACKAGE_NOT_FOUND", message: `Package ${pkgId} not found` } });
        }
        const d = pkgDoc.data();
        if (!d?.assignedRiderId || d.assignedRiderId !== riderId) {
          return res.status(400).json({
            success: false,
            error: {
              code: "WRONG_RIDER_PACKAGE",
              message: `Package ${pkgId} is ${d?.assignedRiderId ? `assigned to rider ${d.assignedRiderId}` : 'not assigned to any rider'}, but run is for rider ${riderId}`
            }
          });
        }
        const currStatus = (d?.operationalStatus || d?.current_status || "").toUpperCase();
        if (["DELIVERED", "RETURNED", "CANCELLED", "CLOSED", "RETURNING_TO_WAREHOUSE"].includes(currStatus)) {
          return res.status(400).json({ success: false, error: { code: "INVALID_PACKAGE_STATUS", message: `Package ${pkgId} is in completed status ${currStatus}` } });
        }
        if (existingActivePackageIds.has(pkgId)) {
          return res.status(400).json({ success: false, error: { code: "PACKAGE_IN_ACTIVE_RUN", message: `Package ${pkgId} is already in an active dispatch run` } });
        }
        expectedCod += (d?.cod_expected || d?.expectedCod || d?.codExpected || 0);
      }

      const runUuid = crypto.randomUUID();
      const runId = `run_${runUuid}`;
      const runNumber = `RUN-${runUuid.slice(0, 8).toUpperCase()}`;
      const nowStr = new Date().toISOString();

      const runData = {
        id: runId,
        runId,
        runNumber,
        riderId,
        vehicle: vehicle || "Motorbike",
        shift: shift || "Morning",
        dispatchDate: dispatchDate || nowStr.split("T")[0],
        expectedPackages: packageIds,
        expectedCod,
        scannedPackages: [],
        missingPackages: [],
        preparedBy: req.auth.uid,
        handedOverBy: null,
        acceptedByRider: false,
        status: "draft",
        startTimestamp: null,
        endTimestamp: null,
        createdAt: nowStr,
        updatedAt: nowStr
      };

      await db.collection("dispatchRuns").doc(runId).set(runData);

      // Note: Creating a run MUST NOT automatically mark packages Out for Delivery!
      return res.json({ success: true, data: runData });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/dispatch/runs", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("dispatchRuns").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/dispatch/runs/me", requireAuth, async (req: any, res: any) => {
    try {
      if (!req.auth.riderId) {
        return res.status(404).json({ success: false, error: { code: "RIDER_NOT_FOUND", message: "No rider record linked to profile" } });
      }

      const snap = await db.collection("dispatchRuns")
        .where("riderId", "==", req.auth.riderId)
        .where("status", "in", ["accepted_by_rider", "in_progress", "ready_for_scan", "handoff_pending", "draft"])
        .limit(1)
        .get();

      if (snap.empty) {
        return res.json({ success: true, data: null });
      }

      return res.json({ success: true, data: snap.docs[0].data() });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Dedicated Dispatcher Scan Endpoint
  app.post("/api/dispatch/runs/:runId/dispatcher-scan", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "warehouse_staff"), async (req: any, res: any) => {
    const { runId } = req.params;
    const { packageBarcode } = req.body;
    if (!packageBarcode) {
      return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "packageBarcode is required" } });
    }

    try {
      const runRef = db.collection("dispatchRuns").doc(runId);
      const runDoc = await runRef.get();
      if (!runDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Dispatch run ${runId} not found` } });
      }
      const runData = runDoc.data();

      // Find package by barcode or packageNumber or id
      const pkgSnap = await db.collection("packages").get();
      const matchedPkg = pkgSnap.docs.map(d => d.data()).find((p: any) =>
        p.packageNumber === packageBarcode ||
        p.package_number === packageBarcode ||
        p.id === packageBarcode ||
        p.courier_tracking_number === packageBarcode
      );

      if (!matchedPkg) {
        return res.status(400).json({
          success: false,
          error: { code: "EXACT_MATCH_REQUIRED", message: `No package found matching barcode "${packageBarcode}".` }
        });
      }

      if (!(runData?.expectedPackages || []).includes(matchedPkg.id)) {
        return res.status(400).json({
          success: false,
          error: { code: "PACKAGE_NOT_IN_MANIFEST", message: `Package ${matchedPkg.packageNumber || matchedPkg.id} is not in manifest for run ${runId}` }
        });
      }

      const nowStr = new Date().toISOString();

      // Check if already dispatcher scanned in this run to avoid duplicate custody events
      const existingScanSnap = await db.collection("custodyScans")
        .where("runId", "==", runId)
        .where("packageId", "==", matchedPkg.id)
        .where("scanStage", "==", "dispatcher_scanned")
        .limit(1)
        .get();

      if (!existingScanSnap.empty) {
        return res.json({
          success: true,
          data: existingScanSnap.docs[0].data()
        });
      }

      const scanDocId = `scan_${crypto.randomUUID()}`;
      const scanRecord = {
        id: scanDocId,
        packageId: matchedPkg.id,
        packageNumber: matchedPkg.packageNumber || matchedPkg.package_number,
        scanStage: "dispatcher_scanned",
        runId,
        scannedBy: req.auth.uid,
        scannedAt: nowStr
      };

      await db.collection("custodyScans").doc(scanDocId).set(scanRecord);
      await db.collection("packages").doc(matchedPkg.id).update({
        custodyStage: "dispatcher_scanned",
        custody_stage: "dispatcher_scanned",
        operationalStatus: "DISPATCHER_SCANNED",
        updatedAt: nowStr
      });

      return res.json({ success: true, data: scanRecord });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Dedicated Rider Scan Endpoint
  app.post("/api/dispatch/runs/:runId/rider-scan", requireAuth, requireExactRole("rider"), async (req: any, res: any) => {
    const { runId } = req.params;
    const { packageBarcode } = req.body;
    if (!packageBarcode) {
      return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "packageBarcode is required" } });
    }

    try {
      const runRef = db.collection("dispatchRuns").doc(runId);
      const runDoc = await runRef.get();
      if (!runDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Dispatch run ${runId} not found` } });
      }
      const runData = runDoc.data();

      if (runData?.riderId !== req.auth.riderId) {
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Rider can only scan packages into their own dispatch run." } });
      }

      // Find package
      const pkgSnap = await db.collection("packages").get();
      const matchedPkg = pkgSnap.docs.map(d => d.data()).find((p: any) =>
        p.packageNumber === packageBarcode ||
        p.package_number === packageBarcode ||
        p.id === packageBarcode ||
        p.courier_tracking_number === packageBarcode
      );

      if (!matchedPkg) {
        return res.status(400).json({
          success: false,
          error: { code: "EXACT_MATCH_REQUIRED", message: `No package found matching barcode "${packageBarcode}".` }
        });
      }

      if (!(runData?.expectedPackages || []).includes(matchedPkg.id)) {
        return res.status(400).json({
          success: false,
          error: { code: "PACKAGE_NOT_IN_MANIFEST", message: `Package ${matchedPkg.packageNumber || matchedPkg.id} is not in manifest for run ${runId}` }
        });
      }

      const currentCustody = (matchedPkg.custodyStage || matchedPkg.custody_stage || "").toLowerCase();
      const currentOpStatus = (matchedPkg.operationalStatus || "").toUpperCase();

      // Check if duplicate scan: if package already rider_scanned for this run
      const isAlreadyScanned = (runData.scannedPackages || []).includes(matchedPkg.id);
      const existingScanSnap = await db.collection("custodyScans")
        .where("runId", "==", runId)
        .where("packageId", "==", matchedPkg.id)
        .where("scanStage", "==", "rider_scanned")
        .limit(1)
        .get();

      if (isAlreadyScanned || !existingScanSnap.empty) {
        const existingRecord = !existingScanSnap.empty ? existingScanSnap.docs[0].data() : {
          packageId: matchedPkg.id,
          scanStage: "rider_scanned",
          runId
        };
        return res.json({
          success: true,
          data: {
            scanRecord: existingRecord,
            scannedPackagesCount: (runData.scannedPackages || []).length,
            totalExpected: (runData.expectedPackages || []).length,
            alreadyScanned: true
          }
        });
      }

      // Lifecycle check: Prior stage must be dispatcher_scanned
      if (currentCustody !== "dispatcher_scanned" && currentOpStatus !== "DISPATCHER_SCANNED") {
        return res.status(400).json({
          success: false,
          error: {
            code: "INVALID_CUSTODY_STAGE_SEQUENCE",
            message: `Rider scan requires prior dispatcher_scanned stage (found: ${currentCustody || currentOpStatus || 'none'}).`
          }
        });
      }

      const nowStr = new Date().toISOString();
      const scannedPackages = Array.from(new Set([...(runData.scannedPackages || []), matchedPkg.id]));
      await runRef.update({
        scannedPackages,
        updatedAt: nowStr
      });

      const scanDocId = `scan_${crypto.randomUUID()}`;
      const scanRecord = {
        id: scanDocId,
        packageId: matchedPkg.id,
        packageNumber: matchedPkg.packageNumber || matchedPkg.package_number,
        scanStage: "rider_scanned",
        runId,
        scannedBy: req.auth.uid,
        scannedAt: nowStr
      };

      await db.collection("custodyScans").doc(scanDocId).set(scanRecord);
      await db.collection("packages").doc(matchedPkg.id).update({
        custodyStage: "rider_scanned",
        custody_stage: "rider_scanned",
        operationalStatus: "RIDER_SCANNED",
        updatedAt: nowStr
      });

      return res.json({
        success: true,
        data: {
          scanRecord,
          scannedPackagesCount: scannedPackages.length,
          totalExpected: (runData.expectedPackages || []).length
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Dedicated Rider Manifest Acceptance Endpoint
  app.post("/api/dispatch/runs/:runId/accept", requireAuth, requireExactRole("rider"), async (req: any, res: any) => {
    const { runId } = req.params;
    const { discrepancyOverrideReason } = req.body || {};

    try {
      const runRef = db.collection("dispatchRuns").doc(runId);
      const runDoc = await runRef.get();
      if (!runDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Dispatch run ${runId} not found` } });
      }
      const runData = runDoc.data();

      if (runData?.riderId !== req.auth.riderId) {
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Rider can only accept their own dispatch run manifest." } });
      }

      const expected: string[] = runData?.expectedPackages || [];
      const scanned: string[] = runData?.scannedPackages || [];
      const hasMismatch = expected.length !== scanned.length || expected.some((id: string) => !scanned.includes(id));

      if (hasMismatch && !discrepancyOverrideReason) {
        return res.status(409).json({
          success: false,
          error: {
            code: "MANIFEST_MISMATCH",
            message: `Manifest scan count (${scanned.length}) does not match expected package count (${expected.length}). All packages must be scanned before acceptance or manager override required.`
          }
        });
      }

      const nowStr = new Date().toISOString();
      await runRef.update({
        status: "accepted_by_rider",
        acceptedByRider: true,
        startTimestamp: nowStr,
        acceptedAt: nowStr,
        discrepancyOverrideReason: discrepancyOverrideReason || null,
        updatedAt: nowStr
      });

      // Atomically update all accepted packages to OUT_FOR_DELIVERY
      const batch = db.batch();
      for (const pid of expected) {
        const pRef = db.collection("packages").doc(pid);
        batch.update(pRef, {
          current_status: "Out for Delivery",
          operationalStatus: "out_for_delivery",
          custodyStage: "rider_accepted",
          custody_stage: "rider_accepted",
          dispatchedAt: nowStr,
          updatedAt: nowStr
        });
      }
      await batch.commit();

      const updatedSnap = await runRef.get();
      return res.json({ success: true, data: updatedSnap.data() });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Dedicated Rider End Shift / Close Run Endpoint
  app.post("/api/dispatch/runs/:runId/end-shift", requireAuth, requireExactRole("rider"), async (req: any, res: any) => {
    const { runId } = req.params;
    const riderId = req.auth.riderId;

    try {
      const runRef = db.collection("dispatchRuns").doc(runId);
      const runDoc = await runRef.get();
      if (!runDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Dispatch run ${runId} not found` } });
      }
      const runData = runDoc.data();

      if (runData?.riderId !== riderId) {
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Rider can only end their own dispatch run shift." } });
      }

      const expectedPkgIds: string[] = runData?.expectedPackages || [];
      const pendingReasons: string[] = [];

      // 1. Fetch all packages in this run
      let runPackages: any[] = [];
      if (expectedPkgIds.length > 0) {
        const pkgSnaps = await Promise.all(expectedPkgIds.map(id => db.collection("packages").doc(id).get()));
        runPackages = pkgSnaps.filter(s => s.exists).map(s => s.data());
      } else {
        const allRiderPkgs = await db.collection("packages").where("assignedRiderId", "==", riderId).get();
        runPackages = allRiderPkgs.docs.map(d => d.data());
      }

      // Check Active Deliveries
      const activePending = runPackages.filter(p => {
        const st = (p.operationalStatus || p.current_status || "").toUpperCase().replace(/[\s-]+/g, "_");
        return ["OUT_FOR_DELIVERY", "ASSIGNED", "PICKED_UP", "READY_FOR_DISPATCH", "RIDER_SCANNED", "RIDER_ACCEPTED"].includes(st);
      });

      if (activePending.length > 0) {
        pendingReasons.push(`${activePending.length} delivery stop${activePending.length === 1 ? "" : "s"} still active on route`);
      }

      // Check Returns Handback
      const failedPackages = runPackages.filter(p => {
        const st = (p.operationalStatus || p.current_status || "").toLowerCase().replace(/[\s-]+/g, "_");
        return ["customer_unavailable", "rescheduled", "refused", "customer_refused", "incorrect_address", "address_issue", "cancelled", "customer_cancelled", "return_required", "returning_to_warehouse"].includes(st);
      });

      let unHandedBackReturns = 0;
      for (const p of failedPackages) {
        const retDoc = await db.collection("returns").doc(`ret_${p.id}`).get();
        const retData = retDoc.exists ? retDoc.data() : null;
        const isHandedBack = (retData?.returnStatus === "rider_handed_back" || retData?.returnStatus === "warehouse_received" || p.custodyStage === "return_handed_back");
        if (!isHandedBack) {
          unHandedBackReturns++;
        }
      }

      if (unHandedBackReturns > 0) {
        pendingReasons.push(`${unHandedBackReturns} return package${unHandedBackReturns === 1 ? "" : "s"} not scanned for depot return`);
      }

      // Check Cash Handover
      const codCollectionsSnap = await db.collection("codCollections")
        .where("riderId", "==", riderId)
        .where("paymentMethod", "==", "cash")
        .get();
      const allCashCollections = codCollectionsSnap.docs.map(d => d.data());
      const totalCashCollected = allCashCollections.reduce((sum, c: any) => sum + Number(c.collectedAmount || 0), 0);

      // Check total settlements submitted by rider
      const settlementsSnap = await db.collection("riderSettlements")
        .where("riderId", "==", riderId)
        .get();
      const validSettlements = settlementsSnap.docs.map(d => d.data()).filter((s: any) => s.status !== "rejected");
      const totalSubmitted = validSettlements.reduce((sum, s: any) => {
        const amt = s.physicallyReceivedAmount > 0 ? s.physicallyReceivedAmount : (s.declaredCashAmount || 0);
        return sum + Number(amt);
      }, 0);

      const cashPendingHandover = Math.max(0, totalCashCollected - totalSubmitted);
      if (cashPendingHandover > 0) {
        pendingReasons.push(`Rs. ${cashPendingHandover.toLocaleString()} cash not handed over to cashier`);
      }

      if (pendingReasons.length > 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: "SHIFT_CANNOT_CLOSE",
            message: `Shift cannot close: ${pendingReasons.join(". ")}.`,
            pendingReasons
          }
        });
      }

      const nowStr = new Date().toISOString();
      const deliveredCount = runPackages.filter(p => (p.operationalStatus || p.current_status || "").toLowerCase() === "delivered").length;
      const failedCount = failedPackages.length;

      await runRef.update({
        status: "completed",
        closedAt: nowStr,
        shiftEndedAt: nowStr,
        completedByUid: req.auth.uid,
        updatedAt: nowStr
      });

      const finalSnap = await runRef.get();
      return res.json({
        success: true,
        data: {
          ...finalSnap.data(),
          summary: {
            deliveredCount,
            failedCount,
            returnsCount: failedPackages.length,
            cashHandedOver: totalSubmitted,
            closedAt: nowStr
          }
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.patch("/api/dispatch/runs/:id", requireAuth, requireAnyRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const runRef = db.collection("dispatchRuns").doc(req.params.id);
      const runDoc = await runRef.get();
      if (!runDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Dispatch run not found" } });
      }

      const currentRun = runDoc.data();
      if (req.auth.role === 'rider' && currentRun?.riderId !== req.auth.riderId) {
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "You can only update your own dispatch run" } });
      }

      // Security: Dispatcher cannot impersonate rider to accept manifest or set in_progress
      if (req.body.status === "accepted_by_rider" || req.body.acceptedByRider === true || req.body.status === "in_progress") {
        if (req.auth.role !== "rider") {
          return res.status(403).json({
            success: false,
            error: {
              code: "DISPATCHER_IMPERSONATION_FORBIDDEN",
              message: "Dispatcher cannot set accepted_by_rider or in_progress. Rider must explicitly accept the manifest via /api/dispatch/runs/:id/accept"
            }
          });
        }
      }

      const updates: any = { ...req.body, updatedAt: new Date().toISOString() };
      
      if (req.body.status === "in_progress" || req.body.status === "accepted_by_rider") {
        updates.acceptedByRider = true;
        updates.startTimestamp = updates.startTimestamp || new Date().toISOString();

        // Mark assigned packages as out_for_delivery / dispatched
        const pkgIds: string[] = currentRun?.expectedPackages || [];
        for (const pid of pkgIds) {
          await db.collection("packages").doc(pid).update({
            current_status: "Out for Delivery",
            operationalStatus: "out_for_delivery",
            updatedAt: new Date().toISOString()
          }).catch(() => {});
        }
      }

      await runRef.update(updates);
      const updatedSnap = await runRef.get();
      return res.json({ success: true, data: updatedSnap.data() });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- CUSTODY SCANNING ---
  app.post("/api/dispatch/scan", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "warehouse_staff"), async (req: any, res: any) => {
    const { packageBarcode, scanStage, runId } = req.body;
    if (!packageBarcode || !scanStage) {
      return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageBarcode or scanStage" } });
    }

    if (scanStage === "delivered") {
      return res.status(400).json({ success: false, error: { code: "INVALID_CUSTODY_STAGE", message: "A custody scan must never mark a package Delivered." } });
    }

    try {
      // Exact Barcode Matching ONLY!
      const snap = await db.collection("packages").get();
      const allPkgs = snap.docs.map(d => d.data());

      const matchedPkg = allPkgs.find((p: any) =>
        p.packageNumber === packageBarcode ||
        p.package_number === packageBarcode ||
        p.id === packageBarcode ||
        p.courier_tracking_number === packageBarcode
      );

      if (!matchedPkg) {
        return res.status(400).json({
          success: false,
          error: { code: "EXACT_MATCH_REQUIRED", message: `No package found matching exact barcode "${packageBarcode}". Partial matches are strictly rejected.` }
        });
      }

      // Check Stage Sequence
      const currentCustodyStage = matchedPkg.custodyStage || matchedPkg.custody_stage || "none";
      
      if (scanStage === "dispatcher_scanned" && currentCustodyStage !== "warehouse_prepared" && currentCustodyStage !== "none") {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_CUSTODY_STAGE_SEQUENCE", message: `Scan stage dispatcher_scanned requires prior stage warehouse_prepared or staged.` }
        });
      }

      if (scanStage === "rider_accepted" && currentCustodyStage !== "dispatcher_scanned") {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_CUSTODY_STAGE_SEQUENCE", message: `Scan stage rider_accepted requires prior stage dispatcher_scanned (found: ${currentCustodyStage}).` }
        });
      }

      const scanDocId = `scan_${Date.now()}_${Math.random().toString(36).substring(2,6)}`;
      const nowStr = new Date().toISOString();
      const scanRecord = {
        id: scanDocId,
        packageId: matchedPkg.id,
        packageNumber: matchedPkg.packageNumber || matchedPkg.package_number,
        scanStage,
        runId: runId || null,
        scannedBy: req.auth.uid,
        scannedAt: nowStr
      };

      await db.collection("custodyScans").doc(scanDocId).set(scanRecord);
      await db.collection("packages").doc(matchedPkg.id).update({
        custodyStage: scanStage,
        custody_stage: scanStage,
        updatedAt: nowStr
      });

      return res.json({ success: true, data: scanRecord });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- DELIVERY ATTEMPTS & OUTCOMES ---
  app.post("/api/delivery/attempt", requireAuth, requireExactRole("rider"), requirePackageOwnership, async (req: any, res: any) => {
    const {
      packageId,
      status,
      attemptId: customAttemptId,
      deliveryAttemptId,
      collectedAmount,
      paymentMethod,
      receiverName,
      receiverRelationship,
      deviceTimestamp,
      latitude,
      longitude,
      proofImageUrl,
      proofPhoto,
      proofImage,
      proofStoragePath,
      gpsPermissionState,
      proofStatus,
      reason,
      riderNotes,
      customerContacted,
      newDeliveryDate,
      idempotencyKey,
      digitalReference
    } = req.body;

    if (!packageId || !status) {
      return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId or status" } });
    }

    // 1. Strict Delivery Outcome Validation
    const ALLOWED_OUTCOMES = [
      "DELIVERED",
      "CUSTOMER_UNAVAILABLE",
      "RESCHEDULED",
      "REFUSED",
      "ADDRESS_ISSUE",
      "CUSTOMER_CANCELLED"
    ];
    const rawOutcome = (status || "").toUpperCase().replace(/[\s-]+/g, "_");
    if (!ALLOWED_OUTCOMES.includes(rawOutcome)) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_DELIVERY_OUTCOME", message: `Invalid delivery outcome "${status}". Allowed outcomes: ${ALLOWED_OUTCOMES.join(", ")}` }
      });
    }

    // 2. Client-side Proof & Input Validations before starting transaction
    const hasLat = latitude !== undefined && latitude !== null && latitude !== "" && !isNaN(Number(latitude));
    const hasLng = longitude !== undefined && longitude !== null && longitude !== "" && !isNaN(Number(longitude));
    const photoRef = (proofImageUrl || proofPhoto || proofImage || proofStoragePath || "").trim();

    if (rawOutcome === "DELIVERED") {
      if (collectedAmount === undefined || collectedAmount === null || collectedAmount === "" || isNaN(Number(collectedAmount))) {
        return res.status(400).json({
          success: false,
          error: { code: "COLLECTED_AMOUNT_REQUIRED", message: "Delivered status requires actual collected amount." }
        });
      }
      const collAmt = Number(collectedAmount);
      if (collAmt < 0) {
        return res.status(400).json({
          success: false,
          error: { code: "NEGATIVE_COD_REJECTED", message: "Collected amount cannot be negative." }
        });
      }

      if (!receiverName || typeof receiverName !== "string" || !receiverName.trim()) {
        return res.status(400).json({
          success: false,
          error: { code: "RECEIVER_NAME_REQUIRED", message: "Delivered status requires receiverName." }
        });
      }

      // Photo proof requirement
      if (!photoRef) {
        return res.status(400).json({
          success: false,
          error: { code: "PROOF_PHOTO_REQUIRED", message: "Delivered status requires photo proof." }
        });
      }

      // GPS requirement (do not default missing GPS)
      if (!hasLat || !hasLng) {
        return res.status(400).json({
          success: false,
          error: { code: "GPS_COORDINATES_REQUIRED", message: "Delivered status requires valid GPS coordinates (latitude, longitude)." }
        });
      }
    } else if (rawOutcome === "RESCHEDULED") {
      if (!newDeliveryDate || typeof newDeliveryDate !== "string" || !newDeliveryDate.trim()) {
        return res.status(400).json({
          success: false,
          error: { code: "NEW_DELIVERY_DATE_REQUIRED", message: "Rescheduled status requires a new delivery date." }
        });
      }
    } else {
      if (!reason || typeof reason !== "string" || !reason.trim()) {
        return res.status(400).json({
          success: false,
          error: { code: "REASON_REQUIRED", message: "Failed delivery outcome requires a reason." }
        });
      }
    }

    const effectiveAttemptId = customAttemptId || deliveryAttemptId || `att_${crypto.randomUUID()}`;
    const effectiveIdemKey = idempotencyKey || `DELIVERY:${packageId}:${effectiveAttemptId}`;
    const isContacted = customerContacted === true;
    const nowStr = new Date().toISOString();

    try {
      const result = await db.runTransaction(async (t: any) => {
        // Read 1: Package Doc
        const pkgRef = db.collection("packages").doc(packageId);
        const pkgDoc = await t.get(pkgRef);
        if (!pkgDoc.exists) {
          throw { status: 404, code: "NOT_FOUND", message: `Package ${packageId} not found` };
        }

        const pkgData = pkgDoc.data();
        const assignedRiderId = pkgData?.assignedRiderId;

        // Rider Ownership Check
        if (req.auth.role === "rider") {
          if (assignedRiderId !== req.auth.riderId) {
            throw { status: 403, code: "FORBIDDEN", message: "You are not assigned to this package. Rider completing unassigned package is strictly rejected." };
          }
        }

        // Read 2: Idempotency Doc
        const idemRef = db.collection("idempotencyKeys").doc(effectiveIdemKey);
        const idemDoc = await t.get(idemRef);
        if (idemDoc.exists) {
          const stored = idemDoc.data();
          return { idempotent: true, data: stored?.attemptRecord || { packageId, status: rawOutcome } };
        }

        // State Check: ONLY OUT_FOR_DELIVERY is permitted
        const currOpStatus = (pkgData?.operationalStatus || pkgData?.current_status || "").toUpperCase().replace(/[\s-]+/g, "_");
        if (currOpStatus !== "OUT_FOR_DELIVERY") {
          if (currOpStatus === "DELIVERED") {
            // Already delivered
            throw { status: 400, code: "DUPLICATE_DELIVERY_SUBMISSION", message: "Package is already delivered. Duplicate delivery submission rejected." };
          }
          throw { status: 400, code: "INVALID_STATE_TRANSITION", message: `Cannot record delivery attempt for package in state "${currOpStatus}". Package must be OUT_FOR_DELIVERY.` };
        }

        // Determine Payment & COD amounts
        const isPrepaid = (pkgData.paymentMethod || pkgData.payment_method || "").toLowerCase() === "prepaid" ||
                          Number(pkgData.expectedCod || pkgData.cod_expected || 0) === 0;
        const expectedCod = isPrepaid ? 0 : Number(pkgData.cod_expected || pkgData.expectedCod || pkgData.codExpected || 0);
        const collAmt = rawOutcome === "DELIVERED" ? (isPrepaid ? 0 : Number(collectedAmount)) : 0;
        const normPayment = (paymentMethod || pkgData.paymentMethod || pkgData.payment_method || (isPrepaid ? "prepaid" : "cash")).toLowerCase().replace(/[\s_]+/g, "_");
        const isDigital = ["jazzcash", "easypaisa", "bank_transfer"].includes(normPayment);

        if (rawOutcome === "DELIVERED" && isDigital && (!digitalReference || !digitalReference.trim())) {
          throw { status: 400, code: "DIGITAL_REFERENCE_REQUIRED", message: "Digital payment method requires a digital reference." };
        }

        // Build Attempt Record
        const attemptRef = db.collection("deliveryAttempts").doc(effectiveAttemptId);
        const attemptRecord = {
          id: effectiveAttemptId,
          packageId,
          riderId: req.auth.riderId || assignedRiderId,
          status: rawOutcome,
          collectedAmount: collAmt,
          paymentMethod: rawOutcome === "DELIVERED" ? (isPrepaid ? "Prepaid" : (paymentMethod || "Cash")) : null,
          receiverName: rawOutcome === "DELIVERED" ? receiverName.trim() : null,
          receiverRelationship: rawOutcome === "DELIVERED" ? (receiverRelationship?.trim() || "Recipient") : null,
          latitude: hasLat ? Number(latitude) : null,
          longitude: hasLng ? Number(longitude) : null,
          proofImageUrl: photoRef || null,
          proofStoragePath: proofStoragePath || null,
          reason: reason || null,
          riderNotes: riderNotes || null,
          customerContacted: isContacted,
          newDeliveryDate: rawOutcome === "RESCHEDULED" ? newDeliveryDate.trim() : null,
          serverTimestamp: nowStr,
          deviceTimestamp: deviceTimestamp || nowStr,
          gpsPermissionState: hasLat && hasLng ? (gpsPermissionState || "granted") : (gpsPermissionState || "denied"),
          proofStatus: proofStatus || (rawOutcome === "DELIVERED" ? "captured" : "pending"),
          idempotencyKey: effectiveIdemKey,
          createdAt: nowStr
        };

        t.set(attemptRef, attemptRecord);

        let codCollectionRecord = null;
        let txId = null;

        if (rawOutcome === "DELIVERED") {
          // Update Package to DELIVERED
          t.update(pkgRef, {
            current_status: "Delivered",
            operationalStatus: "delivered",
            collectedAmount: collAmt,
            receiverName: receiverName.trim(),
            deliveredAt: nowStr,
            failureReason: null,
            updatedAt: nowStr
          });

          // If COD and amount > 0, post COD Collection and Financial Ledger Transaction
          if (!isPrepaid && collAmt > 0) {
            const codId = `cod_${crypto.randomUUID()}`;
            txId = `tx_${crypto.randomUUID()}`;
            const collectionVariance = collAmt - expectedCod;

            let accountCode = "RIDER_CASH_WALLET";
            if (normPayment === "jazzcash") accountCode = "JAZZCASH_CLEARING";
            else if (normPayment === "easypaisa") accountCode = "EASYPAISA_CLEARING";
            else if (normPayment === "bank_transfer") accountCode = "BANK_TRANSFER_CLEARING";

            // 1. Financial Transaction
            const txRef = db.collection("financialTransactions").doc(txId);
            t.set(txRef, {
              id: txId,
              transactionType: "COD_COLLECTION",
              sourceType: "cod_collection",
              sourceId: packageId,
              packageId,
              riderId: req.auth.riderId || assignedRiderId,
              cashierProfileId: null,
              settlementId: null,
              bankDepositId: null,
              status: "posted",
              currency: "PKR",
              totalDebit: collAmt,
              totalCredit: collAmt,
              idempotencyKey: effectiveIdemKey,
              createdByUid: req.auth.uid,
              createdAt: nowStr,
              reversedTransactionId: null,
              reversedByUid: null,
              reversedAt: null,
              reversalReason: null
            });

            // 2. Financial Postings (Debit Rider Wallet / Credit Customer COD Receivable)
            const postDebitRef = db.collection("financialPostings").doc(`post_dr_${crypto.randomUUID()}`);
            t.set(postDebitRef, {
              id: postDebitRef.id,
              transactionId: txId,
              accountCode,
              debitAmount: collAmt,
              creditAmount: 0,
              packageId,
              riderId: req.auth.riderId || assignedRiderId,
              createdAt: nowStr
            });

            const postCreditRef = db.collection("financialPostings").doc(`post_cr_${crypto.randomUUID()}`);
            t.set(postCreditRef, {
              id: postCreditRef.id,
              transactionId: txId,
              accountCode: "CUSTOMER_COD_RECEIVABLE",
              debitAmount: 0,
              creditAmount: collAmt,
              packageId,
              riderId: req.auth.riderId || assignedRiderId,
              createdAt: nowStr
            });

            // 3. COD Collection record
            codCollectionRecord = {
              id: codId,
              packageId,
              riderId: req.auth.riderId || assignedRiderId,
              expectedCod,
              collectedAmount: collAmt,
              paymentMethod: normPayment,
              digitalReference: isDigital ? digitalReference.trim() : null,
              collectionVariance,
              idempotencyKey: effectiveIdemKey,
              transactionId: txId,
              createdAt: nowStr
            };
            const codRef = db.collection("codCollections").doc(codId);
            t.set(codRef, codCollectionRecord);

            if (isDigital) {
              const digRefClean = digitalReference.trim();
              const digRef = db.collection("digitalPaymentVerifications").doc(`dig_${digRefClean}`);
              t.set(digRef, {
                id: `dig_${digRefClean}`,
                digitalReference: digRefClean,
                packageId,
                paymentMethod: normPayment,
                amount: collAmt,
                status: "pending",
                verifiedByUid: null,
                createdAt: nowStr
              });
            }
          }

          // 4. Audit Event
          const auditRef = db.collection("auditLogs").doc(`audit_${crypto.randomUUID()}`);
          t.set(auditRef, {
            id: auditRef.id,
            action: "PACKAGE_DELIVERED",
            packageId,
            riderId: req.auth.riderId || assignedRiderId,
            actorUid: req.auth.uid,
            actorRole: req.auth.role,
            metadata: {
              attemptId: effectiveAttemptId,
              collectedAmount: collAmt,
              paymentMethod: normPayment,
              txId
            },
            timestamp: nowStr
          });
        } else {
          // Failed delivery outcome
          let targetStatus = "Customer Unavailable";
          let targetOpStatus = "customer_unavailable";
          if (rawOutcome === "RESCHEDULED") { targetStatus = "Rescheduled"; targetOpStatus = "rescheduled"; }
          else if (rawOutcome === "REFUSED") { targetStatus = "Refused"; targetOpStatus = "refused"; }
          else if (rawOutcome === "ADDRESS_ISSUE") { targetStatus = "Incorrect Address"; targetOpStatus = "address_issue"; }
          else if (rawOutcome === "CUSTOMER_CANCELLED") { targetStatus = "Cancelled"; targetOpStatus = "cancelled"; }

          t.update(pkgRef, {
            current_status: targetStatus,
            operationalStatus: targetOpStatus,
            failureReason: reason || null,
            nextAttemptDate: rawOutcome === "RESCHEDULED" ? newDeliveryDate.trim() : null,
            updatedAt: nowStr
          });

          // Return Initiation Record
          const returnRef = db.collection("returns").doc(`ret_${packageId}`);
          t.set(returnRef, {
            id: `ret_${packageId}`,
            packageId,
            packageNumber: pkgData?.packageNumber || pkgData?.package_number || packageId,
            riderId: req.auth.riderId || assignedRiderId,
            returnReason: reason || rawOutcome,
            returnStatus: "return_required",
            createdAt: nowStr,
            updatedAt: nowStr
          }, { merge: true });

          // Audit Event
          const auditRef = db.collection("auditLogs").doc(`audit_${crypto.randomUUID()}`);
          t.set(auditRef, {
            id: auditRef.id,
            action: `DELIVERY_FAILED_${rawOutcome}`,
            packageId,
            riderId: req.auth.riderId || assignedRiderId,
            actorUid: req.auth.uid,
            actorRole: req.auth.role,
            metadata: { attemptId: effectiveAttemptId, reason, nextAttemptDate: newDeliveryDate },
            timestamp: nowStr
          });
        }

        // Set Idempotency Key
        t.set(idemRef, {
          key: effectiveIdemKey,
          packageId,
          attemptId: effectiveAttemptId,
          status: rawOutcome,
          attemptRecord,
          codCollectionRecord,
          createdAt: nowStr
        });

        return { idempotent: false, data: attemptRecord };
      });

      return res.json({ success: true, data: result.data });
    } catch (err: any) {
      const status = err.status || 500;
      const code = err.code || "SERVER_ERROR";
      return res.status(status).json({ success: false, error: { code, message: err.message || "Operation failed" } });
    }
  });

  app.get("/api/delivery/history/me", requireAuth, requireExactRole("rider"), async (req: any, res: any) => {
    try {
      if (!req.auth.riderId) {
        return res.json({ success: true, data: [] });
      }
      const snap = await db.collection("deliveryAttempts").where("riderId", "==", req.auth.riderId).get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/delivery/history", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("deliveryAttempts").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- FINANCIAL LEDGER & SETTLEMENTS ---

  // Accounts List
  app.get("/api/finance/accounts", requireAuth, requireAnyRole("super_admin", "cashier", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      await seedFinancialAccounts(db);
      const snap = await db.collection("financialAccounts").get();
      const accounts = snap.docs.map(d => d.data());
      return res.json({ success: true, data: accounts });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Post Financial Transaction
  app.post("/api/finance/transactions", requireAuth, requireRole("super_admin"), (req: any, res: any) => {
    return res.status(503).json({
      success: false,
      error: { code: "MODULE_DISABLED", message: "This module is not yet enabled." }
    });
  });

  // Reverse Financial Transaction
  app.post("/api/finance/transactions/reverse", requireAuth, requireRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const { transactionId, reversalReason, idempotencyKey } = req.body;
      if (!transactionId || !reversalReason || !reversalReason.trim()) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing transactionId or reversalReason" } });
      }

      const txRef = db.collection("financialTransactions").doc(transactionId);
      const txDoc = await txRef.get();
      if (!txDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Transaction ${transactionId} not found` } });
      }

      const txData = txDoc.data();
      if (txData?.status === "reversed") {
        return res.status(400).json({ success: false, error: { code: "DOUBLE_REVERSAL_REJECTED", message: "Transaction has already been reversed. Double reversal rejected." } });
      }

      const postingsSnap = await db.collection("financialPostings").where("transactionId", "==", transactionId).get();
      const originalPostings = postingsSnap.docs.map(d => d.data());

      // Swap debits and credits
      const reversedPostings = originalPostings.map((p: any) => ({
        accountCode: p.accountCode,
        debitAmount: p.creditAmount,
        creditAmount: p.debitAmount,
        packageId: p.packageId,
        riderId: p.riderId,
        settlementId: p.settlementId,
        bankDepositId: p.bankDepositId
      }));

      const revResult = await createDoubleEntryTransaction(db, {
        transactionType: "REVERSAL",
        sourceType: txData.sourceType,
        sourceId: txData.sourceId,
        packageId: txData.packageId,
        riderId: txData.riderId,
        cashierProfileId: txData.cashierProfileId,
        settlementId: txData.settlementId,
        bankDepositId: txData.bankDepositId,
        idempotencyKey: idempotencyKey || `rev_${transactionId}_${Date.now()}`,
        createdByUid: req.auth.uid,
        postings: reversedPostings
      });

      const nowStr = new Date().toISOString();
      await txRef.update({
        status: "reversed",
        reversedTransactionId: revResult.transactionId,
        reversedByUid: req.auth.uid,
        reversedAt: nowStr,
        reversalReason
      });

      return res.json({ success: true, data: { originalTransactionId: transactionId, reversalTransactionId: revResult.transactionId } });
    } catch (err: any) {
      const status = err.status || 400;
      return res.status(status).json({ success: false, error: { code: err.code || "REVERSAL_FAILED", message: err.message } });
    }
  });

  // Rider Submit Cash Settlement
  app.post("/api/finance/settlements/submit", requireAuth, requireExactRole("rider"), async (req: any, res: any) => {
    try {
      const { settlementId: reqSettlementId, declaredCashAmount, notes, idempotencyKey } = req.body;
      if (declaredCashAmount === undefined || declaredCashAmount < 0) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "declaredCashAmount must be a non-negative number" } });
      }

      const riderId = req.auth.riderId;
      const targetSettlementId = reqSettlementId || `stl_${riderId}_${Date.now()}`;

      // Calculate rider's physical cash obligation from un-settled cash collections
      const codSnap = await db.collection("codCollections")
        .where("riderId", "==", riderId)
        .where("paymentMethod", "==", "cash")
        .get();

      const allCollections = codSnap.docs.map(d => d.data());
      
      const settlementLinesSnap = await db.collection("settlementLines").get();
      const usedPackageIds = new Set(settlementLinesSnap.docs.map(d => d.data().packageId));

      const eligibleCollections = allCollections.filter((c: any) => !usedPackageIds.has(c.packageId));
      const calculatedCashObligation = eligibleCollections.reduce((sum: number, c: any) => sum + (c.collectedAmount || 0), 0);
      const riderHandoverVariance = Number(declaredCashAmount) - calculatedCashObligation;

      const nowStr = new Date().toISOString();
      const settlementDoc = {
        id: targetSettlementId,
        settlementNumber: `SET-${Date.now().toString().slice(-6)}`,
        riderId,
        status: "rider_submitted",
        calculatedCashObligation,
        declaredCashAmount: Number(declaredCashAmount),
        physicallyReceivedAmount: 0,
        collectionVariance: eligibleCollections.reduce((sum: number, c: any) => sum + (c.collectionVariance || 0), 0),
        riderHandoverVariance,
        cashierVariance: 0,
        discrepancyAmount: 0,
        discrepancyReason: null,
        notes: notes || null,
        receiptNotes: null,
        submittedAt: nowStr,
        receivedAt: null,
        approvedAt: null,
        approvedByUid: null,
        closedAt: null,
        createdAt: nowStr,
        updatedAt: nowStr
      };

      await db.collection("riderSettlements").doc(targetSettlementId).set(settlementDoc);

      for (const col of eligibleCollections) {
        const lineId = `line_${targetSettlementId}_${col.packageId}`;
        await db.collection("settlementLines").doc(lineId).set({
          id: lineId,
          settlementId: targetSettlementId,
          packageId: col.packageId,
          collectedAmount: col.collectedAmount,
          paymentMethod: "cash",
          createdAt: nowStr
        });
      }

      return res.json({ success: true, data: settlementDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Cashier Receive Settlement
  app.post("/api/finance/settlements/receive", requireAuth, requireExactRole("cashier"), async (req: any, res: any) => {
    try {
      const { settlementId, physicallyReceivedAmount, receiptNotes, idempotencyKey } = req.body;
      if (!settlementId || physicallyReceivedAmount === undefined || physicallyReceivedAmount < 0) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing settlementId or valid physicallyReceivedAmount" } });
      }

      const stlRef = db.collection("riderSettlements").doc(settlementId);
      const stlDoc = await stlRef.get();
      if (!stlDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Settlement ${settlementId} not found` } });
      }

      const stlData = stlDoc.data();
      if (stlData?.status !== "rider_submitted") {
        return res.status(400).json({ success: false, error: { code: "INVALID_SETTLEMENT_STAGE", message: `Cannot receive physical cash for settlement in stage "${stlData?.status}". Stage skipping rejected.` } });
      }

      if (stlData.riderId === req.auth.riderId || stlData.riderId === req.auth.uid) {
        return res.status(403).json({ success: false, error: { code: "SELF_ACTION_REJECTED", message: "Rider cannot confirm their own cashier receipt." } });
      }

      const receivedAmt = Number(physicallyReceivedAmount);
      const calculatedCash = Number(stlData.calculatedCashObligation || 0);
      const declaredAmt = Number(stlData.declaredCashAmount || 0);
      const cashierVariance = receivedAmt - declaredAmt;
      const totalSettlementVariance = receivedAmt - calculatedCash;
      const hasDiscrepancy = cashierVariance !== 0 || totalSettlementVariance !== 0;
      const discrepancyType = totalSettlementVariance < 0 ? "SHORT" : (totalSettlementVariance > 0 ? "EXCESS" : (cashierVariance !== 0 ? "DECLARATION_MISMATCH" : "NONE"));

      const nowStr = new Date().toISOString();
      const idemKey = idempotencyKey || `idem_rcv_${settlementId}_${Date.now()}`;

      const txRes = await createDoubleEntryTransaction(db, {
        transactionType: "RIDER_SETTLEMENT_RECEIPT",
        sourceType: "rider_settlement",
        sourceId: settlementId,
        settlementId,
        riderId: stlData.riderId,
        cashierProfileId: req.auth.uid,
        idempotencyKey: idemKey,
        createdByUid: req.auth.uid,
        postings: [
          { accountCode: "CASHIER_CASH_CONTROL", debitAmount: receivedAmt, creditAmount: 0 },
          { accountCode: "RIDER_CASH_WALLET", debitAmount: 0, creditAmount: receivedAmt }
        ]
      });

      const nextStatus = hasDiscrepancy ? "discrepancy" : "cashier_received";

      await stlRef.update({
        physicallyReceivedAmount: receivedAmt,
        cashierVariance,
        totalSettlementVariance,
        discrepancyAmount: totalSettlementVariance !== 0 ? totalSettlementVariance : cashierVariance,
        discrepancyType,
        status: nextStatus,
        receiptNotes: receiptNotes || null,
        receivedAt: nowStr,
        updatedAt: nowStr
      });

      if (hasDiscrepancy) {
        const auditRef = db.collection("financialAuditEvents").doc();
        await auditRef.set({
          id: auditRef.id,
          eventType: "SETTLEMENT_DISCREPANCY_DETECTED",
          entityType: "rider_settlement",
          entityId: settlementId,
          actorUid: req.auth.uid,
          details: { cashierVariance, declared: stlData.declaredCashAmount, received: receivedAmt },
          createdAt: nowStr
        });
      }

      const updatedDoc = (await stlRef.get()).data();
      return res.json({ success: true, data: updatedDoc });
    } catch (err: any) {
      const status = err.status || 400;
      return res.status(status).json({ success: false, error: { code: err.code || "RECEIPT_FAILED", message: err.message } });
    }
  });

  // Manager Approve Discrepancy
  app.post("/api/finance/settlements/approve-discrepancy", requireAuth, requireRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const { settlementId, discrepancyReason, idempotencyKey } = req.body;
      if (!settlementId || !discrepancyReason || !discrepancyReason.trim()) {
        return res.status(400).json({ success: false, error: { code: "DISCREPANCY_REASON_REQUIRED", message: "Approval requires a discrepancy reason" } });
      }

      const stlRef = db.collection("riderSettlements").doc(settlementId);
      const stlDoc = await stlRef.get();
      if (!stlDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Settlement ${settlementId} not found` } });
      }

      const stlData = stlDoc.data();
      if (stlData?.status === "closed") {
        return res.status(400).json({ success: false, error: { code: "SETTLEMENT_CLOSED", message: "Closed settlement cannot be modified." } });
      }
      if (stlData?.status === "manager_approved") {
        return res.status(400).json({ success: false, error: { code: "DUPLICATE_APPROVAL_REJECTED", message: "Settlement discrepancy is already approved." } });
      }

      if (stlData.riderId === req.auth.riderId || stlData.riderId === req.auth.uid) {
        return res.status(403).json({ success: false, error: { code: "SELF_APPROVAL_REJECTED", message: "Self-approval of discrepancy rejected." } });
      }

      const nowStr = new Date().toISOString();
      await stlRef.update({
        status: "manager_approved",
        discrepancyReason: discrepancyReason.trim(),
        approvedByUid: req.auth.uid,
        approvedAt: nowStr,
        updatedAt: nowStr
      });

      const auditRef = db.collection("financialAuditEvents").doc();
      await auditRef.set({
        id: auditRef.id,
        eventType: "SETTLEMENT_DISCREPANCY_APPROVED",
        entityType: "rider_settlement",
        entityId: settlementId,
        actorUid: req.auth.uid,
        details: { discrepancyReason: discrepancyReason.trim() },
        createdAt: nowStr
      });

      const updatedDoc = (await stlRef.get()).data();
      return res.json({ success: true, data: updatedDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Close Settlement
  app.post("/api/finance/settlements/close", requireAuth, requireRole("super_admin"), async (req: any, res: any) => {
    try {
      const { settlementId } = req.body;
      if (!settlementId) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing settlementId" } });
      }

      const stlRef = db.collection("riderSettlements").doc(settlementId);
      const stlDoc = await stlRef.get();
      if (!stlDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Settlement ${settlementId} not found` } });
      }

      const stlData = stlDoc.data();
      if (stlData?.status === "closed") {
        return res.status(400).json({ success: false, error: { code: "SETTLEMENT_ALREADY_CLOSED", message: "Settlement is already closed." } });
      }
      if (stlData?.status !== "manager_approved" && stlData?.status !== "cashier_received") {
        return res.status(400).json({ success: false, error: { code: "UNAPPROVED_DISCREPANCY", message: "Settlement with unapproved discrepancy cannot be closed." } });
      }

      const nowStr = new Date().toISOString();
      await stlRef.update({
        status: "closed",
        closedAt: nowStr,
        updatedAt: nowStr
      });

      const updatedDoc = (await stlRef.get()).data();
      return res.json({ success: true, data: updatedDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Get Rider Own Settlements
  app.get("/api/finance/settlements/me", requireAuth, requireExactRole("rider"), async (req: any, res: any) => {
    try {
      if (!req.auth.riderId) {
        return res.json({ success: true, data: [] });
      }
      const snap = await db.collection("riderSettlements").where("riderId", "==", req.auth.riderId).get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Get Settlements List
  app.get("/api/finance/settlements", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "cashier", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("riderSettlements").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Bank Deposit Create
  app.post("/api/finance/bank-deposits/create", requireAuth, requireExactRole("cashier"), async (req: any, res: any) => {
    try {
      const { bankAccountCode, depositedAmount, depositReference, depositDate, depositSlipStoragePath, idempotencyKey } = req.body;
      if (!bankAccountCode || !depositedAmount || depositedAmount <= 0 || !depositReference || !depositReference.trim()) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing required bank deposit fields" } });
      }

      const normRef = depositReference.trim();
      const depCheck = await db.collection("bankDeposits").where("depositReference", "==", normRef).get();
      if (!depCheck.empty) {
        return res.status(400).json({ success: false, error: { code: "DUPLICATE_DEPOSIT_REFERENCE", message: `Duplicate deposit reference "${normRef}" rejected.` } });
      }

      const depositId = `dep_${Date.now()}`;
      const idemKey = idempotencyKey || `idem_dep_${depositId}`;

      const txRes = await createDoubleEntryTransaction(db, {
        transactionType: "BANK_DEPOSIT",
        sourceType: "bank_deposit",
        sourceId: depositId,
        bankDepositId: depositId,
        cashierProfileId: req.auth.uid,
        idempotencyKey: idemKey,
        createdByUid: req.auth.uid,
        postings: [
          { accountCode: bankAccountCode, debitAmount: Number(depositedAmount), creditAmount: 0 },
          { accountCode: "CASHIER_CASH_CONTROL", debitAmount: 0, creditAmount: Number(depositedAmount) }
        ]
      });

      const nowStr = new Date().toISOString();
      const depositDoc = {
        id: depositId,
        cashierProfileId: req.auth.uid,
        bankAccountCode,
        depositedAmount: Number(depositedAmount),
        depositReference: normRef,
        depositDate: depositDate || nowStr.split("T")[0],
        depositSlipStoragePath: depositSlipStoragePath || null,
        depositedByUid: req.auth.uid,
        verifiedByUid: null,
        verifiedAt: null,
        discrepancyAmount: 0,
        discrepancyReason: null,
        status: "submitted",
        createdAt: nowStr
      };

      await db.collection("bankDeposits").doc(depositId).set(depositDoc);
      return res.json({ success: true, data: depositDoc });
    } catch (err: any) {
      const status = err.status || 400;
      return res.status(status).json({ success: false, error: { code: err.code || "DEPOSIT_FAILED", message: err.message } });
    }
  });

  // Bank Deposit Verify
  app.post("/api/finance/bank-deposits/verify", requireAuth, requireRole("super_admin"), async (req: any, res: any) => {
    try {
      const { bankDepositId, status, discrepancyAmount, discrepancyReason } = req.body;
      if (!bankDepositId || !status) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing bankDepositId or status" } });
      }

      const depRef = db.collection("bankDeposits").doc(bankDepositId);
      const depDoc = await depRef.get();
      if (!depDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Bank deposit ${bankDepositId} not found` } });
      }

      const depData = depDoc.data();
      if (depData?.depositedByUid === req.auth.uid) {
        return res.status(403).json({ success: false, error: { code: "SELF_VERIFICATION_REJECTED", message: "Cashier cannot verify their own bank deposit." } });
      }

      const nowStr = new Date().toISOString();
      await depRef.update({
        status,
        discrepancyAmount: discrepancyAmount || 0,
        discrepancyReason: discrepancyReason || null,
        verifiedByUid: req.auth.uid,
        verifiedAt: nowStr
      });

      const updatedDoc = (await depRef.get()).data();
      return res.json({ success: true, data: updatedDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Reports Summary
  app.get("/api/finance/reports/summary", requireAuth, requireAnyRole("super_admin", "cashier", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const postingsSnap = await db.collection("financialPostings").get();
      const allPostings = postingsSnap.docs.map(d => d.data());

      const riderDebits = allPostings.filter((p: any) => p.accountCode === "RIDER_CASH_WALLET").reduce((sum: number, p: any) => sum + (p.debitAmount || 0), 0);
      const riderCredits = allPostings.filter((p: any) => p.accountCode === "RIDER_CASH_WALLET").reduce((sum: number, p: any) => sum + (p.creditAmount || 0), 0);
      const riderCashExposure = Math.max(0, riderDebits - riderCredits);

      const cashierDebits = allPostings.filter((p: any) => p.accountCode === "CASHIER_CASH_CONTROL").reduce((sum: number, p: any) => sum + (p.debitAmount || 0), 0);
      const cashierCredits = allPostings.filter((p: any) => p.accountCode === "CASHIER_CASH_CONTROL").reduce((sum: number, p: any) => sum + (p.creditAmount || 0), 0);
      const cashierCashExposure = Math.max(0, cashierDebits - cashierCredits);

      const stlSnap = await db.collection("riderSettlements").where("status", "==", "discrepancy").get();
      const settlementDiscrepancies = stlSnap.size;

      const digSnap = await db.collection("digitalPaymentVerifications").where("status", "==", "pending").get();
      const digitalPendingVerification = digSnap.size;

      const depSnap = await db.collection("bankDeposits").where("status", "==", "discrepancy").get();
      const bankDepositDiscrepancies = depSnap.size;

      return res.json({
        success: true,
        data: {
          riderCashExposure,
          cashierCashExposure,
          unbankedCash: cashierCashExposure,
          settlementDiscrepancies,
          digitalPendingVerification,
          bankDepositDiscrepancies,
          cashAging: { pending24h: riderCashExposure, pending48h: 0, pending72h: 0 }
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- ANALYTICS ---
  app.get("/api/analytics/summary", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("packages").get();
      const orders = snap.docs.map(d => d.data());

      const totalOrders = orders.length;
      const delivered = orders.filter((o: any) => o.current_status === "delivered" || o.operationalStatus === "delivered");
      const returned = orders.filter((o: any) => o.current_status === "returned" || o.operationalStatus === "returned");
      const awaiting = orders.filter((o: any) => o.current_status === "imported_review" || o.operationalStatus === "imported_review");
      const inTransit = orders.filter((o: any) => o.current_status === "dispatched" || o.operationalStatus === "dispatched");

      const totalExpectedCod = orders.reduce((acc: number, o: any) => acc + (o.cod_expected || o.expectedCod || 0), 0);
      const totalCollectedCod = delivered.reduce((acc: number, o: any) => acc + (o.collectedAmount || o.cod_expected || o.expectedCod || 0), 0);

      return res.json({
        success: true,
        data: {
          totalOrders,
          importedToday: awaiting.length,
          awaitingAssignment: awaiting.length,
          handedToRiders: inTransit.length,
          outForDelivery: inTransit.length,
          deliveredToday: delivered.length,
          totalDelivered: delivered.length,
          totalReturned: returned.length,
          totalRescheduled: 0,
          successPercentage: totalOrders > 0 ? `${((delivered.length / totalOrders) * 100).toFixed(1)}%` : "0%",
          firstAttemptPercentage: "100%",
          totalExpectedCod,
          totalCollectedCod,
          totalSettledCod: 0,
          codHeldByRiders: inTransit.reduce((acc: number, o: any) => acc + (o.cod_expected || o.expectedCod || 0), 0),
          codDiscrepancies: 0,
          aging: { pending24: 0, pending48: 0, pending72: 0 }
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Helper for Idempotency
  async function checkIdempotency(db: any, idempotencyKey?: string) {
    if (!idempotencyKey || !idempotencyKey.trim()) return;
    const key = idempotencyKey.trim();
    const ref = db.collection("idempotencyKeys").doc(key);
    const doc = await ref.get();
    if (doc.exists) {
      throw { status: 400, code: "DUPLICATE_IDEMPOTENCY_KEY", message: `Duplicate request with idempotency key "${key}" rejected.` };
    }
    await ref.set({ id: key, createdAt: new Date().toISOString() });
  }

  // ==========================================
  // SPRINT 4: RETURNS, CS, EXCHANGES & COURIER
  // ==========================================

  // --- 1. RETURNS WORKFLOW ---

  // Rider Return Handback
  app.post("/api/returns/rider-handback", requireAuth, requireExactRole("rider"), requirePackageOwnership, async (req: any, res: any) => {
    try {
      const { packageId, scannedPackageNumber, returnReason, quantity, riderNotes, handoffEmployee, idempotencyKey } = req.body;
      if (!packageId || !scannedPackageNumber) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId or scannedPackageNumber" } });
      }

      await checkIdempotency(db, idempotencyKey);

      const pkgRef = db.collection("packages").doc(packageId);
      const pkgDoc = await pkgRef.get();
      if (!pkgDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Package ${packageId} not found` } });
      }

      const pkgData = pkgDoc.data();
      const realPkgNum = pkgData?.packageNumber || pkgData?.package_number || "";

      // Exact Barcode Matching Requirement
      if (scannedPackageNumber !== realPkgNum) {
        return res.status(400).json({
          success: false,
          error: { code: "EXACT_BARCODE_MATCH_REQUIRED", message: `Scanned barcode "${scannedPackageNumber}" does not match exact package number "${realPkgNum}". Partial barcode matching is strictly rejected.` }
        });
      }

      // Rider Security Check: Rider can only submit return handback for their own assigned package
      if (req.auth.role === 'rider') {
        const assignedRider = pkgData?.assignedRiderId;
        if (assignedRider !== req.auth.riderId) {
          return res.status(403).json({
            success: false,
            error: { code: "UNAUTHORIZED_RIDER_RETURN", message: "Rider may submit return handback only for their own assigned package." }
          });
        }
      }

      const currStatus = (pkgData?.operationalStatus || pkgData?.current_status || "").toLowerCase();
      if (currStatus === "delivered" || currStatus === "closed") {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_PACKAGE_STATUS", message: `Delivered or closed package cannot be handed back for return. Status: ${currStatus}` }
        });
      }

      // Check if duplicate return handback scan
      const returnId = `ret_${packageId}`;
      const existingRetDoc = await db.collection("returns").doc(returnId).get();
      if (existingRetDoc.exists && existingRetDoc.data()?.returnStatus === "rider_handed_back") {
        return res.json({
          success: true,
          data: existingRetDoc.data(),
          alreadyHandedBack: true,
          message: `Package ${realPkgNum} already handed back to hub warehouse.`
        });
      }

      const nowStr = new Date().toISOString();

      const returnData = {
        id: returnId,
        packageId,
        packageNumber: realPkgNum,
        riderId: req.auth.riderId,
        handoffEmployee: handoffEmployee || null,
        returnReason: returnReason || pkgData?.failureReason || "Failed Delivery Return",
        quantity: quantity || 1,
        riderNotes: riderNotes || null,
        returnStatus: "rider_handed_back",
        riderHandedBackAt: nowStr,
        createdAt: nowStr,
        updatedAt: nowStr
      };

      await db.collection("returns").doc(returnId).set(returnData, { merge: true });

      const custodyEventId = `cust_${Date.now()}_${Math.random().toString(36).substring(2,6)}`;
      await db.collection("returnCustodyEvents").doc(custodyEventId).set({
        id: custodyEventId,
        returnId,
        packageId,
        eventStage: "rider_handed_back",
        actorUid: req.auth.uid,
        actorRole: req.auth.role,
        handoffEmployee: handoffEmployee || null,
        timestamp: nowStr
      });

      await pkgRef.update({
        current_status: "Returning to Warehouse",
        operationalStatus: "returning_to_warehouse",
        custodyStage: "return_handed_back",
        updatedAt: nowStr
      });

      return res.json({ success: true, data: returnData });
    } catch (err: any) {
      const status = err.status || 400;
      return res.status(status).json({ success: false, error: { code: err.code || "HANDBACK_FAILED", message: err.message } });
    }
  });

  // Warehouse Return Receipt
  app.post("/api/returns/warehouse-receipt", requireAuth, requireRole("super_admin", "warehouse_staff"), async (req: any, res: any) => {
    try {
      const { packageId, scannedPackageNumber, receivedQuantity, packageCondition, restockable, conditionNotes, idempotencyKey } = req.body;

      if (!packageId || !scannedPackageNumber) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId or scannedPackageNumber" } });
      }

      await checkIdempotency(db, idempotencyKey);

      const pkgRef = db.collection("packages").doc(packageId);
      const pkgDoc = await pkgRef.get();
      if (!pkgDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Package ${packageId} not found` } });
      }

      const pkgData = pkgDoc.data();
      const realPkgNum = pkgData?.packageNumber || pkgData?.package_number || "";

      // Exact Barcode Matching Requirement
      if (scannedPackageNumber !== realPkgNum) {
        return res.status(400).json({
          success: false,
          error: { code: "EXACT_BARCODE_MATCH_REQUIRED", message: `Scanned barcode "${scannedPackageNumber}" does not match exact package number "${realPkgNum}". Partial barcode matching is strictly rejected.` }
        });
      }

      const returnId = `ret_${packageId}`;
      const retDoc = await db.collection("returns").doc(returnId).get();
      const retData = retDoc.exists ? retDoc.data() : null;

      const currentReturnStatus = retData?.returnStatus || pkgData?.custodyStage || "";

      // Check duplicate receipt
      const rcptCheck = await db.collection("returnReceipts").where("packageId", "==", packageId).get();
      if (!rcptCheck.empty || currentReturnStatus === "warehouse_received") {
        return res.status(400).json({
          success: false,
          error: { code: "DUPLICATE_WAREHOUSE_RECEIPT", message: `Warehouse receipt already recorded for package ${packageId}. Duplicate receipt rejected.` }
        });
      }

      // Custody Order Check: must be in return process (rider handed back or courier returning)
      const validReturnStages = ["rider_handed_back", "courier_returning", "returning_to_warehouse", "return_handed_back"];
      const opStatus = (pkgData?.operationalStatus || pkgData?.current_status || "").toLowerCase().replace(/[\s-]+/g, "_");
      const custodyStage = (pkgData?.custodyStage || "").toLowerCase().replace(/[\s-]+/g, "_");

      const isEligibleReturnStage = validReturnStages.includes(currentReturnStatus) ||
                                    validReturnStages.includes(opStatus) ||
                                    validReturnStages.includes(custodyStage);

      if (!isEligibleReturnStage) {
        return res.status(400).json({
          success: false,
          error: { code: "WRONG_CUSTODY_ORDER", message: `Warehouse receipt requested out of sequence. Current stage: "${currentReturnStatus || opStatus || custodyStage}". Package must be handed back by rider first.` }
        });
      }

      // Condition Notes validation for missing/damaged items
      const cond = (packageCondition || "sealed").toLowerCase();
      if ((cond === "damaged" || cond === "missing_item" || cond === "wrong_item") && (!conditionNotes || !conditionNotes.trim())) {
        return res.status(400).json({
          success: false,
          error: { code: "MISSING_CONDITION_NOTES", message: `Condition "${cond}" requires detailed condition notes.` }
        });
      }

      const nowStr = new Date().toISOString();
      const receiptId = `rcpt_${packageId}_${Date.now()}`;

      const receiptData = {
        id: receiptId,
        returnId,
        packageId,
        packageNumber: realPkgNum,
        receivedQuantity: Number(receivedQuantity) || 1,
        packageCondition: cond,
        restockable: restockable !== false,
        conditionNotes: conditionNotes ? conditionNotes.trim() : null,
        receivedByUid: req.auth.uid,
        receivedAt: nowStr,
        createdAt: nowStr
      };

      await db.collection("returnReceipts").doc(receiptId).set(receiptData);

      await db.collection("returns").doc(returnId).set({
        id: returnId,
        packageId,
        packageNumber: realPkgNum,
        returnStatus: "warehouse_received",
        warehouseReceivedAt: nowStr,
        updatedAt: nowStr
      }, { merge: true });

      const custodyEventId = `cust_${Date.now()}_${Math.random().toString(36).substring(2,6)}`;
      await db.collection("returnCustodyEvents").doc(custodyEventId).set({
        id: custodyEventId,
        returnId,
        packageId,
        eventStage: "warehouse_received",
        actorUid: req.auth.uid,
        actorRole: req.auth.role,
        timestamp: nowStr
      });

      await pkgRef.update({
        current_status: "Warehouse Received",
        operationalStatus: "warehouse_received",
        custodyStage: "warehouse_return_received",
        warehouseReceivedAt: nowStr,
        updatedAt: nowStr
      });

      // Automatically create a Customer Service Case for CS Review
      const csCaseId = `cs_${packageId}_${Date.now()}`;
      await db.collection("customerServiceCases").doc(csCaseId).set({
        id: csCaseId,
        packageId,
        packageNumber: realPkgNum,
        customerId: pkgData?.customerName || pkgData?.recipient_name || "Unknown",
        caseType: "failed_delivery_review",
        priority: cond === "damaged" ? "high" : "normal",
        status: "open",
        attemptCount: 0,
        createdAt: nowStr,
        updatedAt: nowStr
      });

      return res.json({ success: true, data: receiptData });
    } catch (err: any) {
      const status = err.status || 400;
      return res.status(status).json({ success: false, error: { code: err.code || "WAREHOUSE_RECEIPT_FAILED", message: err.message } });
    }
  });

  // Get Returns Workspace & List
  app.get("/api/returns/workspace", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "warehouse_staff", "customer_service", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("returns").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/returns/list", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "warehouse_staff", "customer_service", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("returns").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- 2. CUSTOMER SERVICE & REATTEMPTS ---

  // Get CS Queue & Cases
  app.get("/api/cs/queue", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "customer_service", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("customerServiceCases").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/cs/cases", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "customer_service", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("customerServiceCases").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Create CS Case
  app.post("/api/cs/cases", requireAuth, requireRole("customer_service", "super_admin", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const { packageId, customerId, caseType, priority, status, nextActionAt, ownerProfileId } = req.body;
      if (!packageId) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId" } });
      }

      const nowStr = new Date().toISOString();
      const caseId = `cs_${packageId}_${Date.now()}`;

      const caseDoc = {
        id: caseId,
        packageId,
        customerId: customerId || "Unknown",
        caseType: caseType || "delivery_exception",
        ownerProfileId: ownerProfileId || req.auth.uid,
        priority: priority || "normal",
        status: status || "open",
        nextActionAt: nextActionAt || null,
        attemptCount: 0,
        resolution: null,
        createdAt: nowStr,
        updatedAt: nowStr
      };

      await db.collection("customerServiceCases").doc(caseId).set(caseDoc);
      return res.json({ success: true, data: caseDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Get Contact Attempts
  app.get("/api/cs/contact-attempts", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "customer_service", "management_viewer"), async (req: any, res: any) => {
    try {
      const { caseId } = req.query;
      let snap;
      if (caseId) {
        snap = await db.collection("customerContactAttempts").where("caseId", "==", caseId).get();
      } else {
        snap = await db.collection("customerContactAttempts").get();
      }
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Log Contact Attempt
  app.post("/api/cs/contact-attempts", requireAuth, requireRole("customer_service", "super_admin", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const { caseId, packageId, channel, result, notes, nextAction } = req.body;
      if (!caseId || !channel || !result) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing caseId, channel, or result" } });
      }

      const nowStr = new Date().toISOString();
      const attemptId = `cnt_${caseId}_${Date.now()}`;

      const attemptDoc = {
        id: attemptId,
        caseId,
        packageId: packageId || null,
        channel,
        result,
        notes: notes || null,
        nextAction: nextAction || null,
        performedByUid: req.auth.uid,
        createdAt: nowStr
      };

      await db.collection("customerContactAttempts").doc(attemptId).set(attemptDoc);

      const caseRef = db.collection("customerServiceCases").doc(caseId);
      const caseDoc = await caseRef.get();
      if (caseDoc.exists) {
        const curAttempts = (caseDoc.data()?.attemptCount || 0) + 1;
        await caseRef.update({
          attemptCount: curAttempts,
          status: "contacting",
          updatedAt: nowStr
        });
      }

      return res.json({ success: true, data: attemptDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Schedule Reattempt
  app.post("/api/cs/reattempts", requireAuth, requireRole("customer_service", "super_admin", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const { packageId, caseId, newPromisedDeliveryDate, validAddress, customerConfirmationStatus, assignedCsOwner, reason } = req.body;

      if (!packageId) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId" } });
      }

      const pkgRef = db.collection("packages").doc(packageId);
      const pkgDoc = await pkgRef.get();
      if (!pkgDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Package ${packageId} not found` } });
      }

      const pkgData = pkgDoc.data();

      // 1. Unreceived return check: Returned package MUST be received by warehouse before scheduling reattempt
      const returnId = `ret_${packageId}`;
      const retDoc = await db.collection("returns").doc(returnId).get();
      const rcptSnap = await db.collection("returnReceipts").where("packageId", "==", packageId).get();
      const isWarehouseReceived = (retDoc.exists && retDoc.data()?.returnStatus === "warehouse_received") ||
        !rcptSnap.empty ||
        pkgData?.operationalStatus === "warehouse_received" ||
        pkgData?.custodyStage === "warehouse_return_received";

      if (!isWarehouseReceived) {
        return res.status(400).json({
          success: false,
          error: { code: "UNRECEIVED_RETURN_REATTEMPT_REJECTED", message: "Reattempt rejected for unreceived return package. Warehouse receipt required first." }
        });
      }

      // 2. Delivery Date validation
      if (!newPromisedDeliveryDate || !newPromisedDeliveryDate.trim()) {
        return res.status(400).json({
          success: false,
          error: { code: "MISSING_DELIVERY_DATE", message: "New promised delivery date required for reattempt." }
        });
      }

      // 3. Customer Confirmation Status check
      const confStatus = (customerConfirmationStatus || "").toLowerCase();
      const isConfirmed = confStatus.includes("confirm") || confStatus.includes("agree") || confStatus === "yes" || confStatus === "customer_confirmed";
      if (!isConfirmed) {
        return res.status(400).json({
          success: false,
          error: { code: "REATTEMPT_WITHOUT_CUSTOMER_CONFIRMATION", message: "Reattempt without explicit customer confirmation is strictly rejected." }
        });
      }

      // 4. Maximum attempt rule check
      const attemptsSnap = await db.collection("deliveryAttempts").where("packageId", "==", packageId).get();
      const priorAttemptsCount = attemptsSnap.size;
      if (priorAttemptsCount >= 3) {
        return res.status(400).json({
          success: false,
          error: { code: "MAX_ATTEMPTS_EXCEEDED", message: `Maximum delivery attempts limit (3) reached for package ${packageId}. Reattempt rejected.` }
        });
      }

      const nowStr = new Date().toISOString();
      const reattemptId = `reatt_${packageId}_${Date.now()}`;

      const reattemptDoc = {
        id: reattemptId,
        packageId,
        caseId: caseId || null,
        newPromisedDeliveryDate: newPromisedDeliveryDate.trim(),
        validAddress: validAddress ? validAddress.trim() : pkgData?.deliveryAddress || pkgData?.recipient_address || "Confirmed Address",
        customerConfirmationStatus: "customer_confirmed",
        assignedCsOwner: assignedCsOwner || req.auth.uid,
        reason: reason || "Customer Service Approved Reattempt",
        status: "scheduled",
        createdAt: nowStr,
        updatedAt: nowStr
      };

      await db.collection("reattemptRequests").doc(reattemptId).set(reattemptDoc);

      // Update package status to scheduled reattempt (preserving history, inactive until dispatch)
      await pkgRef.update({
        current_status: "Reattempt Scheduled",
        operationalStatus: "reattempt_scheduled",
        nextAttemptDate: newPromisedDeliveryDate.trim(),
        updatedAt: nowStr
      });

      if (caseId) {
        await db.collection("customerServiceCases").doc(caseId).update({
          status: "resolved",
          resolution: "Reattempt Scheduled",
          updatedAt: nowStr
        }).catch(() => {});
      }

      return res.json({ success: true, data: reattemptDoc });
    } catch (err: any) {
      const status = err.status || 400;
      return res.status(status).json({ success: false, error: { code: err.code || "REATTEMPT_FAILED", message: err.message } });
    }
  });

  // Create Exchange
  app.post("/api/cs/exchanges", requireAuth, requireRole("customer_service", "super_admin", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const { originalPackageId, exchangeReason, replacementItems, priceDifference, additionalCod, replacementPackageNumber } = req.body;

      if (!originalPackageId) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing originalPackageId" } });
      }

      const origPkgRef = db.collection("packages").doc(originalPackageId);
      const origPkgDoc = await origPkgRef.get();
      if (!origPkgDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Original package ${originalPackageId} not found` } });
      }

      const origPkgData = origPkgDoc.data();
      const origPkgNum = origPkgData?.packageNumber || origPkgData?.package_number;

      // Reject reusing the original physical package number for the replacement!
      if (replacementPackageNumber && replacementPackageNumber === origPkgNum) {
        return res.status(400).json({
          success: false,
          error: { code: "PACKAGE_NUMBER_REUSE_REJECTED", message: "Replacement package cannot reuse the original physical package number." }
        });
      }

      const nowStr = new Date().toISOString();
      const exchangeId = `ex_${originalPackageId}_${Date.now()}`;
      
      const newPackageNumber = replacementPackageNumber || `EX-${origPkgNum}-${Date.now().toString().slice(-6)}`;
      const newPackageId = buildPackageDocumentId(newPackageNumber);

      // Prevent replacement package-number collisions
      const existingPkgDoc = await db.collection("packages").doc(newPackageId).get();
      if (existingPkgDoc.exists) {
        return res.status(409).json({
          success: false,
          error: { code: "PACKAGE_NUMBER_ALREADY_EXISTS", message: `Replacement package ${newPackageNumber} already exists.` }
        });
      }

      const addCod = Number(additionalCod) || Number(priceDifference) || 0;

      // Create replacement package
      const replacementPackageDoc = {
        ...origPkgData,
        id: newPackageId,
        packageId: newPackageId,
        packageNumber: newPackageNumber,
        package_number: newPackageNumber,
        parentOrderNumber: origPkgData?.parentOrderNumber || origPkgData?.order_number || origPkgNum,
        originalPackageId,
        cod_expected: addCod,
        expectedCod: addCod,
        current_status: "Imported Review",
        operationalStatus: "imported_review",
        custodyStage: "warehouse_prepared",
        assignedRiderId: null,
        createdAt: nowStr,
        updatedAt: nowStr
      };

      await db.collection("packages").doc(newPackageId).set(replacementPackageDoc);

      const exchangeDoc = {
        id: exchangeId,
        originalPackageId,
        replacementPackageId: newPackageId,
        exchangeReason: exchangeReason || "Customer Requested Exchange",
        priceDifference: Number(priceDifference) || 0,
        additionalCod: addCod,
        status: "approved",
        createdByUid: req.auth.uid,
        createdAt: nowStr,
        updatedAt: nowStr
      };

      await db.collection("exchanges").doc(exchangeId).set(exchangeDoc);

      await db.collection("exchangePackages").doc(`exp_${exchangeId}`).set({
        id: `exp_${exchangeId}`,
        exchangeId,
        originalPackageId,
        replacementPackageId: newPackageId,
        replacementItems: replacementItems || [],
        createdAt: nowStr
      });

      // Mark original package return as exchange_created
      const returnId = `ret_${originalPackageId}`;
      await db.collection("returns").doc(returnId).set({
        id: returnId,
        packageId: originalPackageId,
        returnStatus: "exchange_created",
        exchangeId,
        updatedAt: nowStr
      }, { merge: true });

      return res.json({ success: true, data: { exchange: exchangeDoc, replacementPackage: replacementPackageDoc } });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- 3. EXTERNAL COURIER RECONCILIATION ---

  // Get Courier Shipments
  app.get("/api/courier/shipments", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "cashier", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("courierShipments").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Create Courier Shipment
  app.post("/api/courier/shipments", requireAuth, requireAnyRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const { packageId, courierCompanyId, trackingNumber, manifestId, expectedCod } = req.body;
      if (!packageId || !courierCompanyId || !trackingNumber) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId, courierCompanyId, or trackingNumber" } });
      }

      const normTracking = trackingNumber.trim();

      // Unique tracking number per courier validation
      const trkCheck = await db.collection("courierShipments")
        .where("courierCompanyId", "==", courierCompanyId)
        .where("trackingNumber", "==", normTracking)
        .get();

      if (!trkCheck.empty) {
        return res.status(400).json({
          success: false,
          error: { code: "DUPLICATE_TRACKING_NUMBER", message: `Tracking number "${normTracking}" already exists for this courier company.` }
        });
      }

      const pkgRef = db.collection("packages").doc(packageId);
      const pkgDoc = await pkgRef.get();
      if (!pkgDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Package ${packageId} not found` } });
      }

      const pkgData = pkgDoc.data();
      const expCod = expectedCod !== undefined ? Number(expectedCod) : Number(pkgData?.cod_expected || pkgData?.expectedCod || 0);
      const nowStr = new Date().toISOString();
      const shipmentId = `cshp_${packageId}_${Date.now()}`;

      const shipmentDoc = {
        id: shipmentId,
        packageId,
        courierCompanyId,
        trackingNumber: normTracking,
        manifestId: manifestId || null,
        dispatchedAt: nowStr,
        courierStatus: "dispatched",
        expectedCod: expCod,
        collectedCod: 0,
        createdAt: nowStr,
        updatedAt: nowStr
      };

      await db.collection("courierShipments").doc(shipmentId).set(shipmentDoc);

      await pkgRef.update({
        deliveryChannel: "External Courier",
        courierTrackingNumber: normTracking,
        courierCompanyId,
        current_status: "Handed to Courier",
        operationalStatus: "handed_to_courier",
        updatedAt: nowStr
      });

      return res.json({ success: true, data: shipmentDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Courier Confirm Delivery & Post Financial Receivables
  app.post("/api/courier/shipments/confirm-delivery", requireAuth, requireAnyRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const { packageId, trackingNumber, collectedCod, idempotencyKey } = req.body;
      if (!packageId) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId" } });
      }

      await checkIdempotency(db, idempotencyKey);

      const pkgRef = db.collection("packages").doc(packageId);
      const pkgDoc = await pkgRef.get();
      if (!pkgDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Package ${packageId} not found` } });
      }

      const pkgData = pkgDoc.data();
      const collAmt = Number(collectedCod) || Number(pkgData?.cod_expected || pkgData?.expectedCod || 0);

      const shpSnap = await db.collection("courierShipments").where("packageId", "==", packageId).get();
      if (!shpSnap.empty) {
        const shpId = shpSnap.docs[0].id;
        await db.collection("courierShipments").doc(shpId).update({
          courierStatus: "delivered",
          collectedCod: collAmt,
          updatedAt: new Date().toISOString()
        });
      }

      const nowStr = new Date().toISOString();
      const idemKey = idempotencyKey || `idem_cour_del_${packageId}_${Date.now()}`;

      // Financial Posting: Debit EXTERNAL_COURIER_RECEIVABLE, Credit CUSTOMER_COD_RECEIVABLE
      const txRes = await createDoubleEntryTransaction(db, {
        transactionType: "COURIER_DELIVERY_RECEIVABLE",
        sourceType: "courier_shipment",
        sourceId: packageId,
        packageId,
        idempotencyKey: idemKey,
        createdByUid: req.auth.uid,
        postings: [
          { accountCode: "EXTERNAL_COURIER_RECEIVABLE", debitAmount: collAmt, creditAmount: 0 },
          { accountCode: "CUSTOMER_COD_RECEIVABLE", debitAmount: 0, creditAmount: collAmt }
        ]
      });

      await pkgRef.update({
        current_status: "Delivered",
        operationalStatus: "delivered",
        courierStatus: "delivered",
        collectedAmount: collAmt,
        updatedAt: nowStr
      });

      return res.json({ success: true, data: { packageId, courierStatus: "delivered", transactionId: txRes.transactionId } });
    } catch (err: any) {
      const status = err.status || 400;
      return res.status(status).json({ success: false, error: { code: err.code || "CONFIRMATION_FAILED", message: err.message } });
    }
  });

  // Get Courier Manifests
  app.get("/api/courier/manifests", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "cashier", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("courierManifests").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Create Courier Manifest
  app.post("/api/courier/manifests", requireAuth, requireRole("dispatch_manager", "super_admin"), async (req: any, res: any) => {
    try {
      const { courierCompanyId, packageIds, manifestReference, dispatchDate } = req.body;
      if (!courierCompanyId || !packageIds || !Array.isArray(packageIds)) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing courierCompanyId or packageIds" } });
      }

      const manifestId = `man_${Date.now()}`;
      const nowStr = new Date().toISOString();

      const manifestDoc = {
        id: manifestId,
        courierCompanyId,
        manifestReference: manifestReference || `MAN-${Date.now().toString().slice(-6)}`,
        dispatchDate: dispatchDate || nowStr.split("T")[0],
        packageCount: packageIds.length,
        packageIds,
        createdByUid: req.auth.uid,
        createdAt: nowStr
      };

      await db.collection("courierManifests").doc(manifestId).set(manifestDoc);
      return res.json({ success: true, data: manifestDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Get Courier Remittances
  app.get("/api/courier/remittances", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "cashier", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("courierRemittanceBatches").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Post Courier Remittance Batch
  app.post("/api/courier/remittances/create", requireAuth, requireRole("super_admin"), async (req: any, res: any) => {
    try {
      const {
        courierCompanyId,
        statementReference,
        statementDate,
        grossCod,
        deliveryCharges,
        returnCharges,
        otherDeductions,
        actualRemittedAmount,
        bankReference,
        remittanceLines,
        idempotencyKey
      } = req.body;

      if (!courierCompanyId || !statementReference || !statementReference.trim()) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing courierCompanyId or statementReference" } });
      }

      const normStmtRef = statementReference.trim();

      // 1. Duplicate Statement Reference Check
      const stmtCheck = await db.collection("courierRemittanceBatches").where("statementReference", "==", normStmtRef).get();
      if (!stmtCheck.empty) {
        return res.status(400).json({
          success: false,
          error: { code: "DUPLICATE_STATEMENT_REFERENCE", message: `Duplicate courier statement reference "${normStmtRef}" rejected.` }
        });
      }

      // 2. Duplicate Bank Reference Check
      if (bankReference && bankReference.trim()) {
        const bankRefClean = bankReference.trim();
        const bankCheck = await db.collection("courierRemittanceBatches").where("bankReference", "==", bankRefClean).get();
        if (!bankCheck.empty) {
          return res.status(400).json({
            success: false,
            error: { code: "DUPLICATE_BANK_REFERENCE", message: `Duplicate bank reference "${bankRefClean}" rejected.` }
          });
        }
      }

      await checkIdempotency(db, idempotencyKey);

      // 3. Validate Remittance Lines
      const lines = Array.isArray(remittanceLines) ? remittanceLines : [];
      for (const line of lines) {
        const pkgId = line.packageId;
        if (pkgId) {
          const pkgDoc = await db.collection("packages").doc(pkgId).get();
          if (pkgDoc.exists) {
            const pkgData = pkgDoc.data();
            const channel = (pkgData?.deliveryChannel || pkgData?.delivery_channel || "").toLowerCase().replace(/[\s_]+/g, "");

            // Reject remittance against internal rider package!
            if (channel.includes("internalrider") || channel === "internal") {
              return res.status(400).json({
                success: false,
                error: { code: "INTERNAL_RIDER_REMITTANCE_REJECTED", message: `Package ${pkgId} is an internal rider package. Remittance against an internal rider package rejected.` }
              });
            }

            // Reject remittance against undelivered package!
            const opStatus = (pkgData?.operationalStatus || pkgData?.current_status || "").toLowerCase();
            const courStatus = (pkgData?.courierStatus || "").toLowerCase();
            if (opStatus !== "delivered" && courStatus !== "delivered") {
              return res.status(400).json({
                success: false,
                error: { code: "UNDELIVERED_PACKAGE_REMITTANCE_REJECTED", message: `Package ${pkgId} is not delivered. Remittance against an undelivered courier package rejected.` }
              });
            }
          }
        }
      }

      const batchId = `rem_${Date.now()}`;
      const nowStr = new Date().toISOString();
      const gross = Number(grossCod) || 0;
      const delFee = Number(deliveryCharges) || 0;
      const retFee = Number(returnCharges) || 0;
      const othDed = Number(otherDeductions) || 0;
      const actualAmt = Number(actualRemittedAmount) || (gross - delFee - retFee - othDed);

      // Financial Posting
      const idemKey = idempotencyKey || `idem_rem_${batchId}`;
      const txRes = await createDoubleEntryTransaction(db, {
        transactionType: "COURIER_REMITTANCE",
        sourceType: "courier_remittance_batch",
        sourceId: batchId,
        idempotencyKey: idemKey,
        createdByUid: req.auth.uid,
        postings: [
          { accountCode: "BANK_ACCOUNT", debitAmount: actualAmt, creditAmount: 0 },
          { accountCode: "COD_DISCREPANCY", debitAmount: delFee + retFee + othDed, creditAmount: 0 },
          { accountCode: "EXTERNAL_COURIER_RECEIVABLE", debitAmount: 0, creditAmount: gross }
        ]
      });

      const batchDoc = {
        id: batchId,
        courierCompanyId,
        statementReference: normStmtRef,
        statementDate: statementDate || nowStr.split("T")[0],
        grossCod: gross,
        deliveryCharges: delFee,
        returnCharges: retFee,
        otherDeductions: othDed,
        actualRemittedAmount: actualAmt,
        bankReference: bankReference ? bankReference.trim() : null,
        status: "posted",
        transactionId: txRes.transactionId,
        createdByUid: req.auth.uid,
        createdAt: nowStr
      };

      await db.collection("courierRemittanceBatches").doc(batchId).set(batchDoc);

      for (const l of lines) {
        const lineId = `remline_${batchId}_${l.packageId || Date.now()}`;
        await db.collection("courierRemittanceLines").doc(lineId).set({
          id: lineId,
          batchId,
          packageId: l.packageId || null,
          trackingNumber: l.trackingNumber || null,
          collectedCod: Number(l.collectedCod) || 0,
          deliveryFee: Number(l.deliveryFee) || 0,
          createdAt: nowStr
        });
      }

      return res.json({ success: true, data: batchDoc });
    } catch (err: any) {
      const status = err.status || 400;
      return res.status(status).json({ success: false, error: { code: err.code || "REMITTANCE_FAILED", message: err.message } });
    }
  });

  // Post Courier Deduction
  app.post("/api/courier/deductions", requireAuth, requireRole("super_admin"), async (req: any, res: any) => {
    try {
      const { batchId, packageId, deductionType, amount, courierExplanation, supportingDocumentPath } = req.body;

      if (!deductionType || !amount || Number(amount) <= 0 || !courierExplanation || !courierExplanation.trim()) {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_DEDUCTION", message: "Courier deduction requires a valid deductionType, positive amount, and detailed courier explanation." }
        });
      }

      const nowStr = new Date().toISOString();
      const deductionId = `ded_${Date.now()}`;

      const deductionDoc = {
        id: deductionId,
        batchId: batchId || null,
        packageId: packageId || null,
        deductionType,
        amount: Number(amount),
        courierExplanation: courierExplanation.trim(),
        supportingDocumentPath: supportingDocumentPath || null,
        approvedByUid: req.auth.uid,
        status: "approved",
        createdAt: nowStr
      };

      await db.collection("courierDeductions").doc(deductionId).set(deductionDoc);
      return res.json({ success: true, data: deductionDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Track / Close Courier Return
  app.post("/api/courier/returns", requireAuth, requireRole("dispatch_manager", "super_admin", "warehouse_staff"), async (req: any, res: any) => {
    try {
      const { packageId, courierCompanyId, returnReason, status } = req.body;
      if (!packageId) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId" } });
      }

      if (status === "closed") {
        // Check if warehouse receipt scan exists for this package
        const rcptSnap = await db.collection("returnReceipts").where("packageId", "==", packageId).get();
        if (rcptSnap.empty) {
          return res.status(400).json({
            success: false,
            error: { code: "COURIER_RETURN_CLOSED_WITHOUT_WAREHOUSE_RECEIPT", message: "Courier return cannot be closed without an authorized warehouse receipt scan." }
          });
        }
      }

      const nowStr = new Date().toISOString();
      const returnId = `cret_${packageId}_${Date.now()}`;

      const returnDoc = {
        id: returnId,
        packageId,
        courierCompanyId: courierCompanyId || null,
        returnReason: returnReason || "Courier Delivery Failed",
        status: status || "courier_returning",
        createdAt: nowStr,
        updatedAt: nowStr
      };

      await db.collection("courierReturns").doc(returnId).set(returnDoc);
      return res.json({ success: true, data: returnDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- 4. OPERATIONAL WORKSPACES & REPORTS ---

  // Courier Workspace Summary
  app.get("/api/courier/workspace", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "cashier", "management_viewer"), async (req: any, res: any) => {
    try {
      const shipmentsSnap = await db.collection("courierShipments").get();
      const shipments = shipmentsSnap.docs.map(d => d.data());

      const batchesSnap = await db.collection("courierRemittanceBatches").get();
      const batches = batchesSnap.docs.map(d => d.data());

      const unremittedShipments = shipments.filter(s => s.courierStatus === "delivered" && !s.remitted);
      const unremittedCod = unremittedShipments.reduce((sum, s) => sum + (s.collectedCod || s.expectedCod || 0), 0);

      return res.json({
        success: true,
        data: {
          summary: {
            totalShipments: shipments.length,
            unremittedCount: unremittedShipments.length,
            unremittedCod,
            totalRemittanceBatches: batches.length
          },
          shipments,
          batches
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // Reports
  app.get("/api/reports/returns-awaiting-warehouse", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("returns").where("returnStatus", "==", "rider_handed_back").get();
      return res.json({ success: true, data: snap.docs.map(d => d.data()) });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/reports/failed-awaiting-cs", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("customerServiceCases").where("status", "==", "open").get();
      return res.json({ success: true, data: snap.docs.map(d => d.data()) });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/reports/reattempt-due-today", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const todayStr = new Date().toISOString().split("T")[0];
      const snap = await db.collection("reattemptRequests").get();
      const list = snap.docs.map(d => d.data()).filter(r => r.newPromisedDeliveryDate && r.newPromisedDeliveryDate.startsWith(todayStr));
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/reports/repeated-refusals", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("deliveryAttempts").where("status", "==", "refused").get();
      const list = snap.docs.map(d => d.data());
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/reports/courier-unremitted", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("courierShipments").get();
      const list = snap.docs.map(d => d.data()).filter(s => s.courierStatus === "delivered" && !s.remitted);
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/reports/courier-remittance-aging", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("courierShipments").get();
      const list = snap.docs.map(d => d.data()).filter(s => s.courierStatus === "delivered" && !s.remitted);
      const totalUnremitted = list.reduce((sum, s) => sum + (s.collectedCod || s.expectedCod || 0), 0);
      return res.json({
        success: true,
        data: {
          aging: {
            current15Days: totalUnremitted,
            days16To30: 0,
            over30Days: 0
          },
          unremittedCount: list.length,
          totalUnremittedAmount: totalUnremitted
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.get("/api/reports/courier-deductions", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "management_viewer"), async (req: any, res: any) => {
    try {
      const snap = await db.collection("courierDeductions").get();
      return res.json({ success: true, data: snap.docs.map(d => d.data()) });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  // --- LOGISTICS HUB API ---
  app.use("/api/logistics", createLogisticsRouter(db, requireAuth, requireRole));

  // --- SUPER ADMIN USER MANAGEMENT API ---
  app.use("/api/admin", createAdminUserRouter(db, adminAuth, requireAuth, requireExactRole, adminUserTestHooks));

  // --- SHOPIFY DIRECT INTEGRATION API ---
  const shopifyRouter = createShopifyRouter({ db, requireAuth, requireRole, requireAnyRole });
  app.use("/api/shopify", shopifyRouter);
  app.use("/api/integrations/shopify", shopifyRouter);

  // --- MASTER DATA ---
  app.get("/api/master-data", requireAuth, (req: any, res: any) => {
    res.json({
      success: true,
      data: {
        cities: ["Lahore", "Karachi", "Islamabad", "Rawalpindi", "Faisalabad"],
        zones: {
          "Lahore": ["Gulberg III", "DHA Phase 5", "Johar Town Phase 2", "Model Town", "Garden Town", "Cantt"],
          "Karachi": ["Clifton Block 4", "DHA Phase 6", "North Nazimabad", "PECHS Block 2", "Gulshan-e-Iqbal"],
          "Islamabad": ["F-7/2", "F-8/4", "G-11/3", "E-11/2", "Blue Area"],
          "Rawalpindi": ["Saddar", "Satellite Town", "Bahria Town Phase 4", "Askari 14"],
          "Faisalabad": ["People's Colony 1", "Civil Lines", "Canal Park"]
        },
        vehicles: ["Motorbike", "Cargo Rickshaw", "Van", "Bicycle"],
        delivery_statuses: ["imported_review", "dispatched", "delivered", "returned", "awaiting_return"],
        failure_reasons: ["Customer Unavailable - Phone Unanswered", "Customer Requested Reschedule", "Refused - Size / Fit Issue", "Refused - Order Cancelled", "Incorrect Address / Location", "Customer Refused COD Amount"],
        payment_methods: ["Cash", "JazzCash", "Easypaisa", "Bank transfer", "Card or prepaid", "External courier receivable"]
      }
    });
  });

  return app;
}

export async function startServer() {
  const app = createApp();

  // Vite Middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  return app.listen(PORT, "0.0.0.0", () => {
    console.log(`Gomila Logistics Server running on http://localhost:${PORT}`);
  });
}

if (process.argv[1] && (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.cjs") || process.argv[1].endsWith("server.js"))) {
  startServer();
}
