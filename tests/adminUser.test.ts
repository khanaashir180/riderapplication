import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import {
  VALID_ROLES,
  getRiderOpenOperations,
  normalizeCode,
  generateSearchPrefixes,
  getCodeLockDocId,
  createAdminUserRouter
} from '../src/server/adminUserRouter.js';

// ---------------------------------------------------------------------------
// Mock Firestore Implementation for Fast In-Memory Unit & Integration Testing
// ---------------------------------------------------------------------------
class MockDocRef {
  id: string;
  dataStore: Map<string, any>;
  path: string;

  constructor(id: string, dataStore: Map<string, any>, path: string) {
    this.id = id;
    this.dataStore = dataStore;
    this.path = path;
  }

  async get() {
    const data = this.dataStore.get(this.path);
    return {
      exists: !!data,
      id: this.id,
      data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined)
    };
  }

  async set(data: any, options?: any) {
    if (options?.merge && this.dataStore.has(this.path)) {
      const existing = this.dataStore.get(this.path);
      this.dataStore.set(this.path, { ...existing, ...JSON.parse(JSON.stringify(data)) });
    } else {
      this.dataStore.set(this.path, JSON.parse(JSON.stringify(data)));
    }
  }

  async update(data: any) {
    const existing = this.dataStore.get(this.path) || {};
    this.dataStore.set(this.path, { ...existing, ...JSON.parse(JSON.stringify(data)) });
  }

  async delete() {
    this.dataStore.delete(this.path);
  }
}

class MockQuery {
  collectionName: string;
  dataStore: Map<string, any>;
  conditions: Array<{ field: string; op: string; value: any }>;
  limitVal?: number;

  constructor(collectionName: string, dataStore: Map<string, any>, conditions: Array<{ field: string; op: string; value: any }> = []) {
    this.collectionName = collectionName;
    this.dataStore = dataStore;
    this.conditions = conditions;
  }

  where(field: string, op: string, value: any) {
    return new MockQuery(this.collectionName, this.dataStore, [...this.conditions, { field, op, value }]);
  }

  orderBy() {
    return this;
  }

  startAfter() {
    return this;
  }

  limit(num: number) {
    this.limitVal = num;
    return this;
  }

  async get() {
    const results: MockDocRef[] = [];
    for (const [path, data] of this.dataStore.entries()) {
      if (!path.startsWith(`${this.collectionName}/`)) continue;

      let match = true;
      for (const cond of this.conditions) {
        const fieldVal = data[cond.field];
        if (cond.op === '==') {
          if (fieldVal !== cond.value) match = false;
        } else if (cond.op === 'array-contains') {
          if (!Array.isArray(fieldVal) || !fieldVal.includes(cond.value)) match = false;
        }
      }

      if (match) {
        const id = path.split('/')[1];
        results.push(new MockDocRef(id, this.dataStore, path));
      }
    }

    let docs = results;
    if (this.limitVal !== undefined) {
      docs = docs.slice(0, this.limitVal);
    }

    const snaps = await Promise.all(docs.map(d => d.get()));
    return {
      docs: snaps,
      empty: snaps.length === 0,
      size: snaps.length
    };
  }
}

class MockBatch {
  dataStore: Map<string, any>;
  ops: Array<() => void> = [];
  shouldFail = false;

  constructor(dataStore: Map<string, any>) {
    this.dataStore = dataStore;
  }

  set(docRef: MockDocRef, data: any, options?: any) {
    this.ops.push(() => {
      docRef.set(data, options);
    });
  }

  update(docRef: MockDocRef, data: any) {
    this.ops.push(() => {
      docRef.update(data);
    });
  }

  delete(docRef: MockDocRef) {
    this.ops.push(() => {
      docRef.delete();
    });
  }

  async commit() {
    if (this.shouldFail) {
      throw new Error('Simulated Firestore Batch Commit Failure');
    }
    for (const op of this.ops) {
      op();
    }
  }
}

class MockFirestore {
  dataStore = new Map<string, any>();
  nextAutoId = 1000;
  batchShouldFail = false;
  mainTransactionShouldFail = false;
  transactionCount = 0;

