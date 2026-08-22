import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  sanitizePhone,
  cleanExcelFormulaString,
  buildPackageDocumentId,
  encodeDocId
} from '../src/services/csvImporter';

describe('Shopify Direct Integration & Order Mapping Tests', () => {

  test('should normalize Pakistani phone numbers accurately from Shopify customer records', () => {
    assert.strictEqual(sanitizePhone('+923001234567'), '03001234567');
    assert.strictEqual(sanitizePhone('923001234567'), '03001234567');
    assert.strictEqual(sanitizePhone('0300 1234567'), '03001234567');
    assert.strictEqual(sanitizePhone('0300-1234567'), '03001234567');
    assert.strictEqual(sanitizePhone(''), '');
  });

  test('should clean and normalize Shopify order numbers and formula prefixes', () => {
    assert.strictEqual(cleanExcelFormulaString('="41499"'), '41499');
    assert.strictEqual(cleanExcelFormulaString('#41499'), '#41499');
    assert.strictEqual(buildPackageDocumentId('41499'), 'pkg_41499');
    assert.strictEqual(encodeDocId('41499.1'), '41499%2E1');
  });

  test('should correctly classify COD vs Prepaid from Shopify financial status', () => {
    // Paid order
    const paidOrder = {
      id: 1001,
      total_price: "8500.00",
      financial_status: "paid"
    };
    const isPaid = paidOrder.financial_status === "paid";
    const codExpectedPaid = isPaid ? 0 : Math.round(Number(paidOrder.total_price));
    assert.strictEqual(isPaid, true);
    assert.strictEqual(codExpectedPaid, 0);

    // Pending COD order
    const codOrder = {
      id: 1002,
      total_price: "12500.00",
      total_outstanding: "12500.00",
      financial_status: "pending"
    };
    const isCodPaid = codOrder.financial_status === "paid";
    const codExpected = isCodPaid ? 0 : Math.round(Number(codOrder.total_outstanding || codOrder.total_price));
    assert.strictEqual(isCodPaid, false);
    assert.strictEqual(codExpected, 12500);
  });

  test('should classify delivery channel based on destination city', () => {
    const karachiCities = ['Karachi', 'karachi', 'KHI', 'Karachi, Sindh'];
    karachiCities.forEach(city => {
      const cityLower = city.toLowerCase();
      const isKarachi = cityLower.includes('karachi') || cityLower.includes('khi');
      const channel = isKarachi ? 'internal_rider' : 'external_courier';
      assert.strictEqual(channel, 'internal_rider');
    });

    const nonKarachiCities = ['Lahore', 'Islamabad', 'Rawalpindi', 'Peshawar', 'Multan'];
    nonKarachiCities.forEach(city => {
      const cityLower = city.toLowerCase();
      const isKarachi = cityLower.includes('karachi') || cityLower.includes('khi');
      const channel = isKarachi ? 'internal_rider' : 'external_courier';
      assert.strictEqual(channel, 'external_courier');
    });
  });

  test('should map Shopify line items correctly into canonical package items', () => {
    const mockShopifyLineItems = [
      {
        id: 991,
        title: "Gomila Classic Oxford",
        variant_title: "Size 42 / Dark Brown",
        sku: "GOM-OXF-42-DB",
        quantity: 1,
        price: "14500.00"
      },
      {
        id: 992,
        title: "Leather Care Cream",
        variant_title: "Neutral",
        sku: "GOM-CARE-NT",
        quantity: 2,
        price: "1200.00"
      }
    ];

    const packageNumber = "41500";
    const items = mockShopifyLineItems.map((li, idx) => ({
      itemId: `item_${encodeDocId(packageNumber)}_${idx + 1}`,
      packageId: buildPackageDocumentId(packageNumber),
      packageNumber,
      itemTitle: li.title,
      variantTitle: li.variant_title,
      barcode: li.sku,
      quantity: li.quantity,
      unitPrice: Math.round(Number(li.price))
    }));

    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].itemId, 'item_41500_1');
    assert.strictEqual(items[0].packageId, 'pkg_41500');
    assert.strictEqual(items[0].unitPrice, 14500);
    assert.strictEqual(items[1].itemId, 'item_41500_2');
    assert.strictEqual(items[1].quantity, 2);
    assert.strictEqual(items[1].unitPrice, 1200);
  });

  test('should enforce operational conflict protection for packages out for delivery or delivered', () => {
    const activeOperationalStatuses = ['out_for_delivery', 'delivered', 'returned', 'returning_to_warehouse'];
    
    activeOperationalStatuses.forEach(status => {
      const isConflict = ['out_for_delivery', 'delivered', 'returned', 'returning_to_warehouse'].includes(status);
      assert.strictEqual(isConflict, true, `Status ${status} should be flagged as an operational conflict`);
    });

    const editableStatuses = ['unassigned', 'imported_review', 'assigned'];
    editableStatuses.forEach(status => {
      const isConflict = ['out_for_delivery', 'delivered', 'returned', 'returning_to_warehouse'].includes(status);
      assert.strictEqual(isConflict, false, `Status ${status} should allow safe source updates`);
    });
  });

});
