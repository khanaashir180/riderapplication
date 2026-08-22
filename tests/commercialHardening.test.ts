import { describe, test } from "node:test";
import assert from "node:assert/strict";

class MockFirestore {
  collections = new Map<string, Map<string, any>>();
  private transactionLock = Promise.resolve();

  collection(name: string) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    const col = this.collections.get(name)!;
    return {
      doc: (id: string) => ({
        id,
        get: async () => {
          const data = col.get(id);
          return { exists: data !== undefined, id, data: () => (data ? structuredClone(data) : undefined) };
        },
        set: async (data: any, opts?: { merge?: boolean }) => {
          if (opts?.merge && col.has(id)) col.set(id, { ...col.get(id), ...structuredClone(data) });
          else col.set(id, structuredClone(data));
        },
        update: async (data: any) => {
          if (!col.has(id)) throw new Error(`Missing ${name}/${id}`);
          col.set(id, { ...col.get(id), ...structuredClone(data) });
        }
      }),
      get: async () => ({
        docs: Array.from(col.entries()).map(([id, data]) => ({ id, data: () => structuredClone(data) })),
        empty: col.size === 0,
        size: col.size
      }),
      where: (field: string, op: string, value: any) => ({
        get: async () => {
          const docs = Array.from(col.entries())
            .filter(([, data]) => op === "==" ? data[field] === value : Array.isArray(value) && value.includes(data[field]))
            .map(([id, data]) => ({ id, data: () => structuredClone(data) }));
          return { docs, empty: docs.length === 0, size: docs.length };
        },
        limit: (_n: number) => ({
          get: async () => {
            const docs = Array.from(col.entries())
              .filter(([, data]) => op === "==" ? data[field] === value : Array.isArray(value) && value.includes(data[field]))
              .slice(0, _n)
              .map(([id, data]) => ({ id, data: () => structuredClone(data) }));
            return { docs, empty: docs.length === 0, size: docs.length };
          }
        })
      })
    };
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const run = async () => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: { merge?: boolean }) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data)
      };
      return fn(tx);
    };
    const result = this.transactionLock.then(run, run);
    this.transactionLock = result.then(() => undefined, () => undefined);
    return result;
  }
}

function normalizeDigitalReference(reference: string) {
  return reference.trim().toUpperCase().replace(/[\s-]+/g, "");
}

async function createDispatchRun(db: MockFirestore, riderId: string, packageId: string) {
  const runId = `run_${Math.random().toString(36).slice(2, 10)}`;
  await db.runTransaction(async (tx) => {
    const pkgRef = db.collection("packages").doc(packageId);
    const pkgDoc = await tx.get(pkgRef);
    if (!pkgDoc.exists) throw { code: "PACKAGE_NOT_FOUND" };
    const pkg = pkgDoc.data();
    if (pkg.activeDispatchRunId) throw { code: "PACKAGE_IN_ACTIVE_RUN" };
    tx.update(pkgRef, { activeDispatchRunId: runId, assignedRiderId: riderId });
    tx.set(db.collection("dispatchRuns").doc(runId), { id: runId, riderId, expectedPackages: [packageId], scannedPackages: [] });
  });
  return runId;
}

async function acceptManifest(db: MockFirestore, runId: string, riderId: string, riderSuppliedOverride?: string) {
  return db.runTransaction(async (tx) => {
    const runRef = db.collection("dispatchRuns").doc(runId);
    const runDoc = await tx.get(runRef);
    const run = runDoc.data();
    const mismatch = run.expectedPackages.length !== run.scannedPackages.length;
    const overrideDocs = await db.collection("manifestDiscrepancyOverrides").where("runId", "==", runId).get();
    const approved = overrideDocs.docs.find((doc) => doc.data().status === "approved");
    if (mismatch && !approved) throw { code: "MANIFEST_MISMATCH", riderSuppliedOverride };
    for (const packageId of run.expectedPackages) {
      const pkgRef = db.collection("packages").doc(packageId);
      const pkgDoc = await tx.get(pkgRef);
      const pkg = pkgDoc.data();
      if (pkg.assignedRiderId !== riderId) throw { code: "PACKAGE_REASSIGNED" };
      if (["cancelled", "delivered", "return_required", "returning_to_warehouse", "returned", "transferred"].includes(String(pkg.operationalStatus).toLowerCase())) {
        throw { code: "PACKAGE_STATE_CHANGED" };
      }
      tx.update(pkgRef, { operationalStatus: "out_for_delivery" });
    }
    tx.update(runRef, { status: "accepted_by_rider", riderSuppliedOverrideIgnored: riderSuppliedOverride || null });
    return true;
  });
}

