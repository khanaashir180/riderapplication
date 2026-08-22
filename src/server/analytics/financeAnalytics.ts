import { FinanceBreakdownRow, LoadedAnalyticsDataset, ManagementFilters, ManagementMetric } from "./analyticsTypes.js";
import {
  buildIndexes,
  formatCurrency,
  getRangeForFilters,
  isIsoInRange,
  makeMetric,
  normalizePaymentMethod,
  packageMatchesFilters,
  recordMatchesFilters,
  toAmount
} from "./shared.js";

function sumPostings(postings: any[], accountCode: string, side: "debit" | "credit", riderId?: string) {
  return postings
    .filter((posting) => posting.accountCode === accountCode && (!riderId || String(posting.riderId || "") === riderId))
    .reduce((sum, posting) => sum + toAmount(side === "debit" ? posting.debitAmount : posting.creditAmount), 0);
}

export type FinanceReconciliationReason =
  | "OPEN_COLLECTION_VARIANCE"
  | "DIGITAL_VERIFICATION_PENDING"
  | "RIDER_CASH_OUTSTANDING"
  | "SETTLEMENT_SHORTAGE"
  | "SETTLEMENT_EXCESS"
  | "LEDGER_IMBALANCE"
  | "UNRESOLVED_DISCREPANCY";

function componentStatus(condition: boolean) {
  return condition ? "MATCHED" : "ATTENTION_REQUIRED";
}

