import {
  Shipment,
  ShipmentEvent,
  ShipmentProductItem,
  LogisticsStatus,
  CodStatus,
  ImportJob,
  CourierMapping,
  LogisticsException,
  ReturnCondition,
  ReturnDisposition,
  PhysicalReturnRecord,
  CourierPerformanceMetrics
} from '../types/logistics';
import Papa from 'papaparse';

/**
 * Clean and normalize tracking / order numbers
 * Removes Excel formatting like `="12345"`, quotes, whitespace, `.0` suffixes, etc.
 */
export function normalizeIdentifier(val: any): string {
  if (val === null || val === undefined) return '';
  let str = String(val).trim();
  // Remove Excel formula wrappers like `="12345"`
  if (str.startsWith('="') && str.endsWith('"')) {
    str = str.substring(2, str.length - 1);
  } else if (str.startsWith('"') && str.endsWith('"')) {
    str = str.substring(1, str.length - 1);
  }
  // Remove trailing .0 from numeric Excel conversions
  if (/^\d+\.0$/.test(str)) {
    str = str.replace(/\.0$/, '');
  }
  // Remove inner spaces and non-printable chars
  str = str.replace(/[\s\t\r\n]+/g, '');
  return str.toUpperCase();
}

/**
 * Calculates late delivery status based on 96 hours (4 exact days) rule from courier booking date.
 */
export function calculateLateByCourier(
  courierBookedAt?: string,
  courierDeliveredAt?: string,
  nowISO: string = new Date().toISOString()
): { lateByCourier: boolean; ageHours: number } {
  if (!courierBookedAt) {
    return { lateByCourier: false, ageHours: 0 };
  }

  const bookedTime = new Date(courierBookedAt).getTime();
  if (isNaN(bookedTime)) {
    return { lateByCourier: false, ageHours: 0 };
  }

  const endTime = courierDeliveredAt ? new Date(courierDeliveredAt).getTime() : new Date(nowISO).getTime();
  if (isNaN(endTime)) {
    return { lateByCourier: false, ageHours: 0 };
  }

  const diffMs = endTime - bookedTime;
  if (diffMs <= 0) {
    return { lateByCourier: false, ageHours: 0 };
  }

  const ageHours = Math.floor(diffMs / (1000 * 60 * 60));
  const lateByCourier = ageHours > 96;

  return { lateByCourier, ageHours };
}

/**
 * Default courier status mappings to Unified Logistics Status
 */
export const DEFAULT_STATUS_MAPPINGS: Record<string, LogisticsStatus> = {
  // Unbooked
  'unbooked': 'UNBOOKED',
  'created': 'UNBOOKED',
  'pending booking': 'UNBOOKED',

  // Pending Delivery
  'booked': 'PENDING_DELIVERY',
  'picked up': 'PENDING_DELIVERY',
  'pickup done': 'PENDING_DELIVERY',
  'warehouse': 'PENDING_DELIVERY',
  'en route': 'PENDING_DELIVERY',
  'in transit': 'PENDING_DELIVERY',
  'out for delivery': 'PENDING_DELIVERY',
  'attempted': 'PENDING_DELIVERY',
  'delivery under review': 'PENDING_DELIVERY',
  'reattempt requested': 'PENDING_DELIVERY',
  'arrived at station': 'PENDING_DELIVERY',
  'dispatched': 'PENDING_DELIVERY',

  // Delivered
  'delivered': 'DELIVERED',
  'delivered to customer': 'DELIVERED',
  'completed': 'DELIVERED',
  'successful': 'DELIVERED',

  // Return Marked (maps to RETURN_AWAITING_PHYSICAL_RECEIPT)
  'return marked': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'return initiated': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'out for return': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'return in transit': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'returned': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'returned to origin': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'returned to merchant': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'return to origin': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'rto': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'return dispatched to merchant': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'return received at hub': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'refused': 'RETURN_AWAITING_PHYSICAL_RECEIPT',
  'cancelled': 'RETURN_AWAITING_PHYSICAL_RECEIPT'
};

