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
exports.assignPackageAuthority = assignPackageAuthority;
exports.transferAssignmentAuthority = transferAssignmentAuthority;
exports.approveCodAllocationAuthority = approveCodAllocationAuthority;
exports.recordDeliveryAttemptAuthority = recordDeliveryAttemptAuthority;
const crypto = __importStar(require("crypto"));
function makeError(status, code, message) {
    return { status, code, message };
}
function normalizeStatus(value) {
    return String(value || "").toLowerCase().replace(/[\s-]+/g, "_");
}
function normalizeUpperStatus(value) {
    return String(value || "").toUpperCase().replace(/[\s-]+/g, "_");
}
function normalizeDigitalReference(reference) {
    return reference.trim().toUpperCase().replace(/[\s-]+/g, "");
}
function isDataUrl(value) {
    return typeof value === "string" && value.trim().toLowerCase().startsWith("data:");
}
function isValidCoordinate(value, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}
function normalizeIsoDate(value) {
    if (typeof value !== "string" || !value.trim())
        return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
async function assignPackageAuthority(params) {
    const { db, packageId, riderId, actorUid } = params;
    if (!packageId || !riderId) {
        throw makeError(400, "INVALID_ARGUMENT", "Missing packageId or riderId");
    }
    const assignedAt = new Date().toISOString();
    await db.runTransaction(async (transaction) => {
        const pkgRef = db.collection("packages").doc(packageId);
        const pkgDoc = await transaction.get(pkgRef);
        if (!pkgDoc.exists) {
            throw makeError(404, "NOT_FOUND", `Package ${packageId} not found`);
        }
        const pkgData = pkgDoc.data();
        if (pkgData?.importState !== "committed") {
            throw makeError(400, "FAILED_PRECONDITION", "Package is not committed");
        }
        const rawChannel = String(pkgData?.deliveryChannel || pkgData?.delivery_channel || "").toLowerCase().replace(/[\s_]+/g, "");
        if (rawChannel && !rawChannel.includes("internalrider") && rawChannel !== "internal") {
            throw makeError(400, "EXTERNAL_COURIER_ASSIGNMENT_REJECTED", "External courier package cannot be assigned to internal rider.");
        }
        const currentStatus = normalizeStatus(pkgData?.operationalStatus || pkgData?.current_status);
        if (["delivered", "returned", "cancelled", "closed"].includes(currentStatus)) {
            throw makeError(400, "INVALID_PACKAGE_STATUS", `Delivered, returned, cancelled or closed package cannot be assigned. Status: ${currentStatus}`);
        }
        if (pkgData?.assignedRiderId) {
            throw makeError(409, "PACKAGE_ALREADY_ASSIGNED", `Package ${packageId} is already assigned to rider ${pkgData.assignedRiderId}.`);
        }
        const riderRef = db.collection("riders").doc(riderId);
        const riderDoc = await transaction.get(riderRef);
        if (!riderDoc.exists) {
            throw makeError(404, "RIDER_NOT_FOUND", `Rider ${riderId} not found`);
        }
        const riderData = riderDoc.data();
        if (riderData?.active === false) {
            throw makeError(400, "RIDER_INACTIVE", `Rider ${riderId} is inactive`);
        }
        const activeSnap = await db.collection("assignments")
            .where("riderId", "==", riderId)
            .where("active", "==", true)
            .get();
        const maxCapacity = riderData?.maximum_daily_capacity || riderData?.maximumDailyCapacity || 50;
        if (activeSnap.size >= maxCapacity) {
            throw makeError(400, "RIDER_CAPACITY_EXCEEDED", `Rider ${riderId} maximum daily capacity of ${maxCapacity} reached`);
        }
        const lockRef = db.collection("assignments").doc(packageId);
        const lockDoc = await transaction.get(lockRef);
        if (lockDoc.exists && lockDoc.data()?.active === true) {
            throw makeError(409, "PACKAGE_ALREADY_ASSIGNED", `Active assignment lock exists for package ${packageId}. Simultaneous double assignment rejected.`);
        }
        transaction.set(lockRef, {
            id: packageId,
            packageId,
            riderId,
            assignedBy: actorUid,
            assignedAt,
            active: true
        });
        transaction.update(pkgRef, {
            assignedRiderId: riderId,
            rider_id: riderId,
            current_status: "Assigned",
            operationalStatus: "assigned",
            custodyStage: "assigned_to_rider",
            custody_stage: "assigned_to_rider",
            updatedAt: assignedAt
        });
        const auditRef = db.collection("auditEvents").doc();
        transaction.set(auditRef, {
            id: auditRef.id,
            action: "PACKAGE_ASSIGNED",
            packageId,
            riderId,
            assignedByUid: actorUid,
            timestamp: assignedAt
        });
    });
    return { packageId, riderId, assignedAt };
}
async function transferAssignmentAuthority(params) {
    const { db, packageId, destinationRiderId, transferReason, actorUid, actorRole, actorRiderId } = params;
    if (!packageId || !destinationRiderId) {
        throw makeError(400, "INVALID_ARGUMENT", "Missing packageId or destinationRiderId");
    }
    if (!transferReason || typeof transferReason !== "string" || !transferReason.trim()) {
        throw makeError(400, "TRANSFER_REASON_REQUIRED", "Transfer reason is required");
    }
    const transferredAt = new Date().toISOString();
    let sourceRiderId = "";
    await db.runTransaction(async (transaction) => {
        const lockRef = db.collection("assignments").doc(packageId);
        const lockDoc = await transaction.get(lockRef);
        if (!lockDoc.exists || lockDoc.data()?.active !== true) {
            throw makeError(404, "NO_ACTIVE_ASSIGNMENT", `No active assignment lock found for package ${packageId}`);
        }
        const currentLock = lockDoc.data();
        sourceRiderId = String(currentLock?.riderId || "");
        if (!sourceRiderId) {
            throw makeError(409, "ACTIVE_ASSIGNMENT_CORRUPT", `Active assignment for package ${packageId} is missing rider ownership.`);
        }
        if (actorRole === "rider" && sourceRiderId !== actorRiderId) {
            throw makeError(403, "FORBIDDEN", "Rider cannot transfer another rider's package.");
        }
        const pkgRef = db.collection("packages").doc(packageId);
        const pkgDoc = await transaction.get(pkgRef);
        if (!pkgDoc.exists) {
            throw makeError(404, "NOT_FOUND", `Package ${packageId} not found`);
        }
        const pkgData = pkgDoc.data();
        const currentStatus = normalizeStatus(pkgData?.operationalStatus || pkgData?.current_status);
        if (["delivered", "returned", "cancelled", "closed"].includes(currentStatus)) {
            throw makeError(400, "COMPLETED_PACKAGE", "Completed package cannot be transferred");
        }
        const assignedRiderId = String(pkgData?.assignedRiderId || pkgData?.rider_id || "");
        if (assignedRiderId && assignedRiderId !== sourceRiderId) {
            throw makeError(409, "ACTIVE_ASSIGNMENT_MISMATCH", "Package assignment and active assignment lock are inconsistent.");
        }
        const destRiderRef = db.collection("riders").doc(destinationRiderId);
        const destRiderDoc = await transaction.get(destRiderRef);
        if (!destRiderDoc.exists || destRiderDoc.data()?.active === false) {
            throw makeError(400, "RIDER_INACTIVE", `Destination rider ${destinationRiderId} is inactive or does not exist`);
        }
        transaction.update(lockRef, {
            active: false,
            closedAt: transferredAt,
            closeReason: "transferred"
        });
        const newLockRef = db.collection("assignments").doc(`${packageId}_tr_${Date.now()}`);
        transaction.set(newLockRef, {
            id: newLockRef.id,
            packageId,
            riderId: destinationRiderId,
            previousRiderId: sourceRiderId,
            transferReason: transferReason.trim(),
            assignedBy: actorUid,
            assignedAt: transferredAt,
            active: true
        });
        transaction.update(pkgRef, {
            assignedRiderId: destinationRiderId,
            rider_id: destinationRiderId,
            updatedAt: transferredAt
        });
        const auditRef = db.collection("auditEvents").doc();
        transaction.set(auditRef, {
            id: auditRef.id,
            action: "PACKAGE_TRANSFERRED",
            packageId,
            sourceRiderId,
            destinationRiderId,
            transferReason: transferReason.trim(),
            transferredByUid: actorUid,
            timestamp: transferredAt
        });
    });
    return { packageId, sourceRiderId, destinationRiderId, transferredAt };
}
async function approveCodAllocationAuthority(params) {
    const { db, reviewId, allocations, actorUid } = params;
    if (!reviewId || !Array.isArray(allocations)) {
        throw makeError(400, "INVALID_ARGUMENT", "Missing reviewId or allocations mapping");
    }
    const approvedAt = new Date().toISOString();
    await db.runTransaction(async (transaction) => {
        const revRef = db.collection("codAllocationReviews").doc(reviewId);
        const revDoc = await transaction.get(revRef);
        if (!revDoc.exists) {
            throw makeError(404, "NOT_FOUND", "COD Allocation Review record not found");
        }
        const revData = revDoc.data();
        if (revData?.status === "Approved") {
            throw makeError(409, "ALREADY_APPROVED", "Review has already been approved");
        }
        const remainingBalance = Number(revData?.remainingBalance ?? revData?.remaining_balance ?? 0);
        const activePkgNumbers = revData?.activePackageNumbers || [];
        const seenPkgIds = new Set();
        let totalAllocated = 0;
        for (const alloc of allocations) {
            const allocAmount = Number(alloc.allocatedCod ?? alloc.allocated_cod ?? 0);
            if (allocAmount < 0) {
                throw makeError(400, "INVALID_ALLOCATION_AMOUNT", "Allocation amount cannot be negative");
            }
            totalAllocated += allocAmount;
            if (typeof alloc.packageId !== "string" || !alloc.packageId.trim()) {
                throw makeError(400, "PACKAGE_ID_REQUIRED", "Every allocation must include a packageId.");
            }
            const pkgDocId = alloc.packageId.trim();
            if (seenPkgIds.has(pkgDocId)) {
                throw makeError(400, "DUPLICATE_ALLOCATION", `Duplicate allocation for package ${pkgDocId}`);
            }
            seenPkgIds.add(pkgDocId);
            const pkgRef = db.collection("packages").doc(pkgDocId);
            const pkgDoc = await transaction.get(pkgRef);
            if (!pkgDoc.exists) {
                throw makeError(404, "PACKAGE_NOT_FOUND", `Package ${pkgDocId} does not exist`);
            }
            const pkgData = pkgDoc.data();
            const docPkgId = pkgData?.packageId || pkgData?.id;
            if (docPkgId && docPkgId !== pkgDocId) {
                throw makeError(400, "PACKAGE_ID_MISMATCH", `Package document packageId mismatch for ${pkgDocId}`);
            }
            const allocPkgNum = alloc.packageNumber || alloc.package_number;
            if (allocPkgNum) {
                const docPkgNum = pkgData?.packageNumber || pkgData?.package_number;
                if (docPkgNum && docPkgNum !== allocPkgNum) {
                    throw makeError(400, "PACKAGE_NUMBER_MISMATCH", `Package number mismatch for package ${pkgDocId}`);
                }
            }
            const pkgNum = allocPkgNum || pkgData?.packageNumber || pkgData?.package_number || pkgDocId;
            if (pkgData?.parentOrderNumber !== revData?.parentOrderNumber && pkgData?.parent_order_number !== revData?.parent_order_number) {
                throw makeError(400, "PARENT_ORDER_MISMATCH", `Package ${pkgNum} does not belong to review parent order`);
            }
            if (pkgData?.operationalStatus !== "dispatched" && pkgData?.current_status !== "dispatched") {
                throw makeError(400, "INVALID_PACKAGE_STATUS", `Package ${pkgNum} is not in dispatched status`);
            }
            if (pkgData?.importState !== "committed") {
                throw makeError(400, "FAILED_PRECONDITION", `Package ${pkgNum} is not committed`);
            }
            transaction.update(pkgRef, {
                expectedCod: allocAmount,
                codExpected: allocAmount,
                cod_expected: allocAmount,
                requiresCodReview: false,
                requires_cod_review: false,
                updatedAt: approvedAt
            });
            const allocRef = db.collection("codAllocations").doc();
            transaction.set(allocRef, {
                id: allocRef.id,
                reviewId,
                packageId: pkgDocId,
                packageNumber: pkgNum,
                allocatedCod: allocAmount,
                createdByUid: actorUid,
                createdAt: approvedAt
            });
        }
        if (Math.abs(totalAllocated - remainingBalance) > 0.01) {
            throw makeError(400, "ALLOCATION_TOTAL_MISMATCH", `Allocation sum (${totalAllocated}) does not equal parent balance (${remainingBalance})`);
        }
        if (activePkgNumbers.length > 0 && seenPkgIds.size !== activePkgNumbers.length) {
            throw makeError(400, "INCOMPLETE_ALLOCATIONS", `Incomplete allocations: expected ${activePkgNumbers.length} packages, got ${seenPkgIds.size}`);
        }
        transaction.update(revRef, {
            status: "Approved",
            approvedByUid: actorUid,
            approvedAt
        });
        const auditRef = db.collection("auditEvents").doc();
        transaction.set(auditRef, {
            id: auditRef.id,
            action: "COD_ALLOCATION_APPROVED",
            reviewId,
            approvedByUid: actorUid,
            timestamp: approvedAt
        });
    });
    return { reviewId, approvedAt };
}
async function recordDeliveryAttemptAuthority(params) {
    const { db, auth, body, verifyDeliveryProofStorageObject } = params;
    const { packageId, status, attemptId: customAttemptId, deliveryAttemptId, collectedAmount, paymentMethod, receiverName, receiverRelationship, deviceTimestamp, latitude, longitude, proofImageUrl, proofPhoto, proofImage, proofStoragePath, gpsPermissionState, proofStatus, reason, riderNotes, customerContacted, newDeliveryDate, idempotencyKey, digitalReference } = body;
    if (!packageId || !status) {
        throw makeError(400, "INVALID_ARGUMENT", "Missing packageId or status");
    }
    const allowedOutcomes = ["DELIVERED", "CUSTOMER_UNAVAILABLE", "RESCHEDULED", "REFUSED", "ADDRESS_ISSUE", "CUSTOMER_CANCELLED"];
    const rawOutcome = normalizeUpperStatus(status);
    if (!allowedOutcomes.includes(rawOutcome)) {
        throw makeError(400, "INVALID_DELIVERY_OUTCOME", `Invalid delivery outcome "${status}". Allowed outcomes: ${allowedOutcomes.join(", ")}`);
    }
    const hasLat = isValidCoordinate(latitude, -90, 90);
    const hasLng = isValidCoordinate(longitude, -180, 180);
    const legacyProofPayload = [proofImageUrl, proofPhoto, proofImage].find((value) => typeof value === "string" && value.trim());
    const storageProofPath = typeof proofStoragePath === "string" ? proofStoragePath.trim() : "";
    if (legacyProofPayload && isDataUrl(legacyProofPayload)) {
        throw makeError(400, "BASE64_PROOF_REJECTED", "Photo proof must be uploaded to Firebase Storage first; base64 payloads are rejected.");
    }
    if (rawOutcome === "DELIVERED") {
        if (collectedAmount === undefined || collectedAmount === null || collectedAmount === "" || Number.isNaN(Number(collectedAmount))) {
            throw makeError(400, "COLLECTED_AMOUNT_REQUIRED", "Delivered status requires actual collected amount.");
        }
        if (Number(collectedAmount) < 0) {
            throw makeError(400, "NEGATIVE_COD_REJECTED", "Collected amount cannot be negative.");
        }
        if (!receiverName || typeof receiverName !== "string" || !receiverName.trim()) {
            throw makeError(400, "RECEIVER_NAME_REQUIRED", "Delivered status requires receiverName.");
        }
        if (!storageProofPath) {
            throw makeError(400, "PROOF_STORAGE_PATH_REQUIRED", "Delivered status requires a Firebase Storage proof path.");
        }
    }
    else if (rawOutcome === "RESCHEDULED") {
        if (!newDeliveryDate || typeof newDeliveryDate !== "string" || !newDeliveryDate.trim()) {
            throw makeError(400, "NEW_DELIVERY_DATE_REQUIRED", "Rescheduled status requires a new delivery date.");
        }
    }
    else if (!reason || typeof reason !== "string" || !reason.trim()) {
        throw makeError(400, "REASON_REQUIRED", "Failed delivery outcome requires a reason.");
    }
    const effectiveAttemptId = customAttemptId || deliveryAttemptId || `att_${crypto.randomUUID()}`;
    const effectiveIdemKey = idempotencyKey || `DELIVERY:${packageId}:${effectiveAttemptId}`;
    const nowStr = new Date().toISOString();
    const deliveredReceiverName = typeof receiverName === "string" ? receiverName.trim() : "";
    if (rawOutcome === "DELIVERED" && verifyDeliveryProofStorageObject) {
        await verifyDeliveryProofStorageObject({
            uid: auth.uid,
            attemptId: effectiveAttemptId,
            proofStoragePath: storageProofPath
        });
    }
    const result = await db.runTransaction(async (t) => {
        const pkgRef = db.collection("packages").doc(packageId);
        const pkgDoc = await t.get(pkgRef);
        if (!pkgDoc.exists) {
            throw makeError(404, "NOT_FOUND", `Package ${packageId} not found`);
        }
        const pkgData = pkgDoc.data();
        const assignedRiderId = pkgData?.assignedRiderId || pkgData?.rider_id || null;
        if (auth.role === "rider" && assignedRiderId !== auth.riderId) {
            throw makeError(403, "FORBIDDEN", "You are not assigned to this package. Rider completing unassigned package is strictly rejected.");
        }
        const idemRef = db.collection("idempotencyKeys").doc(effectiveIdemKey);
        const idemDoc = await t.get(idemRef);
        if (idemDoc.exists) {
            const stored = idemDoc.data();
            return { idempotent: true, data: stored?.attemptRecord || { packageId, status: rawOutcome } };
        }
        const currOpStatus = normalizeUpperStatus(pkgData?.operationalStatus || pkgData?.current_status);
        if (currOpStatus !== "OUT_FOR_DELIVERY") {
            if (currOpStatus === "DELIVERED") {
                throw makeError(400, "DUPLICATE_DELIVERY_SUBMISSION", "Package is already delivered. Duplicate delivery submission rejected.");
            }
            throw makeError(400, "INVALID_STATE_TRANSITION", `Cannot record delivery attempt for package in state "${currOpStatus}". Package must be OUT_FOR_DELIVERY.`);
        }
        let gpsExceptionRecord = null;
        if (rawOutcome === "DELIVERED" && (!hasLat || !hasLng)) {
            const gpsExceptionId = String(pkgData?.gpsExceptionId || "").trim();
            if (!gpsExceptionId) {
                throw makeError(400, "GPS_COORDINATES_REQUIRED", "Delivered status requires valid GPS coordinates unless a privileged GPS exception has already been approved.");
            }
            const gpsRef = db.collection("deliveryGpsExceptions").doc(gpsExceptionId);
            const gpsDoc = await t.get(gpsRef);
            if (!gpsDoc.exists) {
                throw makeError(400, "GPS_EXCEPTION_NOT_FOUND", "Approved GPS exception record was not found.");
            }
            gpsExceptionRecord = gpsDoc.data();
            const normalizedGpsStatus = String(gpsExceptionRecord?.status || "").toLowerCase();
            const expiresAt = normalizeIsoDate(gpsExceptionRecord?.expiresAt);
            if (normalizedGpsStatus !== "approved") {
                throw makeError(400, "GPS_EXCEPTION_INVALID", "GPS exception is not currently approved.");
            }
            if (String(gpsExceptionRecord?.packageId || "") !== packageId) {
                throw makeError(400, "GPS_EXCEPTION_PACKAGE_MISMATCH", "GPS exception does not belong to this package.");
            }
            if (expiresAt && Date.parse(nowStr) > Date.parse(expiresAt)) {
                throw makeError(400, "GPS_EXCEPTION_EXPIRED", "GPS exception has expired and cannot be used.");
            }
            if (gpsExceptionRecord?.consumedAt || gpsExceptionRecord?.consumedAttemptId) {
                throw makeError(409, "GPS_EXCEPTION_ALREADY_CONSUMED", "GPS exception has already been consumed by another attempt.");
            }
        }
        const isPrepaid = String(pkgData.paymentMethod || pkgData.payment_method || "").toLowerCase() === "prepaid" || Number(pkgData.expectedCod || pkgData.cod_expected || 0) === 0;
        const expectedCod = isPrepaid ? 0 : Number(pkgData.cod_expected || pkgData.expectedCod || pkgData.codExpected || 0);
        const collAmt = rawOutcome === "DELIVERED" ? (isPrepaid ? 0 : Number(collectedAmount)) : 0;
        const normPayment = String(paymentMethod || pkgData.paymentMethod || pkgData.payment_method || (isPrepaid ? "prepaid" : "cash")).toLowerCase().replace(/[\s_]+/g, "_");
        const isDigital = ["jazzcash", "easypaisa", "bank_transfer"].includes(normPayment);
        let normalizedDigitalReference = null;
        if (rawOutcome === "DELIVERED" && isDigital) {
            if (!digitalReference || !digitalReference.trim()) {
                throw makeError(400, "DIGITAL_REFERENCE_REQUIRED", "Digital payment method requires a digital reference.");
            }
            normalizedDigitalReference = normalizeDigitalReference(digitalReference);
            if (!normalizedDigitalReference) {
                throw makeError(400, "DIGITAL_REFERENCE_REQUIRED", "Digital payment reference cannot be blank.");
            }
            const digRef = db.collection("digitalPaymentVerifications").doc(`dig_${normalizedDigitalReference}`);
            const digDoc = await t.get(digRef);
            if (digDoc.exists) {
                const digData = digDoc.data();
                if (digData?.packageId !== packageId) {
                    throw makeError(409, "DIGITAL_REFERENCE_ALREADY_USED", `Digital reference "${normalizedDigitalReference}" has already been used for another package.`);
                }
            }
        }
        let wasCustomerContacted = customerContacted === true;
        try {
            const contactEventsQuery = db.collection("deliveryContactEvents")
                .where("packageId", "==", packageId)
                .where("riderId", "==", (auth.riderId || assignedRiderId))
                .limit(1);
            const contactEventsSnap = await t.get(contactEventsQuery);
            wasCustomerContacted = !contactEventsSnap.empty;
        }
        catch {
            wasCustomerContacted = customerContacted === true;
        }
        const attemptRef = db.collection("deliveryAttempts").doc(effectiveAttemptId);
        const attemptRecord = {
            id: effectiveAttemptId,
            packageId,
            riderId: auth.riderId || assignedRiderId,
            status: rawOutcome,
            collectedAmount: collAmt,
            paymentMethod: rawOutcome === "DELIVERED" ? (isPrepaid ? "Prepaid" : (paymentMethod || "Cash")) : null,
            receiverName: rawOutcome === "DELIVERED" ? deliveredReceiverName : null,
            receiverRelationship: rawOutcome === "DELIVERED" ? (receiverRelationship?.trim() || "Recipient") : null,
            latitude: hasLat ? Number(latitude) : null,
            longitude: hasLng ? Number(longitude) : null,
            proofImageUrl: null,
            proofStoragePath: storageProofPath || null,
            reason: reason || null,
            riderNotes: riderNotes || null,
            customerContacted: wasCustomerContacted,
            newDeliveryDate: rawOutcome === "RESCHEDULED" ? newDeliveryDate?.trim() || null : null,
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
        let codCollectionId = null;
        let collectionDiscrepancyId = null;
        if (rawOutcome === "DELIVERED") {
            t.update(pkgRef, {
                current_status: "Delivered",
                operationalStatus: "delivered",
                collectedAmount: collAmt,
                receiverName: deliveredReceiverName,
                deliveredAt: nowStr,
                failureReason: null,
                updatedAt: nowStr
            });
            if (!isPrepaid) {
                codCollectionId = `cod_${crypto.randomUUID()}`;
                const collectionVariance = collAmt - expectedCod;
                let accountCode = "RIDER_CASH_WALLET";
                if (normPayment === "jazzcash")
                    accountCode = "JAZZCASH_CLEARING";
                else if (normPayment === "easypaisa")
                    accountCode = "EASYPAISA_CLEARING";
                else if (normPayment === "bank_transfer")
                    accountCode = "BANK_TRANSFER_CLEARING";
                if (collAmt > 0) {
                    txId = `tx_${crypto.randomUUID()}`;
                    const txRef = db.collection("financialTransactions").doc(txId);
                    t.set(txRef, {
                        id: txId,
                        transactionType: "COD_COLLECTION",
                        sourceType: "cod_collection",
                        sourceId: packageId,
                        packageId,
                        riderId: auth.riderId || assignedRiderId,
                        cashierProfileId: null,
                        settlementId: null,
                        bankDepositId: null,
                        status: "posted",
                        currency: "PKR",
                        totalDebit: collAmt,
                        totalCredit: collAmt,
                        idempotencyKey: effectiveIdemKey,
                        createdByUid: auth.uid,
                        createdAt: nowStr,
                        reversedTransactionId: null,
                        reversedByUid: null,
                        reversedAt: null,
                        reversalReason: null
                    });
                    const postDebitRef = db.collection("financialPostings").doc(`post_dr_${crypto.randomUUID()}`);
                    t.set(postDebitRef, {
                        id: postDebitRef.id,
                        transactionId: txId,
                        accountCode,
                        debitAmount: collAmt,
                        creditAmount: 0,
                        packageId,
                        riderId: auth.riderId || assignedRiderId,
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
                        riderId: auth.riderId || assignedRiderId,
                        createdAt: nowStr
                    });
                }
                codCollectionRecord = {
                    id: codCollectionId,
                    packageId,
                    riderId: auth.riderId || assignedRiderId,
                    expectedCod,
                    collectedAmount: collAmt,
                    paymentMethod: normPayment,
                    digitalReference: normalizedDigitalReference,
                    collectionVariance,
                    idempotencyKey: effectiveIdemKey,
                    transactionId: txId,
                    discrepancyId: null,
                    createdAt: nowStr,
                    updatedAt: nowStr
                };
                if (collectionVariance !== 0) {
                    collectionDiscrepancyId = `cod_disc_${crypto.randomUUID()}`;
                    codCollectionRecord.discrepancyId = collectionDiscrepancyId;
                    t.set(db.collection("codCollectionDiscrepancies").doc(collectionDiscrepancyId), {
                        id: collectionDiscrepancyId,
                        packageId,
                        riderId: auth.riderId || assignedRiderId,
                        expectedCod,
                        collectedAmount: collAmt,
                        variance: collectionVariance,
                        reason: null,
                        resolutionType: null,
                        status: "OPEN",
                        createdAt: nowStr,
                        approvedAt: null,
                        approvedByUid: null,
                        resolvedAt: null,
                        resolvedByUid: null,
                        settlementId: null
                    });
                }
                t.set(db.collection("codCollections").doc(codCollectionId), codCollectionRecord);
                if (isDigital && normalizedDigitalReference) {
                    t.set(db.collection("digitalPaymentVerifications").doc(`dig_${normalizedDigitalReference}`), {
                        id: `dig_${normalizedDigitalReference}`,
                        digitalReference: normalizedDigitalReference,
                        packageId,
                        paymentMethod: normPayment,
                        amount: collAmt,
                        verificationStatus: "PENDING",
                        status: "pending",
                        verificationNote: null,
                        verifiedByUid: null,
                        verifiedAt: null,
                        createdAt: nowStr
                    });
                }
            }
            const deliveryProofRef = db.collection("deliveryProofs").doc(`proof_${effectiveAttemptId}`);
            t.set(deliveryProofRef, {
                id: deliveryProofRef.id,
                attemptId: effectiveAttemptId,
                packageId,
                riderId: auth.riderId || assignedRiderId,
                proofStoragePath: storageProofPath,
                latitude: hasLat ? Number(latitude) : null,
                longitude: hasLng ? Number(longitude) : null,
                capturedAt: deviceTimestamp || nowStr,
                uploadedAt: nowStr,
                receiverName: deliveredReceiverName,
                createdAt: nowStr
            });
            t.set(db.collection("auditLogs").doc(`audit_${crypto.randomUUID()}`), {
                id: `audit_${crypto.randomUUID()}`,
                action: "PACKAGE_DELIVERED",
                packageId,
                riderId: auth.riderId || assignedRiderId,
                actorUid: auth.uid,
                actorRole: auth.role,
                metadata: {
                    attemptId: effectiveAttemptId,
                    collectedAmount: collAmt,
                    paymentMethod: normPayment,
                    txId,
                    discrepancyId: collectionDiscrepancyId
                },
                timestamp: nowStr
            });
            if (gpsExceptionRecord) {
                t.set(db.collection("deliveryGpsExceptions").doc(String(gpsExceptionRecord.id || pkgData?.gpsExceptionId)), {
                    status: "consumed",
                    consumedAttemptId: effectiveAttemptId,
                    consumedAt: nowStr,
                    consumedByUid: auth.uid,
                    updatedAt: nowStr
                }, { merge: true });
                t.set(pkgRef, {
                    gpsExceptionApproved: false,
                    gpsExceptionId: null,
                    gpsExceptionApprovedAt: null,
                    gpsExceptionApprovedByUid: null,
                    gpsExceptionReason: null,
                    gpsExceptionExpiresAt: null,
                    gpsExceptionConsumedAt: nowStr,
                    gpsExceptionConsumedAttemptId: effectiveAttemptId,
                    updatedAt: nowStr
                }, { merge: true });
            }
        }
        else {
            let targetStatus = "Customer Unavailable";
            let targetOperationalStatus = "customer_unavailable";
            if (rawOutcome === "RESCHEDULED") {
                targetStatus = "Rescheduled";
                targetOperationalStatus = "rescheduled";
            }
            else if (rawOutcome === "REFUSED") {
                targetStatus = "Refused";
                targetOperationalStatus = "refused";
            }
            else if (rawOutcome === "ADDRESS_ISSUE") {
                targetStatus = "Incorrect Address";
                targetOperationalStatus = "address_issue";
            }
            else if (rawOutcome === "CUSTOMER_CANCELLED") {
                targetStatus = "Cancelled";
                targetOperationalStatus = "cancelled";
            }
            t.update(pkgRef, {
                current_status: targetStatus,
                operationalStatus: targetOperationalStatus,
                failureReason: reason?.trim() || null,
                nextAttemptDate: rawOutcome === "RESCHEDULED" ? newDeliveryDate?.trim() || null : null,
                updatedAt: nowStr
            });
            t.set(db.collection("returns").doc(`ret_${packageId}`), {
                id: `ret_${packageId}`,
                packageId,
                packageNumber: pkgData?.packageNumber || pkgData?.package_number || packageId,
                riderId: auth.riderId || assignedRiderId,
                returnReason: reason || rawOutcome,
                returnStatus: "return_required",
                createdAt: nowStr,
                updatedAt: nowStr
            }, { merge: true });
            t.set(db.collection("auditLogs").doc(`audit_${crypto.randomUUID()}`), {
                id: `audit_${crypto.randomUUID()}`,
                action: `DELIVERY_FAILED_${rawOutcome}`,
                packageId,
                riderId: auth.riderId || assignedRiderId,
                actorUid: auth.uid,
                actorRole: auth.role,
                metadata: {
                    attemptId: effectiveAttemptId,
                    reason,
                    nextAttemptDate: newDeliveryDate
                },
                timestamp: nowStr
            });
        }
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
    return result.data;
}
//# sourceMappingURL=logisticsAuthority.js.map