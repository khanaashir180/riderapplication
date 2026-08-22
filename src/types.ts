export type UserRole =
  | 'super_admin'
  | 'dispatch_manager'
  | 'rider'
  | 'cashier'
  | 'customer_service'
  | 'warehouse_staff'
  | 'management_viewer';

/**
 * CANONICAL OPERATIONAL STATUS ENUM
 * Used as single source of truth across all operational workflows
 */
export type OperationalStatus =
  | 'IMPORTED_REVIEW'
  | 'READY_FOR_DISPATCH'
  | 'ASSIGNED'
  | 'DISPATCHER_SCANNED'
  | 'RIDER_SCANNED'
  | 'RIDER_ACCEPTED'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'CUSTOMER_UNAVAILABLE'
  | 'RESCHEDULED'
  | 'REFUSED'
  | 'ADDRESS_ISSUE'
  | 'CANCELLED'
  | 'RETURN_REQUIRED'
  | 'RIDER_RETURNING'
  | 'RIDER_HANDBACK'
  | 'WAREHOUSE_RECEIVED'
  | 'CLOSED';

export const CANONICAL_OPERATIONAL_STATUSES: Record<OperationalStatus, { label: string; stage: string; color: string }> = {
  IMPORTED_REVIEW: { label: 'Imported / Review', stage: 'intake', color: 'bg-amber-100 text-amber-800' },
  READY_FOR_DISPATCH: { label: 'Ready for Dispatch', stage: 'staged', color: 'bg-blue-100 text-blue-800' },
  ASSIGNED: { label: 'Assigned to Rider', stage: 'assigned', color: 'bg-indigo-100 text-indigo-800' },
  DISPATCHER_SCANNED: { label: 'Dispatcher Scanned', stage: 'custody', color: 'bg-purple-100 text-purple-800' },
  RIDER_SCANNED: { label: 'Rider Scanned', stage: 'custody', color: 'bg-cyan-100 text-cyan-800' },
  RIDER_ACCEPTED: { label: 'Rider Accepted', stage: 'custody', color: 'bg-sky-100 text-sky-800' },
  OUT_FOR_DELIVERY: { label: 'Out for Delivery', stage: 'in_transit', color: 'bg-yellow-100 text-yellow-800' },
  DELIVERED: { label: 'Delivered', stage: 'completed', color: 'bg-emerald-100 text-emerald-800' },
  CUSTOMER_UNAVAILABLE: { label: 'Customer Unavailable', stage: 'failed', color: 'bg-orange-100 text-orange-800' },
  RESCHEDULED: { label: 'Rescheduled', stage: 'rescheduled', color: 'bg-violet-100 text-violet-800' },
  REFUSED: { label: 'Customer Refused', stage: 'failed', color: 'bg-red-100 text-red-800' },
  ADDRESS_ISSUE: { label: 'Address Issue', stage: 'exception', color: 'bg-rose-100 text-rose-800' },
  CANCELLED: { label: 'Cancelled', stage: 'terminal', color: 'bg-zinc-100 text-zinc-800' },
  RETURN_REQUIRED: { label: 'Return Required', stage: 'return', color: 'bg-orange-100 text-orange-900' },
  RIDER_RETURNING: { label: 'Rider Returning', stage: 'return', color: 'bg-amber-100 text-amber-900' },
  RIDER_HANDBACK: { label: 'Rider Handed Back', stage: 'return', color: 'bg-teal-100 text-teal-800' },
  WAREHOUSE_RECEIVED: { label: 'Warehouse Received', stage: 'return', color: 'bg-emerald-100 text-emerald-900' },
  CLOSED: { label: 'Closed', stage: 'terminal', color: 'bg-slate-100 text-slate-800' }
};

/**
 * Standard UI status formatter
 */