function getField(row: Record<string, any>, ...keys: string[]): any {
  const rowKeys = Object.keys(row);
  for (const k of keys) {
    const target = k.toLowerCase().replace(/[\s_]+/g, '');
    const foundKey = rowKeys.find(rk => rk.toLowerCase().replace(/[\s_]+/g, '') === target);
    if (foundKey && row[foundKey] !== undefined && row[foundKey] !== null && String(row[foundKey]).trim() !== '') {
      return row[foundKey];
    }
  }
  return undefined;
}

/**
 * Resolves a raw courier status to Unified Logistics Status
 */
export function resolveLogisticsStatus(
  rawStatus: string,
  customMappings: CourierMapping[] = [],
  currentStatus?: LogisticsStatus,
  physicalReturnReceived: boolean = false
): LogisticsStatus {
  // RULE: If physically received, courier updates CANNOT overwrite physical warehouse receipt!
  if (physicalReturnReceived || currentStatus === 'RETURN_PHYSICALLY_RECEIVED') {
    return 'RETURN_PHYSICALLY_RECEIVED';
  }

  const cleanRaw = (rawStatus || '').trim().toLowerCase();

  // Check custom mappings first
  const match = customMappings.find(
    m => m.courierStatusRaw.trim().toLowerCase() === cleanRaw
  );
  if (match) {
    if (match.logisticsStatus === 'RETURN_MARKED') {
      return 'RETURN_AWAITING_PHYSICAL_RECEIPT';
    }
    return match.logisticsStatus;
  }

  // Fallback to default mapping
  const mapped = DEFAULT_STATUS_MAPPINGS[cleanRaw];
  if (mapped) {
    return mapped;
  }

  return 'EXCEPTION';
}

/**
 * Determines COD status
 */
export function calculateCodStatus(
  codExpected: number,
  codReceived: number,
  logisticsStatus: LogisticsStatus
): CodStatus {
  if (logisticsStatus === 'UNBOOKED') return 'NOT_DUE';
  if (logisticsStatus === 'PENDING_DELIVERY') {
    if (codReceived > 0 && codReceived < codExpected) return 'PARTIALLY_RECEIVED';
    return 'NOT_DUE';
  }

  if (logisticsStatus === 'DELIVERED') {
    if (codExpected <= 0) return 'RECEIVED';
    if (codReceived >= codExpected) return 'RECEIVED';
    if (codReceived === 0) return 'PENDING'; // Delivered with unpaid COD is PENDING!
    if (codReceived > 0 && codReceived < codExpected) return 'PARTIALLY_RECEIVED';
    if (codReceived > codExpected) return 'MISMATCH';
  }

  if (logisticsStatus === 'RETURN_AWAITING_PHYSICAL_RECEIPT' || logisticsStatus === 'RETURN_PHYSICALLY_RECEIVED') {
    if (codReceived > 0) return 'MISMATCH';
    return 'NOT_DUE';
  }

  return 'NOT_DUE';
}

/**
 * Parses OMS CSV file content and returns consolidated shipments, events, and exceptions.
 */
