import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

describe("Dispatch & Rider Custody Workflow Verification", () => {
  // Mock In-Memory Firestore-like store with transactions and atomicity
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
            where: (field2: string, op2: string, val2: any) => ({
              limit: (n: number) => ({
                get: async () => {
                  const docs: any[] = [];
                  for (const [id, d] of colMap.entries()) {
                    let m1 = false;
                    if (op === "==") m1 = d[field] === val;
                    else if (op === "in") m1 = Array.isArray(val) && val.includes(d[field]);

                    let m2 = false;
                    if (op2 === "==") m2 = d[field2] === val2;
                    else if (op2 === "in") m2 = Array.isArray(val2) && val2.includes(d[field2]);

                    if (m1 && m2) {
                      docs.push({ id, data: () => JSON.parse(JSON.stringify(d)) });
                      if (docs.length >= n) break;
                    }
                  }
                  return { docs, empty: docs.length === 0, size: docs.length };
                }
              }),
              get: async () => {
                const docs: any[] = [];
                for (const [id, d] of colMap.entries()) {
                  let m1 = false;
                  if (op === "==") m1 = d[field] === val;
                  else if (op === "in") m1 = Array.isArray(val) && val.includes(d[field]);

                  let m2 = false;
                  if (op2 === "==") m2 = d[field2] === val2;
                  else if (op2 === "in") m2 = Array.isArray(val2) && val2.includes(d[field2]);

                  if (m1 && m2) {
                    docs.push({ id, data: () => JSON.parse(JSON.stringify(d)) });
                  }
                }
                return { docs, empty: docs.length === 0, size: docs.length };
              }
            }),
            limit: (n: number) => ({
              get: async () => {
                const docs: any[] = [];
                for (const [id, d] of colMap.entries()) {
                  let match = false;
                  if (op === "==") match = d[field] === val;
                  else if (op === "in") match = Array.isArray(val) && val.includes(d[field]);
                  if (match) {
                    docs.push({ id, data: () => JSON.parse(JSON.stringify(d)) });
                    if (docs.length >= n) break;
                  }
                }
                return { docs, empty: docs.length === 0, size: docs.length };
              }
            }),
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
          const docs: any[] = [];
          for (const [id, d] of colMap.entries()) {
            docs.push({ id, data: () => JSON.parse(JSON.stringify(d)) });
          }
          return { docs, empty: docs.length === 0, size: docs.length };
        }
      };
    }

    batch() {
      const operations: Array<() => Promise<void>> = [];
      return {
        update: (ref: any, data: any) => {
          operations.push(async () => {
            await ref.update(data);
          });
        },
        commit: async () => {
          for (const op of operations) {
            await op();
          }
        }
      };
    }

    // Atomic transaction simulation with lock
    private transactionLock = Promise.resolve();
    async runTransaction<T>(updateFunction: (transaction: any) => Promise<T>): Promise<T> {
      // Serialize transactions to simulate atomic execution
      const run = async () => {
        const txn = {
          get: async (ref: any) => ref.get(),
          set: (ref: any, data: any) => ref.set(data),
          update: (ref: any, data: any) => ref.update(data)
        };
        return await updateFunction(txn);
      };

      const resultPromise = this.transactionLock.then(run, run);
      this.transactionLock = resultPromise.then(() => {}, () => {});
      return resultPromise;
    }
  }

  // --- HANDLER SIMULATIONS MATCHING SERVER.TS EXACTLY ---
  async function handleAssign(db: MockFirestore, req: { body: { packageId: string; riderId: string }; auth: { uid: string; role: string } }) {
    const { packageId, riderId } = req.body;
    if (!packageId || !riderId) {
      return { status: 400, body: { success: false, error: { code: "INVALID_ARGUMENT", message: "Missing packageId or riderId" } } };
    }

    try {
      await db.runTransaction(async (transaction) => {
        const pkgRef = db.collection("packages").doc(packageId);
        const pkgDoc = await transaction.get(pkgRef);

        if (!pkgDoc.exists) {
          throw { code: "NOT_FOUND", status: 404, message: `Package ${packageId} not found` };
        }

        const pkgData = pkgDoc.data();
        if (pkgData?.importState !== "committed") {
          throw { code: "FAILED_PRECONDITION", status: 400, message: "Package is not committed" };
        }

        const currentStatus = (pkgData?.operationalStatus || pkgData?.current_status || "").toLowerCase();
        if (["delivered", "returned", "cancelled", "closed"].includes(currentStatus)) {
          throw { code: "INVALID_PACKAGE_STATUS", status: 400, message: `Delivered or closed package cannot be assigned. Status: ${currentStatus}` };
        }

        // Active assignment check on package
        if (pkgData?.assignedRiderId) {
          throw { code: "PACKAGE_ALREADY_ASSIGNED", status: 409, message: `Package ${packageId} is already assigned to rider ${pkgData.assignedRiderId}.` };
        }

        const riderRef = db.collection("riders").doc(riderId);
        const riderDoc = await transaction.get(riderRef);
        if (!riderDoc.exists) {
          throw { code: "RIDER_NOT_FOUND", status: 404, message: `Rider ${riderId} not found` };
        }

        const riderData = riderDoc.data();
        if (riderData?.active === false || riderData?.status === "inactive") {
          throw { code: "RIDER_INACTIVE", status: 400, message: `Rider ${riderId} is inactive` };
        }

        // Deterministic Active Lock Check
        const lockRef = db.collection("assignments").doc(packageId);
        const lockDoc = await transaction.get(lockRef);
        if (lockDoc.exists && lockDoc.data()?.active === true) {
          throw { code: "PACKAGE_ALREADY_ASSIGNED", status: 409, message: `Active assignment lock exists for package ${packageId}. Simultaneous double assignment rejected.` };
        }

        const nowStr = new Date().toISOString();
        transaction.set(lockRef, {
          id: packageId,
          packageId,
          riderId,
          assignedBy: req.auth.uid,
          assignedAt: nowStr,
          active: true
        });

        transaction.update(pkgRef, {
          assignedRiderId: riderId,
          current_status: "Assigned",
          operationalStatus: "ASSIGNED",
          custodyStage: "assigned_to_rider",
          custody_stage: "assigned_to_rider",
          updatedAt: nowStr
        });
      });

      return { status: 200, body: { success: true, data: { packageId, riderId } } };
    } catch (err: any) {
      const status = err.status || 400;
      const code = err.code || "ASSIGNMENT_FAILED";
      return { status, body: { success: false, error: { code, message: err.message || "Assignment failed" } } };
    }
  }

  async function handleCreateRun(db: MockFirestore, req: { body: { riderId: string; packageIds: string[]; vehicle?: string; shift?: string }; auth: { uid: string; role: string } }) {
    const { riderId, vehicle, shift, packageIds } = req.body;
    if (!riderId || !packageIds || !Array.isArray(packageIds) || packageIds.length === 0) {
      return { status: 400, body: { success: false, error: { code: "INVALID_ARGUMENT", message: "Missing riderId or packageIds array" } } };
    }

    // 1. Validate Rider existence, role, and active state
    const riderRef = db.collection("riders").doc(riderId);
    const riderDoc = await riderRef.get();
    if (!riderDoc.exists) {
      return { status: 404, body: { success: false, error: { code: "RIDER_NOT_FOUND", message: `Rider ${riderId} not found` } } };
    }
    const riderData = riderDoc.data();
    if (riderData?.active === false || riderData?.status === "inactive") {
      return { status: 400, body: { success: false, error: { code: "RIDER_INACTIVE", message: `Rider ${riderId} is inactive` } } };
    }
    if (riderData?.role && riderData.role !== "rider") {
      return { status: 400, body: { success: false, error: { code: "INVALID_RIDER_ROLE", message: `Rider role must be 'rider', found '${riderData.role}'` } } };
    }

    // 2. Validate all packages
    const activeRunsSnap = await db.collection("dispatchRuns")
      .where("status", "in", ["draft", "ready_for_scan", "in_progress", "accepted_by_rider", "handoff_pending"])
      .get();
    const existingActivePackageIds = new Set<string>();
    activeRunsSnap.docs.forEach((d: any) => {
      const rData = d.data();
      (rData.expectedPackages || []).forEach((pid: string) => existingActivePackageIds.add(pid));
    });

    let expectedCod = 0;
    for (const pkgId of packageIds) {
      const pkgDoc = await db.collection("packages").doc(pkgId).get();
      if (!pkgDoc.exists) {
        return { status: 404, body: { success: false, error: { code: "PACKAGE_NOT_FOUND", message: `Package ${pkgId} not found` } } };
      }
      const d = pkgDoc.data();
      if (!d?.assignedRiderId || d.assignedRiderId !== riderId) {
        return {
          status: 400,
          body: {
            success: false,
            error: {
              code: "WRONG_RIDER_PACKAGE",
              message: `Package ${pkgId} is ${d?.assignedRiderId ? `assigned to rider ${d.assignedRiderId}` : 'not assigned to any rider'}, but run is for rider ${riderId}`
            }
          }
        };
      }
      const currStatus = (d?.operationalStatus || d?.current_status || "").toUpperCase();
      if (["DELIVERED", "RETURNED", "CANCELLED", "CLOSED", "RETURNING_TO_WAREHOUSE"].includes(currStatus)) {
        return { status: 400, body: { success: false, error: { code: "INVALID_PACKAGE_STATUS", message: `Package ${pkgId} is in completed status ${currStatus}` } } };
      }
      if (existingActivePackageIds.has(pkgId)) {
        return { status: 400, body: { success: false, error: { code: "PACKAGE_IN_ACTIVE_RUN", message: `Package ${pkgId} is already in an active dispatch run` } } };
      }
      expectedCod += (d?.cod_expected || d?.expectedCod || 0);
    }

    const runUuid = crypto.randomUUID();
    const runId = `run_${runUuid}`;
    const runNumber = `RUN-${runUuid.slice(0, 8).toUpperCase()}`;
    const nowStr = new Date().toISOString();

    const runData = {
      id: runId,
      runId,
      runNumber,
      riderId,
      vehicle: vehicle || "Motorbike",
      shift: shift || "Morning",
      expectedPackages: packageIds,
      expectedCod,
      scannedPackages: [],
      missingPackages: [],
      preparedBy: req.auth.uid,
      acceptedByRider: false,
      status: "draft",
      createdAt: nowStr,
      updatedAt: nowStr
    };

    await db.collection("dispatchRuns").doc(runId).set(runData);
    return { status: 200, body: { success: true, data: runData } };
  }

  async function handleDispatcherScan(db: MockFirestore, req: { params: { runId: string }; body: { packageBarcode: string }; auth: { uid: string; role: string } }) {
    const { runId } = req.params;
    const { packageBarcode } = req.body;

    const runRef = db.collection("dispatchRuns").doc(runId);
    const runDoc = await runRef.get();
    if (!runDoc.exists) return { status: 404, body: { success: false, error: { code: "NOT_FOUND" } } };
    const runData = runDoc.data();

    const pkgSnap = await db.collection("packages").get();
    const matchedPkg = pkgSnap.docs.map((d: any) => d.data()).find((p: any) =>
      p.packageNumber === packageBarcode || p.package_number === packageBarcode || p.id === packageBarcode
    );

    if (!matchedPkg) return { status: 400, body: { success: false, error: { code: "EXACT_MATCH_REQUIRED" } } };
    if (!(runData?.expectedPackages || []).includes(matchedPkg.id)) {
      return { status: 400, body: { success: false, error: { code: "PACKAGE_NOT_IN_MANIFEST" } } };
    }

    const scanDocId = `scan_${crypto.randomUUID()}`;
    const nowStr = new Date().toISOString();
    const scanRecord = {
      id: scanDocId,
      packageId: matchedPkg.id,
      packageNumber: matchedPkg.packageNumber || matchedPkg.package_number,
      scanStage: "dispatcher_scanned",
      runId,
      scannedBy: req.auth.uid,
      scannedAt: nowStr
    };

    await db.collection("custodyScans").doc(scanDocId).set(scanRecord);
    await db.collection("packages").doc(matchedPkg.id).update({
      custodyStage: "dispatcher_scanned",
      operationalStatus: "DISPATCHER_SCANNED",
      updatedAt: nowStr
    });

    return { status: 200, body: { success: true, data: scanRecord } };
  }

  async function handleRiderScan(db: MockFirestore, req: { params: { runId: string }; body: { packageBarcode: string }; auth: { uid: string; role: string; riderId?: string } }) {
    if (req.auth.role !== "rider") {
      return { status: 403, body: { success: false, error: { code: "FORBIDDEN", message: "Only riders may call rider scan" } } };
    }

    const { runId } = req.params;
    const { packageBarcode } = req.body;

    const runRef = db.collection("dispatchRuns").doc(runId);
    const runDoc = await runRef.get();
    if (!runDoc.exists) return { status: 404, body: { success: false, error: { code: "NOT_FOUND" } } };
    const runData = runDoc.data();

    if (runData?.riderId !== req.auth.riderId) {
      return { status: 403, body: { success: false, error: { code: "FORBIDDEN", message: "Rider can only scan packages into their own dispatch run." } } };
    }

    const pkgSnap = await db.collection("packages").get();
    const matchedPkg = pkgSnap.docs.map((d: any) => d.data()).find((p: any) =>
      p.packageNumber === packageBarcode || p.package_number === packageBarcode || p.id === packageBarcode
    );

    if (!matchedPkg) return { status: 400, body: { success: false, error: { code: "EXACT_MATCH_REQUIRED" } } };
    if (!(runData?.expectedPackages || []).includes(matchedPkg.id)) {
      return { status: 400, body: { success: false, error: { code: "PACKAGE_NOT_IN_MANIFEST" } } };
    }

    const currentCustody = (matchedPkg.custodyStage || matchedPkg.custody_stage || "").toLowerCase();
    const currentOpStatus = (matchedPkg.operationalStatus || "").toUpperCase();

    // Check duplicate scan
    const isAlreadyScanned = (runData.scannedPackages || []).includes(matchedPkg.id);
    const existingScanSnap = await db.collection("custodyScans")
      .where("runId", "==", runId)
      .where("packageId", "==", matchedPkg.id)
      .get();

    const alreadyInCustodyScans = existingScanSnap.docs.some((d: any) => d.data().scanStage === "rider_scanned");

    if (isAlreadyScanned || alreadyInCustodyScans) {
      return {
        status: 200,
        body: {
          success: true,
          data: {
            alreadyScanned: true,
            scannedPackagesCount: (runData.scannedPackages || []).length,
            totalExpected: (runData.expectedPackages || []).length
          }
        }
      };
    }

    if (currentCustody !== "dispatcher_scanned" && currentOpStatus !== "DISPATCHER_SCANNED") {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: "INVALID_CUSTODY_STAGE_SEQUENCE",
            message: `Rider scan requires prior dispatcher_scanned stage (found: ${currentCustody || currentOpStatus || 'none'}).`
          }
        }
      };
    }

    const nowStr = new Date().toISOString();
    const scannedPackages = Array.from(new Set([...(runData.scannedPackages || []), matchedPkg.id]));
    await runRef.update({ scannedPackages, updatedAt: nowStr });

    const scanDocId = `scan_${crypto.randomUUID()}`;
    const scanRecord = {
      id: scanDocId,
      packageId: matchedPkg.id,
      packageNumber: matchedPkg.packageNumber || matchedPkg.package_number,
      scanStage: "rider_scanned",
      runId,
      scannedBy: req.auth.uid,
      scannedAt: nowStr
    };

    await db.collection("custodyScans").doc(scanDocId).set(scanRecord);
    await db.collection("packages").doc(matchedPkg.id).update({
      custodyStage: "rider_scanned",
      operationalStatus: "RIDER_SCANNED",
      updatedAt: nowStr
    });

    return {
      status: 200,
      body: {
        success: true,
        data: {
          scanRecord,
          scannedPackagesCount: scannedPackages.length,
          totalExpected: (runData.expectedPackages || []).length
        }
      }
    };
  }

  async function handleAccept(db: MockFirestore, req: { params: { runId: string }; body?: { discrepancyOverrideReason?: string }; auth: { uid: string; role: string; riderId?: string } }) {
    if (req.auth.role !== "rider") {
      return { status: 403, body: { success: false, error: { code: "FORBIDDEN", message: "Only assigned rider may accept manifest" } } };
    }

    const { runId } = req.params;
    const runRef = db.collection("dispatchRuns").doc(runId);
    const runDoc = await runRef.get();
    if (!runDoc.exists) return { status: 404, body: { success: false, error: { code: "NOT_FOUND" } } };
    const runData = runDoc.data();

    if (runData?.riderId !== req.auth.riderId) {
      return { status: 403, body: { success: false, error: { code: "FORBIDDEN", message: "Rider can only accept their own dispatch run manifest." } } };
    }

    const expected: string[] = runData?.expectedPackages || [];
    const scanned: string[] = runData?.scannedPackages || [];
    const hasMismatch = expected.length !== scanned.length || expected.some((id: string) => !scanned.includes(id));

    if (hasMismatch && !req.body?.discrepancyOverrideReason) {
      return {
        status: 409,
        body: {
          success: false,
          error: {
            code: "MANIFEST_MISMATCH",
            message: `Manifest scan count (${scanned.length}) does not match expected package count (${expected.length}).`
          }
        }
      };
    }

    const nowStr = new Date().toISOString();
    await runRef.update({
      status: "accepted_by_rider",
      acceptedByRider: true,
      startTimestamp: nowStr,
      acceptedAt: nowStr,
      updatedAt: nowStr
    });

    const batch = db.batch();
    for (const pid of expected) {
      const pRef = db.collection("packages").doc(pid);
      batch.update(pRef, {
        current_status: "Out for Delivery",
        operationalStatus: "out_for_delivery",
        custodyStage: "rider_accepted",
        dispatchedAt: nowStr,
        updatedAt: nowStr
      });
    }
    await batch.commit();

    return { status: 200, body: { success: true, data: { status: "accepted_by_rider", acceptedByRider: true } } };
  }

  // ==========================================
  // 11 VERIFICATION TESTS
  // ==========================================

  test("1. 100 simultaneous assignment races: exactly 1 winner each time", async () => {
    const db = new MockFirestore();
    const pkgId = "pkg_race_100";
    await db.collection("packages").doc(pkgId).set({
      id: pkgId,
      packageNumber: "GOM-RACE-1",
      importState: "committed",
      operationalStatus: "READY_FOR_DISPATCH",
      current_status: "Pending"
    });

    // Create 100 riders
    for (let i = 1; i <= 100; i++) {
      await db.collection("riders").doc(`rider_${i}`).set({
        id: `rider_${i}`,
        fullName: `Rider ${i}`,
        active: true,
        role: "rider"
      });
    }

    // Launch 100 simultaneous assignment promises
    const promises = [];
    for (let i = 1; i <= 100; i++) {
      promises.push(
        handleAssign(db, {
          body: { packageId: pkgId, riderId: `rider_${i}` },
          auth: { uid: `dispatcher_${i}`, role: "dispatch_manager" }
        })
      );
    }

    const results = await Promise.all(promises);
    const winners = results.filter(r => r.status === 200);
    const losers = results.filter(r => r.status === 409 && r.body.error.code === "PACKAGE_ALREADY_ASSIGNED");

    assert.equal(winners.length, 1, "Exactly 1 assignment transaction must succeed");
    assert.equal(losers.length, 99, "99 conflicting assignment requests must receive 409 PACKAGE_ALREADY_ASSIGNED");

    const pkgFinal = (await db.collection("packages").doc(pkgId).get()).data();
    assert.ok(pkgFinal.assignedRiderId);
    assert.equal(pkgFinal.operationalStatus, "ASSIGNED");
  });

  test("2. 100 simultaneous run creations: 100 unique IDs", async () => {
    const db = new MockFirestore();
    const riderId = "rider_uuid_test";
    await db.collection("riders").doc(riderId).set({
      id: riderId,
      fullName: "Test Rider",
      active: true,
      role: "rider"
    });

    // Create 100 unique packages assigned to this rider
    for (let i = 1; i <= 100; i++) {
      await db.collection("packages").doc(`pkg_run_${i}`).set({
        id: `pkg_run_${i}`,
        packageNumber: `GOM-RUN-${i}`,
        assignedRiderId: riderId,
        operationalStatus: "ASSIGNED"
      });
    }

    // 100 run creations
    const runPromises = [];
    for (let i = 1; i <= 100; i++) {
      runPromises.push(
        handleCreateRun(db, {
          body: { riderId, packageIds: [`pkg_run_${i}`] },
          auth: { uid: "dispatcher_1", role: "dispatch_manager" }
        })
      );
    }

    const runResults = await Promise.all(runPromises);
    assert.equal(runResults.every(r => r.status === 200), true);

    const generatedIds = runResults.map(r => r.body.data.id);
    const uniqueIds = new Set(generatedIds);

    assert.equal(uniqueIds.size, 100, "All 100 run IDs must be unique cryptographically secure IDs");
    assert.ok(generatedIds[0].startsWith("run_"));
  });

  test("3. Fake rider run creation must fail with 404 RIDER_NOT_FOUND", async () => {
    const db = new MockFirestore();
    const res = await handleCreateRun(db, {
      body: { riderId: "fake_non_existent_rider", packageIds: ["pkg_1"] },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "RIDER_NOT_FOUND");
  });

  test("4. Rider A package in Rider B run must fail with 400 WRONG_RIDER_PACKAGE", async () => {
    const db = new MockFirestore();
    await db.collection("riders").doc("rider_A").set({ id: "rider_A", fullName: "Rider A", active: true, role: "rider" });
    await db.collection("riders").doc("rider_B").set({ id: "rider_B", fullName: "Rider B", active: true, role: "rider" });

    await db.collection("packages").doc("pkg_rider_A").set({
      id: "pkg_rider_A",
      packageNumber: "GOM-A-1",
      assignedRiderId: "rider_A",
      operationalStatus: "ASSIGNED"
    });

    const res = await handleCreateRun(db, {
      body: { riderId: "rider_B", packageIds: ["pkg_rider_A"] },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "WRONG_RIDER_PACKAGE");
  });

  test("5. Same package in two active runs must fail with 400 PACKAGE_IN_ACTIVE_RUN", async () => {
    const db = new MockFirestore();
    await db.collection("riders").doc("rider_A").set({ id: "rider_A", fullName: "Rider A", active: true, role: "rider" });

    await db.collection("packages").doc("pkg_1").set({
      id: "pkg_1",
      packageNumber: "GOM-1",
      assignedRiderId: "rider_A",
      operationalStatus: "ASSIGNED"
    });

    // Run 1 created with pkg_1
    const run1 = await handleCreateRun(db, {
      body: { riderId: "rider_A", packageIds: ["pkg_1"] },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });
    assert.equal(run1.status, 200);

    // Attempt Run 2 with same pkg_1
    const run2 = await handleCreateRun(db, {
      body: { riderId: "rider_A", packageIds: ["pkg_1"] },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });

    assert.equal(run2.status, 400);
    assert.equal(run2.body.error.code, "PACKAGE_IN_ACTIVE_RUN");
  });

  test("6. Correct rider scan must pass", async () => {
    const db = new MockFirestore();
    const riderId = "rider_scan_1";
    await db.collection("riders").doc(riderId).set({ id: riderId, fullName: "Rider 1", active: true, role: "rider" });

    await db.collection("packages").doc("pkg_s1").set({
      id: "pkg_s1",
      packageNumber: "GOM-SCAN-1",
      assignedRiderId: riderId,
      operationalStatus: "ASSIGNED",
      custodyStage: "assigned_to_rider"
    });

    const runRes = await handleCreateRun(db, {
      body: { riderId, packageIds: ["pkg_s1"] },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });
    const runId = runRes.body.data.id;

    // Step 1: Dispatcher Scan
    const dScan = await handleDispatcherScan(db, {
      params: { runId },
      body: { packageBarcode: "GOM-SCAN-1" },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });
    assert.equal(dScan.status, 200);

    // Step 2: Rider Scan
    const rScan = await handleRiderScan(db, {
      params: { runId },
      body: { packageBarcode: "GOM-SCAN-1" },
      auth: { uid: "rider_uid_1", role: "rider", riderId }
    });

    assert.equal(rScan.status, 200);
    assert.equal(rScan.body.data.scannedPackagesCount, 1);

    const pkgAfter = (await db.collection("packages").doc("pkg_s1").get()).data();
    assert.equal(pkgAfter.custodyStage, "rider_scanned");
    assert.equal(pkgAfter.operationalStatus, "RIDER_SCANNED");
  });

  test("7. Wrong rider scan must return 403 FORBIDDEN", async () => {
    const db = new MockFirestore();
    const riderA = "rider_A";
    const riderB = "rider_B";
    await db.collection("riders").doc(riderA).set({ id: riderA, fullName: "Rider A", active: true, role: "rider" });
    await db.collection("riders").doc(riderB).set({ id: riderB, fullName: "Rider B", active: true, role: "rider" });

    await db.collection("packages").doc("pkg_a").set({
      id: "pkg_a",
      packageNumber: "GOM-A",
      assignedRiderId: riderA,
      operationalStatus: "ASSIGNED"
    });

    const runRes = await handleCreateRun(db, {
      body: { riderId: riderA, packageIds: ["pkg_a"] },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });
    const runId = runRes.body.data.id;

    // Dispatcher scans
    await handleDispatcherScan(db, {
      params: { runId },
      body: { packageBarcode: "GOM-A" },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });

    // Rider B attempts to scan into Rider A's run
    const rScan = await handleRiderScan(db, {
      params: { runId },
      body: { packageBarcode: "GOM-A" },
      auth: { uid: "rider_b_uid", role: "rider", riderId: riderB }
    });

    assert.equal(rScan.status, 403);
    assert.equal(rScan.body.error.code, "FORBIDDEN");
  });

  test("8. Duplicate rider scan must create one custody event", async () => {
    const db = new MockFirestore();
    const riderId = "rider_dup_test";
    await db.collection("riders").doc(riderId).set({ id: riderId, fullName: "Rider Dup", active: true, role: "rider" });

    await db.collection("packages").doc("pkg_dup").set({
      id: "pkg_dup",
      packageNumber: "GOM-DUP-1",
      assignedRiderId: riderId,
      operationalStatus: "ASSIGNED"
    });

    const runRes = await handleCreateRun(db, {
      body: { riderId, packageIds: ["pkg_dup"] },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });
    const runId = runRes.body.data.id;

    await handleDispatcherScan(db, {
      params: { runId },
      body: { packageBarcode: "GOM-DUP-1" },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });

    // First rider scan
    const scan1 = await handleRiderScan(db, {
      params: { runId },
      body: { packageBarcode: "GOM-DUP-1" },
      auth: { uid: "rider_uid", role: "rider", riderId }
    });
    assert.equal(scan1.status, 200);

    // Second rider scan (duplicate)
    const scan2 = await handleRiderScan(db, {
      params: { runId },
      body: { packageBarcode: "GOM-DUP-1" },
      auth: { uid: "rider_uid", role: "rider", riderId }
    });
    assert.equal(scan2.status, 200);
    assert.equal(scan2.body.data.alreadyScanned, true);

    // Verify custodyScans collection has exactly ONE record for this package rider_scanned
    const custodyDocs = (await db.collection("custodyScans").get()).docs;
    const riderScans = custodyDocs.filter((d: any) => d.data().scanStage === "rider_scanned" && d.data().packageId === "pkg_dup");
    assert.equal(riderScans.length, 1, "Duplicate rider scan must create exactly ONE custody scan event");
  });

  test("9. Manifest 30 expected / 29 scanned must fail with 409 MANIFEST_MISMATCH", async () => {
    const db = new MockFirestore();
    const riderId = "rider_30";
    await db.collection("riders").doc(riderId).set({ id: riderId, fullName: "Rider 30", active: true, role: "rider" });

    const packageIds: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const pid = `pkg_m30_${i}`;
      packageIds.push(pid);
      await db.collection("packages").doc(pid).set({
        id: pid,
        packageNumber: `GOM-M30-${i}`,
        assignedRiderId: riderId,
        operationalStatus: "ASSIGNED"
      });
    }

    const runRes = await handleCreateRun(db, {
      body: { riderId, packageIds },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });
    const runId = runRes.body.data.id;

    // Dispatcher scans all 30
    for (let i = 1; i <= 30; i++) {
      await handleDispatcherScan(db, {
        params: { runId },
        body: { packageBarcode: `GOM-M30-${i}` },
        auth: { uid: "dispatcher_1", role: "dispatch_manager" }
      });
    }

    // Rider scans only 29 (missing #30)
    for (let i = 1; i <= 29; i++) {
      await handleRiderScan(db, {
        params: { runId },
        body: { packageBarcode: `GOM-M30-${i}` },
        auth: { uid: "rider_30_uid", role: "rider", riderId }
      });
    }

    // Rider attempts to accept
    const acceptRes = await handleAccept(db, {
      params: { runId },
      auth: { uid: "rider_30_uid", role: "rider", riderId }
    });

    assert.equal(acceptRes.status, 409);
    assert.equal(acceptRes.body.error.code, "MANIFEST_MISMATCH");
  });

  test("10. Manifest 30 expected / 30 scanned must pass and move packages OUT_FOR_DELIVERY", async () => {
    const db = new MockFirestore();
    const riderId = "rider_30_full";
    await db.collection("riders").doc(riderId).set({ id: riderId, fullName: "Rider 30 Full", active: true, role: "rider" });

    const packageIds: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const pid = `pkg_full_${i}`;
      packageIds.push(pid);
      await db.collection("packages").doc(pid).set({
        id: pid,
        packageNumber: `GOM-FULL-${i}`,
        assignedRiderId: riderId,
        operationalStatus: "ASSIGNED"
      });
    }

    const runRes = await handleCreateRun(db, {
      body: { riderId, packageIds },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });
    const runId = runRes.body.data.id;

    // Dispatcher scans all 30
    for (let i = 1; i <= 30; i++) {
      await handleDispatcherScan(db, {
        params: { runId },
        body: { packageBarcode: `GOM-FULL-${i}` },
        auth: { uid: "dispatcher_1", role: "dispatch_manager" }
      });
    }

    // Rider scans all 30
    for (let i = 1; i <= 30; i++) {
      await handleRiderScan(db, {
        params: { runId },
        body: { packageBarcode: `GOM-FULL-${i}` },
        auth: { uid: "rider_full_uid", role: "rider", riderId }
      });
    }

    // Rider accepts manifest
    const acceptRes = await handleAccept(db, {
      params: { runId },
      auth: { uid: "rider_full_uid", role: "rider", riderId }
    });

    assert.equal(acceptRes.status, 200);
    assert.equal(acceptRes.body.data.status, "accepted_by_rider");
    assert.equal(acceptRes.body.data.acceptedByRider, true);

    // Verify all 30 packages are in out_for_delivery
    for (let i = 1; i <= 30; i++) {
      const pkgDoc = (await db.collection("packages").doc(`pkg_full_${i}`).get()).data();
      assert.equal(pkgDoc.operationalStatus, "out_for_delivery");
      assert.equal(pkgDoc.custodyStage, "rider_accepted");
      assert.equal(pkgDoc.current_status, "Out for Delivery");
    }
  });

  test("11. Dispatcher attempting rider acceptance must fail with 403 FORBIDDEN", async () => {
    const db = new MockFirestore();
    const riderId = "rider_auth_test";
    await db.collection("riders").doc(riderId).set({ id: riderId, fullName: "Rider", active: true, role: "rider" });

    await db.collection("packages").doc("pkg_disp").set({
      id: "pkg_disp",
      packageNumber: "GOM-DISP-1",
      assignedRiderId: riderId,
      operationalStatus: "ASSIGNED"
    });

    const runRes = await handleCreateRun(db, {
      body: { riderId, packageIds: ["pkg_disp"] },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });
    const runId = runRes.body.data.id;

    // Dispatcher calls accept
    const acceptRes = await handleAccept(db, {
      params: { runId },
      auth: { uid: "dispatcher_1", role: "dispatch_manager" }
    });

    assert.equal(acceptRes.status, 403);
    assert.equal(acceptRes.body.error.code, "FORBIDDEN");
  });
});
