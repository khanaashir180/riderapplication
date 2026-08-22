export type LogisticsStatus =
  | 'UNBOOKED'
  | 'PENDING_DELIVERY'
  | 'DELIVERED'
  | 'RETURN_MARKED'
  | 'RETURN_AWAITING_PHYSICAL_RECEIPT'
  | 'RETURN_PHYSICALLY_RECEIVED'
  | 'EXCEPTION';

export type CodStatus =
  | 'NOT_DUE'
  | 'PENDING'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'MISMATCH'
  | 'WAIVED';

export type ReturnCondition =
  | 'Good'
  | 'Used'
  | 'Damaged'
  | 'Wrong Item'
  | 'Incomplete'
  | 'Packaging Damaged'
  | 'Other';

export type ReturnDisposition =
  | 'Restock'
  | 'Repair'
  | 'Quality Check'
  | 'Hold'
  | 'Reject'
  | 'Missing Item Investigation';

export interface ShipmentProductItem {
  id?: string;
  sku: string;
  title: string;
  quantity: number;
  unitPrice: number;
  totalAmount?: number;
}

export interface Shipment {
  id: string;
  parentOrderNumber: string;
  orderNumber: string;
  courier: string; // 'TRAX' | 'PostEx' | 'TCS' | 'Company Rider' | string
  trackingNumber: string;
  customerName: string;
  customerPhone: string;
  destinationCity: string;
  shippingAddress: string;
  orderAmount: number;
  codExpected: number;
  codReceived: number;
  codPending: number;
  codStatus: CodStatus;
  
  omsOrderDate?: string;
  omsDispatchDate?: string;
  courierBookedAt?: string;
  courierPickupAt?: string;
  courierDeliveredAt?: string;
  courierReturnMarkedAt?: string;
  
  courierStatusRaw: string;
  logisticsStatus: LogisticsStatus;
  lateByCourier: boolean;
  deliveryAgeHours: number;
  
  physicalReturnReceived: boolean;
  physicalReturnReceivedAt?: string;
  physicalReturnReceivedBy?: string;
  physicalReturnLocation?: string;
  returnCondition?: ReturnCondition;
  returnDisposition?: ReturnDisposition;
  returnQuantityExpected?: number;
  returnQuantityReceived?: number;
  returnNotes?: string;
  
  items: ShipmentProductItem[];
  
  settlementReference?: string;
  settlementDate?: string;
  settlementSource?: string;
  settlementDifference?: number;
  
  importJobId?: string;
  lastCourierUpdateAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShipmentEvent {
  id: string;
  shipmentId: string;
  eventType: string; // 'IMPORT' | 'COURIER_SYNC' | 'MANUAL_OVERRIDE' | 'PHYSICAL_RETURN' | 'COD_SETTLEMENT' | 'EXCEPTION_RESOLVED'
  previousStatus?: LogisticsStatus;
  newStatus: LogisticsStatus;
  courierStatusRaw?: string;
  source: string;
  importJobId?: string;
  performedBy: string;
  eventTimestamp: string;
  notes?: string;
}

export interface ImportJob {
  id: string;
  fileName: string;
  fileType: 'oms' | 'trax' | 'postex' | 'tcs' | 'rider' | 'other';
  courier: string;
  uploadedBy: string;
  uploadedAt: string;
  processingStatus: 'processing' | 'completed' | 'failed';
  totalRows: number;
  successfulRows: number;
  failedRows: number;
  duplicateRows: number;
  unmatchedRows: number;
  errorDetails: string[];
}

export interface PhysicalReturnRecord {
  id: string;
  shipmentId: string;
  trackingNumber: string;
  orderNumber: string;
  receivedBy: string;
  receivedByUid: string;
  receivedAt: string;
  location: string;
  condition: ReturnCondition;
  disposition: ReturnDisposition;
  quantityExpected: number;
  quantityReceived: number;
  remarks?: string;
  photoUrls?: string[];
}

export interface CourierMapping {
  id: string;
  courier: string;
  courierStatusRaw: string;
  logisticsStatus: LogisticsStatus;
  description?: string;
  updatedAt: string;
}

export type ExceptionType =
  | 'MISSING_TRACKING'
  | 'DUPLICATE_TRACKING'
  | 'MULTIPLE_OMS'
  | 'COURIER_MISSING_FROM_OMS'
  | 'OMS_MISSING_FROM_COURIER'
  | 'COD_MISMATCH'
  | 'STATUS_CONFLICT'
  | 'INVALID_DATE'
  | 'UNSUPPORTED_STATUS'
  | 'OTHER';

export interface LogisticsException {
  id: string;
  shipmentId?: string;
  trackingNumber?: string;
  orderNumber?: string;
  courier?: string;
  exceptionType: ExceptionType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'OPEN' | 'IN_REVIEW' | 'RESOLVED';
  details: string;
  resolutionNotes?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  importJobId?: string;
  createdAt: string;
}

export interface CourierPerformanceMetrics {
  courier: string;
  totalAssigned: number;
  deliveredCount: number;
  returnCount: number;
  pendingCount: number;
  lateCount: number;
  deliveryPercentage: number;
  returnPercentage: number;
  avgDeliveryTimeHours: number;
  avgReturnTimeHours: number;
  returnsAwaitingPhysicalReceipt: number;
  codExpected: number;
  codReceived: number;
  codPending: number;
  exceptionCount: number;
}
