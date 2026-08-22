import express from 'express';
import request from 'supertest';
import {
  normalizeIdentifier,
  calculateLateByCourier,
  calculateCodStatus,
  resolveLogisticsStatus,
  parseOmsCsv,
  reconcileCourierCsv,
  calculateCourierPerformance,
  DEFAULT_STATUS_MAPPINGS
} from '../src/services/logisticsService.js';
import { Shipment, ReturnCondition, ReturnDisposition } from '../src/types/logistics.js';
import { createLogisticsRouter } from '../src/server/logisticsRouter.js';

// In-Memory Mock Firestore for Router testing
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

  constructor(collectionName: string, dataStore: Map<string, any>, conditions: Array<{ field: string; op: string; value: any }> = []) {
    this.collectionName = collectionName;
    this.dataStore = dataStore;
    this.conditions = conditions;
  }

  where(field: string, op: string, value: any) {
    return new MockQuery(this.collectionName, this.dataStore, [...this.conditions, { field, op, value }]);
  }

  async get() {
    const prefix = `${this.collectionName}/`;
    let docs = Array.from(this.dataStore.entries())
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, data]) => {
        const id = path.slice(prefix.length);
        return {
          id,
          data: () => JSON.parse(JSON.stringify(data))
        };
      });

    for (const cond of this.conditions) {
      if (cond.op === '==') {
        docs = docs.filter(doc => doc.data()[cond.field] === cond.value);
      }
    }

    return {
      docs,
      size: docs.length,
      empty: docs.length === 0
    };
  }
}

class MockFirestore {
  dataStore: Map<string, any> = new Map();

  collection(name: string) {
    return {
      doc: (id?: string) => new MockDocRef(id || `doc_${Date.now()}`, this.dataStore, `${name}/${id || `doc_${Date.now()}`}`),
      where: (field: string, op: string, value: any) => new MockQuery(name, this.dataStore, [{ field, op, value }]),
      get: async () => new MockQuery(name, this.dataStore).get(),
      add: async (data: any) => {
        const id = `doc_${Date.now()}`;
        const ref = new MockDocRef(id, this.dataStore, `${name}/${id}`);
        await ref.set(data);
        return ref;
      }
    };
  }

  batch() {
    const operations: Array<() => Promise<void>> = [];
    return {
      set: (ref: any, data: any, options?: any) => {
        operations.push(async () => { await ref.set(data, options); });
      },
      update: (ref: any, data: any) => {
        operations.push(async () => { await ref.update(data); });
      },
      delete: (ref: any) => {
        operations.push(async () => { await ref.delete(); });
      },
      commit: async () => {
        for (const op of operations) {
          await op();
        }
      }
    };
  }
}

