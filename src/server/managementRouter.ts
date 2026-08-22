import { Router } from "express";
import { buildActivityAnalytics } from "./analytics/activityAnalytics.js";
import { buildExceptionsAnalytics } from "./analytics/exceptionsAnalytics.js";
import { buildFinanceAnalytics } from "./analytics/financeAnalytics.js";
import { buildOperationsAnalytics } from "./analytics/operationsAnalytics.js";
import { buildReturnsAnalytics } from "./analytics/returnsAnalytics.js";
import { buildRiderAnalytics } from "./analytics/riderAnalytics.js";
import { DrilldownResponse } from "./analytics/analyticsTypes.js";
import { buildIndexes, formatCurrency, getRangeForFilters, loadAnalyticsDataset, parseManagementFilters, packageMatchesFilters, recordMatchesFilters, resolvePackageNumber, resolvePackageStatus } from "./analytics/shared.js";

export function createManagementRouter(db: FirebaseFirestore.Firestore, requireAuth: any, requireRole: any) {
  const router = Router();
  const fullDashboard = requireRole("super_admin", "management_viewer");
  const operationsReadOnly = requireRole("super_admin", "dispatch_manager", "management_viewer");
  const financeReadOnly = requireRole("super_admin", "cashier", "management_viewer");
  const returnsReadOnly = requireRole("super_admin", "dispatch_manager", "customer_service", "warehouse_staff", "management_viewer");

  router.get("/overview", requireAuth, fullDashboard, async (req: any, res: any) => {
    try {
      const filters = parseManagementFilters(req.query);
      const dataset = await loadAnalyticsDataset(db, filters);
      const operations = buildOperationsAnalytics(dataset, filters);
      const finance = buildFinanceAnalytics(dataset, filters);
      const returns = buildReturnsAnalytics(dataset, filters);
      const exceptions = buildExceptionsAnalytics(dataset, filters);
      const activity = buildActivityAnalytics(dataset, filters);

      return res.json({
        success: true,
        data: {
          filters,
          range: operations.range,
          generatedAt: new Date().toISOString(),
          freshness: { lastRefreshedAt: new Date().toISOString() },
          topStats: operations.topStats,
          deliveryPerformance: operations.deliveryPerformance,
          aging: operations.aging,
          funnel: operations.funnel,
          topFailureReasons: operations.topFailureReasons,
          reattemptDashboard: operations.reattemptDashboard,
          intakeHealth: operations.intakeHealth,
          exceptionSummary: exceptions.counts,
          liveAlerts: exceptions.liveAlerts,
          financeHighlights: finance.summary,
          returnHighlights: returns.summary,
          activityHighlights: activity.summary,
          dailySnapshot: {
            date: operations.range.fromDate,
            ordersEntered: valueByKey(operations.topStats, "ordersEntered"),
            readyForDispatch: valueByKey(operations.topStats, "readyForDispatch"),
            assigned: valueByKey(operations.topStats, "assigned"),
            outForDelivery: valueByKey(operations.topStats, "outForDelivery"),
            delivered: valueByKey(operations.topStats, "deliveredToday"),
            failed: valueByKey(operations.topStats, "failedAttemptsToday"),
            returned: valueByKey(returns.summary, "warehouseReceived"),
            firstAttemptSuccess: valueByKey(operations.deliveryPerformance, "firstAttemptSuccessRate"),
            codExpected: valueByKey(finance.summary, "codExpected"),
            codCollected: valueByKey(finance.summary, "codCollected"),
            cashReceived: valueByKey(finance.summary, "cashierReceived"),
            cashOutstanding: valueByKey(finance.summary, "cashWithRiders"),
            shortage: valueByKey(finance.summary, "openShortage"),
            excess: valueByKey(finance.summary, "openExcess"),
            openExceptions: exceptions.openExceptions.length,
            closedExceptions: 0
          }
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  router.get("/riders", requireAuth, operationsReadOnly, async (req: any, res: any) => {
    try {
      const filters = parseManagementFilters(req.query);
      const dataset = await loadAnalyticsDataset(db, filters);
      const riders = buildRiderAnalytics(dataset, filters);
      return res.json({ success: true, data: riders });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  router.get("/finance", requireAuth, financeReadOnly, async (req: any, res: any) => {
    try {
      const filters = parseManagementFilters(req.query);
      const dataset = await loadAnalyticsDataset(db, filters);
      const finance = buildFinanceAnalytics(dataset, filters);
      return res.json({ success: true, data: finance });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  router.get("/returns", requireAuth, returnsReadOnly, async (req: any, res: any) => {
    try {
      const filters = parseManagementFilters(req.query);
      const dataset = await loadAnalyticsDataset(db, filters);
      const returns = buildReturnsAnalytics(dataset, filters);
      return res.json({ success: true, data: returns });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  router.get("/exceptions", requireAuth, returnsReadOnly, async (req: any, res: any) => {
    try {
      const filters = parseManagementFilters(req.query);
      const dataset = await loadAnalyticsDataset(db, filters);
      const exceptions = buildExceptionsAnalytics(dataset, filters);
      return res.json({ success: true, data: exceptions });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  router.get("/activity", requireAuth, fullDashboard, async (req: any, res: any) => {
    try {
      const filters = parseManagementFilters(req.query);
      const dataset = await loadAnalyticsDataset(db, filters);
      const activity = buildActivityAnalytics(dataset, filters);
      return res.json({ success: true, data: activity });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  router.get("/drilldown", requireAuth, fullDashboard, async (req: any, res: any) => {
    try {
      const filters = parseManagementFilters(req.query);
      const key = String(req.query.key || "").trim();
      const dataset = await loadAnalyticsDataset(db, filters);
      const data = buildDrilldown(dataset, filters, key);
      return res.json({ success: true, data });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  router.get("/eod", requireAuth, fullDashboard, async (req: any, res: any) => {
    try {
      const filters = parseManagementFilters({ ...req.query, datePreset: req.query.datePreset || "today" });
      const dataset = await loadAnalyticsDataset(db, filters);
      const operations = buildOperationsAnalytics(dataset, filters);
      const finance = buildFinanceAnalytics(dataset, filters);
      const returns = buildReturnsAnalytics(dataset, filters);
      const exceptions = buildExceptionsAnalytics(dataset, filters);

      return res.json({
        success: true,
        data: {
          title: "GOMILA RIDER CONTROL",
          subtitle: `Daily Close — ${operations.range.label}`,
          ordersProcessed: valueByKey(operations.topStats, "ordersEntered"),
          delivered: valueByKey(operations.topStats, "deliveredToday"),
          failed: valueByKey(operations.topStats, "failedAttemptsToday"),
          pending: valueByKey(operations.topStats, "stillWithRiders"),
          deliverySuccess: valueByKey(operations.deliveryPerformance, "deliverySuccessRate"),
          firstAttemptSuccess: valueByKey(operations.deliveryPerformance, "firstAttemptSuccessRate"),
          codCollected: valueByKey(finance.summary, "codCollected"),
          cashReceived: valueByKey(finance.summary, "cashierReceived"),
          cashWithRiders: valueByKey(finance.summary, "cashWithRiders"),
          shortage: valueByKey(finance.summary, "openShortage"),
          excess: valueByKey(finance.summary, "openExcess"),
          returnsRequired: valueByKey(returns.summary, "returnRequired"),
          warehouseReceived: valueByKey(returns.summary, "warehouseReceived"),
          returnsPending: valueByKey(returns.summary, "awaitingResolution"),
          criticalExceptions: exceptions.counts.critical,
          highExceptions: exceptions.counts.high
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  router.get("/export", requireAuth, fullDashboard, async (req: any, res: any) => {
    try {
      const filters = parseManagementFilters(req.query);
      const key = String(req.query.key || "").trim();
      const dataset = await loadAnalyticsDataset(db, filters);
      const drilldown = buildDrilldown(dataset, filters, key);
      const headers = drilldown.columns.map((column) => column.label);
      const rows = drilldown.rows.map((row) => drilldown.columns.map((column) => csvEscape(row[column.key])));
      const csv = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=\"${key || "management-export"}.csv\"`);
      return res.send(csv);
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: err.message } });
    }
  });

  return router;
}

function valueByKey(metrics: Array<{ key: string; value: number | null }>, key: string) {
  return metrics.find((metric) => metric.key === key)?.value ?? null;
}

function csvEscape(value: unknown) {
  const stringValue = String(value ?? "");
  if (stringValue.includes(",") || stringValue.includes("\"") || stringValue.includes("\n")) {
    return `"${stringValue.replace(/"/g, "\"\"")}"`;
  }
  return stringValue;
}

function buildDrilldown(dataset: any, filters: any, key: string): DrilldownResponse {
  const indexes = buildIndexes(dataset);
  const operations = buildOperationsAnalytics(dataset, filters);
  const finance = buildFinanceAnalytics(dataset, filters);
  const returns = buildReturnsAnalytics(dataset, filters);
  const riders = buildRiderAnalytics(dataset, filters);
  const activity = buildActivityAnalytics(dataset, filters);
  const exceptions = buildExceptionsAnalytics(dataset, filters);

  if (key === "overview.ordersEntered") {
    const rows = dataset.packages
      .filter((pkg: any) => packageMatchesFilters(pkg, filters))
      .filter((pkg: any) => pkg.createdAt >= operations.range.startIso && pkg.createdAt <= operations.range.endIso)
      .map((pkg: any) => packageRow(pkg));
    return packageDrilldown(key, "Orders Entered", rows);
  }

  if (key === "overview.readyForDispatch") {
    return packageDrilldown(key, "Ready for Dispatch", dataset.packages.filter((pkg: any) => packageMatchesFilters(pkg, filters) && resolvePackageStatus(pkg) === "READY_FOR_DISPATCH").map((pkg: any) => packageRow(pkg)));
  }

  if (key === "overview.assigned") {
    return packageDrilldown(key, "Assigned", dataset.packages.filter((pkg: any) => packageMatchesFilters(pkg, filters) && ["ASSIGNED", "DISPATCHER_SCANNED", "RIDER_SCANNED", "RIDER_ACCEPTED"].includes(resolvePackageStatus(pkg))).map((pkg: any) => packageRow(pkg)));
  }

  if (key === "overview.outForDelivery") {
    return packageDrilldown(key, "Out for Delivery", dataset.packages.filter((pkg: any) => packageMatchesFilters(pkg, filters) && resolvePackageStatus(pkg) === "OUT_FOR_DELIVERY").map((pkg: any) => packageRow(pkg)));
  }

  if (key === "overview.deliveredToday") {
    const packageIds = new Set(dataset.deliveryAttempts.filter((attempt: any) => String(attempt.status).toUpperCase() === "DELIVERED" && recordMatchesFilters(attempt, dataset, filters) && attempt.createdAt >= operations.range.startIso && attempt.createdAt <= operations.range.endIso).map((attempt: any) => String(attempt.packageId)));
    return packageDrilldown(key, "Delivered Today", Array.from(packageIds).map((packageId: string) => packageRow(indexes.packagesById.get(packageId))));
  }

  if (key === "overview.failedAttemptsToday") {
    return eventDrilldown(key, "Failed Attempts Today", dataset.deliveryAttempts.filter((attempt: any) => String(attempt.status).toUpperCase() !== "DELIVERED" && recordMatchesFilters(attempt, dataset, filters) && attempt.createdAt >= operations.range.startIso && attempt.createdAt <= operations.range.endIso).map((attempt: any) => attemptRow(attempt, indexes.packagesById.get(String(attempt.packageId)))));
  }

  if (key === "overview.returnsReceived") {
    return eventDrilldown(key, "Returns Received", dataset.returnReceipts.filter((receipt: any) => receipt.receivedAt >= operations.range.startIso && receipt.receivedAt <= operations.range.endIso && recordMatchesFilters(receipt, dataset, filters)).map((receipt: any) => ({
      packageId: receipt.packageId,
      packageNumber: indexes.packagesById.get(String(receipt.packageId))?.packageNumber || receipt.packageId,
      status: receipt.packageCondition,
      timestamp: receipt.receivedAt,
      amount: ""
    })));
  }

  if (key === "overview.stillWithRiders") {
    return packageDrilldown(key, "Still With Riders", dataset.packages.filter((pkg: any) => packageMatchesFilters(pkg, filters) && pkg.assignedRiderId && ["ASSIGNED", "DISPATCHER_SCANNED", "RIDER_SCANNED", "RIDER_ACCEPTED", "OUT_FOR_DELIVERY", "CUSTOMER_UNAVAILABLE", "RESCHEDULED", "REFUSED", "ADDRESS_ISSUE", "RETURN_REQUIRED", "RIDER_RETURNING", "RIDER_HANDBACK"].includes(resolvePackageStatus(pkg))).map((pkg: any) => packageRow(pkg)));
  }

  if (key.startsWith("finance.")) {
    const financeKey = key.replace("finance.", "");
    const sourceRows = (finance.drilldowns as any)[financeKey] || [];
    return genericDrilldown(key, financeKey, sourceRows);
  }

  if (key.startsWith("riderTimeline.")) {
    const riderId = key.split(".")[1];
    return genericDrilldown(key, `Rider Timeline ${riderId}`, riders.timelines.get(riderId) || []);
  }

  if (key.startsWith("returns.")) {
    const rows = (() => {
      switch (key) {
        case "returns.returnRequired":
          return returns.discrepancies.returnNotClosed;
        case "returns.awaitingResolution":
          return returns.discrepancies.returnNotClosed;
        default:
          return returns.discrepancies.riderHandedBackWarehouseMissing;
      }
    })();
    return genericDrilldown(key, key, rows);
  }

  if (key === "alerts.unsettledCashRiders") {
    return genericDrilldown(key, "Riders With Unsettled Cash", finance.drilldowns.cashWithRiders);
  }

  if (key === "alerts.returnsMissingWarehouse") {
    return genericDrilldown(key, "Returns Missing Warehouse Receipt", returns.discrepancies.riderHandedBackWarehouseMissing);
  }

  if (key === "alerts.readyOver24h") {
    return packageDrilldown(key, "Ready >24h", dataset.packages.filter((pkg: any) => packageMatchesFilters(pkg, filters) && resolvePackageStatus(pkg) === "READY_FOR_DISPATCH" && Date.now() - Date.parse(pkg.updatedAt || pkg.createdAt || "") > 24 * 60 * 60 * 1000).map((pkg: any) => packageRow(pkg)));
  }

  if (key === "alerts.overdueReattempts") {
    return genericDrilldown(key, "Overdue Reattempts", dataset.reattemptRequests.filter((request: any) => request.newPromisedDeliveryDate && request.newPromisedDeliveryDate < operations.range.toDate && recordMatchesFilters(request, dataset, filters)));
  }

  if (key === "alerts.cancelledWithRiders") {
    return packageDrilldown(key, "Cancelled With Riders", dataset.packages.filter((pkg: any) => packageMatchesFilters(pkg, filters) && resolvePackageStatus(pkg) === "CANCELLED" && pkg.assignedRiderId).map((pkg: any) => packageRow(pkg)));
  }

  return genericDrilldown(key, key || "Drilldown", []);
}

function packageDrilldown(key: string, title: string, rows: any[]): DrilldownResponse {
  return {
    key,
    title,
    columns: [
      { key: "packageNumber", label: "Package" },
      { key: "customerName", label: "Customer" },
      { key: "city", label: "City" },
      { key: "status", label: "Status" },
      { key: "codExpected", label: "COD" }
    ],
    rows
  };
}

function eventDrilldown(key: string, title: string, rows: any[]): DrilldownResponse {
  return {
    key,
    title,
    columns: [
      { key: "packageNumber", label: "Package" },
      { key: "status", label: "Status" },
      { key: "timestamp", label: "Timestamp" },
      { key: "amount", label: "Amount" }
    ],
    rows
  };
}

function genericDrilldown(key: string, title: string, rows: any[]): DrilldownResponse {
  const sample = rows[0] || {};
  const columns = Object.keys(sample).slice(0, 8).map((columnKey) => ({
    key: columnKey,
    label: columnKey
  }));
  return { key, title, columns, rows };
}

function packageRow(pkg: any) {
  return {
    packageId: pkg?.id || "",
    packageNumber: pkg?.packageNumber || pkg?.package_number || pkg?.id || "",
    customerName: pkg?.customerName || pkg?.customer_name || "",
    city: pkg?.city || "",
    status: resolvePackageStatus(pkg),
    codExpected: formatCurrency(pkg?.cod_expected || pkg?.expectedCod || pkg?.codExpected || 0)
  };
}

function attemptRow(attempt: any, pkg: any) {
  return {
    packageId: attempt.packageId,
    packageNumber: pkg?.packageNumber || attempt.packageId,
    status: attempt.status,
    timestamp: attempt.createdAt || attempt.serverTimestamp,
    amount: attempt.collectedAmount ? formatCurrency(attempt.collectedAmount) : ""
  };
}
