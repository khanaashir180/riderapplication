import crypto from 'crypto';

export interface CSVRowData {
  [key: string]: string;
}

export interface ParsedPackageItem {
  itemId: string;
  packageId: string;
  packageNumber: string;
  itemTitle: string;
  variantTitle?: string;
  barcode?: string;
  quantity: number;
  unitPrice: number;
  itemNotes?: string;
  // Backward compatibility aliases
  item_title?: string;
  variant_title?: string;
  unit_price?: number;
  item_notes?: string;
}

export interface ParsedPackage {
  packageId: string;
  packageNumber: string;
  parentOrderNumber: string;
  customerName: string;
  contactNumber: string;
  primaryPhone: string;
  fallbackPhone?: string;
  addressLine1: string;
  address: string;
  city: string;
  province?: string;
  email?: string;
  packageTotal: number;
  parentCapturedAmount: number;
  paymentMethod: string;
  deliveryChannel: string;
  operationalStatus: string;
  currentStatus: string;
  promisedDeliveryDate: string | null;
  orderCreatedAt: string | null;
  courierCompany?: string;
  trackingNumber?: string;
  comments?: string;
  internalNotes?: string;
  orderNotes?: string;
  tags?: string;
  items: ParsedPackageItem[];
  expectedCod: number;
  codExpected: number;
  requiresCodReview: boolean;
  importBatchId?: string;
  importState: 'staged' | 'committed';

  // Aliases for compatibility
  package_number?: string;
  parent_order_number?: string;
  customer_name?: string;
  contact_number?: string;
  package_total?: number;
  parent_captured_amount?: number;
  payment_method?: string;
  delivery_channel?: string;
  current_status?: string;
  promised_delivery_date?: string | null;
  cod_expected?: number;
  requires_cod_review?: boolean;
}

export interface ActiveCodReview {
  parentOrderNumber: string;
  activePackageNumbers: string[];
  parentTotal: number;
  parentCaptured: number;
  parentBalance: number;
}

export interface ParentOrderGroup {
  parentOrderNumber: string;
  customerName: string;
  contactNumber: string;
  address: string;
  city: string;
  parentTotal: number;
  parentCaptured: number;
  parentBalance: number;
  packages: ParsedPackage[];
  requiresReview: boolean;
}

export interface ImportValidationData {
  batchId: string;
  status: 'validated';
  sourceRowCount: number;
  uniquePackageCount: number;
  packageItemCount: number;
  validPackageCount: number;
  warningPackageCount: number;
  blockedPackageCount: number;
  statusCounts: {
    delivered: number;
    dispatched: number;
    returned: number;
    awaiting_return: number;
    imported_review: number;
  };
  deliveryChannelCounts: {
    external_courier: number;
    internal_rider: number;
    outlet_delivery: number;
    internal_manual: number;
    unassigned: number;
  };
  activeCodReviews: ActiveCodReview[];
  warningCount: number;
  errorCount: number;
}

export interface ImportValidationResult {
  validationData: ImportValidationData;
  parentGroups: ParentOrderGroup[];
  packages: ParsedPackage[];
  errors: Array<{ id: string; row: number; packageNumber?: string; error: string }>;
  warnings: Array<{ id: string; row: number; packageNumber?: string; message: string }>;
  total_rows?: number;
  sourceRowCount?: number;
  unique_packages_count?: number;
  uniquePackageCount?: number;
  packageItemCount?: number;
  validPackageCount?: number;
  warningPackageCount?: number;
  blockedPackageCount?: number;
  statusCounts?: Record<string, number>;
  deliveryChannelCounts?: Record<string, number>;
  activeCodReviews?: ActiveCodReview[];
  cod_allocation_reviews?: any[];
}

export function encodeDocId(str: string): string {
  return encodeURIComponent(str).replace(/\./g, '%2E');
}

export function buildPackageDocumentId(packageNumber: string): string {
  return `pkg_${encodeDocId(packageNumber)}`;
}

export function calculateSHA256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function cleanExcelFormulaString(val: any): string {
  if (!val) return '';
  let str = val.toString().trim();
  if (str.startsWith('="') && str.endsWith('"')) {
    str = str.substring(2, str.length - 1);
  } else if (str.startsWith('=')) {
    str = str.substring(1);
  }
  return str.replace(/^"+|"+$/g, '').trim();
}