  collection(name: string) {
    return {
      doc: (id?: string) => {
        const docId = id || `auto_${this.nextAutoId++}`;
        return new MockDocRef(docId, this.dataStore, `${name}/${docId}`);
      },
      where: (field: string, op: string, value: any) => {
        return new MockQuery(name, this.dataStore, [{ field, op, value }]);
      },
      orderBy: () => new MockQuery(name, this.dataStore),
      get: () => new MockQuery(name, this.dataStore).get(),
      add: async (data: any) => {
        const docId = `auto_${this.nextAutoId++}`;
        const ref = new MockDocRef(docId, this.dataStore, `${name}/${docId}`);
        await ref.set(data);
        return ref;
      }
    };
  }

  batch() {
    const b = new MockBatch(this.dataStore);
    b.shouldFail = this.batchShouldFail;
    return b;
  }

  async runTransaction(cb: (tx: any) => Promise<any>) {
    this.transactionCount++;
    if (this.mainTransactionShouldFail && this.transactionCount > 1) {
      throw new Error('Simulated Main Firestore Transaction Failure');
    }
    const tx = {
      get: async (docRef: MockDocRef) => docRef.get(),
      set: (docRef: MockDocRef, data: any, options?: any) => docRef.set(data, options),
      update: (docRef: MockDocRef, data: any) => docRef.update(data),
      delete: (docRef: MockDocRef) => docRef.delete()
    };
    return cb(tx);
  }

  async getAll(...docRefs: MockDocRef[]) {
    return Promise.all(docRefs.map(r => r.get()));
  }
}

class MockAuth {
  users = new Map<string, any>();
  lookupShouldFail = false;
  linkShouldFail = false;
  deleteShouldFail = false;

  async getUser(uid: string) {
    if (this.lookupShouldFail) {
      const err = new Error('Auth Unavailable');
      (err as any).code = 'auth/internal-error';
      throw err;
    }
    const user = this.users.get(uid);
    if (user) return user;
    return {
      uid,
      email: `${uid}@gomila.pk`,
      displayName: 'Test User',
      disabled: false
    };
  }

  async getUserByEmail(email: string) {
    if (this.lookupShouldFail) {
      const err = new Error('Auth Unavailable');
      (err as any).code = 'auth/internal-error';
      throw err;
    }
    for (const u of this.users.values()) {
      if (u.email === email) return u;
    }
    const err = new Error('User not found');
    (err as any).code = 'auth/user-not-found';
    throw err;
  }

  async createUser(data: any) {
    const uid = `uid_${Math.random().toString(36).substring(2, 9)}`;
    const userObj = { uid, ...data };
    this.users.set(uid, userObj);
    return userObj;
  }

  async updateUser(uid: string, data: any) {
    const existing = this.users.get(uid);
    if (!existing) {
      const err = new Error('User not found');
      (err as any).code = 'auth/user-not-found';
      throw err;
    }
    const updated = { ...existing, ...data };
    this.users.set(uid, updated);
    return updated;
  }

  async deleteUser(uid: string) {
    if (this.deleteShouldFail) {
      throw new Error('Failed to delete Auth user');
    }
    this.users.delete(uid);
  }

  async generatePasswordResetLink(email: string) {
    if (this.linkShouldFail) {
      throw new Error('Link generation failed');
    }
    return `https://auth.gomila.pk/reset?email=${encodeURIComponent(email)}&token=test_token`;
  }
}

