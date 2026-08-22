import { Order, Rider } from '../types';

export interface RiderCapacitySnapshot {
  riderId: string;
  assignedCount: number;
  maximumPackages: number;
  codExposure: number;
  maximumCodExposure: number;
  remainingPackages: number;
  remainingCodExposure: number;
  zoneMatch: boolean;
  explainers: string[];
}

export interface RiderRecommendation {
  riderId: string;
  score: number;
  explainers: string[];
  capacity: RiderCapacitySnapshot;
}

export interface SuggestedRun {
  city: string;
  zone: string;
  subZone: string;
  packageIds: string[];
  packageCount: number;
  codExposure: number;
  routeSequence: Array<{ packageId: string; routeSequence: number }>;
  recommendedRiderId: string | null;
  explainers: string[];
}

function normalizeZone(value: string | undefined | null) {
  return String(value || '').trim().toLowerCase();
}

function codValue(order: Partial<Order>) {
  return Number(order.codExpected ?? order.cod_expected ?? 0) || 0;
}

function orderZoneKey(order: Partial<Order>) {
  return [order.city || '', order.zone || '', order.subZone || ''].map((value) => String(value || '').trim()).join(' / ');
}

function customerWindowPriority(order: Partial<Order>) {
  return order.customerDeliveryWindow ? 10 : 0;
}

function reattemptPriority(order: Partial<Order>) {
  return Number(order.reattemptPriority || 0) || 0;
}

export function assignRouteSequences<T extends Partial<Order>>(orders: T[]): Array<T & { routeSequence: number }> {
  const sorted = [...orders].sort((a, b) => {
    const zoneDiff = orderZoneKey(a).localeCompare(orderZoneKey(b));
    if (zoneDiff !== 0) return zoneDiff;
    const reattemptDiff = reattemptPriority(b) - reattemptPriority(a);
    if (reattemptDiff !== 0) return reattemptDiff;
    const windowDiff = customerWindowPriority(b) - customerWindowPriority(a);
    if (windowDiff !== 0) return windowDiff;
    return String(a.packageNumber || a.id || '').localeCompare(String(b.packageNumber || b.id || ''));
  });
  return sorted.map((order, index) => ({ ...order, routeSequence: index + 1 }));
}

export function computeRiderCapacitySnapshot(params: {
  rider: Rider;
  activeOrders: Partial<Order>[];
  proposedOrders?: Partial<Order>[];
  targetZone?: string;
}): RiderCapacitySnapshot {
  const { rider, activeOrders, proposedOrders = [], targetZone } = params;
  const maximumPackages = rider.maximum_daily_capacity || 45;
  const maximumCodExposure = rider.maximum_cod_exposure || 250000;
  const assignedCount = activeOrders.length + proposedOrders.length;
  const codExposure = [...activeOrders, ...proposedOrders].reduce((sum, order) => sum + codValue(order), Number(rider.cod_held || 0));
  const allowedZones = rider.allowed_zones || (rider.assigned_zone ? [rider.assigned_zone] : []);
  const zoneMatch = !targetZone || allowedZones.length === 0 || allowedZones.map(normalizeZone).includes(normalizeZone(targetZone));
  const explainers = [
    zoneMatch ? 'Zone match' : 'Zone mismatch',
    `${assignedCount}/${maximumPackages} packages`,
    `Rs ${codExposure.toLocaleString()}/Rs ${maximumCodExposure.toLocaleString()} COD exposure`
  ];

  return {
    riderId: rider.id,
    assignedCount,
    maximumPackages,
    codExposure,
    maximumCodExposure,
    remainingPackages: maximumPackages - assignedCount,
    remainingCodExposure: maximumCodExposure - codExposure,
    zoneMatch,
    explainers
  };
}