export function sanitizePhone(phone: string): string {
  if (!phone) return '';
  const cleanedVal = cleanExcelFormulaString(phone);
  let cleaned = cleanedVal.replace(/[^\d+]/g, '').trim();
  if (cleaned.startsWith('923')) {
    cleaned = '0' + cleaned.substring(2);
  } else if (cleaned.startsWith('+923')) {
    cleaned = '0' + cleaned.substring(3);
  }
  return cleaned;
}

export function resolveHeaderValue(row: CSVRowData, candidates: string[]): string {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const matchedKey = keys.find((k) => k.trim().toLowerCase() === candidate.toLowerCase());
    if (matchedKey && row[matchedKey] !== undefined && row[matchedKey] !== null) {
      return cleanExcelFormulaString(row[matchedKey]);
    }
  }
  return '';
}

export function classifyOperationalStatus(row: CSVRowData): string {
  const sourceStatusRaw = resolveHeaderValue(row, ['Order Status', 'Order status', 'source_order_status', 'Status']).trim().toLowerCase();
  const deliveredAt = resolveHeaderValue(row, ['Delivered', 'delivered_at', 'Delivered At']);
  const returnedAt = resolveHeaderValue(row, ['Returned', 'returned_at', 'Returned At']);
  const dispatchedAt = resolveHeaderValue(row, ['Dispatched', 'dispatched_at', 'Dispatched At']);

  if (deliveredAt || sourceStatusRaw === 'delivered') {
    return 'delivered';
  }
  if (returnedAt || sourceStatusRaw === 'returned') {
    return 'returned';
  }
  if (sourceStatusRaw === 'awaiting return' || sourceStatusRaw === 'awaiting_return') {
    return 'awaiting_return';
  }
  if (dispatchedAt || sourceStatusRaw === 'dispatched' || sourceStatusRaw === 'fulfilled') {
    return 'dispatched';
  }

  return 'imported_review';
}

export function classifyDeliveryChannel(courier: string): string {
  if (!courier) return 'unassigned';
  const c = courier.toLowerCase().trim();
  if (c.includes('rider')) {
    return 'internal_rider';
  }
  if (c.includes('tcs') || c.includes('leopard') || c.includes('trax') || c.includes('postex') || c.includes('m&p') || c.includes('tranzo')) {
    return 'external_courier';
  }
  if (c.includes('outlet')) {
    return 'outlet_delivery';
  }
  if (c.includes('internal') || c.includes('manual') || c.includes('warehouse')) {
    return 'internal_manual';
  }
  return 'unassigned';
}

