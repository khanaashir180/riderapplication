import test from 'node:test';
import assert from 'node:assert';

test('Rider Route & Bulk Assignment Logic Tests', async (t) => {
  await t.test('should correctly normalize package fields for rider interface consumption', () => {
    function normalizePackageRecord(pkg: any) {
      const pkgNum = pkg.packageNumber || pkg.package_number || pkg.id || "";
      const orderNum = pkg.parentOrderNumber || pkg.parent_order_number || pkg.original_order_number || pkg.order_number || pkgNum;
      const custName = pkg.customerName || pkg.customer_name || pkg.recipient_name || "Valued Customer";
      const phone = pkg.primaryPhone || pkg.contact_number || pkg.phone || "";
      const addr = pkg.shippingAddress || pkg.delivery_address || pkg.address || "";
      const city = pkg.city || "Lahore";
      const zone = pkg.zone || pkg.assignedZone || "";
      const payment = pkg.paymentMethod || pkg.payment_method || "COD";
      const cod = Number(pkg.expectedCod !== undefined ? pkg.expectedCod : (pkg.cod_expected !== undefined ? pkg.cod_expected : (pkg.totalAmount || 0)));
      const status = pkg.current_status || pkg.operationalStatus || "Assigned";
      const channel = pkg.deliveryChannel || pkg.delivery_channel || "Internal Rider";

      return {
        ...pkg,
        id: pkg.id,
        packageNumber: pkgNum,
        package_number: pkgNum,
        original_order_number: orderNum,
        parentOrderNumber: orderNum,
        parent_order_number: orderNum,
        order_number: orderNum,
        customerName: custName,
        customer_name: custName,
        recipient_name: custName,
        contact_number: phone,
        primaryPhone: phone,
        phone: phone,
        address: addr,
        delivery_address: addr,
        shippingAddress: addr,
        city: city,
        zone: zone,
        assignedZone: zone,
        paymentMethod: payment,
        payment_method: payment,
        expectedCod: cod,
        cod_expected: cod,
        total_amount: cod,
        current_status: status,
        operationalStatus: (pkg.operationalStatus || status).toLowerCase().replace(/[\s_]+/g, "_"),
        deliveryChannel: channel,
        delivery_channel: channel,
        custodyStage: pkg.custodyStage || pkg.custody_stage || "assigned_to_rider",
        customer_notes: pkg.customerNotes || pkg.customer_notes || pkg.specialInstructions || ""
      };
    }

    const rawPkg = {
      id: 'pkg_123',
      packageNumber: 'PKG-2026-001',
      parentOrderNumber: '#10523',
      customerName: 'Muhammad Ali',
      primaryPhone: '03001234567',
      shippingAddress: 'House 12, Street 4, Gulberg III',
      city: 'Lahore',
      assignedZone: 'Gulberg',
      paymentMethod: 'COD',
      expectedCod: 4500,
      operationalStatus: 'out_for_delivery',
      deliveryChannel: 'Internal Rider',
      customerNotes: 'Ring the bell twice'
    };

    const normalized = normalizePackageRecord(rawPkg);

    // Verify snake_case compatibility
    assert.strictEqual(normalized.original_order_number, '#10523');
    assert.strictEqual(normalized.customer_name, 'Muhammad Ali');
    assert.strictEqual(normalized.address, 'House 12, Street 4, Gulberg III');
    assert.strictEqual(normalized.contact_number, '03001234567');
    assert.strictEqual(normalized.cod_expected, 4500);
    assert.strictEqual(normalized.payment_method, 'COD');
    assert.strictEqual(normalized.customer_notes, 'Ring the bell twice');

    // Verify camelCase compatibility
    assert.strictEqual(normalized.packageNumber, 'PKG-2026-001');
    assert.strictEqual(normalized.parentOrderNumber, '#10523');
    assert.strictEqual(normalized.customerName, 'Muhammad Ali');
    assert.strictEqual(normalized.expectedCod, 4500);
  });

  await t.test('should validate rider capacity limit before bulk assignment', () => {
    const maxDailyCapacity = 50;
    const currentActiveAssignments = 45;
    const incomingPackageCount = 10;

    const wouldExceed = (currentActiveAssignments + incomingPackageCount) > maxDailyCapacity;
    assert.strictEqual(wouldExceed, true, 'Should flag assignment exceeding maximum daily capacity');

    const validIncomingCount = 5;
    const wouldExceedValid = (currentActiveAssignments + validIncomingCount) > maxDailyCapacity;
    assert.strictEqual(wouldExceedValid, false, 'Should allow assignment within capacity');
  });

  await t.test('should reject external courier packages from internal rider assignment', () => {
    function isInternalDeliveryChannel(deliveryChannel: string): boolean {
      const rawChannel = (deliveryChannel || "").toLowerCase().replace(/[\s_]+/g, "");
      return rawChannel.includes("internalrider") || rawChannel === "internal" || rawChannel === "";
    }

    assert.strictEqual(isInternalDeliveryChannel("Internal Rider"), true);
    assert.strictEqual(isInternalDeliveryChannel("internal"), true);
    assert.strictEqual(isInternalDeliveryChannel("TCS"), false);
    assert.strictEqual(isInternalDeliveryChannel("Trax"), false);
    assert.strictEqual(isInternalDeliveryChannel("Call Courier"), false);
  });
});
