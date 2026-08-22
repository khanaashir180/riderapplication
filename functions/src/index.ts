import * as functions from "firebase-functions/v1";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { approveCodAllocationAuthority } from "../../src/services/logisticsAuthority";

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

async function verifyUserRole(context: functions.https.CallableContext, allowedRoles: string[]) {
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

function toHttpsError(err: any) {
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

export const approveCodAllocation = functions.https.onCall(async (data, context) => {
  try {
    const { uid } = await verifyUserRole(context, ["dispatch_manager", "super_admin"]);
    const { reviewId, allocations } = data || {};

    const result = await approveCodAllocationAuthority({
      db,
      reviewId,
      allocations,
      actorUid: uid
    });

    return { success: true, ...result };
  } catch (err: any) {
    throw toHttpsError(err);
  }
});

export const recalculateActiveShipmentAgeing = functions.https.onCall(async (_data, context) => {
  const { uid } = await verifyUserRole(context, ["dispatch_manager", "super_admin", "logistics", "warehouse_staff"]);

  const shipmentsSnap = await db.collection("shipments").get();
  const nowMs = Date.now();
  const nowISO = new Date(nowMs).toISOString();

  const batch = db.batch();
  let updatedCount = 0;

  shipmentsSnap.docs.forEach((doc) => {
    const shipment = doc.data();
    if (!shipment.courierBookedAt) return;

    const bookedMs = new Date(shipment.courierBookedAt).getTime();
    if (Number.isNaN(bookedMs)) return;

    const endMs = shipment.courierDeliveredAt ? new Date(shipment.courierDeliveredAt).getTime() : nowMs;
    if (Number.isNaN(endMs) || endMs <= bookedMs) return;

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