async function runLogisticsHubTests() {
  console.log('================================================================');
  console.log('RUNNING LOGISTICS HUB AUTOMATED ACCEPTANCE & SECURITY TESTS');
  console.log('================================================================');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      failed++;
    }
  }

  // 1. IDENTIFIER NORMALIZATION TESTS
  assert(normalizeIdentifier('="TRX-10023"') === 'TRX-10023', 'Normalizes Excel formula formula string ="TRX-10023"');
  assert(normalizeIdentifier('10023.0') === '10023', 'Normalizes numeric string with trailing .0');
  assert(normalizeIdentifier('  trx-10023  ') === 'TRX-10023', 'Trims whitespace and converts to uppercase');

  // 2. LATE SLA CALCULATION (> 96 HOURS / 4 DAYS RULE)
  const bookingTime = '2026-08-01T10:00:00.000Z';
  const deliveryWithin96 = '2026-08-04T10:00:00.000Z'; // 72 hours
  const deliveryAfter96 = '2026-08-06T11:00:00.000Z'; // 121 hours

  const onTimeResult = calculateLateByCourier(bookingTime, deliveryWithin96);
  assert(onTimeResult.lateByCourier === false, 'Shipment delivered in 72 hours is NOT marked late');
  assert(onTimeResult.ageHours === 72, 'Age in hours is correctly calculated as 72');

  const lateResult = calculateLateByCourier(bookingTime, deliveryAfter96);
  assert(lateResult.lateByCourier === true, 'Shipment delivered after 121 hours IS marked late (> 96h)');
  assert(lateResult.ageHours === 121, 'Age in hours is correctly calculated as 121');

  // 3. PHYSICAL RETURN OVERRIDE RULE
  const initialShipment: Shipment = {
    id: 'ship_001',
    trackingNumber: 'TRX-998877',
    orderNumber: 'G#50001_1',
    parentOrderNumber: 'G#50001',
    courier: 'TRAX',
    logisticsStatus: 'PENDING_DELIVERY',
    courierStatusRaw: 'In Transit',
    physicalReturnReceived: false,
    codExpected: 4500,
    codReceived: 0,
    codPending: 4500,
    codStatus: 'PENDING',
    customerName: 'Test Customer',
    customerPhone: '03001234567',
    shippingAddress: 'Street 1, DHA',
    destinationCity: 'Lahore',
    orderAmount: 4500,
    items: [],
    lateByCourier: false,
    deliveryAgeHours: 24,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z'
  };

  const status1 = resolveLogisticsStatus('Returned to Origin', [], initialShipment.logisticsStatus, initialShipment.physicalReturnReceived);
  assert(
    status1 === 'RETURN_AWAITING_PHYSICAL_RECEIPT',
    'Courier status "Returned to Origin" maps to RETURN_AWAITING_PHYSICAL_RECEIPT when physical return is unconfirmed'
  );

  const confirmedShipment: Shipment = {
    ...initialShipment,
    physicalReturnReceived: true,
    logisticsStatus: 'RETURN_PHYSICALLY_RECEIVED'
  };

  const status2 = resolveLogisticsStatus('Delivered to Customer', [], confirmedShipment.logisticsStatus, confirmedShipment.physicalReturnReceived);
  assert(
    status2 === 'RETURN_PHYSICALLY_RECEIVED',
    'Physical return confirmation PRESERVES RETURN_PHYSICALLY_RECEIVED and blocks courier status overwrites'
  );

  // 4. DELIVERED ORDERS COD SEPARATION
  const cod1 = calculateCodStatus(4500, 0, 'DELIVERED');
  assert(cod1 === 'PENDING', 'Delivered shipment with 0 COD received remains PENDING codStatus');

  const cod2 = calculateCodStatus(4500, 4500, 'DELIVERED');
  assert(cod2 === 'RECEIVED', 'Delivered shipment with full COD received becomes RECEIVED codStatus');

  // 5. OMS CSV PARSING & RECONCILIATION PIPELINE
  const omsCsv = `Order number,Parent order number,Shipping Name,Shipping Phone,Shipping Address1,Shipping City,Total,Lineitem Title,Lineitem quantity,Lineitem price,Dispatched
G#60001_1,G#60001,Zahid Khan,03211234567,Model Town,Lahore,5000,Gomila Boots,1,5000,2026-08-01T10:00:00Z
G#60002_1,G#60002,Usman Ali,03337654321,DHA Phase 5,Karachi,7500,Gomila Loafers,1,7500,2026-08-01T10:00:00Z`;

  const parseResult = parseOmsCsv(omsCsv, 'job_test_01', 'admin@gomila.pk');
  assert(parseResult.shipments.length === 2, 'OMS CSV parsing creates 2 shipments');
  assert(parseResult.shipments[0].trackingNumber === 'G#60001_1', 'Defaults tracking number to order number if unbooked');

  const existingShipments = parseResult.shipments;
  // Reconcile with Courier TRAX File
  const courierCsv = `Tracking Number,Order Number,Courier Status,Booked Date,Delivery Date
TRX-60001,G#60001_1,Delivered,2026-08-01T10:00:00Z,2026-08-03T12:00:00Z
TRX-60002,G#60002_1,Returned,2026-08-01T10:00:00Z,`;

  const reconResult = reconcileCourierCsv(courierCsv, 'TRAX', 'job_recon_01', 'admin@gomila.pk', existingShipments, []);
  assert(reconResult.updatedShipments.length === 2, 'Reconciliation updates 2 shipments');

  const delShipment = reconResult.updatedShipments.find(s => s.orderNumber === 'G#60001_1');
  assert(delShipment?.logisticsStatus === 'DELIVERED', 'Shipment 1 updated to DELIVERED');
  assert(delShipment?.trackingNumber === 'TRX-60001', 'Shipment 1 tracking number updated to TRX-60001');

  const retShipment = reconResult.updatedShipments.find(s => s.orderNumber === 'G#60002_1');
  assert(retShipment?.logisticsStatus === 'RETURN_AWAITING_PHYSICAL_RECEIPT', 'Shipment 2 updated to RETURN_AWAITING_PHYSICAL_RECEIPT');
  assert(retShipment?.physicalReturnReceived === false, 'Physical return received remains false');

  // 6. COURIER PERFORMANCE METRICS AGGREGATION
  const perfMetrics = calculateCourierPerformance(reconResult.updatedShipments, []);
  assert(perfMetrics.length === 1, 'Calculated performance metrics for TRAX');
  assert(perfMetrics[0].totalAssigned === 2, 'Total assigned = 2');
  assert(perfMetrics[0].deliveredCount === 1, 'Delivered count = 1');
  assert(perfMetrics[0].deliveryPercentage === 50, 'Delivery % = 50%');
  assert(perfMetrics[0].returnCount === 1, 'Return count = 1');

  // ================================================================
  // 7. SECURITY & ACCESS CONTROL REGRESSION TESTS (ROLES & PERMISSIONS)
  // ================================================================
  console.log('\n--- TESTING ACCESS CONTROL ON LOGISTICS ENDPOINTS ---');

  const mockDb = new MockFirestore();
  // Seed a sample shipment and exception
  await mockDb.collection('shipments').doc('ship_001').set(initialShipment);
  await mockDb.collection('exceptions').doc('exc_001').set({
    id: 'exc_001',
    status: 'OPEN',
    shipmentId: 'ship_001',
    trackingNumber: 'TRX-998877',
    orderNumber: 'G#50001_1',
    courier: 'TRAX',
    reason: 'Incorrect Address',
    createdAt: new Date().toISOString()
  });

  // Mock requireAuth and requireRole middleware matching server.ts behavior
  let currentAuthContext: { uid: string; email: string; role: string } = {
    uid: 'rider-user-1',
    email: 'rider@gomila.pk',
    role: 'rider'
  };

  const testRequireAuth = (req: any, res: any, next: any) => {
    req.auth = currentAuthContext;
    next();
  };

  const testRequireRole = (...roles: string[]) => {
    return (req: any, res: any, next: any) => {
      if (!req.auth || (!roles.includes(req.auth.role) && req.auth.role !== 'super_admin')) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Insufficient permissions for this operation.' }
        });
      }
      next();
    };
  };

  const testApp = express();
  testApp.use(express.json());
  testApp.use('/api/logistics', createLogisticsRouter(mockDb as any, testRequireAuth, testRequireRole));

  // TEST 7.1: RIDER Role gets 403 Forbidden on restricted GET routes
  currentAuthContext = { uid: 'rider_001', email: 'rider@gomila.pk', role: 'rider' };

  const endpointsToTestForRiderBlock = [
    { method: 'get', url: '/api/logistics/dashboard', name: 'GET /dashboard' },
    { method: 'get', url: '/api/logistics/shipments', name: 'GET /shipments' },
    { method: 'get', url: '/api/logistics/shipments/ship_001', name: 'GET /shipments/:id' },
    { method: 'get', url: '/api/logistics/import-jobs', name: 'GET /import-jobs' },
    { method: 'get', url: '/api/logistics/exceptions', name: 'GET /exceptions' },
    { method: 'get', url: '/api/logistics/reports/courier-performance', name: 'GET /reports/courier-performance' },
    { method: 'get', url: '/api/logistics/courier-mappings', name: 'GET /courier-mappings' },
    { method: 'post', url: '/api/logistics/import', name: 'POST /import', body: { fileType: 'oms', csvContent: 'dummy' } },
    { method: 'post', url: '/api/logistics/courier-mappings', name: 'POST /courier-mappings', body: { courier: 'TRAX', courierStatusRaw: 'DEL', logisticsStatus: 'DELIVERED' } }
  ];

  for (const ep of endpointsToTestForRiderBlock) {
    let res: any;
    if (ep.method === 'get') {
      res = await request(testApp).get(ep.url);
    } else {
      res = await request(testApp).post(ep.url).send(ep.body);
    }
    assert(
      res.status === 403 && res.body?.error?.code === 'FORBIDDEN',
      `Security: 'rider' role is blocked (HTTP 403) from ${ep.name}`
    );
  }

  // TEST 7.2: DISPATCH_MANAGER Role is allowed (HTTP 200) on management endpoints
  currentAuthContext = { uid: 'dispatch_001', email: 'dispatch@gomila.pk', role: 'dispatch_manager' };

  const resDash = await request(testApp).get('/api/logistics/dashboard');
  assert(resDash.status === 200 && resDash.body?.success === true, 'Access Control: dispatch_manager can access GET /dashboard');

  const resShip = await request(testApp).get('/api/logistics/shipments');
  assert(resShip.status === 200 && resShip.body?.success === true, 'Access Control: dispatch_manager can access GET /shipments');

  const resExc = await request(testApp).get('/api/logistics/exceptions');
  assert(resExc.status === 200 && resExc.body?.success === true, 'Access Control: dispatch_manager can access GET /exceptions');

  const resPerf = await request(testApp).get('/api/logistics/reports/courier-performance');
  assert(resPerf.status === 200 && resPerf.body?.success === true, 'Access Control: dispatch_manager can access GET /reports/courier-performance');

  // TEST 7.3: CUSTOMER_SERVICE Role has access to shipments and exceptions, but NOT reports/dashboard
  currentAuthContext = { uid: 'cs_001', email: 'cs@gomila.pk', role: 'customer_service' };

  const resCsShip = await request(testApp).get('/api/logistics/shipments');
  assert(resCsShip.status === 200, 'Access Control: customer_service can view shipments');

  const resCsExc = await request(testApp).get('/api/logistics/exceptions');
  assert(resCsExc.status === 200, 'Access Control: customer_service can view exceptions');

  const resCsDash = await request(testApp).get('/api/logistics/dashboard');
  assert(resCsDash.status === 403, 'Access Control: customer_service is blocked from /dashboard');

  const resCsPerf = await request(testApp).get('/api/logistics/reports/courier-performance');
  assert(resCsPerf.status === 403, 'Access Control: customer_service is blocked from /reports/courier-performance');

  // TEST 7.4: WAREHOUSE_STAFF Role can access /import-jobs and physical returns
  currentAuthContext = { uid: 'wh_001', email: 'warehouse@gomila.pk', role: 'warehouse_staff' };

  const resWhJobs = await request(testApp).get('/api/logistics/import-jobs');
  assert(resWhJobs.status === 200, 'Access Control: warehouse_staff can view import-jobs');

  const resWhDash = await request(testApp).get('/api/logistics/dashboard');
  assert(resWhDash.status === 403, 'Access Control: warehouse_staff is blocked from /dashboard');

  // TEST 7.5: SUPER_ADMIN Role can access all endpoints
  currentAuthContext = { uid: 'super_001', email: 'admin@gomila.pk', role: 'super_admin' };

  const resAdminDash = await request(testApp).get('/api/logistics/dashboard');
  assert(resAdminDash.status === 200, 'Access Control: super_admin can access /dashboard');

  console.log('================================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runLogisticsHubTests();
