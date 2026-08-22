import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { initializeTestEnvironment, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import fs from "fs";
import path from "path";
import { createApp } from "../server.js";
import { createHash } from "crypto";
import { getFirestore } from "firebase-admin/firestore";
import { releaseCodeReservation, releaseUserMutationLockOrAlert } from "../src/server/adminUserRouter.js";

const app = createApp();

function getCodeLockDocId(code: string): string {
  const normalized = code.trim().replace(/\s+/g, " ").toUpperCase();
  return createHash("sha256").update(normalized).digest("hex");
}

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  throw new Error("Missing required emulator environment variables: FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_STORAGE_EMULATOR_HOST");
}

const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;

async function getOrAuthToken(email: string, pass: string): Promise<{ uid: string; token: string }> {
  const signUpUrl = `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`;
  const signInUrl = `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`;

  let res = await fetch(signUpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pass, returnSecureToken: true })
  });

  let data = await res.json();
  if (data.error && data.error.message === "EMAIL_EXISTS") {
    res = await fetch(signInUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: pass, returnSecureToken: true })
    });
    data = await res.json();
  }

  if (!data.idToken || !data.localId) {
    throw new Error(`Failed to authenticate emulator user ${email}: ${JSON.stringify(data)}`);
  }

  return { uid: data.localId, token: data.idToken };
}

