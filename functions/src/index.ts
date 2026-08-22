import * as functions from 'firebase-functions/v1';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

// Helper to check user auth and role
async function verifyUserRole(context: functions.https.CallableContext, allowedRoles: string[]) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }
  const uid = context.auth.uid;
  const userDoc = await db.collection('profiles').doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'User profile not found.');
  }
  const userData = userDoc.data();
  if (!userData?.active) {
    throw new functions.https.HttpsError('permission-denied', 'Account is inactive.');
  }
  if (!allowedRoles.includes(userData.role) && userData.role !== 'super_admin') {
    throw new functions.https.HttpsError('permission-denied', 'Insufficient permissions for this operation.');
  }
  return { uid, userData };
}

// Active cloud functions
export const assignPackage = functions.https.onCall(async (data, context) => {
  const { uid } = await verifyUserRole(context, ['dispatch_manager', 'super_admin']);
  const { packageId, riderId } = data || {};
  if (!packageId || !riderId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing packageId or riderId.');
  }

  return await db.runTransaction(async (transaction) => {
    const pkgRef = db.collection('packages').doc(packageId);
    const pkgDoc = await transaction.get(pkgRef);
    if (!pkgDoc.exists) {
      throw new functions.https.HttpsError('not-found', `Package ${packageId} does not exist.`);
    }

    const pkgData = pkgDoc.data();
    if (pkgData?.importState !== 'committed') {
      throw new functions.https.HttpsError('failed-precondition', 'Package is not committed.');
    }

    const rawChannel = (pkgData?.deliveryChannel || pkgData?.delivery_channel || '').toLowerCase().replace(/[\s_]+/g, '');
    if (rawChannel && !rawChannel.includes('internalrider') && rawChannel !== 'internal') {
      throw new functions.https.HttpsError('invalid-argument', 'Cannot assign package with non-internal rider delivery channel.');
    }

    const currentStatus = (pkgData?.operationalStatus || pkgData?.current_status || '').toLowerCase();
    if (['delivered', 'returned', 'cancelled', 'closed'].includes(currentStatus)) {
      throw new functions.https.HttpsError('failed-precondition', `Completed or closed package cannot be assigned. Current status: ${currentStatus}`);
    }

    const riderRef = db.collection('riders').doc(riderId);
    const riderDoc = await transaction.get(riderRef);
    if (!riderDoc.exists) {
      throw new functions.https.HttpsError('not-found', `Rider ${riderId} does not exist.`);
    }
    const riderData = riderDoc.data();
    if (riderData?.active === false) {
      throw new functions.https.HttpsError('failed-precondition', `Rider ${riderId} is inactive.`);
    }

    // Capacity Check
    const activeAssignmentsSnap = await db.collection('assignments')
      .where('riderId', '==', riderId)
      .where('active', '==', true)
      .get();
    
    const maxCapacity = riderData?.maximum_daily_capacity || riderData?.maximumDailyCapacity || 50;
    if (activeAssignmentsSnap.size >= maxCapacity) {
      throw new functions.https.HttpsError('resource-exhausted', `Rider ${riderId} has reached maximum daily capacity (${maxCapacity}).`);
    }

    // Active Assignment Lock Check
    const lockRef = db.collection('assignments').doc(packageId);
    const lockDoc = await transaction.get(lockRef);
    if (lockDoc.exists && lockDoc.data()?.active === true) {
      throw new functions.https.HttpsError('already-exists', `Active assignment lock exists for package ${packageId}. Double assignment blocked.`);
    }

    // Perform atomic updates
    const nowStr = new Date().toISOString();
    transaction.set(lockRef, {
      id: packageId,
      packageId,
      riderId,
      assignedBy: uid,
      assignedAt: nowStr,
      active: true
    });

    transaction.update(pkgRef, {
      assignedRiderId: riderId,
      rider_id: riderId,
      current_status: 'Assigned',
      operationalStatus: 'assigned',
      updatedAt: nowStr
    });

    const auditRef = db.collection('auditEvents').doc();
    transaction.set(auditRef, {
      id: auditRef.id,
      action: 'PACKAGE_ASSIGNED',
      packageId,
      riderId,
      assignedByUid: uid,
      timestamp: nowStr
    });

    return { success: true, packageId, riderId, assignedAt: nowStr };
  });
});

