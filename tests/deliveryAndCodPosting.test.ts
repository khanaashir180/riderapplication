import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

describe("Delivery + COD Posting Workflow Verification", () => {
  // In-memory mock Firestore with transaction support
  class MockFirestore {
    collections: Map<string, Map<string, any>> = new Map();

    collection(name: string) {
      if (!this.collections.has(name)) {
        this.collections.set(name, new Map());
      }
      const colMap = this.collections.get(name)!;

      return {
        doc: (id?: string) => {
          const docId = id || crypto.randomUUID();
          return {
            id: docId,
            _colName: name,
            _colMap: colMap,
            get: async () => {
              const data = colMap.get(docId);
              return {
                exists: data !== undefined,
                id: docId,
                data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined)
              };
            },
            set: async (data: any, options?: { merge?: boolean }) => {
              if (options?.merge && colMap.has(docId)) {
                colMap.set(docId, { ...colMap.get(docId), ...data });
              } else {
                colMap.set(docId, JSON.parse(JSON.stringify(data)));
              }
            },
            update: async (data: any) => {
              if (!colMap.has(docId)) {
                throw new Error(`Doc ${docId} not found in ${name}`);
              }
              colMap.set(docId, { ...colMap.get(docId), ...data });
            }
          };
        },
        where: (field: string, op: string, val: any) => {
          return {
            get: async () => {
              const docs: any[] = [];
              for (const [id, d] of colMap.entries()) {
                let match = false;
                if (op === "==") match = d[field] === val;
                else if (op === "in") match = Array.isArray(val) && val.includes(d[field]);
                if (match) {
                  docs.push({ id, data: () => JSON.parse(JSON.stringify(d)) });
                }
              }
              return { docs, empty: docs.length === 0, size: docs.length };
            }
          };
        },
        get: async () => {
          const docs = Array.from(colMap.entries()).map(([id, d]) => ({
            id,
            data: () => JSON.parse(JSON.stringify(d))
          }));
          return { docs, empty: docs.length === 0, size: docs.length };
        }
      };
    }

    async runTransaction(updateFunction: (transaction: any) => Promise<any>) {
      const stagedWrites: Array<() => void> = [];

      const transaction = {
        get: async (docRef: any) => {
          return await docRef.get();
        },
        set: (docRef: any, data: any, options?: { merge?: boolean }) => {
          stagedWrites.push(() => {
            const colMap = docRef._colMap;
            if (colMap) {
              if (options?.merge && colMap.has(docRef.id)) {
                colMap.set(docRef.id, { ...colMap.get(docRef.id), ...data });
              } else {
                colMap.set(docRef.id, JSON.parse(JSON.stringify(data)));
              }
            }
          });
        },
        update: (docRef: any, data: any) => {
          stagedWrites.push(() => {
            const colMap = docRef._colMap;
            if (colMap) {
              if (!colMap.has(docRef.id)) {
                throw new Error(`Doc ${docRef.id} not found in ${docRef._colName}`);
              }
              colMap.set(docRef.id, { ...colMap.get(docRef.id), ...data });
            }
          });
        }
      };

      const result = await updateFunction(transaction);
      for (const write of stagedWrites) {
        write();
      }
      return result;
    }
  }

  // Delivery attempt business handler implementation mirroring server.ts logic
  async function handleDeliveryAttempt(db: MockFirestore, req: any) {
    const {
      packageId,
      status,
      attemptId: customAttemptId,
      deliveryAttemptId,
      collectedAmount,
      paymentMethod,
      receiverName,
      receiverRelationship,
      deviceTimestamp,
      latitude,
      longitude,
      proofImageUrl,
      proofPhoto,
      proofImage,
      proofStoragePath,
      gpsPermissionState,
      proofStatus,
      reason,
      riderNotes,
      customerContacted,
      newDeliveryDate,
      idempotencyKey,
      digitalReference
    } = req.body;

    if (!packageId || !status) {
      return { status: 400, body: { success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId or status" } } };
    }

    const ALLOWED_OUTCOMES = [
      "DELIVERED",
      "CUSTOMER_UNAVAILABLE",
      "RESCHEDULED",
      "REFUSED",
      "ADDRESS_ISSUE",
      "CUSTOMER_CANCELLED"
    ];
    const rawOutcome = (status || "").toUpperCase().replace(/[\s-]+/g, "_");
    if (!ALLOWED_OUTCOMES.includes(rawOutcome)) {
      return {
        status: 400,
        body: { success: false, error: { code: "INVALID_DELIVERY_OUTCOME", message: `Invalid delivery outcome "${status}". Allowed outcomes: ${ALLOWED_OUTCOMES.join(", ")}` } }
      };
    }

    const hasLat = latitude !== undefined && latitude !== null && latitude !== "" && !isNaN(Number(latitude));
    const hasLng = longitude !== undefined && longitude !== null && longitude !== "" && !isNaN(Number(longitude));
    const photoRef = (proofImageUrl || proofPhoto || proofImage || proofStoragePath || "").trim();

    if (rawOutcome === "DELIVERED") {
      if (collectedAmount === undefined || collectedAmount === null || collectedAmount === "" || isNaN(Number(collectedAmount))) {
        return {
          status: 400,
          body: { success: false, error: { code: "COLLECTED_AMOUNT_REQUIRED", message: "Delivered status requires actual collected amount." } }
        };
      }
      const collAmt = Number(collectedAmount);
      if (collAmt < 0) {
        return {
          status: 400,
          body: { success: false, error: { code: "NEGATIVE_COD_REJECTED", message: "Collected amount cannot be negative." } }
        };
      }

      if (!receiverName || typeof receiverName !== "string" || !receiverName.trim()) {
        return {
          status: 400,
          body: { success: false, error: { code: "RECEIVER_NAME_REQUIRED", message: "Delivered status requires receiverName." } }
        };
      }

      if (!photoRef) {
        return {
          status: 400,
          body: { success: false, error: { code: "PROOF_PHOTO_REQUIRED", message: "Delivered status requires photo proof." } }
        };
      }

      if (!hasLat || !hasLng) {
        return {
          status: 400,
          body: { success: false, error: { code: "GPS_COORDINATES_REQUIRED", message: "Delivered status requires valid GPS coordinates (latitude, longitude)." } }
        };
      }
    } else if (rawOutcome === "RESCHEDULED") {
      if (!newDeliveryDate || typeof newDeliveryDate !== "string" || !newDeliveryDate.trim()) {
        return {
          status: 400,
          body: { success: false, error: { code: "NEW_DELIVERY_DATE_REQUIRED", message: "Rescheduled status requires a new delivery date." } }
        };
      }
    } else {
      if (!reason || typeof reason !== "string" || !reason.trim()) {
        return {
          status: 400,
          body: { success: false, error: { code: "REASON_REQUIRED", message: "Failed delivery outcome requires a reason." } }
        };
      }
    }

    const effectiveAttemptId = customAttemptId || deliveryAttemptId || `att_${crypto.randomUUID()}`;
    const effectiveIdemKey = idempotencyKey || `DELIVERY:${packageId}:${effectiveAttemptId}`;
    const isContacted = customerContacted === true;
    const nowStr = new Date().toISOString();

    try {
      const result = await db.runTransaction(async (t: any) => {
        const pkgRef = db.collection("packages").doc(packageId);
        const pkgDoc = await t.get(pkgRef);
        if (!pkgDoc.exists) {
          throw { status: 404, code: "NOT_FOUND", message: `Package ${packageId} not found` };
        }

        const pkgData = pkgDoc.data();
        const assignedRiderId = pkgData?.assignedRiderId;

        if (req.auth.role === "rider" && assignedRiderId !== req.auth.riderId) {
          throw { status: 403, code: "FORBIDDEN", message: "You are not assigned to this package. Rider completing unassigned package is strictly rejected." };
        }

        const idemRef = db.collection("idempotencyKeys").doc(effectiveIdemKey);
        const idemDoc = await t.get(idemRef);
        if (idemDoc.exists) {
          const stored = idemDoc.data();
          return { idempotent: true, data: stored?.attemptRecord || { packageId, status: rawOutcome } };
        }

        const currOpStatus = (pkgData?.operationalStatus || pkgData?.current_status || "").toUpperCase().replace(/[\s-]+/g, "_");
        if (currOpStatus !== "OUT_FOR_DELIVERY") {
          if (currOpStatus === "DELIVERED") {
            throw { status: 400, code: "DUPLICATE_DELIVERY_SUBMISSION", message: "Package is already delivered. Duplicate delivery submission rejected." };
          }
          throw { status: 400, code: "INVALID_STATE_TRANSITION", message: `Cannot record delivery attempt for package in state "${currOpStatus}". Package must be OUT_FOR_DELIVERY.` };
        }

        const isPrepaid = (pkgData.paymentMethod || pkgData.payment_method || "").toLowerCase() === "prepaid" ||
                          Number(pkgData.expectedCod || pkgData.cod_expected || 0) === 0;
        const expectedCod = isPrepaid ? 0 : Number(pkgData.cod_expected || pkgData.expectedCod || pkgData.codExpected || 0);
        const collAmt = rawOutcome === "DELIVERED" ? (isPrepaid ? 0 : Number(collectedAmount)) : 0;
        const normPayment = (paymentMethod || pkgData.paymentMethod || pkgData.payment_method || (isPrepaid ? "prepaid" : "cash")).toLowerCase().replace(/[\s_]+/g, "_");
        const isDigital = ["jazzcash", "easypaisa", "bank_transfer"].includes(normPayment);

        if (rawOutcome === "DELIVERED" && isDigital && (!digitalReference || !digitalReference.trim())) {
          throw { status: 400, code: "DIGITAL_REFERENCE_REQUIRED", message: "Digital payment method requires a digital reference." };
        }

        const attemptRef = db.collection("deliveryAttempts").doc(effectiveAttemptId);
        const attemptRecord = {
          id: effectiveAttemptId,
          packageId,
          riderId: req.auth.riderId || assignedRiderId,
          status: rawOutcome,
          collectedAmount: collAmt,
          paymentMethod: rawOutcome === "DELIVERED" ? (isPrepaid ? "Prepaid" : (paymentMethod || "Cash")) : null,
          receiverName: rawOutcome === "DELIVERED" ? receiverName.trim() : null,
          receiverRelationship: rawOutcome === "DELIVERED" ? (receiverRelationship?.trim() || "Recipient") : null,
          latitude: hasLat ? Number(latitude) : null,
          longitude: hasLng ? Number(longitude) : null,
          proofImageUrl: photoRef || null,
          proofStoragePath: proofStoragePath || null,
          reason: reason || null,
          riderNotes: riderNotes || null,
          customerContacted: isContacted,
          newDeliveryDate: rawOutcome === "RESCHEDULED" ? newDeliveryDate.trim() : null,
          serverTimestamp: nowStr,
          deviceTimestamp: deviceTimestamp || nowStr,
          gpsPermissionState: hasLat && hasLng ? (gpsPermissionState || "granted") : (gpsPermissionState || "denied"),
          proofStatus: proofStatus || (rawOutcome === "DELIVERED" ? "captured" : "pending"),
          idempotencyKey: effectiveIdemKey,
          createdAt: nowStr
        };

        t.set(attemptRef, attemptRecord);

        let codCollectionRecord = null;
        let txId = null;

        if (rawOutcome === "DELIVERED") {
          t.update(pkgRef, {
            current_status: "Delivered",
            operationalStatus: "delivered",
            collectedAmount: collAmt,
            receiverName: receiverName.trim(),
            deliveredAt: nowStr,
            failureReason: null,
            updatedAt: nowStr
          });

          if (!isPrepaid && collAmt > 0) {
            const codId = `cod_${crypto.randomUUID()}`;
            txId = `tx_${crypto.randomUUID()}`;
            const collectionVariance = collAmt - expectedCod;

            let accountCode = "RIDER_CASH_WALLET";
            if (normPayment === "jazzcash") accountCode = "JAZZCASH_CLEARING";
            else if (normPayment === "easypaisa") accountCode = "EASYPAISA_CLEARING";
            else if (normPayment === "bank_transfer") accountCode = "BANK_TRANSFER_CLEARING";

            const txRef = db.collection("financialTransactions").doc(txId);
            t.set(txRef, {
              id: txId,
              transactionType: "COD_COLLECTION",
              sourceType: "cod_collection",
              sourceId: packageId,
              packageId,
              riderId: req.auth.riderId || assignedRiderId,
              cashierProfileId: null,
              settlementId: null,
              bankDepositId: null,
              status: "posted",
              currency: "PKR",
              totalDebit: collAmt,
              totalCredit: collAmt,
              idempotencyKey: effectiveIdemKey,
              createdByUid: req.auth.uid,
              createdAt: nowStr
            });

            const postDebitRef = db.collection("financialPostings").doc(`post_dr_${crypto.randomUUID()}`);
            t.set(postDebitRef, {
              id: postDebitRef.id,
              transactionId: txId,
              accountCode,
              debitAmount: collAmt,
              creditAmount: 0,
              packageId,
              riderId: req.auth.riderId || assignedRiderId,
              createdAt: nowStr
            });

            const postCreditRef = db.collection("financialPostings").doc(`post_cr_${crypto.randomUUID()}`);
            t.set(postCreditRef, {
              id: postCreditRef.id,
              transactionId: txId,
              accountCode: "CUSTOMER_COD_RECEIVABLE",
              debitAmount: 0,
              creditAmount: collAmt,
              packageId,
              riderId: req.auth.riderId || assignedRiderId,
              createdAt: nowStr
            });

            codCollectionRecord = {
              id: codId,
              packageId,
              riderId: req.auth.riderId || assignedRiderId,
              expectedCod,
              collectedAmount: collAmt,
              paymentMethod: normPayment,
              digitalReference: isDigital ? digitalReference.trim() : null,
              collectionVariance,
              idempotencyKey: effectiveIdemKey,
              transactionId: txId,
              createdAt: nowStr
            };
            const codRef = db.collection("codCollections").doc(codId);
            t.set(codRef, codCollectionRecord);
          }

          const auditRef = db.collection("auditLogs").doc(`audit_${crypto.randomUUID()}`);
          t.set(auditRef, {
            id: auditRef.id,
            action: "PACKAGE_DELIVERED",
            packageId,
            riderId: req.auth.riderId || assignedRiderId,
            actorUid: req.auth.uid,
            actorRole: req.auth.role,
            metadata: {
              attemptId: effectiveAttemptId,
              collectedAmount: collAmt,
              paymentMethod: normPayment,
              txId
            },
            timestamp: nowStr
          });
        }

        t.set(idemRef, {
          key: effectiveIdemKey,
          packageId,
          attemptId: effectiveAttemptId,
          status: rawOutcome,
          attemptRecord,
          codCollectionRecord,
          createdAt: nowStr
        });

        return { idempotent: false, data: attemptRecord };
      });

      return { status: 200, body: { success: true, data: result.data } };
    } catch (err: any) {
      const status = err.status || 500;
      const code = err.code || "SERVER_ERROR";
      return { status, body: { success: false, error: { code, message: err.message || "Operation failed" } } };
    }
  }

  test("1. 'ASSIGNED → DELIVERED' transition must fail and reject with INVALID_STATE_TRANSITION", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_assigned_001";
    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      assignedRiderId: "rider_123",
      current_status: "Assigned",
      operationalStatus: "assigned",
      cod_expected: 1500
    });

    const res = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: {
        packageId: pkgId,
        status: "DELIVERED",
        collectedAmount: 1500,
        receiverName: "John Doe",
        proofImageUrl: "https://storage.googleapis.com/proof/p1.jpg",
        latitude: 24.8607,
        longitude: 67.0011
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, "INVALID_STATE_TRANSITION");

    // Verify package remains in Assigned status
    const pkg = (await db.collection("packages").doc(pkgId).get()).data();
    assert.equal(pkg.operationalStatus, "assigned");
  });

  test("2. Valid 'OUT_FOR_DELIVERY → DELIVERED' must pass and record delivery", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_ofd_001";
    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      assignedRiderId: "rider_123",
      current_status: "Out for Delivery",
      operationalStatus: "out_for_delivery",
      cod_expected: 2500
    });

    const res = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: {
        packageId: pkgId,
        status: "DELIVERED",
        collectedAmount: 2500,
        paymentMethod: "cash",
        receiverName: "Sarah Connor",
        receiverRelationship: "Self",
        proofImageUrl: "https://storage.googleapis.com/proof/sarah.jpg",
        latitude: 24.8607,
        longitude: 67.0011
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    // Verify package is delivered
    const pkg = (await db.collection("packages").doc(pkgId).get()).data();
    assert.equal(pkg.operationalStatus, "delivered");
    assert.equal(pkg.current_status, "Delivered");
    assert.equal(pkg.collectedAmount, 2500);
  });

  test("3. 'LOST_IN_TRANSIT → DELIVERED' must fail and package remain unchanged", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_lost_001";
    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      assignedRiderId: "rider_123",
      current_status: "Lost in Transit",
      operationalStatus: "lost_in_transit",
      cod_expected: 3000
    });

    const res = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: {
        packageId: pkgId,
        status: "DELIVERED",
        collectedAmount: 3000,
        receiverName: "Alex Vance",
        proofImageUrl: "https://storage.googleapis.com/proof/alex.jpg",
        latitude: 24.8607,
        longitude: 67.0011
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, "INVALID_STATE_TRANSITION");

    const pkg = (await db.collection("packages").doc(pkgId).get()).data();
    assert.equal(pkg.operationalStatus, "lost_in_transit");
    assert.equal(pkg.current_status, "Lost in Transit");
  });

  test("4. Delivered without photo must fail with PROOF_PHOTO_REQUIRED", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_nophoto_001";
    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      assignedRiderId: "rider_123",
      operationalStatus: "out_for_delivery",
      cod_expected: 1000
    });

    const res = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: {
        packageId: pkgId,
        status: "DELIVERED",
        collectedAmount: 1000,
        receiverName: "Bruce Wayne",
        proofImageUrl: "",
        latitude: 24.8607,
        longitude: 67.0011
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, "PROOF_PHOTO_REQUIRED");
  });

  test("5. Delivered without GPS coordinates must fail with GPS_COORDINATES_REQUIRED", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_nogps_001";
    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      assignedRiderId: "rider_123",
      operationalStatus: "out_for_delivery",
      cod_expected: 1000
    });

    const res = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: {
        packageId: pkgId,
        status: "DELIVERED",
        collectedAmount: 1000,
        receiverName: "Clark Kent",
        proofImageUrl: "https://storage.googleapis.com/proof/clark.jpg",
        latitude: null,
        longitude: null
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, "GPS_COORDINATES_REQUIRED");
  });

  test("6. Delivered without receiverName must fail with RECEIVER_NAME_REQUIRED", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_noname_001";
    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      assignedRiderId: "rider_123",
      operationalStatus: "out_for_delivery",
      cod_expected: 1000
    });

    const res = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: {
        packageId: pkgId,
        status: "DELIVERED",
        collectedAmount: 1000,
        receiverName: "   ",
        proofImageUrl: "https://storage.googleapis.com/proof/test.jpg",
        latitude: 24.8607,
        longitude: 67.0011
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, "RECEIVER_NAME_REQUIRED");
  });

  test("7. Invalid delivery outcome must return 400 INVALID_DELIVERY_OUTCOME", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_invalid_001";
    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      assignedRiderId: "rider_123",
      operationalStatus: "out_for_delivery",
      cod_expected: 1000
    });

    const res = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: {
        packageId: pkgId,
        status: "CUSTOM_UNKNOWN_STATUS"
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, "INVALID_DELIVERY_OUTCOME");
  });

  test("8. Negative collected amount must be rejected with NEGATIVE_COD_REJECTED", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_neg_001";
    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      assignedRiderId: "rider_123",
      operationalStatus: "out_for_delivery",
      cod_expected: 1000
    });

    const res = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: {
        packageId: pkgId,
        status: "DELIVERED",
        collectedAmount: -500,
        receiverName: "Peter Parker",
        proofImageUrl: "https://storage.googleapis.com/proof/p.jpg",
        latitude: 24.8607,
        longitude: 67.0011
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, "NEGATIVE_COD_REJECTED");
  });

  test("9. Wrong rider delivery must return 403 FORBIDDEN", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_wrong_rider_001";
    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      assignedRiderId: "rider_456",
      operationalStatus: "out_for_delivery",
      cod_expected: 1000
    });

    const res = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: {
        packageId: pkgId,
        status: "DELIVERED",
        collectedAmount: 1000,
        receiverName: "Diana Prince",
        proofImageUrl: "https://storage.googleapis.com/proof/diana.jpg",
        latitude: 24.8607,
        longitude: 67.0011
      }
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.error?.code, "FORBIDDEN");
  });

  test("10. Valid COD delivery must atomically create exactly 1 delivery event, 1 COD collection, 1 ledger transaction, and 1 audit event", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_atomic_cod_001";
    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      assignedRiderId: "rider_123",
      operationalStatus: "out_for_delivery",
      cod_expected: 3500
    });

    const res = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: {
        packageId: pkgId,
        status: "DELIVERED",
        collectedAmount: 3500,
        paymentMethod: "cash",
        receiverName: "Hal Jordan",
        proofImageUrl: "https://storage.googleapis.com/proof/hal.jpg",
        latitude: 24.8607,
        longitude: 67.0011
      }
    });

    assert.equal(res.status, 200);

    // Assert counts
    const attempts = (await db.collection("deliveryAttempts").get()).docs;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].data().packageId, pkgId);

    const cods = (await db.collection("codCollections").get()).docs;
    assert.equal(cods.length, 1);
    assert.equal(cods[0].data().collectedAmount, 3500);

    const txs = (await db.collection("financialTransactions").get()).docs;
    assert.equal(txs.length, 1);
    assert.equal(txs[0].data().totalDebit, 3500);
    assert.equal(txs[0].data().totalCredit, 3500);

    const postings = (await db.collection("financialPostings").get()).docs;
    assert.equal(postings.length, 2); // 1 Debit, 1 Credit

    const audits = (await db.collection("auditLogs").get()).docs;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].data().action, "PACKAGE_DELIVERED");
  });

  test("11. Duplicate delivery submission with same attempt/idempotency key returns idempotent success without duplicate records", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_idempotent_001";
    const attemptId = "att_idem_test_999";
    const idemKey = `DELIVERY:${pkgId}:${attemptId}`;

    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      assignedRiderId: "rider_123",
      operationalStatus: "out_for_delivery",
      cod_expected: 4000
    });

    const payload = {
      packageId: pkgId,
      attemptId,
      idempotencyKey: idemKey,
      status: "DELIVERED",
      collectedAmount: 4000,
      paymentMethod: "cash",
      receiverName: "Barry Allen",
      proofImageUrl: "https://storage.googleapis.com/proof/barry.jpg",
      latitude: 24.8607,
      longitude: 67.0011
    };

    // First attempt
    const res1 = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: payload
    });
    assert.equal(res1.status, 200);

    // Second duplicate attempt (same payload / idemKey)
    const res2 = await handleDeliveryAttempt(db, {
      auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
      body: payload
    });
    assert.equal(res2.status, 200);

    // Still exactly 1 of each record!
    const attempts = (await db.collection("deliveryAttempts").get()).docs;
    assert.equal(attempts.length, 1);

    const cods = (await db.collection("codCollections").get()).docs;
    assert.equal(cods.length, 1);

    const txs = (await db.collection("financialTransactions").get()).docs;
    assert.equal(txs.length, 1);
  });

  test("12. 100 simultaneous deliveries across 100 packages produce exactly 100 delivered packages, 100 COD ledger entries, and 0 duplicates", async () => {
    const db = new MockFirestore();
    const count = 100;

    // Seed 100 packages
    for (let i = 0; i < count; i++) {
      const pkgId = `pkg_bulk_${i}`;
      await db.collection("packages").doc(pkgId).set({
        id: pkgId,
        assignedRiderId: "rider_123",
        operationalStatus: "out_for_delivery",
        cod_expected: 1000 + i
      });
    }

    // Fire 100 delivery attempts concurrently
    const promises = [];
    for (let i = 0; i < count; i++) {
      const pkgId = `pkg_bulk_${i}`;
      promises.push(
        handleDeliveryAttempt(db, {
          auth: { uid: "user_rider_123", role: "rider", riderId: "rider_123" },
          body: {
            packageId: pkgId,
            status: "DELIVERED",
            collectedAmount: 1000 + i,
            paymentMethod: "cash",
            receiverName: `Receiver ${i}`,
            proofImageUrl: `https://storage.googleapis.com/proof/${i}.jpg`,
            latitude: 24.8607,
            longitude: 67.0011
          }
        })
      );
    }

    const results = await Promise.all(promises);
    for (const res of results) {
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
    }

    // Verify exactly 100 packages delivered
    const pkgs = (await db.collection("packages").get()).docs;
    assert.equal(pkgs.length, 100);
    for (const p of pkgs) {
      assert.equal(p.data().operationalStatus, "delivered");
    }

    // Verify exactly 100 delivery attempts
    const attempts = (await db.collection("deliveryAttempts").get()).docs;
    assert.equal(attempts.length, 100);

    // Verify exactly 100 COD collections
    const cods = (await db.collection("codCollections").get()).docs;
    assert.equal(cods.length, 100);

    // Verify exactly 100 financial transactions
    const txs = (await db.collection("financialTransactions").get()).docs;
    assert.equal(txs.length, 100);

    // Verify exactly 200 financial postings (100 DR + 100 CR)
    const postings = (await db.collection("financialPostings").get()).docs;
    assert.equal(postings.length, 200);
  });
});
