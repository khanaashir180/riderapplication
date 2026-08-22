import assert from "node:assert/strict";
import { initializeApp as initializeClientApp, deleteApp, type FirebaseApp } from "firebase/app";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  type Auth
} from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable, type Functions } from "firebase/functions";
import { getApps, initializeApp as initializeAdminApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || "gen-lang-client-0398272509";
const functionsHost = "127.0.0.1";
const functionsPort = 5001;
const authUrl = "http://127.0.0.1:9099";

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

if (!getApps().length) {
  initializeAdminApp({ projectId });
}

const db = getFirestore();

async function createOrSignIn(auth: Auth, email: string, password: string) {
  try {
    await createUserWithEmailAndPassword(auth, email, password);
  } catch (err: any) {
    if (err?.code !== "auth/email-already-in-use") {
      throw err;
    }
  }
  await signInWithEmailAndPassword(auth, email, password);
}

async function makeClient(name: string, email: string, password: string) {
  const app: FirebaseApp = initializeClientApp(
    {
      apiKey: "fake-key",
      authDomain: `${projectId}.firebaseapp.com`,
      projectId,
      appId: `1:123:web:${name}`
    },
    name
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, authUrl, { disableWarnings: true });
  await createOrSignIn(auth, email, password);
  const functions = getFunctions(app, "us-central1");
  connectFunctionsEmulator(functions, functionsHost, functionsPort);
  return { app, auth, functions };
}

async function expectCallableFailure(functions: Functions, name: string, data: any, assertion?: (err: any) => void) {
  try {
    await httpsCallable(functions, name)(data);
    assert.fail(`Callable ${name} unexpectedly succeeded`);
  } catch (err: any) {
    assertion?.(err);
  }
}

async function run() {
  const dispatchClient = await makeClient("dispatch-client", "dispatch_manager@gomila.com", "Password123!");
  const riderClient = await makeClient("rider-client", "rider_a@gomila.com", "Password123!");
  const warehouseClient = await makeClient("warehouse-client", "warehouse@gomila.com", "Password123!");

  try {
    await db.recursiveDelete(db.collection("profiles"));
    await db.recursiveDelete(db.collection("riders"));
    await db.recursiveDelete(db.collection("packages"));
    await db.recursiveDelete(db.collection("assignments"));
    await db.recursiveDelete(db.collection("deliveryAttempts"));
    await db.recursiveDelete(db.collection("codAllocationReviews"));
    await db.recursiveDelete(db.collection("codAllocations"));
    await db.recursiveDelete(db.collection("shipments"));

    const dispatchUid = dispatchClient.auth.currentUser?.uid;
    const riderUid = riderClient.auth.currentUser?.uid;
    const warehouseUid = warehouseClient.auth.currentUser?.uid;
    assert.ok(dispatchUid && riderUid && warehouseUid, "Expected emulator auth users to be signed in");

    await db.collection("profiles").doc(dispatchUid).set({
      id: dispatchUid,
      authUserId: dispatchUid,
      email: "dispatch_manager@gomila.com",
      role: "dispatch_manager",
      active: true
    });
    await db.collection("profiles").doc(riderUid).set({
      id: riderUid,
      authUserId: riderUid,
      email: "rider_a@gomila.com",
      role: "rider",
      riderId: "rider_a_doc",
      active: true
    });
    await db.collection("profiles").doc(warehouseUid).set({
      id: warehouseUid,
      authUserId: warehouseUid,
      email: "warehouse@gomila.com",
      role: "warehouse_staff",
      active: true
    });

    await db.collection("riders").doc("rider_a_doc").set({
      id: "rider_a_doc",
      profileId: riderUid,
      active: true
    });

    await db.collection("packages").doc("pkg_callable_cod").set({
      id: "pkg_callable_cod",
      packageId: "pkg_callable_cod",
      packageNumber: "PKG-CALLABLE-COD",
      parentOrderNumber: "ORD-CALLABLE-1",
      operationalStatus: "dispatched",
      current_status: "dispatched",
      importState: "committed"
    });
    await db.collection("codAllocationReviews").doc("rev_callable_cod").set({
      id: "rev_callable_cod",
      parentOrderNumber: "ORD-CALLABLE-1",
      remainingBalance: 1200,
      activePackageNumbers: ["PKG-CALLABLE-COD"],
      status: "Pending"
    });
    await db.collection("shipments").doc("ship_1").set({
      id: "ship_1",
      courierBookedAt: "2026-08-20T00:00:00.000Z"
    });

    await expectCallableFailure(dispatchClient.functions, "assignPackage", {
      packageId: "pkg_removed_assign",
      riderId: "rider_a_doc"
    });
    assert.equal((await db.collection("assignments").get()).empty, true, "Removed assignPackage callable must not write assignments");

    await expectCallableFailure(dispatchClient.functions, "transferAssignment", {
      packageId: "pkg_removed_transfer",
      sourceRiderId: "rider_a_doc",
      destinationRiderId: "rider_b_doc",
      transferReason: "deprecated"
    });

    await expectCallableFailure(riderClient.functions, "recordDeliveryAttempt", {
      packageId: "pkg_removed_delivery",
      status: "DELIVERED"
    });
    assert.equal((await db.collection("deliveryAttempts").get()).empty, true, "Removed recordDeliveryAttempt callable must not write attempts");

    await expectCallableFailure(riderClient.functions, "approveCodAllocation", {
      reviewId: "rev_callable_cod",
      allocations: [{ packageId: "pkg_callable_cod", allocatedCod: 1200 }]
    }, (err) => {
      assert.match(String(err?.code || err?.message || ""), /permission-denied|functions\/permission-denied/i);
    });

    await expectCallableFailure(dispatchClient.functions, "approveCodAllocation", {
      reviewId: "rev_callable_cod",
      allocations: [{ packageNumber: "PKG-CALLABLE-COD", allocatedCod: 1200 }]
    }, (err) => {
      assert.match(String(err?.code || err?.message || ""), /invalid-argument|functions\/invalid-argument/i);
    });

    const approveResult = await httpsCallable(dispatchClient.functions, "approveCodAllocation")({
      reviewId: "rev_callable_cod",
      allocations: [{ packageId: "pkg_callable_cod", packageNumber: "PKG-CALLABLE-COD", allocatedCod: 1200 }]
    });
    assert.equal((approveResult.data as any).success, true, "approveCodAllocation callable should succeed for dispatch manager");
    const approvedPackage = (await db.collection("packages").doc("pkg_callable_cod").get()).data();
    assert.equal(approvedPackage?.cod_expected, 1200, "Retained callable must use shared COD allocation authority");

    await expectCallableFailure(riderClient.functions, "recalculateActiveShipmentAgeing", {}, (err) => {
      assert.match(String(err?.code || err?.message || ""), /permission-denied|functions\/permission-denied/i);
    });

    const ageingResult = await httpsCallable(warehouseClient.functions, "recalculateActiveShipmentAgeing")({});
    assert.equal((ageingResult.data as any).success, true, "warehouse staff should be allowed to recalculate shipment ageing");

    console.log("Callable integration checks passed.");
  } finally {
    await deleteApp(dispatchClient.app);
    await deleteApp(riderClient.app);
    await deleteApp(warehouseClient.app);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