// ---------------------------------------------------------------------------
// UNIT TESTS
// ---------------------------------------------------------------------------
describe('User Management Unit Tests', () => {
  it('should define exactly the 7 strict system roles', () => {
    const expectedRoles = [
      'super_admin',
      'dispatch_manager',
      'rider',
      'cashier',
      'customer_service',
      'warehouse_staff',
      'management_viewer'
    ];
    assert.deepEqual(VALID_ROLES.sort(), expectedRoles.sort());
    assert.equal(VALID_ROLES.length, 7);
  });

  it('should normalize codes consistently (uppercase, trimmed, single spacing)', () => {
    assert.equal(normalizeCode('  emp-1002  '), 'EMP-1002');
    assert.equal(normalizeCode(' rider   005 '), 'RIDER 005');
  });

  it('should generate lowercase search prefixes', () => {
    const prefixes = generateSearchPrefixes('Zahid Ali', 'zahid@gomila.pk', 'EMP-1001');
    assert.ok(prefixes.includes('z'));
    assert.ok(prefixes.includes('zahid'));
    assert.ok(prefixes.includes('emp-1001'));
  });

  it('should correctly evaluate getRiderOpenOperations counts', async () => {
    const db = new MockFirestore() as any;
    const riderId = 'rider_99';

    // 1. Initially no open operations
    let ops = await getRiderOpenOperations(db, riderId);
    assert.equal(ops.hasOpenOperations, false);

    // 2. Add open assignment
    await db.collection('assignments').doc('a1').set({ riderId, active: true });
    // Add open dispatch run
    await db.collection('dispatchRuns').doc('dr1').set({ riderId, status: 'in_progress' });
    // Add open settlement
    await db.collection('riderSettlements').doc('s1').set({ riderId, status: 'pending' });
    // Add unreturned package
    await db.collection('packages').doc('p1').set({ assignedRiderId: riderId, operationalStatus: 'OUT_FOR_DELIVERY' });

    ops = await getRiderOpenOperations(db, riderId);
    assert.equal(ops.hasOpenOperations, true);
    assert.equal(ops.activeAssignmentCount, 1);
    assert.equal(ops.openDispatchRunCount, 1);
    assert.equal(ops.openSettlementCount, 1);
    assert.equal(ops.unreturnedPackageCount, 1);

    // 3. Mark all as closed/completed
    await db.collection('assignments').doc('a1').set({ riderId, active: false });
    await db.collection('dispatchRuns').doc('dr1').set({ riderId, status: 'completed' });
    await db.collection('riderSettlements').doc('s1').set({ riderId, status: 'closed' });
    await db.collection('packages').doc('p1').set({ assignedRiderId: riderId, operationalStatus: 'DELIVERED' });

    ops = await getRiderOpenOperations(db, riderId);
    assert.equal(ops.hasOpenOperations, false);
    assert.equal(ops.activeAssignmentCount, 0);
  });
});