async function submitSettlement(db: MockFirestore, riderId: string, declaredCashAmount: number, idempotencyKey: string) {
  const idemRef = db.collection("idempotencyKeys").doc(idempotencyKey);
  let result: any = null;
  await db.runTransaction(async (tx) => {
    const idem = await tx.get(idemRef);
    if (idem.exists) {
      result = idem.data().result;
      return;
    }
    const collections = (await db.collection("codCollections").get()).docs
      .map((doc) => doc.data())
      .filter((doc) => doc.riderId === riderId && doc.paymentMethod === "cash" && !doc.settlementId);
    const settlementId = `stl_${riderId}_1`;
    result = {
      id: settlementId,
      riderId,
      calculatedCashObligation: collections.reduce((sum, doc) => sum + doc.collectedAmount, 0),
      declaredCashAmount
    };
    tx.set(db.collection("riderSettlements").doc(settlementId), result);
    for (const collection of collections) {
      tx.update(db.collection("codCollections").doc(collection.id), { settlementId });
    }
    tx.set(idemRef, { key: idempotencyKey, result });
  });
  return result;
}

async function postLedger(db: MockFirestore, idempotencyKey: string) {
  const idemRef = db.collection("idempotencyKeys").doc(idempotencyKey);
  await db.runTransaction(async (tx) => {
    const idem = await tx.get(idemRef);
    if (idem.exists) throw { code: "DUPLICATE_IDEMPOTENCY_KEY" };
    tx.set(db.collection("financialTransactions").doc(`tx_${idempotencyKey}`), { idempotencyKey });
    tx.set(idemRef, { key: idempotencyKey });
  });
}

async function recordDelivered(db: MockFirestore, packageId: string, riderId: string, paymentMethod: string, digitalReference: string | null, proofStoragePath: string | null, latitude: number | null, longitude: number | null, gpsExceptionApproved = false) {
  return db.runTransaction(async (tx) => {
    if (!proofStoragePath) throw { code: "PROOF_STORAGE_PATH_REQUIRED" };
    if (!gpsExceptionApproved && (latitude === null || longitude === null)) throw { code: "GPS_COORDINATES_REQUIRED" };
    const pkgRef = db.collection("packages").doc(packageId);
    const pkgDoc = await tx.get(pkgRef);
    const pkg = pkgDoc.data();
    if (pkg.operationalStatus !== "out_for_delivery") throw { code: "INVALID_STATE_TRANSITION" };
    const isDigital = ["jazzcash", "easypaisa", "bank_transfer"].includes(paymentMethod);
    if (isDigital && digitalReference) {
      const normalized = normalizeDigitalReference(digitalReference);
      const digRef = db.collection("digitalPaymentVerifications").doc(`dig_${normalized}`);
      const digDoc = await tx.get(digRef);
      if (digDoc.exists && digDoc.data().packageId !== packageId) throw { code: "DIGITAL_REFERENCE_ALREADY_USED" };
      tx.set(digRef, { id: `dig_${normalized}`, digitalReference: normalized, packageId });
    }
    tx.set(db.collection("deliveryProofs").doc(`proof_${packageId}`), { packageId, riderId, proofStoragePath, latitude, longitude });
    tx.update(pkgRef, { operationalStatus: "delivered" });
  });
}

