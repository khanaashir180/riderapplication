import {
  LoadedAnalyticsDataset,
  ManagementFilters,
  RiderCommandRow,
  RiderTimelineEvent
} from "./analyticsTypes.js";
import {
  buildIndexes,
  getAttemptTimestamp,
  getHoursFromNow,
  getRangeForFilters,
  isIsoInRange,
  normalizeStatus,
  packageMatchesFilters,
  recordMatchesFilters,
  resolveActorType,
  resolvePackageStatus,
  sortByTimestamp,
  toAmount
} from "./shared.js";

const ACTIVE_PACKAGE_STATUSES = new Set([
  "ASSIGNED",
  "DISPATCHER_SCANNED",
  "RIDER_SCANNED",
  "RIDER_ACCEPTED",
  "OUT_FOR_DELIVERY",
  "CUSTOMER_UNAVAILABLE",
  "RESCHEDULED",
  "REFUSED",
  "ADDRESS_ISSUE",
  "RETURN_REQUIRED",
  "RIDER_RETURNING",
  "RIDER_HANDBACK"
]);

export function buildRiderAnalytics(dataset: LoadedAnalyticsDataset, filters: ManagementFilters) {
  const range = getRangeForFilters(filters);
  const indexes = buildIndexes(dataset);
  const riders = dataset.riders.filter((rider) => rider.active !== false && (!filters.riderId || String(rider.id) === filters.riderId));
  const exceptionsByRider = new Map<string, number>();
  for (const exception of dataset.exceptions) {
    const riderId = String(exception.riderId || "");
    if (!riderId) continue;
    exceptionsByRider.set(riderId, (exceptionsByRider.get(riderId) || 0) + 1);
  }

  const rows: RiderCommandRow[] = riders.map((rider) => {
    const riderId = String(rider.id);
    const riderPackages = dataset.packages.filter((pkg) => String(pkg.assignedRiderId || "") === riderId && packageMatchesFilters(pkg, filters));
    const riderAttemptsToday = dataset.deliveryAttempts.filter((attempt) => String(attempt.riderId || "") === riderId && isIsoInRange(getAttemptTimestamp(attempt), range) && recordMatchesFilters(attempt, dataset, filters));
    const deliveredAttemptsToday = riderAttemptsToday.filter((attempt) => normalizeStatus(attempt.status) === "DELIVERED");
    const failedAttemptsToday = riderAttemptsToday.filter((attempt) => normalizeStatus(attempt.status) !== "DELIVERED");
    const assignedCount = riderPackages.filter((pkg) => ["ASSIGNED", "DISPATCHER_SCANNED", "RIDER_SCANNED", "RIDER_ACCEPTED"].includes(resolvePackageStatus(pkg))).length;
    const remaining = riderPackages.filter((pkg) => ACTIVE_PACKAGE_STATUSES.has(resolvePackageStatus(pkg))).length;
    const codCollected = dataset.codCollections
      .filter((collection) => String(collection.riderId || "") === riderId && isIsoInRange(collection.createdAt, range) && recordMatchesFilters(collection, dataset, filters))
      .reduce((sum, collection) => sum + toAmount(collection.collectedAmount), 0);
    const returnsPending = dataset.returns.filter((ret) => String(ret.riderId || "") === riderId && ["rider_handed_back", "returning_to_warehouse"].includes(String(ret.returnStatus || "").toLowerCase()) && recordMatchesFilters(ret, dataset, filters)).length;
    const firstAttemptDenominator = new Set(riderAttemptsToday.map((attempt) => String(attempt.packageId))).size;
    const firstAttemptSuccessCount = deliveredAttemptsToday.filter((attempt) => Number(attempt.attemptNumber || 1) === 1).length;
    const firstAttemptSuccess = firstAttemptDenominator > 0 ? (firstAttemptSuccessCount / firstAttemptDenominator) * 100 : null;
    const cashOutstanding = Math.max(0,
      dataset.financialPostings
        .filter((posting) => posting.accountCode === "RIDER_CASH_WALLET" && String(posting.riderId || "") === riderId)
        .reduce((sum, posting) => sum + toAmount(posting.debitAmount) - toAmount(posting.creditAmount), 0)
    );

    const timeline = buildRiderTimeline(dataset, filters, riderId);
    const shiftStatus = deriveShiftStatus(dataset, riderId, riderPackages, returnsPending, cashOutstanding);

    return {
      riderId,
      riderName: rider.fullName || rider.full_name || rider.rider_code || riderId,
      riderCode: rider.rider_code || riderId,
      city: rider.city || "",
      zone: rider.assigned_zone || rider.assignedZone || "",
      shiftStatus,
      assigned: assignedCount,
      delivered: deliveredAttemptsToday.length,
      failed: failedAttemptsToday.length,
      remaining,
      firstAttemptSuccess,
      codCollected,
      cashOutstanding,
      returnsPending,
      lastActionAt: timeline[0]?.timestamp || null,
      lastActionLabel: timeline[0]?.label || null,
      exceptionCount: exceptionsByRider.get(riderId) || 0,
      timelineDrilldownKey: `riderTimeline.${riderId}`
    };
  });

  const timelines = new Map<string, RiderTimelineEvent[]>();
  for (const rider of rows) {
    timelines.set(rider.riderId, buildRiderTimeline(dataset, filters, rider.riderId));
  }

  return {
    range,
    riders: rows,
    timelines
  };
}

