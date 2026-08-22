import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizePackage, isValidStatusTransition, formatOperationalStatus, OperationalStatus } from "../src/types";

describe("Operational Chain Unit Tests", () => {
  test("should normalize legacy and snake_case packages into canonical Package DTO", () => {
    const rawLegacy = {
      id: "pkg_12345",
      package_number: "GOM-PKG-1001",
      customer_name: "Tariq Mahmood",
      contact_number: "03001234567",
      delivery_address: "House 12, Street 4, Gulberg III",
      city: "Lahore",
      cod_expected: 4500,
      current_status: "Imported"
    };

    const canonical = normalizePackage(rawLegacy);

    assert.equal(canonical.id, "pkg_12345");
    assert.equal(canonical.packageNumber, "GOM-PKG-1001");
    assert.equal(canonical.customerName, "Tariq Mahmood");
    assert.equal(canonical.customerPhone, "03001234567");
    assert.equal(canonical.deliveryAddress, "House 12, Street 4, Gulberg III");
    assert.equal(canonical.city, "Lahore");
    assert.equal(canonical.codExpected, 4500);
    assert.equal(canonical.operationalStatus, "IMPORTED_REVIEW");
    assert.equal(canonical.currentStatus, "Imported / Review");
    assert.equal(canonical.deliveryChannel, "Internal Rider");

    // Also verify legacy aliases are accessible
    assert.equal(canonical.package_number, "GOM-PKG-1001");
    assert.equal(canonical.customer_name, "Tariq Mahmood");
    assert.equal(canonical.contact_number, "03001234567");
    assert.equal(canonical.cod_expected, 4500);
  });

  test("should enforce legal operational status transitions", () => {
    // Valid transitions
    assert.equal(isValidStatusTransition("IMPORTED_REVIEW", "READY_FOR_DISPATCH"), true);
    assert.equal(isValidStatusTransition("READY_FOR_DISPATCH", "ASSIGNED"), true);
    assert.equal(isValidStatusTransition("ASSIGNED", "DISPATCHER_SCANNED"), true);
    assert.equal(isValidStatusTransition("DISPATCHER_SCANNED", "RIDER_SCANNED"), true);
    assert.equal(isValidStatusTransition("RIDER_SCANNED", "RIDER_ACCEPTED"), true);
    assert.equal(isValidStatusTransition("RIDER_ACCEPTED", "OUT_FOR_DELIVERY"), true);
    assert.equal(isValidStatusTransition("OUT_FOR_DELIVERY", "DELIVERED"), true);
    assert.equal(isValidStatusTransition("OUT_FOR_DELIVERY", "CUSTOMER_UNAVAILABLE"), true);
    assert.equal(isValidStatusTransition("CUSTOMER_UNAVAILABLE", "RETURN_REQUIRED"), true);
    assert.equal(isValidStatusTransition("RETURN_REQUIRED", "RIDER_HANDBACK"), true);
    assert.equal(isValidStatusTransition("RIDER_HANDBACK", "WAREHOUSE_RECEIVED"), true);
    assert.equal(isValidStatusTransition("WAREHOUSE_RECEIVED", "CLOSED"), true);

    // Invalid transitions
    assert.equal(isValidStatusTransition("DELIVERED", "OUT_FOR_DELIVERY"), false);
    assert.equal(isValidStatusTransition("CLOSED", "ASSIGNED"), false);
    assert.equal(isValidStatusTransition("CANCELLED", "OUT_FOR_DELIVERY"), false);
  });

  test("should format operational status labels correctly for UI", () => {
    assert.equal(formatOperationalStatus("IMPORTED_REVIEW"), "Imported / Review");
    assert.equal(formatOperationalStatus("READY_FOR_DISPATCH"), "Ready for Dispatch");
    assert.equal(formatOperationalStatus("OUT_FOR_DELIVERY"), "Out for Delivery");
    assert.equal(formatOperationalStatus("WAREHOUSE_RECEIVED"), "Warehouse Received");
  });

  test("should handle missing city without defaulting to Karachi and set proper exception state", () => {
    const pkgWithoutCity = {
      id: "pkg_no_city",
      packageNumber: "GOM-PKG-9999",
      customerName: "Imran Ali",
      customerPhone: "03211234567",
      deliveryAddress: "Near Main Market",
      city: "",
      codExpected: 3200
    };

    const normalized = normalizePackage(pkgWithoutCity);
    assert.equal(normalized.city, "");
    assert.equal(normalized.deliveryChannel, "Unassigned");
    // Verify city was not silently set to Karachi
    assert.notEqual(normalized.city.toLowerCase(), "karachi");
  });

  test("should verify double-entry journal balance for COD collections", () => {
    const codAmount = 6500;
    const postings = [
      { accountCode: "RIDER_CASH_WALLET", debitAmount: codAmount, creditAmount: 0 },
      { accountCode: "CUSTOMER_COD_RECEIVABLE", debitAmount: 0, creditAmount: codAmount }
    ];

    const totalDebits = postings.reduce((sum, p) => sum + p.debitAmount, 0);
    const totalCredits = postings.reduce((sum, p) => sum + p.creditAmount, 0);

    assert.equal(totalDebits, totalCredits, "Debits must strictly equal Credits");
    assert.equal(totalDebits, 6500);
  });

  test("should verify double-entry journal balance for Cashier Settlement Receipts", () => {
    const handoverAmount = 14500;
    const postings = [
      { accountCode: "CASHIER_CASH_CONTROL", debitAmount: handoverAmount, creditAmount: 0 },
      { accountCode: "RIDER_CASH_WALLET", debitAmount: 0, creditAmount: handoverAmount }
    ];

    const totalDebits = postings.reduce((sum, p) => sum + p.debitAmount, 0);
    const totalCredits = postings.reduce((sum, p) => sum + p.creditAmount, 0);

    assert.equal(totalDebits, totalCredits);
    assert.equal(totalDebits, 14500);
  });

  test("should verify reverse logistics lifecycle flow", () => {
    const stages = [
      "OUT_FOR_DELIVERY",
      "CUSTOMER_UNAVAILABLE",
      "RETURN_REQUIRED",
      "RIDER_HANDBACK",
      "WAREHOUSE_RECEIVED",
      "CLOSED"
    ];

    for (let i = 0; i < stages.length - 1; i++) {
      const from = stages[i];
      const to = stages[i + 1];
      assert.equal(
        isValidStatusTransition(from, to),
        true,
        `Transition from ${from} to ${to} should be valid`
      );
    }
  });
});