export function buildFinanceAnalytics(dataset: LoadedAnalyticsDataset, filters: ManagementFilters) {
  const range = getRangeForFilters(filters);
  const indexes = buildIndexes(dataset);
  const codCollections = dataset.codCollections.filter((collection) => recordMatchesFilters(collection, dataset, filters));
  const collectionsToday = codCollections.filter((collection) => isIsoInRange(collection.createdAt, range));
  const expectedToday = collectionsToday.reduce((sum, collection) => sum + toAmount(collection.expectedCod), 0);
  const collectedToday = collectionsToday.reduce((sum, collection) => sum + toAmount(collection.collectedAmount), 0);
  const cashCollectionsToday = collectionsToday.filter((collection) => normalizePaymentMethod(collection.paymentMethod) === "cash");
  const digitalCollectionsToday = collectionsToday.filter((collection) => normalizePaymentMethod(collection.paymentMethod) !== "cash" && normalizePaymentMethod(collection.paymentMethod) !== "prepaid");
  const cashCodToday = cashCollectionsToday.reduce((sum, collection) => sum + toAmount(collection.collectedAmount), 0);
  const digitalCodToday = digitalCollectionsToday.reduce((sum, collection) => sum + toAmount(collection.collectedAmount), 0);

  const settlements = dataset.riderSettlements.filter((settlement) => !filters.riderId || String(settlement.riderId || "") === filters.riderId);
  const settlementSubmittedToday = settlements.filter((settlement) => isIsoInRange(settlement.submittedAt, range));
  const settlementReceivedToday = settlements.filter((settlement) => isIsoInRange(settlement.receivedAt, range));
  const settlementSubmittedAmount = settlementSubmittedToday.reduce((sum, settlement) => sum + toAmount(settlement.declaredCashAmount), 0);
  const cashierReceivedToday = settlementReceivedToday.reduce((sum, settlement) => sum + toAmount(settlement.physicallyReceivedAmount), 0);

  const digitalPending = dataset.digitalPaymentVerifications.filter((verification) => verification.status === "pending" && recordMatchesFilters(verification, dataset, filters));
  const digitalVerificationPendingAmount = digitalPending.reduce((sum, verification) => sum + toAmount(verification.amount), 0);
  const openCollectionVarianceRows = dataset.codCollectionDiscrepancies
    .filter((discrepancy) => String(discrepancy.status || "").toUpperCase() === "OPEN")
    .filter((discrepancy) => recordMatchesFilters(discrepancy, dataset, filters))
    .map((discrepancy) => ({
      key: discrepancy.id,
      label: indexes.packagesById.get(String(discrepancy.packageId))?.packageNumber || discrepancy.packageId,
      riderId: discrepancy.riderId,
      riderName: indexes.ridersById.get(String(discrepancy.riderId))?.fullName || indexes.ridersById.get(String(discrepancy.riderId))?.full_name || String(discrepancy.riderId),
      packageId: discrepancy.packageId,
      packageNumber: indexes.packagesById.get(String(discrepancy.packageId))?.packageNumber || discrepancy.packageId,
      amount: Math.abs(toAmount(discrepancy.variance)),
      paymentMethod: "collection_variance",
      timestamp: discrepancy.createdAt || null,
      variance: toAmount(discrepancy.variance)
    }));
  const openCollectionVarianceAmount = openCollectionVarianceRows.reduce((sum, row) => sum + row.amount, 0);

  const riderCashRows: FinanceBreakdownRow[] = dataset.riders
    .filter((rider) => !filters.riderId || String(rider.id) === filters.riderId)
    .map((rider) => {
      const riderId = String(rider.id);
      const riderCashDebit = sumPostings(dataset.financialPostings, "RIDER_CASH_WALLET", "debit", riderId);
      const riderCashCredit = sumPostings(dataset.financialPostings, "RIDER_CASH_WALLET", "credit", riderId);
      return {
        key: riderId,
        label: rider.fullName || rider.full_name || rider.rider_code || riderId,
        riderId,
        riderName: rider.fullName || rider.full_name || rider.rider_code || riderId,
        amount: Math.max(0, riderCashDebit - riderCashCredit)
      };
    })
    .filter((row) => row.amount > 0);

  const cashWithRiders = riderCashRows.reduce((sum, row) => sum + row.amount, 0);

  const openShortageRows = settlements
    .filter((settlement) => !["closed", "manager_approved"].includes(String(settlement.status || "")) && toAmount(settlement.totalSettlementVariance) < 0)
    .map((settlement) => ({
      key: settlement.id,
      label: settlement.settlementNumber || settlement.id,
      riderId: settlement.riderId,
      riderName: indexes.ridersById.get(String(settlement.riderId))?.fullName || indexes.ridersById.get(String(settlement.riderId))?.full_name || String(settlement.riderId),
      amount: Math.abs(toAmount(settlement.totalSettlementVariance)),
      timestamp: settlement.receivedAt || settlement.updatedAt || settlement.createdAt || null
    }));

  const openExcessRows = settlements
    .filter((settlement) => !["closed", "manager_approved"].includes(String(settlement.status || "")) && toAmount(settlement.totalSettlementVariance) > 0)
    .map((settlement) => ({
      key: settlement.id,
      label: settlement.settlementNumber || settlement.id,
      riderId: settlement.riderId,
      riderName: indexes.ridersById.get(String(settlement.riderId))?.fullName || indexes.ridersById.get(String(settlement.riderId))?.full_name || String(settlement.riderId),
      amount: toAmount(settlement.totalSettlementVariance),
      timestamp: settlement.receivedAt || settlement.updatedAt || settlement.createdAt || null
    }));

  const openShortage = openShortageRows.reduce((sum, row) => sum + row.amount, 0);
  const openExcess = openExcessRows.reduce((sum, row) => sum + row.amount, 0);
  const settled = cashierReceivedToday - openShortage + openExcess;
  const reconciliationDifference = cashCodToday - cashierReceivedToday - cashWithRiders - openShortage + openExcess;
  const ledgerDebits = dataset.financialPostings.reduce((sum, posting) => sum + toAmount(posting.debitAmount), 0);
  const ledgerCredits = dataset.financialPostings.reduce((sum, posting) => sum + toAmount(posting.creditAmount), 0);
  const ledgerDifference = ledgerDebits - ledgerCredits;
  const unresolvedFinancialDiscrepancyCount = dataset.exceptions.filter((exception) => {
    const status = String(exception.status || exception.resolutionStatus || "OPEN").toUpperCase();
    const code = String(exception.code || exception.type || exception.category || "").toUpperCase();
    return !["RESOLVED", "CLOSED", "APPROVED"].includes(status) && /FINANC|COD|SETTLEMENT|PAYMENT|LEDGER|COLLECTION/.test(code);
  }).length;
  const reasons: FinanceReconciliationReason[] = [];
  if (Math.abs(openCollectionVarianceAmount) > 0.0001) reasons.push("OPEN_COLLECTION_VARIANCE");
  if (Math.abs(digitalVerificationPendingAmount) > 0.0001) reasons.push("DIGITAL_VERIFICATION_PENDING");
  if (Math.abs(cashWithRiders) > 0.0001) reasons.push("RIDER_CASH_OUTSTANDING");
  if (Math.abs(openShortage) > 0.0001) reasons.push("SETTLEMENT_SHORTAGE");
  if (Math.abs(openExcess) > 0.0001) reasons.push("SETTLEMENT_EXCESS");
  if (Math.abs(ledgerDifference) > 0.0001) reasons.push("LEDGER_IMBALANCE");
  if (unresolvedFinancialDiscrepancyCount > 0) reasons.push("UNRESOLVED_DISCREPANCY");
  const cashReconciliationMatched = Math.abs(reconciliationDifference) < 0.0001;
  const digitalReconciliationMatched = Math.abs(digitalVerificationPendingAmount) < 0.0001;
  const collectionReconciliationMatched = Math.abs(openCollectionVarianceAmount) < 0.0001;
  const ledgerReconciliationMatched = Math.abs(ledgerDifference) < 0.0001;

  const summary: ManagementMetric[] = [
    makeMetric({
      key: "codExpected",
      label: "COD Expected",
      value: expectedToday,
      unit: "currency",
      source: "codCollections.expectedCod in selected Karachi range",
      formula: "Sum of expectedCod for COD collections created in the selected range.",
      drilldownKey: "finance.codExpected"
    }),
    makeMetric({
      key: "codCollected",
      label: "COD Collected",
      value: collectedToday,
      unit: "currency",
      source: "codCollections.collectedAmount in selected Karachi range",
      formula: "Sum of collectedAmount for COD collections in the selected range.",
      drilldownKey: "finance.codCollected"
    }),
    makeMetric({
      key: "cashCod",
      label: "Cash COD",
      value: cashCodToday,
      unit: "currency",
      source: "cash codCollections in selected Karachi range",
      formula: "Sum of collectedAmount where paymentMethod = cash.",
      drilldownKey: "finance.cashCod"
    }),
    makeMetric({
      key: "digitalCod",
      label: "Digital COD",
      value: digitalCodToday,
      unit: "currency",
      source: "digital codCollections in selected Karachi range",
      formula: "Sum of collectedAmount where paymentMethod is digital.",
      drilldownKey: "finance.digitalCod"
    }),
    makeMetric({
      key: "cashWithRiders",
      label: "Cash With Riders",
      value: cashWithRiders,
      unit: "currency",
      source: "financialPostings accountCode = RIDER_CASH_WALLET",
      formula: "RIDER_CASH_WALLET debits - credits across matching rider postings.",
      drilldownKey: "finance.cashWithRiders",
      status: cashWithRiders > 0 ? "warning" : "normal"
    }),
    makeMetric({
      key: "settlementSubmitted",
      label: "Settlement Submitted",
      value: settlementSubmittedAmount,
      unit: "currency",
      source: "riderSettlements.submittedAt in selected Karachi range",
      formula: "Sum of declaredCashAmount for settlements submitted in range.",
      drilldownKey: "finance.settlementSubmitted"
    }),
    makeMetric({
      key: "cashierReceived",
      label: "Cashier Received",
      value: cashierReceivedToday,
      unit: "currency",
      source: "riderSettlements.receivedAt in selected Karachi range",
      formula: "Sum of physicallyReceivedAmount for settlements received in range.",
      drilldownKey: "finance.cashierReceived"
    }),
    makeMetric({
      key: "digitalVerificationPending",
      label: "Digital Verification Pending",
      value: digitalVerificationPendingAmount,
      unit: "currency",
      source: "digitalPaymentVerifications.status = pending",
      formula: "Sum of pending digital verification amounts under active filters.",
      drilldownKey: "finance.digitalVerificationPending"
    }),
    makeMetric({
      key: "openCollectionVariance",
      label: "Open Collection Variance",
      value: openCollectionVarianceAmount,
      unit: "currency",
      source: "codCollectionDiscrepancies.status = OPEN",
      formula: "Absolute sum of unresolved expected COD vs collected COD differences.",
      drilldownKey: "finance.openCollectionVariance",
      status: openCollectionVarianceAmount > 0 ? "critical" : "normal"
    }),
    makeMetric({
      key: "openShortage",
      label: "Open Shortage",
      value: openShortage,
      unit: "currency",
      source: "riderSettlements with negative totalSettlementVariance",
      formula: "Absolute sum of open negative settlement variance.",
      drilldownKey: "finance.openShortage",
      status: openShortage > 0 ? "critical" : "normal"
    }),
    makeMetric({
      key: "openExcess",
      label: "Open Excess",
      value: openExcess,
      unit: "currency",
      source: "riderSettlements with positive totalSettlementVariance",
      formula: "Sum of open positive settlement variance.",
      drilldownKey: "finance.openExcess",
      status: openExcess > 0 ? "warning" : "normal"
    }),
    makeMetric({
      key: "settled",
      label: "Settled",
      value: settled,
      unit: "currency",
      source: "cashier receipts net of still-open variance",
      formula: "Cashier received - open shortage + open excess.",
      drilldownKey: "finance.settled"
    })
  ];

  return {
    range,
    summary,
    reconciliation: {
      status: cashReconciliationMatched && Math.abs(cashWithRiders) < 0.0001 && Math.abs(openShortage) < 0.0001 && Math.abs(openExcess) < 0.0001 && collectionReconciliationMatched && digitalReconciliationMatched && ledgerReconciliationMatched && unresolvedFinancialDiscrepancyCount === 0 ? "MATCHED" : "ATTENTION_REQUIRED",
      reasonFlags: reasons,
      unresolvedFinancialDiscrepancyCount,
      equation: `Cash COD Collected (${formatCurrency(cashCodToday)}) - Cashier Received (${formatCurrency(cashierReceivedToday)}) - Cash Still With Riders (${formatCurrency(cashWithRiders)}) - Open Shortage (${formatCurrency(openShortage)}) + Open Excess (${formatCurrency(openExcess)}) = ${formatCurrency(reconciliationDifference)}`,
      difference: reconciliationDifference,
      cashReconciliationDifference: reconciliationDifference,
      openCollectionVariance: openCollectionVarianceAmount,
      digitalVerificationPending: digitalVerificationPendingAmount,
      cashWithRiders,
      openShortage,
      openExcess,
      components: {
        cash: { status: componentStatus(cashReconciliationMatched && Math.abs(cashWithRiders) < 0.0001 && Math.abs(openShortage) < 0.0001 && Math.abs(openExcess) < 0.0001), difference: reconciliationDifference },
        digital: { status: componentStatus(digitalReconciliationMatched), pending: digitalVerificationPendingAmount },
        collection: { status: componentStatus(collectionReconciliationMatched), variance: openCollectionVarianceAmount },
        ledger: { status: componentStatus(ledgerReconciliationMatched), difference: ledgerDifference }
      },
      ledger: {
        debits: ledgerDebits,
        credits: ledgerCredits,
        difference: ledgerDifference
      }
    },
    drilldowns: {
      cashWithRiders: riderCashRows,
      openShortage: openShortageRows,
      openExcess: openExcessRows,
      cashCod: cashCollectionsToday.map((collection) => buildCollectionRow(collection, indexes.packagesById)),
      digitalCod: digitalCollectionsToday.map((collection) => buildCollectionRow(collection, indexes.packagesById)),
      openCollectionVariance: openCollectionVarianceRows,
      digitalVerificationPending: digitalPending.map((verification) => ({
        key: verification.id,
        label: verification.digitalReference || verification.id,
        packageId: verification.packageId,
        packageNumber: indexes.packagesById.get(String(verification.packageId))?.packageNumber || verification.packageId,
        amount: toAmount(verification.amount),
        paymentMethod: verification.paymentMethod,
        timestamp: verification.createdAt || null
      }))
    }
  };
}

function buildCollectionRow(collection: any, packagesById: Map<string, any>): FinanceBreakdownRow {
  const pkg = packagesById.get(String(collection.packageId));
  return {
    key: collection.id,
    label: pkg?.packageNumber || collection.packageId,
    riderId: collection.riderId,
    packageId: collection.packageId,
    packageNumber: pkg?.packageNumber || collection.packageId,
    amount: toAmount(collection.collectedAmount),
    paymentMethod: collection.paymentMethod,
    timestamp: collection.createdAt || null
  };
}