export function recommendRidersForPackages(params: {
  riders: Rider[];
  activeOrders: Partial<Order>[];
  proposedOrders: Partial<Order>[];
}): RiderRecommendation[] {
  const { riders, activeOrders, proposedOrders } = params;
  const targetZone = proposedOrders[0]?.zone || '';

  return riders.map((rider) => {
    const riderOrders = activeOrders.filter((order) => (order.assignedRiderId || order.assigned_rider_id) === rider.id);
    const capacity = computeRiderCapacitySnapshot({
      rider,
      activeOrders: riderOrders,
      proposedOrders,
      targetZone
    });
    let score = 0;
    if (capacity.zoneMatch) score += 40;
    score += Math.max(0, capacity.remainingPackages) * 2;
    score += Math.max(0, capacity.remainingCodExposure / 10000);
    score += proposedOrders.reduce((sum, order) => sum + reattemptPriority(order) + customerWindowPriority(order), 0);
    if (capacity.remainingPackages < 0 || capacity.remainingCodExposure < 0) {
      score -= 1000;
    }
    const explainers = [
      capacity.zoneMatch ? 'Zone match keeps route local.' : 'Zone mismatch reduces recommendation.',
      `Remaining capacity: ${Math.max(0, capacity.remainingPackages)} packages`,
      `Remaining COD headroom: Rs ${Math.max(0, capacity.remainingCodExposure).toLocaleString()}`
    ];
    return {
      riderId: rider.id,
      score,
      explainers,
      capacity
    };
  }).sort((a, b) => b.score - a.score);
}

export function buildSuggestedRuns(params: {
  packages: Partial<Order>[];
  riders: Rider[];
  activeOrders: Partial<Order>[];
}): SuggestedRun[] {
  const grouped = new Map<string, Partial<Order>[]>();
  for (const pkg of params.packages) {
    if (!pkg.city || !pkg.zone) continue;
    const key = `${pkg.city}::${pkg.zone}::${pkg.subZone || 'General'}`;
    const bucket = grouped.get(key) || [];
    bucket.push(pkg);
    grouped.set(key, bucket);
  }

  return Array.from(grouped.entries()).map(([key, group]) => {
    const [city, zone, subZone] = key.split('::');
    const sequenced = assignRouteSequences(group);
    const recommendation = recommendRidersForPackages({
      riders: params.riders,
      activeOrders: params.activeOrders,
      proposedOrders: sequenced
    })[0] || null;

    return {
      city,
      zone,
      subZone,
      packageIds: sequenced.map((pkg) => String(pkg.id)),
      packageCount: sequenced.length,
      codExposure: sequenced.reduce((sum, pkg) => sum + codValue(pkg), 0),
      routeSequence: sequenced.map((pkg) => ({ packageId: String(pkg.id), routeSequence: pkg.routeSequence })),
      recommendedRiderId: recommendation?.riderId || null,
      explainers: recommendation?.explainers || ['No eligible rider found']
    };
  });
}

export function simulateDispatchPlan(params: {
  packages: Partial<Order>[];
  riders: Rider[];
  activeOrders?: Partial<Order>[];
}): {
  assignments: Array<{ packageId: string; riderId: string; routeSequence: number }>;
  unassignedPackageIds: string[];
  violations: string[];
} {
  const activeOrders = [...(params.activeOrders || [])];
  const assignments: Array<{ packageId: string; riderId: string; routeSequence: number }> = [];
  const unassignedPackageIds: string[] = [];
  const violations: string[] = [];

  const sequenced = assignRouteSequences(params.packages);
  for (const pkg of sequenced) {
    if (!pkg.city || !pkg.zone) {
      unassignedPackageIds.push(String(pkg.id));
      violations.push(`Invalid address auto-dispatch blocked for ${pkg.id}`);
      continue;
    }

    const recommendation = recommendRidersForPackages({
      riders: params.riders,
      activeOrders,
      proposedOrders: [pkg]
    }).find((candidate) => candidate.capacity.remainingPackages >= 0 && candidate.capacity.remainingCodExposure >= 0 && candidate.capacity.zoneMatch);

    if (!recommendation) {
      unassignedPackageIds.push(String(pkg.id));
      violations.push(`No capacity-safe rider found for ${pkg.id}`);
      continue;
    }

    assignments.push({
      packageId: String(pkg.id),
      riderId: recommendation.riderId,
      routeSequence: pkg.routeSequence
    });
    activeOrders.push({ ...pkg, assignedRiderId: recommendation.riderId, routeSequence: pkg.routeSequence } as Partial<Order>);
  }

  return { assignments, unassignedPackageIds, violations };
}
