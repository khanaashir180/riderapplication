/**
 * Gomila Intersole API Client Service
 * Enforces real Firebase ID Token Authentication header transmission on all operational requests.
 */
import { Order, Rider, Profile, ImportBatch, MasterData, CODAllocationReview, normalizePackage } from "../types";

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number = 500, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface OrdersResponse {
  orders: Order[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface AnalyticsSummary {
  totalOrders: number;
  importedToday: number;
  awaitingAssignment: number;
  handedToRiders: number;
  outForDelivery: number;
  deliveredToday: number;
  totalDelivered: number;
  totalReturned: number;
  totalRescheduled: number;
  successPercentage: string;
  firstAttemptPercentage: string;
  totalExpectedCod: number;
  totalCollectedCod: number;
  totalSettledCod: number;
  codHeldByRiders: number;
  codDiscrepancies: number;
  assignedToday?: number;
  failedToday?: number;
  returnedToday?: number;
  cashierReceived?: number;
  openShortage?: number;
  openExcess?: number;
  unsettledCod?: number;
  reportingDay?: string;
  aging: {
    pending24: number;
    pending48: number;
    pending72: number;
  };
}

export type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  orders?: Order[];
  pagination?: any;
  profiles?: Profile[];
  riders?: Rider[];
};

let activeAuthToken = "";

export function setApiAuthToken(token: string) {
  activeAuthToken = token;
}

export function getApiAuthToken(): string {
  return activeAuthToken;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {})
  };

  if (activeAuthToken) {
    headers["Authorization"] = `Bearer ${activeAuthToken}`;
  }

  const res = await fetch(path, { ...options, headers });
  const json = await res.json().catch(() => ({}));

  if (!res.ok || json.success === false) {
    const code = json.error?.code || json.code || `HTTP_${res.status}`;
    const message = json.error?.message || json.message || res.statusText || 'API Request Failed';
    throw new ApiError(message, res.status || 500, code, json.error?.details || json);
  }

  const data = json.data !== undefined ? json.data : json;
  const responseObj: ApiResponse<T> = {
    success: true,
    data
  };

  if (data && typeof data === 'object') {
    if (Array.isArray(data.orders)) {
      responseObj.orders = data.orders.map(normalizePackage);
      responseObj.pagination = data.pagination;
    } else if (Array.isArray(data.items)) {
      responseObj.orders = data.items.map(normalizePackage);
      responseObj.pagination = {
        total: data.totalCount ?? data.items.length,
        page: 1,
        limit: data.pageSize ?? 25,
        totalPages: Math.ceil((data.totalCount ?? data.items.length) / (data.pageSize ?? 25))
      };
    } else if (Array.isArray(data)) {
      responseObj.orders = data.map(normalizePackage);
    }

    if (Array.isArray(data.riders)) {
      responseObj.riders = data.riders;
    } else if (Array.isArray(data)) {
      if (path.includes('/profiles')) responseObj.profiles = data;
      if (path.includes('/riders')) responseObj.riders = data;
    }
  }

  return responseObj;
}

function disabledModuleResponse<T>(): Promise<ApiResponse<T>> {
  return Promise.resolve({
    success: false,
    error: {
      code: "MODULE_DISABLED",
      message: "This module is not yet enabled."
    }
  });
}

