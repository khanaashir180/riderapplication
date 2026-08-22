import { LoadedAnalyticsDataset, ManagementFilters, StaffActionRow } from "./analyticsTypes.js";
import {
  buildIndexes,
  getAttemptTimestamp,
  getRangeForFilters,
  groupBy,
  isIsoInRange,
  packageMatchesFilters,
  recordMatchesFilters,
  resolveActorType,
  sortByTimestamp,
  toAmount
} from "./shared.js";

export function buildActivityAnalytics(dataset: LoadedAnalyticsDataset, filters: ManagementFilters) {
  const range = getRangeForFilters(filters);
  const indexes = buildIndexes(dataset);
  const actions: any[] = [];

  for (const attempt of dataset.deliveryAttempts) {
    if (!isIsoInRange(getAttemptTimestamp(attempt), range) || !recordMatchesFilters(attempt, dataset, filters)) continue;
    actions.push({
      actorUid: attempt.riderId,
      actorRole: "rider",
      actorType: "HUMAN",
      label: `Delivery Attempt: ${attempt.status}`,
      packageId: attempt.packageId,
      timestamp: getAttemptTimestamp(attempt)
    });
  }

  for (const event of dataset.deliveryContactEvents) {
    if (!isIsoInRange(event.createdAt || event.timestamp, range) || !recordMatchesFilters(event, dataset, filters)) continue;
    actions.push({
      actorUid: event.riderId,
      actorRole: "rider",
      actorType: "HUMAN",
      label: `Contact: ${event.outcome}`,
      packageId: event.packageId,
      timestamp: event.createdAt || event.timestamp
    });
  }

  for (const event of dataset.customerContactAttempts) {
    if (!isIsoInRange(event.createdAt, range) || !recordMatchesFilters(event, dataset, filters)) continue;
    actions.push({
      actorUid: event.userUid,
      actorRole: "customer_service",
      actorType: "HUMAN",
      label: `Customer Contact: ${event.result}`,
      packageId: event.packageId,
      timestamp: event.createdAt
    });
  }

  for (const scan of dataset.custodyScans) {
    if (!isIsoInRange(scan.scannedAt, range) || !recordMatchesFilters(scan, dataset, filters)) continue;
    actions.push({
      actorUid: scan.scannedBy,
      actorRole: "dispatch_manager",
      actorType: "HUMAN",
      label: `Custody Scan: ${scan.scanStage}`,
      packageId: scan.packageId,
      timestamp: scan.scannedAt
    });
  }

  for (const settlement of dataset.riderSettlements) {
    if (settlement.submittedAt && isIsoInRange(settlement.submittedAt, range) && (!filters.riderId || String(settlement.riderId) === filters.riderId)) {
      actions.push({
        actorUid: settlement.riderId,
        actorRole: "rider",
        actorType: "HUMAN",
        label: "Settlement Submitted",
        timestamp: settlement.submittedAt
      });
    }
    if (settlement.receivedAt && isIsoInRange(settlement.receivedAt, range)) {
      actions.push({
        actorUid: settlement.receivedByUid || settlement.receivedBy || "cashier",
        actorRole: "cashier",
        actorType: "HUMAN",
        label: "Cashier Received Settlement",
        timestamp: settlement.receivedAt
      });
    }
    if (settlement.approvedAt && isIsoInRange(settlement.approvedAt, range)) {
      actions.push({
        actorUid: settlement.approvedByUid || settlement.approvedBy || "manager",
        actorRole: "dispatch_manager",
        actorType: "HUMAN",
        label: "Settlement Approved",
        timestamp: settlement.approvedAt
      });
    }
  }

  const auditStreams = [...dataset.auditLogs, ...dataset.auditEvents, ...dataset.financialAuditEvents];
  for (const event of auditStreams) {
    const timestamp = event.timestamp || event.createdAt || event.performedAt || null;
    if (!isIsoInRange(timestamp, range)) continue;
    const actorType = resolveActorType(event);
    if (actorType !== "HUMAN") continue;
    if (!recordMatchesFilters(event, dataset, filters)) continue;
    actions.push({
      actorUid: event.actorUid || event.performedByUid || event.createdByUid || "unknown",
      actorRole: event.actorRole || event.performedByRole || inferRoleFromProfile(indexes.profilesById.get(String(event.actorUid || event.performedByUid || event.createdByUid || ""))),
      actorType,
      label: event.action || event.eventType || "Audit Event",
      timestamp
    });
  }

  const grouped = groupBy(actions, (action) => String(action.actorUid));
  const staffRows: StaffActionRow[] = [];
  for (const [actorUid, actorActions] of grouped.entries()) {
    const sorted = sortByTimestamp(actorActions, (action) => action.timestamp).reverse();
    const profile = indexes.profilesById.get(actorUid);
    staffRows.push({
      actorUid,
      actorName: profile?.fullName || profile?.full_name || actorUid,
      actorRole: sorted[0]?.actorRole || profile?.role || "unknown",
      actionCount: actorActions.length,
      lastActionAt: sorted[0]?.timestamp || null,
      lastActionLabel: sorted[0]?.label || null,
      criticalActionCount: actorActions.filter((action) => /SETTLEMENT|APPROVED|PACKAGE_ASSIGNED|PACKAGE_TRANSFERRED|DELIVERED/i.test(String(action.label))).length,
      assignedExceptionCount: dataset.exceptions.filter((exception) => String(exception.assignedToUid || "") === actorUid).length
    });
  }

  return {
    range,
    summary: {
      humanActionCount: actions.length,
      systemActionCount: auditStreams.filter((event) => resolveActorType(event) === "SYSTEM" && isIsoInRange(event.timestamp || event.createdAt, range)).length
    },
    staffRows: staffRows.sort((a, b) => b.actionCount - a.actionCount)
  };
}

function inferRoleFromProfile(profile: any) {
  return profile?.role || "unknown";
}