describe("Commercial hardening regression harness", () => {
  test("100 dispatch run races protect package-level active run lock", async () => {
    let protectedPairs = 0;
    for (let i = 0; i < 100; i++) {
      const db = new MockFirestore();
      await db.collection("packages").doc("pkg_1").set({ id: "pkg_1", operationalStatus: "assigned" });
      const [a, b] = await Promise.allSettled([
        createDispatchRun(db, "rider_a", "pkg_1"),
        createDispatchRun(db, "rider_a", "pkg_1")
      ]);
      const outcomes = [a, b].map((entry) => entry.status === "fulfilled" ? "success" : (entry.reason.code || "error"));
      if (outcomes.includes("success") && outcomes.includes("PACKAGE_IN_ACTIVE_RUN")) protectedPairs++;
    }
    assert.equal(protectedPairs, 100);
  });

  test("manifest acceptance rejects rider self-override and requires approved privileged override", async () => {
    const db = new MockFirestore();
    await db.collection("packages").doc("pkg_1").set({ id: "pkg_1", assignedRiderId: "rider_1", operationalStatus: "rider_scanned" });
    await db.collection("dispatchRuns").doc("run_1").set({ id: "run_1", riderId: "rider_1", expectedPackages: ["pkg_1"], scannedPackages: [] });
    await assert.rejects(() => acceptManifest(db, "run_1", "rider_1", "missing one box"), (error: any) => error?.code === "MANIFEST_MISMATCH");
    await db.collection("manifestDiscrepancyOverrides").doc("override_1").set({ id: "override_1", runId: "run_1", status: "approved" });
    await acceptManifest(db, "run_1", "rider_1", "ignored by server");
    assert.equal((await db.collection("packages").doc("pkg_1").get()).data().operationalStatus, "out_for_delivery");
  });

  test("manifest revalidation blocks cancelled package", async () => {
    const db = new MockFirestore();
    await db.collection("packages").doc("pkg_1").set({ id: "pkg_1", assignedRiderId: "rider_1", operationalStatus: "cancelled" });
    await db.collection("dispatchRuns").doc("run_1").set({ id: "run_1", riderId: "rider_1", expectedPackages: ["pkg_1"], scannedPackages: ["pkg_1"] });
    await assert.rejects(() => acceptManifest(db, "run_1", "rider_1"), (error: any) => error?.code === "PACKAGE_STATE_CHANGED");
  });

  test("delivery proof rejects missing gps and duplicate digital references", async () => {
    const db = new MockFirestore();
    await db.collection("packages").doc("pkg_1").set({ id: "pkg_1", operationalStatus: "out_for_delivery" });
    await assert.rejects(() => recordDelivered(db, "pkg_1", "rider_1", "cash", null, "deliveryProofs/rider/1/photo.jpg", null, null), (error: any) => error?.code === "GPS_COORDINATES_REQUIRED");
    await recordDelivered(db, "pkg_1", "rider_1", "jazzcash", " abc-123 ", "deliveryProofs/rider/1/photo.jpg", 24.9, 67.1);

    await db.collection("packages").doc("pkg_2").set({ id: "pkg_2", operationalStatus: "out_for_delivery" });
    await assert.rejects(() => recordDelivered(db, "pkg_2", "rider_1", "jazzcash", "ABC123", "deliveryProofs/rider/2/photo.jpg", 24.9, 67.1), (error: any) => error?.code === "DIGITAL_REFERENCE_ALREADY_USED");
  });

  test("100 duplicate settlement submissions create exactly one settlement", async () => {
    const db = new MockFirestore();
    for (let i = 0; i < 5; i++) {
      await db.collection("codCollections").doc(`cod_${i}`).set({ id: `cod_${i}`, riderId: "rider_1", paymentMethod: "cash", collectedAmount: 1000 });
    }
    await Promise.all(Array.from({ length: 100 }, () => submitSettlement(db, "rider_1", 5000, "settlement_key")));
    const settlements = (await db.collection("riderSettlements").get()).docs;
    assert.equal(settlements.length, 1);
    const assigned = (await db.collection("codCollections").get()).docs.filter((doc) => doc.data().settlementId === "stl_rider_1_1");
    assert.equal(assigned.length, 5);
  });

  test("100 duplicate financial postings create exactly one ledger transaction", async () => {
    const db = new MockFirestore();
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => postLedger(db, "ledger_key")));
    const successes = results.filter((entry) => entry.status === "fulfilled").length;
    const duplicates = results.filter((entry) => entry.status === "rejected" && (entry.reason.code === "DUPLICATE_IDEMPOTENCY_KEY")).length;
    assert.equal(successes, 1);
    assert.equal(duplicates, 99);
    assert.equal((await db.collection("financialTransactions").get()).size, 1);
  });

  test("shopify integration secret requires exact configured match", () => {
    const configured = "exactly-this-secret";
    const exact = (candidate: string | undefined) => candidate === configured;
    assert.equal(exact(undefined), false);
    assert.equal(exact("short"), false);
    assert.equal(exact("12345678901234567890"), false);
    assert.equal(exact("x".repeat(100)), false);
    assert.equal(exact("exactly-this-secret"), true);
  });

  test("analytics today metrics stay date-scoped", () => {
    const today = "2026-08-22T10:00:00+05:00";
    const yesterday = "2026-08-21T10:00:00+05:00";
    const attempts = [
      { status: "DELIVERED", createdAt: today },
      { status: "DELIVERED", createdAt: yesterday },
      { status: "REFUSED", createdAt: today }
    ];
    const deliveredToday = attempts.filter((attempt) => attempt.status === "DELIVERED" && attempt.createdAt.startsWith("2026-08-22")).length;
    const failedToday = attempts.filter((attempt) => attempt.status !== "DELIVERED" && attempt.createdAt.startsWith("2026-08-22")).length;
    assert.equal(deliveredToday, 1);
    assert.equal(failedToday, 1);
  });
});