export const api = {
  // Profiles & Auth
  async getMe(): Promise<ApiResponse<{ profile: Profile; rider?: Rider }>> {
    return request<{ profile: Profile; rider?: Rider }>("/api/auth/me");
  },

  async getProfiles(): Promise<ApiResponse<Profile[]>> {
    return request<Profile[]>("/api/profiles");
  },

  // Riders
  async getRiderMe(): Promise<ApiResponse<Rider>> {
    return request<Rider>("/api/riders/me");
  },

  async getMyRiderOrders(): Promise<ApiResponse<{ orders: Order[]; total: number; activeCount: number; deliveredCount: number }>> {
    return request<{ orders: Order[]; total: number; activeCount: number; deliveredCount: number }>("/api/riders/me/orders");
  },

  async getRiders(): Promise<ApiResponse<Rider[]>> {
    return request<Rider[]>("/api/riders");
  },

  async saveRider(riderData: Partial<Rider>): Promise<ApiResponse<{ rider: Rider }>> {
    return request<{ rider: Rider }>("/api/riders", {
      method: "POST",
      body: JSON.stringify(riderData)
    });
  },

  // Master Data
  async getMasterData(): Promise<ApiResponse<MasterData>> {
    return request<MasterData>("/api/master-data");
  },

  async updateMasterData(payload: Partial<MasterData>): Promise<ApiResponse<MasterData>> {
    return request<MasterData>("/api/master-data", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  // Orders
  async getOrders(params: {
    page?: number;
    limit?: number;
    search?: string;
    city?: string;
    zone?: string;
    status?: string;
    rider_id?: string;
    import_batch_id?: string;
    date?: string;
    delivery_channel?: string;
  } = {}): Promise<ApiResponse<OrdersResponse>> {
    const query = new URLSearchParams();
    if (params.page) query.append("page", params.page.toString());
    if (params.limit) query.append("limit", params.limit.toString());
    if (params.search) query.append("search", params.search);
    if (params.city) query.append("city", params.city);
    if (params.zone) query.append("zone", params.zone);
    if (params.status) query.append("status", params.status);
    if (params.rider_id) query.append("rider_id", params.rider_id);
    if (params.import_batch_id) query.append("import_batch_id", params.import_batch_id);
    if (params.date) query.append("date", params.date);
    if (params.delivery_channel) query.append("delivery_channel", params.delivery_channel);

    return request<OrdersResponse>(`/api/orders?${query.toString()}`);
  },

  async getOrderById(id: string): Promise<ApiResponse<Order>> {
    return request<Order>(`/api/orders/${encodeURIComponent(id)}`);
  },

  async updateOrderStatus(orderId: string, statusOrPayload: any, notes?: string): Promise<ApiResponse<any>> {
    let payload: any = {};
    if (typeof statusOrPayload === 'string') {
      payload = { status: statusOrPayload, reason: notes };
    } else {
      payload = { ...statusOrPayload };
    }
    payload.packageId = payload.packageId || orderId;
    return request<any>("/api/delivery/attempt", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async bulkAssignOrders(orderIds: string[] | any, riderId?: string): Promise<ApiResponse<any>> {
    let list: string[] = [];
    let targetRider = riderId;
    if (Array.isArray(orderIds)) {
      list = orderIds;
    } else if (orderIds && typeof orderIds === 'object') {
      list = orderIds.packageIds || orderIds.package_ids || orderIds.order_ids || orderIds.orderIds || [];
      targetRider = targetRider || orderIds.riderId || orderIds.rider_id;
    }
    return request<any>("/api/dispatch/bulk-assign", {
      method: "POST",
      body: JSON.stringify({ packageIds: list, riderId: targetRider })
    });
  },

  // Dispatch Assignment & Transfers
  async assignPackage(packageId: string, riderId: string): Promise<ApiResponse<any>> {
    return request<any>("/api/dispatch/assign", {
      method: "POST",
      body: JSON.stringify({ packageId, riderId })
    });
  },

  async transferAssignment(payload: {
    packageId: string;
    sourceRiderId: string;
    destinationRiderId: string;
    transferReason: string;
    sourceConfirmed?: boolean;
    destinationAccepted?: boolean;
  }): Promise<ApiResponse<any>> {
    return request<any>("/api/dispatch/transfer", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  // Dispatch Runs
  async getDispatchRuns(): Promise<ApiResponse<any[]>> {
    return request<any[]>("/api/dispatch/runs");
  },

  async getDispatchBatches(): Promise<ApiResponse<any[]>> {
    return this.getDispatchRuns();
  },

  async getMyDispatchRun(): Promise<ApiResponse<any>> {
    return request<any>("/api/dispatch/runs/me");
  },

  async createDispatchRun(payload: {
    riderId: string;
    vehicle?: string;
    shift?: string;
    dispatchDate?: string;
    packageIds: string[];
  }): Promise<ApiResponse<any>> {
    return request<any>("/api/dispatch/runs", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async createDispatchBatch(payload: any): Promise<ApiResponse<any>> {
    const pkgIds = payload.packageIds || payload.order_ids || payload.orderIds || [];
    return this.createDispatchRun({
      riderId: payload.riderId || payload.rider_id,
      vehicle: payload.vehicle,
      shift: payload.shift,
      dispatchDate: payload.dispatchDate || payload.dispatch_date,
      packageIds: pkgIds
    });
  },

  async updateDispatchRun(runId: string, updates: any): Promise<ApiResponse<any>> {
    return request<any>(`/api/dispatch/runs/${encodeURIComponent(runId)}`, {
      method: "PATCH",
      body: JSON.stringify(updates)
    });
  },

  async riderScanRun(runId: string, packageBarcode: string): Promise<ApiResponse<any>> {
    return request<any>(`/api/dispatch/runs/${encodeURIComponent(runId)}/rider-scan`, {
      method: "POST",
      body: JSON.stringify({ packageBarcode })
    });
  },

  async acceptDispatchRun(runId: string, discrepancyOverrideReason?: string): Promise<ApiResponse<any>> {
    return request<any>(`/api/dispatch/runs/${encodeURIComponent(runId)}/accept`, {
      method: "POST",
      body: JSON.stringify({ discrepancyOverrideReason })
    });
  },

  async reportManifestDiscrepancy(runId: string, payload: { note?: string; expectedPackages?: string[]; scannedPackages?: string[] } = {}): Promise<ApiResponse<any>> {
    return request<any>(`/api/dispatch/runs/${encodeURIComponent(runId)}/manifest-discrepancies/report`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async endDispatchRunShift(runId: string): Promise<ApiResponse<any>> {
    return request<any>(`/api/dispatch/runs/${encodeURIComponent(runId)}/end-shift`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },

  // Custody Scanning
  async scanCustody(payload: {
    packageBarcode: string;
    scanStage: string;
    runId?: string;
  }): Promise<ApiResponse<any>> {
    return request<any>("/api/dispatch/scan", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  // Delivery Attempts
  async recordDeliveryAttempt(payload: {
    packageId: string;
    status: string;
    collectedAmount?: number;
    paymentMethod?: string;
    receiverName?: string;
    receiverRelationship?: string;
    deviceTimestamp?: string;
    gpsPermissionState?: string;
    proofStatus?: string;
    reason?: string;
    riderNotes?: string;
    newDeliveryDate?: string;
    proofStoragePath?: string;
  }): Promise<ApiResponse<any>> {
    return request<any>("/api/delivery/attempt", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async recordDeliveryContactEvent(payload: {
    packageId: string;
    method: 'CALL' | 'WHATSAPP';
    outcome: 'ANSWERED' | 'NO_ANSWER' | 'PHONE_OFF' | 'INVALID_NUMBER' | 'CALLBACK_REQUESTED';
    notes?: string;
  }): Promise<ApiResponse<any>> {
    return request<any>("/api/delivery/contact-events", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async getDeliveryHistory(): Promise<ApiResponse<any[]>> {
    return request<any[]>("/api/delivery/history");
  },

  // Import Batches & OMS Parser
  async getImportBatches(): Promise<ApiResponse<ImportBatch[]>> {
    return request<ImportBatch[]>("/api/import-batches");
  },

  async validateCsvImport(csvContentOrPayload: any, fileName?: string): Promise<ApiResponse<any>> {
    const bodyPayload = typeof csvContentOrPayload === 'string'
      ? { csvContent: csvContentOrPayload, fileName }
      : csvContentOrPayload;
    return request<any>("/api/import/validate", {
      method: "POST",
      body: JSON.stringify(bodyPayload)
    });
  },

  async validateCSVImport(csvContentOrPayload: any, fileName?: string): Promise<ApiResponse<any>> {
    return this.validateCsvImport(csvContentOrPayload, fileName);
  },

  async commitCsvImport(batchIdOrPayload: any): Promise<ApiResponse<any>> {
    const bodyPayload = typeof batchIdOrPayload === 'string'
      ? { batchId: batchIdOrPayload }
      : batchIdOrPayload;
    return request<any>("/api/import/commit", {
      method: "POST",
      body: JSON.stringify(bodyPayload)
    });
  },

  async executeCSVImport(batchIdOrPayload: any): Promise<ApiResponse<any>> {
    return this.commitCsvImport(batchIdOrPayload);
  },

  async executeImportBatch(batchIdOrPayload: any): Promise<ApiResponse<any>> {
    return this.commitCsvImport(batchIdOrPayload);
  },

  // COD Allocation
  async getCodAllocationReviews(): Promise<ApiResponse<CODAllocationReview[]>> {
    return request<CODAllocationReview[]>("/api/cod-allocation/reviews");
  },

  async approveCodAllocation(payload: {
    reviewId: string;
    allocations: Array<{ packageId: string; allocatedCod: number }>;
  }): Promise<ApiResponse<any>> {
    return request<any>("/api/cod-allocation/approve", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  // Finance & Settlements
  async getRiderSettlements(): Promise<ApiResponse<any[]>> {
    return request<any[]>("/api/finance/settlements");
  },

  async getMySettlements(): Promise<ApiResponse<any[]>> {
    return request<any[]>("/api/finance/settlements/me");
  },

  async submitRiderSettlement(payload: { declaredCashAmount: number; notes?: string; idempotencyKey?: string }): Promise<ApiResponse<any>> {
    return request<any>("/api/finance/settlements/submit", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async receiveCashierSettlement(payload: { settlementId: string; physicallyReceivedAmount: number; receiptNotes?: string; idempotencyKey?: string }): Promise<ApiResponse<any>> {
    return request<any>("/api/finance/settlements/receive", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async approveSettlementDiscrepancy(payload: { settlementId: string; discrepancyReason?: string; resolutionType: 'RECOVERED_FROM_RIDER' | 'APPROVED_WRITE_OFF' | 'ACCOUNTING_CORRECTION' | 'SYSTEM_CORRECTION'; resolutionReason: string; idempotencyKey?: string }): Promise<ApiResponse<any>> {
    return request<any>("/api/finance/settlements/approve-discrepancy", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async closeSettlement(payload: { settlementId: string }): Promise<ApiResponse<any>> {
    return request<any>("/api/finance/settlements/close", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async reverseTransaction(payload: { transactionId: string; reversalReason: string; idempotencyKey?: string }): Promise<ApiResponse<any>> {
    return request<any>("/api/finance/transactions/reverse", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async createBankDeposit(payload: { bankAccountCode: string; depositedAmount: number; depositReference: string; depositDate?: string; depositSlipStoragePath?: string; idempotencyKey?: string }): Promise<ApiResponse<any>> {
    return request<any>("/api/finance/bank-deposits/create", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async verifyBankDeposit(payload: { bankDepositId: string; status: "verified" | "discrepancy"; discrepancyAmount?: number; discrepancyReason?: string }): Promise<ApiResponse<any>> {
    return request<any>("/api/finance/bank-deposits/verify", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  // Returns & Reverse Logistics
  async getReturnsList(): Promise<ApiResponse<any[]>> {
    return request<any[]>("/api/returns/list");
  },

  async getReturnsWorkspace(): Promise<ApiResponse<any[]>> {
    return request<any[]>("/api/returns/workspace");
  },

  async submitRiderHandback(payload: {
    packageId: string;
    scannedPackageNumber: string;
    returnReason?: string;
    quantity?: number;
    riderNotes?: string;
    handoffEmployee?: string;
    idempotencyKey?: string;
  }): Promise<ApiResponse<any>> {
    return request<any>("/api/returns/rider-handback", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async receiveWarehouseReceipt(payload: {
    packageId: string;
    scannedPackageNumber: string;
    receivedQuantity?: number;
    packageCondition?: string;
    restockable?: boolean;
    conditionNotes?: string;
    idempotencyKey?: string;
  }): Promise<ApiResponse<any>> {
    return request<any>("/api/returns/warehouse-receipt", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async getMyRiderSettlements(): Promise<ApiResponse<any[]>> {
    return request<any[]>("/api/finance/settlements/me");
  },

  async getFinancialSummary(): Promise<ApiResponse<any>> {
    return request<any>("/api/finance/reports/summary");
  },

  async getExternalCourierShipments(): Promise<ApiResponse<any[]>> {
    return disabledModuleResponse();
  },

  async reconcileSettlement(payload?: any): Promise<ApiResponse<any>> {
    return disabledModuleResponse();
  },

  // Analytics
  async getAnalyticsSummary(): Promise<ApiResponse<AnalyticsSummary>> {
    return request<AnalyticsSummary>("/api/analytics/summary");
  },

  // Shopify Direct Integration
  async getShopifyStatus(): Promise<ApiResponse<{ configured: boolean; storeDomain: string | null; apiVersion: string; message?: string }>> {
    return request<{ configured: boolean; storeDomain: string | null; apiVersion: string; message?: string }>("/api/shopify/status");
  },

  async testShopifyConnection(): Promise<ApiResponse<{ shopName?: string; email?: string; currency?: string; domain?: string; country?: string }>> {
    return request<{ shopName?: string; email?: string; currency?: string; domain?: string; country?: string }>("/api/shopify/test-connection", {
      method: "POST"
    });
  },

  async previewShopifyOrders(options: { limit?: number; status?: string; fulfillmentStatus?: string } = {}): Promise<ApiResponse<{
    totalShopifyOrders: number;
    newOrdersCount: number;
    duplicateOrdersCount: number;
    conflictCount: number;
    totalOrderAmount: number;
    totalExpectedCod: number;
    prepaidCount: number;
    codCount: number;
    internalRiderCount: number;
    externalCourierCount: number;
    storeDomain?: string;
    orders: Array<any>;
  }>> {
    return request("/api/shopify/preview", {
      method: "POST",
      body: JSON.stringify(options)
    });
  },

  async syncShopifyOrders(options: { limit?: number; status?: string; fulfillmentStatus?: string } = {}): Promise<ApiResponse<{
    syncRunId: string;
    totalFetched: number;
    created: number;
    updated: number;
    skippedDuplicates: number;
    conflicts: number;
    storeDomain?: string;
    status: string;
  }>> {
    return request("/api/shopify/sync", {
      method: "POST",
      body: JSON.stringify(options)
    });
  },

  // Disabled Modules
  async getCourierReconciliation(): Promise<ApiResponse<any>> {
    return disabledModuleResponse();
  },

  async getProofOfDelivery(): Promise<ApiResponse<any>> {
    return disabledModuleResponse();
  },

  async syncExternalCourier(): Promise<ApiResponse<any>> {
    return disabledModuleResponse();
  },

  async runScaleTest(): Promise<ApiResponse<any>> {
    return disabledModuleResponse();
  }
};
