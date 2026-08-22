"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.recalculateActiveShipmentAgeing = exports.approveCodAllocation = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const logisticsAuthority_1 = require("../../src/services/logisticsAuthority");
if (!(0, app_1.getApps)().length) {
    (0, app_1.initializeApp)();
}
const db = (0, firestore_1.getFirestore)();
async function verifyUserRole(context, allowedRoles) {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "User must be authenticated.");
    }
    const uid = context.auth.uid;
    const userDoc = await db.collection("profiles").doc(uid).get();
    if (!userDoc.exists) {
        throw new functions.https.HttpsError("not-found", "User profile not found.");
    }
    const userData = userDoc.data();
    if (!userData?.active) {
        throw new functions.https.HttpsError("permission-denied", "Account is inactive.");
    }
    if (!allowedRoles.includes(userData.role) && userData.role !== "super_admin") {
        throw new functions.https.HttpsError("permission-denied", "Insufficient permissions for this operation.");
    }
    return { uid, userData };
}
function toHttpsError(err) {
    if (err instanceof functions.https.HttpsError) {
        return err;
    }
    switch (err?.status) {
        case 400:
            return new functions.https.HttpsError("invalid-argument", err.message || "Invalid request.");
        case 401:
            return new functions.https.HttpsError("unauthenticated", err.message || "Authentication required.");
        case 403:
            return new functions.https.HttpsError("permission-denied", err.message || "Permission denied.");
        case 404:
            return new functions.https.HttpsError("not-found", err.message || "Record not found.");
        case 409:
            return new functions.https.HttpsError("already-exists", err.message || "Conflict.");
        default:
            return new functions.https.HttpsError("internal", err?.message || "Operation failed.");
    }
}
// Legacy callable write paths intentionally removed:
// - assignPackage
// - transferAssignment
// - recordDeliveryAttempt
// Express is the only authoritative backend for those custody-changing actions.
exports.approveCodAllocation = functions.https.onCall(async (data, context) => {
    try {
        const { uid } = await verifyUserRole(context, ["dispatch_manager", "super_admin"]);
        const { reviewId, allocations } = data || {};
        const result = await (0, logisticsAuthority_1.approveCodAllocationAuthority)({
            db,
            reviewId,
            allocations,
            actorUid: uid
        });
        return { success: true, ...result };
    }
    catch (err) {
        throw toHttpsError(err);
    }
});
exports.recalculateActiveShipmentAgeing = functions.https.onCall(async (_data, context) => {
    const { uid } = await verifyUserRole(context, ["dispatch_manager", "super_admin", "logistics", "warehouse_staff"]);
    const shipmentsSnap = await db.collection("shipments").get();
    const nowMs = Date.now();
    const nowISO = new Date(nowMs).toISOString();
    const batch = db.batch();
    let updatedCount = 0;
    shipmentsSnap.docs.forEach((doc) => {
        const shipment = doc.data();
        if (!shipment.courierBookedAt)
            return;
        const bookedMs = new Date(shipment.courierBookedAt).getTime();
        if (Number.isNaN(bookedMs))
            return;
        const endMs = shipment.courierDeliveredAt ? new Date(shipment.courierDeliveredAt).getTime() : nowMs;
        if (Number.isNaN(endMs) || endMs <= bookedMs)
            return;
        const ageHours = Math.floor((endMs - bookedMs) / (1000 * 60 * 60));
        const isLate = ageHours > 96;
        if (shipment.lateByCourier !== isLate || shipment.deliveryAgeHours !== ageHours) {
            batch.update(doc.ref, {
                lateByCourier: isLate,
                deliveryAgeHours: ageHours,
                updatedAt: nowISO,
                lastRecalculatedByUid: uid
            });
            updatedCount++;
        }
    });
    if (updatedCount > 0) {
        await batch.commit();
    }
    return { success: true, updatedCount, recalculatedAt: nowISO };
});
//# sourceMappingURL=index.js.map