export function formatOperationalStatus(status?: string): string {
  if (!status) return 'Unknown';
  const clean = status.trim().toUpperCase().replace(/[\s-]+/g, '_') as OperationalStatus;
  if (CANONICAL_OPERATIONAL_STATUSES[clean]) {
    return CANONICAL_OPERATIONAL_STATUSES[clean].label;
  }
  // Legacy status string fallback formatting
  return status
    .replace(/[_\-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Canonical legal status transition validator
 */
export function isValidStatusTransition(fromStatus: string, toStatus: string): boolean {
  const from = (fromStatus || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const to = (toStatus || '').trim().toUpperCase().replace(/[\s-]+/g, '_');

  if (from === to) return true;

  // Terminal states cannot transition to active states
  if (from === 'CLOSED' || from === 'CANCELLED') {
    return false;
  }
  if (from === 'DELIVERED' && to !== 'CLOSED') {
    return false;
  }

  const legalTransitions: Record<string, string[]> = {
    IMPORTED_REVIEW: ['READY_FOR_DISPATCH', 'ASSIGNED', 'ADDRESS_ISSUE', 'CANCELLED'],
    READY_FOR_DISPATCH: ['ASSIGNED', 'DISPATCHER_SCANNED', 'CANCELLED', 'ADDRESS_ISSUE'],
    ASSIGNED: ['DISPATCHER_SCANNED', 'RIDER_SCANNED', 'RIDER_ACCEPTED', 'OUT_FOR_DELIVERY', 'READY_FOR_DISPATCH', 'CANCELLED'],
    DISPATCHER_SCANNED: ['RIDER_SCANNED', 'RIDER_ACCEPTED', 'OUT_FOR_DELIVERY', 'ASSIGNED'],
    RIDER_SCANNED: ['RIDER_ACCEPTED', 'OUT_FOR_DELIVERY', 'DISPATCHER_SCANNED'],
    RIDER_ACCEPTED: ['OUT_FOR_DELIVERY', 'DELIVERED', 'CUSTOMER_UNAVAILABLE', 'RESCHEDULED', 'REFUSED', 'ADDRESS_ISSUE', 'RETURN_REQUIRED', 'RIDER_RETURNING'],
    OUT_FOR_DELIVERY: ['DELIVERED', 'CUSTOMER_UNAVAILABLE', 'RESCHEDULED', 'REFUSED', 'ADDRESS_ISSUE', 'CANCELLED', 'RETURN_REQUIRED', 'RIDER_RETURNING', 'RIDER_HANDBACK'],
    CUSTOMER_UNAVAILABLE: ['RESCHEDULED', 'READY_FOR_DISPATCH', 'ASSIGNED', 'RETURN_REQUIRED', 'RIDER_RETURNING', 'RIDER_HANDBACK', 'WAREHOUSE_RECEIVED'],
    RESCHEDULED: ['READY_FOR_DISPATCH', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'RETURN_REQUIRED', 'RIDER_RETURNING'],
    REFUSED: ['RETURN_REQUIRED', 'RIDER_RETURNING', 'RIDER_HANDBACK', 'WAREHOUSE_RECEIVED'],
    ADDRESS_ISSUE: ['READY_FOR_DISPATCH', 'ASSIGNED', 'CANCELLED', 'RETURN_REQUIRED'],
    RETURN_REQUIRED: ['RIDER_RETURNING', 'RIDER_HANDBACK', 'WAREHOUSE_RECEIVED'],
    RIDER_RETURNING: ['RIDER_HANDBACK', 'WAREHOUSE_RECEIVED'],
    RIDER_HANDBACK: ['WAREHOUSE_RECEIVED', 'CLOSED'],
    WAREHOUSE_RECEIVED: ['CLOSED', 'READY_FOR_DISPATCH', 'ASSIGNED'],
    DELIVERED: ['CLOSED'],
    CANCELLED: ['CLOSED'],
    CLOSED: []
  };

  const allowed = legalTransitions[from];
  return allowed ? allowed.includes(to) : true;
}

export type OrderStatus =
  | 'Imported'
  | 'Awaiting Assignment'
  | 'Assigned'
  | 'Picked Up'
  | 'Out for Delivery'
  | 'Customer Contacted'
  | 'Delivered'
  | 'Customer Unavailable'
  | 'Rescheduled'
  | 'Refused'
  | 'Incorrect Address'
  | 'Exchange Requested'
  | 'Returning to Warehouse'
  | 'Returned to Warehouse'
  | 'Cancelled'
  | OperationalStatus;

export type SettlementStatus =
  | 'Open'
  | 'Submitted by Rider'
  | 'Received by Cashier'
  | 'Discrepancy'
  | 'Approved'
  | 'Closed'
  | 'open'
  | 'rider_submitted'
  | 'cashier_received'
  | 'matched'
  | 'discrepancy'
  | 'resolved'
  | 'manager_approved'
  | 'closed';

export interface CustomerContactEvent {
  id?: string;
  timestamp: string;
  method: 'CALL' | 'WHATSAPP' | 'SMS';
  result: 'ANSWERED' | 'NO_ANSWER' | 'PHONE_OFF' | 'INVALID_NUMBER' | 'CALLBACK_REQUESTED';
  callerUid?: string;
  notes?: string;
}

export interface DeliveryProof {
  latitude: number;
  longitude: number;
  receiverName: string;
  receiverRelationship: string;
  collectedAmount?: number;
  proofImageUrl?: string;
  proofStoragePath?: string;
  digitalReference?: string;
  timestamp: string;
}

/**
 * CANONICAL PACKAGE DTO
 * Primary data contract across all layers (Shopify, CSV, Dispatch, Rider, Returns, Finance)
 */
export interface Package {
  id: string;
  packageId: string;
  parentOrderId: string;
  externalOrderId?: string;
  orderNumber?: string;
  packageNumber: string;
  packageSuffix?: string;

  source: 'SHOPIFY' | 'CSV' | 'MANUAL';

  customerName: string;
  customerPhone: string;
  alternatePhone?: string;
  deliveryAddress: string;
  city: string;
  province?: string;
  zone?: string;
  latitude?: number;
  longitude?: number;
  customerNotes?: string;
  deliveryInstructions?: string;

  orderAmount: number;
  codExpected: number;
  amountPaid?: number;
  collectedAmount?: number;
  paymentMethod: string;
  paymentStatus?: 'pending' | 'paid' | 'cod';

  operationalStatus: OperationalStatus;
  currentStatus: string;
  deliveryChannel?: DeliveryChannel;

  assignedRiderId?: string | null;
  dispatchRunId?: string | null;
  routeSequence?: number;

  locked?: boolean;
  lockReason?: string;

  importState: 'committed' | 'staged' | 'pending_review';
  importBatchId?: string;
  syncRunId?: string;

  deliveryAttempts?: DeliveryAttempt[];
  contactEvents?: CustomerContactEvent[];
  deliveryProof?: DeliveryProof;

  itemSummary?: string;
  items?: any[];

  createdAt: string;
  updatedAt: string;

  // Legacy field aliases for seamless backwards-compatibility
  original_order_number?: string;
  parent_order_number?: string;
  parentOrderNumber?: string;
  package_number?: string;
  customer_name?: string;
  customer_phone?: string;
  contact_number?: string;
  primaryPhone?: string;
  alternate_contact_number?: string;
  address?: string;
  delivery_address?: string;
  shippingAddress?: string;
  expectedCod?: number;
  cod_expected?: number;
  total_amount?: number;
  packageTotal?: number;
  current_status?: string;
  payment_method?: string;
  delivery_channel?: DeliveryChannel;
  assigned_rider_id?: string;
  dispatch_batch_id?: string;
  dispatch_id?: string;
  custodyStage?: string;
  custody_stage?: string;
  promised_delivery_date?: string;
  promisedDeliveryDate?: string;
  order_date?: string;
  customer_notes?: string;
  internal_notes?: string;
  proof_image_url?: string;
  failure_reason?: string;
  next_attempt_date?: string;
  tracking_number?: string;
  courier_tracking_number?: string;
  courier_company?: string;
  captured_amount?: number;
  rider?: Rider;
  order_items?: OrderItem[];
  delivery_attempts?: DeliveryAttempt[];
  status_history?: StatusHistory[];
  cod_collection?: CODCollection;
  created_at?: string;
  updated_at?: string;
}

/**
 * Canonical normalizer function to ensure consistent access across all components
 */
export function normalizePackage(raw: any): Package {
  if (!raw) {
    return {
      id: '',
      packageId: '',
      parentOrderId: '',
      packageNumber: '',
      source: 'MANUAL',
      customerName: '',
      customerPhone: '',
      deliveryAddress: '',
      city: '',
      orderAmount: 0,
      codExpected: 0,
      paymentMethod: 'COD',
      operationalStatus: 'IMPORTED_REVIEW',
      currentStatus: 'Imported',
      importState: 'committed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  const pkgId = raw.id || raw.packageId || raw.package_id || '';
  const pkgNum = raw.packageNumber || raw.package_number || raw.id || '';
  const parentNum = raw.parentOrderNumber || raw.parent_order_number || raw.parentOrderId || raw.original_order_number || raw.order_number || pkgNum;
  const custName = raw.customerName || raw.customer_name || raw.recipient_name || 'Customer';
  const phone = raw.customerPhone || raw.primaryPhone || raw.contact_number || raw.phone || '';
  const altPhone = raw.alternatePhone || raw.fallbackPhone || raw.alternate_contact_number || '';
  const addr = raw.deliveryAddress || raw.shippingAddress || raw.address || raw.delivery_address || raw.addressLine1 || '';
  const city = raw.city || '';
  const prov = raw.province || '';
  const zone = raw.zone || raw.assignedZone || '';

  const rawCod = raw.codExpected !== undefined
    ? raw.codExpected
    : (raw.expectedCod !== undefined
      ? raw.expectedCod
      : (raw.cod_expected !== undefined ? raw.cod_expected : (raw.packageTotal || raw.orderAmount || 0)));
  const codExpected = Number(rawCod) || 0;

  const orderAmount = Number(raw.orderAmount || raw.packageTotal || raw.total_amount || codExpected) || 0;
  const collectedAmount = raw.collectedAmount !== undefined ? Number(raw.collectedAmount) : (raw.amountPaid !== undefined ? Number(raw.amountPaid) : undefined);

  const rawStatus = raw.operationalStatus || raw.current_status || raw.currentStatus || 'IMPORTED_REVIEW';
  let normStatus: OperationalStatus = 'IMPORTED_REVIEW';

  const statusStr = String(rawStatus).toUpperCase().replace(/[\s-]+/g, '_');
  if (statusStr in CANONICAL_OPERATIONAL_STATUSES) {
    normStatus = statusStr as OperationalStatus;
  } else if (statusStr === 'DISPATCHED' || statusStr === 'PICKED_UP' || statusStr === 'IN_TRANSIT') {
    normStatus = 'OUT_FOR_DELIVERY';
  } else if (statusStr === 'IMPORTED' || statusStr === 'AWAITING_ASSIGNMENT' || statusStr === 'UNASSIGNED' || statusStr === 'STAGED') {
    normStatus = 'IMPORTED_REVIEW';
  } else if (statusStr === 'INCORRECT_ADDRESS') {
    normStatus = 'ADDRESS_ISSUE';
  } else if (statusStr === 'RETURNING_TO_WAREHOUSE' || statusStr === 'COURIER_RETURNING') {
    normStatus = 'RIDER_RETURNING';
  } else if (statusStr === 'RETURNED' || statusStr === 'RETURNED_TO_WAREHOUSE') {
    normStatus = 'WAREHOUSE_RECEIVED';
  }

  const assignedRiderId = raw.assignedRiderId || raw.assigned_rider_id || raw.riderId || raw.rider_id || null;
  const dispatchRunId = raw.dispatchRunId || raw.dispatch_batch_id || raw.runId || null;
  const importState = raw.importState || 'committed';
  const source = (raw.source || (raw.shopifyId ? 'SHOPIFY' : 'MANUAL')).toUpperCase() as 'SHOPIFY' | 'CSV' | 'MANUAL';

  const now = new Date().toISOString();
  const createdAt = raw.createdAt || raw.created_at || raw.orderCreatedAt || now;
  const updatedAt = raw.updatedAt || raw.updated_at || now;

  return {
    ...raw,
    id: pkgId,
    packageId: pkgId,
    parentOrderId: parentNum,
    externalOrderId: raw.externalOrderId || raw.shopifyId || undefined,
    orderNumber: parentNum,
    packageNumber: pkgNum,
    packageSuffix: raw.packageSuffix || raw.package_suffix,
    source,
    customerName: custName,
    customerPhone: phone,
    alternatePhone: altPhone || undefined,
    deliveryAddress: addr,
    city,
    province: prov || undefined,
    zone: zone || undefined,
    latitude: raw.latitude,
    longitude: raw.longitude,
    customerNotes: raw.customerNotes || raw.customer_notes || raw.specialInstructions || raw.deliveryInstructions || '',
    deliveryInstructions: raw.deliveryInstructions || raw.delivery_instructions || '',
    orderAmount,
    codExpected,
    amountPaid: collectedAmount,
    collectedAmount,
    paymentMethod: raw.paymentMethod || raw.payment_method || 'COD',
    paymentStatus: raw.paymentStatus || (codExpected === 0 ? 'paid' : 'cod'),
    operationalStatus: normStatus,
    currentStatus: CANONICAL_OPERATIONAL_STATUSES[normStatus]?.label || normStatus,
    deliveryChannel: raw.deliveryChannel || raw.delivery_channel || (!city.trim() ? 'Unassigned' : (city.toLowerCase() === 'lahore' || city.toLowerCase() === 'karachi' ? 'Internal Rider' : 'External Courier')),
    assignedRiderId,
    dispatchRunId,
    routeSequence: raw.routeSequence,
    locked: raw.locked || false,
    lockReason: raw.lockReason || raw.lock_reason,
    importState,
    importBatchId: raw.importBatchId || raw.import_batch_id,
    syncRunId: raw.syncRunId,
    deliveryAttempts: raw.deliveryAttempts || raw.delivery_attempts || [],
    contactEvents: raw.contactEvents || raw.contact_events || [],
    deliveryProof: raw.deliveryProof,
    itemSummary: raw.itemSummary || raw.item_summary || '',
    items: raw.items || raw.order_items || [],
    createdAt,
    updatedAt,

    // Legacy fields
    original_order_number: parentNum,
    parent_order_number: parentNum,
    parentOrderNumber: parentNum,
    package_number: pkgNum,
    customer_name: custName,
    contact_number: phone,
    primaryPhone: phone,
    address: addr,
    delivery_address: addr,
    shippingAddress: addr,
    expectedCod: codExpected,
    cod_expected: codExpected,
    total_amount: orderAmount,
    packageTotal: orderAmount,
    current_status: CANONICAL_OPERATIONAL_STATUSES[normStatus]?.label || normStatus,
    assigned_rider_id: assignedRiderId || undefined,
    dispatch_batch_id: dispatchRunId || undefined,
    custodyStage: raw.custodyStage || raw.custody_stage || (normStatus === 'ASSIGNED' ? 'assigned_to_rider' : undefined),
    custody_stage: raw.custodyStage || raw.custody_stage || (normStatus === 'ASSIGNED' ? 'assigned_to_rider' : undefined)
  };
}

export type Order = Package;

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

export interface Profile {
  id: string;
  full_name?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  role: UserRole;
  active: boolean;
  created_at?: string;
  createdAt?: string;
  avatar?: string;
}

export interface Rider {
  id: string;
  profile_id?: string;
  profileId?: string;
  full_name?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  rider_code?: string;
  vehicle_type?: 'Motorbike' | 'Cargo Rickshaw' | 'Van' | 'Bicycle';
  registration_number?: string;
  maximum_daily_capacity?: number;
  assigned_zone?: string;
  active?: boolean;
  profile?: Profile;
  assigned_count?: number;
  delivered_count?: number;
  pending_count?: number;
  cod_held?: number;
}

export type DeliveryChannel =
  | 'Internal Rider'
  | 'External Courier'
  | 'Outlet Delivery'
  | 'Internal Transfer'
  | 'Unassigned';

export type PaymentMethodType =
  | 'Cash'
  | 'JazzCash'
  | 'Easypaisa'
  | 'Bank transfer'
  | 'Card or prepaid'
  | 'External courier receivable';

export type LedgerEntryType =
  | 'COD_EXPECTED'
  | 'COD_COLLECTED'
  | 'RIDER_SUBMISSION'
  | 'CASHIER_RECEIPT'
  | 'DIGITAL_PAYMENT_VERIFICATION'
  | 'BANK_DEPOSIT'
  | 'DISCREPANCY'
  | 'MANAGER_APPROVED_ADJUSTMENT'
  | 'REVERSAL';

export interface CODLedgerEntry {
  id: string;
  entry_type: LedgerEntryType;
  order_id?: string;
  parent_order_number?: string;
  rider_id?: string;
  settlement_id?: string;
  amount: number;
  payment_method: PaymentMethodType;
  txn_reference?: string;
  is_reversal?: boolean;
  reversal_of_entry_id?: string;
  performed_by: string;
  performed_by_name?: string;
  notes?: string;
  created_at: string;
}

export interface CustodyScan {
  id: string;
  order_id: string;
  package_number: string;
  scan_stage: 'Warehouse Preparation' | 'Dispatcher Handoff' | 'Rider Acceptance' | 'Doorstep Delivery' | 'Return Handoff' | 'Warehouse Return Receipt';
  expected_qty: number;
  scanned_qty: number;
  discrepancy_count: number;
  scanned_by: string;
  scanned_by_name?: string;
  scanned_at: string;
  notes?: string;
  matched_order?: any;
}

export interface MasterData {
  cities: string[];
  zones: Record<string, string[]>;
  riders: Rider[];
  vehicles: string[];
  delivery_statuses: string[];
  failure_reasons: string[];
  return_reasons: string[];
  payment_methods: string[];
  courier_companies: string[];
  shift_definitions: string[];
}

export interface CODAllocationReview {
  id?: string;
  importBatchId?: string;
  parent_order_number: string;
  parentOrderNumber?: string;
  parent_total: number;
  parentTotal?: number;
  parent_captured: number;
  parentCaptured?: number;
  parent_balance?: number;
  remaining_balance?: number;
  remainingBalance?: number;
  packages: Array<{
    order_id?: string;
    order_number?: string;
    packageId?: string;
    packageNumber?: string;
    current_cod_allocated?: number;
    allocatedCod?: number;
    current_status?: OrderStatus;
  }>;
  allocated?: boolean;
  status?: string;
}

export interface OrderItem {
  id: string;
  sku: string;
  title: string;
  quantity: number;
  unit_price: number;
}

export interface ExternalCourierShipment {
  id: string;
  order_id: string;
  courier_company: string;
  tracking_number: string;
  dispatch_date: string;
  cod_receivable: number;
  remittance_status: 'Pending' | 'Remitted' | 'Disputed';
  remitted_amount?: number;
  remitted_at?: string;
}

export interface ScaleTestResult {
  total_rows_imported: number;
  import_duration_ms: number;
  total_packages_stored: number;
  concurrent_dispatchers: number;
  simulated_rider_sessions: number;
  memory_usage_mb: number;
  lock_tests_passed: boolean;
  rls_tests_passed: boolean;
  timestamp: string;
}

export interface ImportBatch {
  id: string;
  file_name: string;
  fileName?: string;
  file_checksum: string;
  storage_path?: string;
  uploaded_by?: string;
  total_rows?: number;
  sourceRowCount?: number;
  uniquePackageCount?: number;
  packageItemCount?: number;
  valid_rows?: number;
  warning_rows?: number;
  rejected_rows?: number;
  imported_rows?: number;
  created_at: string;
  createdAt?: string;
  status?: string;
  uploader_name?: string;
  rejected_data?: Array<{ row_number: number; raw_data: any; reason: string }>;
}

export interface DispatchBatch {
  id: string;
  batch_number: string;
  dispatch_date: string;
  shift: 'Morning' | 'Evening';
  rider_id: string;
  created_by: string;
  package_count: number;
  expected_cod: number;
  status: 'Draft' | 'Handed Over' | 'In Transit' | 'Reconciled';
  handed_to_rider_at?: string;
  handed_to_rider_by?: string;
  rider?: Rider;
}

export interface Assignment {
  id: string;
  order_id: string;
  rider_id: string;
  dispatch_batch_id?: string;
  assigned_by: string;
  assigned_at: string;
  picked_up_at?: string;
  completed_at?: string;
  active: boolean;
}

export interface DeliveryAttempt {
  id: string;
  order_id: string;
  rider_id: string;
  attempt_number: number;
  status: OrderStatus;
  reason?: string;
  rider_notes?: string;
  customer_contacted: boolean;
  attempted_at: string;
  latitude?: number;
  longitude?: number;
  proof_storage_path?: string;
  next_attempt_date?: string;
}

export interface CODCollection {
  id: string;
  order_id: string;
  rider_id: string;
  expected_amount: number;
  collected_amount: number;
  collection_method: 'Cash' | 'Easypaisa' | 'JazzCash' | 'Bank Transfer' | 'POS Card';
  collected_at: string;
  notes?: string;
}

export interface RiderSettlement {
  id: string;
  settlementNumber?: string;
  settlement_number?: string;
  riderId: string;
  rider_id?: string;
  dispatchRunId?: string;
  dispatch_batch_id?: string;
  settlementDate: string;
  settlement_date?: string;
  shift?: string;

  // Mandatory canonical financial fields
  calculatedCashObligation: number;
  declaredCashAmount: number;
  physicallyReceivedAmount: number;
  riderHandoverVariance: number;
  cashierVariance: number;
  totalSettlementVariance: number;

  status: SettlementStatus;

  // Discrepancy details
  discrepancyType?: 'NONE' | 'SHORT' | 'EXCESS' | 'DECLARATION_MISMATCH';
  discrepancyAmount?: number;
  discrepancyReason?: string;
  resolutionType?: 'RECOVERED_FROM_RIDER' | 'APPROVED_WRITE_OFF' | 'ACCOUNTING_CORRECTION' | 'SYSTEM_CORRECTION' | 'OTHER_APPROVED';
  resolutionReason?: string;
  resolutionApprovedBy?: string;
  resolutionApprovedAt?: string;
  evidenceReference?: string;

  // Audit metadata
  submittedBy?: string;
  submitted_by?: string;
  submittedAt?: string;
  submitted_at?: string;
  receivedBy?: string;
  received_by?: string;
  receivedAt?: string;
  received_at?: string;
  approvedBy?: string;
  approved_by?: string;
  approvedAt?: string;
  approved_at?: string;
  receiptNotes?: string;
  notes?: string;
  idempotencyKey?: string;

  rider?: Rider;
  submitted_by_profile?: Profile;
  received_by_profile?: Profile;

  // Backwards compatibility legacy aliases
  expected_cod?: number;
  rider_reported_amount?: number;
  cashier_received_amount?: number;
  difference_amount?: number;
  discrepancy_reason?: string;
  settlement_status?: SettlementStatus;
}

export interface ReturnRecord {
  id: string;
  order_id: string;
  rider_id: string;
  return_reason: string;
  return_notes?: string;
  returned_to_warehouse: boolean;
  warehouse_received_by?: string;
  warehouse_received_at?: string;
  next_action?: 'Reattempt' | 'Refused' | 'Return to Merchant Inventory' | 'Exchange';
  created_at: string;
  order?: Order;
}

export interface StatusHistory {
  id: string;
  order_id: string;
  old_status?: OrderStatus;
  new_status: OrderStatus;
  changed_by: string;
  changed_at: string;
  notes?: string;
  changed_by_name?: string;
}

export interface AuditLog {
  id: string;
  user_id: string;
  user_name?: string;
  action: string;
  entity_type: string;
  entity_id: string;
  previous_values?: any;
  new_values?: any;
  created_at: string;
}

export interface FinancialAccount {
  id: string;
  code: string;
  name: string;
  category: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';
  balance: number;
}

export interface FinancialTransaction {
  id: string;
  transaction_date: string;
  reference_type: 'COD_COLLECTION' | 'RIDER_SETTLEMENT' | '3PL_REMITTANCE' | 'BANK_DEPOSIT' | 'DISCREPANCY_ADJUSTMENT';
  reference_id: string;
  description: string;
  created_by: string;
  postings: FinancialPosting[];
}

export interface FinancialPosting {
  id: string;
  transaction_id: string;
  account_id: string;
  account_code: string;
  debit: number;
  credit: number;
  created_at: string;
}

export type AccountType = "asset" | "liability" | "income" | "expense" | "clearing";

export interface FinancialAccountDoc {
  code: string;
  name: string;
  accountType: AccountType;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialTransactionDoc {
  id: string;
  transactionType: string;
  sourceType: string;
  sourceId: string;
  packageId: string | null;
  riderId: string | null;
  cashierProfileId: string | null;
  settlementId: string | null;
  bankDepositId: string | null;
  status: "posted" | "reversed";
  currency: "PKR";
  totalDebit: number;
  totalCredit: number;
  idempotencyKey: string;
  createdByUid: string;
  createdAt: string;
  reversedTransactionId: string | null;
  reversedByUid: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface FinancialPostingDoc {
  id: string;
  transactionId: string;
  accountCode: string;
  debitAmount: number;
  creditAmount: number;
  packageId: string | null;
  riderId: string | null;
  settlementId: string | null;
  bankDepositId: string | null;
  createdAt: string;
}

export interface CODCollectionDoc {
  id: string;
  packageId: string;
  riderId: string;
  expectedCod: number;
  collectedAmount: number;
  paymentMethod: "cash" | "jazzcash" | "easypaisa" | "bank_transfer" | "prepaid";
  digitalReference: string | null;
  collectionVariance: number;
  idempotencyKey: string;
  transactionId: string;
  createdAt: string;
}

export interface DigitalPaymentVerificationDoc {
  id: string;
  digitalReference: string;
  packageId: string;
  paymentMethod: string;
  amount: number;
  status: "pending" | "verified" | "rejected";
  verifiedByUid: string | null;
  createdAt: string;
}

export type SettlementStage =
  | "open"
  | "rider_submitted"
  | "cashier_received"
  | "discrepancy"
  | "manager_approved"
  | "closed";

export interface RiderSettlementDoc {
  id: string;
  settlementNumber: string;
  riderId: string;
  status: SettlementStage;
  calculatedCashObligation: number;
  declaredCashAmount: number;
  physicallyReceivedAmount: number;
  collectionVariance: number;
  riderHandoverVariance: number;
  cashierVariance: number;
  discrepancyAmount: number;
  discrepancyReason: string | null;
  notes: string | null;
  receiptNotes: string | null;
  submittedAt: string | null;
  receivedAt: string | null;
  approvedAt: string | null;
  approvedByUid: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SettlementLineDoc {
  id: string;
  settlementId: string;
  packageId: string;
  collectedAmount: number;
  paymentMethod: string;
  createdAt: string;
}

export interface BankDepositDoc {
  id: string;
  cashierProfileId: string;
  bankAccountCode: string;
  depositedAmount: number;
  depositReference: string;
  depositDate: string;
  depositSlipStoragePath: string | null;
  depositedByUid: string;
  verifiedByUid: string | null;
  verifiedAt: string | null;
  discrepancyAmount: number;
  discrepancyReason: string | null;
  status: "draft" | "submitted" | "verified" | "discrepancy" | "closed";
  createdAt: string;
}

export interface BankDepositLineDoc {
  id: string;
  bankDepositId: string;
  settlementId: string;
  amount: number;
}

export interface FinancialAuditEventDoc {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  actorUid: string;
  details: any;
  createdAt: string;
}

export interface IdempotencyKeyDoc {
  key: string;
  action: string;
  createdAt: string;
}

export type ReturnStatus =
  | "return_requested"
  | "returning_to_warehouse"
  | "rider_handed_back"
  | "warehouse_received"
  | "customer_service_review"
  | "reattempt_scheduled"
  | "exchange_created"
  | "cancelled"
  | "closed";

export interface ReturnDoc {
  id: string;
  packageId: string;
  riderId: string;
  status: ReturnStatus;
  returnReason: string;
  quantity: number;
  riderNotes: string | null;
  handoffEmployee: string | null;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReturnCustodyEventDoc {
  id: string;
  returnId: string;
  packageId: string;
  eventType: string;
  actorUid: string;
  notes: string | null;
  createdAt: string;
}

export type PackageCondition =
  | "sealed"
  | "opened"
  | "damaged"
  | "missing_item"
  | "wrong_item";

export interface ReturnReceiptDoc {
  id: string;
  returnId: string;
  packageId: string;
  scannedPackageNumber: string;
  receivedQuantity: number;
  packageCondition: PackageCondition;
  restockable: boolean;
  conditionNotes: string | null;
  receivedByUid: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface ReattemptRequestDoc {
  id: string;
  packageId: string;
  caseId: string | null;
  newPromisedDeliveryDate: string;
  validAddress: string;
  customerConfirmationStatus: string;
  assignedCsOwner: string;
  reason: string;
  attemptNumber: number;
  status: "pending_approval" | "approved" | "dispatched" | "rejected";
  approvedByUid: string | null;
  createdAt: string;
}

export type CasePriority = "normal" | "high" | "urgent";
export type CaseStatus = "open" | "contacting" | "waiting_customer" | "resolved" | "closed";

export interface CustomerServiceCaseDoc {
  id: string;
  packageId: string;
  customerId: string;
  caseType: string;
  ownerProfileId: string | null;
  priority: CasePriority;
  status: CaseStatus;
  nextActionAt: string | null;
  attemptCount: number;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ContactChannel = "call" | "whatsapp" | "sms" | "email";

export interface CustomerContactAttemptDoc {
  id: string;
  caseId: string;
  packageId: string;
  userUid: string;
  channel: ContactChannel;
  result: string;
  notes: string | null;
  nextAction: string | null;
  createdAt: string;
}

export interface ExchangeDoc {
  id: string;
  originalPackageId: string;
  replacementPackageId: string;
  priceDifference: number;
  additionalCod: number;
  refundAmount: number;
  exchangeReason: string;
  warehouseCondition: string | null;
  csApprovalUid: string;
  status: "pending" | "approved" | "dispatched" | "completed" | "cancelled";
  createdAt: string;
}

export interface CourierShipmentDoc {
  id: string;
  packageId: string;
  courierCompanyId: string;
  trackingNumber: string;
  manifestId: string | null;
  dispatchedAt: string;
  courierStatus: "booked" | "picked_up" | "in_transit" | "out_for_delivery" | "delivered" | "returning" | "returned" | "lost" | "cancelled";
  expectedCod: number;
  deliveredAt: string | null;
  returnedAt: string | null;
  lastSyncedAt: string | null;
}

export interface CourierManifestDoc {
  id: string;
  courierCompanyId: string;
  manifestReference: string;
  dispatchDate: string;
  packageCount: number;
  expectedCod: number;
  preparedByUid: string;
  handedOverByUid: string;
  courierAcknowledgement: string | null;
  status: "draft" | "dispatched" | "acknowledged" | "completed";
  createdAt: string;
}

export interface CourierRemittanceBatchDoc {
  id: string;
  courierCompanyId: string;
  statementReference: string;
  statementDate: string;
  grossCod: number;
  deliveryCharges: number;
  returnCharges: number;
  otherDeductions: number;
  netExpectedRemittance: number;
  actualRemittedAmount: number;
  remittanceDate: string | null;
  bankReference: string | null;
  differenceAmount: number;
  status: "uploaded" | "review" | "matched" | "discrepancy" | "closed";
  createdAt: string;
}

export interface CourierRemittanceLineDoc {
  id: string;
  batchId: string;
  packageId: string;
  trackingNumber: string;
  collectedCod: number;
  deliveryFee: number;
  netAmount: number;
  status: string;
}

export interface CourierDeductionDoc {
  id: string;
  batchId: string | null;
  packageId: string | null;
  deductionType: string;
  amount: number;
  courierExplanation: string;
  approvedByUid: string | null;
  supportingDocumentPath: string | null;
  createdAt: string;
}

export interface CourierReturnDoc {
  id: string;
  packageId: string;
  courierCompanyId: string;
  trackingNumber: string;
  courierReturnStatus: "courier_returning" | "courier_return_received" | "inspected" | "closed";
  receivedAt: string | null;
  receivedByUid: string | null;
  createdAt: string;
}


