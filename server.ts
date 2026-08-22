import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import { processOMSImportRows, calculateSHA256, buildPackageDocumentId } from "./src/services/csvImporter.js";
import { approveCodAllocationAuthority, assignPackageAuthority, recordDeliveryAttemptAuthority, transferAssignmentAuthority } from "./src/services/logisticsAuthority.js";
import { createLogisticsRouter } from "./src/server/logisticsRouter.js";
import { createAdminUserRouter, AdminUserTestHooks } from "./src/server/adminUserRouter.js";
import { createShopifyRouter } from "./src/server/shopifyRouter.js";
import { createManagementRouter } from "./src/server/managementRouter.js";
import { enqueueShopifyOutboundEvent, enqueueShopifyPackageEvent } from "./src/services/shopifyOutbound.js";

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
const adminStorage = getStorage();

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

function normalizeDigitalReference(reference: string) {
  return reference.trim().toUpperCase().replace(/[\s-]+/g, "");
}

function isValidCoordinate(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

function isDataUrl(value: string | undefined | null) {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("data:");
}

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

function getAsiaKarachiDayRange(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const dayString = `${year}-${month}-${day}`;
  return {
    dayString,
    startIso: `${dayString}T00:00:00+05:00`,
    endIso: `${dayString}T23:59:59.999+05:00`
  };
}

function isIsoWithinRange(value: unknown, startIso: string, endIso: string) {
  if (typeof value !== "string" || !value.trim()) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts >= Date.parse(startIso) && ts <= Date.parse(endIso);
}

function isPackageStateBlockedForManifest(statusValue: unknown) {
  const normalized = String(statusValue || "").toLowerCase().replace(/[\s-]+/g, "_");
  return [
    "cancelled",
    "customer_cancelled",
    "delivered",
    "return_required",
    "returning_to_warehouse",
    "returned",
    "transferred"
  ].includes(normalized);
}

function buildSettlementResolutionPostings(settlement: any, resolutionType: string) {
  const variance = Number(settlement.totalSettlementVariance ?? settlement.discrepancyAmount ?? 0);
  const amount = Math.abs(variance);
  if (amount <= 0) {
    throw { status: 400, code: "NO_OPEN_DISCREPANCY", message: "Settlement has no open discrepancy to resolve." };
  }

  if (variance < 0) {
    if (resolutionType === "RECOVERED_FROM_RIDER") {
      return [
        { accountCode: "CASHIER_CASH_CONTROL", debitAmount: amount, creditAmount: 0 },
        { accountCode: "RIDER_CASH_WALLET", debitAmount: 0, creditAmount: amount }
      ];
    }
    if (resolutionType === "APPROVED_WRITE_OFF") {
      return [
        { accountCode: "APPROVED_WRITE_OFF", debitAmount: amount, creditAmount: 0 },
        { accountCode: "RIDER_CASH_WALLET", debitAmount: 0, creditAmount: amount }
      ];
    }
    if (resolutionType === "ACCOUNTING_CORRECTION" || resolutionType === "SYSTEM_CORRECTION") {
      return [
        { accountCode: "COD_DISCREPANCY", debitAmount: amount, creditAmount: 0 },
        { accountCode: "RIDER_CASH_WALLET", debitAmount: 0, creditAmount: amount }
      ];
    }
    throw { status: 400, code: "INVALID_RESOLUTION_TYPE", message: `Resolution type "${resolutionType}" is not valid for a shortage.` };
  }

  if (resolutionType === "ACCOUNTING_CORRECTION" || resolutionType === "SYSTEM_CORRECTION") {
    return [
      { accountCode: "RIDER_CASH_WALLET", debitAmount: amount, creditAmount: 0 },
      { accountCode: "COD_DISCREPANCY", debitAmount: 0, creditAmount: amount }
    ];
  }

  throw { status: 400, code: "INVALID_RESOLUTION_TYPE", message: `Resolution type "${resolutionType}" is not valid for an excess.` };
}

const DIGITAL_PAYMENT_STATUSES = ["PENDING", "VERIFIED", "MISMATCH", "REJECTED"] as const;
const COLLECTION_DISCREPANCY_REASONS = [
  "CUSTOMER_SHORT_PAYMENT_APPROVED",
  "ORDER_VALUE_CORRECTION",
  "DISCOUNT_CORRECTION",
  "RIDER_UNDERCOLLECTION",
  "RIDER_OVERCOLLECTION",
  "SYSTEM_ERROR"
] as const;

function normalizeIsoDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function buildCollectionDiscrepancyStatus(details: {
  collectionVariance: number;
  riderHandoverVariance: number;
  cashierVariance: number;
  unresolvedCollectionDiscrepancyCount: number;
}) {
  const totalSettlementVariance = Number(details.collectionVariance || 0) + Number(details.riderHandoverVariance || 0) + Number(details.cashierVariance || 0);
  const unresolvedCollectionVariance = Number(details.unresolvedCollectionDiscrepancyCount || 0) > 0;
  const requiresResolution = unresolvedCollectionVariance || totalSettlementVariance !== 0;
  const discrepancyType = unresolvedCollectionVariance
    ? "COLLECTION_VARIANCE"
    : totalSettlementVariance < 0
      ? "SHORT"
      : totalSettlementVariance > 0
        ? "EXCESS"
        : Number(details.cashierVariance || 0) !== 0
          ? "DECLARATION_MISMATCH"
          : "NONE";
  return {
    totalSettlementVariance,
    unresolvedCollectionVariance,
    requiresResolution,
    discrepancyType
  };
}

async function verifyDeliveryProofStorageObject(params: {
  uid: string;
  attemptId: string;
  proofStoragePath: string;
}) {
  const normalizedPath = String(params.proofStoragePath || "").trim();
  if (!normalizedPath) {
    throw { status: 400, code: "PROOF_STORAGE_PATH_REQUIRED", message: "Delivered status requires a Firebase Storage proof path." };
  }

  const expectedPrefix = `deliveryProofs/${params.uid}/${params.attemptId}/`;
  if (!normalizedPath.startsWith(expectedPrefix)) {
    throw {
      status: 400,
      code: "INVALID_PROOF_STORAGE_PATH",
      message: `Proof storage path must start with "${expectedPrefix}".`
    };
  }

  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
  const maxBytes = 10 * 1024 * 1024;

  try {
    const bucket = adminStorage.bucket();
    const file = bucket.file(normalizedPath);
    const [exists] = await file.exists();
    if (!exists) {
      throw { status: 400, code: "PROOF_FILE_NOT_FOUND", message: "Uploaded delivery proof file does not exist in Storage." };
    }
    const [metadata] = await file.getMetadata();
    const contentType = String(metadata.contentType || "").toLowerCase();
    const size = Number(metadata.size || 0);
    if (!allowedTypes.has(contentType)) {
      throw { status: 400, code: "INVALID_PROOF_CONTENT_TYPE", message: `Proof content type "${contentType || "unknown"}" is not allowed.` };
    }
    if (!(size > 0) || size > maxBytes) {
      throw { status: 400, code: "INVALID_PROOF_FILE_SIZE", message: "Proof file size is invalid or exceeds the permitted limit." };
    }
    return { contentType, size };
  } catch (err: any) {
    if (err?.code) throw err;
    throw { status: 500, code: "PROOF_STORAGE_VALIDATION_FAILED", message: err.message || "Unable to validate delivery proof in Storage." };
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
    const existingIdem = await t.get(idemRef);
    if (existingIdem.exists) {
      throw { status: 409, code: "DUPLICATE_IDEMPOTENCY_KEY", message: `Duplicate idempotency key "${params.idempotencyKey}" rejected` };
    }

    t.set(idemRef, {
      key: params.idempotencyKey,
      action: params.transactionType,
      result: {
        transactionId: txId,
        sourceType: params.sourceType,
        sourceId: params.sourceId
      },
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
  const jsonVerify = (req: any, _res: any, buf: Buffer) => {
    req.rawBody = Buffer.from(buf);
  };
  const largeJsonParser = express.json({ limit: "50mb", verify: jsonVerify });
  const largeUrlencodedParser = express.urlencoded({ extended: true, limit: "50mb" });
  app.use(
    ["/api/import", "/api/import-batches", "/api/logistics/import"],
    largeJsonParser,
    largeUrlencodedParser
  );

  // Default global body limits (2mb)
  app.use(express.json({ limit: "2mb", verify: jsonVerify }));
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
      await approveCodAllocationAuthority({
        db,
        reviewId,
        allocations,
        actorUid: req.auth.uid
      });

      return res.json({ success: true, data: { message: "COD allocation approved atomically" } });
    } catch (err: any) {
      const status = err.status || 409;
      return res.status(status).json({ success: false, error: { code: err.code || "TRANSACTION_FAILED", message: err.message } });
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
      const result = await assignPackageAuthority({
        db,
        packageId,
        riderId,
        actorUid: req.auth.uid
      });
      void enqueueShopifyPackageEvent(db, {
        packageId,
        eventType: "PACKAGE_ASSIGNED",
        payload: { riderId, assignedByUid: req.auth.uid },
        idempotencyKey: `assign:${packageId}:${riderId}:${result?.assignedAt || "current"}`
      }).catch((error) => console.error("Shopify assignment write-back enqueue failed", error));
      return res.json({ success: true, data: result });
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

      for (const assignedPackageId of assignedResults) {
        void enqueueShopifyPackageEvent(db, {
          packageId: assignedPackageId,
          eventType: "PACKAGE_ASSIGNED",
          payload: { riderId, assignedByUid: req.auth.uid },
          idempotencyKey: `bulk-assign:${assignedPackageId}:${riderId}:${nowStr}`
        }).catch((error) => console.error("Shopify bulk assignment write-back enqueue failed", error));
      }

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
    const { packageId, destinationRiderId, transferReason } = req.body;
    if (!packageId || !destinationRiderId) {
      return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId or destinationRiderId" } });
    }

    if (!transferReason || typeof transferReason !== "string" || !transferReason.trim()) {
      return res.status(400).json({ success: false, error: { code: "TRANSFER_REASON_REQUIRED", message: "Transfer reason is required" } });
    }

    try {
      const result = await transferAssignmentAuthority({
        db,
        packageId,
        destinationRiderId,
        transferReason,
        actorUid: req.auth.uid,
        actorRole: req.auth.role,
        actorRiderId: req.auth.riderId
      });
      void enqueueShopifyPackageEvent(db, {
        packageId,
        eventType: "PACKAGE_TRANSFERRED",
        payload: { destinationRiderId, transferReason, transferredByUid: req.auth.uid },
        idempotencyKey: `transfer:${packageId}:${destinationRiderId}:${result?.transferredAt || "current"}`
      }).catch((error) => console.error("Shopify transfer write-back enqueue failed", error));
      return res.json({ success: true, data: result });
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

      const runUuid = crypto.randomUUID();
      const runId = `run_${runUuid}`;
      const runNumber = `RUN-${runUuid.slice(0, 8).toUpperCase()}`;
      const nowStr = new Date().toISOString();
      let runData: any;

      await db.runTransaction(async (transaction: any) => {
        let expectedCod = 0;
        const packageRefs = packageIds.map((pkgId: string) => db.collection("packages").doc(pkgId));
        const packageDocs = await Promise.all(packageRefs.map((pkgRef: any) => transaction.get(pkgRef)));

        for (let index = 0; index < packageIds.length; index++) {
          const pkgId = packageIds[index];
          const pkgDoc = packageDocs[index];
          if (!pkgDoc.exists) {
            throw { status: 404, code: "PACKAGE_NOT_FOUND", message: `Package ${pkgId} not found` };
          }

          const d = pkgDoc.data();
          if (!d?.assignedRiderId || d.assignedRiderId !== riderId) {
            throw {
              status: 400,
              code: "WRONG_RIDER_PACKAGE",
              message: `Package ${pkgId} is ${d?.assignedRiderId ? `assigned to rider ${d.assignedRiderId}` : "not assigned to any rider"}, but run is for rider ${riderId}`
            };
          }

          const currStatus = (d?.operationalStatus || d?.current_status || "").toUpperCase();
          if (["DELIVERED", "RETURNED", "CANCELLED", "CLOSED", "RETURNING_TO_WAREHOUSE"].includes(currStatus)) {
            throw { status: 400, code: "INVALID_PACKAGE_STATUS", message: `Package ${pkgId} is in completed status ${currStatus}` };
          }

          if (d?.activeDispatchRunId && d.activeDispatchRunId !== runId) {
            throw { status: 400, code: "PACKAGE_IN_ACTIVE_RUN", message: `Package ${pkgId} is already in active dispatch run ${d.activeDispatchRunId}` };
          }

          expectedCod += Number(d?.cod_expected || d?.expectedCod || d?.codExpected || 0);
        }

        runData = {
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

        transaction.set(db.collection("dispatchRuns").doc(runId), runData);
        packageRefs.forEach((pkgRef: any, index: number) => {
          transaction.update(pkgRef, {
            activeDispatchRunId: runId,
            activeDispatchRunNumber: runNumber,
            activeDispatchRunLockedAt: nowStr,
            updatedAt: nowStr
          });
        });
      });

      // Note: Creating a run MUST NOT automatically mark packages Out for Delivery!
      for (const packageId of packageIds) {
        void enqueueShopifyPackageEvent(db, {
          packageId,
          eventType: "DISPATCH_RUN_CREATED",
          payload: { runId, runNumber, riderId, dispatchDate: runData.dispatchDate },
          idempotencyKey: `run:${runId}:${packageId}`
        }).catch((error) => console.error("Shopify dispatch run write-back enqueue failed", error));
      }
      return res.json({ success: true, data: runData });
    } catch (err: any) {
      const status = err.status || 500;
      return res.status(status).json({ success: false, error: { code: err.code || "SERVER_ERROR", message: err.message } });
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

    try {
      const runRef = db.collection("dispatchRuns").doc(runId);
      let responseData: any;

      await db.runTransaction(async (transaction: any) => {
        const runDoc = await transaction.get(runRef);
        if (!runDoc.exists) {
          throw { status: 404, code: "NOT_FOUND", message: `Dispatch run ${runId} not found` };
        }
        const runData = runDoc.data();

        if (runData?.riderId !== req.auth.riderId) {
          throw { status: 403, code: "FORBIDDEN", message: "Rider can only accept their own dispatch run manifest." };
        }

        const expected: string[] = runData?.expectedPackages || [];
        const scanned: string[] = runData?.scannedPackages || [];
        const hasMismatch = expected.length !== scanned.length || expected.some((id: string) => !scanned.includes(id));

        let approvedOverride: any = null;
        if (hasMismatch) {
          const overrideQuery = db.collection("manifestDiscrepancyOverrides")
            .where("runId", "==", runId)
            .where("status", "==", "approved")
            .limit(1);
          const overrideSnap = await transaction.get(overrideQuery);
          approvedOverride = overrideSnap.empty ? null : overrideSnap.docs[0].data();
          if (!approvedOverride) {
            throw {
              status: 409,
              code: "MANIFEST_MISMATCH",
              message: `Manifest scan count (${scanned.length}) does not match expected package count (${expected.length}). All packages must be scanned before acceptance or manager override required.`
            };
          }
        }

        const packageRefs = expected.map((pid: string) => db.collection("packages").doc(pid));
        const packageDocs = await Promise.all(packageRefs.map((pkgRef: any) => transaction.get(pkgRef)));
        const nowStr = new Date().toISOString();

        for (let index = 0; index < expected.length; index++) {
          const pid = expected[index];
          const pkgDoc = packageDocs[index];
          if (!pkgDoc.exists) {
            throw { status: 404, code: "PACKAGE_NOT_FOUND", message: `Package ${pid} not found during acceptance revalidation.` };
          }

          const pkgData = pkgDoc.data();
          if (pkgData?.assignedRiderId !== req.auth.riderId) {
            throw { status: 409, code: "PACKAGE_REASSIGNED", message: `Package ${pid} is no longer assigned to rider ${req.auth.riderId}.` };
          }
          if (pkgData?.activeDispatchRunId && pkgData.activeDispatchRunId !== runId) {
            throw { status: 409, code: "PACKAGE_IN_ACTIVE_RUN", message: `Package ${pid} is locked by another active dispatch run.` };
          }
          if (isPackageStateBlockedForManifest(pkgData?.operationalStatus || pkgData?.current_status)) {
            throw { status: 409, code: "PACKAGE_STATE_CHANGED", message: `Package ${pid} changed state and can no longer move out for delivery.` };
          }
        }

        transaction.update(runRef, {
          status: "accepted_by_rider",
          acceptedByRider: true,
          startTimestamp: nowStr,
          acceptedAt: nowStr,
          approvedDiscrepancyOverrideId: approvedOverride?.id || null,
          updatedAt: nowStr
        });

        packageRefs.forEach((pRef: any) => {
          transaction.update(pRef, {
            current_status: "Out for Delivery",
            operationalStatus: "out_for_delivery",
            custodyStage: "rider_accepted",
            custody_stage: "rider_accepted",
            dispatchedAt: nowStr,
            updatedAt: nowStr
          });
        });

        responseData = {
          ...runData,
          status: "accepted_by_rider",
          acceptedByRider: true,
          acceptedAt: nowStr,
          approvedDiscrepancyOverrideId: approvedOverride?.id || null
        };
      });

      return res.json({ success: true, data: responseData });
    } catch (err: any) {
      const status = err.status || 500;
      return res.status(status).json({ success: false, error: { code: err.code || "SERVER_ERROR", message: err.message } });
    }
  });

  app.post("/api/dispatch/runs/:runId/manifest-discrepancies/report", requireAuth, requireExactRole("rider"), async (req: any, res: any) => {
    const { runId } = req.params;
    const { note, expectedPackages, scannedPackages } = req.body || {};

    try {
      const runRef = db.collection("dispatchRuns").doc(runId);
      const runDoc = await runRef.get();
      if (!runDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Dispatch run ${runId} not found` } });
      }
      const runData = runDoc.data();
      if (runData?.riderId !== req.auth.riderId) {
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Rider can only report discrepancy on their own dispatch run." } });
      }

      const overrideId = `mdo_${runId}_${Date.now()}`;
      const nowStr = new Date().toISOString();
      const discrepancyDoc = {
        id: overrideId,
        runId,
        riderId: req.auth.riderId,
        reportedByUid: req.auth.uid,
        status: "reported",
        note: note?.trim() || null,
        expectedPackages: Array.isArray(expectedPackages) ? expectedPackages : runData?.expectedPackages || [],
        scannedPackages: Array.isArray(scannedPackages) ? scannedPackages : runData?.scannedPackages || [],
        reportedAt: nowStr,
        approvedAt: null,
        approvedByUid: null
      };
      await db.collection("manifestDiscrepancyOverrides").doc(overrideId).set(discrepancyDoc);
      return res.json({ success: true, data: discrepancyDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: err.code || "SERVER_ERROR", message: err.message } });
    }
  });

  app.post("/api/dispatch/runs/:runId/manifest-discrepancies/approve", requireAuth, requireRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    const { runId } = req.params;
    const { overrideId, resolutionNote } = req.body || {};

    if (!overrideId) {
      return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "overrideId is required" } });
    }

    try {
      const overrideRef = db.collection("manifestDiscrepancyOverrides").doc(overrideId);
      const overrideDoc = await overrideRef.get();
      if (!overrideDoc.exists || overrideDoc.data()?.runId !== runId) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Manifest discrepancy override ${overrideId} not found for run ${runId}` } });
      }

      const nowStr = new Date().toISOString();
      await overrideRef.update({
        status: "approved",
        resolutionNote: resolutionNote?.trim() || null,
        approvedAt: nowStr,
        approvedByUid: req.auth.uid,
        updatedAt: nowStr
      });
      const updated = (await overrideRef.get()).data();
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: err.code || "SERVER_ERROR", message: err.message } });
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
        const amt = ["cashier_received", "manager_approved", "closed"].includes(String(s.status || "").toLowerCase())
          ? Number(s.physicallyReceivedAmount || 0)
          : 0;
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

      const packageReleaseBatch = db.batch();
      for (const p of runPackages) {
        const pRef = db.collection("packages").doc(p.id);
        packageReleaseBatch.update(pRef, {
          activeDispatchRunId: null,
          activeDispatchRunNumber: null,
          activeDispatchRunLockedAt: null,
          updatedAt: nowStr
        });
      }
      await packageReleaseBatch.commit();

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
  app.post("/api/delivery/contact-events", requireAuth, requireExactRole("rider"), requirePackageOwnership, async (req: any, res: any) => {
    const { packageId, method, outcome, notes, attemptId } = req.body || {};
    const normalizedMethod = String(method || "").toUpperCase();
    const normalizedOutcome = String(outcome || "ATTEMPTED").toUpperCase();
    const validMethods = ["CALL", "WHATSAPP"];
    const validOutcomes = ["ATTEMPTED", "ANSWERED", "NO_ANSWER", "PHONE_OFF", "INVALID_NUMBER", "CALLBACK_REQUESTED"];

    if (!packageId || !validMethods.includes(normalizedMethod) || !validOutcomes.includes(normalizedOutcome)) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_CONTACT_EVENT", message: "packageId, method (CALL/WHATSAPP), and a valid outcome are required." }
      });
    }

    try {
      const eventId = `dce_${packageId}_${Date.now()}`;
      const nowStr = new Date().toISOString();
      const eventDoc = {
        id: eventId,
        packageId,
        riderId: req.auth.riderId,
        method: normalizedMethod,
        outcome: normalizedOutcome,
        attemptId: attemptId || null,
        notes: notes?.trim() || null,
        timestamp: nowStr,
        createdAt: nowStr
      };
      await db.collection("deliveryContactEvents").doc(eventId).set(eventDoc);
      return res.json({ success: true, data: eventDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: err.code || "SERVER_ERROR", message: err.message } });
    }
  });

  app.post("/api/delivery/gps-exceptions", requireAuth, requireRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    const { packageId, reason, expiresAt } = req.body || {};
    if (!packageId || !reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "packageId and reason are required" } });
    }

    try {
      const pkgRef = db.collection("packages").doc(packageId);
      const pkgDoc = await pkgRef.get();
      if (!pkgDoc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Package ${packageId} not found` } });
      }

      const exceptionId = `gps_${packageId}_${Date.now()}`;
      const nowStr = new Date().toISOString();
      const exceptionDoc = {
        id: exceptionId,
        packageId,
        reason: String(reason).trim(),
        approvedByUid: req.auth.uid,
        approvedAt: nowStr,
        expiresAt: expiresAt || null,
        status: "approved"
      };
      await db.collection("deliveryGpsExceptions").doc(exceptionId).set(exceptionDoc);
      await pkgRef.set({
        gpsExceptionApproved: true,
        gpsExceptionId: exceptionId,
        gpsExceptionApprovedByUid: req.auth.uid,
        gpsExceptionApprovedAt: nowStr,
        gpsExceptionReason: String(reason).trim(),
        gpsExceptionExpiresAt: expiresAt || null,
        updatedAt: nowStr
      }, { merge: true });

      return res.json({ success: true, data: exceptionDoc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: err.code || "SERVER_ERROR", message: err.message } });
    }
  });

  app.post("/api/delivery/attempt", requireAuth, requireExactRole("rider"), requirePackageOwnership, async (req: any, res: any) => {
    try {
      const result = await recordDeliveryAttemptAuthority({
        db,
        auth: req.auth,
        body: req.body,
        verifyDeliveryProofStorageObject
      });
      const packageId = String(req.body?.packageId || "");
      const packageSnapshot = packageId ? await db.collection("packages").doc(packageId).get() : null;
      const packageData = packageSnapshot?.exists ? packageSnapshot.data() : null;
      if (packageData?.source === "shopify" && packageData.shopifyId) {
        void enqueueShopifyOutboundEvent(db, {
          packageId,
          shopifyOrderId: String(packageData.shopifyId),
          eventType: "DELIVERY_STATUS_CHANGED",
          idempotencyKey: String(req.body?.idempotencyKey || req.body?.attemptId || `delivery_${packageId}_${result?.deliveryAttemptId || Date.now()}`),
          payload: { status: result?.status || req.body?.status, riderId: req.auth.riderId, packageId, occurredAt: new Date().toISOString() }
        }).catch((error) => console.error("Shopify outbound queue enqueue failed", error));
      }
      return res.json({ success: true, data: result });
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
      const idemKey = (idempotencyKey || `settlement_submit_${targetSettlementId}`).trim();
      const idemRef = db.collection("idempotencyKeys").doc(idemKey);
      let responseData: any;

      await db.runTransaction(async (transaction: any) => {
        const existingIdem = await transaction.get(idemRef);
        if (existingIdem.exists) {
          const idemData = existingIdem.data();
          responseData = idemData?.result || null;
          return;
        }

        const codQuery = db.collection("codCollections")
          .where("riderId", "==", riderId)
          .where("paymentMethod", "==", "cash");
        const codSnap = await transaction.get(codQuery);
        const eligibleCollections = codSnap.docs
          .map((d: any) => d.data())
          .filter((c: any) => !c.settlementId && !c.assignedSettlementId);

        const calculatedCashObligation = eligibleCollections.reduce((sum: number, c: any) => sum + Number(c.collectedAmount || 0), 0);
        const collectionVariance = eligibleCollections.reduce((sum: number, c: any) => sum + Number(c.collectionVariance || 0), 0);
        const riderHandoverVariance = Number(declaredCashAmount) - calculatedCashObligation;
        let unresolvedCollectionDiscrepancyCount = 0;
        for (const col of eligibleCollections) {
          if (col.discrepancyId) {
            const discrepancyDoc = await transaction.get(db.collection("codCollectionDiscrepancies").doc(col.discrepancyId));
            const discrepancyData = discrepancyDoc.exists ? discrepancyDoc.data() : null;
            if (String(discrepancyData?.status || "").toUpperCase() === "OPEN") {
              unresolvedCollectionDiscrepancyCount += 1;
            }
          }
        }
        const settlementState = buildCollectionDiscrepancyStatus({
          collectionVariance,
          riderHandoverVariance,
          cashierVariance: 0,
          unresolvedCollectionDiscrepancyCount
        });
        const nowStr = new Date().toISOString();
        const settlementDoc = {
          id: targetSettlementId,
          settlementNumber: `SET-${Date.now().toString().slice(-6)}`,
          riderId,
          status: settlementState.requiresResolution ? "discrepancy" : "rider_submitted",
          calculatedCashObligation,
          declaredCashAmount: Number(declaredCashAmount),
          physicallyReceivedAmount: 0,
          collectionVariance,
          riderHandoverVariance,
          cashierVariance: 0,
          totalSettlementVariance: settlementState.totalSettlementVariance,
          unresolvedCollectionDiscrepancyCount,
          discrepancyType: settlementState.discrepancyType,
          discrepancyAmount: settlementState.totalSettlementVariance,
          discrepancyReason: null,
          notes: notes || null,
          receiptNotes: null,
          submittedAt: nowStr,
          receivedAt: null,
          approvedAt: null,
          approvedByUid: null,
          closedAt: null,
          idempotencyKey: idemKey,
          createdAt: nowStr,
          updatedAt: nowStr
        };

        transaction.set(db.collection("riderSettlements").doc(targetSettlementId), settlementDoc);

        eligibleCollections.forEach((col: any) => {
          const lineId = `line_${targetSettlementId}_${col.packageId}`;
          transaction.set(db.collection("settlementLines").doc(lineId), {
            id: lineId,
            settlementId: targetSettlementId,
            riderId,
            packageId: col.packageId,
            collectedAmount: col.collectedAmount,
            expectedCod: col.expectedCod || 0,
            collectionVariance: Number(col.collectionVariance || 0),
            discrepancyId: col.discrepancyId || null,
            paymentMethod: "cash",
            createdAt: nowStr
          });
          transaction.update(db.collection("codCollections").doc(col.id), {
            settlementId: targetSettlementId,
            assignedSettlementId: targetSettlementId,
            settlementAssignedAt: nowStr,
            updatedAt: nowStr
          });
          if (col.discrepancyId) {
            transaction.set(db.collection("codCollectionDiscrepancies").doc(col.discrepancyId), {
              settlementId: targetSettlementId,
              updatedAt: nowStr
            }, { merge: true });
          }
        });

        responseData = settlementDoc;
        transaction.set(idemRef, {
          key: idemKey,
          action: "RIDER_SETTLEMENT_SUBMIT",
          result: settlementDoc,
          createdAt: nowStr
        });
      });

      return res.json({ success: true, data: responseData });
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
      const idemKey = (idempotencyKey || `idem_rcv_${settlementId}_${Date.now()}`).trim();
      const idemRef = db.collection("idempotencyKeys").doc(idemKey);
      let updatedDoc: any = null;

      await db.runTransaction(async (transaction: any) => {
        const existingIdem = await transaction.get(idemRef);
        if (existingIdem.exists) {
          updatedDoc = existingIdem.data()?.result || null;
          return;
        }

        const stlDoc = await transaction.get(stlRef);
        if (!stlDoc.exists) {
          throw { status: 404, code: "NOT_FOUND", message: `Settlement ${settlementId} not found` };
        }
        const stlData = stlDoc.data();
        if (stlData.riderId === req.auth.riderId || stlData.riderId === req.auth.uid) {
          throw { status: 403, code: "SELF_ACTION_REJECTED", message: "Rider cannot confirm their own cashier receipt." };
        }
        if (stlData?.receiptTransactionId || stlData?.status === "cashier_received" || stlData?.status === "manager_approved" || stlData?.status === "closed") {
          throw { status: 409, code: "SETTLEMENT_ALREADY_RECEIVED", message: "Physical cashier receipt has already been recorded for this settlement." };
        }
        if (!["rider_submitted", "discrepancy"].includes(String(stlData?.status || ""))) {
          throw { status: 400, code: "INVALID_SETTLEMENT_STAGE", message: `Cannot receive physical cash for settlement in stage "${stlData?.status}". Stage skipping rejected.` };
        }

        const receivedAmt = Number(physicallyReceivedAmount);
        const declaredAmt = Number(stlData.declaredCashAmount || 0);
        const cashierVariance = receivedAmt - declaredAmt;
        const settlementState = buildCollectionDiscrepancyStatus({
          collectionVariance: Number(stlData.collectionVariance || 0),
          riderHandoverVariance: Number(stlData.riderHandoverVariance || 0),
          cashierVariance,
          unresolvedCollectionDiscrepancyCount: Number(stlData.unresolvedCollectionDiscrepancyCount || 0)
        });
        const nowStr = new Date().toISOString();
        const receiptTransactionId = `tx_${crypto.randomUUID()}`;

        transaction.set(db.collection("financialTransactions").doc(receiptTransactionId), {
          id: receiptTransactionId,
          transactionType: "RIDER_SETTLEMENT_RECEIPT",
          sourceType: "rider_settlement",
          sourceId: settlementId,
          packageId: null,
          riderId: stlData.riderId,
          cashierProfileId: req.auth.uid,
          settlementId,
          bankDepositId: null,
          status: "posted",
          currency: "PKR",
          totalDebit: receivedAmt,
          totalCredit: receivedAmt,
          idempotencyKey: idemKey,
          createdByUid: req.auth.uid,
          createdAt: nowStr,
          reversedTransactionId: null,
          reversedByUid: null,
          reversedAt: null,
          reversalReason: null
        });
        const debitRef = db.collection("financialPostings").doc();
        transaction.set(debitRef, {
          id: debitRef.id,
          transactionId: receiptTransactionId,
          accountCode: "CASHIER_CASH_CONTROL",
          debitAmount: receivedAmt,
          creditAmount: 0,
          packageId: null,
          riderId: stlData.riderId,
          settlementId,
          bankDepositId: null,
          createdAt: nowStr
        });
        const creditRef = db.collection("financialPostings").doc();
        transaction.set(creditRef, {
          id: creditRef.id,
          transactionId: receiptTransactionId,
          accountCode: "RIDER_CASH_WALLET",
          debitAmount: 0,
          creditAmount: receivedAmt,
          packageId: null,
          riderId: stlData.riderId,
          settlementId,
          bankDepositId: null,
          createdAt: nowStr
        });

        updatedDoc = {
          ...stlData,
          physicallyReceivedAmount: receivedAmt,
          cashierVariance,
          totalSettlementVariance: settlementState.totalSettlementVariance,
          discrepancyAmount: settlementState.totalSettlementVariance,
          discrepancyType: settlementState.discrepancyType,
          status: settlementState.requiresResolution ? "discrepancy" : "cashier_received",
          receiptNotes: receiptNotes || null,
          receivedAt: nowStr,
          receiptTransactionId,
          receiptIdempotencyKey: idemKey,
          updatedAt: nowStr
        };
        transaction.set(stlRef, updatedDoc, { merge: true });

        if (settlementState.requiresResolution) {
          const auditRef = db.collection("financialAuditEvents").doc();
          transaction.set(auditRef, {
            id: auditRef.id,
            eventType: "SETTLEMENT_DISCREPANCY_DETECTED",
            entityType: "rider_settlement",
            entityId: settlementId,
            actorUid: req.auth.uid,
            details: {
              collectionVariance: Number(stlData.collectionVariance || 0),
              riderHandoverVariance: Number(stlData.riderHandoverVariance || 0),
              cashierVariance,
              received: receivedAmt
            },
            createdAt: nowStr
          });
        }

        transaction.set(idemRef, {
          key: idemKey,
          action: "SETTLEMENT_CASHIER_RECEIPT",
          result: updatedDoc,
          createdAt: nowStr
        });
      });

      return res.json({ success: true, data: updatedDoc });
    } catch (err: any) {
      const status = err.status || 400;
      return res.status(status).json({ success: false, error: { code: err.code || "RECEIPT_FAILED", message: err.message } });
    }
  });

  // Manager Approve Discrepancy
  app.post("/api/finance/settlements/approve-discrepancy", requireAuth, requireRole("super_admin", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const { settlementId, discrepancyReason, idempotencyKey, resolutionType, resolutionReason } = req.body;
      if (!settlementId || !resolutionType || !String(resolutionType).trim()) {
        return res.status(400).json({ success: false, error: { code: "RESOLUTION_TYPE_REQUIRED", message: "A privileged discrepancy resolution type is required." } });
      }
      const normalizedResolutionType = String(resolutionType).trim().toUpperCase();
      const normalizedReason = String(discrepancyReason || "").trim().toUpperCase();
      if (normalizedReason && !COLLECTION_DISCREPANCY_REASONS.includes(normalizedReason as any)) {
        return res.status(400).json({ success: false, error: { code: "INVALID_COLLECTION_DISCREPANCY_REASON", message: `Unsupported discrepancy reason "${discrepancyReason}".` } });
      }
      const stlRef = db.collection("riderSettlements").doc(settlementId);
      const idemKey = (idempotencyKey || `settlement_resolution_${settlementId}_${normalizedResolutionType}`).trim();
      const idemRef = db.collection("idempotencyKeys").doc(idemKey);
      let updatedDoc: any;
      await db.runTransaction(async (transaction: any) => {
        const existingIdem = await transaction.get(idemRef);
        if (existingIdem.exists) {
          updatedDoc = existingIdem.data()?.result || null;
          return;
        }

        const stlDoc = await transaction.get(stlRef);
        if (!stlDoc.exists) {
          throw { status: 404, code: "NOT_FOUND", message: `Settlement ${settlementId} not found` };
        }
        const stlData = stlDoc.data();
        if (stlData?.status === "closed") {
          throw { status: 400, code: "SETTLEMENT_CLOSED", message: "Closed settlement cannot be modified." };
        }
        if (stlData?.status === "manager_approved") {
          updatedDoc = stlData;
          return;
        }
        if (stlData.riderId === req.auth.riderId || stlData.riderId === req.auth.uid) {
          throw { status: 403, code: "SELF_APPROVAL_REJECTED", message: "Self-approval of discrepancy rejected." };
        }

        const nowStr = new Date().toISOString();
        const effectiveReason = String(resolutionReason || discrepancyReason || "").trim();
        if (!effectiveReason) {
          throw { status: 400, code: "RESOLUTION_REASON_REQUIRED", message: "Resolution requires an explicit reason." };
        }
        const openDiscrepancyLines = (await transaction.get(db.collection("settlementLines").where("settlementId", "==", settlementId))).docs
          .map((doc: any) => doc.data())
          .filter((line: any) => line.discrepancyId);
        const openCollectionDiscrepancyIds: string[] = [];
        for (const line of openDiscrepancyLines) {
          const discrepancyDoc = await transaction.get(db.collection("codCollectionDiscrepancies").doc(String(line.discrepancyId)));
          const discrepancyData = discrepancyDoc.exists ? discrepancyDoc.data() : null;
          if (String(discrepancyData?.status || "").toUpperCase() === "OPEN") {
            openCollectionDiscrepancyIds.push(String(line.discrepancyId));
          }
        }
        if (Number(stlData.totalSettlementVariance || 0) === 0 && openCollectionDiscrepancyIds.length === 0) {
          throw { status: 400, code: "NO_OPEN_DISCREPANCY", message: "Settlement has no open discrepancy to resolve." };
        }
        if (stlData?.resolutionTransactionId || stlData?.status === "manager_approved") {
          throw { status: 409, code: "DISCREPANCY_ALREADY_RESOLVED", message: "A discrepancy resolution has already been posted for this settlement." };
        }

        const postings = buildSettlementResolutionPostings(stlData, normalizedResolutionType);
        const resolutionTransactionId = `tx_${crypto.randomUUID()}`;
        transaction.set(db.collection("financialTransactions").doc(resolutionTransactionId), {
          id: resolutionTransactionId,
          transactionType: "SETTLEMENT_DISCREPANCY_RESOLUTION",
          sourceType: "rider_settlement",
          sourceId: settlementId,
          packageId: null,
          riderId: stlData.riderId || null,
          cashierProfileId: null,
          settlementId,
          bankDepositId: null,
          status: "posted",
          currency: "PKR",
          totalDebit: postings.reduce((sum: number, posting: any) => sum + Number(posting.debitAmount || 0), 0),
          totalCredit: postings.reduce((sum: number, posting: any) => sum + Number(posting.creditAmount || 0), 0),
          idempotencyKey: `ledger_${idemKey}`,
          createdByUid: req.auth.uid,
          createdAt: nowStr,
          reversedTransactionId: null,
          reversedByUid: null,
          reversedAt: null,
          reversalReason: null
        });
        for (const posting of postings) {
          const postRef = db.collection("financialPostings").doc();
          transaction.set(postRef, {
            id: postRef.id,
            transactionId: resolutionTransactionId,
            accountCode: posting.accountCode,
            debitAmount: posting.debitAmount,
            creditAmount: posting.creditAmount,
            packageId: null,
            riderId: stlData.riderId || null,
            settlementId,
            bankDepositId: null,
            createdAt: nowStr
          });
        }

        const nextDoc = {
          ...stlData,
          status: "manager_approved",
          discrepancyReason: String(discrepancyReason || stlData.discrepancyReason || "").trim() || null,
          resolutionType: normalizedResolutionType,
          resolutionReason: effectiveReason,
          resolutionApprovedBy: req.auth.uid,
          resolutionApprovedAt: nowStr,
          approvedByUid: req.auth.uid,
          approvedAt: nowStr,
          resolutionTransactionId,
          unresolvedCollectionDiscrepancyCount: 0,
          updatedAt: nowStr
        };

        transaction.set(stlRef, nextDoc, { merge: true });
        for (const discrepancyId of openCollectionDiscrepancyIds) {
          transaction.set(db.collection("codCollectionDiscrepancies").doc(discrepancyId), {
            status: "APPROVED",
            reason: normalizedReason || null,
            resolutionType: normalizedResolutionType,
            resolutionReason: effectiveReason,
            approvedAt: nowStr,
            approvedByUid: req.auth.uid,
            settlementId,
            updatedAt: nowStr
          }, { merge: true });
        }

        const auditRef = db.collection("financialAuditEvents").doc();
        transaction.set(auditRef, {
          id: auditRef.id,
          eventType: "SETTLEMENT_DISCREPANCY_APPROVED",
          entityType: "rider_settlement",
          entityId: settlementId,
          actorUid: req.auth.uid,
          details: {
            discrepancyReason: nextDoc.discrepancyReason,
            resolutionType: normalizedResolutionType,
            resolutionReason: effectiveReason,
            resolutionTransactionId
          },
          createdAt: nowStr
        });

        updatedDoc = nextDoc;
        transaction.set(idemRef, {
          key: idemKey,
          action: "SETTLEMENT_DISCREPANCY_APPROVAL",
          result: nextDoc,
          createdAt: nowStr
        });
      });

      return res.json({ success: true, data: updatedDoc });
    } catch (err: any) {
      const status = err.status || 500;
      return res.status(status).json({ success: false, error: { code: err.code || "SERVER_ERROR", message: err.message } });
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
      if (Number(stlData?.unresolvedCollectionDiscrepancyCount || 0) > 0) {
        return res.status(400).json({ success: false, error: { code: "UNRESOLVED_COLLECTION_DISCREPANCY", message: "Settlement with unresolved collection variance cannot be closed." } });
      }

      const nowStr = new Date().toISOString();
      await stlRef.update({
        status: "closed",
        closedAt: nowStr,
        updatedAt: nowStr
      });
      const lineSnap = await db.collection("settlementLines").where("settlementId", "==", settlementId).get();
      for (const doc of lineSnap.docs) {
        const line = doc.data();
        if (line?.discrepancyId) {
          await db.collection("codCollectionDiscrepancies").doc(String(line.discrepancyId)).set({
            status: "RESOLVED",
            resolvedAt: nowStr,
            resolvedByUid: req.auth.uid,
            settlementId,
            updatedAt: nowStr
          }, { merge: true });
        }
      }

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

  app.get("/api/finance/digital-payments", requireAuth, requireAnyRole("super_admin", "dispatch_manager", "cashier", "management_viewer"), async (_req: any, res: any) => {
    try {
      const snap = await db.collection("digitalPaymentVerifications").get();
      return res.json({ success: true, data: snap.docs.map((doc: any) => doc.data()) });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  app.post("/api/finance/digital-payments/verify", requireAuth, requireAnyRole("super_admin", "cashier", "dispatch_manager"), async (req: any, res: any) => {
    try {
      const { digitalReference, packageId, amount, paymentChannel, verificationStatus, verificationNote } = req.body || {};
      const normalizedReference = normalizeDigitalReference(digitalReference);
      const normalizedStatus = String(verificationStatus || "").trim().toUpperCase();
      if (!normalizedReference || !packageId || !paymentChannel || !DIGITAL_PAYMENT_STATUSES.includes(normalizedStatus as any)) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "digitalReference, packageId, paymentChannel, and a valid verificationStatus are required." } });
      }
      if ((normalizedStatus === "MISMATCH" || normalizedStatus === "REJECTED") && !String(verificationNote || "").trim()) {
        return res.status(400).json({ success: false, error: { code: "VERIFICATION_NOTE_REQUIRED", message: "Mismatch or rejection requires a verification note." } });
      }

      const ref = db.collection("digitalPaymentVerifications").doc(`dig_${normalizedReference}`);
      const doc = await ref.get();
      if (!doc.exists) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Digital verification ${normalizedReference} not found.` } });
      }
      const data = doc.data();
      if (String(data?.packageId || "") !== String(packageId)) {
        return res.status(409).json({ success: false, error: { code: "PACKAGE_MISMATCH", message: "Digital payment reference does not belong to the supplied package." } });
      }

      const nowStr = new Date().toISOString();
      const nextDoc = {
        ...data,
        amount: amount !== undefined ? Number(amount) : Number(data?.amount || 0),
        paymentMethod: paymentChannel,
        verificationStatus: normalizedStatus,
        status: normalizedStatus.toLowerCase(),
        verificationNote: String(verificationNote || "").trim() || null,
        verifiedByUid: req.auth.uid,
        verifiedAt: nowStr,
        updatedAt: nowStr
      };
      await ref.set(nextDoc, { merge: true });
      return res.json({ success: true, data: nextDoc });
    } catch (err: any) {
      return res.status(err.status || 500).json({ success: false, error: { code: err.code || "SERVER_ERROR", message: err.message } });
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
      const [{ startIso, endIso }, packageSnap, assignmentSnap, attemptSnap, returnSnap, codSnap, postingSnap, settlementSnap] = await Promise.all([
        Promise.resolve(getAsiaKarachiDayRange()),
        db.collection("packages").get(),
        db.collection("assignments").get(),
        db.collection("deliveryAttempts").get(),
        db.collection("returns").get(),
        db.collection("codCollections").get(),
        db.collection("financialPostings").get(),
        db.collection("riderSettlements").get()
      ]);

      const orders = packageSnap.docs.map((d: any) => d.data());
      const assignments = assignmentSnap.docs.map((d: any) => d.data());
      const attempts = attemptSnap.docs.map((d: any) => d.data());
      const returns = returnSnap.docs.map((d: any) => d.data());
      const codCollections = codSnap.docs.map((d: any) => d.data());
      const postings = postingSnap.docs.map((d: any) => d.data());
      const settlements = settlementSnap.docs.map((d: any) => d.data());

      const totalOrders = orders.length;
      const deliveredPackages = orders.filter((o: any) => String(o.current_status || o.operationalStatus || "").toLowerCase() === "delivered");
      const returnedPackages = orders.filter((o: any) => String(o.current_status || o.operationalStatus || "").toLowerCase() === "returned");
      const awaiting = orders.filter((o: any) => String(o.current_status || o.operationalStatus || "").toLowerCase() === "imported_review");
      const inTransit = orders.filter((o: any) => ["dispatched", "out_for_delivery"].includes(String(o.current_status || o.operationalStatus || "").toLowerCase()));

      const assignmentsToday = assignments.filter((a: any) => isIsoWithinRange(a.assignedAt, startIso, endIso));
      const deliveredTodayAttempts = attempts.filter((a: any) => a.status === "DELIVERED" && isIsoWithinRange(a.createdAt || a.serverTimestamp, startIso, endIso));
      const failedTodayAttempts = attempts.filter((a: any) => a.status !== "DELIVERED" && isIsoWithinRange(a.createdAt || a.serverTimestamp, startIso, endIso));
      const returnedToday = returns.filter((r: any) => isIsoWithinRange(r.updatedAt || r.createdAt, startIso, endIso));
      const codCollectionsToday = codCollections.filter((c: any) => isIsoWithinRange(c.createdAt, startIso, endIso));
      const cashierReceivedToday = settlements.filter((s: any) => isIsoWithinRange(s.receivedAt, startIso, endIso));

      const firstAttemptDeliveredPackages = deliveredTodayAttempts.filter((attempt: any) => {
        const priorAttempts = attempts.filter((candidate: any) => candidate.packageId === attempt.packageId);
        return priorAttempts.length === 1;
      });
      const firstAttemptPercentage = deliveredTodayAttempts.length > 0
        ? `${((firstAttemptDeliveredPackages.length / deliveredTodayAttempts.length) * 100).toFixed(1)}%`
        : "0%";

      const riderDebits = postings.filter((p: any) => p.accountCode === "RIDER_CASH_WALLET").reduce((sum: number, p: any) => sum + Number(p.debitAmount || 0), 0);
      const riderCredits = postings.filter((p: any) => p.accountCode === "RIDER_CASH_WALLET").reduce((sum: number, p: any) => sum + Number(p.creditAmount || 0), 0);
      const cashierDebitsToday = postings
        .filter((p: any) => p.accountCode === "CASHIER_CASH_CONTROL" && isIsoWithinRange(p.createdAt, startIso, endIso))
        .reduce((sum: number, p: any) => sum + Number(p.debitAmount || 0), 0);

      const openDiscrepancies = settlements.filter((s: any) => s.status === "discrepancy");
      const openShortage = openDiscrepancies
        .filter((s: any) => Number(s.totalSettlementVariance || 0) < 0)
        .reduce((sum: number, s: any) => sum + Math.abs(Number(s.totalSettlementVariance || 0)), 0);
      const openExcess = openDiscrepancies
        .filter((s: any) => Number(s.totalSettlementVariance || 0) > 0)
        .reduce((sum: number, s: any) => sum + Number(s.totalSettlementVariance || 0), 0);
      const unsettledCod = codCollections
        .filter((c: any) => !c.settlementId && !c.assignedSettlementId)
        .reduce((sum: number, c: any) => sum + Number(c.collectedAmount || 0), 0);

      const totalExpectedCod = deliveredTodayAttempts.reduce((acc: number, attempt: any) => {
        const pkg = orders.find((order: any) => order.id === attempt.packageId);
        return acc + Number(pkg?.cod_expected || pkg?.expectedCod || pkg?.codExpected || 0);
      }, 0);
      const totalCollectedCod = codCollectionsToday.reduce((acc: number, c: any) => acc + Number(c.collectedAmount || 0), 0);
      const totalSettledCod = cashierReceivedToday.reduce((acc: number, s: any) => acc + Number(s.physicallyReceivedAmount || 0), 0);

      return res.json({
        success: true,
        data: {
          totalOrders,
          importedToday: orders.filter((o: any) => isIsoWithinRange(o.createdAt, startIso, endIso)).length,
          awaitingAssignment: awaiting.length,
          handedToRiders: inTransit.length,
          outForDelivery: inTransit.length,
          deliveredToday: deliveredTodayAttempts.length,
          totalDelivered: deliveredPackages.length,
          totalReturned: returnedPackages.length,
          totalRescheduled: failedTodayAttempts.filter((a: any) => a.status === "RESCHEDULED").length,
          successPercentage: totalOrders > 0 ? `${((deliveredPackages.length / totalOrders) * 100).toFixed(1)}%` : "0%",
          firstAttemptPercentage,
          totalExpectedCod,
          totalCollectedCod,
          totalSettledCod,
          codHeldByRiders: Math.max(0, riderDebits - riderCredits),
          codDiscrepancies: openShortage + openExcess,
          aging: { pending24: 0, pending48: 0, pending72: 0 },
          assignedToday: assignmentsToday.length,
          failedToday: failedTodayAttempts.length,
          returnedToday: returnedToday.length,
          cashierReceived: cashierDebitsToday,
          openShortage,
          openExcess,
          unsettledCod,
          reportingDay: getAsiaKarachiDayRange().dayString
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
      const idemKey = String(idempotencyKey || `HANDBACK:${packageId}:${scannedPackageNumber}`).trim();
      const idemRef = db.collection("idempotencyKeys").doc(idemKey);
      let responseData: any = null;
      let alreadyHandedBack = false;

      await db.runTransaction(async (transaction: any) => {
        const existingIdem = await transaction.get(idemRef);
        if (existingIdem.exists) {
          responseData = existingIdem.data()?.result || null;
          alreadyHandedBack = Boolean(existingIdem.data()?.alreadyHandedBack);
          return;
        }

        const pkgRef = db.collection("packages").doc(packageId);
        const pkgDoc = await transaction.get(pkgRef);
        if (!pkgDoc.exists) {
          throw { status: 404, code: "NOT_FOUND", message: `Package ${packageId} not found` };
        }

        const pkgData = pkgDoc.data();
        const realPkgNum = pkgData?.packageNumber || pkgData?.package_number || "";
        if (scannedPackageNumber !== realPkgNum) {
          throw { status: 400, code: "EXACT_BARCODE_MATCH_REQUIRED", message: `Scanned barcode "${scannedPackageNumber}" does not match exact package number "${realPkgNum}". Partial barcode matching is strictly rejected.` };
        }
        if (req.auth.role === "rider" && pkgData?.assignedRiderId !== req.auth.riderId) {
          throw { status: 403, code: "UNAUTHORIZED_RIDER_RETURN", message: "Rider may submit return handback only for their own assigned package." };
        }
        const currStatus = (pkgData?.operationalStatus || pkgData?.current_status || "").toLowerCase();
        if (currStatus === "delivered" || currStatus === "closed") {
          throw { status: 400, code: "INVALID_PACKAGE_STATUS", message: `Delivered or closed package cannot be handed back for return. Status: ${currStatus}` };
        }

        const returnId = `ret_${packageId}`;
        const returnRef = db.collection("returns").doc(returnId);
        const existingRetDoc = await transaction.get(returnRef);
        if (existingRetDoc.exists && existingRetDoc.data()?.returnStatus === "rider_handed_back") {
          responseData = existingRetDoc.data();
          alreadyHandedBack = true;
          transaction.set(idemRef, {
            key: idemKey,
            action: "RIDER_RETURN_HANDBACK",
            result: responseData,
            alreadyHandedBack: true,
            createdAt: new Date().toISOString()
          });
          return;
        }

        const nowStr = new Date().toISOString();
        responseData = {
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
          createdAt: existingRetDoc.exists ? (existingRetDoc.data()?.createdAt || nowStr) : nowStr,
          updatedAt: nowStr
        };
        transaction.set(returnRef, responseData, { merge: true });

        const custodyEventId = `cust_${packageId}_rider_handback`;
        transaction.set(db.collection("returnCustodyEvents").doc(custodyEventId), {
          id: custodyEventId,
          returnId,
          packageId,
          eventStage: "rider_handed_back",
          actorUid: req.auth.uid,
          actorRole: req.auth.role,
          handoffEmployee: handoffEmployee || null,
          timestamp: nowStr
        });

        transaction.update(pkgRef, {
          current_status: "Returning to Warehouse",
          operationalStatus: "returning_to_warehouse",
          custodyStage: "return_handed_back",
          updatedAt: nowStr
        });

        transaction.set(idemRef, {
          key: idemKey,
          action: "RIDER_RETURN_HANDBACK",
          result: responseData,
          alreadyHandedBack: false,
          createdAt: nowStr
        });
      });

      if (!alreadyHandedBack) {
        void enqueueShopifyPackageEvent(db, {
          packageId,
          eventType: "RETURN_STATUS_CHANGED",
          payload: { returnStatus: "rider_handed_back", returnReason: responseData?.returnReason || null, actorUid: req.auth.uid },
          idempotencyKey: `return-handback:${idemKey}`
        }).catch((error) => console.error("Shopify rider handback write-back enqueue failed", error));
      }
      return res.json({
        success: true,
        data: responseData,
        alreadyHandedBack,
        message: alreadyHandedBack ? `Package ${scannedPackageNumber} already handed back to hub warehouse.` : undefined
      });
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
      const idemKey = String(idempotencyKey || `WAREHOUSE_RECEIPT:${packageId}:${scannedPackageNumber}`).trim();
      const idemRef = db.collection("idempotencyKeys").doc(idemKey);
      let receiptData: any = null;

      await db.runTransaction(async (transaction: any) => {
        const existingIdem = await transaction.get(idemRef);
        if (existingIdem.exists) {
          receiptData = existingIdem.data()?.result || null;
          return;
        }

        const pkgRef = db.collection("packages").doc(packageId);
        const pkgDoc = await transaction.get(pkgRef);
        if (!pkgDoc.exists) {
          throw { status: 404, code: "NOT_FOUND", message: `Package ${packageId} not found` };
        }
        const pkgData = pkgDoc.data();
        const realPkgNum = pkgData?.packageNumber || pkgData?.package_number || "";
        if (scannedPackageNumber !== realPkgNum) {
          throw { status: 400, code: "EXACT_BARCODE_MATCH_REQUIRED", message: `Scanned barcode "${scannedPackageNumber}" does not match exact package number "${realPkgNum}". Partial barcode matching is strictly rejected.` };
        }

        const returnId = `ret_${packageId}`;
        const returnRef = db.collection("returns").doc(returnId);
        const retDoc = await transaction.get(returnRef);
        const retData = retDoc.exists ? retDoc.data() : null;
        const currentReturnStatus = String(retData?.returnStatus || pkgData?.custodyStage || "").toLowerCase().replace(/[\s-]+/g, "_");
        if (currentReturnStatus === "warehouse_received") {
          throw { status: 409, code: "DUPLICATE_WAREHOUSE_RECEIPT", message: `Warehouse receipt already recorded for package ${packageId}. Duplicate receipt rejected.` };
        }

        const validReturnStages = ["rider_handed_back", "courier_returning", "returning_to_warehouse", "return_handed_back"];
        const opStatus = (pkgData?.operationalStatus || pkgData?.current_status || "").toLowerCase().replace(/[\s-]+/g, "_");
        const custodyStage = (pkgData?.custodyStage || "").toLowerCase().replace(/[\s-]+/g, "_");
        const isEligibleReturnStage = validReturnStages.includes(currentReturnStatus) || validReturnStages.includes(opStatus) || validReturnStages.includes(custodyStage);
        if (!isEligibleReturnStage) {
          throw { status: 400, code: "WRONG_CUSTODY_ORDER", message: `Warehouse receipt requested out of sequence. Current stage: "${currentReturnStatus || opStatus || custodyStage}". Package must be handed back by rider first.` };
        }

        const cond = (packageCondition || "sealed").toLowerCase();
        if ((cond === "damaged" || cond === "missing_item" || cond === "wrong_item") && (!conditionNotes || !conditionNotes.trim())) {
          throw { status: 400, code: "MISSING_CONDITION_NOTES", message: `Condition "${cond}" requires detailed condition notes.` };
        }

        const nowStr = new Date().toISOString();
        const receiptId = `rcpt_${packageId}`;
        receiptData = {
          id: receiptId,
          returnId,
          packageId,
          packageNumber: realPkgNum,
          scannedPackageNumber,
          receivedQuantity: Number(receivedQuantity) || 1,
          packageCondition: cond,
          restockable: restockable !== false,
          conditionNotes: conditionNotes ? conditionNotes.trim() : null,
          receivedByUid: req.auth.uid,
          receivedAt: nowStr,
          idempotencyKey: idemKey,
          createdAt: nowStr
        };
        transaction.set(db.collection("returnReceipts").doc(receiptId), receiptData);
        transaction.set(returnRef, {
          id: returnId,
          packageId,
          packageNumber: realPkgNum,
          returnStatus: "warehouse_received",
          warehouseReceivedAt: nowStr,
          updatedAt: nowStr
        }, { merge: true });

        transaction.set(db.collection("returnCustodyEvents").doc(`cust_${packageId}_warehouse_received`), {
          id: `cust_${packageId}_warehouse_received`,
          returnId,
          packageId,
          eventStage: "warehouse_received",
          actorUid: req.auth.uid,
          actorRole: req.auth.role,
          timestamp: nowStr
        });

        transaction.update(pkgRef, {
          current_status: "Warehouse Received",
          operationalStatus: "warehouse_received",
          custodyStage: "warehouse_return_received",
          warehouseReceivedAt: nowStr,
          updatedAt: nowStr
        });

        transaction.set(db.collection("customerServiceCases").doc(`cs_${packageId}`), {
          id: `cs_${packageId}`,
          packageId,
          packageNumber: realPkgNum,
          customerId: pkgData?.customerName || pkgData?.recipient_name || "Unknown",
          caseType: "failed_delivery_review",
          priority: cond === "damaged" ? "high" : "normal",
          status: "open",
          attemptCount: 0,
          createdAt: nowStr,
          updatedAt: nowStr
        }, { merge: true });

        transaction.set(idemRef, {
          key: idemKey,
          action: "WAREHOUSE_RETURN_RECEIPT",
          result: receiptData,
          createdAt: nowStr
        });
      });

      void enqueueShopifyPackageEvent(db, {
        packageId,
        eventType: "RETURN_STATUS_CHANGED",
        payload: { returnStatus: "warehouse_received", actorUid: req.auth.uid },
        idempotencyKey: `warehouse-receipt:${idemKey}`
      }).catch((error) => console.error("Shopify warehouse receipt write-back enqueue failed", error));
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

  // --- MANAGEMENT COMMAND CENTER ANALYTICS API ---
  app.use("/api/management", createManagementRouter(db, requireAuth, requireRole));

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