export function processOMSImportRows(rows: CSVRowData[], batchId: string): ImportValidationResult {
  const errors: Array<{ id: string; row: number; packageNumber?: string; error: string }> = [];
  const warnings: Array<{ id: string; row: number; packageNumber?: string; message: string }> = [];
  const packageMap = new Map<string, ParsedPackage>();
  const parentMap = new Map<string, ParsedPackage[]>();

  let itemsCount = 0;
  let rejectedRowsCount = 0;
  let warningRowsCount = 0;

  const statusCounts = {
    delivered: 0,
    dispatched: 0,
    returned: 0,
    awaiting_return: 0,
    imported_review: 0
  };

  const deliveryChannelCounts = {
    external_courier: 0,
    internal_rider: 0,
    outlet_delivery: 0,
    internal_manual: 0,
    unassigned: 0
  };

  rows.forEach((row, index) => {
    const rowNum = index + 1;

    const packageNumber = resolveHeaderValue(row, [
      'Order number',
      'Order Number',
      'package_number',
      'Order',
      'Order #'
    ]);

    if (!packageNumber) {
      errors.push({ id: `err-${rowNum}`, row: rowNum, error: 'Missing package identifier (Order number)' });
      rejectedRowsCount++;
      return;
    }

    if (['captured amount', 'order weight type', 'previous address1'].includes(packageNumber.toLowerCase())) {
      errors.push({ id: `err-${rowNum}`, row: rowNum, packageNumber, error: 'Invalid header matched as package number' });
      rejectedRowsCount++;
      return;
    }

    const parentOrderNumber = resolveHeaderValue(row, [
      'Parent order number',
      'Parent Order Number',
      'Parent Order',
      'Parent Order #'
    ]) || packageNumber;

    const customerName = resolveHeaderValue(row, [
      'Shipping Name',
      'customer_name',
      'Billing Name',
      'Name'
    ]) || 'Customer';

    const primaryPhone = sanitizePhone(resolveHeaderValue(row, [
      'Shipping Phone',
      'primary_phone',
      'Billing Phone',
      'Phone',
      'Contact'
    ]));

    const fallbackPhone = sanitizePhone(resolveHeaderValue(row, [
      'Billing Phone'
    ]));

    const address = resolveHeaderValue(row, [
      'Shipping Address1',
      'address_line_1',
      'Address 1',
      'Address'
    ]) || '';

    const province = resolveHeaderValue(row, ['Shipping Province', 'province']);
    const email = resolveHeaderValue(row, ['Email', 'email']);

    const city = resolveHeaderValue(row, [
      'Shipping City',
      'city',
      'City'
    ]) || '';

    const totalVal = parseFloat(resolveHeaderValue(row, ['Total', 'package_total', 'Amount']) || '0') || 0;
    const capturedVal = parseFloat(resolveHeaderValue(row, ['Captured Amount', 'parent_captured_amount']) || '0') || 0;

    const itemTitle = resolveHeaderValue(row, ['Lineitem Title', 'item_title', 'Title']) || 'Gomila Footwear Item';
    const variantTitle = resolveHeaderValue(row, ['Variant Title', 'variant_title']);
    const barcode = resolveHeaderValue(row, ['Lineitem barcode', 'barcode']);
    const quantity = parseInt(resolveHeaderValue(row, ['Lineitem quantity', 'quantity']) || '1', 10) || 1;
    const unitPrice = parseFloat(resolveHeaderValue(row, ['Lineitem price', 'unit_price', 'Price']) || '0') || totalVal;

    const promisedDateRaw = resolveHeaderValue(row, ['Promised Delivery Date', 'promised_delivery_date']);
    const promisedDeliveryDate = promisedDateRaw ? promisedDateRaw : null;

    const orderCreatedAt = resolveHeaderValue(row, ['Order Date', 'order_created_at', 'Created at']) || null;
    const paymentMethod = resolveHeaderValue(row, ['Payment Method', 'payment_method']) || (totalVal > 0 ? 'COD' : 'Prepaid');
    const courierCompany = resolveHeaderValue(row, ['Courier', 'courier_company', 'Delivery Provider']);
    const trackingNumber = resolveHeaderValue(row, ['Tracking Number', 'tracking_number']);
    const comments = resolveHeaderValue(row, ['Comments']);
    const internalNotes = resolveHeaderValue(row, ['My Notes', 'internal_notes']);
    const orderNotes = resolveHeaderValue(row, ['Notes', 'order_notes']);
    const tags = resolveHeaderValue(row, ['Tags', 'tags']);

    const currentStatus = classifyOperationalStatus(row);
    const deliveryChannel = classifyDeliveryChannel(courierCompany);

    itemsCount++;
    const packageId = buildPackageDocumentId(packageNumber);
    const itemId = `item-${packageId}-${itemsCount}`;

    const item: ParsedPackageItem = {
      itemId,
      packageId,
      packageNumber,
      itemTitle,
      variantTitle: variantTitle || undefined,
      barcode: barcode || undefined,
      quantity,
      unitPrice,
      itemNotes: resolveHeaderValue(row, ['line_item_comment', 'item_notes']) || undefined,
      item_title: itemTitle,
      variant_title: variantTitle || undefined,
      unit_price: unitPrice,
      item_notes: resolveHeaderValue(row, ['line_item_comment', 'item_notes']) || undefined
    };

    if (packageMap.has(packageNumber)) {
      const existingPkg = packageMap.get(packageNumber)!;
      existingPkg.items.push(item);
    } else {
      const newPkg: ParsedPackage = {
        packageId,
        packageNumber,
        parentOrderNumber,
        customerName,
        contactNumber: primaryPhone,
        primaryPhone,
        fallbackPhone: fallbackPhone || undefined,
        addressLine1: address,
        address,
        city,
        province: province || undefined,
        email: email || undefined,
        packageTotal: totalVal,
        parentCapturedAmount: capturedVal,
        paymentMethod,
        deliveryChannel,
        operationalStatus: currentStatus,
        currentStatus,
        promisedDeliveryDate,
        orderCreatedAt,
        courierCompany: courierCompany || undefined,
        trackingNumber: trackingNumber || undefined,
        comments: comments || undefined,
        internalNotes: internalNotes || undefined,
        orderNotes: orderNotes || undefined,
        tags: tags || undefined,
        items: [item],
        expectedCod: 0,
        codExpected: 0,
        requiresCodReview: false,
        importBatchId: batchId,
        importState: 'staged',

        package_number: packageNumber,
        parent_order_number: parentOrderNumber,
        customer_name: customerName,
        contact_number: primaryPhone,
        package_total: totalVal,
        parent_captured_amount: capturedVal,
        payment_method: paymentMethod,
        delivery_channel: deliveryChannel,
        current_status: currentStatus,
        promised_delivery_date: promisedDeliveryDate,
        cod_expected: 0,
        requires_cod_review: false
      };

      packageMap.set(packageNumber, newPkg);

      if (!parentMap.has(parentOrderNumber)) {
        parentMap.set(parentOrderNumber, []);
      }
      parentMap.get(parentOrderNumber)!.push(newPkg);

      if (currentStatus in statusCounts) {
        statusCounts[currentStatus as keyof typeof statusCounts]++;
      }
      if (deliveryChannel in deliveryChannelCounts) {
        deliveryChannelCounts[deliveryChannel as keyof typeof deliveryChannelCounts]++;
      }
    }
  });

  // Calculate COD allocations per parent order
  const parentGroups: ParentOrderGroup[] = [];
  const activeCodReviews: ActiveCodReview[] = [];

  parentMap.forEach((pkgs, parentNum) => {
    const parentTotal = pkgs.reduce((sum, p) => sum + p.packageTotal, 0);
    const parentCaptured = Math.max(...pkgs.map((p) => p.parentCapturedAmount), 0);
    const parentBalance = Math.max(parentTotal - parentCaptured, 0);

    const activePackages = pkgs.filter(p => p.operationalStatus === 'dispatched');

    let requiresReview = false;

    if (activePackages.length === 1) {
      activePackages[0].expectedCod = parentBalance;
      activePackages[0].codExpected = parentBalance;
      activePackages[0].cod_expected = parentBalance;
    } else if (activePackages.length > 1) {
      if (parentCaptured === 0) {
        activePackages.forEach((p) => {
          p.expectedCod = p.packageTotal;
          p.codExpected = p.packageTotal;
          p.cod_expected = p.packageTotal;
        });
      } else if (parentBalance === 0) {
        activePackages.forEach((p) => {
          p.expectedCod = 0;
          p.codExpected = 0;
          p.cod_expected = 0;
        });
      } else {
        requiresReview = true;
        activePackages.forEach((p) => {
          p.expectedCod = 0;
          p.codExpected = 0;
          p.cod_expected = 0;
          p.requiresCodReview = true;
          p.requires_cod_review = true;
        });

        activeCodReviews.push({
          parentOrderNumber: parentNum,
          activePackageNumbers: activePackages.map(p => p.packageNumber),
          parentTotal,
          parentCaptured,
          parentBalance
        });
      }
    }

    parentGroups.push({
      parentOrderNumber: parentNum,
      customerName: pkgs[0].customerName,
      contactNumber: pkgs[0].contactNumber,
      address: pkgs[0].address,
      city: pkgs[0].city,
      parentTotal,
      parentCaptured,
      parentBalance,
      packages: pkgs,
      requiresReview
    });
  });

  const allPackages = Array.from(packageMap.values());
  const validPackageCount = allPackages.filter(p => !p.requiresCodReview).length;
  const warningPackageCount = allPackages.filter(p => p.requiresCodReview).length;

  const cod_allocation_reviews = activeCodReviews.map(r => ({
    parent_order_number: r.parentOrderNumber,
    parentOrderNumber: r.parentOrderNumber,
    remaining_balance: r.parentBalance,
    remainingBalance: r.parentBalance,
    parent_total: r.parentTotal,
    parentTotal: r.parentTotal,
    parent_captured: r.parentCaptured,
    parentCaptured: r.parentCaptured,
    active_packages: r.activePackageNumbers,
    activePackageNumbers: r.activePackageNumbers
  }));

  return {
    total_rows: rows.length,
    sourceRowCount: rows.length,
    unique_packages_count: packageMap.size,
    uniquePackageCount: packageMap.size,
    packageItemCount: itemsCount,
    validPackageCount,
    warningPackageCount,
    blockedPackageCount: rejectedRowsCount,
    statusCounts,
    deliveryChannelCounts,
    activeCodReviews,
    cod_allocation_reviews,
    validationData: {
      batchId,
      status: 'validated',
      sourceRowCount: rows.length,
      uniquePackageCount: packageMap.size,
      packageItemCount: itemsCount,
      validPackageCount,
      warningPackageCount,
      blockedPackageCount: rejectedRowsCount,
      statusCounts,
      deliveryChannelCounts,
      activeCodReviews,
      warningCount: warningRowsCount,
      errorCount: errors.length
    },
    parentGroups,
    packages: allPackages,
    errors,
    warnings
  };
}

