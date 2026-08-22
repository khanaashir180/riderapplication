import { LoadedAnalyticsDataset, ManagementFilters, ManagementMetric } from "./analyticsTypes.js";
import {
  buildIndexes,
  getHoursFromNow,
  getRangeForFilters,
  isIsoInRange,
  makeMetric,
  packageMatchesFilters,
  resolvePackageStatus
} from "./shared.js";

export function buildReturnsAnalytics(dataset: LoadedAnalyticsDataset, filters: ManagementFilters) {
  const range = getRangeForFilters(filters);
  const indexes = buildIndexes(dataset);
  const returns = dataset.returns.filter((ret) => packageMatchesFilters(indexes.packagesById.get(String(ret.packageId)), filters));
  const receipts = dataset.returnReceipts.filter((receipt) => packageMatchesFilters(indexes.packagesById.get(String(receipt.packageId)), filters));

  const returnRequired = returns.filter((ret) => ["return_required", "rider_handed_back", "warehouse_received"].includes(String(ret.returnStatus || ret.status || "").toLowerCase()));
  const riderReturning = returns.filter((ret) => String(ret.returnStatus || ret.status || "").toLowerCase() === "rider_handed_back");
  const warehouseReceived = returns.filter((ret) => String(ret.returnStatus || ret.status || "").toLowerCase() === "warehouse_received");
  const awaitingResolution = warehouseReceived.filter((ret) => {
    const pkg = indexes.packagesById.get(String(ret.packageId));
    const pkgStatus = resolvePackageStatus(pkg);
    return pkgStatus !== "CLOSED";
  });
  const closedToday = dataset.packages.filter((pkg) => packageMatchesFilters(pkg, filters) && resolvePackageStatus(pkg) === "CLOSED" && isIsoInRange(pkg.updatedAt, range));

  const pendingWarehouseReceipt = returns.filter((ret) => {
    const status = String(ret.returnStatus || ret.status || "").toLowerCase();
    return status === "rider_handed_back" || status === "returning_to_warehouse";
  });

  const aging = [
    buildAgingRow("gt2h", "Return pending >2h", pendingWarehouseReceipt, 2),
    buildAgingRow("gt6h", "Return pending >6h", pendingWarehouseReceipt, 6),
    buildAgingRow("gt12h", "Return pending >12h", pendingWarehouseReceipt, 12),
    buildAgingRow("gt24h", "Return pending >24h", pendingWarehouseReceipt, 24)
  ];

  const discrepancies = {
    riderHandedBackWarehouseMissing: pendingWarehouseReceipt
      .filter((ret) => String(ret.returnStatus || "").toLowerCase() === "rider_handed_back")
      .map((ret) => buildReturnRow(ret, indexes.packagesById)),
    warehouseConditionDiscrepancy: receipts
      .filter((receipt) => ["damaged", "missing_item", "wrong_item"].includes(String(receipt.packageCondition || "").toLowerCase()))
      .map((receipt) => ({
        key: receipt.id,
        packageId: receipt.packageId,
        packageNumber: indexes.packagesById.get(String(receipt.packageId))?.packageNumber || receipt.packageId,
        condition: receipt.packageCondition,
        notes: receipt.conditionNotes,
        receivedAt: receipt.receivedAt || receipt.createdAt
      })),
    returnNotClosed: awaitingResolution.map((ret) => buildReturnRow(ret, indexes.packagesById))
  };

  const summary: ManagementMetric[] = [
    makeMetric({
      key: "returnRequired",
      label: "Return Required",
      value: returnRequired.length,
      source: "returns where returnStatus is active",
      formula: "Return records currently in reverse-logistics lifecycle.",
      drilldownKey: "returns.returnRequired"
    }),
    makeMetric({
      key: "riderReturning",
      label: "Rider Returning",
      value: riderReturning.length,
      source: "returns.returnStatus = rider_handed_back",
      formula: "Returns handed back by rider and still pending warehouse completion.",
      drilldownKey: "returns.riderReturning"
    }),
    makeMetric({
      key: "riderHandback",
      label: "Rider Handback",
      value: dataset.returnCustodyEvents.filter((event) => event.eventStage === "rider_handed_back" && isIsoInRange(event.timestamp, range) && packageMatchesFilters(indexes.packagesById.get(String(event.packageId)), filters)).length,
      source: "returnCustodyEvents.eventStage = rider_handed_back in range",
      formula: "Count of rider handback custody events in the selected range.",
      drilldownKey: "returns.riderHandback"
    }),
    makeMetric({
      key: "warehouseReceived",
      label: "Warehouse Received",
      value: warehouseReceived.length,
      source: "returns.returnStatus = warehouse_received",
      formula: "Return records currently marked warehouse_received.",
      drilldownKey: "returns.warehouseReceived"
    }),
    makeMetric({
      key: "awaitingResolution",
      label: "Awaiting Resolution",
      value: awaitingResolution.length,
      source: "warehouse_received returns whose package is not CLOSED",
      formula: "Warehouse received returns still open in customer-service / resolution workflow.",
      drilldownKey: "returns.awaitingResolution"
    }),
    makeMetric({
      key: "closedToday",
      label: "Closed Today",
      value: closedToday.length,
      source: "packages updated to CLOSED in selected range",
      formula: "Packages whose current status is CLOSED and updatedAt is in the selected range.",
      drilldownKey: "returns.closedToday"
    })
  ];

  return {
    range,
    summary,
    aging,
    discrepancies
  };
}

function buildAgingRow(key: string, label: string, rows: any[], threshold: number) {
  const matching = rows.filter((row) => {
    const hours = getHoursFromNow(row.riderHandedBackAt || row.updatedAt || row.createdAt);
    return hours !== null && hours > threshold;
  });
  return {
    key,
    label,
    count: matching.length,
    drilldownKey: `returnsAging.${key}`
  };
}

function buildReturnRow(ret: any, packagesById: Map<string, any>) {
  const pkg = packagesById.get(String(ret.packageId));
  return {
    key: ret.id,
    packageId: ret.packageId,
    packageNumber: pkg?.packageNumber || ret.packageId,
    riderId: ret.riderId,
    returnStatus: ret.returnStatus || ret.status,
    returnReason: ret.returnReason,
    updatedAt: ret.updatedAt || ret.createdAt
  };
}
