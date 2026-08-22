import {
  KarachiRange,
  LoadedAnalyticsDataset,
  ManagementFilters,
  ManagementMetric
} from "./analyticsTypes.js";

const KARACHI_OFFSET = "+05:00";

export function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "N/A";
  return `Rs ${Math.round(Number(value)).toLocaleString()}`;
}

export function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "N/A";
  return `${Number(value).toFixed(1)}%`;
}

export function makeMetric(params: Omit<ManagementMetric, "displayValue"> & { displayValue?: string }): ManagementMetric {
  const { unit = "count", value } = params;
  let displayValue = params.displayValue;
  if (!displayValue) {
    if (value === null || value === undefined) displayValue = "N/A";
    else if (unit === "currency") displayValue = formatCurrency(value);
    else if (unit === "percent") displayValue = formatPercent(value);
    else displayValue = `${value}`;
  }
  return {
    ...params,
    unit,
    displayValue
  };
}

export function getKarachiDateString(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

export function shiftKarachiDate(dateString: string, deltaDays: number) {
  const base = new Date(`${dateString}T00:00:00${KARACHI_OFFSET}`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return getKarachiDateString(base);
}

export function buildKarachiRange(fromDate: string, toDate: string): KarachiRange {
  return {
    fromDate,
    toDate,
    startIso: `${fromDate}T00:00:00${KARACHI_OFFSET}`,
    endIso: `${toDate}T23:59:59.999${KARACHI_OFFSET}`,
    label: fromDate === toDate ? fromDate : `${fromDate} → ${toDate}`
  };
}

export function parseManagementFilters(query: any): ManagementFilters {
  const today = getKarachiDateString();
  const yesterday = shiftKarachiDate(today, -1);
  const requestedPreset = String(query.datePreset || query.date || "today").toLowerCase();
  const datePreset = requestedPreset === "yesterday" ? "yesterday" : requestedPreset === "custom" ? "custom" : "today";
  const fromDate = String(query.fromDate || query.startDate || (datePreset === "yesterday" ? yesterday : today));
  const toDate = String(query.toDate || query.endDate || (datePreset === "yesterday" ? yesterday : fromDate));

  return {
    datePreset,
    fromDate,
    toDate,
    city: cleanOptional(query.city),
    zone: cleanOptional(query.zone),
    riderId: cleanOptional(query.riderId || query.rider_id),
    paymentType: cleanOptional(query.paymentType),
    source: cleanOptional(query.source),
    courier: cleanOptional(query.courier),
    shift: cleanOptional(query.shift)
  };
}

function cleanOptional(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function getRangeForFilters(filters: ManagementFilters) {
  return buildKarachiRange(filters.fromDate, filters.toDate);
}

export function isIsoInRange(value: unknown, range: KarachiRange) {
  if (typeof value !== "string" || !value.trim()) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts >= Date.parse(range.startIso) && ts <= Date.parse(range.endIso);
}

export function getHoursFromNow(timestamp: string | null | undefined, now = new Date()) {
  if (!timestamp) return null;
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (now.getTime() - ts) / (1000 * 60 * 60));
}

export function normalizeStatus(value: unknown) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

export function normalizePaymentMethod(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function toAmount(value: unknown) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

export function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key) || [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

export function sortByTimestamp<T>(items: T[], tsFn: (item: T) => string | null | undefined) {
  return [...items].sort((a, b) => {
    const ta = Date.parse(tsFn(a) || "");
    const tb = Date.parse(tsFn(b) || "");
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });
}

export function resolvePackageId(record: any) {
  return record?.packageId || record?.id || record?.package_id || record?.order_id || null;
}

export function resolvePackageNumber(pkg: any) {
  return pkg?.packageNumber || pkg?.package_number || pkg?.id || "";
}

export function resolvePackageCod(pkg: any) {
  return toAmount(pkg?.cod_expected ?? pkg?.expectedCod ?? pkg?.codExpected ?? pkg?.orderAmount);
}

export function resolvePackageStatus(pkg: any) {
  return normalizeStatus(pkg?.operationalStatus || pkg?.current_status || pkg?.currentStatus);
}

export function resolvePackageSource(pkg: any) {
  return String(pkg?.source || (pkg?.shopifyId ? "SHOPIFY" : "MANUAL")).toUpperCase();
}

export function resolveActorType(event: any): "HUMAN" | "SYSTEM" {
  if (event?.actorType === "HUMAN" || event?.actorType === "SYSTEM") return event.actorType;
  const actorUid = String(event?.actorUid || event?.performedByUid || event?.createdByUid || event?.userUid || "").toLowerCase();
  const actorName = String(event?.performedBy || "").toLowerCase();
  const source = String(event?.source || event?.subsystem || "").toLowerCase();
  if (
    actorUid.startsWith("system") ||
    actorUid.includes("shopify_sync") ||
    actorName.startsWith("system") ||
    source.includes("system") ||
    source.includes("job") ||
    source.includes("webhook")
  ) {
    return "SYSTEM";
  }
  return "HUMAN";
}

export function loadCollectionDocs(snapshot: any) {
  return snapshot.docs.map((doc: any) => doc.data());
}

export async function loadAnalyticsDataset(db: FirebaseFirestore.Firestore): Promise<LoadedAnalyticsDataset> {
  const [
    packages,
    riders,
    profiles,
    assignments,
    dispatchRuns,
    custodyScans,
    deliveryAttempts,
    deliveryContactEvents,
    returns,
    returnReceipts,
    returnCustodyEvents,
    codCollections,
    codCollectionDiscrepancies,
    financialPostings,
    riderSettlements,
    digitalPaymentVerifications,
    auditLogs,
    auditEvents,
    financialAuditEvents,
    exceptions,
    customerServiceCases,
    customerContactAttempts,
    reattemptRequests,
    importBatches
  ] = await Promise.all([
    db.collection("packages").get(),
    db.collection("riders").get(),
    db.collection("profiles").get(),
    db.collection("assignments").get(),
    db.collection("dispatchRuns").get(),
    db.collection("custodyScans").get(),
    db.collection("deliveryAttempts").get(),
    db.collection("deliveryContactEvents").get(),
    db.collection("returns").get(),
    db.collection("returnReceipts").get(),
    db.collection("returnCustodyEvents").get(),
    db.collection("codCollections").get(),
    db.collection("codCollectionDiscrepancies").get(),
    db.collection("financialPostings").get(),
    db.collection("riderSettlements").get(),
    db.collection("digitalPaymentVerifications").get(),
    db.collection("auditLogs").get(),
    db.collection("auditEvents").get(),
    db.collection("financialAuditEvents").get(),
    db.collection("exceptions").get(),
    db.collection("customerServiceCases").get(),
    db.collection("customerContactAttempts").get(),
    db.collection("reattemptRequests").get(),
    db.collection("importBatches").get()
  ]);

  return {
    packages: loadCollectionDocs(packages),
    riders: loadCollectionDocs(riders),
    profiles: loadCollectionDocs(profiles),
    assignments: loadCollectionDocs(assignments),
    dispatchRuns: loadCollectionDocs(dispatchRuns),
    custodyScans: loadCollectionDocs(custodyScans),
    deliveryAttempts: loadCollectionDocs(deliveryAttempts),
    deliveryContactEvents: loadCollectionDocs(deliveryContactEvents),
    returns: loadCollectionDocs(returns),
    returnReceipts: loadCollectionDocs(returnReceipts),
    returnCustodyEvents: loadCollectionDocs(returnCustodyEvents),
    codCollections: loadCollectionDocs(codCollections),
    codCollectionDiscrepancies: loadCollectionDocs(codCollectionDiscrepancies),
    financialPostings: loadCollectionDocs(financialPostings),
    riderSettlements: loadCollectionDocs(riderSettlements),
    digitalPaymentVerifications: loadCollectionDocs(digitalPaymentVerifications),
    auditLogs: loadCollectionDocs(auditLogs),
    auditEvents: loadCollectionDocs(auditEvents),
    financialAuditEvents: loadCollectionDocs(financialAuditEvents),
    exceptions: loadCollectionDocs(exceptions),
    customerServiceCases: loadCollectionDocs(customerServiceCases),
    customerContactAttempts: loadCollectionDocs(customerContactAttempts),
    reattemptRequests: loadCollectionDocs(reattemptRequests),
    importBatches: loadCollectionDocs(importBatches)
  };
}

export function buildIndexes(dataset: LoadedAnalyticsDataset) {
  const packagesById = new Map<string, any>();
  const ridersById = new Map<string, any>();
  const profilesById = new Map<string, any>();

  for (const pkg of dataset.packages) packagesById.set(String(pkg.id || pkg.packageId), pkg);
  for (const rider of dataset.riders) ridersById.set(String(rider.id), rider);
  for (const profile of dataset.profiles) profilesById.set(String(profile.id || profile.uid || ""), profile);

  return { packagesById, ridersById, profilesById };
}

export function packageMatchesFilters(pkg: any, filters: ManagementFilters) {
  if (!pkg) return false;
  if (filters.city && String(pkg.city || "").toLowerCase() !== filters.city.toLowerCase()) return false;
  if (filters.zone && String(pkg.zone || pkg.assignedZone || "").toLowerCase() !== filters.zone.toLowerCase()) return false;
  if (filters.riderId && String(pkg.assignedRiderId || "") !== filters.riderId) return false;
  if (filters.paymentType && normalizePaymentMethod(pkg.paymentMethod || pkg.payment_method) !== normalizePaymentMethod(filters.paymentType)) return false;
  if (filters.source && resolvePackageSource(pkg) !== filters.source.toUpperCase()) return false;
  if (filters.courier && String(pkg.courier_company || pkg.courierCompany || pkg.deliveryChannel || "").toLowerCase() !== filters.courier.toLowerCase()) return false;
  return true;
}

export function recordMatchesFilters(record: any, dataset: LoadedAnalyticsDataset, filters: ManagementFilters) {
  const indexes = buildIndexes(dataset);
  const packageId = record?.packageId || record?.package_id || record?.order_id || record?.entityId || null;
  if (packageId && indexes.packagesById.has(String(packageId))) {
    return packageMatchesFilters(indexes.packagesById.get(String(packageId)), filters);
  }
  if (filters.riderId) {
    const riderId = String(record?.riderId || record?.rider_id || "");
    return riderId === filters.riderId;
  }
  return !filters.city && !filters.zone && !filters.paymentType && !filters.source && !filters.courier;
}

export function getAttemptTimestamp(attempt: any) {
  return attempt?.createdAt || attempt?.serverTimestamp || attempt?.timestamp || attempt?.deviceTimestamp || null;
}

export function getFailureReason(attempt: any) {
  return normalizeStatus(attempt?.reason || attempt?.status);
}

export function computeAttemptSequences(attempts: any[]) {
  const byPackage = groupBy(attempts, (attempt) => String(attempt.packageId));
  const sequence = new Map<string, number>();
  for (const [, packageAttempts] of byPackage) {
    const sorted = sortByTimestamp(packageAttempts, getAttemptTimestamp);
    sorted.forEach((attempt, index) => {
      sequence.set(String(attempt.id), Number(attempt.attemptNumber || index + 1));
    });
  }
  return sequence;
}