export function buildRiderTimeline(dataset: LoadedAnalyticsDataset, filters: ManagementFilters, riderId: string): RiderTimelineEvent[] {
  const indexes = buildIndexes(dataset);
  const events: RiderTimelineEvent[] = [];
  const pushEvent = (event: RiderTimelineEvent | null) => {
    if (event) events.push(event);
  };

  for (const run of dataset.dispatchRuns.filter((run) => String(run.riderId || "") === riderId)) {
    if (run.startTimestamp) {
      pushEvent({
        id: `${run.id}_start`,
        riderId,
        timestamp: run.startTimestamp,
        label: "Shift started",
        detail: `Dispatch run ${run.id} started`,
        source: "dispatchRuns"
      });
    }
    if (run.acceptedByRider || run.acceptedAt) {
      pushEvent({
        id: `${run.id}_accept`,
        riderId,
        timestamp: run.acceptedAt || run.startTimestamp || run.updatedAt || run.createdAt,
        label: "Manifest accepted",
        detail: `${Array.isArray(run.expectedPackages) ? run.expectedPackages.length : 0} packages`,
        source: "dispatchRuns"
      });
    }
    if (run.endTimestamp || run.completedAt) {
      pushEvent({
        id: `${run.id}_end`,
        riderId,
        timestamp: run.endTimestamp || run.completedAt,
        label: "Shift closed",
        detail: `Dispatch run ${run.id} closed`,
        source: "dispatchRuns"
      });
    }
  }

  for (const attempt of dataset.deliveryAttempts.filter((attempt) => String(attempt.riderId || "") === riderId && recordMatchesFilters(attempt, dataset, filters))) {
    const pkg = indexes.packagesById.get(String(attempt.packageId));
    pushEvent({
      id: String(attempt.id),
      riderId,
      timestamp: getAttemptTimestamp(attempt) || "",
      label: normalizeStatus(attempt.status) === "DELIVERED" ? "Delivered" : normalizeStatus(attempt.status).replace(/_/g, " "),
      detail: `${resolvePackageNumberOrId(pkg, attempt.packageId)}${normalizeStatus(attempt.status) === "DELIVERED" ? ` — ${attempt.paymentMethod || "Prepaid"}` : ""}`,
      packageId: String(attempt.packageId),
      packageNumber: pkg?.packageNumber || String(attempt.packageId),
      amount: toAmount(attempt.collectedAmount),
      source: "deliveryAttempts"
    });
  }

  for (const retEvent of dataset.returnCustodyEvents.filter((event) => String(event.actorUid || "") && String(event.packageId || "") && recordMatchesFilters(event, dataset, filters))) {
    const pkg = indexes.packagesById.get(String(retEvent.packageId));
    if (String(retEvent.actorUid) !== riderId && String(retEvent.riderId || "") !== riderId) continue;
    pushEvent({
      id: String(retEvent.id),
      riderId,
      timestamp: retEvent.timestamp || retEvent.createdAt || "",
      label: String(retEvent.eventStage || "Return Event").replace(/_/g, " "),
      detail: resolvePackageNumberOrId(pkg, retEvent.packageId),
      packageId: String(retEvent.packageId),
      packageNumber: pkg?.packageNumber || String(retEvent.packageId),
      source: "returnCustodyEvents"
    });
  }

  for (const settlement of dataset.riderSettlements.filter((settlement) => String(settlement.riderId || "") === riderId)) {
    if (settlement.submittedAt) {
      pushEvent({
        id: `${settlement.id}_submitted`,
        riderId,
        timestamp: settlement.submittedAt,
        label: "Settlement submitted",
        detail: `${toAmount(settlement.declaredCashAmount).toLocaleString()} declared`,
        amount: toAmount(settlement.declaredCashAmount),
        source: "riderSettlements"
      });
    }
    if (settlement.receivedAt) {
      pushEvent({
        id: `${settlement.id}_received`,
        riderId,
        timestamp: settlement.receivedAt,
        label: "Cashier received",
        detail: `${toAmount(settlement.physicallyReceivedAmount).toLocaleString()} received`,
        amount: toAmount(settlement.physicallyReceivedAmount),
        source: "riderSettlements"
      });
    }
  }

  return sortByTimestamp(events, (event) => event.timestamp).reverse();
}

function deriveShiftStatus(dataset: LoadedAnalyticsDataset, riderId: string, riderPackages: any[], returnsPending: number, cashOutstanding: number) {
  const runs = dataset.dispatchRuns.filter((run) => String(run.riderId || "") === riderId);
  const latestRun = sortByTimestamp(runs, (run) => run.updatedAt || run.startTimestamp || run.createdAt).reverse()[0];
  const hasActiveRoutePackages = riderPackages.some((pkg) => ["ASSIGNED", "DISPATCHER_SCANNED", "RIDER_SCANNED", "RIDER_ACCEPTED", "OUT_FOR_DELIVERY"].includes(resolvePackageStatus(pkg)));
  const hasDiscrepancy = dataset.riderSettlements.some((settlement) => String(settlement.riderId || "") === riderId && ["discrepancy", "manager_approved"].includes(String(settlement.status || "")));

  if (!latestRun) return "NOT STARTED";
  if (hasDiscrepancy) return "DISCREPANCY";
  if (hasActiveRoutePackages) return "ACTIVE";
  if (returnsPending > 0) return "RETURN PENDING";
  if (cashOutstanding > 0) return "CASH PENDING";
  if (latestRun.endTimestamp || latestRun.completedAt || String(latestRun.status || "").toLowerCase() === "completed") return "CLOSED";
  return "ROUTE COMPLETE";
}

function resolvePackageNumberOrId(pkg: any, packageId: string) {
  return pkg?.packageNumber || String(packageId);
}
