import { describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  approveCodAllocationAuthority,
  assignPackageAuthority,
  recordDeliveryAttemptAuthority,
  transferAssignmentAuthority
} from "../src/services/logisticsAuthority.js";

class MockFirestore {
  collections: Map<string, Map<string, any>> = new Map();

  collection(name: string) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    const colMap = this.collections.get(name)!;

    const buildQuery = (filters: Array<{ field: string; op: string; value: any }>) => ({
      where: (field: string, op: string, value: any) => buildQuery([...filters, { field, op, value }]),
      limit: (_count: number) => buildQuery(filters),
      get: async () => {
        const docs = Array.from(colMap.entries())
          .filter(([, doc]) => filters.every((filter) => {
            if (filter.op === "==") return doc[filter.field] === filter.value;
            return false;
          }))
          .map(([id, doc]) => ({ id, data: () => structuredClone(doc) }));
        return { docs, empty: docs.length === 0, size: docs.length };
      }
    });

    return {
      doc: (id?: string) => {
        const docId = id || crypto.randomUUID();
        return {
          id: docId,
          _colMap: colMap,
          _colName: name,
          get: async () => {
            const data = colMap.get(docId);
            return {
              exists: data !== undefined,
              id: docId,
              data: () => (data ? structuredClone(data) : undefined)
            };
          },
          set: async (data: any, options?: { merge?: boolean }) => {
            if (options?.merge && colMap.has(docId)) {
              colMap.set(docId, { ...colMap.get(docId), ...structuredClone(data) });
            } else {
              colMap.set(docId, structuredClone(data));
            }
          },
          update: async (data: any) => {
            if (!colMap.has(docId)) throw new Error(`Doc ${docId} not found`);
            colMap.set(docId, { ...colMap.get(docId), ...structuredClone(data) });
          }
        };
      },
      where: (field: string, op: string, value: any) => buildQuery([{ field, op, value }]),
      get: async () => {
        const docs = Array.from(colMap.entries()).map(([id, doc]) => ({ id, data: () => structuredClone(doc) }));
        return { docs, empty: docs.length === 0, size: docs.length };
      }
    };
  }

  async runTransaction(updateFn: (transaction: any) => Promise<any>) {
    const writes: Array<() => void> = [];
    const tx = {
      get: async (ref: any) => {
        if (typeof ref.get === "function") return ref.get();
        throw new Error("Unsupported transactional read target");
      },
      set: (ref: any, data: any, options?: { merge?: boolean }) => {
        writes.push(() => {
          const colMap = ref._colMap;
          if (options?.merge && colMap.has(ref.id)) {
            colMap.set(ref.id, { ...colMap.get(ref.id), ...structuredClone(data) });
          } else {
            colMap.set(ref.id, structuredClone(data));
          }
        });
      },
      update: (ref: any, data: any) => {
        writes.push(() => {
          const colMap = ref._colMap;
          if (!colMap.has(ref.id)) throw new Error(`Doc ${ref.id} not found`);
          colMap.set(ref.id, { ...colMap.get(ref.id), ...structuredClone(data) });
        });
      }
    };
    const result = await updateFn(tx);
    writes.forEach((write) => write());
    return result;
  }
}

