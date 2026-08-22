import test from 'node:test';
import assert from 'node:assert';
import {
  assignRouteSequences,
  buildSuggestedRuns,
  computeRiderCapacitySnapshot,
  recommendRidersForPackages,
  simulateDispatchPlan
} from '../src/services/dispatchPlanning';

test('route sequence does not rely on input array order', () => {
  const sequenced = assignRouteSequences([
    { id: 'pkg_2', packageNumber: 'PKG-2', city: 'Lahore', zone: 'DHA', reattemptPriority: 1 },
    { id: 'pkg_1', packageNumber: 'PKG-1', city: 'Lahore', zone: 'DHA', reattemptPriority: 3 }
  ]);

  assert.equal(sequenced[0].routeSequence, 1);
  assert.equal(sequenced[1].routeSequence, 2);
  assert.equal(sequenced[0].id, 'pkg_1');
});

test('capacity snapshot includes COD exposure and zone eligibility', () => {
  const snapshot = computeRiderCapacitySnapshot({
    rider: {
      id: 'r1',
      maximum_daily_capacity: 45,
      maximum_cod_exposure: 250000,
      allowed_zones: ['DHA']
    },
    activeOrders: [
      { id: 'pkg_1', codExpected: 100000, assignedRiderId: 'r1' },
      { id: 'pkg_2', codExpected: 50000, assignedRiderId: 'r1' }
    ],
    proposedOrders: [{ id: 'pkg_3', codExpected: 25000 }],
    targetZone: 'DHA'
  });

  assert.equal(snapshot.assignedCount, 3);
  assert.equal(snapshot.codExposure, 175000);
  assert.equal(snapshot.remainingCodExposure, 75000);
  assert.equal(snapshot.zoneMatch, true);
});

test('rider recommendations are explainable and prioritize eligible capacity', () => {
  const recommendations = recommendRidersForPackages({
    riders: [
      { id: 'r1', maximum_daily_capacity: 45, maximum_cod_exposure: 250000, allowed_zones: ['DHA'] },
      { id: 'r2', maximum_daily_capacity: 45, maximum_cod_exposure: 80000, allowed_zones: ['Cantt'] }
    ],
    activeOrders: [{ id: 'pkg_x', codExpected: 10000, assignedRiderId: 'r1', zone: 'DHA' }],
    proposedOrders: [{ id: 'pkg_1', codExpected: 20000, city: 'Lahore', zone: 'DHA' }]
  });

  assert.equal(recommendations[0].riderId, 'r1');
  assert.match(recommendations[0].explainers.join(' '), /Remaining capacity/i);
});

test('suggested runs include route sequence and recommended rider', () => {
  const runs = buildSuggestedRuns({
    packages: [
      { id: 'pkg_1', packageNumber: 'PKG-1', city: 'Lahore', zone: 'DHA', subZone: 'Phase 5', codExpected: 2000 },
      { id: 'pkg_2', packageNumber: 'PKG-2', city: 'Lahore', zone: 'DHA', subZone: 'Phase 5', codExpected: 3000 }
    ],
    riders: [{ id: 'r1', maximum_daily_capacity: 45, maximum_cod_exposure: 250000, allowed_zones: ['DHA'] }],
    activeOrders: []
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].packageCount, 2);
  assert.equal(runs[0].recommendedRiderId, 'r1');
  assert.equal(runs[0].routeSequence[0].routeSequence, 1);
});

test('500-package simulation avoids duplicate assignment and violations', () => {
  const packages = Array.from({ length: 500 }, (_, index) => ({
    id: `pkg_${index + 1}`,
    packageNumber: `PKG-${index + 1}`,
    city: 'Lahore',
    zone: index % 2 === 0 ? 'DHA' : 'Cantt',
    subZone: index % 5 === 0 ? 'Phase 5' : 'Main',
    codExpected: 1000,
    customerDeliveryWindow: index % 7 === 0 ? '2pm-6pm' : undefined
  }));
  const riders = Array.from({ length: 10 }, (_, index) => ({
    id: `rider_${index + 1}`,
    maximum_daily_capacity: 60,
    maximum_cod_exposure: 60000,
    allowed_zones: index % 2 === 0 ? ['DHA'] : ['Cantt']
  }));

  const result = simulateDispatchPlan({ packages, riders, activeOrders: [] });
  const uniquePackageIds = new Set(result.assignments.map((assignment) => assignment.packageId));

  assert.equal(uniquePackageIds.size, result.assignments.length);
  assert.equal(result.violations.length, 0);
  assert.equal(result.unassignedPackageIds.length, 0);
  assert.equal(result.assignments.every((assignment) => assignment.routeSequence > 0), true);
});
