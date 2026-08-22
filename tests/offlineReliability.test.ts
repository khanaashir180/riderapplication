import test from 'node:test';
import assert from 'node:assert';
import {
  buildOfflineBannerText,
  buildOfflineQueueItem,
  buildRouteSnapshot,
  computeRetryDelay
} from '../src/services/offline_store';

test('offline route snapshot is rider-scoped and minimal', () => {
  const actor = { uid: 'user_a', riderId: 'rider_a', fullName: 'A Rider' };
  const snapshot = buildRouteSnapshot({
    actor,
    orders: [
      {
        id: 'pkg_1',
        packageNumber: 'PKG-1',
        customerName: 'Ali',
        customerPhone: '0300',
        deliveryAddress: 'DHA',
        city: 'Lahore',
        zone: 'DHA',
        codExpected: 1200,
        paymentMethod: 'COD',
        operationalStatus: 'OUT_FOR_DELIVERY',
        routeSequence: 4,
        updatedAt: '2026-08-22T10:00:00.000Z'
      }
    ],
    activeRun: { id: 'run_1', status: 'in_progress', expectedPackages: ['pkg_1'] },
    riderInfo: { id: 'rider_a', rider_code: 'RD-01', assigned_zone: 'DHA' }
  });

  assert.equal(snapshot.actorKey, 'user_a::rider_a');
  assert.equal(snapshot.routePackages[0].customerName, 'Ali');
  assert.equal(snapshot.routePackages[0].routeSequence, 4);
  assert.equal(snapshot.activeRun?.id, 'run_1');
  assert.equal(snapshot.riderInfo?.assignedZone, 'DHA');
});

test('offline queue item includes required sync fields', () => {
  const actor = { uid: 'user_a', riderId: 'rider_a' };
  const item = buildOfflineQueueItem({
    actor,
    packageId: 'pkg_1',
    operationType: 'CONTACT_EVENT',
    payload: { method: 'CALL', outcome: 'NO_ANSWER' },
    observedServerRevision: '2026-08-22T10:00:00.000Z',
    idempotencyKey: 'CONTACT:pkg_1:1'
  });

  assert.equal(item.packageId, 'pkg_1');
  assert.equal(item.syncStatus, 'PENDING');
  assert.equal(item.retryCount, 0);
  assert.equal(item.observedServerRevision, '2026-08-22T10:00:00.000Z');
  assert.ok(item.operationId);
});

test('retry delay backs off and caps safely', () => {
  assert.equal(computeRetryDelay(0), 2000);
  assert.equal(computeRetryDelay(1), 4000);
  assert.equal(computeRetryDelay(10), 60000);
});

test('offline banner text matches sync state', () => {
  assert.equal(buildOfflineBannerText({ isOnline: true, pendingCount: 0 }), 'ONLINE');
  assert.equal(buildOfflineBannerText({ isOnline: false, pendingCount: 4 }), 'OFFLINE — 4 UPDATES WAITING');
  assert.equal(buildOfflineBannerText({ isOnline: true, pendingCount: 2 }), 'ONLINE — 2 UPDATES WAITING');
});