export const transferAssignment = functions.https.onCall(async (data, context) => {
  const { uid } = await verifyUserRole(context, ['dispatch_manager', 'super_admin', 'rider']);
  const { packageId, sourceRiderId, destinationRiderId, transferReason } = data || {};

  if (!packageId || !sourceRiderId || !destinationRiderId || !transferReason?.trim()) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing packageId, sourceRiderId, destinationRiderId, or transferReason.');
  }

  return await db.runTransaction(async (transaction) => {
    const lockRef = db.collection('assignments').doc(packageId);
    const lockDoc = await transaction.get(lockRef);
    if (!lockDoc.exists || lockDoc.data()?.active !== true) {
      throw new functions.https.HttpsError('not-found', `No active assignment found for package ${packageId}.`);
    }

    const currentLock = lockDoc.data();
    if (currentLock?.riderId !== sourceRiderId) {
      throw new functions.https.HttpsError('permission-denied', 'Source rider does not match current active assignment.');
    }

    const pkgRef = db.collection('packages').doc(packageId);
    const pkgDoc = await transaction.get(pkgRef);
    if (!pkgDoc.exists) {
      throw new functions.https.HttpsError('not-found', `Package ${packageId} does not exist.`);
    }
    const pkgData = pkgDoc.data();
    const currentStatus = (pkgData?.operationalStatus || pkgData?.current_status || '').toLowerCase();
    if (['delivered', 'returned', 'cancelled', 'closed'].includes(currentStatus)) {
      throw new functions.https.HttpsError('failed-precondition', 'Completed package cannot be transferred.');
    }

    const destRiderRef = db.collection('riders').doc(destinationRiderId);
    const destRiderDoc = await transaction.get(destRiderRef);
    if (!destRiderDoc.exists || destRiderDoc.data()?.active === false) {
      throw new functions.https.HttpsError('failed-precondition', `Destination rider ${destinationRiderId} is inactive or does not exist.`);
    }

    const nowStr = new Date().toISOString();
    // Close old assignment, open new assignment
    transaction.update(lockRef, {
      active: false,
      closedAt: nowStr,
      closeReason: 'transferred'
    });

    const newLockRef = db.collection('assignments').doc(`${packageId}_t_${Date.now()}`);
    transaction.set(newLockRef, {
      id: newLockRef.id,
      packageId,
      riderId: destinationRiderId,
      previousRiderId: sourceRiderId,
      transferReason,
      assignedBy: uid,
      assignedAt: nowStr,
      active: true
    });

    transaction.update(pkgRef, {
      assignedRiderId: destinationRiderId,
      rider_id: destinationRiderId,
      updatedAt: nowStr
    });

    const auditRef = db.collection('auditEvents').doc();
    transaction.set(auditRef, {
      id: auditRef.id,
      action: 'PACKAGE_TRANSFERRED',
      packageId,
      sourceRiderId,
      destinationRiderId,
      transferReason,
      transferredByUid: uid,
      timestamp: nowStr
    });

    return { success: true, packageId, destinationRiderId, transferredAt: nowStr };
  });
});