export function parseOmsCsv(
  csvContent: string,
  importJobId: string,
  uploadedBy: string
): {
  shipments: Shipment[];
  events: ShipmentEvent[];
  exceptions: LogisticsException[];
  jobStats: { totalRows: number; successfulRows: number; failedRows: number; duplicateRows: number; unmatchedRows: number; errorDetails: string[] };
} {
  const parseResult = Papa.parse<Record<string, any>>(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim()
  });

  const rows = parseResult.data || [];
  const shipmentMap = new Map<string, Shipment>();
  const exceptions: LogisticsException[] = [];
  const events: ShipmentEvent[] = [];
  const errorDetails: string[] = [];
  let failedRows = 0;
  let duplicateRows = 0;

  const nowISO = new Date().toISOString();

  rows.forEach((row, index) => {
    const rowNum = index + 2;
    const trackingNumber = normalizeIdentifier(
      getField(row, 'Tracking Number', 'tracking_number', 'Tracking #', 'CN', 'Waybill', 'Tracking')
    );
    const orderNumber = normalizeIdentifier(
      getField(row, 'Order number', 'Order Number', 'order_number', 'Order #', 'Order', 'Reference')
    );
    const parentOrderNumber = normalizeIdentifier(
      getField(row, 'Parent order number', 'Parent Order Number', 'parent_order_number', 'Parent Order') || (orderNumber ? orderNumber.split('-')[0] : '')
    );

    if (!trackingNumber && !orderNumber) {
      failedRows++;
      errorDetails.push(`Row ${rowNum}: Missing both tracking number and order number.`);
      exceptions.push({
        id: `exc_oms_${importJobId}_${rowNum}`,
        exceptionType: 'MISSING_TRACKING',
        severity: 'HIGH',
        status: 'OPEN',
        details: `OMS import row ${rowNum} has neither tracking number nor order number.`,
        importJobId,
        createdAt: nowISO
      });
      return;
    }

    const key = trackingNumber || orderNumber;

    const sku = String(getField(row, 'SKU', 'sku', 'Item Code', 'Lineitem sku') || 'GENERIC').trim();
    const itemTitle = String(getField(row, 'Lineitem Title', 'Title', 'Item Name', 'Product', 'item_summary') || 'Footwear Item').trim();
    const qty = parseInt(getField(row, 'Lineitem quantity', 'Quantity', 'qty', 'Qty') || '1', 10) || 1;
    const unitPrice = parseFloat(getField(row, 'Lineitem price', 'Price', 'Unit Price', 'price') || '0') || 0;
    const codExp = parseFloat(getField(row, 'COD Expected', 'cod_expected', 'COD', 'Amount') || '0') || 0;
    const orderAmt = parseFloat(getField(row, 'Order Amount', 'order_amount', 'Total') || '0') || (codExp || unitPrice * qty);

    const courierName = String(getField(row, 'Courier', 'courier', 'Courier Company') || 'Unassigned').trim();
    const custName = String(getField(row, 'Shipping Name', 'Customer Name', 'customer_name', 'Customer', 'Name') || 'Valued Customer').trim();
    const custPhone = String(getField(row, 'Shipping Phone', 'Customer Phone', 'customer_phone', 'Phone', 'Contact') || '').trim();
    const city = String(getField(row, 'Shipping City', 'City', 'city', 'Destination') || 'Lahore').trim();
    const address = String(getField(row, 'Shipping Address1', 'Address', 'address', 'Shipping Address') || '').trim();

    const item: ShipmentProductItem = {
      id: `item_${key}_${sku}_${index}`,
      sku,
      title: itemTitle,
      quantity: qty,
      unitPrice,
      totalAmount: unitPrice * qty
    };

    if (shipmentMap.has(key)) {
      // Consolidate line item into existing shipment record!
      duplicateRows++;
      const existing = shipmentMap.get(key)!;
      existing.items.push(item);
      // Keep order amount / COD clean
      existing.orderAmount = Math.max(existing.orderAmount, orderAmt);
      existing.codExpected = Math.max(existing.codExpected, codExp);
      existing.codPending = Math.max(0, existing.codExpected - existing.codReceived);
    } else {
      const initialStatus: LogisticsStatus = courierName.toLowerCase() === 'unassigned' ? 'UNBOOKED' : 'PENDING_DELIVERY';
      const initialCodStatus = calculateCodStatus(codExp, 0, initialStatus);
      const bookedAt = row['Courier Booked At'] || row['booked_at'] || (initialStatus !== 'UNBOOKED' ? nowISO : undefined);
      const { lateByCourier, ageHours } = calculateLateByCourier(bookedAt, undefined, nowISO);

      const shipment: Shipment = {
        id: `ship_${key}`,
        parentOrderNumber,
        orderNumber,
        courier: courierName,
        trackingNumber: trackingNumber || key,
        customerName: custName,
        customerPhone: custPhone,
        destinationCity: city,
        shippingAddress: address,
        orderAmount: orderAmt,
        codExpected: codExp,
        codReceived: 0,
        codPending: codExp,
        codStatus: initialCodStatus,
        omsOrderDate: row['Order Date'] || row['order_date'] || nowISO,
        omsDispatchDate: row['Dispatch Date'] || row['dispatch_date'] || nowISO,
        courierBookedAt: bookedAt,
        courierStatusRaw: row['Courier Status'] || row['raw_status'] || 'Booked',
        logisticsStatus: initialStatus,
        lateByCourier,
        deliveryAgeHours: ageHours,
        physicalReturnReceived: false,
        items: [item],
        importJobId,
        createdAt: nowISO,
        updatedAt: nowISO
      };

      shipmentMap.set(key, shipment);

      events.push({
        id: `evt_oms_${key}_${Date.now()}`,
        shipmentId: shipment.id,
        eventType: 'IMPORT',
        newStatus: initialStatus,
        courierStatusRaw: shipment.courierStatusRaw,
        source: 'OMS CSV Import',
        importJobId,
        performedBy: uploadedBy,
        eventTimestamp: nowISO,
        notes: `Imported shipment ${shipment.trackingNumber} for order ${shipment.orderNumber}`
      });
    }
  });

  const consolidatedShipments = Array.from(shipmentMap.values());
  const successfulRows = consolidatedShipments.length;

  return {
    shipments: consolidatedShipments,
    events,
    exceptions,
    jobStats: {
      totalRows: rows.length,
      successfulRows,
      failedRows,
      duplicateRows,
      unmatchedRows: 0,
      errorDetails
    }
  };
}

