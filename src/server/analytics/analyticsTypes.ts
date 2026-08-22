export type ManagementDatePreset = "today" | "yesterday" | "custom";

export interface ManagementFilters {
  datePreset: ManagementDatePreset;
  fromDate: string;
  toDate: string;
  city?: string;
  zone?: string;
  riderId?: string;
  paymentType?: string;
  source?: string;
  courier?: string;
  shift?: string;
}

export interface KarachiRange {
  fromDate: string;
  toDate: string;
  startIso: string;
  endIso: string;
  label: string;
}

export interface ManagementMetric {
  key: string;
  label: string;
  value: number | null;
  unit?: "count" | "currency" | "percent" | "text";
  displayValue: string;
  source: string;
  formula?: string;
  drilldownKey?: string;
  status?: "normal" | "warning" | "critical" | "na";
}

export interface AgingBucket {
  key: string;
  label: string;
  minHours: number;
  maxHours: number | null;
  count: number;
  drilldownKey: string;
  status: "normal" | "warning" | "critical";
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  percentageOfBase: number | null;
  source: string;
  drilldownKey: string;
}

export interface RiderCommandRow {
  riderId: string;
  riderName: string;
  riderCode: string;
  city: string;
  zone: string;
  shiftStatus: string;
  assigned: number;
  delivered: number;
  failed: number;
  remaining: number;
  firstAttemptSuccess: number | null;
  codCollected: number;
  cashOutstanding: number;
  returnsPending: number;
  lastActionAt: string | null;
  lastActionLabel: string | null;
  exceptionCount: number;
  timelineDrilldownKey: string;
}

export interface RiderTimelineEvent {
  id: string;
  riderId: string;
  timestamp: string;
  label: string;
  detail: string;
  packageId?: string | null;
  packageNumber?: string | null;
  amount?: number | null;
  source: string;
}

export interface FinanceBreakdownRow {
  key: string;
  label: string;
  riderId?: string;
  riderName?: string;
  packageId?: string;
  packageNumber?: string;
  amount: number;
  paymentMethod?: string | null;
  timestamp?: string | null;
}

export interface ExceptionSummaryRow {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  status: string;
  title: string;
  detail: string;
  packageId?: string | null;
  riderId?: string | null;
  createdAt: string;
  source: string;
}

export interface StaffActionRow {
  actorUid: string;
  actorName: string;
  actorRole: string;
  actionCount: number;
  lastActionAt: string | null;
  lastActionLabel: string | null;
  criticalActionCount: number;
  assignedExceptionCount: number;
}

export interface DrilldownResponse {
  key: string;
  title: string;
  columns: Array<{ key: string; label: string }>;
  rows: any[];
}

export interface LoadedAnalyticsDataset {
  packages: any[];
  riders: any[];
  profiles: any[];
  assignments: any[];
  dispatchRuns: any[];
  custodyScans: any[];
  deliveryAttempts: any[];
  deliveryContactEvents: any[];
  returns: any[];
  returnReceipts: any[];
  returnCustodyEvents: any[];
  codCollections: any[];
  codCollectionDiscrepancies: any[];
  financialPostings: any[];
  riderSettlements: any[];
  digitalPaymentVerifications: any[];
  auditLogs: any[];
  auditEvents: any[];
  financialAuditEvents: any[];
  exceptions: any[];
  customerServiceCases: any[];
  customerContactAttempts: any[];
  reattemptRequests: any[];
  importBatches: any[];
}