describe("Admin User Management Integration & Emulator Tests", () => {
  let testEnv: RulesTestEnvironment;
  let superAdminAuth: { uid: string; token: string };
  let dispatchAuth: { uid: string; token: string };

  before(async () => {
    // Set environment variables for emulators if not already set
    process.env.FIRESTORE_EMULATOR_HOST = firestoreHost;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;

    const firestoreRules = fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8");
    const [host, portStr] = firestoreHost.split(":");

    testEnv = await initializeTestEnvironment({
      projectId: "gen-lang-client-0398272509",
      firestore: {
        rules: firestoreRules,
        host: host || "127.0.0.1",
        port: parseInt(portStr || "8080", 10)
      }
    });

    await testEnv.clearFirestore();

    // Authenticate test users in Auth emulator
    superAdminAuth = await getOrAuthToken("superadmin_test@gomila.pk", "AdminPass123!");
    dispatchAuth = await getOrAuthToken("dispatch_test@gomila.pk", "Dispatch123!");

    // Seed Super Admin and Dispatch Manager Profiles
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("profiles").doc(superAdminAuth.uid).set({
        id: superAdminAuth.uid,
        fullName: "Super Admin Test",
        email: "superadmin_test@gomila.pk",
        employeeCode: "EMP-0001",
        normalizedEmployeeCode: "EMP-0001",
        role: "super_admin",
        active: true,
        createdAt: new Date().toISOString()
      });

      await db.collection("profiles").doc(dispatchAuth.uid).set({
        id: dispatchAuth.uid,
        fullName: "Dispatch User Test",
        email: "dispatch_test@gomila.pk",
        employeeCode: "EMP-0002",
        normalizedEmployeeCode: "EMP-0002",
        role: "dispatch_manager",
        active: true,
        createdAt: new Date().toISOString()
      });
    });
  });

  after(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  it("should block non-super_admin users with 403 Forbidden", async () => {
    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${dispatchAuth.token}`);
    assert.equal(res.status, 403);
  });

  it("should create employee account and commit lock document with SHA-256 ID", async () => {
    const empCode = "EMP-9001";
    const empEmail = "emp9001@gomila.pk";
    const res = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Employee Nine",
        email: empEmail,
        phone: "03009990001",
        employeeCode: empCode,
        role: "dispatch_manager",
        active: true
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    const createdUid = res.body.data.uid;

    const expectedLockDocId = getCodeLockDocId(empCode);
    let lockDocData: any = null;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const doc = await db.collection("uniqueEmployeeCodes").doc(expectedLockDocId).get();
      lockDocData = doc.data();
    });

    assert.ok(lockDocData, "Lock document should exist");
    assert.equal(lockDocData.status, "committed");
    assert.equal(lockDocData.targetUid, createdUid);
    assert.ok(lockDocData.reservationId);
  });

  it("should reject duplicate employee code with 409 DUPLICATE_EMPLOYEE_CODE", async () => {
    const res = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Another Employee",
        email: "another@gomila.pk",
        phone: "03009990002",
        employeeCode: "EMP-9001",
        role: "dispatch_manager",
        active: true
      });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "DUPLICATE_EMPLOYEE_CODE");
  });

  it("should reject duplicate profile email with 400 DUPLICATE_EMAIL", async () => {
    const res = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Email Dup",
        email: "emp9001@gomila.pk",
        phone: "03009990003",
        employeeCode: "EMP-9002",
        role: "dispatch_manager",
        active: true
      });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "DUPLICATE_EMAIL");
  });

  it("should handle simultaneous duplicate employee code creation (one 201, one 409, 1 lock)", async () => {
    const concCode = "EMP-CONC-100";
    const [p1, p2] = await Promise.all([
      request(app)
        .post("/api/admin/users")
        .set("Authorization", `Bearer ${superAdminAuth.token}`)
        .send({
          fullName: "Concurrent User A",
          email: "concur_a@gomila.pk",
          phone: "03001112233",
          employeeCode: concCode,
          role: "cashier",
          active: true
        }),
      request(app)
        .post("/api/admin/users")
        .set("Authorization", `Bearer ${superAdminAuth.token}`)
        .send({
          fullName: "Concurrent User B",
          email: "concur_b@gomila.pk",
          phone: "03001112244",
          employeeCode: concCode,
          role: "cashier",
          active: true
        })
    ]);

    const successes = [p1, p2].filter((r) => r.status === 201);
    const conflicts = [p1, p2].filter((r) => r.status === 409);
    assert.equal(successes.length, 1);
    assert.equal(conflicts.length, 1);

    const expectedLockDocId = getCodeLockDocId(concCode);
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const doc = await db.collection("uniqueEmployeeCodes").doc(expectedLockDocId).get();
      assert.ok(doc.exists);
      assert.equal(doc.data()?.status, "committed");
    });
  });

  it("should handle simultaneous duplicate rider code creation (one 201, one 409)", async () => {
    const riderCode = "RIDER-CONC-200";
    const [p1, p2] = await Promise.all([
      request(app)
        .post("/api/admin/users")
        .set("Authorization", `Bearer ${superAdminAuth.token}`)
        .send({
          fullName: "Rider Conc A",
          email: "rider_a@gomila.pk",
          phone: "03005551111",
          employeeCode: "EMP-RIDER-A",
          role: "rider",
          active: true,
          riderCode: riderCode,
          vehicleType: "Bike",
          vehicleNumber: "LHR-111",
          city: "Lahore",
          assignedZone: "Zone 1",
          maximumDailyCapacity: 20
        }),
      request(app)
        .post("/api/admin/users")
        .set("Authorization", `Bearer ${superAdminAuth.token}`)
        .send({
          fullName: "Rider Conc B",
          email: "rider_b@gomila.pk",
          phone: "03005552222",
          employeeCode: "EMP-RIDER-B",
          role: "rider",
          active: true,
          riderCode: riderCode,
          vehicleType: "Bike",
          vehicleNumber: "LHR-222",
          city: "Lahore",
          assignedZone: "Zone 2",
          maximumDailyCapacity: 20
        })
    ]);

    const successes = [p1, p2].filter((r) => r.status === 201);
    const conflicts = [p1, p2].filter((r) => r.status === 409);
    assert.equal(successes.length, 1);
    assert.equal(conflicts.length, 1);

    const expectedLockDocId = getCodeLockDocId(riderCode);
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const doc = await db.collection("uniqueRiderCodes").doc(expectedLockDocId).get();
      assert.ok(doc.exists);
      assert.equal(doc.data()?.status, "committed");
    });
  });

  it("should test open operations returnStatus schema (rider_handed_back, returning_to_warehouse, return_requested block; warehouse_received, closed, cancelled do NOT block)", async () => {
    // 1. Create a rider
    const resCreateRider = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Rider Schema Test",
        email: "rider_schema@gomila.pk",
        phone: "03008889999",
        employeeCode: "EMP-RIDER-SCHEMA",
        role: "rider",
        active: true,
        riderCode: "RIDER-SCHEMA-1",
        vehicleType: "Motorbike",
        vehicleNumber: "LHR-888",
        city: "Lahore",
        assignedZone: "Gulberg",
        maximumDailyCapacity: 20
      });

    assert.equal(resCreateRider.status, 201);
    const riderUid = resCreateRider.body.data.uid;
    const riderId = resCreateRider.body.data.riderId;

    // Test blocking statuses
    const blockingStatuses = ["rider_handed_back", "returning_to_warehouse", "return_requested"];
    for (const status of blockingStatuses) {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await db.collection("returns").doc("ret_block_test").set({
          riderId,
          returnStatus: status,
          createdAt: new Date().toISOString()
        });
      });

      const resDeact = await request(app)
        .post(`/api/admin/users/${riderUid}/deactivate`)
        .set("Authorization", `Bearer ${superAdminAuth.token}`);

      assert.equal(resDeact.status, 409, `Status '${status}' should block deactivation`);
      assert.equal(resDeact.body.error.code, "RIDER_HAS_OPEN_OPERATIONS");
    }

    // Test non-blocking statuses
    const nonBlockingStatuses = ["warehouse_received", "closed", "cancelled"];
    for (const status of nonBlockingStatuses) {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await db.collection("returns").doc("ret_block_test").set({
          riderId,
          returnStatus: status,
          createdAt: new Date().toISOString()
        });
      });

      // Clear any other open ops
      const resDeact = await request(app)
        .post(`/api/admin/users/${riderUid}/deactivate`)
        .set("Authorization", `Bearer ${superAdminAuth.token}`);

      assert.equal(resDeact.status, 200, `Status '${status}' should NOT block deactivation`);

      // Reactivate for next loop
      await request(app)
        .post(`/api/admin/users/${riderUid}/activate`)
        .set("Authorization", `Bearer ${superAdminAuth.token}`);
    }

    // Clean up test document
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("returns").doc("ret_block_test").delete();
    });
  });

  it("should test releaseCodeReservation helper safety", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const docId = getCodeLockDocId("SAFE-TEST-001");
      const docRef = db.collection("uniqueEmployeeCodes").doc(docId);

      // Set committed lock
      await docRef.set({
        status: "committed",
        reservationId: "res-committed-123",
        targetUid: "uid-123"
      });

      // Attempting to release with reservationId should not delete committed lock
      await releaseCodeReservation(db as any, docRef as any, "res-committed-123");
      let checkSnap = await docRef.get();
      assert.ok(checkSnap.exists, "Committed lock must NOT be deleted by releaseCodeReservation");

      // Set reserved lock with reservationId 'res-A'
      await docRef.set({
        status: "reserved",
        reservationId: "res-A",
        targetUid: "uid-123"
      });

      // Mismatched reservationId 'res-B' should ignore deletion
      await releaseCodeReservation(db as any, docRef as any, "res-B");
      checkSnap = await docRef.get();
      assert.ok(checkSnap.exists, "Reserved lock must NOT be deleted if reservationId mismatches");

      // Matching reservationId 'res-A' should delete reserved lock
      await releaseCodeReservation(db as any, docRef as any, "res-A");
      checkSnap = await docRef.get();
      assert.equal(checkSnap.exists, false, "Reserved lock MUST be deleted when reservationId matches");
    });
  });

  it("should test password-setup-link endpoint", async () => {
    // Create an employee first
    const resCreate = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Link Setup User",
        email: "linksetup@gomila.pk",
        phone: "03007771122",
        employeeCode: "EMP-LINK-SETUP",
        role: "cashier",
        active: true
      });

    assert.equal(resCreate.status, 201);
    const targetUid = resCreate.body.data.uid;

    const resLink = await request(app)
      .post(`/api/admin/users/${targetUid}/password-setup-link`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`);

    assert.equal(resLink.status, 200);
    assert.equal(resLink.body.success, true);
    assert.ok(resLink.body.data.passwordSetupLink);
    assert.equal(resLink.body.data.setupLinkStatus, "generated");
  });

  it("should test pagination and search queries", async () => {
    const resList = await request(app)
      .get("/api/admin/users?pageSize=2")
      .set("Authorization", `Bearer ${superAdminAuth.token}`);

    assert.equal(resList.status, 200);
    assert.equal(resList.body.success, true);
    assert.ok(Array.isArray(resList.body.items));
    assert.ok(resList.body.items.length <= 2);

    const resSearchEmail = await request(app)
      .get("/api/admin/users?q=emp9001@gomila.pk")
      .set("Authorization", `Bearer ${superAdminAuth.token}`);

    assert.equal(resSearchEmail.status, 200);
    assert.ok(resSearchEmail.body.items.length >= 1);
  });

  it("should test optimistic profile versioning and concurrent update rejection", async () => {
    // 1. Create a user
    const resCreate = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Version Test User",
        email: "ver_test@gomila.pk",
        phone: "03001119988",
        employeeCode: "EMP-VER-001",
        role: "cashier",
        active: true
      });

    assert.equal(resCreate.status, 201);
    const targetUid = resCreate.body.data.uid;

    // Check version is 1
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const doc = await db.collection("profiles").doc(targetUid).get();
      assert.equal(doc.data()?.version, 1);
    });

    // Update once -> version becomes 2
    const resUpdate1 = await request(app)
      .patch(`/api/admin/users/${targetUid}`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        employeeCode: "EMP-VER-002"
      });

    assert.equal(resUpdate1.status, 200);

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const doc = await db.collection("profiles").doc(targetUid).get();
      assert.equal(doc.data()?.version, 2);
    });

    // Simultaneous updates on the same user with different new employee codes
    const [u1, u2] = await Promise.all([
      request(app)
        .patch(`/api/admin/users/${targetUid}`)
        .set("Authorization", `Bearer ${superAdminAuth.token}`)
        .send({ employeeCode: "EMP-VER-100", version: 2 }),
      request(app)
        .patch(`/api/admin/users/${targetUid}`)
        .set("Authorization", `Bearer ${superAdminAuth.token}`)
        .send({ employeeCode: "EMP-VER-200", version: 2 })
    ]);

    const successes = [u1, u2].filter((r) => r.status === 200);
    const conflicts = [u1, u2].filter((r) => r.status === 409);
    assert.equal(successes.length, 1);
    assert.equal(conflicts.length, 1);
    assert.ok(
      conflicts[0].body.error.code === "USER_UPDATED_CONCURRENTLY" ||
      conflicts[0].body.error.code === "EXISTING_CODE_LOCK_INCONSISTENT" ||
      conflicts[0].body.error.code === "DUPLICATE_EMPLOYEE_CODE"
    );

    // Verify exactly 1 committed lock exists for the winning new code
    const winningCode = successes[0].body.data.employeeCode;
    const winningLockId = getCodeLockDocId(winningCode);
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const lockDoc = await db.collection("uniqueEmployeeCodes").doc(winningLockId).get();
      assert.ok(lockDoc.exists);
      assert.equal(lockDoc.data()?.status, "committed");
      assert.equal(lockDoc.data()?.targetUid, targetUid);
    });
  });

  it("should reject update if previous code lock document is missing or inconsistent", async () => {
    // Create user
    const resCreate = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Inconsistent Lock Test",
        email: "inconsistent@gomila.pk",
        phone: "03004445555",
        employeeCode: "EMP-INCONSISTENT-1",
        role: "cashier",
        active: true
      });

    assert.equal(resCreate.status, 201);
    const targetUid = resCreate.body.data.uid;

    // Tamper/delete the lock document
    const oldLockId = getCodeLockDocId("EMP-INCONSISTENT-1");
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("uniqueEmployeeCodes").doc(oldLockId).delete();
    });

    // Updating employee code should fail with EXISTING_CODE_LOCK_INCONSISTENT
    const resUpdate = await request(app)
      .patch(`/api/admin/users/${targetUid}`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        employeeCode: "EMP-INCONSISTENT-2"
      });

    assert.equal(resUpdate.status, 409);
    assert.equal(resUpdate.body.error.code, "EXISTING_CODE_LOCK_INCONSISTENT");
  });

  it("should enforce strict concurrency lock during concurrent email updates", async () => {
    // 1. Create user
    const resCreate = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Email Concurrency User",
        email: "email_conc_init@gomila.pk",
        phone: "03001234560",
        employeeCode: "EMP-EMAIL-CONC",
        role: "cashier",
        active: true
      });

    assert.equal(resCreate.status, 201);
    const targetUid = resCreate.body.data.uid;

    // Concurrent email updates
    const [u1, u2] = await Promise.all([
      request(app)
        .patch(`/api/admin/users/${targetUid}`)
        .set("Authorization", `Bearer ${superAdminAuth.token}`)
        .send({ email: "email_conc_a@gomila.pk", version: 1 }),
      request(app)
        .patch(`/api/admin/users/${targetUid}`)
        .set("Authorization", `Bearer ${superAdminAuth.token}`)
        .send({ email: "email_conc_b@gomila.pk", version: 1 })
    ]);

    const successes = [u1, u2].filter((r) => r.status === 200);
    const conflicts = [u1, u2].filter((r) => r.status === 409);
    assert.equal(successes.length, 1);
    assert.equal(conflicts.length, 1);
    assert.ok(
      conflicts[0].body.error.code === "USER_OPERATION_IN_PROGRESS" ||
      conflicts[0].body.error.code === "USER_UPDATED_CONCURRENTLY"
    );

    // Verify mutation lock is cleaned up after completion
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const lockDoc = await db.collection("userMutationLocks").doc(targetUid).get();
      assert.equal(lockDoc.exists, false, "User mutation lock must be released after completion");
    });
  });

  it("should test rider-role conversion blocking by open assignments, dispatch runs, settlements, and returns", async () => {
    // Create rider
    const resCreate = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Rider Conversion Test",
        email: "rider_conv_test@gomila.pk",
        phone: "03009988776",
        employeeCode: "EMP-RIDER-CONV",
        role: "rider",
        active: true,
        riderCode: "RIDER-CONV-01",
        vehicleType: "Bike",
        vehicleNumber: "LHR-999",
        city: "Lahore",
        assignedZone: "Gulberg",
        maximumDailyCapacity: 15
      });

    assert.equal(resCreate.status, 201);
    const targetUid = resCreate.body.data.uid;
    const riderId = resCreate.body.data.riderId;

    // 1. Open assignment blocks role conversion
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("assignments").doc("asgn_open_1").set({
        riderId,
        active: true,
        assignmentStatus: "assigned",
        createdAt: new Date().toISOString()
      });
    });

    let resRoleChange = await request(app)
      .patch(`/api/admin/users/${targetUid}`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({ role: "cashier" });

    assert.equal(resRoleChange.status, 409);
    assert.equal(resRoleChange.body.error.code, "RIDER_HAS_OPEN_OPERATIONS");

    // Clear assignment
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("assignments").doc("asgn_open_1").delete();
    });

    // 2. Safe Rider -> Non-Rider conversion succeeds when no open ops
    resRoleChange = await request(app)
      .patch(`/api/admin/users/${targetUid}`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({ role: "cashier" });

    assert.equal(resRoleChange.status, 200);
    assert.equal(resRoleChange.body.data.role, "cashier");
    assert.equal(resRoleChange.body.data.riderCode, null);

    // Verify historical rider doc remains, active=false, old rider code lock is removed
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const riderSnap = await db.collection("riders").doc(riderId).get();
      assert.ok(riderSnap.exists, "Historical rider doc must be preserved");
      assert.equal(riderSnap.data()?.active, false);

      const oldRiderLockId = getCodeLockDocId("RIDER-CONV-01");
      const oldLockSnap = await db.collection("uniqueRiderCodes").doc(oldRiderLockId).get();
      assert.equal(oldLockSnap.exists, false, "Old rider code lock document must be removed");
    });
  });

  it("should test releaseUserMutationLockOrAlert reporting and recover-mutation-lock endpoint", async () => {
    // 1. Create target user
    const resCreate = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Lock Recover User",
        email: "lock_recover@gomila.pk",
        phone: "03001122334",
        employeeCode: "EMP-LOCK-REC",
        role: "cashier",
        active: true
      });

    assert.equal(resCreate.status, 201);
    const targetUid = resCreate.body.data.uid;

    const db = getFirestore();

    // 2. Test releaseUserMutationLockOrAlert with mismatched operationId
    const resAlert = await releaseUserMutationLockOrAlert({
      db,
      targetUid,
      operationId: "invalid-op-id",
      operation: "test_op",
      performedByUid: superAdminAuth.uid
    });

    assert.equal(resAlert, "not_found"); // No active lock exists

    // 3. Set a mock stale active lock
    const lockRef = db.collection("userMutationLocks").doc(targetUid);
    await lockRef.set({
      operationId: "stale-op-123",
      operation: "activate_user",
      status: "active",
      createdAt: new Date(Date.now() - 120000), // 2 minutes old (> 60s threshold)
      heartbeatAt: new Date(Date.now() - 120000),
      leaseExpiresAt: new Date(Date.now() - 60000) // Expired 1 minute ago
    });

    // Test releaseUserMutationLockOrAlert with wrong operationId -> creates systemAlerts record
    const resNotOwned = await releaseUserMutationLockOrAlert({
      db,
      targetUid,
      operationId: "wrong-op-456",
      operation: "activate_user",
      performedByUid: superAdminAuth.uid
    });

    assert.equal(resNotOwned, "not_owned");

    let alertDocs: any[] = [];
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const snap = await context.firestore().collection("systemAlerts").where("targetUid", "==", targetUid).get();
      alertDocs = snap.docs.map(d => d.data());
    });
    assert.ok(alertDocs.length >= 1, "System alert must be logged for failed lock release");
    assert.equal(alertDocs[0].type, "USER_MUTATION_LOCK_RELEASE_FAILED");

    // 4. Test recover-mutation-lock endpoint without reason -> 400
    const resNoReason = await request(app)
      .post(`/api/admin/users/${targetUid}/recover-mutation-lock`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({});

    assert.equal(resNoReason.status, 400);

    // 5. Recover stale lock -> 200 Success
    const resRecover = await request(app)
      .post(`/api/admin/users/${targetUid}/recover-mutation-lock`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({ reason: "System crashed during operation" });

    assert.equal(resRecover.status, 200);
    assert.equal(resRecover.body.success, true);
    assert.equal(resRecover.body.data.recoveredOperationId, "stale-op-123");

    // Verify lock deleted
    const checkLockDoc = await lockRef.get();
    assert.equal(checkLockDoc.exists, false, "Stale lock must be deleted after recovery");

    // 6. Non-super admin forbidden -> 403
    const resForbidden = await request(app)
      .post(`/api/admin/users/${targetUid}/recover-mutation-lock`)
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({ reason: "Unauthorized attempt" });

    assert.equal(resForbidden.status, 403);
  });

  it("should test pagination, role filter, active filter, and search queries in user list", async () => {
    // Query page 1
    const resPage1 = await request(app)
      .get("/api/admin/users?pageSize=2")
      .set("Authorization", `Bearer ${superAdminAuth.token}`);

    assert.equal(resPage1.status, 200);
    assert.equal(resPage1.body.success, true);
    assert.ok(resPage1.body.items.length <= 2);

    // Query role filter
    const resRoleFilter = await request(app)
      .get("/api/admin/users?role=super_admin")
      .set("Authorization", `Bearer ${superAdminAuth.token}`);

    assert.equal(resRoleFilter.status, 200);
    assert.ok(resRoleFilter.body.items.every((u: any) => u.role === "super_admin"));

    // Query active filter
    const resActiveFilter = await request(app)
      .get("/api/admin/users?active=true")
      .set("Authorization", `Bearer ${superAdminAuth.token}`);

    assert.equal(resActiveFilter.status, 200);
    assert.ok(resActiveFilter.body.items.every((u: any) => u.active === true));
  });

  it("should handle same-normalised code updates without reserving new locks or deleting existing ones", async () => {
    // 1. Create a user with employee code "emp-700" and rider code "rider-700"
    const resCreate = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Same Normalised User",
        email: "samenorm@gomila.pk",
        phone: "03001237700",
        employeeCode: "emp 700",
        role: "rider",
        active: true,
        riderCode: "rider 700",
        vehicleType: "Bike",
        vehicleNumber: "LHR-700",
        city: "Lahore",
        assignedZone: "Zone 7",
        maximumDailyCapacity: 20
      });

    assert.equal(resCreate.status, 201);
    const targetUid = resCreate.body.data.uid;

    const initialEmpLockId = getCodeLockDocId("emp 700");
    const initialRiderLockId = getCodeLockDocId("rider 700");

    // 2. Perform case-only change: emp 700 -> EMP 700, rider 700 -> RIDER 700
    const resUpdateCase = await request(app)
      .patch(`/api/admin/users/${targetUid}`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        employeeCode: "EMP 700",
        riderCode: "RIDER 700"
      });

    if (resUpdateCase.status !== 200) {
      console.error("DEBUG resUpdateCase:", resUpdateCase.status, JSON.stringify(resUpdateCase.body));
    }
    assert.equal(resUpdateCase.status, 200);
    assert.equal(resUpdateCase.body.data.employeeCode, "EMP 700");
    assert.equal(resUpdateCase.body.data.riderCode, "RIDER 700");

    // Verify lock document IDs and status remain identical
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const empLock = await db.collection("uniqueEmployeeCodes").doc(initialEmpLockId).get();
      assert.ok(empLock.exists);
      assert.equal(empLock.data()?.status, "committed");
      assert.equal(empLock.data()?.targetUid, targetUid);
      assert.equal(empLock.data()?.rawCode, "EMP 700");

      const riderLock = await db.collection("uniqueRiderCodes").doc(initialRiderLockId).get();
      assert.ok(riderLock.exists);
      assert.equal(riderLock.data()?.status, "committed");
      assert.equal(riderLock.data()?.targetUid, targetUid);
      assert.equal(riderLock.data()?.rawCode, "RIDER 700");
    });

    // 3. Perform whitespace-only change: EMP 700 -> EMP  700
    const resUpdateSpace = await request(app)
      .patch(`/api/admin/users/${targetUid}`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        employeeCode: "EMP  700"
      });

    assert.equal(resUpdateSpace.status, 200);
    assert.equal(resUpdateSpace.body.data.employeeCode, "EMP  700");

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const empLock = await db.collection("uniqueEmployeeCodes").doc(initialEmpLockId).get();
      assert.ok(empLock.exists);
      assert.equal(empLock.data()?.status, "committed");
      assert.equal(empLock.data()?.targetUid, targetUid);
      assert.equal(empLock.data()?.rawCode, "EMP  700");
    });
  });

  it("should never steal an active mutation lock during normal operation requests", async () => {
    // 1. Create a user
    const resCreate = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "No Steal Test User",
        email: "nosteal@gomila.pk",
        phone: "03001238800",
        employeeCode: "EMP-NOSTEAL-1",
        role: "cashier",
        active: true
      });

    assert.equal(resCreate.status, 201);
    const targetUid = resCreate.body.data.uid;

    // 2. Manually write an active lock with an EXPIRED lease time to test that normal ops won't steal it
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("userMutationLocks").doc(targetUid).set({
        operationId: "expired-active-op-999",
        operation: "update_user",
        performedByUid: "some-user",
        status: "active",
        createdAt: new Date(Date.now() - 300000), // 5 mins ago
        heartbeatAt: new Date(Date.now() - 300000), // 5 mins ago
        leaseExpiresAt: new Date(Date.now() - 180000) // expired 3 mins ago
      });
    });

    // 3. Normal update request must be rejected with 409 USER_OPERATION_IN_PROGRESS
    const resUpdate = await request(app)
      .patch(`/api/admin/users/${targetUid}`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({ fullName: "Updated Name Attempt" });

    assert.equal(resUpdate.status, 409);
    assert.equal(resUpdate.body.error.code, "USER_OPERATION_IN_PROGRESS");

    // Clean up mock lock
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("userMutationLocks").doc(targetUid).delete();
    });
  });

  it("should reject lock recovery for legacy locks missing lease fields with 409 LEGACY_LOCK_REQUIRES_MANUAL_REVIEW", async () => {
    // 1. Create a user
    const resCreate = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Legacy Lock User",
        email: "legacylock@gomila.pk",
        phone: "03001239900",
        employeeCode: "EMP-LEGACY-1",
        role: "cashier",
        active: true
      });

    assert.equal(resCreate.status, 201);
    const targetUid = resCreate.body.data.uid;

    // 2. Insert active lock missing leaseExpiresAt and heartbeatAt
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("userMutationLocks").doc(targetUid).set({
        operationId: "legacy-op-001",
        operation: "activate_user",
        status: "active"
      });
    });

    // 3. Recover attempt must fail with 409 LEGACY_LOCK_REQUIRES_MANUAL_REVIEW
    const resRecover = await request(app)
      .post(`/api/admin/users/${targetUid}/recover-mutation-lock`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({ reason: "Attempting to recover legacy lock" });

    assert.equal(resRecover.status, 409);
    assert.equal(resRecover.body.error.code, "LEGACY_LOCK_REQUIRES_MANUAL_REVIEW");

    // Clean up lock
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("userMutationLocks").doc(targetUid).delete();
    });
  });

  it("should maintain lock lease during long operations using heartbeat renewals", async () => {
    // Override lease and heartbeat config in env for quick lease expiration
    const origLease = process.env.USER_MUTATION_LOCK_LEASE_MS;
    const origInterval = process.env.USER_MUTATION_HEARTBEAT_INTERVAL_MS;
    process.env.USER_MUTATION_LOCK_LEASE_MS = "300";
    process.env.USER_MUTATION_HEARTBEAT_INTERVAL_MS = "50";

    const appWithDelay = createApp({
      beforeFirestoreCommit: async () => {
        // Delay 900ms - lease is 300ms so heartbeat must renew lock multiple times
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
    });

    try {
      // 1. Create a user
      const resCreate = await request(appWithDelay)
        .post("/api/admin/users")
        .set("Authorization", `Bearer ${superAdminAuth.token}`)
        .send({
          fullName: "Heartbeat User",
          email: "hb_user@gomila.pk",
          phone: "03001235555",
          employeeCode: "EMP-HB-1",
          role: "cashier",
          active: true
        });

      assert.equal(resCreate.status, 201);
      const targetUid = resCreate.body.data.uid;

      // 2. Perform patch with 900ms delay inside hook
      const resUpdate = await request(appWithDelay)
        .patch(`/api/admin/users/${targetUid}`)
        .set("Authorization", `Bearer ${superAdminAuth.token}`)
        .send({
          fullName: "Heartbeat User Updated"
        });

      assert.equal(resUpdate.status, 200);
      assert.equal(resUpdate.body.data.fullName, "Heartbeat User Updated");
    } finally {
      if (origLease !== undefined) process.env.USER_MUTATION_LOCK_LEASE_MS = origLease;
      else delete process.env.USER_MUTATION_LOCK_LEASE_MS;
      if (origInterval !== undefined) process.env.USER_MUTATION_HEARTBEAT_INTERVAL_MS = origInterval;
      else delete process.env.USER_MUTATION_HEARTBEAT_INTERVAL_MS;
    }
  });

  it("should fail with 409 USER_OPERATION_LOCK_LOST when heartbeat renewal fails or lock is lost, rolling back Auth and Firestore", async () => {
    const appWithLockLoss = createApp({
      beforeFirestoreCommit: async ({ targetUid }) => {
        // Delete lock document right before Firestore commit to simulate lock loss
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await db.collection("userMutationLocks").doc(targetUid).delete();
        });
      }
    });

    // 1. Create a user
    const resCreate = await request(appWithLockLoss)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Lock Loss User Initial",
        email: "lockloss@gomila.pk",
        phone: "03001236666",
        employeeCode: "EMP-LOSS-1",
        role: "cashier",
        active: true
      });

    assert.equal(resCreate.status, 201);
    const targetUid = resCreate.body.data.uid;

    // 2. Perform patch which will lose lock right before Firestore commit
    const resUpdate = await request(appWithLockLoss)
      .patch(`/api/admin/users/${targetUid}`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Name Change Attempted",
        email: "lockloss_new@gomila.pk"
      });

    assert.equal(resUpdate.status, 409);
    assert.equal(resUpdate.body.error.code, "USER_OPERATION_LOCK_LOST");

    // Verify Firestore profile fullName and email remain original
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const pDoc = await db.collection("profiles").doc(targetUid).get();
      assert.equal(pDoc.data()?.fullName, "Lock Loss User Initial");
      assert.equal(pDoc.data()?.email, "lockloss@gomila.pk");
    });
  });

  it("should log systemAlerts when Auth restoration fails during lock loss compensation", async () => {
    const appWithCompFailure = createApp({
      beforeFirestoreCommit: async ({ targetUid }) => {
        // Delete lock to trigger lock loss path
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await db.collection("userMutationLocks").doc(targetUid).delete();
        });
      },
      beforeAuthCompensation: async () => {
        // Throw error during Auth rollback compensation
        throw new Error("SIMULATED_AUTH_RESTORE_FAILURE");
      }
    });

    // 1. Create a user
    const resCreate = await request(appWithCompFailure)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Comp Failure User",
        email: "compfail@gomila.pk",
        phone: "03001239999",
        employeeCode: "EMP-COMP-1",
        role: "cashier",
        active: true
      });

    assert.equal(resCreate.status, 201);
    const targetUid = resCreate.body.data.uid;

    // 2. Attempt patch with lock loss and failed Auth compensation
    const resUpdate = await request(appWithCompFailure)
      .patch(`/api/admin/users/${targetUid}`)
      .set("Authorization", `Bearer ${superAdminAuth.token}`)
      .send({
        fullName: "Comp Fail Update Attempt",
        email: "compfail_new@gomila.pk"
      });

    // Should return error response (409 or 500)
    assert.ok(resUpdate.status === 409 || resUpdate.status === 500);

    // Verify systemAlerts recorded the failure
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const snap = await db.collection("systemAlerts").where("targetUid", "==", targetUid).get();
      assert.ok(snap.docs.length >= 1, "System alert must be recorded for Auth compensation failure");
      const alert = snap.docs[0].data();
      assert.equal(alert.failedStage, "AUTH_ROLLBACK");
    });
  });
});
