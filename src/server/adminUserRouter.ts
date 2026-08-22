import { Router } from 'express';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import crypto from 'crypto';
import { UserRole } from '../types.js';

export const VALID_ROLES: UserRole[] = [
  'super_admin',
  'dispatch_manager',
  'rider',
  'cashier',
  'customer_service',
  'warehouse_staff',
  'management_viewer'
];

export interface RiderOpenOperationsResult {
  hasOpenOperations: boolean;
  activeAssignmentCount: number;
  openDispatchRunCount: number;
  openSettlementCount: number;
  unreturnedPackageCount: number;
  pendingReturnCount: number;
  pendingOfflineActionCount: number;
}

// Adapter to count pending offline actions for a rider
export const OFFLINE_ACTIONS_ENABLED = process.env.OFFLINE_ACTIONS_ENABLED === 'true';

export async function countPendingOfflineActions(
  db: FirebaseFirestore.Firestore,
  riderId: string
): Promise<number> {
  if (!OFFLINE_ACTIONS_ENABLED) return 0;
  if (!riderId) return 0;

  const snap = await db.collection('offlineActions')
    .where('riderId', '==', riderId)
    .get();
  if (snap.empty) return 0;
  const pendingStatuses = ['pending', 'syncing', 'conflict', 'failed requiring intervention', 'failed_requiring_intervention', 'failed'];
  return snap.docs.filter(d => {
    const st = String(d.data().status || '').trim().toLowerCase();
    return pendingStatuses.includes(st);
  }).length;
}

// 1. Canonical open-operations checker
export async function getRiderOpenOperations(
  db: FirebaseFirestore.Firestore,
  riderId: string
): Promise<RiderOpenOperationsResult> {
  if (!riderId) {
    return {
      hasOpenOperations: false,
      activeAssignmentCount: 0,
      openDispatchRunCount: 0,
      openSettlementCount: 0,
      unreturnedPackageCount: 0,
      pendingReturnCount: 0,
      pendingOfflineActionCount: 0
    };
  }

  // 1. Active assignments
  const assignSnap = await db.collection('assignments')
    .where('riderId', '==', riderId)
    .where('active', '==', true)
    .get();
  const activeAssignmentCount = assignSnap.size;

  // 2. Open dispatch runs (closed, completed, cancelled are closed)
  const runSnap = await db.collection('dispatchRuns')
    .where('riderId', '==', riderId)
    .get();
  const closedRunStatuses = ['closed', 'completed', 'cancelled'];
  const openDispatchRunCount = runSnap.docs.filter(d => {
    const st = String(d.data().status || '').trim().toLowerCase();
    return !closedRunStatuses.includes(st);
  }).length;

  // 3. Open settlements (query riderSettlements collection!)
  const setSnap = await db.collection('riderSettlements')
    .where('riderId', '==', riderId)
    .get();
  const openSettlementCount = setSnap.docs.filter(d => {
    const st = String(d.data().status || '').trim().toLowerCase();
    return st !== 'closed';
  }).length;

  // 4 & 5. Unreturned packages & Pending returns
  const pkgSnap = await db.collection('packages')
    .where('assignedRiderId', '==', riderId)
    .get();

  const pendingReturnStatusesPkg = ['RETURN_AWAITING_PHYSICAL_RECEIPT', 'RETURN_REQUESTED', 'RETURN_IN_TRANSIT'];
  const pendingPkgIds = new Set<string>();
  pkgSnap.docs.forEach(d => {
    const st = String(d.data().operationalStatus || d.data().status || '').trim().toUpperCase();
    if (pendingReturnStatusesPkg.includes(st)) {
      pendingPkgIds.add(d.id);
    }
  });

  const returnColSnap = await db.collection('returns')
    .where('riderId', '==', riderId)
    .get();
  const pendingReturnColStatuses = ['rider_handed_back', 'returning_to_warehouse', 'return_requested'];
  returnColSnap.docs.forEach(d => {
    const st = String(d.data().returnStatus || d.data().status || '').trim().toLowerCase();
    if (pendingReturnColStatuses.includes(st)) {
      const pkgId = d.data().packageId || d.id;
      pendingPkgIds.add(pkgId);
    }
  });

  const pendingReturnCount = pendingPkgIds.size;

  const finalPackageStatuses = ['DELIVERED', 'RETURN_PHYSICALLY_RECEIVED', 'CANCELLED', 'RETURNED_TO_WAREHOUSE', 'RETURNED TO WAREHOUSE'];
  const unreturnedPackageCount = pkgSnap.docs.filter(d => {
    if (pendingPkgIds.has(d.id)) return false; // Exclude return custody packages
    const st = String(d.data().operationalStatus || d.data().status || '').trim().toUpperCase();
    return !finalPackageStatuses.includes(st);
  }).length;

  // 6. Pending offline actions adapter
  const pendingOfflineActionCount = await countPendingOfflineActions(db, riderId);

  const hasOpenOperations = (
    activeAssignmentCount +
    openDispatchRunCount +
    openSettlementCount +
    unreturnedPackageCount +
    pendingReturnCount +
    pendingOfflineActionCount
  ) > 0;

  return {
    hasOpenOperations,
    activeAssignmentCount,
    openDispatchRunCount,
    openSettlementCount,
    unreturnedPackageCount,
    pendingReturnCount,
    pendingOfflineActionCount
  };
}

// 2. Code Normalisation & Search Prefixes Helpers
export function normalizeCode(code: string): string {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

export function normalizeSearchTerm(term: string): string {
  return String(term || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function generateSearchPrefixes(...inputs: (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const input of inputs) {
    if (!input) continue;
    const normalized = normalizeSearchTerm(input);
    if (!normalized) continue;
    set.add(normalized); // exact full string
    const tokens = normalized.split(' ');
    for (const token of tokens) {
      if (!token) continue;
      set.add(token);
      for (let i = 1; i <= Math.min(token.length, 35); i++) {
        set.add(token.substring(0, i));
      }
    }
  }
  return Array.from(set);
}

export function toIsoString(val: any): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (val.toDate && typeof val.toDate === 'function') return val.toDate().toISOString();
  if (val._seconds !== undefined) return new Date(val._seconds * 1000).toISOString();
  if (val instanceof Date) return val.toISOString();
  return null;
}

export function getCodeLockDocId(normalizedCode: string): string {
  return crypto.createHash('sha256').update(normalizedCode).digest('hex');
}

// 3. Code Uniqueness Reservation Helper with SHA-256 IDs & Reservation IDs
export async function reserveCode(
  db: FirebaseFirestore.Firestore,
  collectionName: 'uniqueEmployeeCodes' | 'uniqueRiderCodes',
  rawCode: string,
  targetUid: string | null,
  operatorUid: string
): Promise<{ normalizedCode: string; reservationId: string; docRef: FirebaseFirestore.DocumentReference }> {
  const normalizedCode = normalizeCode(rawCode);
  const lockDocId = getCodeLockDocId(normalizedCode);
  const docRef = db.collection(collectionName).doc(lockDocId);
  const reservationId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);
    if (doc.exists) {
      const data = doc.data()!;
      if (data.status === 'committed') {
        const errCode = collectionName === 'uniqueEmployeeCodes' ? 'DUPLICATE_EMPLOYEE_CODE' : 'DUPLICATE_RIDER_CODE';
        const err = new Error(errCode);
        (err as any).code = errCode;
        throw err;
      } else if (data.status === 'reserved') {
        if (data.reservationId !== reservationId) {
          const errCode = collectionName === 'uniqueEmployeeCodes' ? 'DUPLICATE_EMPLOYEE_CODE' : 'DUPLICATE_RIDER_CODE';
          const err = new Error(errCode);
          (err as any).code = errCode;
          throw err;
        }
      }
    }

    transaction.set(docRef, {
      normalisedValue: normalizedCode,
      rawCode: rawCode,
      targetUid: targetUid || null,
      status: 'reserved',
      reservationId: reservationId,
      reservedByUid: operatorUid,
      reservedAt: FieldValue.serverTimestamp()
    });
  });

  return { normalizedCode, reservationId, docRef };
}

export type ReservationReleaseResult =
  | 'released'
  | 'not_found'
  | 'not_owned'
  | 'committed'
  | 'failed';

// Transactional Reservation Cleanup Helper (cannot delete another request's lock)
export async function releaseCodeReservation(
  db: FirebaseFirestore.Firestore,
  docRef: FirebaseFirestore.DocumentReference | null,
  reservationId: string | null
): Promise<ReservationReleaseResult> {
  if (!docRef || !reservationId) return 'not_found';
  try {
    return await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) return 'not_found';
      const data = doc.data()!;
      if (data.status === 'committed') return 'committed';
      if (data.reservationId !== reservationId) return 'not_owned';
      if (data.status === 'reserved') {
        transaction.delete(docRef);
        return 'released';
      }
      return 'not_found';
    });
  } catch (err: any) {
    console.error('Failed to release code reservation:', {
      collection: docRef.parent ? docRef.parent.id : 'unknown',
      docId: docRef.id,
      reservationId,
      error: String(err?.message || err)
    });
    try {
      await db.collection('systemAlerts').add({
        type: 'RESERVATION_CLEANUP_FAILED',
        collection: docRef.parent ? docRef.parent.id : 'unknown',
        docId: docRef.id,
        reservationId,
        error: String(err?.message || err),
        createdAt: FieldValue.serverTimestamp()
      });
    } catch (alertErr) {
      console.error('Failed to write systemAlerts record for RESERVATION_CLEANUP_FAILED:', alertErr);
    }
    return 'failed';
  }
}

export type AdminUserTestHooks = {
  afterAuthUpdate?: (context: {
    targetUid: string;
    operationId: string;
    operation: string;
  }) => Promise<void>;

  beforeFirestoreCommit?: (context: {
    targetUid: string;
    operationId: string;
    operation: string;
  }) => Promise<void>;

  beforeAuthCompensation?: (context: {
    targetUid: string;
    operationId: string;
    operation: string;
  }) => Promise<void>;
};

export function getUserMutationLockConfig(): { leaseMs: number; heartbeatIntervalMs: number } {
  const rawLease = process.env.USER_MUTATION_LOCK_LEASE_MS !== undefined ? Number(process.env.USER_MUTATION_LOCK_LEASE_MS) : NaN;
  const rawInterval = process.env.USER_MUTATION_HEARTBEAT_INTERVAL_MS !== undefined ? Number(process.env.USER_MUTATION_HEARTBEAT_INTERVAL_MS) : NaN;

  let leaseMs = 120000;
  let heartbeatIntervalMs = 30000;

  const validLease = Number.isFinite(rawLease) && rawLease > 0;
  const validInterval = Number.isFinite(rawInterval) && rawInterval > 0;

  if (validLease) {
    leaseMs = rawLease;
  }
  if (validInterval) {
    heartbeatIntervalMs = rawInterval;
  }

  if (heartbeatIntervalMs >= leaseMs / 3) {
    if (validLease && leaseMs > 0) {
      heartbeatIntervalMs = Math.max(1, Math.floor(leaseMs / 4));
    } else {
      leaseMs = 120000;
      heartbeatIntervalMs = 30000;
    }
  }

  return { leaseMs, heartbeatIntervalMs };
}

export async function acquireUserMutationLock(
  db: FirebaseFirestore.Firestore,
  targetUid: string,
  operation: 'update_user' | 'activate_user' | 'deactivate_user',
  performedByUid: string
): Promise<{ operationId: string; lockRef: FirebaseFirestore.DocumentReference }> {
  const operationId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const lockRef = db.collection('userMutationLocks').doc(targetUid);
  const { leaseMs } = getUserMutationLockConfig();

  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(lockRef);
    if (doc.exists && doc.data()?.status === 'active') {
      const err = new Error('USER_OPERATION_IN_PROGRESS');
      (err as any).code = 'USER_OPERATION_IN_PROGRESS';
      throw err;
    }

    const nowMs = Date.now();
    const leaseExpiresAt = Timestamp.fromMillis(nowMs + leaseMs);

    transaction.set(lockRef, {
      operationId,
      targetUid,
      operation,
      performedByUid,
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      heartbeatAt: FieldValue.serverTimestamp(),
      leaseExpiresAt
    });
  });

  return { operationId, lockRef };
}