export const recordDeliveryAttempt = functions.https.onCall(async (data, context) => {
  const { userData } = await verifyUserRole(context, ['rider', 'dispatch_manager', 'super_admin']);
  const {
    packageId,
    status,
    collectedAmount,
    paymentMethod,
    receiverName,
    receiverRelationship,
    deviceTimestamp,
    gpsPermissionState,
    proofStatus,
    reason,
    riderNotes,
    customerContacted,
    newDeliveryDate
  } = data || {};

  if (!packageId || !status) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing packageId or status.');
  }

  const pkgRef = db.collection('packages').doc(packageId);
  const pkgDoc = await pkgRef.get();
  if (!pkgDoc.exists) {
    throw new functions.https.HttpsError('not-found', `Package ${packageId} does not exist.`);
  }

  const pkgData = pkgDoc.data();
  let riderId = userData.role === 'rider' ? context.auth?.uid : (pkgData?.assignedRiderId || pkgData?.rider_id);

  if (userData.role === 'rider') {
    // Find linked rider ID if profile UID doesn't match directly
    if (pkgData?.assignedRiderId !== context.auth?.uid && pkgData?.rider_id !== context.auth?.uid) {
      const ridersSnap = await db.collection('riders').where('profileId', '==', context.auth?.uid).limit(1).get();
      if (!ridersSnap.empty) {
        riderId = ridersSnap.docs[0].id;
      }
    }
    if (pkgData?.assignedRiderId !== riderId && pkgData?.rider_id !== riderId) {
      throw new functions.https.HttpsError('permission-denied', 'Rider is not assigned to this package.');
    }
  }

  const normStatus = (status || '').toLowerCase().replace(/[\s_]+/g, '');
  const currStatus = (pkgData?.operationalStatus || pkgData?.current_status || '').toLowerCase().replace(/[\s_]+/g, '');

  if (currStatus === 'delivered') {
    throw new functions.https.HttpsError('already-exists', 'Package is already delivered. Duplicate submission blocked.');
  }
  if (['returned', 'cancelled', 'closed'].includes(currStatus)) {
    throw new functions.https.HttpsError('failed-precondition', `Invalid state transition from ${currStatus} to ${normStatus}.`);
  }

  const nowStr = new Date().toISOString();

  if (normStatus === 'delivered') {
    if (collectedAmount === undefined || collectedAmount === null) {
      throw new functions.https.HttpsError('invalid-argument', 'Delivered status requires actual collected amount.');
    }
    if (!receiverName?.trim() || !receiverRelationship?.trim()) {
      throw new functions.https.HttpsError('invalid-argument', 'Delivered status requires receiverName and receiverRelationship.');
    }
  } else if (normStatus === 'rescheduled') {
    if (!newDeliveryDate?.trim()) {
      throw new functions.https.HttpsError('invalid-argument', 'Rescheduled status requires a new delivery date.');
    }
  } else {
    if (!reason?.trim()) {
      throw new functions.https.HttpsError('invalid-argument', 'Failed delivery attempt requires a valid reason.');
    }
  }

  const attemptId = `att_${Date.now()}_${Math.random().toString(36).substring(2,6)}`;
  const attemptData = {
    id: attemptId,
    packageId,
    riderId,
    status,
    collectedAmount: normStatus === 'delivered' ? Number(collectedAmount) : 0,
    paymentMethod: normStatus === 'delivered' ? paymentMethod || 'Cash' : null,
    receiverName: normStatus === 'delivered' ? receiverName : null,
    receiverRelationship: normStatus === 'delivered' ? receiverRelationship : null,
    reason: reason || null,
    riderNotes: riderNotes || null,
    customerContacted: customerContacted !== false,
    newDeliveryDate: normStatus === 'rescheduled' ? newDeliveryDate : null,
    serverTimestamp: nowStr,
    deviceTimestamp: deviceTimestamp || nowStr,
    gpsPermissionState: gpsPermissionState || 'granted',
    proofStatus: proofStatus || 'pending',
    createdAt: nowStr
  };

  await db.collection('deliveryAttempts').doc(attemptId).set(attemptData);

  let targetStatus = 'Delivered';
  if (normStatus === 'customerunavailable') targetStatus = 'Customer Unavailable';
  else if (normStatus === 'rescheduled') targetStatus = 'Rescheduled';
  else if (normStatus === 'refused') targetStatus = 'Refused';
  else if (normStatus === 'incorrectaddress') targetStatus = 'Incorrect Address';
  else if (normStatus === 'returningtowarehouse') targetStatus = 'Returning to Warehouse';

  await pkgRef.update({
    current_status: targetStatus,
    operationalStatus: targetStatus.toLowerCase().replace(/[\s_]+/g, '_'),
    collectedAmount: normStatus === 'delivered' ? Number(collectedAmount) : 0,
    receiverName: normStatus === 'delivered' ? receiverName : null,
    failureReason: reason || null,
    nextAttemptDate: normStatus === 'rescheduled' ? newDeliveryDate : null,
    updatedAt: nowStr
  });

  return { success: true, attemptId, status: targetStatus, serverTimestamp: nowStr };
});

