import {
  AgingBucket,
  FunnelStage,
  LoadedAnalyticsDataset,
  ManagementFilters,
  ManagementMetric
} from "./analyticsTypes.js";
import {
  buildIndexes,
  getAttemptTimestamp,
  getFailureReason,
  getHoursFromNow,
  getRangeForFilters,
  isIsoInRange,
  makeMetric,
  packageMatchesFilters,
  resolvePackageCod,
  resolvePackageNumber,
  resolvePackageStatus,
  sortByTimestamp,
  unique
} from "./shared.js";

const ACTIVE_WITH_RIDER_STATUSES = new Set([
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

function buildAgingBuckets(items: any[], getTimestamp: (item: any) => string | null | undefined, prefix: string): AgingBucket[] {
  const definitions = [
    { key: "0_12", label: "0–12h", minHours: 0, maxHours: 12, status: "normal" as const },
    { key: "12_24", label: "12–24h", minHours: 12, maxHours: 24, status: "normal" as const },
    { key: "24_48", label: "24–48h", minHours: 24, maxHours: 48, status: "warning" as const },
    { key: "48_72", label: "48–72h", minHours: 48, maxHours: 72, status: "critical" as const },
    { key: "72_plus", label: "72h+", minHours: 72, maxHours: null, status: "critical" as const }
  ];

  return definitions.map((definition) => {
    const count = items.filter((item) => {
      const hours = getHoursFromNow(getTimestamp(item));
      if (hours === null) return false;
      if (definition.maxHours === null) return hours >= definition.minHours;
      return hours >= definition.minHours && hours < definition.maxHours;
    }).length;

    return {
      ...definition,
      count,
      drilldownKey: `${prefix}.${definition.key}`
    };
  });
}

export function buildOperationsAnalytics(dataset: LoadedAnalyticsDataset, filters: ManagementFilters) {
  const range = getRangeForFilters(filters);
  const indexes = buildIndexes(dataset);
  const packages = dataset.packages.filter((pkg) => packageMatchesFilters(pkg, filters));
  const attempts = dataset.deliveryAttempts.filter((attempt) => {
    const pkg = indexes.packagesById.get(String(attempt.packageId));
    return pkg && packageMatchesFilters(pkg, filters);
  });
  const attemptsToday = attempts.filter((attempt) => isIsoInRange(getAttemptTimestamp(attempt), range));
  const deliveredAttemptsToday = attemptsToday.filter((attempt) => String(attempt.status).toUpperCase() === "DELIVERED");
  const failedAttemptsToday = attemptsToday.filter((attempt) => String(attempt.status).toUpperCase() !== "DELIVERED");
  const returnReceiptsToday = dataset.returnReceipts.filter((receipt) => isIsoInRange(receipt.receivedAt || receipt.createdAt, range) && packageMatchesFilters(indexes.packagesById.get(String(receipt.packageId)), filters));

  const readyPackages = packages.filter((pkg) => resolvePackageStatus(pkg) === "READY_FOR_DISPATCH");
  const assignedPackages = packages.filter((pkg) => ["ASSIGNED", "DISPATCHER_SCANNED", "RIDER_SCANNED", "RIDER_ACCEPTED"].includes(resolvePackageStatus(pkg)));
  const outForDeliveryPackages = packages.filter((pkg) => resolvePackageStatus(pkg) === "OUT_FOR_DELIVERY");
  const stillWithRidersPackages = packages.filter((pkg) => pkg.assignedRiderId && ACTIVE_WITH_RIDER_STATUSES.has(resolvePackageStatus(pkg)));

  const topStats: ManagementMetric[] = [
    makeMetric({
      key: "ordersEntered",
      label: "Orders Entered",
      value: packages.filter((pkg) => isIsoInRange(pkg.createdAt, range)).length,
      source: "packages.createdAt within Asia/Karachi day",
      formula: "Count of packages with createdAt inside the selected Karachi date range.",
      drilldownKey: "overview.ordersEntered"
    }),
    makeMetric({
      key: "readyForDispatch",
      label: "Ready for Dispatch",
      value: readyPackages.length,
      source: "current packages where operationalStatus = READY_FOR_DISPATCH",
      formula: "Current open packages in READY_FOR_DISPATCH under the active filter context.",
      drilldownKey: "overview.readyForDispatch",
      status: readyPackages.length > 0 ? "warning" : "normal"
    }),
    makeMetric({
      key: "assigned",
      label: "Assigned",
      value: assignedPackages.length,
      source: "current packages in assigned / custody-pre-delivery states",
      formula: "Current packages in ASSIGNED, DISPATCHER_SCANNED, RIDER_SCANNED, or RIDER_ACCEPTED.",
      drilldownKey: "overview.assigned"
    }),
    makeMetric({
      key: "outForDelivery",
      label: "Out for Delivery",
      value: outForDeliveryPackages.length,
      source: "current packages where operationalStatus = OUT_FOR_DELIVERY",
      formula: "Current packages actively out for delivery.",
      drilldownKey: "overview.outForDelivery"
    }),
    makeMetric({
      key: "deliveredToday",
      label: "Delivered",
      value: unique(deliveredAttemptsToday.map((attempt) => String(attempt.packageId))).length,
      source: "deliveryAttempts.status = DELIVERED in selected Karachi range",
      formula: "Unique packages with a DELIVERED delivery attempt in the selected range.",
      drilldownKey: "overview.deliveredToday"
    }),
    makeMetric({
      key: "failedAttemptsToday",
      label: "Failed Attempts",
      value: failedAttemptsToday.length,
      source: "non-delivered deliveryAttempts in selected Karachi range",
      formula: "Count of deliveryAttempts whose status is not DELIVERED in the selected range.",
      drilldownKey: "overview.failedAttemptsToday"
    }),
    makeMetric({
      key: "returnsReceived",
      label: "Returns Received",
      value: returnReceiptsToday.length,
      source: "returnReceipts.receivedAt in selected Karachi range",
      formula: "Count of warehouse return receipts recorded in the selected range.",
      drilldownKey: "overview.returnsReceived"
    }),
    makeMetric({
      key: "stillWithRiders",
      label: "Still With Riders",
      value: stillWithRidersPackages.length,
      source: "current packages assigned to a rider and not terminal",
      formula: "Current assigned packages in active rider custody states.",
      drilldownKey: "overview.stillWithRiders",
      status: stillWithRidersPackages.length > 0 ? "warning" : "normal"
    })
  ];

  const sortedAttempts = sortByTimestamp(attempts, getAttemptTimestamp);
  const attemptNumberById = new Map<string, number>();
  const attemptsByPackage = new Map<string, any[]>();
  for (const attempt of sortedAttempts) {
    const packageId = String(attempt.packageId);
    const current = attemptsByPackage.get(packageId) || [];
    current.push(attempt);
    attemptsByPackage.set(packageId, current);
    attemptNumberById.set(String(attempt.id), Number(attempt.attemptNumber || current.length));
  }

  const attemptedPackagesToday = unique(attemptsToday.map((attempt) => String(attempt.packageId)));
  const deliveredPackageIdsToday = unique(deliveredAttemptsToday.map((attempt) => String(attempt.packageId)));
  const deliveredOnFirstAttemptCount = deliveredAttemptsToday.filter((attempt) => attemptNumberById.get(String(attempt.id)) === 1).length;
  const deliveredAfterReattemptCount = deliveredAttemptsToday.filter((attempt) => (attemptNumberById.get(String(attempt.id)) || 0) > 1).length;
  const deliveredAttemptCounts = deliveredPackageIdsToday.map((packageId) => (attemptsByPackage.get(packageId) || []).length);
  const deliveryPerformance: ManagementMetric[] = [
    makeMetric({
      key: "deliverySuccessRate",
      label: "Delivery Success %",
      value: attemptedPackagesToday.length > 0 ? (deliveredPackageIdsToday.length / attemptedPackagesToday.length) * 100 : null,
      unit: "percent",
      source: "unique packages delivered / unique packages with at least one delivery attempt in range",
      formula: "Delivered packages in range / packages with at least one delivery attempt in range.",
      drilldownKey: "performance.deliverySuccessRate"
    }),
    makeMetric({
      key: "firstAttemptSuccessRate",
      label: "First Attempt Success %",
      value: attemptedPackagesToday.length > 0 ? (deliveredOnFirstAttemptCount / attemptedPackagesToday.length) * 100 : null,
      unit: "percent",
      source: "deliveryAttempts chronological sequence",
      formula: "Packages delivered on attempt #1 / packages with at least one completed delivery attempt.",
      drilldownKey: "performance.firstAttemptSuccessRate"
    }),
    makeMetric({
      key: "averageAttemptsPerDeliveredPackage",
      label: "Average Attempts per Delivered Package",
      value: deliveredAttemptCounts.length > 0 ? deliveredAttemptCounts.reduce((sum, count) => sum + count, 0) / deliveredAttemptCounts.length : null,
      source: "deliveryAttempts grouped by delivered package",
      formula: "Total attempts across delivered packages / delivered package count.",
      drilldownKey: "performance.averageAttemptsPerDeliveredPackage"
    }),
    makeMetric({
      key: "reattemptRate",
      label: "Reattempt Rate",
      value: deliveredPackageIdsToday.length > 0 ? (deliveredAfterReattemptCount / deliveredPackageIdsToday.length) * 100 : null,
      unit: "percent",
      source: "delivered packages with attemptNumber > 1",
      formula: "Delivered packages requiring attempt #2+ / delivered packages.",
      drilldownKey: "performance.reattemptRate"
    }),
    makeMetric({
      key: "refusalRate",
      label: "Refusal Rate",
      value: attemptsToday.length > 0 ? (attemptsToday.filter((attempt) => normalizeAttemptOutcome(attempt) === "REFUSED").length / attemptsToday.length) * 100 : null,
      unit: "percent",
      source: "deliveryAttempts.status = REFUSED",
      formula: "REFUSED attempts / total delivery attempts in range.",
      drilldownKey: "performance.refusalRate"
    }),
    makeMetric({
      key: "customerUnavailableRate",
      label: "Customer Unavailable Rate",
      value: attemptsToday.length > 0 ? (attemptsToday.filter((attempt) => normalizeAttemptOutcome(attempt) === "CUSTOMER_UNAVAILABLE").length / attemptsToday.length) * 100 : null,
      unit: "percent",
      source: "deliveryAttempts.status = CUSTOMER_UNAVAILABLE",
      formula: "CUSTOMER_UNAVAILABLE attempts / total delivery attempts in range.",
      drilldownKey: "performance.customerUnavailableRate"
    }),
    makeMetric({
      key: "addressIssueRate",
      label: "Address Issue Rate",
      value: attemptsToday.length > 0 ? (attemptsToday.filter((attempt) => normalizeAttemptOutcome(attempt) === "ADDRESS_ISSUE").length / attemptsToday.length) * 100 : null,
      unit: "percent",
      source: "deliveryAttempts.status = ADDRESS_ISSUE",
      formula: "ADDRESS_ISSUE attempts / total delivery attempts in range.",
      drilldownKey: "performance.addressIssueRate"
    }),
    makeMetric({
      key: "returnRate",
      label: "Return Rate",
      value: attemptedPackagesToday.length > 0 ? (unique(dataset.returns.filter((ret) => isIsoInRange(ret.createdAt || ret.updatedAt, range) && packageMatchesFilters(indexes.packagesById.get(String(ret.packageId)), filters)).map((ret) => String(ret.packageId))).length / attemptedPackagesToday.length) * 100 : null,
      unit: "percent",
      source: "returns.createdAt within selected Karachi range",
      formula: "Unique packages with a return record in range / packages with at least one delivery attempt in range.",
      drilldownKey: "performance.returnRate"
    })
  ];

  const assignmentByPackage = new Map<string, any>();
  for (const assignment of dataset.assignments) {
    const packageId = String(assignment.packageId || assignment.id);
    if (!assignmentByPackage.has(packageId) || Date.parse(assignment.assignedAt || "") > Date.parse(assignmentByPackage.get(packageId)?.assignedAt || "")) {
      assignmentByPackage.set(packageId, assignment);
    }
  }

  const readyAging = buildAgingBuckets(readyPackages, (pkg) => pkg.updatedAt || pkg.createdAt, "aging.readyForDispatch");
  const assignedAging = buildAgingBuckets(assignedPackages, (pkg) => assignmentByPackage.get(String(pkg.id || pkg.packageId))?.assignedAt || pkg.updatedAt || pkg.createdAt, "aging.assignedNotOutForDelivery");
  const withRiderAging = buildAgingBuckets(stillWithRidersPackages, (pkg) => assignmentByPackage.get(String(pkg.id || pkg.packageId))?.assignedAt || pkg.updatedAt || pkg.createdAt, "aging.withRider");

  const runsInRange = dataset.dispatchRuns.filter((run) => isIsoInRange(run.startTimestamp || run.acceptedAt || run.updatedAt || run.createdAt, range) && (!filters.riderId || String(run.riderId) === filters.riderId));
  const funnelBase = packages.filter((pkg) => isIsoInRange(pkg.createdAt, range)).length;
  const riderAcceptedIds = unique([
    ...dataset.custodyScans
      .filter((scan) => String(scan.scanStage || "").toLowerCase() === "rider_accepted" && isIsoInRange(scan.scannedAt, range))
      .map((scan) => String(scan.packageId)),
    ...runsInRange.flatMap((run) => Array.isArray(run.expectedPackages) ? run.expectedPackages.map((value: any) => String(value)) : [])
  ]).filter((packageId) => {
    const pkg = indexes.packagesById.get(packageId);
    return pkg && packageMatchesFilters(pkg, filters);
  });

  const outForDeliveryIds = unique([
    ...packages.filter((pkg) => isIsoInRange(pkg.updatedAt, range) && resolvePackageStatus(pkg) === "OUT_FOR_DELIVERY").map((pkg) => String(pkg.id || pkg.packageId)),
    ...runsInRange.flatMap((run) => Array.isArray(run.expectedPackages) ? run.expectedPackages.map((value: any) => String(value)) : [])
  ]).filter((packageId) => {
    const pkg = indexes.packagesById.get(packageId);
    return pkg && packageMatchesFilters(pkg, filters);
  });

  const funnel: FunnelStage[] = [
    buildStage("readyForDispatch", "Ready for Dispatch", packages.filter((pkg) => isIsoInRange(pkg.createdAt, range)).length, funnelBase, "packages.createdAt in range", "funnel.readyForDispatch"),
    buildStage("assigned", "Assigned", dataset.assignments.filter((assignment) => isIsoInRange(assignment.assignedAt, range) && packageMatchesFilters(indexes.packagesById.get(String(assignment.packageId || assignment.id)), filters)).length, funnelBase, "assignments.assignedAt in range", "funnel.assigned"),
    buildStage("riderAccepted", "Rider Accepted", riderAcceptedIds.length, funnelBase, "custodyScans.rider_accepted or dispatchRuns accepted in range", "funnel.riderAccepted"),
    buildStage("outForDelivery", "Out for Delivery", outForDeliveryIds.length, funnelBase, "dispatchRuns startTimestamp / package updatedAt", "funnel.outForDelivery"),
    buildStage("attempted", "Attempted", attemptedPackagesToday.length, funnelBase, "unique packages with deliveryAttempts in range", "funnel.attempted"),
    buildStage("delivered", "Delivered", deliveredPackageIdsToday.length, funnelBase, "unique DELIVERED attempts in range", "funnel.delivered"),
    buildStage("customerUnavailable", "Unavailable", attemptsToday.filter((attempt) => normalizeAttemptOutcome(attempt) === "CUSTOMER_UNAVAILABLE").length, funnelBase, "deliveryAttempts.status = CUSTOMER_UNAVAILABLE", "funnel.customerUnavailable"),
    buildStage("refused", "Refused", attemptsToday.filter((attempt) => normalizeAttemptOutcome(attempt) === "REFUSED").length, funnelBase, "deliveryAttempts.status = REFUSED", "funnel.refused"),
    buildStage("rescheduled", "Rescheduled", attemptsToday.filter((attempt) => normalizeAttemptOutcome(attempt) === "RESCHEDULED").length, funnelBase, "deliveryAttempts.status = RESCHEDULED", "funnel.rescheduled"),
    buildStage("addressIssue", "Address Issue", attemptsToday.filter((attempt) => normalizeAttemptOutcome(attempt) === "ADDRESS_ISSUE").length, funnelBase, "deliveryAttempts.status = ADDRESS_ISSUE", "funnel.addressIssue"),
    buildStage("cancelled", "Cancelled", attemptsToday.filter((attempt) => normalizeAttemptOutcome(attempt) === "CUSTOMER_CANCELLED").length, funnelBase, "deliveryAttempts.status = CUSTOMER_CANCELLED", "funnel.cancelled"),
    buildStage("returnRequired", "Return Required", dataset.returns.filter((ret) => isIsoInRange(ret.createdAt || ret.updatedAt, range) && packageMatchesFilters(indexes.packagesById.get(String(ret.packageId)), filters)).length, funnelBase, "returns created in range", "funnel.returnRequired")
  ];

  const topFailureReasonCounts = new Map<string, number>();
  for (const attempt of failedAttemptsToday) {
    const reason = getFailureReason(attempt) || "UNKNOWN";
    topFailureReasonCounts.set(reason, (topFailureReasonCounts.get(reason) || 0) + 1);
  }
  const topFailureReasons = Array.from(topFailureReasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({
      reason,
      count,
      percentage: failedAttemptsToday.length > 0 ? (count / failedAttemptsToday.length) * 100 : null,
      drilldownKey: `reasons.${reason}`
    }));

  const reattemptRequests = dataset.reattemptRequests.filter((request) => packageMatchesFilters(indexes.packagesById.get(String(request.packageId)), filters));
  const reattemptDashboard = {
    dueToday: reattemptRequests.filter((request) => request.newPromisedDeliveryDate === range.toDate && request.status !== "rejected").length,
    overdue: reattemptRequests.filter((request) => request.newPromisedDeliveryDate && request.newPromisedDeliveryDate < range.toDate && !["dispatched", "approved", "rejected"].includes(String(request.status))).length,
    customerRequestedTime: reattemptRequests.filter((request) => String(request.customerConfirmationStatus || "").toLowerCase().includes("confirmed")).length,
    finalAttempt: reattemptRequests.filter((request) => Number(request.attemptNumber || 0) >= 3).length,
    csEscalationRequired: dataset.customerServiceCases.filter((csCase) => packageMatchesFilters(indexes.packagesById.get(String(csCase.packageId)), filters) && ["open", "contacting", "waiting_customer"].includes(String(csCase.status))).length
  };

  const intakeHealth = {
    ordersReceivedToday: packages.filter((pkg) => isIsoInRange(pkg.createdAt, range)).length,
    ordersReady: readyPackages.length,
    ordersOnHold: packages.filter((pkg) => resolvePackageStatus(pkg) === "IMPORTED_REVIEW").length,
    addressReview: packages.filter((pkg) => resolvePackageStatus(pkg) === "ADDRESS_ISSUE").length,
    paymentReview: null as number | null,
    cancelled: packages.filter((pkg) => resolvePackageStatus(pkg) === "CANCELLED").length,
    syncErrors: dataset.exceptions.filter((exception) => String(exception.id || "").includes("shopify") && String(exception.status || "").toUpperCase() !== "RESOLVED").length || null,
    lastSuccessfulInboundEvent: dataset.importBatches
      .filter((batch) => String(batch.status || "").toLowerCase() === "committed" || String(batch.status || "").toLowerCase() === "completed")
      .sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""))[0]?.createdAt || null,
    pendingRetryEvents: null as number | null,
    deadLetterFailures: null as number | null
  };

  return {
    range,
    topStats,
    deliveryPerformance,
    aging: {
      readyForDispatch: readyAging,
      assignedNotOutForDelivery: assignedAging,
      withRider: withRiderAging
    },
    funnel,
    topFailureReasons,
    reattemptDashboard,
    intakeHealth,
    supportingData: {
      packageCount: packages.length,
      deliveredPackageIdsToday,
      failedAttemptCount: failedAttemptsToday.length,
      returnReceiptCount: returnReceiptsToday.length
    }
  };
}

function normalizeAttemptOutcome(attempt: any) {
  return String(attempt.status || "").toUpperCase().replace(/[\s-]+/g, "_");
}

function buildStage(key: string, label: string, count: number, base: number, source: string, drilldownKey: string): FunnelStage {
  return {
    key,
    label,
    count,
    percentageOfBase: base > 0 ? (count / base) * 100 : null,
    source,
    drilldownKey
  };
}