export function startUserMutationLockHeartbeat(params: {
  db: FirebaseFirestore.Firestore;
  targetUid: string;
  operationId: string;
  intervalMs?: number;
}): {
  stop: () => Promise<void>;
  assertHealthy: () => void;
} {
  const { db, targetUid, operationId } = params;
  const { leaseMs, heartbeatIntervalMs } = getUserMutationLockConfig();

  let interval = params.intervalMs;
  if (interval === undefined || !Number.isFinite(interval) || interval <= 0) {
    interval = heartbeatIntervalMs;
  }

  let healthy = true;
  let lastError: any = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const timer = setInterval(() => {
    if (stopped || !healthy || inFlight) return;
    inFlight = renewUserMutationLock({ db, targetUid, operationId })
      .catch((err) => {
        healthy = false;
        lastError = err;
      })
      .finally(() => {
        inFlight = null;
      });
  }, interval);

  if (timer && typeof (timer as any).unref === 'function') {
    (timer as any).unref();
  }

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) {
        try {
          await inFlight;
        } catch (_) {}
      }
    },
    assertHealthy() {
      if (!healthy) {
        const err = new Error('USER_OPERATION_LOCK_LOST');
        (err as any).code = 'USER_OPERATION_LOCK_LOST';
        if (lastError) {
          (err as any).cause = lastError;
        }
        throw err;
      }
    }
  };
}

export async function renewUserMutationLock(params: {
  db: FirebaseFirestore.Firestore;
  targetUid: string;
  operationId: string;
}): Promise<void> {
  const { db, targetUid, operationId } = params;
  const lockRef = db.collection('userMutationLocks').doc(targetUid);
  const { leaseMs } = getUserMutationLockConfig();

  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(lockRef);
    if (!doc.exists) {
      const err = new Error('USER_OPERATION_LOCK_LOST');
      (err as any).code = 'USER_OPERATION_LOCK_LOST';
      throw err;
    }
    const data = doc.data()!;
    if (data.status !== 'active' || data.operationId !== operationId) {
      const err = new Error('USER_OPERATION_LOCK_LOST');
      (err as any).code = 'USER_OPERATION_LOCK_LOST';
      throw err;
    }

    const nowMs = Date.now();
    const leaseExpiresAt = Timestamp.fromMillis(nowMs + leaseMs);

    transaction.update(lockRef, {
      heartbeatAt: FieldValue.serverTimestamp(),
      leaseExpiresAt
    });
  });
}

export async function verifyAndRenewUserMutationLock(params: {
  db: FirebaseFirestore.Firestore;
  targetUid: string;
  operationId: string;
  operation: 'update_user' | 'activate_user' | 'deactivate_user';
}): Promise<void> {
  const { db, targetUid, operationId, operation } = params;
  const lockRef = db.collection('userMutationLocks').doc(targetUid);
  const { leaseMs } = getUserMutationLockConfig();

  await db.runTransaction(async (transaction) => {
    const lockDoc = await transaction.get(lockRef);
    if (!lockDoc.exists) {
      const err: any = new Error('USER_OPERATION_LOCK_LOST');
      err.code = 'USER_OPERATION_LOCK_LOST';
      throw err;
    }
    const data = lockDoc.data() || {};
    if (
      data.status !== 'active' ||
      data.operationId !== operationId ||
      data.operation !== operation
    ) {
      const err: any = new Error('USER_OPERATION_LOCK_LOST');
      err.code = 'USER_OPERATION_LOCK_LOST';
      throw err;
    }

    const nowMs = Date.now();
    const leaseExpiresAt = Timestamp.fromMillis(nowMs + leaseMs);

    transaction.update(lockRef, {
      heartbeatAt: FieldValue.serverTimestamp(),
      leaseExpiresAt
    });
  });
}

export type LockReleaseResult = 'released' | 'not_found' | 'not_owned' | 'failed';

export async function releaseUserMutationLockOrAlert(params: {
  db: FirebaseFirestore.Firestore;
  targetUid: string;
  operationId: string;
  operation: string;
  performedByUid: string;
}): Promise<LockReleaseResult> {
  const { db, targetUid, operationId, operation, performedByUid } = params;
  const lockRef = db.collection('userMutationLocks').doc(targetUid);
  let releaseResult: LockReleaseResult = 'failed';

  try {
    releaseResult = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(lockRef);
      if (!doc.exists) return 'not_found';
      const data = doc.data()!;
      if (data.operationId === operationId) {
        transaction.delete(lockRef);
        return 'released';
      }
      return 'not_owned';
    });
  } catch (err: any) {
    console.error('Failed to release user mutation lock:', targetUid, operationId, err);
    releaseResult = 'failed';
  }

  if (releaseResult === 'not_owned' || releaseResult === 'failed') {
    try {
      await db.collection('systemAlerts').add({
        type: 'USER_MUTATION_LOCK_RELEASE_FAILED',
        targetUid,
        operationId,
        operation,
        performedByUid,
        releaseResult,
        createdAt: FieldValue.serverTimestamp()
      });
    } catch (alertErr) {
      console.error('Failed to write systemAlerts record for USER_MUTATION_LOCK_RELEASE_FAILED:', alertErr);
    }
  }

  return releaseResult;
}

export async function releaseUserMutationLock(
  db: FirebaseFirestore.Firestore,
  targetUid: string,
  operationId: string,
  operation: string = 'unknown',
  performedByUid: string = 'system'
): Promise<boolean> {
  const res = await releaseUserMutationLockOrAlert({
    db,
    targetUid,
    operationId,
    operation,
    performedByUid
  });
  return res === 'released';
}

export async function releaseReservationsOrReport(
  db: FirebaseFirestore.Firestore,
  reservations: Array<{ docRef: FirebaseFirestore.DocumentReference | null; reservationId: string | null }>
): Promise<{ hasCleanupFailure: boolean; results: ReservationReleaseResult[] }> {
  let hasCleanupFailure = false;
  const results: ReservationReleaseResult[] = [];

  for (const resItem of reservations) {
    if (!resItem.docRef || !resItem.reservationId) continue;
    const res = await releaseCodeReservation(db, resItem.docRef, resItem.reservationId);
    results.push(res);
    if (res === 'failed') {
      hasCleanupFailure = true;
    }
  }

  return { hasCleanupFailure, results };
}

