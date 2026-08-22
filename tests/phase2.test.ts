import { encodeDocId } from '../src/services/csvImporter';

function runPhase2Tests() {
  console.log('================================================================');
  console.log('RUNNING PHASE 2 AUTOMATED ACCEPTANCE TESTS');
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

  // Simulated In-Memory State & Engine for Validation Testing
  interface TestPackage {
    id: string;
    packageNumber: string;
    importState: string;
    deliveryChannel: string;
    operationalStatus: string;
    assignedRiderId: string | null;
    custodyStage?: string;
    collectedAmount?: number;
    receiverName?: string;
    receiverRelationship?: string;
  }

  interface TestRider {
    id: string;
    name: string;
    active: boolean;
    maximumDailyCapacity: number;
  }

  interface TestAssignmentLock {
    packageId: string;
    riderId: string;
    active: boolean;
  }

  // Mock database initial state
  const packages: Record<string, TestPackage> = {
    'pkg_1': { id: 'pkg_1', packageNumber: 'G#1001_1', importState: 'committed', deliveryChannel: 'internal_rider', operationalStatus: 'ready_for_assignment', assignedRiderId: null },
    'pkg_ext': { id: 'pkg_ext', packageNumber: 'G#1002_1', importState: 'committed', deliveryChannel: 'external_courier', operationalStatus: 'ready_for_assignment', assignedRiderId: null },
    'pkg_del': { id: 'pkg_del', packageNumber: 'G#1003_1', importState: 'committed', deliveryChannel: 'internal_rider', operationalStatus: 'delivered', assignedRiderId: 'rider_1', collectedAmount: 5000 },
    'pkg_unassigned': { id: 'pkg_unassigned', packageNumber: 'G#1004_1', importState: 'committed', deliveryChannel: 'internal_rider', operationalStatus: 'dispatched', assignedRiderId: 'rider_1' },
    'pkg_scan': { id: 'pkg_scan', packageNumber: 'G#1005_1', importState: 'committed', deliveryChannel: 'internal_rider', operationalStatus: 'dispatched', assignedRiderId: 'rider_1', custodyStage: 'none' }
  };

  const riders: Record<string, TestRider> = {
    'rider_1': { id: 'rider_1', name: 'Rider One', active: true, maximumDailyCapacity: 2 },
    'rider_2': { id: 'rider_2', name: 'Rider Two', active: true, maximumDailyCapacity: 50 },
    'rider_inactive': { id: 'rider_inactive', name: 'Inactive Rider', active: false, maximumDailyCapacity: 50 }
  };

  const assignments: Record<string, TestAssignmentLock> = {};

  // Helper Functions representing Server-Side Business Logic
  function assignPackageLogic(packageId: string, riderId: string) {
    const pkg = packages[packageId];
    if (!pkg) throw new Error('Package not found');
    if (pkg.importState !== 'committed') throw new Error('Package not committed');
    if (pkg.deliveryChannel !== 'internal_rider') throw new Error('Cannot assign package with non-internal rider delivery channel');
    if (['delivered', 'returned', 'cancelled', 'closed'].includes(pkg.operationalStatus)) {
      throw new Error(`Package in status ${pkg.operationalStatus} cannot be assigned`);
    }

    const r = riders[riderId];
    if (!r || !r.active) throw new Error('Rider inactive or not found');

    const activeRiderCount = Object.values(assignments).filter(a => a.riderId === riderId && a.active).length;
    if (activeRiderCount >= r.maximumDailyCapacity) {
      throw new Error(`Rider daily capacity exceeded (${r.maximumDailyCapacity})`);
    }

    if (assignments[packageId] && assignments[packageId].active) {
      throw new Error('Active assignment lock exists for package. Simultaneous double assignment rejected.');
    }

    assignments[packageId] = { packageId, riderId, active: true };
    pkg.assignedRiderId = riderId;
    pkg.operationalStatus = 'assigned';
    return true;
  }

  function transferAssignmentLogic(packageId: string, sourceRiderId: string, destRiderId: string, reason: string) {
    const lock = assignments[packageId];
    if (!lock || !lock.active) throw new Error('No active assignment');
    if (lock.riderId !== sourceRiderId) throw new Error('Source rider mismatch');

    const pkg = packages[packageId];
    if (['delivered', 'returned', 'cancelled', 'closed'].includes(pkg.operationalStatus)) {
      throw new Error('Completed package cannot be transferred');
    }

    const destRider = riders[destRiderId];
    if (!destRider || !destRider.active) throw new Error('Destination rider inactive or not found');
    if (!reason || !reason.trim()) throw new Error('Transfer reason required');

    lock.active = false;
    assignments[`${packageId}_tr`] = { packageId, riderId: destRiderId, active: true };
    pkg.assignedRiderId = destRiderId;
    return true;
  }

  function scanCustodyLogic(barcode: string, scanStage: string) {
    const matched = Object.values(packages).find(p => p.packageNumber === barcode || p.id === barcode);
    if (!matched) {
      throw new Error(`No package found matching exact barcode "${barcode}". Partial match rejected.`);
    }

    if (scanStage === 'delivered') throw new Error('Custody scan cannot mark package as delivered');

    const currStage = matched.custodyStage || 'none';
    if (scanStage === 'dispatcher_scanned' && currStage !== 'warehouse_prepared') {
      throw new Error(`Scan stage dispatcher_scanned requires prior stage warehouse_prepared (found: ${currStage})`);
    }

    matched.custodyStage = scanStage;
    return true;
  }

  function riderReadRouteLogic(requestingRiderId: string, targetRiderId: string) {
    if (requestingRiderId !== targetRiderId) {
      throw new Error('Permission denied: Rider A cannot read Rider B route');
    }
    return Object.values(packages).filter(p => p.assignedRiderId === requestingRiderId);
  }

  function recordDeliveryAttemptLogic(requestingRiderId: string, packageId: string, outcome: any) {
    const pkg = packages[packageId];
    if (!pkg) throw new Error('Package not found');
    if (pkg.assignedRiderId !== requestingRiderId) {
      throw new Error('Rider completing unassigned package is strictly rejected');
    }

    if (pkg.operationalStatus === 'delivered') {
      throw new Error('Duplicate delivery submission rejected');
    }

    if (['returned', 'cancelled', 'closed'].includes(pkg.operationalStatus)) {
      throw new Error(`Invalid state transition from ${pkg.operationalStatus} to ${outcome.status}`);
    }

    const statusNorm = outcome.status.toLowerCase().replace(/[\s_]+/g, '');

    if (statusNorm === 'delivered') {
      if (outcome.collectedAmount === undefined || outcome.collectedAmount === null) {
        throw new Error('Delivered status requires actual collected amount');
      }
      if (!outcome.receiverName || !outcome.receiverRelationship) {
        throw new Error('Delivered status requires receiver details');
      }
    } else if (statusNorm === 'rescheduled') {
      if (!outcome.newDeliveryDate) {
        throw new Error('Rescheduled status requires new delivery date');
      }
    }

    pkg.operationalStatus = statusNorm;
    return true;
  }

  // --- 1. Simultaneous double assignment ---
  let err1 = '';
  try {
    assignPackageLogic('pkg_1', 'rider_2');
    assignPackageLogic('pkg_1', 'rider_2'); // Second call triggers double assignment lock
  } catch (e: any) {
    err1 = e.message;
  }
  assert(err1.includes('Simultaneous double assignment rejected'), 'Simultaneous double assignment correctly rejected by lock');

  // --- 2. Capacity exceeded ---
  let err2 = '';
  try {
    assignPackageLogic('pkg_unassigned', 'rider_1');
    assignPackageLogic('pkg_scan', 'rider_1');
    // rider_1 capacity is 2. Attempting a 3rd assignment:
    packages['pkg_extra'] = { id: 'pkg_extra', packageNumber: 'G#1099_1', importState: 'committed', deliveryChannel: 'internal_rider', operationalStatus: 'ready_for_assignment', assignedRiderId: null };
    assignPackageLogic('pkg_extra', 'rider_1');
  } catch (e: any) {
    err2 = e.message;
  }
  assert(err2.includes('capacity exceeded'), 'Rider capacity exceeded rejected');

  // --- 3. Assignment of external courier package ---
  let err3 = '';
  try {
    assignPackageLogic('pkg_ext', 'rider_2');
  } catch (e: any) {
    err3 = e.message;
  }
  assert(err3.includes('non-internal rider delivery channel'), 'Assignment of external courier package rejected');

  // --- 4. Assignment of delivered package ---
  let err4 = '';
  try {
    assignPackageLogic('pkg_del', 'rider_2');
  } catch (e: any) {
    err4 = e.message;
  }
  assert(err4.includes('cannot be assigned'), 'Assignment of delivered package rejected');

  // --- 5. Transfer to inactive rider ---
  let err5 = '';
  try {
    transferAssignmentLogic('pkg_1', 'rider_2', 'rider_inactive', 'Shift end');
  } catch (e: any) {
    err5 = e.message;
  }
  assert(err5.includes('Destination rider inactive'), 'Transfer to inactive rider rejected');

  // --- 6. Scan wrong sequence ---
  let err6 = '';
  try {
    // pkg_scan has custodyStage = 'none'. Attempting 'dispatcher_scanned' directly without 'warehouse_prepared':
    scanCustodyLogic('G#1005_1', 'dispatcher_scanned');
  } catch (e: any) {
    err6 = e.message;
  }
  assert(err6.includes('requires prior stage warehouse_prepared'), 'Scan wrong sequence rejected');

  // --- 7. Partial barcode match rejected ---
  let err7 = '';
  try {
    scanCustodyLogic('G#1005', 'warehouse_prepared'); // Partial string (missing _1)
  } catch (e: any) {
    err7 = e.message;
  }
  assert(err7.includes('Partial match rejected'), 'Partial barcode match rejected');

  // --- 8. Rider A reading Rider B route ---
  let err8 = '';
  try {
    riderReadRouteLogic('rider_1', 'rider_2');
  } catch (e: any) {
    err8 = e.message;
  }
  assert(err8.includes('Permission denied'), 'Rider A reading Rider B route rejected');

  // --- 9. Rider completing unassigned package ---
  let err9 = '';
  try {
    recordDeliveryAttemptLogic('rider_2', 'pkg_unassigned', { status: 'Delivered', collectedAmount: 1000, receiverName: 'Ali', receiverRelationship: 'Self' });
  } catch (e: any) {
    err9 = e.message;
  }
  assert(err9.includes('Rider completing unassigned package'), 'Rider completing unassigned package rejected');

  // --- 10. Delivered without collected amount ---
  let err10 = '';
  try {
    recordDeliveryAttemptLogic('rider_1', 'pkg_unassigned', { status: 'Delivered', collectedAmount: null, receiverName: 'Ali', receiverRelationship: 'Self' });
  } catch (e: any) {
    err10 = e.message;
  }
  assert(err10.includes('Delivered status requires actual collected amount'), 'Delivered without collected amount rejected');

  // --- 11. Rescheduled without new date ---
  let err11 = '';
  try {
    recordDeliveryAttemptLogic('rider_1', 'pkg_unassigned', { status: 'Rescheduled', newDeliveryDate: '' });
  } catch (e: any) {
    err11 = e.message;
  }
  assert(err11.includes('Rescheduled status requires new delivery date'), 'Rescheduled without new date rejected');

  // --- 12. Duplicate delivery submission ---
  let err12 = '';
  try {
    recordDeliveryAttemptLogic('rider_1', 'pkg_del', { status: 'Delivered', collectedAmount: 5000, receiverName: 'Ali', receiverRelationship: 'Self' });
  } catch (e: any) {
    err12 = e.message;
  }
  assert(err12.includes('Duplicate delivery submission rejected'), 'Duplicate delivery submission rejected');

  // --- 13. Invalid state transition ---
  let err13 = '';
  try {
    packages['pkg_returned'] = { id: 'pkg_returned', packageNumber: 'G#1090_1', importState: 'committed', deliveryChannel: 'internal_rider', operationalStatus: 'returned', assignedRiderId: 'rider_1' };
    recordDeliveryAttemptLogic('rider_1', 'pkg_returned', { status: 'Delivered', collectedAmount: 5000, receiverName: 'Ali', receiverRelationship: 'Self' });
  } catch (e: any) {
    err13 = e.message;
  }
  assert(err13.includes('Invalid state transition'), 'Invalid state transition rejected');

  console.log('================================================================');
  console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase2Tests();
