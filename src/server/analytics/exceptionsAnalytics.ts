import { ExceptionSummaryRow, LoadedAnalyticsDataset, ManagementFilters } from "./analyticsTypes.js";
import { buildIndexes, getRangeForFilters, packageMatchesFilters, resolvePackageStatus, toAmount } from "./shared.js";

export function buildExceptionsAnalytics(dataset: LoadedAnalyticsDataset, filters: ManagementFilters) {
  const range = getRangeForFilters(filters);
  const indexes = buildIndexes(dataset);

  const openExceptions: ExceptionSummaryRow[] = dataset.exceptions
    .filter((exception) => String(exception.status || "").toUpperCase() !== "RESOLVED")
    .filter((exception) => {
      const pkg = exception.packageId ? indexes.packagesById.get(String(exception.packageId)) : null;
      return pkg ? packageMatchesFilters(pkg, filters) : (!filters.city && !filters.zone && !filters.riderId);
    })
    .map((exception) => ({
      id: exception.id,
      severity: String(exception.severity || "MEDIUM").toUpperCase() as ExceptionSummaryRow["severity"],
      status: String(exception.status || "OPEN"),
      title: exception.exceptionType || "EXCEPTION",
      detail: exception.details || "",
      packageId: exception.packageId || null,
      riderId: exception.riderId || null,
      createdAt: exception.createdAt || "",
      source: "exceptions"
    }));

  const critical = openExceptions.filter((exception) => exception.severity === "CRITICAL").length;
  const high = openExceptions.filter((exception) => exception.severity === "HIGH").length;
  const medium = openExceptions.filter((exception) => exception.severity === "MEDIUM").length;

  const liveAlerts: Array<{ key: string; label: string; count: number; source: string; drilldownKey: string }> = [];
  const unsettledCashRiders = dataset.riderSettlements
    .filter((settlement) => ["rider_submitted", "discrepancy"].includes(String(settlement.status || "")))
    .filter((settlement) => !filters.riderId || String(settlement.riderId) === filters.riderId);
  liveAlerts.push({
    key: "unsettledCashRiders",
    label: `${new Set(unsettledCashRiders.map((settlement) => String(settlement.riderId))).size} riders have unsettled cash`,
    count: new Set(unsettledCashRiders.map((settlement) => String(settlement.riderId))).size,
    source: "riderSettlements open statuses",
    drilldownKey: "alerts.unsettledCashRiders"
  });

  const returnsMissingWarehouse = dataset.returns
    .filter((ret) => ["rider_handed_back", "returning_to_warehouse"].includes(String(ret.returnStatus || "").toLowerCase()))
    .filter((ret) => packageMatchesFilters(indexes.packagesById.get(String(ret.packageId)), filters));
  liveAlerts.push({
    key: "returnsMissingWarehouse",
    label: `${returnsMissingWarehouse.length} returns have not reached warehouse`,
    count: returnsMissingWarehouse.length,
    source: "returns still pending warehouse receipt",
    drilldownKey: "alerts.returnsMissingWarehouse"
  });

  const readyOver24h = dataset.packages
    .filter((pkg) => packageMatchesFilters(pkg, filters))
    .filter((pkg) => resolvePackageStatus(pkg) === "READY_FOR_DISPATCH")
    .filter((pkg) => {
      const ts = Date.parse(pkg.updatedAt || pkg.createdAt || "");
      return Number.isFinite(ts) && (Date.now() - ts) > 24 * 60 * 60 * 1000;
    });
  liveAlerts.push({
    key: "readyOver24h",
    label: `${readyOver24h.length} packages have been READY_FOR_DISPATCH >24h`,
    count: readyOver24h.length,
    source: "packages READY_FOR_DISPATCH aged by updatedAt/createdAt",
    drilldownKey: "alerts.readyOver24h"
  });

  const overdueReattempts = dataset.reattemptRequests
    .filter((request) => request.newPromisedDeliveryDate && request.newPromisedDeliveryDate < range.toDate && !["approved", "dispatched", "rejected"].includes(String(request.status)))
    .filter((request) => packageMatchesFilters(indexes.packagesById.get(String(request.packageId)), filters));
  liveAlerts.push({
    key: "overdueReattempts",
    label: `${overdueReattempts.length} customer reattempts overdue`,
    count: overdueReattempts.length,
    source: "reattemptRequests overdue promised date",
    drilldownKey: "alerts.overdueReattempts"
  });

  const cancelledWithRiders = dataset.packages
    .filter((pkg) => packageMatchesFilters(pkg, filters))
    .filter((pkg) => resolvePackageStatus(pkg) === "CANCELLED" && pkg.assignedRiderId);
  liveAlerts.push({
    key: "cancelledWithRiders",
    label: `${cancelledWithRiders.length} cancellations currently with riders`,
    count: cancelledWithRiders.length,
    source: "cancelled packages still carrying assignedRiderId",
    drilldownKey: "alerts.cancelledWithRiders"
  });

  const openCollectionVariances = dataset.codCollectionDiscrepancies
    .filter((discrepancy) => String(discrepancy.status || "").toUpperCase() === "OPEN")
    .filter((discrepancy) => packageMatchesFilters(indexes.packagesById.get(String(discrepancy.packageId)), filters));
  liveAlerts.push({
    key: "openCollectionVariances",
    label: `${openCollectionVariances.length} COD collection variances need approval`,
    count: openCollectionVariances.length,
    source: "codCollectionDiscrepancies.status = OPEN",
    drilldownKey: "finance.openCollectionVariance"
  });

  const digitalPending = dataset.digitalPaymentVerifications
    .filter((verification) => String(verification.status || "").toLowerCase() === "pending")
    .filter((verification) => packageMatchesFilters(indexes.packagesById.get(String(verification.packageId)), filters));
  liveAlerts.push({
    key: "digitalPending",
    label: `${digitalPending.length} digital COD payments await verification`,
    count: digitalPending.length,
    source: "digitalPaymentVerifications.status = pending",
    drilldownKey: "finance.digitalVerificationPending"
  });

  return {
    counts: { critical, high, medium },
    openExceptions,
    liveAlerts: liveAlerts.filter((alert) => alert.count > 0)
  };
}