export function createAdminUserRouter(
  db: FirebaseFirestore.Firestore,
  adminAuth: ReturnType<typeof getAuth>,
  requireAuth: any,
  requireExactRole: any,
  testHooks?: AdminUserTestHooks
) {
  const router = Router();
  const superAdminOnly = [requireAuth, requireExactRole('super_admin')];

  // Helper: count active super admins
  async function countActiveSuperAdmins(): Promise<number> {
    const snap = await db.collection('profiles').where('role', '==', 'super_admin').get();
    return snap.docs.filter(d => d.data().active !== false).length;
  }

  // -------------------------------------------------------------------------
  // 1. CREATE USER ACCOUNT (POST /api/admin/users)
  // -------------------------------------------------------------------------
  router.post('/users', superAdminOnly, async (req: any, res: any) => {
    let empCodeRef: FirebaseFirestore.DocumentReference | null = null;
    let empReservationId: string | null = null;
    let riderCodeRef: FirebaseFirestore.DocumentReference | null = null;
    let riderReservationId: string | null = null;
    let normEmpCode = '';
    let normRiderCode = '';

    try {
      const {
        fullName,
        email,
        phone,
        employeeCode,
        role,
        active = true,
        riderCode,
        vehicleType,
        vehicleNumber,
        city,
        assignedZone,
        maximumDailyCapacity
      } = req.body;

      // Validation 1: Email format
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_EMAIL', message: 'A valid email address is required.' }
        });
      }

      // Check profile-email uniqueness in profiles collection
      const existingProfileSnap = await db.collection('profiles').where('email', '==', normalizedEmail).get();
      if (!existingProfileSnap.empty) {
        return res.status(400).json({
          success: false,
          error: { code: 'DUPLICATE_EMAIL', message: 'An account with this email address already exists in employee profiles.' }
        });
      }

      // Validation 2: Required string fields
      const cleanFullName = String(fullName || '').trim();
      const cleanPhone = String(phone || '').trim();
      const cleanEmployeeCode = String(employeeCode || '').trim();

      if (!cleanFullName || !cleanPhone || !cleanEmployeeCode) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_REQUIRED_FIELDS', message: 'Full name, phone, and employee code are required.' }
        });
      }

      // Validation 3: Role Allowlist
      if (!role || !VALID_ROLES.includes(role as UserRole)) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_ROLE', message: `Role must be one of: ${VALID_ROLES.join(', ')}` }
        });
      }

      // Validation 4: Rider specific fields
      let cleanRiderCode = '';
      let cleanVehicleType = '';
      let cleanVehicleNumber = '';
      let cleanCity = '';
      let cleanAssignedZone = '';
      let parsedCapacity = 0;

      if (role === 'rider') {
        cleanRiderCode = String(riderCode || '').trim();
        cleanVehicleType = String(vehicleType || '').trim();
        cleanVehicleNumber = String(vehicleNumber || '').trim();
        cleanCity = String(city || '').trim();
        cleanAssignedZone = String(assignedZone || '').trim();
        parsedCapacity = Number(maximumDailyCapacity);

        if (!cleanRiderCode || !cleanVehicleType || !cleanVehicleNumber || !cleanCity || !cleanAssignedZone) {
          return res.status(400).json({
            success: false,
            error: { code: 'MISSING_RIDER_FIELDS', message: 'Rider code, vehicle type, vehicle number, city, and assigned zone are required for riders.' }
          });
        }

        if (isNaN(parsedCapacity) || parsedCapacity <= 0 || !Number.isInteger(parsedCapacity)) {
          return res.status(400).json({
            success: false,
            error: { code: 'INVALID_CAPACITY', message: 'Maximum daily capacity must be a positive integer.' }
          });
        }
      }

      // Concurrency-safe Code Uniqueness Reservation
      try {
        const empRes = await reserveCode(db, 'uniqueEmployeeCodes', cleanEmployeeCode, null, req.auth.uid);
        empCodeRef = empRes.docRef;
        empReservationId = empRes.reservationId;
        normEmpCode = empRes.normalizedCode;

        if (role === 'rider') {
          const riderRes = await reserveCode(db, 'uniqueRiderCodes', cleanRiderCode, null, req.auth.uid);
          riderCodeRef = riderRes.docRef;
          riderReservationId = riderRes.reservationId;
          normRiderCode = riderRes.normalizedCode;
        }
      } catch (reserveErr: any) {
        if (reserveErr.code === 'DUPLICATE_EMPLOYEE_CODE') {
          return res.status(409).json({
            success: false,
            error: { code: 'DUPLICATE_EMPLOYEE_CODE', message: 'Employee code already exists.' }
          });
        }
        if (reserveErr.code === 'DUPLICATE_RIDER_CODE') {
          await releaseCodeReservation(db, empCodeRef, empReservationId);
          return res.status(409).json({
            success: false,
            error: { code: 'DUPLICATE_RIDER_CODE', message: 'Rider code already exists.' }
          });
        }
        throw reserveErr;
      }

      // Check Email uniqueness in Auth (DO NOT IGNORE UNEXPECTED ERRORS!)
      try {
        const existingAuth = await adminAuth.getUserByEmail(normalizedEmail);
        if (existingAuth) {
          await releaseCodeReservation(db, empCodeRef, empReservationId);
          await releaseCodeReservation(db, riderCodeRef, riderReservationId);
          return res.status(400).json({
            success: false,
            error: { code: 'DUPLICATE_EMAIL', message: 'Email already exists in Firebase Authentication.' }
          });
        }
      } catch (authLookupErr: any) {
        if (authLookupErr.code === 'auth/user-not-found') {
          // Expected - email is free
        } else {
          await releaseCodeReservation(db, empCodeRef, empReservationId);
          await releaseCodeReservation(db, riderCodeRef, riderReservationId);
          return res.status(503).json({
            success: false,
            error: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Firebase Authentication service is unavailable.' }
          });
        }
      }

      // Generate secure temporary password internally (never stored/returned)
      const tempPassword = crypto.randomBytes(16).toString('hex') + 'A1!';
      const activeStatus = Boolean(active);

      // Create Firebase Auth user
      let authUser;
      try {
        authUser = await adminAuth.createUser({
          email: normalizedEmail,
          password: tempPassword,
          displayName: cleanFullName,
          disabled: !activeStatus
        });
      } catch (authErr: any) {
        await releaseCodeReservation(db, empCodeRef, empReservationId);
        await releaseCodeReservation(db, riderCodeRef, riderReservationId);
        return res.status(400).json({
          success: false,
          error: { code: 'AUTH_CREATION_FAILED', message: authErr.message || 'Failed to create Firebase Auth user.' }
        });
      }

      const firebaseUid = authUser.uid;
      const profileRef = db.collection('profiles').doc(firebaseUid);
      let riderId: string | null = null;
      let riderRef: FirebaseFirestore.DocumentReference | null = null;

      if (role === 'rider') {
        riderRef = db.collection('riders').doc();
        riderId = riderRef.id;
      }

      const searchPrefixes = generateSearchPrefixes(cleanFullName, normalizedEmail, cleanEmployeeCode, cleanRiderCode);

      try {
        await db.runTransaction(async (transaction) => {
          // 1. Read employee-code lock doc & verify ownership
          const empLockDoc = await transaction.get(empCodeRef!);
          if (!empLockDoc.exists) throw new Error('CODE_RESERVATION_LOST');
          const empLockData = empLockDoc.data()!;
          if (
            empLockData.status !== 'reserved' ||
            empLockData.reservationId !== empReservationId ||
            empLockData.normalisedValue !== normEmpCode ||
            empLockData.reservedByUid !== req.auth.uid
          ) {
            throw new Error('CODE_RESERVATION_LOST');
          }

          // 2. Read rider-code lock doc & verify ownership if rider
          if (riderCodeRef) {
            const riderLockDoc = await transaction.get(riderCodeRef);
            if (!riderLockDoc.exists) throw new Error('CODE_RESERVATION_LOST');
            const riderLockData = riderLockDoc.data()!;
            if (
              riderLockData.status !== 'reserved' ||
              riderLockData.reservationId !== riderReservationId ||
              riderLockData.normalisedValue !== normRiderCode ||
              riderLockData.reservedByUid !== req.auth.uid
            ) {
              throw new Error('CODE_RESERVATION_LOST');
            }
          }

          // 3. Confirm profile doc does not already exist
          const existingProfileDoc = await transaction.get(profileRef);
          if (existingProfileDoc.exists) {
            throw new Error('PROFILE_EXISTS');
          }

          // 4. Create Rider record where applicable
          if (role === 'rider' && riderRef) {
            transaction.set(riderRef, {
              id: riderId,
              profileId: firebaseUid,
              fullName: cleanFullName,
              email: normalizedEmail,
              phone: cleanPhone,
              riderCode: cleanRiderCode,
              normalizedRiderCode: normRiderCode,
              vehicleType: cleanVehicleType,
              vehicleNumber: cleanVehicleNumber,
              city: cleanCity,
              assignedZone: cleanAssignedZone,
              maximumDailyCapacity: parsedCapacity,
              active: activeStatus,
              createdByUid: req.auth.uid,
              createdAt: FieldValue.serverTimestamp(),
              updatedByUid: req.auth.uid,
              updatedAt: FieldValue.serverTimestamp()
            });
          }

          // 5. Create Profile document
          transaction.set(profileRef, {
            id: firebaseUid,
            authUserId: firebaseUid,
            fullName: cleanFullName,
            email: normalizedEmail,
            phone: cleanPhone,
            employeeCode: cleanEmployeeCode,
            normalizedEmployeeCode: normEmpCode,
            role: role as UserRole,
            active: activeStatus,
            riderId: riderId,
            riderCode: role === 'rider' ? cleanRiderCode : null,
            version: 1,
            searchPrefixes,
            createdByUid: req.auth.uid,
            createdAt: FieldValue.serverTimestamp(),
            updatedByUid: req.auth.uid,
            updatedAt: FieldValue.serverTimestamp()
          });

          // 6. Create Audit Event
          const auditRef = db.collection('auditEvents').doc();
          transaction.set(auditRef, {
            eventType: 'user_created',
            targetUid: firebaseUid,
            targetProfileId: firebaseUid,
            targetRiderId: riderId,
            previousValues: null,
            newValues: {
              fullName: cleanFullName,
              email: normalizedEmail,
              phone: cleanPhone,
              employeeCode: cleanEmployeeCode,
              role,
              active: activeStatus,
              ...(role === 'rider' ? {
                riderCode: cleanRiderCode,
                vehicleType: cleanVehicleType,
                vehicleNumber: cleanVehicleNumber,
                city: cleanCity,
                assignedZone: cleanAssignedZone,
                maximumDailyCapacity: parsedCapacity
              } : {})
            },
            performedByUid: req.auth.uid,
            performedAt: FieldValue.serverTimestamp()
          });

          // 7. Mark lock documents committed: status: committed, targetUid: firebaseUid
          transaction.set(empCodeRef!, {
            normalisedValue: normEmpCode,
            rawCode: cleanEmployeeCode,
            targetUid: firebaseUid,
            status: 'committed',
            reservationId: empReservationId,
            reservedByUid: req.auth.uid,
            reservedAt: FieldValue.serverTimestamp()
          });

          if (riderCodeRef) {
            transaction.set(riderCodeRef, {
              normalisedValue: normRiderCode,
              rawCode: cleanRiderCode,
              targetUid: firebaseUid,
              status: 'committed',
              reservationId: riderReservationId,
              reservedByUid: req.auth.uid,
              reservedAt: FieldValue.serverTimestamp()
            });
          }
        });
      } catch (transErr: any) {
        let authDeleted = false;
        let deleteAuthErr: any = null;
        try {
          await adminAuth.deleteUser(firebaseUid);
          authDeleted = true;
        } catch (delAuthErr: any) {
          deleteAuthErr = delAuthErr;
          console.error('Failed to delete Auth user during creation rollback:', firebaseUid, delAuthErr);
        }

        if (!authDeleted) {
          try {
            await db.collection('systemAlerts').add({
              targetUid: firebaseUid,
              email: normalizedEmail,
              operation: 'CREATE_USER',
              failedStage: 'AUTH_USER_DELETE',
              originalError: String(transErr?.message || transErr),
              compensationError: String(deleteAuthErr?.message || deleteAuthErr),
              employeeCodeLockId: empCodeRef ? empCodeRef.id : null,
              riderCodeLockId: riderCodeRef ? riderCodeRef.id : null,
              createdAt: FieldValue.serverTimestamp()
            });
          } catch (alertErr) {
            console.error('CRITICAL: Failed to write systemAlerts document during account rollback failure:', {
              targetUid: firebaseUid,
              originalError: transErr,
              compensationError: deleteAuthErr,
              alertWriteError: alertErr
            });
          }

          await releaseCodeReservation(db, empCodeRef, empReservationId);
          await releaseCodeReservation(db, riderCodeRef, riderReservationId);

          return res.status(500).json({
            success: false,
            error: {
              code: 'ACCOUNT_ROLLBACK_FAILED',
              message: `Firestore transaction failed and Auth user deletion also failed for UID: ${firebaseUid}`
            }
          });
        }

        await releaseCodeReservation(db, empCodeRef, empReservationId);
        await releaseCodeReservation(db, riderCodeRef, riderReservationId);

        if (transErr.message === 'CODE_RESERVATION_LOST') {
          return res.status(409).json({
            success: false,
            error: { code: 'CODE_RESERVATION_LOST', message: 'Code reservation ownership verification failed.' }
          });
        }

        return res.status(500).json({
          success: false,
          error: { code: 'ACCOUNT_CREATION_ROLLED_BACK', message: 'Firestore transaction failed. Firebase Auth account was rolled back.' }
        });
      }

      // Generate Password Reset / Setup Link with Visible Failure Handling
      let passwordSetupLink: string | null = null;
      let setupLinkStatus: 'generated' | 'failed' = 'generated';
      let setupLinkWarning: { code: string; message: string } | null = null;

      try {
        passwordSetupLink = await adminAuth.generatePasswordResetLink(normalizedEmail);
      } catch (linkErr: any) {
        console.error('Password reset link generation error:', linkErr);
        setupLinkStatus = 'failed';
        setupLinkWarning = {
          code: 'SETUP_LINK_GENERATION_FAILED',
          message: 'The account was created, but the password setup link could not be generated. Use Retry Setup Link.'
        };
      }

      if (setupLinkStatus === 'failed') {
        return res.status(201).json({
          success: true,
          data: {
            uid: firebaseUid,
            profileId: firebaseUid,
            riderId: riderId,
            accountCreated: true,
            setupLinkStatus: 'failed',
            passwordSetupLink: null
          },
          warning: setupLinkWarning
        });
      }

      return res.status(201).json({
        success: true,
        data: {
          uid: firebaseUid,
          profileId: firebaseUid,
          riderId: riderId,
          accountCreated: true,
          setupLinkStatus: 'generated',
          passwordSetupLink: passwordSetupLink
        }
      });
    } catch (err: any) {
      await releaseCodeReservation(db, empCodeRef, empReservationId);
      await releaseCodeReservation(db, riderCodeRef, riderReservationId);
      console.error('Create user endpoint error:', err);
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: err.message || 'Internal server error.' }
      });
    }
  });

  // -------------------------------------------------------------------------
  // 2. GET PAGINATED / FILTERED USERS (GET /api/admin/users)
  // -------------------------------------------------------------------------
  router.get('/users', superAdminOnly, async (req: any, res: any) => {
    try {
      const search = normalizeSearchTerm(req.query.search);
      const roleFilter = String(req.query.role || '').trim();
      const activeFilter = req.query.active !== undefined ? String(req.query.active) : undefined;
      const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || '20'), 10) || 20, 1), 100);
      const cursor = req.query.cursor ? String(req.query.cursor) : null;

      let query: FirebaseFirestore.Query = db.collection('profiles');

      if (roleFilter && VALID_ROLES.includes(roleFilter as UserRole)) {
        query = query.where('role', '==', roleFilter);
      }
      if (activeFilter === 'true') {
        query = query.where('active', '==', true);
      } else if (activeFilter === 'false') {
        query = query.where('active', '==', false);
      }
      if (search) {
        query = query.where('searchPrefixes', 'array-contains', search);
      }

      query = query.orderBy('createdAt', 'desc');

      if (cursor) {
        const cursorDoc = await db.collection('profiles').doc(cursor).get();
        if (cursorDoc.exists) {
          query = query.startAfter(cursorDoc);
        }
      }

      query = query.limit(pageSize + 1);

      let snap: FirebaseFirestore.QuerySnapshot;
      try {
        snap = await query.get();
      } catch (queryErr: any) {
        const msg = String(queryErr?.message || queryErr);
        if (msg.toLowerCase().includes('index') || queryErr.code === 9) {
          console.error('Missing Firestore index for directory query:', msg);
          return res.status(503).json({
            success: false,
            error: {
              code: 'USER_DIRECTORY_INDEX_UNAVAILABLE',
              message: 'User directory index is currently building or unavailable.',
              details: msg
            }
          });
        }
        throw queryErr;
      }

      const docs = snap.docs;
      const hasMore = docs.length > pageSize;
      const pageDocs = hasMore ? docs.slice(0, pageSize) : docs;

      // Batch fetch rider info ONLY for rider accounts on the current page
      const riderIdsToFetch = pageDocs.map(d => d.data().riderId).filter(Boolean);
      const riderMap = new Map<string, any>();

      if (riderIdsToFetch.length > 0) {
        const riderRefs = riderIdsToFetch.map(id => db.collection('riders').doc(id));
        const riderSnaps = await db.getAll(...riderRefs);
        riderSnaps.forEach(rDoc => {
          if (rDoc.exists) {
            riderMap.set(rDoc.id, rDoc.data());
          }
        });
      }

      const items = pageDocs.map(doc => {
        const p = doc.data();
        const riderInfo = p.riderId ? riderMap.get(p.riderId) : null;
        return {
          uid: doc.id,
          fullName: p.fullName || '',
          email: p.email || '',
          phone: p.phone || '',
          employeeCode: p.employeeCode || '',
          role: p.role as UserRole,
          active: p.active !== false,
          riderId: p.riderId || null,
          riderCode: riderInfo?.riderCode || p.riderCode || null,
          vehicleType: riderInfo?.vehicleType || null,
          vehicleNumber: riderInfo?.vehicleNumber || null,
          city: riderInfo?.city || null,
          assignedZone: riderInfo?.assignedZone || null,
          maximumDailyCapacity: riderInfo?.maximumDailyCapacity || null,
          createdAt: toIsoString(p.createdAt),
          updatedAt: toIsoString(p.updatedAt)
        };
      });

      const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].uid : null;

      return res.json({
        success: true,
        items,
        nextCursor,
        hasMore
      });
    } catch (err: any) {
      console.error('List users error:', err);
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: err.message || 'Failed to fetch users list.' }
      });
    }
  });

  // -------------------------------------------------------------------------
  // 3. UPDATE USER DETAILS & ROLES (PATCH /api/admin/users/:uid)
  // -------------------------------------------------------------------------
  // NOTE: Account status ('active') CANNOT be changed via this generic patch endpoint!
  router.patch('/users/:uid', superAdminOnly, async (req: any, res: any) => {
    const targetUid = String(req.params.uid);

    let lockInfo: { operationId: string; lockRef: FirebaseFirestore.DocumentReference } | null = null;
    let heartbeat: ReturnType<typeof startUserMutationLockHeartbeat> | null = null;
    let heartbeatStopped = false;
    let mutationLockReleaseAttempted = false;

    try {
      lockInfo = await acquireUserMutationLock(db, targetUid, 'update_user', req.auth.uid);
      heartbeat = startUserMutationLockHeartbeat({
        db,
        targetUid,
        operationId: lockInfo.operationId
      });
    } catch (lockErr: any) {
      if (lockErr.code === 'USER_OPERATION_IN_PROGRESS' || lockErr.message === 'USER_OPERATION_IN_PROGRESS') {
        return res.status(409).json({
          success: false,
          error: { code: 'USER_OPERATION_IN_PROGRESS', message: 'Another account operation is currently in progress for this user.' }
        });
      }
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: lockErr.message || 'Failed to acquire user mutation lock.' }
      });
    }

    const { operationId } = lockInfo;
    let empCodeRef: FirebaseFirestore.DocumentReference | null = null;
    let empReservationId: string | null = null;
    let riderCodeRef: FirebaseFirestore.DocumentReference | null = null;
    let riderReservationId: string | null = null;
    let authUpdated = false;
    let previousAuthData: { email?: string; displayName?: string; disabled?: boolean } = {};

    try {
      const profileRef = db.collection('profiles').doc(targetUid);
      
      heartbeat?.assertHealthy();

      const profileSnap = await profileRef.get();

      if (!profileSnap.exists) {
        return res.status(404).json({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'Employee profile not found.' }
        });
      }

      const currentProfile = profileSnap.data()!;

      // Read full previous Auth state for truthful rollback compensation
      let previousAuthUser: any = null;
      try {
        heartbeat?.assertHealthy();
        await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'update_user' });
        previousAuthUser = await adminAuth.getUser(targetUid);
        previousAuthData = {
          email: previousAuthUser.email,
          displayName: previousAuthUser.displayName,
          disabled: previousAuthUser.disabled
        };
        heartbeat?.assertHealthy();
      } catch (authFetchErr: any) {
        if (authFetchErr.code === 'USER_OPERATION_LOCK_LOST' || authFetchErr.message === 'USER_OPERATION_LOCK_LOST') {
          throw authFetchErr;
        }
        await releaseCodeReservation(db, empCodeRef, empReservationId);
        await releaseCodeReservation(db, riderCodeRef, riderReservationId);
        return res.status(503).json({
          success: false,
          error: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Firebase Authentication service is unavailable.' }
        });
      }

      const {
        fullName,
        email,
        phone,
        employeeCode,
        role,
        riderCode,
        vehicleType,
        vehicleNumber,
        city,
        assignedZone,
        maximumDailyCapacity,
        version
      } = req.body;

      // 1. Employee code uniqueness check & reservation
      const currentNormalizedEmployeeCode = normalizeCode(currentProfile.employeeCode || '');
      const requestedRawEmployeeCode = employeeCode !== undefined ? String(employeeCode).trim() : String(currentProfile.employeeCode || '');
      const requestedNormalizedEmployeeCode = normalizeCode(requestedRawEmployeeCode);
      const normalizedEmployeeCodeChanged = requestedNormalizedEmployeeCode !== currentNormalizedEmployeeCode;

      let cleanEmpCode = currentProfile.employeeCode;
      let normEmpCode = currentNormalizedEmployeeCode;
      let prevEmpLockRef: FirebaseFirestore.DocumentReference | null = null;

      if (normalizedEmployeeCodeChanged) {
        cleanEmpCode = requestedRawEmployeeCode;
        try {
          const empRes = await reserveCode(db, 'uniqueEmployeeCodes', cleanEmpCode, targetUid, req.auth.uid);
          empCodeRef = empRes.docRef;
          empReservationId = empRes.reservationId;
          normEmpCode = empRes.normalizedCode;
          if (currentNormalizedEmployeeCode) {
            prevEmpLockRef = db.collection('uniqueEmployeeCodes').doc(getCodeLockDocId(currentNormalizedEmployeeCode));
          }
        } catch (reserveErr: any) {
          return res.status(409).json({
            success: false,
            error: { code: 'DUPLICATE_EMPLOYEE_CODE', message: 'Employee code already exists.' }
          });
        }
      } else {
        cleanEmpCode = requestedRawEmployeeCode;
        normEmpCode = currentNormalizedEmployeeCode;
      }

      // 2. Email update check
      let newNormalizedEmail = currentProfile.email;
      const emailChanged = email && String(email).trim().toLowerCase() !== currentProfile.email;
      if (emailChanged) {
        newNormalizedEmail = String(email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newNormalizedEmail)) {
          await releaseCodeReservation(db, empCodeRef, empReservationId);
          return res.status(400).json({
            success: false,
            error: { code: 'INVALID_EMAIL', message: 'Invalid email address provided.' }
          });
        }

        const existingProfileSnap = await db.collection('profiles').where('email', '==', newNormalizedEmail).get();
        if (!existingProfileSnap.empty && existingProfileSnap.docs.some(d => d.id !== targetUid)) {
          await releaseCodeReservation(db, empCodeRef, empReservationId);
          return res.status(400).json({
            success: false,
            error: { code: 'DUPLICATE_EMAIL', message: 'An account with this email address already exists in employee profiles.' }
          });
        }

        try {
          const existingAuth = await adminAuth.getUserByEmail(newNormalizedEmail);
          if (existingAuth && existingAuth.uid !== targetUid) {
            await releaseCodeReservation(db, empCodeRef, empReservationId);
            return res.status(400).json({
              success: false,
              error: { code: 'DUPLICATE_EMAIL', message: 'Email already exists in Firebase Authentication.' }
            });
          }
        } catch (authLookErr: any) {
          if (authLookErr.code !== 'auth/user-not-found') {
            await releaseCodeReservation(db, empCodeRef, empReservationId);
            return res.status(503).json({
              success: false,
              error: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Firebase Authentication service is unavailable.' }
            });
          }
        }
      }

      // 3. Role validation
      const newRole = (role ? String(role).trim() : currentProfile.role) as UserRole;
      if (!VALID_ROLES.includes(newRole)) {
        await releaseCodeReservation(db, empCodeRef, empReservationId);
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_ROLE', message: `Role must be one of: ${VALID_ROLES.join(', ')}` }
        });
      }

      // 4. Super Admin self role change protection
      if (targetUid === req.auth.uid && newRole !== 'super_admin') {
        await releaseCodeReservation(db, empCodeRef, empReservationId);
        return res.status(409).json({
          success: false,
          error: { code: 'SELF_ROLE_CHANGE_BLOCKED', message: 'Super Admin cannot remove their own super_admin role.' }
        });
      }

      // 5. Last Active Super Admin protection
      if (currentProfile.role === 'super_admin' && newRole !== 'super_admin') {
        const activeAdmins = await countActiveSuperAdmins();
        if (activeAdmins <= 1) {
          await releaseCodeReservation(db, empCodeRef, empReservationId);
          return res.status(409).json({
            success: false,
            error: { code: 'LAST_SUPER_ADMIN', message: 'Cannot remove super_admin role from the last active super_admin account.' }
          });
        }
      }

      let newRiderId = currentProfile.riderId || null;
      let cleanRiderCode = currentProfile.riderCode || '';
      let normRiderCode = normalizeCode(cleanRiderCode);
      let prevRiderLockRef: FirebaseFirestore.DocumentReference | null = null;
      let isNewRiderDoc = false;

      const currentNormalizedRiderCode = normalizeCode(currentProfile.riderCode || '');
      const requestedRawRiderCode = riderCode !== undefined ? String(riderCode).trim() : String(currentProfile.riderCode || '');
      const requestedNormalizedRiderCode = normalizeCode(requestedRawRiderCode);
      const normalizedRiderCodeChanged = requestedNormalizedRiderCode !== currentNormalizedRiderCode;

      // Role Transition: Non-Rider -> Rider
      if (currentProfile.role !== 'rider' && newRole === 'rider') {
        cleanRiderCode = String(riderCode || '').trim();
        const cleanVehicleType = String(vehicleType || '').trim();
        const cleanVehicleNumber = String(vehicleNumber || '').trim();
        const cleanCity = String(city || '').trim();
        const cleanAssignedZone = String(assignedZone || '').trim();
        const parsedCapacity = Number(maximumDailyCapacity);

        if (!cleanRiderCode || !cleanVehicleType || !cleanVehicleNumber || !cleanCity || !cleanAssignedZone) {
          await releaseCodeReservation(db, empCodeRef, empReservationId);
          return res.status(400).json({
            success: false,
            error: { code: 'MISSING_RIDER_FIELDS', message: 'Rider code, vehicle type, vehicle number, city, and assigned zone are required when changing role to rider.' }
          });
        }

        if (isNaN(parsedCapacity) || parsedCapacity <= 0 || !Number.isInteger(parsedCapacity)) {
          await releaseCodeReservation(db, empCodeRef, empReservationId);
          return res.status(400).json({
            success: false,
            error: { code: 'INVALID_CAPACITY', message: 'Maximum daily capacity must be a positive integer.' }
          });
        }

        try {
          const riderRes = await reserveCode(db, 'uniqueRiderCodes', cleanRiderCode, targetUid, req.auth.uid);
          riderCodeRef = riderRes.docRef;
          riderReservationId = riderRes.reservationId;
          normRiderCode = riderRes.normalizedCode;
        } catch (rErr: any) {
          await releaseCodeReservation(db, empCodeRef, empReservationId);
          return res.status(409).json({
            success: false,
            error: { code: 'DUPLICATE_RIDER_CODE', message: 'Rider code already exists.' }
          });
        }

        newRiderId = db.collection('riders').doc().id;
        isNewRiderDoc = true;
      }

      // Role Transition: Rider -> Non-Rider
      if (currentProfile.role === 'rider' && newRole !== 'rider') {
        if (currentProfile.riderId) {
          let openOps: RiderOpenOperationsResult;
          try {
            openOps = await getRiderOpenOperations(db, currentProfile.riderId);
          } catch (openOpsErr: any) {
            await releaseReservationsOrReport(db, [
              { docRef: empCodeRef, reservationId: empReservationId },
              { docRef: riderCodeRef, reservationId: riderReservationId }
            ]);
            return res.status(503).json({
              success: false,
              error: {
                code: 'OPEN_OPERATIONS_CHECK_FAILED',
                message: 'Failed to verify rider open operations due to database error.'
              }
            });
          }
          if (openOps.hasOpenOperations) {
            await releaseReservationsOrReport(db, [
              { docRef: empCodeRef, reservationId: empReservationId },
              { docRef: riderCodeRef, reservationId: riderReservationId }
            ]);
            return res.status(409).json({
              success: false,
              error: {
                code: 'RIDER_HAS_OPEN_OPERATIONS',
                message: 'Cannot change role: Rider has open assignments, dispatch runs, cash settlements, or unreturned packages.',
                details: openOps
              }
            });
          }
          newRiderId = null;
          cleanRiderCode = '';
          normRiderCode = '';
          if (currentNormalizedRiderCode) {
            prevRiderLockRef = db.collection('uniqueRiderCodes').doc(getCodeLockDocId(currentNormalizedRiderCode));
          }
        }
      }

      // Updating existing rider record if staying rider
      let riderUpdateFields: Record<string, any> | null = null;
      if (currentProfile.role === 'rider' && newRole === 'rider' && currentProfile.riderId) {
        riderUpdateFields = {
          updatedByUid: req.auth.uid,
          updatedAt: FieldValue.serverTimestamp()
        };

        if (fullName) riderUpdateFields.fullName = String(fullName).trim();
        if (email) riderUpdateFields.email = newNormalizedEmail;
        if (phone) riderUpdateFields.phone = String(phone).trim();
        if (normalizedRiderCodeChanged) {
          cleanRiderCode = requestedRawRiderCode;
          try {
            const riderRes = await reserveCode(db, 'uniqueRiderCodes', cleanRiderCode, targetUid, req.auth.uid);
            riderCodeRef = riderRes.docRef;
            riderReservationId = riderRes.reservationId;
            normRiderCode = riderRes.normalizedCode;
            if (currentNormalizedRiderCode) {
              prevRiderLockRef = db.collection('uniqueRiderCodes').doc(getCodeLockDocId(currentNormalizedRiderCode));
            }
          } catch (rErr: any) {
            await releaseCodeReservation(db, empCodeRef, empReservationId);
            return res.status(409).json({
              success: false,
              error: { code: 'DUPLICATE_RIDER_CODE', message: 'Rider code already exists.' }
            });
          }
          riderUpdateFields.riderCode = cleanRiderCode;
          riderUpdateFields.normalizedRiderCode = normRiderCode;
        } else {
          cleanRiderCode = requestedRawRiderCode;
          normRiderCode = currentNormalizedRiderCode;
          if (cleanRiderCode !== (currentProfile.riderCode || '')) {
            riderUpdateFields.riderCode = cleanRiderCode;
          }
        }
        if (vehicleType) riderUpdateFields.vehicleType = String(vehicleType).trim();
        if (vehicleNumber) riderUpdateFields.vehicleNumber = String(vehicleNumber).trim();
        if (city) riderUpdateFields.city = String(city).trim();
        if (assignedZone) riderUpdateFields.assignedZone = String(assignedZone).trim();
        if (maximumDailyCapacity !== undefined) {
          const cap = Number(maximumDailyCapacity);
          if (isNaN(cap) || cap <= 0 || !Number.isInteger(cap)) {
            await releaseCodeReservation(db, empCodeRef, empReservationId);
            await releaseCodeReservation(db, riderCodeRef, riderReservationId);
            return res.status(400).json({
              success: false,
              error: { code: 'INVALID_CAPACITY', message: 'Maximum daily capacity must be a positive integer.' }
            });
          }
          riderUpdateFields.maximumDailyCapacity = cap;
        }
      }

      const updatedFullName = fullName ? String(fullName).trim() : currentProfile.fullName;
      const fullNameChanged = fullName && updatedFullName !== currentProfile.fullName;

      // Update Auth user if email or fullName changed
      if (emailChanged || fullNameChanged) {
        try {
          heartbeat?.assertHealthy();
          await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'update_user' });
          await adminAuth.updateUser(targetUid, {
            ...(emailChanged ? { email: newNormalizedEmail } : {}),
            ...(fullNameChanged ? { displayName: updatedFullName } : {})
          });
          authUpdated = true;
          if (testHooks?.afterAuthUpdate) {
            await testHooks.afterAuthUpdate({ targetUid, operationId, operation: 'update_user' });
          }
          await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'update_user' });
          heartbeat?.assertHealthy();
        } catch (authErr: any) {
          if (authErr.code === 'USER_OPERATION_LOCK_LOST' || authErr.message === 'USER_OPERATION_LOCK_LOST') {
            throw authErr;
          }
          await releaseCodeReservation(db, empCodeRef, empReservationId);
          await releaseCodeReservation(db, riderCodeRef, riderReservationId);
          return res.status(400).json({
            success: false,
            error: { code: 'AUTH_UPDATE_FAILED', message: authErr.message || 'Failed to update Firebase Auth user.' }
          });
        }
      }

      if (testHooks?.beforeFirestoreCommit) {
        await testHooks.beforeFirestoreCommit({ targetUid, operationId, operation: 'update_user' });
      }

      await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'update_user' });
      heartbeat?.assertHealthy();

      const searchPrefixes = generateSearchPrefixes(updatedFullName, newNormalizedEmail, cleanEmpCode, cleanRiderCode);

      const expectedProfileVersion = version !== undefined && version !== null && !isNaN(Number(version)) ? Number(version) : Number(currentProfile.version || 1);

      const profileUpdates: Record<string, any> = {
        fullName: updatedFullName,
        email: newNormalizedEmail,
        phone: phone ? String(phone).trim() : currentProfile.phone,
        employeeCode: cleanEmpCode,
        normalizedEmployeeCode: normEmpCode,
        role: newRole,
        riderId: newRiderId,
        riderCode: cleanRiderCode || null,
        version: expectedProfileVersion + 1,
        searchPrefixes,
        updatedByUid: req.auth.uid,
        updatedAt: FieldValue.serverTimestamp()
      };

      // Execute Single Firestore Transaction for atomic code changes, lock creation/deletion, & profile/rider updates
      try {
        await db.runTransaction(async (transaction) => {
          heartbeat?.assertHealthy();
          // 1. Verify User Mutation Lock belongs to current operationId
          const userLockRef = db.collection('userMutationLocks').doc(targetUid);
          const userLockDoc = await transaction.get(userLockRef);
          if (
            !userLockDoc.exists ||
            userLockDoc.data()?.operationId !== operationId ||
            userLockDoc.data()?.status !== 'active' ||
            userLockDoc.data()?.operation !== 'update_user'
          ) {
            const err: any = new Error('USER_OPERATION_LOCK_LOST');
            err.code = 'USER_OPERATION_LOCK_LOST';
            throw err;
          }

          // 2. Re-read profile document to enforce optimistic concurrency control
          const txProfileSnap = await transaction.get(profileRef);
          if (!txProfileSnap.exists) {
            throw new Error('USER_NOT_FOUND');
          }
          const txProfile = txProfileSnap.data()!;
          const currentTxVersion = Number(txProfile.version || 1);
          if (currentTxVersion !== expectedProfileVersion) {
            throw new Error('USER_UPDATED_CONCURRENTLY');
          }
          if (
            txProfile.employeeCode !== currentProfile.employeeCode ||
            txProfile.riderId !== currentProfile.riderId ||
            txProfile.riderCode !== currentProfile.riderCode
          ) {
            throw new Error('USER_UPDATED_CONCURRENTLY');
          }

          // 3. Ownership checks on new reservations / display updates on existing locks
          if (empCodeRef) {
            const lockDoc = await transaction.get(empCodeRef);
            if (!lockDoc.exists) throw new Error('CODE_RESERVATION_LOST');
            const lockData = lockDoc.data()!;
            if (
              lockData.status !== 'reserved' ||
              lockData.reservationId !== empReservationId ||
              lockData.normalisedValue !== normEmpCode ||
              lockData.reservedByUid !== req.auth.uid ||
              lockData.targetUid !== targetUid
            ) {
              throw new Error('CODE_RESERVATION_LOST');
            }
          } else if (currentNormalizedEmployeeCode) {
            const existingEmpLockRef = db.collection('uniqueEmployeeCodes').doc(getCodeLockDocId(currentNormalizedEmployeeCode));
            const existingEmpLockDoc = await transaction.get(existingEmpLockRef);
            if (!existingEmpLockDoc.exists) {
              throw new Error('EXISTING_CODE_LOCK_INCONSISTENT');
            }
            const data = existingEmpLockDoc.data()!;
            if (data.status !== 'committed' || data.targetUid !== targetUid || data.normalisedValue !== currentNormalizedEmployeeCode) {
              throw new Error('EXISTING_CODE_LOCK_INCONSISTENT');
            }
            if (cleanEmpCode !== currentProfile.employeeCode) {
              transaction.update(existingEmpLockRef, { rawCode: cleanEmpCode });
            }
          }

          if (riderCodeRef) {
            const lockDoc = await transaction.get(riderCodeRef);
            if (!lockDoc.exists) throw new Error('CODE_RESERVATION_LOST');
            const lockData = lockDoc.data()!;
            if (
              lockData.status !== 'reserved' ||
              lockData.reservationId !== riderReservationId ||
              lockData.normalisedValue !== normRiderCode ||
              lockData.reservedByUid !== req.auth.uid ||
              (lockData.targetUid !== null && lockData.targetUid !== targetUid)
            ) {
              throw new Error('CODE_RESERVATION_LOST');
            }
          } else if (currentProfile.role === 'rider' && newRole === 'rider' && currentNormalizedRiderCode) {
            const existingRiderLockRef = db.collection('uniqueRiderCodes').doc(getCodeLockDocId(currentNormalizedRiderCode));
            const existingRiderLockDoc = await transaction.get(existingRiderLockRef);
            if (!existingRiderLockDoc.exists) {
              throw new Error('EXISTING_CODE_LOCK_INCONSISTENT');
            }
            const data = existingRiderLockDoc.data()!;
            if (data.status !== 'committed' || data.targetUid !== targetUid || data.normalisedValue !== currentNormalizedRiderCode) {
              throw new Error('EXISTING_CODE_LOCK_INCONSISTENT');
            }
            if (cleanRiderCode !== currentProfile.riderCode) {
              transaction.update(existingRiderLockRef, { rawCode: cleanRiderCode });
            }
          }

          // 4. Transactional deletion of old lock documents
          if (prevEmpLockRef) {
            const oldLock = await transaction.get(prevEmpLockRef);
            if (!oldLock.exists) {
              throw new Error('EXISTING_CODE_LOCK_INCONSISTENT');
            }
            const oldLockData = oldLock.data()!;
            const expectedNormOldEmp = currentNormalizedEmployeeCode;
            if (
              oldLockData.status !== 'committed' ||
              oldLockData.targetUid !== targetUid ||
              oldLockData.normalisedValue !== expectedNormOldEmp
            ) {
              throw new Error('EXISTING_CODE_LOCK_INCONSISTENT');
            }
            transaction.delete(prevEmpLockRef);
          }

          if (prevRiderLockRef) {
            const oldLock = await transaction.get(prevRiderLockRef);
            if (!oldLock.exists) {
              throw new Error('EXISTING_CODE_LOCK_INCONSISTENT');
            }
            const oldLockData = oldLock.data()!;
            const expectedNormOldRider = currentNormalizedRiderCode;
            if (
              oldLockData.status !== 'committed' ||
              oldLockData.targetUid !== targetUid ||
              oldLockData.normalisedValue !== expectedNormOldRider
            ) {
              throw new Error('EXISTING_CODE_LOCK_INCONSISTENT');
            }
            transaction.delete(prevRiderLockRef);
          }

          // 5. New Rider doc creation
          if (isNewRiderDoc && newRiderId) {
            const riderRef = db.collection('riders').doc(newRiderId);
            transaction.set(riderRef, {
              id: newRiderId,
              profileId: targetUid,
              fullName: updatedFullName,
              email: newNormalizedEmail,
              phone: phone ? String(phone).trim() : currentProfile.phone,
              riderCode: cleanRiderCode,
              normalizedRiderCode: normRiderCode,
              vehicleType: String(vehicleType || '').trim(),
              vehicleNumber: String(vehicleNumber || '').trim(),
              city: String(city || '').trim(),
              assignedZone: String(assignedZone || '').trim(),
              maximumDailyCapacity: Number(maximumDailyCapacity),
              active: currentProfile.active !== false,
              createdByUid: currentProfile.createdByUid || req.auth.uid,
              createdAt: FieldValue.serverTimestamp(),
              updatedByUid: req.auth.uid,
              updatedAt: FieldValue.serverTimestamp()
            });
          }

          // 6. Rider deactivation if role transitioned Rider -> Non-Rider
          if (currentProfile.role === 'rider' && newRole !== 'rider' && currentProfile.riderId) {
            const riderRef = db.collection('riders').doc(currentProfile.riderId);
            transaction.update(riderRef, {
              active: false,
              updatedByUid: req.auth.uid,
              updatedAt: FieldValue.serverTimestamp()
            });
          }

          // 7. Existing Rider doc update
          if (riderUpdateFields && currentProfile.riderId) {
            const riderRef = db.collection('riders').doc(currentProfile.riderId);
            transaction.update(riderRef, riderUpdateFields);
          }

          // 8. Profile doc update
          transaction.update(profileRef, profileUpdates);

          // 9. Commit new locks
          if (empCodeRef) {
            transaction.set(empCodeRef, {
              normalisedValue: normEmpCode,
              rawCode: cleanEmpCode,
              targetUid,
              status: 'committed',
              reservationId: empReservationId,
              reservedByUid: req.auth.uid,
              reservedAt: FieldValue.serverTimestamp()
            });
          }
          if (riderCodeRef) {
            transaction.set(riderCodeRef, {
              normalisedValue: normRiderCode,
              rawCode: cleanRiderCode,
              targetUid,
              status: 'committed',
              reservationId: riderReservationId,
              reservedByUid: req.auth.uid,
              reservedAt: FieldValue.serverTimestamp()
            });
          }

          // 10. Audit Event
          const auditRef = db.collection('auditEvents').doc();
          transaction.set(auditRef, {
            eventType: currentProfile.role !== newRole ? 'user_role_changed' : 'user_updated',
            targetUid,
            targetProfileId: targetUid,
            targetRiderId: newRiderId,
            previousValues: {
              fullName: currentProfile.fullName,
              email: currentProfile.email,
              phone: currentProfile.phone,
              employeeCode: currentProfile.employeeCode,
              role: currentProfile.role,
              riderId: currentProfile.riderId
            },
            newValues: profileUpdates,
            performedByUid: req.auth.uid,
            performedAt: FieldValue.serverTimestamp()
          });
        });
      } catch (transErr: any) {
        if (transErr.code === 'USER_OPERATION_LOCK_LOST' || transErr.message === 'USER_OPERATION_LOCK_LOST') {
          throw transErr;
        }

        if (authUpdated && previousAuthData.email) {
          try {
            await adminAuth.updateUser(targetUid, {
              email: previousAuthData.email,
              displayName: previousAuthData.displayName,
              disabled: previousAuthData.disabled
            });
          } catch (compErr: any) {
            await db.collection('systemAlerts').add({
              targetUid,
              operation: 'UPDATE_USER',
              failedStage: 'AUTH_ROLLBACK',
              originalError: String(transErr?.message || transErr),
              compensationError: String(compErr?.message || compErr),
              createdAt: FieldValue.serverTimestamp()
            }).catch((alertErr: any) => {
              console.error('Failed to log systemAlerts in UPDATE_USER:', {
                targetUid,
                originalError: transErr,
                compensationError: compErr,
                alertWriteError: alertErr
              });
            });

            const cleanupRes = await releaseReservationsOrReport(db, [
              { docRef: empCodeRef, reservationId: empReservationId },
              { docRef: riderCodeRef, reservationId: riderReservationId }
            ]);

            return res.status(500).json({
              success: false,
              error: {
                code: 'ACCOUNT_STATE_INCONSISTENT',
                message: 'Firestore update failed and Firebase Auth rollback failed.' + (cleanupRes.hasCleanupFailure ? ' RESERVATION_CLEANUP_FAILED' : '')
              }
            });
          }
        }

        const cleanupRes = await releaseReservationsOrReport(db, [
          { docRef: empCodeRef, reservationId: empReservationId },
          { docRef: riderCodeRef, reservationId: riderReservationId }
        ]);

        if (transErr.message === 'USER_OPERATION_IN_PROGRESS') {
          return res.status(409).json({
            success: false,
            error: { code: 'USER_OPERATION_IN_PROGRESS', message: 'Another account operation is currently in progress for this user.' }
          });
        }

        if (transErr.message === 'USER_UPDATED_CONCURRENTLY') {
          return res.status(409).json({
            success: false,
            error: { code: 'USER_UPDATED_CONCURRENTLY', message: 'User profile was updated by another request. Please refresh and try again.' }
          });
        }

        if (transErr.message === 'EXISTING_CODE_LOCK_INCONSISTENT') {
          return res.status(409).json({
            success: false,
            error: { code: 'EXISTING_CODE_LOCK_INCONSISTENT', message: 'Previous code lock document was missing or inconsistent.' }
          });
        }

        if (transErr.message === 'CODE_RESERVATION_LOST') {
          return res.status(409).json({
            success: false,
            error: { code: 'CODE_RESERVATION_LOST', message: 'Code reservation verification failed during user update.' }
          });
        }

        return res.status(500).json({
          success: false,
          error: {
            code: 'UPDATE_ROLLED_BACK',
            message: 'Firestore update failed. Firebase Auth changes were rolled back.' + (cleanupRes.hasCleanupFailure ? ' RESERVATION_CLEANUP_FAILED' : '')
          }
        });
      }

      if (heartbeat && !heartbeatStopped) {
        heartbeatStopped = true;
        await heartbeat.stop();
      }

      let releaseResult: LockReleaseResult = 'failed';
      if (!mutationLockReleaseAttempted) {
        mutationLockReleaseAttempted = true;
        releaseResult = await releaseUserMutationLockOrAlert({
          db,
          targetUid,
          operationId,
          operation: 'update_user',
          performedByUid: req.auth.uid
        });
      }

      const responseObj: any = {
        success: true,
        data: {
          uid: targetUid,
          profileId: targetUid,
          riderId: profileUpdates.riderId !== undefined ? profileUpdates.riderId : (currentProfile.riderId || null),
          fullName: updatedFullName,
          email: newNormalizedEmail,
          phone: phone ? String(phone).trim() : currentProfile.phone,
          employeeCode: cleanEmpCode,
          riderCode: newRole === 'rider' ? (cleanRiderCode || null) : null,
          role: newRole,
          active: currentProfile.active !== false,
          version: expectedProfileVersion + 1
        }
      };

      if (releaseResult === 'not_owned' || releaseResult === 'failed') {
        responseObj.warning = {
          code: 'MUTATION_LOCK_RELEASE_FAILED',
          message: 'The account change succeeded, but its operation lock could not be released. Review the system alert or use lock recovery.'
        };
      }

      return res.json(responseObj);
    } catch (err: any) {
      if (err.code === 'USER_OPERATION_LOCK_LOST' || err.message === 'USER_OPERATION_LOCK_LOST') {
        let authRestored = false;
        let compError: any = null;

        if (authUpdated && previousAuthData.email) {
          try {
            if (testHooks?.beforeAuthCompensation) {
              await testHooks.beforeAuthCompensation({ targetUid, operationId, operation: 'update_user' });
            }
            await adminAuth.updateUser(targetUid, {
              email: previousAuthData.email,
              displayName: previousAuthData.displayName,
              disabled: previousAuthData.disabled
            });
            authRestored = true;
          } catch (compErr: any) {
            compError = compErr;
            await db.collection('systemAlerts').add({
              targetUid,
              operation: 'UPDATE_USER',
              failedStage: 'AUTH_ROLLBACK',
              originalError: 'USER_OPERATION_LOCK_LOST',
              compensationError: String(compErr?.message || compErr),
              createdAt: FieldValue.serverTimestamp()
            }).catch(() => {});
          }
        }

        await releaseReservationsOrReport(db, [
          { docRef: empCodeRef, reservationId: empReservationId },
          { docRef: riderCodeRef, reservationId: riderReservationId }
        ]);

        if (heartbeat && !heartbeatStopped) {
          heartbeatStopped = true;
          await heartbeat.stop();
        }
        if (!mutationLockReleaseAttempted) {
          mutationLockReleaseAttempted = true;
          await releaseUserMutationLockOrAlert({ db, targetUid, operationId, operation: 'update_user', performedByUid: req.auth.uid });
        }

        if (authUpdated && !authRestored && compError) {
          return res.status(500).json({
            success: false,
            error: { code: 'ACCOUNT_STATE_INCONSISTENT', message: 'User operation lock lost and Auth restoration failed.' }
          });
        }

        return res.status(409).json({
          success: false,
          error: { code: 'USER_OPERATION_LOCK_LOST', message: 'User operation lock was lost or expired.' }
        });
      }

      await releaseReservationsOrReport(db, [
        { docRef: empCodeRef, reservationId: empReservationId },
        { docRef: riderCodeRef, reservationId: riderReservationId }
      ]);
      console.error('Update user error:', err);
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: err.message || 'Failed to update user.' }
      });
    } finally {
      if (heartbeat && !heartbeatStopped) {
        heartbeatStopped = true;
        await heartbeat.stop();
      }
      if (!mutationLockReleaseAttempted && lockInfo) {
        mutationLockReleaseAttempted = true;
        await releaseUserMutationLockOrAlert({
          db,
          targetUid,
          operationId: lockInfo.operationId,
          operation: 'update_user',
          performedByUid: req.auth.uid
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // 4. ACTIVATE USER (POST /api/admin/users/:uid/activate)
  // -------------------------------------------------------------------------
  router.post('/users/:uid/activate', superAdminOnly, async (req: any, res: any) => {
    const targetUid = String(req.params.uid);

    let lockInfo: { operationId: string; lockRef: FirebaseFirestore.DocumentReference } | null = null;
    let heartbeat: ReturnType<typeof startUserMutationLockHeartbeat> | null = null;
    let heartbeatStopped = false;
    let mutationLockReleaseAttempted = false;
    let authUpdated = false;
    let previousAuthUser: any = null;

    try {
      lockInfo = await acquireUserMutationLock(db, targetUid, 'activate_user', req.auth.uid);
      heartbeat = startUserMutationLockHeartbeat({
        db,
        targetUid,
        operationId: lockInfo.operationId
      });
    } catch (lockErr: any) {
      if (lockErr.code === 'USER_OPERATION_IN_PROGRESS' || lockErr.message === 'USER_OPERATION_IN_PROGRESS') {
        return res.status(409).json({
          success: false,
          error: { code: 'USER_OPERATION_IN_PROGRESS', message: 'Another account operation is currently in progress for this user.' }
        });
      }
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: lockErr.message || 'Failed to acquire user mutation lock.' }
      });
    }

    const { operationId } = lockInfo;

    try {
      const profileRef = db.collection('profiles').doc(targetUid);
      heartbeat?.assertHealthy();
      const profileSnap = await profileRef.get();

      if (!profileSnap.exists) {
        return res.status(404).json({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'Employee profile not found.' }
        });
      }

      const profile = profileSnap.data()!;

      // Capture previous Auth state for truthful compensation
      try {
        heartbeat?.assertHealthy();
        await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'activate_user' });
        previousAuthUser = await adminAuth.getUser(targetUid);
        heartbeat?.assertHealthy();
      } catch (authFetchErr: any) {
        if (authFetchErr.code === 'USER_OPERATION_LOCK_LOST' || authFetchErr.message === 'USER_OPERATION_LOCK_LOST') {
          throw authFetchErr;
        }
        return res.status(503).json({
          success: false,
          error: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Firebase Authentication service is unavailable.' }
        });
      }

      // Update Auth first
      try {
        heartbeat?.assertHealthy();
        await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'activate_user' });
        await adminAuth.updateUser(targetUid, { disabled: false });
        authUpdated = true;
        if (testHooks?.afterAuthUpdate) {
          await testHooks.afterAuthUpdate({ targetUid, operationId, operation: 'activate_user' });
        }
        await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'activate_user' });
        heartbeat?.assertHealthy();
      } catch (authErr: any) {
        if (authErr.code === 'USER_OPERATION_LOCK_LOST' || authErr.message === 'USER_OPERATION_LOCK_LOST') {
          throw authErr;
        }
        return res.status(500).json({
          success: false,
          error: { code: 'AUTH_UPDATE_FAILED', message: authErr.message || 'Failed to enable Firebase Auth user.' }
        });
      }

      if (testHooks?.beforeFirestoreCommit) {
        await testHooks.beforeFirestoreCommit({ targetUid, operationId, operation: 'activate_user' });
      }

      try {
        heartbeat?.assertHealthy();
        await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'activate_user' });
        await db.runTransaction(async (transaction) => {
          heartbeat?.assertHealthy();
          const userLockRef = db.collection('userMutationLocks').doc(targetUid);
          const userLockDoc = await transaction.get(userLockRef);
          if (
            !userLockDoc.exists ||
            userLockDoc.data()?.operationId !== operationId ||
            userLockDoc.data()?.status !== 'active' ||
            userLockDoc.data()?.operation !== 'activate_user'
          ) {
            const err: any = new Error('USER_OPERATION_LOCK_LOST');
            err.code = 'USER_OPERATION_LOCK_LOST';
            throw err;
          }

          const txProfileSnap = await transaction.get(profileRef);
          if (!txProfileSnap.exists) {
            throw new Error('USER_NOT_FOUND');
          }

          transaction.update(profileRef, {
            active: true,
            updatedByUid: req.auth.uid,
            updatedAt: FieldValue.serverTimestamp()
          });

          if (profile.riderId) {
            const riderRef = db.collection('riders').doc(profile.riderId);
            transaction.update(riderRef, {
              active: true,
              updatedByUid: req.auth.uid,
              updatedAt: FieldValue.serverTimestamp()
            });
          }

          const auditRef = db.collection('auditEvents').doc();
          transaction.set(auditRef, {
            eventType: 'user_activated',
            targetUid,
            targetProfileId: targetUid,
            targetRiderId: profile.riderId || null,
            previousValues: { active: profile.active },
            newValues: { active: true },
            performedByUid: req.auth.uid,
            performedAt: FieldValue.serverTimestamp()
          });
        });
      } catch (transErr: any) {
        if (transErr.code === 'USER_OPERATION_LOCK_LOST' || transErr.message === 'USER_OPERATION_LOCK_LOST') {
          throw transErr;
        }

        // Rollback: Restore full previous Auth state
        try {
          if (previousAuthUser) {
            await adminAuth.updateUser(targetUid, {
              email: previousAuthUser.email,
              displayName: previousAuthUser.displayName,
              disabled: previousAuthUser.disabled
            });
          } else {
            await adminAuth.updateUser(targetUid, { disabled: true });
          }
        } catch (compErr: any) {
          await db.collection('systemAlerts').add({
            targetUid,
            operation: 'ACTIVATE_USER',
            failedStage: 'AUTH_ROLLBACK',
            originalError: String(transErr?.message || transErr),
            compensationError: String(compErr?.message || compErr),
            createdAt: FieldValue.serverTimestamp()
          }).catch((alertErr: any) => {
            console.error('Failed to log systemAlerts in ACTIVATE_USER:', {
              targetUid,
              originalError: transErr,
              compensationError: compErr,
              alertWriteError: alertErr
            });
          });

          return res.status(500).json({
            success: false,
            error: { code: 'ACCOUNT_STATE_INCONSISTENT', message: 'Account state is inconsistent: Auth enabled but Firestore activation failed and restore failed.' }
          });
        }

        if (transErr.message === 'USER_OPERATION_IN_PROGRESS') {
          return res.status(409).json({
            success: false,
            error: { code: 'USER_OPERATION_IN_PROGRESS', message: 'Another account operation is currently in progress for this user.' }
          });
        }

        if (transErr.message === 'USER_NOT_FOUND') {
          return res.status(404).json({
            success: false,
            error: { code: 'USER_NOT_FOUND', message: 'Employee profile not found.' }
          });
        }

        return res.status(500).json({
          success: false,
          error: { code: 'ACTIVATION_ROLLED_BACK', message: 'Firestore activation transaction failed. Firebase Auth account status was restored.' }
        });
      }

      if (heartbeat && !heartbeatStopped) {
        heartbeatStopped = true;
        await heartbeat.stop();
      }

      let releaseResult: LockReleaseResult = 'failed';
      if (!mutationLockReleaseAttempted) {
        mutationLockReleaseAttempted = true;
        releaseResult = await releaseUserMutationLockOrAlert({
          db,
          targetUid,
          operationId,
          operation: 'activate_user',
          performedByUid: req.auth.uid
        });
      }

      const responseObj: any = {
        success: true,
        data: { uid: targetUid, profileId: targetUid, riderId: profile.riderId || null, active: true }
      };

      if (releaseResult === 'not_owned' || releaseResult === 'failed') {
        responseObj.warning = {
          code: 'MUTATION_LOCK_RELEASE_FAILED',
          message: 'The account change succeeded, but its operation lock could not be released. Review the system alert or use lock recovery.'
        };
      }

      return res.json(responseObj);
    } catch (err: any) {
      if (err.code === 'USER_OPERATION_LOCK_LOST' || err.message === 'USER_OPERATION_LOCK_LOST') {
        let authRestored = false;
        let compError: any = null;

        if (authUpdated && previousAuthUser) {
          try {
            await adminAuth.updateUser(targetUid, {
              email: previousAuthUser.email,
              displayName: previousAuthUser.displayName,
              disabled: previousAuthUser.disabled
            });
            authRestored = true;
          } catch (compErr: any) {
            compError = compErr;
            await db.collection('systemAlerts').add({
              targetUid,
              operation: 'ACTIVATE_USER',
              failedStage: 'AUTH_ROLLBACK',
              originalError: 'USER_OPERATION_LOCK_LOST',
              compensationError: String(compErr?.message || compErr),
              createdAt: FieldValue.serverTimestamp()
            }).catch(() => {});
          }
        }

        if (heartbeat && !heartbeatStopped) {
          heartbeatStopped = true;
          await heartbeat.stop();
        }
        if (!mutationLockReleaseAttempted) {
          mutationLockReleaseAttempted = true;
          await releaseUserMutationLockOrAlert({ db, targetUid, operationId, operation: 'activate_user', performedByUid: req.auth.uid });
        }

        if (authUpdated && !authRestored && compError) {
          return res.status(500).json({
            success: false,
            error: { code: 'ACCOUNT_STATE_INCONSISTENT', message: 'User operation lock lost and Auth restoration failed.' }
          });
        }

        return res.status(409).json({
          success: false,
          error: { code: 'USER_OPERATION_LOCK_LOST', message: 'User operation lock was lost or expired.' }
        });
      }

      console.error('Activate user error:', err);
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: err.message || 'Failed to activate user.' }
      });
    } finally {
      if (heartbeat && !heartbeatStopped) {
        heartbeatStopped = true;
        await heartbeat.stop();
      }
      if (!mutationLockReleaseAttempted && lockInfo) {
        mutationLockReleaseAttempted = true;
        await releaseUserMutationLockOrAlert({
          db,
          targetUid,
          operationId: lockInfo.operationId,
          operation: 'activate_user',
          performedByUid: req.auth.uid
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // 5. DEACTIVATE USER (POST /api/admin/users/:uid/deactivate)
  // -------------------------------------------------------------------------
  router.post('/users/:uid/deactivate', superAdminOnly, async (req: any, res: any) => {
    const targetUid = String(req.params.uid);

    let lockInfo: { operationId: string; lockRef: FirebaseFirestore.DocumentReference } | null = null;
    let heartbeat: ReturnType<typeof startUserMutationLockHeartbeat> | null = null;
    let heartbeatStopped = false;
    let mutationLockReleaseAttempted = false;
    let authUpdated = false;
    let previousAuthUser: any = null;

    try {
      lockInfo = await acquireUserMutationLock(db, targetUid, 'deactivate_user', req.auth.uid);
      heartbeat = startUserMutationLockHeartbeat({
        db,
        targetUid,
        operationId: lockInfo.operationId
      });
    } catch (lockErr: any) {
      if (lockErr.code === 'USER_OPERATION_IN_PROGRESS' || lockErr.message === 'USER_OPERATION_IN_PROGRESS') {
        return res.status(409).json({
          success: false,
          error: { code: 'USER_OPERATION_IN_PROGRESS', message: 'Another account operation is currently in progress for this user.' }
        });
      }
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: lockErr.message || 'Failed to acquire user mutation lock.' }
      });
    }

    const { operationId } = lockInfo;

    try {
      if (targetUid === req.auth.uid) {
        return res.status(409).json({
          success: false,
          error: { code: 'SELF_DEACTIVATION_BLOCKED', message: 'Super Admin cannot deactivate their own account.' }
        });
      }

      const profileRef = db.collection('profiles').doc(targetUid);
      heartbeat?.assertHealthy();
      const profileSnap = await profileRef.get();

      if (!profileSnap.exists) {
        return res.status(404).json({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'Employee profile not found.' }
        });
      }

      const profile = profileSnap.data()!;

      // Super Admin protection
      if (profile.role === 'super_admin' && profile.active !== false) {
        const activeAdmins = await countActiveSuperAdmins();
        if (activeAdmins <= 1) {
          return res.status(409).json({
            success: false,
            error: { code: 'LAST_SUPER_ADMIN', message: 'Cannot deactivate the last active super_admin account.' }
          });
        }
      }

      // Rider check for open operations
      if (profile.riderId) {
        let openOps: RiderOpenOperationsResult;
        try {
          openOps = await getRiderOpenOperations(db, profile.riderId);
        } catch (openOpsErr: any) {
          return res.status(503).json({
            success: false,
            error: { code: 'OPEN_OPERATIONS_CHECK_FAILED', message: 'Failed to verify rider open operations status.' }
          });
        }
        if (openOps.hasOpenOperations) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'RIDER_HAS_OPEN_OPERATIONS',
              message: 'Cannot deactivate account: Rider has open assignments, dispatch runs, cash settlements, or unreturned packages.',
              details: openOps
            }
          });
        }
      }

      // Capture previous Auth state for truthful compensation
      try {
        heartbeat?.assertHealthy();
        await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'deactivate_user' });
        previousAuthUser = await adminAuth.getUser(targetUid);
        heartbeat?.assertHealthy();
      } catch (authFetchErr: any) {
        if (authFetchErr.code === 'USER_OPERATION_LOCK_LOST' || authFetchErr.message === 'USER_OPERATION_LOCK_LOST') {
          throw authFetchErr;
        }
        return res.status(503).json({
          success: false,
          error: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Firebase Authentication service is unavailable.' }
        });
      }

      // Update Auth
      try {
        heartbeat?.assertHealthy();
        await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'deactivate_user' });
        await adminAuth.updateUser(targetUid, { disabled: true });
        authUpdated = true;
        if (testHooks?.afterAuthUpdate) {
          await testHooks.afterAuthUpdate({ targetUid, operationId, operation: 'deactivate_user' });
        }
        await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'deactivate_user' });
        heartbeat?.assertHealthy();
      } catch (authErr: any) {
        if (authErr.code === 'USER_OPERATION_LOCK_LOST' || authErr.message === 'USER_OPERATION_LOCK_LOST') {
          throw authErr;
        }
        return res.status(500).json({
          success: false,
          error: { code: 'AUTH_UPDATE_FAILED', message: authErr.message || 'Failed to disable Firebase Auth user.' }
        });
      }

      if (testHooks?.beforeFirestoreCommit) {
        await testHooks.beforeFirestoreCommit({ targetUid, operationId, operation: 'deactivate_user' });
      }

      try {
        heartbeat?.assertHealthy();
        await verifyAndRenewUserMutationLock({ db, targetUid, operationId, operation: 'deactivate_user' });
        await db.runTransaction(async (transaction) => {
          heartbeat?.assertHealthy();
          const userLockRef = db.collection('userMutationLocks').doc(targetUid);
          const userLockDoc = await transaction.get(userLockRef);
          if (
            !userLockDoc.exists ||
            userLockDoc.data()?.operationId !== operationId ||
            userLockDoc.data()?.status !== 'active' ||
            userLockDoc.data()?.operation !== 'deactivate_user'
          ) {
            const err: any = new Error('USER_OPERATION_LOCK_LOST');
            err.code = 'USER_OPERATION_LOCK_LOST';
            throw err;
          }

          const txProfileSnap = await transaction.get(profileRef);
          if (!txProfileSnap.exists) {
            throw new Error('USER_NOT_FOUND');
          }

          transaction.update(profileRef, {
            active: false,
            updatedByUid: req.auth.uid,
            updatedAt: FieldValue.serverTimestamp()
          });

          if (profile.riderId) {
            const riderRef = db.collection('riders').doc(profile.riderId);
            transaction.update(riderRef, {
              active: false,
              updatedByUid: req.auth.uid,
              updatedAt: FieldValue.serverTimestamp()
            });
          }

          const auditRef = db.collection('auditEvents').doc();
          transaction.set(auditRef, {
            eventType: 'user_deactivated',
            targetUid,
            targetProfileId: targetUid,
            targetRiderId: profile.riderId || null,
            previousValues: { active: profile.active },
            newValues: { active: false },
            performedByUid: req.auth.uid,
            performedAt: FieldValue.serverTimestamp()
          });
        });
      } catch (transErr: any) {
        if (transErr.code === 'USER_OPERATION_LOCK_LOST' || transErr.message === 'USER_OPERATION_LOCK_LOST') {
          throw transErr;
        }

        // Rollback Auth user disabled status by restoring previous state
        try {
          if (previousAuthUser) {
            await adminAuth.updateUser(targetUid, {
              email: previousAuthUser.email,
              displayName: previousAuthUser.displayName,
              disabled: previousAuthUser.disabled
            });
          } else {
            await adminAuth.updateUser(targetUid, { disabled: false });
          }
        } catch (compErr: any) {
          await db.collection('systemAlerts').add({
            targetUid,
            operation: 'DEACTIVATE_USER',
            failedStage: 'AUTH_ROLLBACK',
            originalError: String(transErr?.message || transErr),
            compensationError: String(compErr?.message || compErr),
            createdAt: FieldValue.serverTimestamp()
          }).catch((alertErr: any) => {
            console.error('Failed to log systemAlerts in DEACTIVATE_USER:', {
              targetUid,
              originalError: transErr,
              compensationError: compErr,
              alertWriteError: alertErr
            });
          });

          return res.status(500).json({
            success: false,
            error: { code: 'ACCOUNT_STATE_INCONSISTENT', message: 'Account state is inconsistent: Auth disabled but Firestore deactivation failed and re-enable failed.' }
          });
        }

        if (transErr.message === 'USER_OPERATION_IN_PROGRESS') {
          return res.status(409).json({
            success: false,
            error: { code: 'USER_OPERATION_IN_PROGRESS', message: 'Another account operation is currently in progress for this user.' }
          });
        }

        if (transErr.message === 'USER_NOT_FOUND') {
          return res.status(404).json({
            success: false,
            error: { code: 'USER_NOT_FOUND', message: 'Employee profile not found.' }
          });
        }

        return res.status(500).json({
          success: false,
          error: { code: 'DEACTIVATION_ROLLED_BACK', message: 'Firestore deactivation failed. Auth user disabled status was rolled back.' }
        });
      }

      if (heartbeat && !heartbeatStopped) {
        heartbeatStopped = true;
        await heartbeat.stop();
      }

      let releaseResult: LockReleaseResult = 'failed';
      if (!mutationLockReleaseAttempted) {
        mutationLockReleaseAttempted = true;
        releaseResult = await releaseUserMutationLockOrAlert({
          db,
          targetUid,
          operationId,
          operation: 'deactivate_user',
          performedByUid: req.auth.uid
        });
      }

      const responseObj: any = {
        success: true,
        data: { uid: targetUid, profileId: targetUid, riderId: profile.riderId || null, active: false }
      };

      if (releaseResult === 'not_owned' || releaseResult === 'failed') {
        responseObj.warning = {
          code: 'MUTATION_LOCK_RELEASE_FAILED',
          message: 'The account change succeeded, but its operation lock could not be released. Review the system alert or use lock recovery.'
        };
      }

      return res.json(responseObj);
    } catch (err: any) {
      if (err.code === 'USER_OPERATION_LOCK_LOST' || err.message === 'USER_OPERATION_LOCK_LOST') {
        let authRestored = false;
        let compError: any = null;

        if (authUpdated && previousAuthUser) {
          try {
            await adminAuth.updateUser(targetUid, {
              email: previousAuthUser.email,
              displayName: previousAuthUser.displayName,
              disabled: previousAuthUser.disabled
            });
            authRestored = true;
          } catch (compErr: any) {
            compError = compErr;
            await db.collection('systemAlerts').add({
              targetUid,
              operation: 'DEACTIVATE_USER',
              failedStage: 'AUTH_ROLLBACK',
              originalError: 'USER_OPERATION_LOCK_LOST',
              compensationError: String(compErr?.message || compErr),
              createdAt: FieldValue.serverTimestamp()
            }).catch(() => {});
          }
        }

        if (heartbeat && !heartbeatStopped) {
          heartbeatStopped = true;
          await heartbeat.stop();
        }
        if (!mutationLockReleaseAttempted) {
          mutationLockReleaseAttempted = true;
          await releaseUserMutationLockOrAlert({ db, targetUid, operationId, operation: 'deactivate_user', performedByUid: req.auth.uid });
        }

        if (authUpdated && !authRestored && compError) {
          return res.status(500).json({
            success: false,
            error: { code: 'ACCOUNT_STATE_INCONSISTENT', message: 'User operation lock lost and Auth restoration failed.' }
          });
        }

        return res.status(409).json({
          success: false,
          error: { code: 'USER_OPERATION_LOCK_LOST', message: 'User operation lock was lost or expired.' }
        });
      }

      console.error('Deactivate user error:', err);
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: err.message || 'Failed to deactivate user.' }
      });
    } finally {
      if (heartbeat && !heartbeatStopped) {
        heartbeatStopped = true;
        await heartbeat.stop();
      }
      if (!mutationLockReleaseAttempted && lockInfo) {
        mutationLockReleaseAttempted = true;
        await releaseUserMutationLockOrAlert({
          db,
          targetUid,
          operationId: lockInfo.operationId,
          operation: 'deactivate_user',
          performedByUid: req.auth.uid
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // 5B. RECOVER MUTATION LOCK (POST /api/admin/users/:uid/recover-mutation-lock)
  // -------------------------------------------------------------------------
  router.post('/users/:uid/recover-mutation-lock', superAdminOnly, async (req: any, res: any) => {
    const targetUid = String(req.params.uid);
    const reason = req.body?.reason || req.body?.recoveryReason;

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'RECOVERY_REASON_REQUIRED', message: 'A mandatory recovery reason must be provided.' }
      });
    }

    const safeThresholdMs = process.env.MUTATION_LOCK_STALE_THRESHOLD_MS !== undefined
      ? Number(process.env.MUTATION_LOCK_STALE_THRESHOLD_MS)
      : 60000;

    const lockRef = db.collection('userMutationLocks').doc(targetUid);

    try {
      const recoveredData = await db.runTransaction(async (transaction) => {
        const lockDoc = await transaction.get(lockRef);
        if (!lockDoc.exists) {
          throw new Error('LOCK_NOT_FOUND');
        }

        const data = lockDoc.data()!;
        if (data.status !== 'active') {
          throw new Error('LOCK_NOT_ACTIVE');
        }

        if (data.heartbeatAt === undefined || data.leaseExpiresAt === undefined || data.heartbeatAt === null || data.leaseExpiresAt === null) {
          throw new Error('LEGACY_LOCK_REQUIRES_MANUAL_REVIEW');
        }

        const leaseExpiresAt = data.leaseExpiresAt?.toDate ? data.leaseExpiresAt.toDate() : new Date(data.leaseExpiresAt);
        const heartbeatAt = data.heartbeatAt?.toDate ? data.heartbeatAt.toDate() : new Date(data.heartbeatAt);
        const now = Date.now();

        const leaseValid = leaseExpiresAt && leaseExpiresAt.getTime() > now;
        const heartbeatFresh = heartbeatAt && (now - heartbeatAt.getTime() < safeThresholdMs);

        if (leaseValid || heartbeatFresh) {
          throw new Error('LOCK_NOT_STALE');
        }

        transaction.delete(lockRef);

        const auditRef = db.collection('auditEvents').doc();
        transaction.set(auditRef, {
          eventType: 'user_mutation_lock_recovered',
          targetUid,
          targetProfileId: targetUid,
          recoveredOperationId: data.operationId,
          recoveredOperation: data.operation,
          heartbeatAt: data.heartbeatAt,
          leaseExpiresAt: data.leaseExpiresAt,
          reason: String(reason).trim(),
          performedByUid: req.auth.uid,
          performedAt: FieldValue.serverTimestamp()
        });

        return {
          recoveredOperationId: data.operationId,
          recoveredOperation: data.operation
        };
      });

      return res.json({
        success: true,
        data: {
          uid: targetUid,
          ...recoveredData
        }
      });
    } catch (err: any) {
      if (err.message === 'LEGACY_LOCK_REQUIRES_MANUAL_REVIEW') {
        return res.status(409).json({
          success: false,
          error: { code: 'LEGACY_LOCK_REQUIRES_MANUAL_REVIEW', message: 'Legacy mutation lock missing lease fields requires manual review.' }
        });
      }
      if (err.message === 'LOCK_NOT_FOUND') {
        return res.status(404).json({
          success: false,
          error: { code: 'LOCK_NOT_FOUND', message: 'No mutation lock found for this user.' }
        });
      }
      if (err.message === 'LOCK_NOT_ACTIVE') {
        return res.status(400).json({
          success: false,
          error: { code: 'LOCK_NOT_ACTIVE', message: 'Mutation lock is not active.' }
        });
      }
      if (err.message === 'LOCK_NOT_STALE') {
        return res.status(409).json({
          success: false,
          error: { code: 'LOCK_NOT_STALE', message: 'Mutation lock is still active and within safe threshold.' }
        });
      }
      console.error('Recover mutation lock error:', err);
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: err.message || 'Failed to recover mutation lock.' }
      });
    }
  });

  // -------------------------------------------------------------------------
  // 6. GENERATE PASSWORD RESET / SETUP LINK (POST /api/admin/users/:uid/password-setup-link)
  // -------------------------------------------------------------------------
  router.post('/users/:uid/password-setup-link', superAdminOnly, async (req: any, res: any) => {
    try {
      const targetUid = String(req.params.uid);
      const profileSnap = await db.collection('profiles').doc(targetUid).get();

      if (!profileSnap.exists) {
        return res.status(404).json({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'Employee profile not found.' }
        });
      }

      const profile = profileSnap.data()!;
      let passwordSetupLink: string | null = null;
      try {
        passwordSetupLink = await adminAuth.generatePasswordResetLink(profile.email);
      } catch (linkErr: any) {
        console.error('Password reset link error:', linkErr);
        return res.status(500).json({
          success: false,
          error: { code: 'SETUP_LINK_GENERATION_FAILED', message: 'Failed to generate password setup link.' }
        });
      }

      await db.collection('auditEvents').add({
        eventType: 'password_setup_link_generated',
        targetUid,
        targetProfileId: targetUid,
        targetRiderId: profile.riderId || null,
        previousValues: null,
        newValues: null,
        performedByUid: req.auth.uid,
        performedAt: FieldValue.serverTimestamp()
      });

      return res.json({
        success: true,
        data: {
          uid: targetUid,
          email: profile.email,
          passwordSetupLink,
          setupLinkStatus: 'generated'
        }
      });
    } catch (err: any) {
      console.error('Generate password setup link error:', err);
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: err.message || 'Failed to generate password setup link.' }
      });
    }
  });

  // -------------------------------------------------------------------------
  // 7. GET AUDIT HISTORY FOR A USER (GET /api/admin/users/:uid/audit)
  // -------------------------------------------------------------------------
  router.get('/users/:uid/audit', superAdminOnly, async (req: any, res: any) => {
    try {
      const targetUid = String(req.params.uid);
      const snap = await db.collection('auditEvents').where('targetUid', '==', targetUid).get();

      const items = snap.docs.map(doc => {
        const d = doc.data();
        return {
          id: doc.id,
          ...d,
          performedAt: toIsoString(d.performedAt)
        };
      });

      items.sort((a: any, b: any) => {
        const tA = a.performedAt ? new Date(a.performedAt).getTime() : 0;
        const tB = b.performedAt ? new Date(b.performedAt).getTime() : 0;
        return tB - tA;
      });

      return res.json({
        success: true,
        items
      });
    } catch (err: any) {
      console.error('Fetch audit events error:', err);
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: err.message || 'Failed to fetch audit events.' }
      });
    }
  });

  return router;
}