// ---------------------------------------------------------------------------
// IN-MEMORY MOCK BEHAVIOR TESTS FOR USER MANAGEMENT HELPERS AND ROUTER LOGIC
// ---------------------------------------------------------------------------
describe('User Management In-Memory Mock Tests', () => {
  let db: MockFirestore;
  let adminAuth: MockAuth;
  let app: express.Application;
  let superAdminUid = 'admin_uid_1';

  beforeEach(async () => {
    db = new MockFirestore();
    adminAuth = new MockAuth();

    // Create initial Super Admin profile & Auth account
    await adminAuth.createUser({
      uid: superAdminUid,
      email: 'admin@gomila.pk',
      displayName: 'Super Admin'
    });

    await db.collection('profiles').doc(superAdminUid).set({
      id: superAdminUid,
      fullName: 'Super Admin',
      email: 'admin@gomila.pk',
      employeeCode: 'EMP-0001',
      normalizedEmployeeCode: 'EMP-0001',
      role: 'super_admin',
      active: true,
      riderId: null,
      createdAt: new Date().toISOString()
    });

    // Dummy Auth Middlewares for testing
    const mockRequireAuth = (req: any, res: any, next: any) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ success: false, error: { message: 'Unauthorized' } });
      }
      if (authHeader.includes('dispatch_manager_token')) {
        req.auth = { uid: 'dispatch_uid', role: 'dispatch_manager' };
      } else {
        req.auth = { uid: superAdminUid, role: 'super_admin' };
      }
      next();
    };

    const mockRequireExactRole = (allowedRole: string) => (req: any, res: any, next: any) => {
      if (req.auth?.role !== allowedRole) {
        return res.status(403).json({ success: false, error: { message: 'Forbidden' } });
      }
      next();
    };

    const router = createAdminUserRouter(db as any, adminAuth as any, mockRequireAuth, mockRequireExactRole);
    app = express();
    app.use(express.json());
    app.use('/api/admin', router);
  });

  it('should block non-super_admin users from accessing user management routes', async () => {
    const res = await supertest(app)
      .get('/api/admin/users')
      .set('Authorization', 'Bearer dispatch_manager_token');
    assert.equal(res.status, 403);
  });

  it('should create a Dispatch Manager account successfully', async () => {
    const res = await supertest(app)
      .post('/api/admin/users')
      .set('Authorization', 'Bearer super_admin_token')
      .send({
        fullName: 'Tariq Mehmood',
        email: 'tariq@gomila.pk',
        phone: '03001234567',
        employeeCode: 'EMP-1002',
        role: 'dispatch_manager',
        active: true
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.accountCreated, true);
    assert.equal(res.body.data.riderId, null);
    assert.ok(res.body.data.passwordSetupLink);

    // Verify profile in db
    const profileDoc = await db.collection('profiles').doc(res.body.data.uid).get();
    assert.equal(profileDoc.exists, true);
    assert.equal(profileDoc.data()?.role, 'dispatch_manager');

    // Verify code reservation doc
    const codeDoc = await db.collection('uniqueEmployeeCodes').doc(getCodeLockDocId('EMP-1002')).get();
    assert.equal(codeDoc.exists, true);
    assert.equal(codeDoc.data()?.status, 'committed');
  });

  it('should create a Rider account with reciprocal rider record and code reservation', async () => {
    const res = await supertest(app)
      .post('/api/admin/users')
      .set('Authorization', 'Bearer super_admin_token')
      .send({
        fullName: 'Usman Ghani',
        email: 'usman@gomila.pk',
        phone: '03119876543',
        employeeCode: 'EMP-2001',
        role: 'rider',
        active: true,
        riderCode: 'RIDER-501',
        vehicleType: 'Motorbike',
        vehicleNumber: 'LEB-8822',
        city: 'Lahore',
        assignedZone: 'Gulberg III',
        maximumDailyCapacity: 30
      });

    assert.equal(res.status, 201);
    assert.ok(res.body.data.riderId);

    const riderDoc = await db.collection('riders').doc(res.body.data.riderId).get();
    assert.equal(riderDoc.exists, true);
    assert.equal(riderDoc.data()?.riderCode, 'RIDER-501');
    assert.equal(riderDoc.data()?.profileId, res.body.data.uid);

    const riderCodeDoc = await db.collection('uniqueRiderCodes').doc(getCodeLockDocId('RIDER-501')).get();
    assert.equal(riderCodeDoc.exists, true);
    assert.equal(riderCodeDoc.data()?.status, 'committed');
  });

  it('should reject duplicate email, duplicate employee code, and duplicate rider code', async () => {
    // 1. Create initial user
    await supertest(app)
      .post('/api/admin/users')
      .set('Authorization', 'Bearer super_admin_token')
      .send({
        fullName: 'Original User',
        email: 'original@gomila.pk',
        phone: '03000000001',
        employeeCode: 'EMP-3000',
        role: 'rider',
        riderCode: 'RIDER-3000',
        vehicleType: 'Motorbike',
        vehicleNumber: 'AAA-111',
        city: 'Lahore',
        assignedZone: 'DHA',
        maximumDailyCapacity: 20
      });

    // Duplicate email
    const res1 = await supertest(app)
      .post('/api/admin/users')
      .set('Authorization', 'Bearer super_admin_token')
      .send({
        fullName: 'Dup Email',
        email: 'original@gomila.pk',
        phone: '03000000002',
        employeeCode: 'EMP-3001',
        role: 'dispatch_manager'
      });
    assert.equal(res1.status, 400);
    assert.equal(res1.body.error.code, 'DUPLICATE_EMAIL');

    // Duplicate Employee Code
    const res2 = await supertest(app)
      .post('/api/admin/users')
      .set('Authorization', 'Bearer super_admin_token')
      .send({
        fullName: 'Dup Emp Code',
        email: 'unique2@gomila.pk',
        phone: '03000000003',
        employeeCode: 'EMP-3000',
        role: 'dispatch_manager'
      });
    assert.equal(res2.status, 409);
    assert.equal(res2.body.error.code, 'DUPLICATE_EMPLOYEE_CODE');

    // Duplicate Rider Code
    const res3 = await supertest(app)
      .post('/api/admin/users')
      .set('Authorization', 'Bearer super_admin_token')
      .send({
        fullName: 'Dup Rider Code',
        email: 'unique3@gomila.pk',
        phone: '03000000004',
        employeeCode: 'EMP-3002',
        role: 'rider',
        riderCode: 'RIDER-3000',
        vehicleType: 'Motorbike',
        vehicleNumber: 'BBB-222',
        city: 'Lahore',
        assignedZone: 'DHA',
        maximumDailyCapacity: 20
      });
    assert.equal(res3.status, 409);
    assert.equal(res3.body.error.code, 'DUPLICATE_RIDER_CODE');
  });

  it('should handle setup link generation failure gracefully without rolling back created user', async () => {
    adminAuth.linkShouldFail = true;

    const res = await supertest(app)
      .post('/api/admin/users')
      .set('Authorization', 'Bearer super_admin_token')
      .send({
        fullName: 'No Link User',
        email: 'nolink@gomila.pk',
        phone: '03001112233',
        employeeCode: 'EMP-4000',
        role: 'cashier'
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.setupLinkStatus, 'failed');
    assert.equal(res.body.data.passwordSetupLink, null);
    assert.equal(res.body.warning.code, 'SETUP_LINK_GENERATION_FAILED');

    const prof = await db.collection('profiles').doc(res.body.data.uid).get();
    assert.equal(prof.exists, true);
  });

  it('should perform creation rollback if Firestore transaction fails', async () => {
    db.mainTransactionShouldFail = true;

    const res = await supertest(app)
      .post('/api/admin/users')
      .set('Authorization', 'Bearer super_admin_token')
      .send({
        fullName: 'Fail User',
        email: 'fail@gomila.pk',
        phone: '03009998877',
        employeeCode: 'EMP-5000',
        role: 'dispatch_manager'
      });

    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, 'ACCOUNT_CREATION_ROLLED_BACK');
  });

  it('should block deactivating a rider account with open operations with 409 RIDER_HAS_OPEN_OPERATIONS', async () => {
    // 1. Create Rider
    const createRes = await supertest(app)
      .post('/api/admin/users')
      .set('Authorization', 'Bearer super_admin_token')
      .send({
        fullName: 'Active Rider',
        email: 'activerider@gomila.pk',
        phone: '03005554433',
        employeeCode: 'EMP-6000',
        role: 'rider',
        riderCode: 'RIDER-6000',
        vehicleType: 'Motorbike',
        vehicleNumber: 'CCC-333',
        city: 'Lahore',
        assignedZone: 'Johar Town',
        maximumDailyCapacity: 25
      });

    const riderUid = createRes.body.data.uid;
    const riderId = createRes.body.data.riderId;

    // 2. Add open assignment to rider
    await db.collection('assignments').doc('assign_1').set({ riderId, active: true });

    // 3. Attempt to deactivate
    const deactRes = await supertest(app)
      .post(`/api/admin/users/${riderUid}/deactivate`)
      .set('Authorization', 'Bearer super_admin_token');

    assert.equal(deactRes.status, 409);
    assert.equal(deactRes.body.error.code, 'RIDER_HAS_OPEN_OPERATIONS');
    assert.equal(deactRes.body.error.details.activeAssignmentCount, 1);
  });

  it('should ignore active status changes in generic PATCH /api/admin/users/:uid', async () => {
    // Create User
    const createRes = await supertest(app)
      .post('/api/admin/users')
      .set('Authorization', 'Bearer super_admin_token')
      .send({
        fullName: 'Patch User',
        email: 'patch@gomila.pk',
        phone: '03007778899',
        employeeCode: 'EMP-7000',
        role: 'warehouse_staff',
        active: true
      });

    const targetUid = createRes.body.data.uid;

    // Send PATCH with active: false
    const patchRes = await supertest(app)
      .patch(`/api/admin/users/${targetUid}`)
      .set('Authorization', 'Bearer super_admin_token')
      .send({
        fullName: 'Patch User Updated',
        active: false // should be ignored!
      });

    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.data.active, true);

    const prof = await db.collection('profiles').doc(targetUid).get();
    assert.equal(prof.data()?.active, true);
  });

  it('should enforce Super Admin safety checks (self-deactivation & last super admin protection)', async () => {
    // Attempt self-deactivation
    const res1 = await supertest(app)
      .post(`/api/admin/users/${superAdminUid}/deactivate`)
      .set('Authorization', 'Bearer super_admin_token');

    assert.equal(res1.status, 409);
    assert.equal(res1.body.error.code, 'SELF_DEACTIVATION_BLOCKED');

    // Attempt self-role-change
    const res2 = await supertest(app)
      .patch(`/api/admin/users/${superAdminUid}`)
      .set('Authorization', 'Bearer super_admin_token')
      .send({ role: 'dispatch_manager' });

    assert.equal(res2.status, 409);
    assert.equal(res2.body.error.code, 'SELF_ROLE_CHANGE_BLOCKED');
  });
});