/**
 * Parses Courier Sync CSV (TRAX, PostEx, TCS, Rider) and reconciles against existing shipments.
 */
export function reconcileCourierCsv(
  csvContent: string,
  courierName: string,
  importJobId: string,
  uploadedBy: string,
  existingShipments: Shipment[],
  customMappings: CourierMapping[] = []
): {
  updatedShipments: Shipment[];
  events: ShipmentEvent[];
  exceptions: LogisticsException[];
  jobStats: { totalRows: number; successfulRows: number; failedRows: number; duplicateRows: number; unmatchedRows: number; errorDetails: string[] };
} {
  const parseResult = Papa.parse<Record<string, any>>(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim()
  });

  const rows = parseResult.data || [];
  const shipmentMap = new Map<string, Shipment>();
  existingShipments.forEach(s => {
    shipmentMap.set(normalizeIdentifier(s.trackingNumber), s);
    shipmentMap.set(normalizeIdentifier(s.orderNumber), s);
  });

  const updatedShipmentSet = new Set<Shipment>();
  const events: ShipmentEvent[] = [];
  const exceptions: LogisticsException[] = [];
  const errorDetails: string[] = [];

  let successfulRows = 0;
  let failedRows = 0;
  let unmatchedRows = 0;
  let duplicateRows = 0;

  const nowISO = new Date().toISOString();

  rows.forEach((row, index) => {
    const rowNum = index + 2;
    const trackingNumber = normalizeIdentifier(
      getField(row, 'Tracking Number', 'tracking_number', 'Tracking #', 'CN', 'Waybill', 'Tracking')
    );
    const orderNumber = normalizeIdentifier(
      getField(row, 'Order Number', 'Order number', 'order_number', 'Order #', 'Order', 'Reference')
    );

    if (!trackingNumber && !orderNumber) {
      failedRows++;
      errorDetails.push(`Row ${rowNum}: Courier row missing tracking number and order number.`);
      return;
    }

    // Matching order: (1) Tracking Number, (2) Order Number
    let target = shipmentMap.get(trackingNumber);
    if (!target && orderNumber) {
      target = shipmentMap.get(orderNumber);
    }

    if (!target) {
      unmatchedRows++;
      exceptions.push({
        id: `exc_cour_${importJobId}_${rowNum}`,
        trackingNumber: trackingNumber || undefined,
        orderNumber: orderNumber || undefined,
        courier: courierName,
        exceptionType: 'COURIER_MISSING_FROM_OMS',
        severity: 'HIGH',
        status: 'OPEN',
        details: `Courier row ${rowNum} (${trackingNumber || orderNumber}) not found in OMS records.`,
        importJobId,
        createdAt: nowISO
      });
      return;
    }

    if (trackingNumber && trackingNumber !== target.trackingNumber) {
      target.trackingNumber = trackingNumber;
    }

    const rawStatus = String(
      getField(row, 'Status', 'status', 'Courier Status', 'Delivery Status') || 'Booked'
    ).trim();

    const newLogisticsStatus = resolveLogisticsStatus(
      rawStatus,
      customMappings,
      target.logisticsStatus,
      target.physicalReturnReceived
    );

    const bookedAt = row['Booked Date'] || row['booked_at'] || target.courierBookedAt || nowISO;
    const deliveredAt = newLogisticsStatus === 'DELIVERED' ? (row['Delivered Date'] || row['delivered_at'] || nowISO) : target.courierDeliveredAt;
    const returnMarkedAt = (newLogisticsStatus === 'RETURN_AWAITING_PHYSICAL_RECEIPT' || newLogisticsStatus === 'RETURN_PHYSICALLY_RECEIVED')
      ? (row['Return Date'] || row['return_marked_at'] || target.courierReturnMarkedAt || nowISO)
      : target.courierReturnMarkedAt;

    const collectedCod = parseFloat(row['COD Collected'] || row['cod_collected'] || row['Remittance Amount'] || '0');
    if (collectedCod > 0) {
      target.codReceived = collectedCod;
    }
    target.codPending = Math.max(0, target.codExpected - target.codReceived);
    target.codStatus = calculateCodStatus(target.codExpected, target.codReceived, newLogisticsStatus);

    const { lateByCourier, ageHours } = calculateLateByCourier(bookedAt, deliveredAt, nowISO);

    const prevStatus = target.logisticsStatus;
    target.courierStatusRaw = rawStatus;
    target.logisticsStatus = newLogisticsStatus;
    target.courierBookedAt = bookedAt;
    target.courierDeliveredAt = deliveredAt;
    target.courierReturnMarkedAt = returnMarkedAt;
    target.lateByCourier = lateByCourier;
    target.deliveryAgeHours = ageHours;
    target.courier = courierName || target.courier;
    target.lastCourierUpdateAt = nowISO;
    target.updatedAt = nowISO;

    updatedShipmentSet.add(target);
    successfulRows++;

    events.push({
      id: `evt_cour_${target.id}_${Date.now()}_${index}`,
      shipmentId: target.id,
      eventType: 'COURIER_SYNC',
      previousStatus: prevStatus,
      newStatus: newLogisticsStatus,
      courierStatusRaw: rawStatus,
      source: `${courierName} Import`,
      importJobId,
      performedBy: uploadedBy,
      eventTimestamp: nowISO,
      notes: `Courier status updated to "${rawStatus}" (${newLogisticsStatus})`
    });
  });

  return {
    updatedShipments: Array.from(updatedShipmentSet),
    events,
    exceptions,
    jobStats: {
      totalRows: rows.length,
      successfulRows,
      failedRows,
      duplicateRows,
      unmatchedRows,
      errorDetails
    }
  };
}