describe("Shared logistics authority", () => {
  test("assignPackageAuthority creates canonical assignment and package custody update", async () => {
    const db = new MockFirestore();
    await db.collection("packages").doc("pkg_1").set({
      id: "pkg_1",
      importState: "committed",
      operationalStatus: "unassigned",
      deliveryChannel: "Internal Rider"
    });
    await db.collection("riders").doc("rider_1").set({ id: "rider_1", active: true, maximumDailyCapacity: 10 });

    const result = await assignPackageAuthority({
      db,
      packageId: "pkg_1",
      riderId: "rider_1",
      actorUid: "dispatch_1"
    });

    assert.equal(result.packageId, "pkg_1");
    const pkg = (await db.collection("packages").doc("pkg_1").get()).data();
    assert.equal(pkg.assignedRiderId, "rider_1");
    assert.equal(pkg.custodyStage, "assigned_to_rider");
  });

  test("transferAssignmentAuthority rejects cross-rider transfer attempts", async () => {
    const db = new MockFirestore();
    await db.collection("assignments").doc("pkg_2").set({
      id: "pkg_2",
      packageId: "pkg_2",
      riderId: "rider_a",
      active: true
    });
    await db.collection("packages").doc("pkg_2").set({
      id: "pkg_2",
      assignedRiderId: "rider_a",
      operationalStatus: "assigned"
    });
    await db.collection("riders").doc("rider_b").set({ id: "rider_b", active: true });

    await assert.rejects(
      transferAssignmentAuthority({
        db,
        packageId: "pkg_2",
        destinationRiderId: "rider_b",
        transferReason: "attempt",
        actorUid: "rider_uid",
        actorRole: "rider",
        actorRiderId: "rider_c"
      }),
      (err: any) => err?.status === 403 && err?.code === "FORBIDDEN"
    );
  });

  test("recordDeliveryAttemptAuthority rejects invalid delivery transition and missing proof/gps", async () => {
    const db = new MockFirestore();
    await db.collection("packages").doc("pkg_3").set({
      id: "pkg_3",
      assignedRiderId: "rider_3",
      operationalStatus: "assigned",
      expectedCod: 1000
    });

    await assert.rejects(
      recordDeliveryAttemptAuthority({
        db,
        auth: { uid: "user_3", role: "rider", riderId: "rider_3" },
        body: {
          packageId: "pkg_3",
          status: "DELIVERED",
          collectedAmount: 1000,
          receiverName: "Ali",
          proofStoragePath: "deliveryProofs/user_3/att_1/proof.jpg"
        }
      }),
      (err: any) => err?.code === "INVALID_STATE_TRANSITION"
    );

    await db.collection("packages").doc("pkg_3").set({
      id: "pkg_3",
      assignedRiderId: "rider_3",
      operationalStatus: "out_for_delivery",
      expectedCod: 1000
    });

    await assert.rejects(
      recordDeliveryAttemptAuthority({
        db,
        auth: { uid: "user_3", role: "rider", riderId: "rider_3" },
        body: {
          packageId: "pkg_3",
          status: "DELIVERED",
          collectedAmount: 1000,
          receiverName: "Ali"
        }
      }),
      (err: any) => err?.code === "PROOF_STORAGE_PATH_REQUIRED"
    );
  });

  test("recordDeliveryAttemptAuthority posts COD ledger on successful delivered outcome", async () => {
    const db = new MockFirestore();
    await db.collection("packages").doc("pkg_4").set({
      id: "pkg_4",
      assignedRiderId: "rider_4",
      operationalStatus: "out_for_delivery",
      expectedCod: 2200,
      paymentMethod: "cash"
    });

    const result = await recordDeliveryAttemptAuthority({
      db,
      auth: { uid: "user_4", role: "rider", riderId: "rider_4" },
      body: {
        packageId: "pkg_4",
        status: "DELIVERED",
        collectedAmount: 2200,
        receiverName: "Sara",
        receiverRelationship: "Self",
        proofStoragePath: "deliveryProofs/user_4/att_demo/proof.jpg",
        latitude: 24.86,
        longitude: 67.0
      },
      verifyDeliveryProofStorageObject: async () => ({})
    });

    assert.equal(result.packageId, "pkg_4");
    assert.equal((await db.collection("deliveryAttempts").get()).size, 1);
    assert.equal((await db.collection("codCollections").get()).size, 1);
    assert.equal((await db.collection("financialTransactions").get()).size, 1);
    assert.equal((await db.collection("financialPostings").get()).size, 2);
  });

  test("approveCodAllocationAuthority validates canonical package linkage", async () => {
    const db = new MockFirestore();
    await db.collection("codAllocationReviews").doc("rev_1").set({
      id: "rev_1",
      parentOrderNumber: "ORD-1",
      remainingBalance: 900,
      activePackageNumbers: ["PKG-1"],
      status: "Pending"
    });
    await db.collection("packages").doc("pkg_1").set({
      id: "pkg_1",
      packageId: "pkg_1",
      packageNumber: "PKG-1",
      parentOrderNumber: "ORD-1",
      operationalStatus: "dispatched",
      importState: "committed"
    });

    const result = await approveCodAllocationAuthority({
      db,
      reviewId: "rev_1",
      allocations: [{ packageId: "pkg_1", packageNumber: "PKG-1", allocatedCod: 900 }],
      actorUid: "dispatch_1"
    });

    assert.equal(result.reviewId, "rev_1");
    const pkg = (await db.collection("packages").doc("pkg_1").get()).data();
    assert.equal(pkg.cod_expected, 900);
  });
});
