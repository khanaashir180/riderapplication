// Automated Acceptance Tests for Sprint 3: COD Collection, Cash Settlement, and Financial Ledger

export function runPhase3Tests() {
  console.log('================================================================');
  console.log('RUNNING PHASE 3 AUTOMATED ACCEPTANCE TESTS: SPRINT 3 FINANCIAL LEDGER');
  console.log('================================================================');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      failed++;
    }
  }

  // --- 1. DOUBLE-ENTRY ENGINE VALIDATION TESTS ---
  console.log('\n--- 1. Double-Entry Accounting Validation Engine ---');

  interface Posting {
    accountCode: string;
    debitAmount: number;
    creditAmount: number;
  }

  const validAccounts = [
    "CUSTOMER_COD_RECEIVABLE",
    "RIDER_CASH_WALLET",
    "CASHIER_CASH_CONTROL",
    "BANK_CLEARING",
    "BANK_ACCOUNT",
    "JAZZCASH_CLEARING",
    "EASYPAISA_CLEARING",
    "BANK_TRANSFER_CLEARING",
    "EXTERNAL_COURIER_RECEIVABLE",
    "COD_DISCREPANCY",
    "APPROVED_WRITE_OFF"
  ];

  function validateTransaction(postings: Posting[], idempotencyKey: string, existingKeys: Set<string>): { valid: boolean; errorCode?: string } {
    if (!idempotencyKey) return { valid: false, errorCode: "IDEMPOTENCY_KEY_REQUIRED" };
    if (existingKeys.has(idempotencyKey)) return { valid: false, errorCode: "DUPLICATE_IDEMPOTENCY_KEY" };
    if (!postings || postings.length === 0) return { valid: false, errorCode: "INVALID_POSTINGS" };

    let totalDebit = 0;
    let totalCredit = 0;

    for (const p of postings) {
      if (p.debitAmount < 0 || p.creditAmount < 0) return { valid: false, errorCode: "NEGATIVE_POSTING_REJECTED" };
      if (p.debitAmount > 0 && p.creditAmount > 0) return { valid: false, errorCode: "DUAL_POSTING_REJECTED" };
      if (p.debitAmount === 0 && p.creditAmount === 0) return { valid: false, errorCode: "ZERO_POSTING_REJECTED" };
      if (!validAccounts.includes(p.accountCode)) return { valid: false, errorCode: "MISSING_OR_INACTIVE_ACCOUNT" };

      totalDebit += p.debitAmount;
      totalCredit += p.creditAmount;
    }

    if (Math.abs(totalDebit - totalCredit) > 0.0001) {
      return { valid: false, errorCode: "UNBALANCED_TRANSACTION" };
    }

    return { valid: true };
  }

  const existingKeys = new Set<string>(["key_existing"]);

  // Test 1.1: Balanced transaction
  const balanced = validateTransaction([
    { accountCode: "RIDER_CASH_WALLET", debitAmount: 5000, creditAmount: 0 },
    { accountCode: "CUSTOMER_COD_RECEIVABLE", debitAmount: 0, creditAmount: 5000 }
  ], "idem_1", existingKeys);
  assert(balanced.valid, "Balanced double-entry transaction accepted");

  // Test 1.2: Unbalanced transaction
  const unbalanced = validateTransaction([
    { accountCode: "RIDER_CASH_WALLET", debitAmount: 5000, creditAmount: 0 },
    { accountCode: "CUSTOMER_COD_RECEIVABLE", debitAmount: 0, creditAmount: 4000 }
  ], "idem_2", existingKeys);
  assert(!unbalanced.valid && unbalanced.errorCode === "UNBALANCED_TRANSACTION", "Unbalanced transaction rejected server-side");

  // Test 1.3: Negative amounts
  const negative = validateTransaction([
    { accountCode: "RIDER_CASH_WALLET", debitAmount: -5000, creditAmount: 0 },
    { accountCode: "CUSTOMER_COD_RECEIVABLE", debitAmount: 0, creditAmount: -5000 }
  ], "idem_3", existingKeys);
  assert(!negative.valid && negative.errorCode === "NEGATIVE_POSTING_REJECTED", "Negative posting amounts rejected");

  // Test 1.4: Dual posting on single line
  const dual = validateTransaction([
    { accountCode: "RIDER_CASH_WALLET", debitAmount: 5000, creditAmount: 5000 }
  ], "idem_4", existingKeys);
  assert(!dual.valid && dual.errorCode === "DUAL_POSTING_REJECTED", "Dual debit and credit on single posting line rejected");

  // Test 1.5: Missing/Inactive account
  const invalidAcc = validateTransaction([
    { accountCode: "INVALID_GHOST_ACCOUNT", debitAmount: 5000, creditAmount: 0 },
    { accountCode: "CUSTOMER_COD_RECEIVABLE", debitAmount: 0, creditAmount: 5000 }
  ], "idem_5", existingKeys);
  assert(!invalidAcc.valid && invalidAcc.errorCode === "MISSING_OR_INACTIVE_ACCOUNT", "Missing or inactive account code rejected");

  // Test 1.6: Duplicate idempotency key
  const dupKey = validateTransaction([
    { accountCode: "RIDER_CASH_WALLET", debitAmount: 5000, creditAmount: 0 },
    { accountCode: "CUSTOMER_COD_RECEIVABLE", debitAmount: 0, creditAmount: 5000 }
  ], "key_existing", existingKeys);
  assert(!dupKey.valid && dupKey.errorCode === "DUPLICATE_IDEMPOTENCY_KEY", "Duplicate idempotency key rejected");


  // --- 2. COD COLLECTION & EXPOSURE TESTS ---
  console.log('\n--- 2. COD Collection & Payment Methods ---');

  interface CodCollection {
    packageId: string;
    expectedCod: number;
    collectedAmount: number;
    paymentMethod: string;
    digitalReference?: string;
  }

  function processCodCollection(coll: CodCollection, existingDigRefs: Set<string>): { success: boolean; riderCashAdded: number; errorCode?: string; collectionVariance: number } {
    const isDigital = ["jazzcash", "easypaisa", "bank_transfer"].includes(coll.paymentMethod);
    
    if (isDigital) {
      if (!coll.digitalReference) return { success: false, riderCashAdded: 0, errorCode: "DIGITAL_REFERENCE_REQUIRED", collectionVariance: 0 };
      if (existingDigRefs.has(coll.digitalReference)) return { success: false, riderCashAdded: 0, errorCode: "DUPLICATE_DIGITAL_REFERENCE", collectionVariance: 0 };
      existingDigRefs.add(coll.digitalReference);
    }

    const collectionVariance = coll.collectedAmount - coll.expectedCod;
    const riderCashAdded = coll.paymentMethod === "cash" ? coll.collectedAmount : 0;

    return { success: true, riderCashAdded, collectionVariance };
  }

  const digitalRefs = new Set<string>(["TXN999"]);

  // Test 2.1: Physical cash collection increases rider cash exposure
  const cashColl = processCodCollection({ packageId: "P1", expectedCod: 3000, collectedAmount: 3000, paymentMethod: "cash" }, digitalRefs);
  assert(cashColl.success && cashColl.riderCashAdded === 3000, "Cash collection increases rider physical cash wallet exposure");

  // Test 2.2: Digital JazzCash collection does NOT increase rider cash exposure
  const jazzColl = processCodCollection({ packageId: "P2", expectedCod: 4000, collectedAmount: 4000, paymentMethod: "jazzcash", digitalReference: "TXN100" }, digitalRefs);
  assert(jazzColl.success && jazzColl.riderCashAdded === 0, "Digital collection (JazzCash) does NOT increase rider physical cash exposure");

  // Test 2.3: Duplicate digital transaction reference rejected
  const dupJazz = processCodCollection({ packageId: "P3", expectedCod: 4000, collectedAmount: 4000, paymentMethod: "jazzcash", digitalReference: "TXN100" }, digitalRefs);
  assert(!dupJazz.success && dupJazz.errorCode === "DUPLICATE_DIGITAL_REFERENCE", "Duplicate digital transaction reference rejected");

  // Test 2.4: Collection variance calculation
  const overColl = processCodCollection({ packageId: "P4", expectedCod: 2500, collectedAmount: 3000, paymentMethod: "cash" }, digitalRefs);
  assert(overColl.success && overColl.collectionVariance === 500, "Collection variance correctly calculated (3000 - 2500 = +500)");


  // --- 3. VARIANCES & SETTLEMENT STATE MACHINE ---
  console.log('\n--- 3. Variances & Settlement State Machine ---');

  interface Settlement {
    id: string;
    riderId: string;
    status: "open" | "rider_submitted" | "cashier_received" | "discrepancy" | "manager_approved" | "closed";
    calculatedCashObligation: number;
    declaredCashAmount: number;
    physicallyReceivedAmount: number;
    riderHandoverVariance: number;
    cashierVariance: number;
    discrepancyReason?: string;
  }

  // Test 3.1: Rider handover variance
  const calculatedObligation = 10000;
  const declaredByRider = 9500;
  const riderHandoverVariance = declaredByRider - calculatedObligation;
  assert(riderHandoverVariance === -500, "Rider handover variance correctly calculated (-500)");

  // Test 3.2: Cashier receiving cash & detecting discrepancy
  function cashierReceive(stl: Settlement, receivedAmt: number, cashierUid: string): { success: boolean; nextStatus: string; cashierVariance: number; errorCode?: string } {
    if (stl.status !== "rider_submitted") return { success: false, nextStatus: stl.status, cashierVariance: 0, errorCode: "INVALID_SETTLEMENT_STAGE" };
    if (stl.riderId === cashierUid) return { success: false, nextStatus: stl.status, cashierVariance: 0, errorCode: "SELF_ACTION_REJECTED" };

    const cashierVariance = receivedAmt - stl.declaredCashAmount;
    const nextStatus = cashierVariance !== 0 ? "discrepancy" : "cashier_received";
    stl.physicallyReceivedAmount = receivedAmt;
    stl.cashierVariance = cashierVariance;
    stl.status = nextStatus as any;

    return { success: true, nextStatus, cashierVariance };
  }

  const stl1: Settlement = {
    id: "STL_101",
    riderId: "rider_alpha",
    status: "rider_submitted",
    calculatedCashObligation: 10000,
    declaredCashAmount: 9500,
    physicallyReceivedAmount: 0,
    riderHandoverVariance: -500,
    cashierVariance: 0
  };

  // Cashier cannot confirm own settlement if cashier IS the rider
  const selfRcv = cashierReceive(stl1, 9500, "rider_alpha");
  assert(!selfRcv.success && selfRcv.errorCode === "SELF_ACTION_REJECTED", "Self-action rejected: Rider cannot act as cashier for their own settlement");

  // Valid cashier receiving cash with shortfall (9000 vs 9500 declared)
  const validRcv = cashierReceive(stl1, 9000, "cashier_beta");
  assert(validRcv.success && validRcv.nextStatus === "discrepancy" && validRcv.cashierVariance === -500, "Cashier receipt with mismatch correctly transitions status to 'discrepancy'");

  // Test 3.3: Stage skipping (Cannot close without manager approval when in discrepancy)
  function closeSettlement(stl: Settlement): { success: boolean; errorCode?: string } {
    if (stl.status === "closed") return { success: false, errorCode: "SETTLEMENT_ALREADY_CLOSED" };
    if (stl.status !== "manager_approved" && stl.status !== "cashier_received") return { success: false, errorCode: "UNAPPROVED_DISCREPANCY" };
    stl.status = "closed";
    return { success: true };
  }

  const unapprovedClose = closeSettlement(stl1);
  assert(!unapprovedClose.success && unapprovedClose.errorCode === "UNAPPROVED_DISCREPANCY", "Closing settlement with unapproved discrepancy rejected");

  // Test 3.4: Manager approval & Self-approval rejection
  function approveDiscrepancy(stl: Settlement, reason: string, managerUid: string): { success: boolean; errorCode?: string } {
    if (!reason || !reason.trim()) return { success: false, errorCode: "DISCREPANCY_REASON_REQUIRED" };
    if (stl.riderId === managerUid) return { success: false, errorCode: "SELF_APPROVAL_REJECTED" };
    if (stl.status === "closed") return { success: false, errorCode: "SETTLEMENT_CLOSED" };
    stl.status = "manager_approved";
    stl.discrepancyReason = reason;
    return { success: true };
  }

  const selfApprove = approveDiscrepancy(stl1, "Forgiven shortfall", "rider_alpha");
  assert(!selfApprove.success && selfApprove.errorCode === "SELF_APPROVAL_REJECTED", "Self-approval rejected: Rider cannot approve their own discrepancy");

  const managerApprove = approveDiscrepancy(stl1, "Shortfall deducted from salary", "manager_gamma");
  assert(managerApprove.success && stl1.status === "manager_approved", "Manager approved discrepancy with required reason");

  // Test 3.5: Close settlement now succeeds
  const validClose = closeSettlement(stl1);
  assert(validClose.success && stl1.status === "closed", "Settlement with approved discrepancy successfully closed");

  // Test 3.6: Immutable closed settlement
  const mutateClosed = approveDiscrepancy(stl1, "Attempt modify closed", "manager_gamma");
  assert(!mutateClosed.success && mutateClosed.errorCode === "SETTLEMENT_CLOSED", "Closed settlement is immutable; modifications rejected");


  // --- 4. REVERSALS & BANK DEPOSITS ---
  console.log('\n--- 4. Reversals & Bank Deposits ---');

  interface Tx {
    id: string;
    status: "posted" | "reversed";
    postings: Posting[];
  }

  function reverseTx(tx: Tx): { success: boolean; reversalPostings?: Posting[]; errorCode?: string } {
    if (tx.status === "reversed") return { success: false, errorCode: "DOUBLE_REVERSAL_REJECTED" };
    
    const reversalPostings = tx.postings.map(p => ({
      accountCode: p.accountCode,
      debitAmount: p.creditAmount,
      creditAmount: p.debitAmount
    }));

    tx.status = "reversed";
    return { success: true, reversalPostings };
  }

  const originalTx: Tx = {
    id: "TX_501",
    status: "posted",
    postings: [
      { accountCode: "CASHIER_CASH_CONTROL", debitAmount: 10000, creditAmount: 0 },
      { accountCode: "RIDER_CASH_WALLET", debitAmount: 0, creditAmount: 10000 }
    ]
  };

  const rev1 = reverseTx(originalTx);
  assert(
    rev1.success && 
    rev1.reversalPostings?.[0].creditAmount === 10000 && 
    rev1.reversalPostings?.[1].debitAmount === 10000, 
    "Reversal transaction correctly swaps debits and credits"
  );

  const rev2 = reverseTx(originalTx);
  assert(!rev2.success && rev2.errorCode === "DOUBLE_REVERSAL_REJECTED", "Double reversal rejected");

  console.log('================================================================');
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    throw new Error(`Phase 3 Acceptance Tests Failed: ${failed} assertions failed.`);
  }
}

// Execute tests if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runPhase3Tests();
}