/**
 * Calculates Courier Performance Analytics
 */
export function calculateCourierPerformance(
  shipments: Shipment[],
  exceptions: LogisticsException[]
): CourierPerformanceMetrics[] {
  const map = new Map<string, {
    total: number;
    delivered: number;
    returned: number;
    pending: number;
    late: number;
    deliveryTimeMsTotal: number;
    deliveryTimeCount: number;
    returnTimeMsTotal: number;
    returnTimeCount: number;
    awaitingPhysical: number;
    codExpected: number;
    codReceived: number;
    codPending: number;
    exceptions: number;
  }>();

  shipments.forEach(s => {
    const courier = s.courier || 'Unassigned';
    if (!map.has(courier)) {
      map.set(courier, {
        total: 0,
        delivered: 0,
        returned: 0,
        pending: 0,
        late: 0,
        deliveryTimeMsTotal: 0,
        deliveryTimeCount: 0,
        returnTimeMsTotal: 0,
        returnTimeCount: 0,
        awaitingPhysical: 0,
        codExpected: 0,
        codReceived: 0,
        codPending: 0,
        exceptions: 0
      });
    }

    const stat = map.get(courier)!;
    stat.total++;
    if (s.logisticsStatus === 'DELIVERED') stat.delivered++;
    if (s.logisticsStatus === 'RETURN_AWAITING_PHYSICAL_RECEIPT' || s.logisticsStatus === 'RETURN_PHYSICALLY_RECEIVED') stat.returned++;
    if (s.logisticsStatus === 'PENDING_DELIVERY') stat.pending++;
    if (s.lateByCourier) stat.late++;
    if (s.logisticsStatus === 'RETURN_AWAITING_PHYSICAL_RECEIPT') stat.awaitingPhysical++;

    stat.codExpected += s.codExpected || 0;
    stat.codReceived += s.codReceived || 0;
    stat.codPending += s.codPending || 0;

    if (s.courierBookedAt && s.courierDeliveredAt && s.logisticsStatus === 'DELIVERED') {
      const bTime = new Date(s.courierBookedAt).getTime();
      const dTime = new Date(s.courierDeliveredAt).getTime();
      if (!isNaN(bTime) && !isNaN(dTime) && dTime > bTime) {
        stat.deliveryTimeMsTotal += (dTime - bTime);
        stat.deliveryTimeCount++;
      }
    }

    if (s.courierBookedAt && s.courierReturnMarkedAt) {
      const bTime = new Date(s.courierBookedAt).getTime();
      const rTime = new Date(s.courierReturnMarkedAt).getTime();
      if (!isNaN(bTime) && !isNaN(rTime) && rTime > bTime) {
        stat.returnTimeMsTotal += (rTime - bTime);
        stat.returnTimeCount++;
      }
    }
  });

  exceptions.forEach(e => {
    if (e.courier && map.has(e.courier)) {
      map.get(e.courier)!.exceptions++;
    }
  });

  const result: CourierPerformanceMetrics[] = [];
  map.forEach((stat, courier) => {
    result.push({
      courier,
      totalAssigned: stat.total,
      deliveredCount: stat.delivered,
      returnCount: stat.returned,
      pendingCount: stat.pending,
      lateCount: stat.late,
      deliveryPercentage: stat.total > 0 ? Math.round((stat.delivered / stat.total) * 100) : 0,
      returnPercentage: stat.total > 0 ? Math.round((stat.returned / stat.total) * 100) : 0,
      avgDeliveryTimeHours: stat.deliveryTimeCount > 0 ? Math.round(stat.deliveryTimeMsTotal / (stat.deliveryTimeCount * 1000 * 60 * 60)) : 0,
      avgReturnTimeHours: stat.returnTimeCount > 0 ? Math.round(stat.returnTimeMsTotal / (stat.returnTimeCount * 1000 * 60 * 60)) : 0,
      returnsAwaitingPhysicalReceipt: stat.awaitingPhysical,
      codExpected: stat.codExpected,
      codReceived: stat.codReceived,
      codPending: stat.codPending,
      exceptionCount: stat.exceptions
    });
  });

  return result;
}