export const approveCodAllocation = functions.https.onCall(async (data, context) => {
  const { uid } = await verifyUserRole(context, ['dispatch_manager', 'super_admin']);
  const { reviewId, allocations } = data || {};
  if (!reviewId || !allocations || !Array.isArray(allocations)) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing reviewId or allocations array.');
  }

  return await db.runTransaction(async (transaction) => {
    const revRef = db.collection('codAllocationReviews').doc(reviewId);
    const revDoc = await transaction.get(revRef);

    if (!revDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'COD Allocation Review record not found.');
    }

    const revData = revDoc.data();
    if (revData?.status === 'Approved') {
      throw new functions.https.HttpsError('failed-precondition', 'COD Allocation Review was already approved.');
    }

    const remainingBalance = revData?.remainingBalance ?? revData?.remaining_balance ?? 0;
    const activePkgNumbers: string[] = revData?.activePackageNumbers || [];

    const seenPkgIds = new Set<string>();
    let totalAllocated = 0;

    for (const alloc of allocations) {
      const allocAmount = alloc.allocatedCod ?? alloc.allocated_cod ?? 0;
      if (allocAmount < 0) {
        throw new functions.https.HttpsError('invalid-argument', 'Allocation amount cannot be negative.');
      }
      totalAllocated += allocAmount;

      if (typeof alloc.packageId !== 'string' || !alloc.packageId.trim()) {
        throw new functions.https.HttpsError('invalid-argument', 'Every allocation must include a packageId.');
      }
      const packageId = alloc.packageId.trim();

      if (seenPkgIds.has(packageId)) {
        throw new functions.https.HttpsError('invalid-argument', `Duplicate allocation for package ${packageId}`);
      }
      seenPkgIds.add(packageId);

      const pkgRef = db.collection('packages').doc(packageId);
      const pkgDoc = await transaction.get(pkgRef);

      if (!pkgDoc.exists) {
        throw new functions.https.HttpsError('not-found', `Package ${packageId} does not exist.`);
      }

      const pkgData = pkgDoc.data();
      const docPackageId = pkgData?.packageId || pkgData?.id;
      if (docPackageId && docPackageId !== packageId) {
        throw new functions.https.HttpsError('invalid-argument', `Package document packageId mismatch for ${packageId}.`);
      }

      const allocPkgNum = alloc.packageNumber || alloc.package_number;
      if (allocPkgNum) {
        const docPkgNum = pkgData?.packageNumber || pkgData?.package_number;
        if (docPkgNum && docPkgNum !== allocPkgNum) {
          throw new functions.https.HttpsError('invalid-argument', `Package number mismatch for package ${packageId}.`);
        }
      }

      const pkgNum = allocPkgNum || pkgData?.packageNumber || pkgData?.package_number || packageId;
      if (pkgData?.parentOrderNumber !== revData?.parentOrderNumber && pkgData?.parent_order_number !== revData?.parent_order_number) {
        throw new functions.https.HttpsError('invalid-argument', `Package ${pkgNum} does not belong to review parent order.`);
      }

      if (pkgData?.operationalStatus !== 'dispatched' && pkgData?.current_status !== 'dispatched') {
        throw new functions.https.HttpsError('failed-precondition', `Package ${pkgNum} is not in dispatched status.`);
      }

      if (pkgData?.importState !== 'committed') {
        throw new functions.https.HttpsError('failed-precondition', `Package ${pkgNum} is not committed.`);
      }

      transaction.update(pkgRef, {
        expectedCod: allocAmount,
        codExpected: allocAmount,
        cod_expected: allocAmount,
        requiresCodReview: false,
        requires_cod_review: false,
        updatedAt: new Date().toISOString()
      });

      const allocRef = db.collection('codAllocations').doc();
      transaction.set(allocRef, {
        id: allocRef.id,
        reviewId,
        packageId: packageId,
        packageNumber: pkgNum,
        allocatedCod: allocAmount,
        createdByUid: uid,
        createdAt: new Date().toISOString()
      });
    }

    if (Math.abs(totalAllocated - remainingBalance) > 0.01) {
      throw new functions.https.HttpsError('invalid-argument', `Allocation sum (${totalAllocated}) does not equal remaining balance (${remainingBalance}).`);
    }

    if (activePkgNumbers.length > 0 && seenPkgIds.size !== activePkgNumbers.length) {
      throw new functions.https.HttpsError('invalid-argument', `Incomplete allocations: expected ${activePkgNumbers.length} packages, got ${seenPkgIds.size}.`);
    }

    transaction.update(revRef, {
      status: 'Approved',
      approvedByUid: uid,
      approvedAt: new Date().toISOString()
    });

    const auditRef = db.collection('auditEvents').doc();
    transaction.set(auditRef, {
      id: auditRef.id,
      action: 'COD_ALLOCATION_APPROVED',
      reviewId,
      approvedByUid: uid,
      timestamp: new Date().toISOString()
    });

    return { success: true, reviewId, approvedAt: new Date().toISOString() };
  });
});

// Scheduled / Callable function to recalculate shipment SLA ageing (> 96 hours)
export const recalculateActiveShipmentAgeing = functions.https.onCall(async (data, context) => {
  await verifyUserRole(context, ['dispatch_manager', 'super_admin', 'logistics', 'warehouse_staff']);
  
  const shipmentsSnap = await db.collection('shipments').get();
  const nowMs = Date.now();
  const nowISO = new Date(nowMs).toISOString();
  
  const batch = db.batch();
  let updatedCount = 0;

  shipmentsSnap.docs.forEach(doc => {
    const shipment = doc.data();
    if (!shipment.courierBookedAt) return;

    const bookedMs = new Date(shipment.courierBookedAt).getTime();
    if (isNaN(bookedMs)) return;

    const endMs = shipment.courierDeliveredAt ? new Date(shipment.courierDeliveredAt).getTime() : nowMs;
    if (isNaN(endMs) || endMs <= bookedMs) return;

    const ageHours = Math.floor((endMs - bookedMs) / (1000 * 60 * 60));
    const isLate = ageHours > 96;

    if (shipment.lateByCourier !== isLate || shipment.deliveryAgeHours !== ageHours) {
      batch.update(doc.ref, {
        lateByCourier: isLate,
        deliveryAgeHours: ageHours,
        updatedAt: nowISO
      });
      updatedCount++;
    }
  });

  if (updatedCount > 0) {
    await batch.commit();
  }

  return { success: true, updatedCount, recalculatedAt: nowISO };
});

