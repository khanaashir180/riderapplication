import request from "supertest";
import { initializeTestEnvironment, RulesTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import fs from "fs";
import path from "path";
import { createApp } from "../server.js";
import { processOMSImportRows, encodeDocId, buildPackageDocumentId } from "../src/services/csvImporter.js";

const app = createApp();

// Reject execution if emulator environment variables are missing
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  console.error("❌ Emulators not configured. FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST, and FIREBASE_STORAGE_EMULATOR_HOST are required.");
  process.exit(1);
}

const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;

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

async function runSecurityIntegrationTests() {
  console.log("================================================================");
  console.log("RUNNING REAL SECURITY INTEGRATION & EMULATOR TEST SUITE");
  console.log("================================================================");

  let passed = 0;
  let failed = 0;

  function assertTest(condition: boolean, message: string) {
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      failed++;
    }
  }

  // 1. Initialize Emulator Test Environment (Must fail process if infrastructure fails)
  const firestoreRules = fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8");
  const storageRules = fs.readFileSync(path.join(process.cwd(), "storage.rules"), "utf8");

  const firestoreHostPort = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  const storageHostPort = process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(":");

  const testEnv: RulesTestEnvironment = await initializeTestEnvironment({
    projectId: "gen-lang-client-0398272509",
    firestore: {
      rules: firestoreRules,
      host: firestoreHostPort[0] || "127.0.0.1",
      port: parseInt(firestoreHostPort[1] || "8080", 10)
    },
    storage: {
      rules: storageRules,
      host: storageHostPort[0] || "127.0.0.1",
      port: parseInt(storageHostPort[1] || "9199", 10)
    }
  });

  try {
    await testEnv.clearFirestore();

    // --- SECTION 1: DATABASE-ALIGNMENT PROOF ---
    const serverFileContent = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
    const frontendFileContent = fs.readFileSync(path.join(process.cwd(), "src/lib/firebase.ts"), "utf8");
    const configContent = fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8");
    const firebaseJsonContent = fs.readFileSync(path.join(process.cwd(), "firebase.json"), "utf8");

    const noNamedDbInServer = !serverFileContent.includes("getFirestore(firebaseConfig.firestoreDatabaseId)");
    const noNamedDbInFrontend = !frontendFileContent.includes("firebaseConfig.firestoreDatabaseId");
    const noActiveNamedConfig = !configContent.includes("firestoreDatabaseId");
    const firebaseJsonDefaultDb = firebaseJsonContent.includes('"database": "(default)"');

    assertTest(noNamedDbInServer, "Database Alignment: Server uses default Firestore database without named database ID");
    assertTest(noNamedDbInFrontend, "Database Alignment: Frontend uses default Firestore database without named database ID");
    assertTest(noActiveNamedConfig, "Database Alignment: Repository search finds no active firestoreDatabaseId in firebase-applet-config.json");
    assertTest(firebaseJsonDefaultDb, "Database Alignment: firebase.json explicitly configures database as '(default)'");

    // --- SECTION 2: DYNAMIC ROUTE-SECURITY SCANNER ---
    const routes: { method: string; path: string; handle: any; stack: any[] }[] = [];
    app._router.stack.forEach((middleware: any) => {
      if (middleware.route) {
        const pathStr = middleware.route.path;
        const methodsObj = middleware.route.methods;
        Object.keys(methodsObj).forEach((method) => {
          if (methodsObj[method]) {
            routes.push({
              method: method.toUpperCase(),
              path: pathStr,
              handle: middleware.route.stack[middleware.route.stack.length - 1].handle,
              stack: middleware.route.stack
            });
          }
        });
      }
    });

    const routeKeys = routes.map(r => `${r.method} ${r.path}`);
    const uniqueRouteKeys = new Set(routeKeys);
    assertTest(routeKeys.length === uniqueRouteKeys.size, "Route Scanner: No duplicate route path and HTTP method exists");

    const unauthRoutes = routes.filter(r => r.path === "/api/health");
    assertTest(unauthRoutes.length === 1 && unauthRoutes[0].method === "GET", "Route Scanner: /api/health is the only expected unauthenticated route");

    let allOtherApiProtected = true;
    for (const r of routes) {
      if (r.path.startsWith("/api/") && r.path !== "/api/health") {
        const res = await request(app)[r.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete"](r.path);
        if (res.status !== 401) {
          allOtherApiProtected = false;
          console.error(`❌ Unprotected route without token: ${r.method} ${r.path} returned ${res.status}`);
        }
      }
    }
    assertTest(allOtherApiProtected, "Route Scanner: Every /api/* route except /api/health returns 401 without token");

    let allApiHaveAuthMetadata = true;
    for (const r of routes) {
      if (r.path.startsWith("/api/") && r.path !== "/api/health") {
        const hasAuthMeta = r.stack.some((layer: any) => layer.handle?.securityMetadata?.type === "auth");
        if (!hasAuthMeta) {
          allApiHaveAuthMetadata = false;
          console.error(`❌ Route missing authentication metadata: ${r.method} ${r.path}`);
        }
      }
    }
    assertTest(allApiHaveAuthMetadata, "Route Scanner: Every /api/* route except /api/health has authentication middleware metadata");

    let allWriteRoutesRoleProtected = true;
    for (const r of routes) {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(r.method)) {
        const hasRoleMeta = r.stack.some((layer: any) => {
          const meta = layer.handle?.securityMetadata;
          return meta?.type === "role" || meta?.type === "exactRole";
        });
        if (!hasRoleMeta) {
          allWriteRoutesRoleProtected = false;
          console.error(`❌ Write route missing role metadata: ${r.method} ${r.path}`);
        }
      }
    }
    assertTest(allWriteRoutesRoleProtected, "Route Scanner: Every write route (POST/PUT/PATCH/DELETE) has role or exact-role metadata");

    // Rider-only routes must use requireExactRole("rider") (type=='exactRole', roles==['rider'], superAdminBypass==false)
    const riderOnlyEndpoints = [
      { method: "POST", path: "/api/delivery/attempt" },
      { method: "GET", path: "/api/delivery/history/me" },
      { method: "POST", path: "/api/finance/settlements/submit" },
      { method: "GET", path: "/api/finance/settlements/me" },
      { method: "POST", path: "/api/returns/rider-handback" }
    ];

    let noRiderOnlyBypass = true;
    for (const ep of riderOnlyEndpoints) {
      const matched = routes.find(r => r.method === ep.method && r.path === ep.path);
      if (!matched) {
        noRiderOnlyBypass = false;
        console.error(`❌ Rider-only endpoint not found: ${ep.method} ${ep.path}`);
      } else {
        const exactRoleLayer = matched.stack.find((layer: any) => layer.handle?.securityMetadata?.type === "exactRole");
        const meta = exactRoleLayer?.handle?.securityMetadata;
        const isRiderExact = meta && meta.type === "exactRole" && Array.isArray(meta.roles) && meta.roles.length === 1 && meta.roles[0] === "rider" && meta.superAdminBypass === false;
        if (!isRiderExact) {
          noRiderOnlyBypass = false;
          console.error(`❌ Rider-only route metadata invalid: ${ep.method} ${ep.path}`, meta);
        }
      }
    }
    assertTest(noRiderOnlyBypass, "Route Scanner: Rider-only routes have type=='exactRole', roles==['rider'], superAdminBypass==false");

    // Cashier-personal routes inspection
    const cashierPersonalEndpoints = [
      { method: "POST", path: "/api/finance/settlements/receive" },
      { method: "POST", path: "/api/finance/bank-deposits/create" }
    ];
    let cashierPersonalValid = true;
    for (const ep of cashierPersonalEndpoints) {
      const matched = routes.find(r => r.method === ep.method && r.path === ep.path);
      if (!matched) {
        cashierPersonalValid = false;
        console.error(`❌ Cashier-personal endpoint not found: ${ep.method} ${ep.path}`);
      } else {
        const exactRoleLayer = matched.stack.find((layer: any) => layer.handle?.securityMetadata?.type === "exactRole");
        const meta = exactRoleLayer?.handle?.securityMetadata;
        const isCashierExact = meta && meta.type === "exactRole" && Array.isArray(meta.roles) && meta.roles.includes("cashier") && meta.superAdminBypass === false;
        if (!isCashierExact) {
          cashierPersonalValid = false;
          console.error(`❌ Cashier-personal route metadata invalid: ${ep.method} ${ep.path}`, meta);
        }
      }
    }
    assertTest(cashierPersonalValid, "Route Scanner: Cashier-personal routes use exact Cashier role metadata");

    // --- SECTION 3: PROVISION EMULATOR USERS & SEED DATA ---
    const superAdminAuth = await getOrAuthToken("super_admin@gomila.com", "Password123!");
    const dispatchAuth = await getOrAuthToken("dispatch_manager@gomila.com", "Password123!");
    const riderAAuth = await getOrAuthToken("rider_a@gomila.com", "Password123!");
    const riderBAuth = await getOrAuthToken("rider_b@gomila.com", "Password123!");
    const cashierAuth = await getOrAuthToken("cashier@gomila.com", "Password123!");
    const csAuth = await getOrAuthToken("cs@gomila.com", "Password123!");
    const whAuth = await getOrAuthToken("wh@gomila.com", "Password123!");
    const viewerAuth = await getOrAuthToken("viewer@gomila.com", "Password123!");
    const inactiveAuth = await getOrAuthToken("inactive@gomila.com", "Password123!");
    const noProfileAuth = await getOrAuthToken("noprofile@gomila.com", "Password123!");

    // Reciprocal Link Test Accounts
    const riderMissingProfileIdAuth = await getOrAuthToken("rider_missing_pid@gomila.com", "Password123!");
    const riderMismatchedAuth = await getOrAuthToken("rider_mismatched@gomila.com", "Password123!");
    const riderInactiveAuth = await getOrAuthToken("rider_inactive@gomila.com", "Password123!");
    const profileMissingRiderIdAuth = await getOrAuthToken("profile_missing_rid@gomila.com", "Password123!");

    // Generate real OMS package and item via actual parser output
    const sampleCsvRow = {
      'Order number': 'PKG-A',
      'Parent order number': 'ORD-A',
      'Shipping Name': 'Customer A',
      'Shipping Phone': '03001234567',
      'Shipping Address1': '123 Main St',
      'Shipping City': 'Lahore',
      'Lineitem Title': 'Gomila Leather Shoes',
      'Lineitem quantity': '1',
      'Lineitem price': '5000',
      'Status': 'dispatched'
    };
    const parserResult = processOMSImportRows([sampleCsvRow], "batch_test_101");
    const rawGeneratedItem = parserResult.packages[0].items[0];
    const generatedItem = JSON.parse(JSON.stringify(rawGeneratedItem));
    const generatedPkg = parserResult.packages[0];

    assertTest(typeof generatedItem.packageId === "string" && generatedItem.packageId.length > 0, "Parser Output: Generated item contains packageId");
    assertTest(generatedItem.packageNumber === "PKG-A", "Parser Output: Generated item contains packageNumber");
    assertTest(!("riderId" in generatedItem), "Parser Output: Generated item does not contain riderId");

    const pkgDocIdA = generatedItem.packageId;
    const pkgDocIdB = encodeDocId("PKG-B");

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();

      // Profiles
      await db.collection("profiles").doc(superAdminAuth.uid).set({
        id: superAdminAuth.uid, authUserId: superAdminAuth.uid, email: "super_admin@gomila.com", fullName: "Super Admin", role: "super_admin", active: true
      });
      await db.collection("profiles").doc(dispatchAuth.uid).set({
        id: dispatchAuth.uid, authUserId: dispatchAuth.uid, email: "dispatch_manager@gomila.com", fullName: "Dispatch Manager", role: "dispatch_manager", active: true
      });
      await db.collection("profiles").doc(riderAAuth.uid).set({
        id: riderAAuth.uid, authUserId: riderAAuth.uid, email: "rider_a@gomila.com", fullName: "Rider A", role: "rider", riderId: "rider_a_doc", active: true
      });
      await db.collection("profiles").doc(riderBAuth.uid).set({
        id: riderBAuth.uid, authUserId: riderBAuth.uid, email: "rider_b@gomila.com", fullName: "Rider B", role: "rider", riderId: "rider_b_doc", active: true
      });
      await db.collection("profiles").doc(cashierAuth.uid).set({
        id: cashierAuth.uid, authUserId: cashierAuth.uid, email: "cashier@gomila.com", fullName: "Cashier User", role: "cashier", active: true
      });
      await db.collection("profiles").doc(csAuth.uid).set({
        id: csAuth.uid, authUserId: csAuth.uid, email: "cs@gomila.com", fullName: "Customer Service", role: "customer_service", active: true
      });
      await db.collection("profiles").doc(whAuth.uid).set({
        id: whAuth.uid, authUserId: whAuth.uid, email: "wh@gomila.com", fullName: "Warehouse Staff", role: "warehouse_staff", active: true
      });
      await db.collection("profiles").doc(viewerAuth.uid).set({
        id: viewerAuth.uid, authUserId: viewerAuth.uid, email: "viewer@gomila.com", fullName: "Management Viewer", role: "management_viewer", active: true
      });
      await db.collection("profiles").doc(inactiveAuth.uid).set({
        id: inactiveAuth.uid, authUserId: inactiveAuth.uid, email: "inactive@gomila.com", fullName: "Inactive User", role: "dispatch_manager", active: false
      });

      // Reciprocal link profile setup
      await db.collection("profiles").doc(riderMissingProfileIdAuth.uid).set({
        id: riderMissingProfileIdAuth.uid, authUserId: riderMissingProfileIdAuth.uid, email: "rider_missing_pid@gomila.com", fullName: "Rider Missing PID", role: "rider", riderId: "rider_missing_pid_doc", active: true
      });
      await db.collection("profiles").doc(riderMismatchedAuth.uid).set({
        id: riderMismatchedAuth.uid, authUserId: riderMismatchedAuth.uid, email: "rider_mismatched@gomila.com", fullName: "Rider Mismatched", role: "rider", riderId: "rider_mismatched_doc", active: true
      });
      await db.collection("profiles").doc(riderInactiveAuth.uid).set({
        id: riderInactiveAuth.uid, authUserId: riderInactiveAuth.uid, email: "rider_inactive@gomila.com", fullName: "Rider Inactive", role: "rider", riderId: "rider_inactive_doc", active: true
      });
      await db.collection("profiles").doc(profileMissingRiderIdAuth.uid).set({
        id: profileMissingRiderIdAuth.uid, authUserId: profileMissingRiderIdAuth.uid, email: "profile_missing_rid@gomila.com", fullName: "Profile Missing RID", role: "rider", active: true
      });

      // Riders
      await db.collection("riders").doc("rider_a_doc").set({
        id: "rider_a_doc", profileId: riderAAuth.uid, fullName: "Rider A", phone: "03001111111", active: true
      });
      await db.collection("riders").doc("rider_b_doc").set({
        id: "rider_b_doc", profileId: riderBAuth.uid, fullName: "Rider B", phone: "03002222222", active: true
      });
      await db.collection("riders").doc("rider_missing_pid_doc").set({
        id: "rider_missing_pid_doc", fullName: "Rider Missing PID", phone: "03003333333", active: true
      });
      await db.collection("riders").doc("rider_mismatched_doc").set({
        id: "rider_mismatched_doc", profileId: "different_uid_12345", fullName: "Rider Mismatched", phone: "03004444444", active: true
      });
      await db.collection("riders").doc("rider_inactive_doc").set({
        id: "rider_inactive_doc", profileId: riderInactiveAuth.uid, fullName: "Rider Inactive", phone: "03005555555", active: false
      });

      // Packages & Assignments
      await db.collection("packages").doc(pkgDocIdA).set({
        id: pkgDocIdA, packageId: pkgDocIdA, packageNumber: "PKG-A", parentOrderNumber: "ORD-A", assignedRiderId: "rider_a_doc", current_status: "Dispatched", operationalStatus: "dispatched", importState: "committed"
      });
      await db.collection("packages").doc(pkgDocIdB).set({
        id: pkgDocIdB, packageId: pkgDocIdB, packageNumber: "PKG-B", parentOrderNumber: "ORD-B", assignedRiderId: "rider_b_doc", current_status: "Dispatched", operationalStatus: "dispatched", importState: "committed"
      });
      await db.collection("assignments").doc("asgn_a").set({
        id: "asgn_a", packageId: pkgDocIdA, riderId: "rider_a_doc", active: true
      });
      await db.collection("assignments").doc("asgn_b").set({
        id: "asgn_b", packageId: pkgDocIdB, riderId: "rider_b_doc", active: true
      });

      // Package Items (using REAL parser output for item_a)
      await db.collection("packageItems").doc("item_a").set({
        ...generatedItem,
        itemId: "item_a",
        packageId: pkgDocIdA
      });
      await db.collection("packageItems").doc("item_b").set({
        itemId: "item_b", packageId: pkgDocIdB, packageNumber: "PKG-B", itemTitle: "Real OMS Item B", quantity: 1, unitPrice: 100
      });
      await db.collection("packageItems").doc("item_missing_pkgId").set({
        itemId: "item_missing_pkgId", packageNumber: "PKG-NONE", itemTitle: "Missing PackageId Item", quantity: 1, unitPrice: 100
      });
      await db.collection("packageItems").doc("item_nonexistent_pkg").set({
        itemId: "item_nonexistent_pkg", packageId: "non_existent_pkg_999", packageNumber: "PKG-NONE", itemTitle: "Orphan Item", quantity: 1, unitPrice: 100
      });

      // Delivery Attempts
      await db.collection("deliveryAttempts").doc("attempt_a").set({
        id: "attempt_a", packageId: "pkg_a", riderId: "rider_a_doc", status: "delivered"
      });
      await db.collection("deliveryAttempts").doc("attempt_b").set({
        id: "attempt_b", packageId: "pkg_b", riderId: "rider_b_doc", status: "delivered"
      });

      // Customers & Addresses
      await db.collection("customers").doc("cust_1").set({ id: "cust_1", name: "Customer 1" });
      await db.collection("deliveryAddresses").doc("addr_1").set({ id: "addr_1", address: "123 Main St" });

      // Financial accounts, transactions, postings
      await db.collection("financialAccounts").doc("RIDER_CASH_WALLET").set({ id: "RIDER_CASH_WALLET", code: "RIDER_CASH_WALLET", name: "Rider Cash Wallet" });
      await db.collection("financialTransactions").doc("tx_1").set({ id: "tx_1", amount: 100 });
      await db.collection("financialPostings").doc("post_1").set({ id: "post_1", amount: 100 });
      await db.collection("auditEvents").doc("audit_1").set({ id: "audit_1", action: "test" });
    });

    // --- SECTION 4: RECIPROCAL RIDER-LINK TESTS ---
    const resProfileMissingRiderId = await request(app).get("/api/delivery/history/me").set("Authorization", `Bearer ${profileMissingRiderIdAuth.token}`);
    assertTest(resProfileMissingRiderId.status === 403 && resProfileMissingRiderId.body?.error?.code === "RIDER_PROFILE_NOT_LINKED",
      "Rider Link: Profile missing rider ID returns 403 RIDER_PROFILE_NOT_LINKED");

    const resRiderMissingProfileId = await request(app).get("/api/delivery/history/me").set("Authorization", `Bearer ${riderMissingProfileIdAuth.token}`);
    assertTest(resRiderMissingProfileId.status === 403 && resRiderMissingProfileId.body?.error?.code === "RIDER_PROFILE_NOT_LINKED",
      "Rider Link: Rider document missing profileId returns 403 RIDER_PROFILE_NOT_LINKED");

    const resRiderMismatched = await request(app).get("/api/delivery/history/me").set("Authorization", `Bearer ${riderMismatchedAuth.token}`);
    assertTest(resRiderMismatched.status === 403 && resRiderMismatched.body?.error?.code === "RIDER_PROFILE_NOT_LINKED",
      "Rider Link: Rider document profileId belongs to another UID returns 403 RIDER_PROFILE_NOT_LINKED");

    const resRiderInactive = await request(app).get("/api/delivery/history/me").set("Authorization", `Bearer ${riderInactiveAuth.token}`);
    assertTest(resRiderInactive.status === 403 && resRiderInactive.body?.error?.code === "RIDER_INACTIVE",
      "Rider Link: Rider active false returns 403 RIDER_INACTIVE");

    // --- SECTION 5: EXACT ROLE TESTS (Super Admin / Manager / Cashier Rejected on Rider-Only Routes) ---
    const saDeliveryAttempt = await request(app).post("/api/delivery/attempt").set("Authorization", `Bearer ${superAdminAuth.token}`).send({ packageId: "pkg_a", status: "delivered", collectedAmount: 100, receiverName: "Test", receiverRelationship: "Self" });
    assertTest(saDeliveryAttempt.status === 403, "Exact Roles: Super Admin cannot complete a rider delivery");

    const saSettlementSubmit = await request(app).post("/api/finance/settlements/submit").set("Authorization", `Bearer ${superAdminAuth.token}`).send({ declaredCashAmount: 100 });
    assertTest(saSettlementSubmit.status === 403, "Exact Roles: Super Admin cannot submit a rider declaration");

    const saRiderHandback = await request(app).post("/api/returns/rider-handback").set("Authorization", `Bearer ${superAdminAuth.token}`).send({ packageId: "pkg_a", scannedPackageNumber: "PKG-A" });
    assertTest(saRiderHandback.status === 403, "Exact Roles: Super Admin cannot perform rider return handback");

    const dmRiderRoute = await request(app).get("/api/delivery/history/me").set("Authorization", `Bearer ${dispatchAuth.token}`);
    assertTest(dmRiderRoute.status === 403, "Exact Roles: Dispatch Manager cannot use rider-only routes");

    const cashierRiderRoute = await request(app).post("/api/delivery/attempt").set("Authorization", `Bearer ${cashierAuth.token}`).send({ packageId: "pkg_a", status: "delivered", collectedAmount: 100, receiverName: "Test", receiverRelationship: "Self" });
    assertTest(cashierRiderRoute.status === 403, "Exact Roles: Cashier cannot use rider-only routes");

    // --- SECTION 6: AUTHENTICATED EXPRESS TESTS ---
    const validTokenRes = await request(app).get("/api/orders").set("Authorization", `Bearer ${dispatchAuth.token}`);
    assertTest(validTokenRes.status === 200, "Express Auth: Valid Firebase ID token succeeds on allowed endpoint");

    const invalidTokenRes = await request(app).get("/api/orders").set("Authorization", "Bearer invalid_token_123");
    assertTest(invalidTokenRes.status === 401, "Express Auth: Invalid token returns 401");

    const noProfileRes = await request(app).get("/api/orders").set("Authorization", `Bearer ${noProfileAuth.token}`);
    assertTest(noProfileRes.status === 403, "Express Auth: Token with missing profile returns 403");

    const inactiveRes = await request(app).get("/api/orders").set("Authorization", `Bearer ${inactiveAuth.token}`);
    assertTest(inactiveRes.status === 403, "Express Auth: Token with inactive profile returns 403");

    // Request-body riderId cannot change ownership
    const bodyRiderIdSpoof = await request(app)
      .post("/api/delivery/attempt")
      .set("Authorization", `Bearer ${riderAAuth.token}`)
      .send({ packageId: pkgDocIdB, riderId: "rider_b_doc", status: "delivered", collectedAmount: 100, receiverName: "Test", receiverRelationship: "Self" });
    assertTest(bodyRiderIdSpoof.status === 403, "Express Auth: Request-body riderId cannot change ownership");

    // Request-body role cannot elevate access
    const bodyRoleSpoof = await request(app)
      .post("/api/dispatch/assign")
      .set("Authorization", `Bearer ${riderAAuth.token}`)
      .send({ role: "super_admin", packageId: pkgDocIdA, riderId: "rider_a_doc" });
    assertTest(bodyRoleSpoof.status === 403, "Express Auth: Request-body role cannot elevate access");

    // Cashier cannot update a dispatch run
    const cashierDispatchRun = await request(app)
      .post("/api/dispatch/runs")
      .set("Authorization", `Bearer ${cashierAuth.token}`)
      .send({ riderId: "rider_a_doc", zone: "Zone A" });
    assertTest(cashierDispatchRun.status === 403, "Express Auth: Cashier cannot create/update a dispatch run");

    // Customer Service cannot call disabled finance transaction route
    const csFinanceTx = await request(app)
      .post("/api/finance/transactions")
      .set("Authorization", `Bearer ${csAuth.token}`);
    assertTest(csFinanceTx.status === 403, "Express Auth: Customer Service cannot call finance transaction route");

    // Warehouse Staff cannot alter expected COD
    const whCodAlter = await request(app)
      .post("/api/finance/settlements/receive")
      .set("Authorization", `Bearer ${whAuth.token}`)
      .send({ settlementId: "stl_1", physicallyReceivedAmount: 100 });
    assertTest(whCodAlter.status === 403, "Express Auth: Warehouse staff cannot alter expected COD or receive settlements");

    // Management Viewer cannot call write routes
    const viewerWrite = await request(app)
      .post("/api/dispatch/assign")
      .set("Authorization", `Bearer ${viewerAuth.token}`)
      .send({ packageId: "pkg_a", riderId: "rider_a_doc" });
    assertTest(viewerWrite.status === 403, "Express Auth: Management Viewer cannot call registered write routes");

    // Rider cannot access /api/riders
    const riderAccessRiders = await request(app).get("/api/riders").set("Authorization", `Bearer ${riderAAuth.token}`);
    assertTest(riderAccessRiders.status === 403, "Express Auth: Rider cannot access /api/riders");

    // Rider can access /api/riders/me
    const riderAccessMe = await request(app).get("/api/riders/me").set("Authorization", `Bearer ${riderAAuth.token}`);
    assertTest(riderAccessMe.status === 200, "Express Auth: Rider can access /api/riders/me");

    // Cashier receives limited rider view on /api/riders
    const cashierRiders = await request(app).get("/api/riders").set("Authorization", `Bearer ${cashierAuth.token}`);
    assertTest(cashierRiders.status === 200 && Array.isArray(cashierRiders.body.data), "Express Auth: Cashier receives limited rider settlement view on /api/riders");

    // General orders endpoints reject Rider and Cashier
    const riderOrders = await request(app).get("/api/orders").set("Authorization", `Bearer ${riderAAuth.token}`);
    const cashierOrders = await request(app).get("/api/orders").set("Authorization", `Bearer ${cashierAuth.token}`);
    assertTest(riderOrders.status === 403 && cashierOrders.status === 403, "Express Auth: General orders endpoints reject Rider and Cashier");

    // --- SECTION 7: FIRESTORE SECURITY RULES TESTS ---
    const riderAContext = testEnv.authenticatedContext(riderAAuth.uid, { role: "rider" });
    const riderBContext = testEnv.authenticatedContext(riderBAuth.uid, { role: "rider" });
    const cashierContext = testEnv.authenticatedContext(cashierAuth.uid, { role: "cashier" });
    const csContext = testEnv.authenticatedContext(csAuth.uid, { role: "customer_service" });
    const whContext = testEnv.authenticatedContext(whAuth.uid, { role: "warehouse_staff" });
    const dispatchContext = testEnv.authenticatedContext(dispatchAuth.uid, { role: "dispatch_manager" });
    const viewerContext = testEnv.authenticatedContext(viewerAuth.uid, { role: "management_viewer" });

    const dbRiderA = riderAContext.firestore();
    const dbRiderB = riderBContext.firestore();
    const dbCashier = cashierContext.firestore();
    const dbCS = csContext.firestore();
    const dbWH = whContext.firestore();
    const dbDispatch = dispatchContext.firestore();
    const dbViewer = viewerContext.firestore();

    // Rider A package read & cross-read
    await assertSucceeds(dbRiderA.collection("packages").doc(pkgDocIdA).get());
    assertTest(true, "Firestore Rules: Rider A reads their package");

    await assertFails(dbRiderA.collection("packages").doc(pkgDocIdB).get());
    assertTest(true, "Firestore Rules: Rider A cannot read Rider B's package");

    // Package item ownership via parent packageId
    await assertSucceeds(dbRiderA.collection("packageItems").doc("item_a").get());
    assertTest(true, "Firestore Rules: Rider A reads package item through its parent packageId");

    await assertFails(dbRiderA.collection("packageItems").doc("item_b").get());
    assertTest(true, "Firestore Rules: Rider A cannot read Rider B's package item");

    await assertFails(dbRiderA.collection("packageItems").doc("item_missing_pkgId").get());
    assertTest(true, "Firestore Rules: Rider A cannot read package item with missing packageId");

    await assertFails(dbRiderA.collection("packageItems").doc("item_nonexistent_pkg").get());
    assertTest(true, "Firestore Rules: Rider A cannot read package item with nonexistent parent package");

    // Assignments
    await assertSucceeds(dbRiderA.collection("assignments").doc("asgn_a").get());
    assertTest(true, "Firestore Rules: Rider A reads their assignment");

    await assertFails(dbRiderA.collection("assignments").doc("asgn_b").get());
    assertTest(true, "Firestore Rules: Rider A cannot read Rider B's assignment");

    // Delivery attempts
    await assertSucceeds(dbRiderA.collection("deliveryAttempts").doc("attempt_a").get());
    assertTest(true, "Firestore Rules: Rider A reads their delivery attempt");

    await assertFails(dbRiderA.collection("deliveryAttempts").doc("attempt_b").get());
    assertTest(true, "Firestore Rules: Rider A cannot read Rider B's delivery attempt");

    // Cashier reading customers/addresses denied
    await assertFails(dbCashier.collection("customers").doc("cust_1").get());
    assertTest(true, "Firestore Rules: Cashier cannot read customers");

    await assertFails(dbCashier.collection("deliveryAddresses").doc("addr_1").get());
    assertTest(true, "Firestore Rules: Cashier cannot read delivery addresses");

    // Customer Service reading financial accounts & postings denied
    await assertFails(dbCS.collection("financialAccounts").doc("RIDER_CASH_WALLET").get());
    assertTest(true, "Firestore Rules: Customer Service cannot read financial accounts");

    await assertFails(dbCS.collection("financialPostings").doc("post_1").get());
    assertTest(true, "Firestore Rules: Customer Service cannot read financial postings");

    // Warehouse staff reading financial transactions denied
    await assertFails(dbWH.collection("financialTransactions").doc("tx_1").get());
    assertTest(true, "Firestore Rules: Warehouse staff cannot read financial transactions");

    // Management Viewer cannot write
    await assertFails(dbViewer.collection("packages").doc("pkg_a").set({ status: "Delivered" }));
    assertTest(true, "Firestore Rules: Management Viewer cannot write");

    // Direct Client Writes Denied
    await assertFails(dbRiderA.collection("packages").doc("pkg_a").set({ current_status: "Delivered" }));
    assertTest(true, "Firestore Rules: Direct package write denied");

    await assertFails(dbRiderA.collection("packageItems").doc("item_a").set({ title: "Hack" }));
    assertTest(true, "Firestore Rules: Direct package-item write denied");

    await assertFails(dbDispatch.collection("assignments").doc("asgn_a").set({ active: false }));
    assertTest(true, "Firestore Rules: Direct assignment write denied");

    await assertFails(dbCashier.collection("financialAccounts").doc("RIDER_CASH_WALLET").set({ balance: 999999 }));
    assertTest(true, "Firestore Rules: Direct financial write denied");

    await assertFails(dbViewer.collection("auditEvents").doc("audit_1").set({ action: "hack" }));
    assertTest(true, "Firestore Rules: Direct audit write denied");

    await assertFails(dbDispatch.collection("unknownCollection").doc("doc1").get());
    assertTest(true, "Firestore Rules: Unknown collection read denied");

    await assertFails(dbDispatch.collection("unknownCollection").doc("doc1").set({ val: 1 }));
    assertTest(true, "Firestore Rules: Unknown collection write denied");

    // --- SECTION 8: STORAGE SECURITY RULES TESTS ---
    await testEnv.clearStorage();

    const storageRiderA = riderAContext.storage();
    const storageRiderB = testEnv.authenticatedContext(riderBAuth.uid, { role: "rider" }).storage();
    const storageCashier = cashierContext.storage();
    const storageCS = csContext.storage();
    const storageWH = whContext.storage();
    const storageDispatch = dispatchContext.storage();
    const storageSuperAdmin = testEnv.authenticatedContext(superAdminAuth.uid, { role: "super_admin" }).storage();
    const storageUnauth = testEnv.unauthenticatedContext().storage();

    const dummyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dummyWebp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

    // Valid uploads
    await assertSucceeds(Promise.resolve(storageRiderA.ref(`deliveryProofs/${riderAAuth.uid}/att1/proof.jpg`).put(dummyJpeg, { contentType: "image/jpeg" })));
    assertTest(true, "Storage Rules: Valid Rider A JPEG creation succeeds");

    await assertSucceeds(Promise.resolve(storageRiderA.ref(`deliveryProofs/${riderAAuth.uid}/att2/proof.png`).put(dummyPng, { contentType: "image/png" })));
    assertTest(true, "Storage Rules: Valid Rider A PNG creation succeeds");

    await assertSucceeds(Promise.resolve(storageRiderA.ref(`deliveryProofs/${riderAAuth.uid}/att3/proof.webp`).put(dummyWebp, { contentType: "image/webp" })));
    assertTest(true, "Storage Rules: Valid Rider A WebP creation succeeds");

    // Unauthenticated creation denied
    await assertFails(Promise.resolve(storageUnauth.ref(`deliveryProofs/${riderAAuth.uid}/att4/proof.jpg`).put(dummyJpeg, { contentType: "image/jpeg" })));
    assertTest(true, "Storage Rules: Unauthenticated creation denied");

    // Non-rider roles creation denied on deliveryProofs
    await assertFails(Promise.resolve(storageCashier.ref(`deliveryProofs/${riderAAuth.uid}/att5/proof.jpg`).put(dummyJpeg, { contentType: "image/jpeg" })));
    assertTest(true, "Storage Rules: Cashier creation denied on delivery proof");

    await assertFails(Promise.resolve(storageCS.ref(`deliveryProofs/${riderAAuth.uid}/att6/proof.jpg`).put(dummyJpeg, { contentType: "image/jpeg" })));
    assertTest(true, "Storage Rules: Customer Service creation denied on delivery proof");

    await assertFails(Promise.resolve(storageWH.ref(`deliveryProofs/${riderAAuth.uid}/att7/proof.jpg`).put(dummyJpeg, { contentType: "image/jpeg" })));
    assertTest(true, "Storage Rules: Warehouse Staff creation denied on delivery proof");

    // Rider A under Rider B path denied
    await assertFails(Promise.resolve(storageRiderA.ref(`deliveryProofs/${riderBAuth.uid}/att8/proof.jpg`).put(dummyJpeg, { contentType: "image/jpeg" })));
    assertTest(true, "Storage Rules: Rider A creation under Rider B UID denied");

    // Invalid MIME type denied
    await assertFails(Promise.resolve(storageRiderA.ref(`deliveryProofs/${riderAAuth.uid}/att9/proof.txt`).put(Buffer.from("text"), { contentType: "text/plain" })));
    assertTest(true, "Storage Rules: Invalid MIME denied");

    // File larger than 10MB denied
    const largeFile = Buffer.alloc(11 * 1024 * 1024);
    await assertFails(Promise.resolve(storageRiderA.ref(`deliveryProofs/${riderAAuth.uid}/att10/large.jpg`).put(largeFile, { contentType: "image/jpeg" })));
    assertTest(true, "Storage Rules: File larger than 10 MB denied");

    // Immutability: existing proof update/replacement/deletion denied
    await assertFails(Promise.resolve(storageRiderA.ref(`deliveryProofs/${riderAAuth.uid}/att1/proof.jpg`).put(dummyPng, { contentType: "image/png" })));
    assertTest(true, "Storage Rules: Existing proof update denied");

    await assertFails(Promise.resolve(storageRiderA.ref(`deliveryProofs/${riderAAuth.uid}/att1/proof.jpg`).delete()));
    assertTest(true, "Storage Rules: Existing proof deletion denied");

    // Storage Read Permissions
    await assertSucceeds(storageRiderA.ref(`deliveryProofs/${riderAAuth.uid}/att1/proof.jpg`).getDownloadURL());
    assertTest(true, "Storage Rules: Rider A reads their proof");

    await assertFails(storageRiderB.ref(`deliveryProofs/${riderAAuth.uid}/att1/proof.jpg`).getDownloadURL());
    assertTest(true, "Storage Rules: Rider A cannot read Rider B's proof");

    await assertFails(storageCS.ref(`deliveryProofs/${riderAAuth.uid}/att1/proof.jpg`).getDownloadURL());
    assertTest(true, "Storage Rules: Customer Service cannot read proof");

    await assertFails(storageWH.ref(`deliveryProofs/${riderAAuth.uid}/att1/proof.jpg`).getDownloadURL());
    assertTest(true, "Storage Rules: Warehouse Staff cannot read proof");

    await assertSucceeds(storageDispatch.ref(`deliveryProofs/${riderAAuth.uid}/att1/proof.jpg`).getDownloadURL());
    assertTest(true, "Storage Rules: Dispatch Manager can read proof");

    await assertSucceeds(storageSuperAdmin.ref(`deliveryProofs/${riderAAuth.uid}/att1/proof.jpg`).getDownloadURL());
    assertTest(true, "Storage Rules: Super Admin can read proof");

    // --- SECTION 9: PRODUCTION-SCHEMA & ACTUAL IMPORT COMMIT INTEGRATION PROOF ---
    // 1. Authenticate as Dispatch Manager and validate a real CSV row via Express route
    const valRes = await request(app)
      .post("/api/import/validate")
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({
        fileName: "test_real_import.csv",
        fileChecksum: "checksum_real_123",
        rows: [
          {
            'Order number': 'PKG-REAL-1',
            'Parent order number': 'ORD-REAL-1',
            'Shipping Name': 'Customer Real',
            'Shipping Phone': '03001234567',
            'Shipping Address1': '456 Real St',
            'Shipping City': 'Lahore',
            'Lineitem Title': 'Gomila Real Shoes',
            'Lineitem quantity': '1',
            'Lineitem price': '6000',
            'Status': 'dispatched'
          }
        ]
      });

    if (valRes.status !== 200 || !valRes.body.success) {
      console.error("DEBUG valRes:", valRes.status, JSON.stringify(valRes.body));
    }

    assertTest(valRes.status === 200 && valRes.body.success === true, "Import Route: POST /api/import/validate succeeded");
    const realBatchId = valRes.body.data.batchId;
    assertTest(typeof realBatchId === "string" && realBatchId.length > 0, "Import Route: Returned valid batchId");

    // 2. Inspect staged packages and staged items in Firestore
    let stagedPkg: any;
    let stagedItem: any;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const pkgDoc = await db.collection("importBatches").doc(realBatchId).collection("stagedPackages").doc("pkg_PKG-REAL-1").get();
      const itemSnap = await db.collection("importBatches").doc(realBatchId).collection("stagedItems").get();
      stagedPkg = pkgDoc.data();
      stagedItem = itemSnap.docs[0]?.data();
    });

    assertTest(stagedPkg && stagedPkg.packageId === "pkg_PKG-REAL-1", "Import Staging: Staged package document ID === packageId (pkg_PKG-REAL-1)");
    assertTest(stagedItem && stagedItem.packageId === "pkg_PKG-REAL-1", "Import Staging: Staged item packageId matches package ID (pkg_PKG-REAL-1)");

    // 3. Commit through POST /api/import/commit
    const commitRes = await request(app)
      .post("/api/import/commit")
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({ batchId: realBatchId });

    assertTest(commitRes.status === 200 && commitRes.body.success === true, "Import Route: POST /api/import/commit succeeded");

    // 4. Read actual committed production package and item from Firestore
    let prodPkg: any;
    let prodItem: any;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const pkgDoc = await db.collection("packages").doc("pkg_PKG-REAL-1").get();
      const itemSnap = await db.collection("packageItems").where("packageNumber", "==", "PKG-REAL-1").get();
      prodPkg = pkgDoc.data();
      prodItem = itemSnap.docs[0]?.data();
    });

    assertTest(prodPkg && prodPkg.id === "pkg_PKG-REAL-1" && prodPkg.packageId === "pkg_PKG-REAL-1", "Import Commit: Production package document ID === package.packageId");
    assertTest(prodItem && prodItem.packageId === "pkg_PKG-REAL-1", "Import Commit: Production item.packageId === package document ID");
    assertTest(prodItem && prodItem.packageNumber === "PKG-REAL-1" && prodItem.packageNumber === prodPkg.packageNumber, "Import Commit: Production item.packageNumber === package.packageNumber");

    // 5. Authenticate as assigned Rider and test Firestore Rule read on committed package item
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("packages").doc("pkg_PKG-REAL-1").update({ assignedRiderId: "rider_a_doc" });
    });

    const riderAContextReal = testEnv.authenticatedContext(riderAAuth.uid, { role: "rider", riderId: "rider_a_doc" });
    const riderADb = riderAContextReal.firestore();

    await assertSucceeds(riderADb.collection("packageItems").doc(prodItem.itemId).get());
    assertTest(true, "Firestore Rules: Assigned Rider can read committed package item via package relationship");

    // 6. FAILURE TESTS FOR COMMIT
    // Failure 1: Staged item has no packageId
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("importBatches").doc("batch_no_pkg_id").set({ id: "batch_no_pkg_id", status: "validated" });
      await db.collection("importBatches").doc("batch_no_pkg_id").collection("stagedPackages").doc("pkg_PKG-FAIL-1").set({
        packageId: "pkg_PKG-FAIL-1", packageNumber: "PKG-FAIL-1", parentOrderNumber: "ORD-FAIL-1", customerName: "Fail User", address: "123", city: "Lahore"
      });
      await db.collection("importBatches").doc("batch_no_pkg_id").collection("stagedItems").doc("item_no_pkg_id").set({
        itemId: "item_no_pkg_id", packageNumber: "PKG-FAIL-1", itemTitle: "No Pkg Id Item", quantity: 1, unitPrice: 100
      });
    });

    const failRes1 = await request(app)
      .post("/api/import/commit")
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({ batchId: "batch_no_pkg_id" });

    assertTest(failRes1.status === 500 && failRes1.body.success === false, "Failure Test: Commit fails when staged item has no packageId");

    let orphanCreated1 = false;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const doc = await db.collection("packageItems").doc("item_no_pkg_id").get();
      orphanCreated1 = doc.exists;
    });
    assertTest(!orphanCreated1, "Failure Test: Failed relationship did not create production item (item_no_pkg_id)");

    // Failure 2: Staged item has wrong packageId
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("importBatches").doc("batch_wrong_pkg_id").set({ id: "batch_wrong_pkg_id", status: "validated" });
      await db.collection("importBatches").doc("batch_wrong_pkg_id").collection("stagedPackages").doc("pkg_PKG-FAIL-2").set({
        packageId: "pkg_PKG-FAIL-2", packageNumber: "PKG-FAIL-2", parentOrderNumber: "ORD-FAIL-2", customerName: "Fail User", address: "123", city: "Lahore"
      });
      await db.collection("importBatches").doc("batch_wrong_pkg_id").collection("stagedItems").doc("item_wrong_pkg_id").set({
        itemId: "item_wrong_pkg_id", packageId: "pkg_WRONG", packageNumber: "PKG-FAIL-2", itemTitle: "Wrong Pkg Id Item", quantity: 1, unitPrice: 100
      });
    });

    const failRes2 = await request(app)
      .post("/api/import/commit")
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({ batchId: "batch_wrong_pkg_id" });

    assertTest(failRes2.status === 500 && failRes2.body.success === false, "Failure Test: Commit fails when staged item has wrong packageId");

    // Failure 3: Staged item refers to nonexistent staged package
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("importBatches").doc("batch_orphan_item").set({ id: "batch_orphan_item", status: "validated" });
      await db.collection("importBatches").doc("batch_orphan_item").collection("stagedItems").doc("item_orphan_3").set({
        itemId: "item_orphan_3", packageId: "pkg_PKG-MISSING-PKG", packageNumber: "PKG-MISSING-PKG", itemTitle: "Orphan Item", quantity: 1, unitPrice: 100
      });
    });

    const failRes3 = await request(app)
      .post("/api/import/commit")
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({ batchId: "batch_orphan_item" });

    assertTest(failRes3.status === 500 && failRes3.body.success === false, "Failure Test: Commit fails when staged item refers to nonexistent staged package");

    // Failure 4: Staged package has ID inconsistent with package number
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("importBatches").doc("batch_bad_pkg_id").set({ id: "batch_bad_pkg_id", status: "validated" });
      await db.collection("importBatches").doc("batch_bad_pkg_id").collection("stagedPackages").doc("bad_doc_id").set({
        packageId: "invalid_pkg_doc_id", packageNumber: "PKG-FAIL-4", parentOrderNumber: "ORD-FAIL-4", customerName: "Fail User", address: "123", city: "Lahore"
      });
    });

    const failRes4 = await request(app)
      .post("/api/import/commit")
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({ batchId: "batch_bad_pkg_id" });

    assertTest(failRes4.status === 500 && failRes4.body.success === false, "Failure Test: Commit fails when staged package has ID inconsistent with package number");

    // --- SECTION 10: EXCHANGE INTEGRATION & CLOUD FUNCTION ALLOCATION TESTS ---
    // 1. Exchange: Reusing original physical package number is rejected
    const reuseRes = await request(app)
      .post("/api/cs/exchanges")
      .set("Authorization", `Bearer ${csAuth.token}`)
      .send({
        originalPackageId: "pkg_PKG-REAL-1",
        replacementPackageNumber: "PKG-REAL-1",
        exchangeReason: "Size Swap"
      });

    assertTest(reuseRes.status === 400 && reuseRes.body.error?.code === "PACKAGE_NUMBER_REUSE_REJECTED", "Exchange Test: Reusing original package number is rejected");

    // 2. Exchange: Valid exchange creates replacement package with canonical ID
    const repPkgNum = "PKG-EX-REP-1";
    const expectedRepPkgId = buildPackageDocumentId(repPkgNum); // "pkg_PKG-EX-REP-1"

    const exRes = await request(app)
      .post("/api/cs/exchanges")
      .set("Authorization", `Bearer ${csAuth.token}`)
      .send({
        originalPackageId: "pkg_PKG-REAL-1",
        replacementPackageNumber: repPkgNum,
        exchangeReason: "Defect Replacement",
        priceDifference: 500
      });

    assertTest(exRes.status === 200 && exRes.body.success === true, "Exchange Route: POST /api/cs/exchanges succeeded");

    let repPkgDoc: any;
    let exDoc: any;
    let expPkgDoc: any;

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const pkg = await db.collection("packages").doc(expectedRepPkgId).get();
      repPkgDoc = pkg.data();

      const exSnap = await db.collection("exchanges").where("originalPackageId", "==", "pkg_PKG-REAL-1").get();
      exDoc = exSnap.docs[0]?.data();

      if (exDoc) {
        const expSnap = await db.collection("exchangePackages").doc(`exp_${exDoc.id}`).get();
        expPkgDoc = expSnap.data();
      }
    });

    assertTest(repPkgDoc && repPkgDoc.id === expectedRepPkgId, "Exchange Test: Replacement package doc ID equals buildPackageDocumentId(replacementPackageNumber)");
    assertTest(repPkgDoc && repPkgDoc.id === repPkgDoc.packageId, "Exchange Test: replacementPackage.id equals its Firestore document ID & packageId");
    assertTest(repPkgDoc && repPkgDoc.packageId === expectedRepPkgId, "Exchange Test: replacementPackage.packageId equals expected package ID");
    assertTest(exDoc && exDoc.replacementPackageId === expectedRepPkgId, "Exchange Test: Exchange record references replacement package ID");
    assertTest(expPkgDoc && expPkgDoc.replacementPackageId === expectedRepPkgId, "Exchange Test: Exchange-package record references replacement package ID");

    // 3. Exchange: Reusing existing replacement package number returns 409
    const dupRes = await request(app)
      .post("/api/cs/exchanges")
      .set("Authorization", `Bearer ${csAuth.token}`)
      .send({
        originalPackageId: "pkg_PKG-REAL-1",
        replacementPackageNumber: repPkgNum,
        exchangeReason: "Duplicate Attempt"
      });

    assertTest(dupRes.status === 409 && dupRes.body.error?.code === "PACKAGE_NUMBER_ALREADY_EXISTS", "Exchange Test: Reusing existing replacement package number returns 409 PACKAGE_NUMBER_ALREADY_EXISTS");

    // 4. Allocation / Cloud Function Validation Tests
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.collection("codAllocationReviews").doc("rev_cf_test_1").set({
        id: "rev_cf_test_1",
        parentOrderNumber: "ORD-CF-1",
        remainingBalance: 1000,
        activePackageNumbers: ["PKG-CF-1"],
        status: "Pending"
      });
      await db.collection("packages").doc("pkg_PKG-CF-1").set({
        id: "pkg_PKG-CF-1",
        packageId: "pkg_PKG-CF-1",
        packageNumber: "PKG-CF-1",
        parentOrderNumber: "ORD-CF-1",
        operationalStatus: "dispatched",
        importState: "committed"
      });
      await db.collection("packages").doc("pkg_MISMATCH_ID").set({
        id: "pkg_MISMATCH_ID",
        packageId: "pkg_DIFFERENT",
        packageNumber: "PKG-CF-MISMATCH",
        parentOrderNumber: "ORD-CF-1",
        operationalStatus: "dispatched",
        importState: "committed"
      });
    });

    // Allocation without packageId
    const allocNoPkgIdRes = await request(app)
      .post("/api/cod-allocation/approve")
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({
        reviewId: "rev_cf_test_1",
        allocations: [{ packageNumber: "PKG-CF-1", allocatedCod: 1000 }]
      });
    assertTest((allocNoPkgIdRes.status === 409 || allocNoPkgIdRes.status === 500) && allocNoPkgIdRes.body.error?.message?.includes("Every allocation must include a packageId"), "Allocation Test: Allocation without packageId is rejected");

    // Allocation with nonexistent packageId
    const allocNonexistentRes = await request(app)
      .post("/api/cod-allocation/approve")
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({
        reviewId: "rev_cf_test_1",
        allocations: [{ packageId: "pkg_NONEXISTENT", packageNumber: "PKG-CF-1", allocatedCod: 1000 }]
      });
    assertTest((allocNonexistentRes.status === 409 || allocNonexistentRes.status === 500) && allocNonexistentRes.body.error?.message?.includes("does not exist"), "Allocation Test: Allocation with nonexistent packageId is rejected");

    // Allocation where package document packageId differs
    const allocMismatchPkgIdRes = await request(app)
      .post("/api/cod-allocation/approve")
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({
        reviewId: "rev_cf_test_1",
        allocations: [{ packageId: "pkg_MISMATCH_ID", packageNumber: "PKG-CF-MISMATCH", allocatedCod: 1000 }]
      });
    assertTest((allocMismatchPkgIdRes.status === 409 || allocMismatchPkgIdRes.status === 500) && allocMismatchPkgIdRes.body.error?.message?.includes("packageId mismatch"), "Allocation Test: Allocation where package document packageId differs is rejected");

    // Allocation where supplied package number differs
    const allocMismatchPkgNumRes = await request(app)
      .post("/api/cod-allocation/approve")
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({
        reviewId: "rev_cf_test_1",
        allocations: [{ packageId: "pkg_PKG-CF-1", packageNumber: "WRONG-NUMBER", allocatedCod: 1000 }]
      });
    assertTest((allocMismatchPkgNumRes.status === 409 || allocMismatchPkgNumRes.status === 500) && allocMismatchPkgNumRes.body.error?.message?.includes("Package number mismatch"), "Allocation Test: Allocation where supplied package number differs is rejected");

    // Valid canonical package ID
    const allocValidRes = await request(app)
      .post("/api/cod-allocation/approve")
      .set("Authorization", `Bearer ${dispatchAuth.token}`)
      .send({
        reviewId: "rev_cf_test_1",
        allocations: [{ packageId: "pkg_PKG-CF-1", packageNumber: "PKG-CF-1", allocatedCod: 1000 }]
      });
    assertTest(allocValidRes.status === 200 && allocValidRes.body.success === true, "Allocation Test: Valid canonical package ID is accepted");

    // 5. Logistics Router Security & Role Access Regression Tests
    const riderLogisticsDashRes = await request(app)
      .get("/api/logistics/dashboard")
      .set("Authorization", `Bearer ${riderAAuth.token}`);
    assertTest(riderLogisticsDashRes.status === 403, "Logistics Security: Rider token receives 403 on /api/logistics/dashboard");

    const riderLogisticsShipmentsRes = await request(app)
      .get("/api/logistics/shipments")
      .set("Authorization", `Bearer ${riderAAuth.token}`);
    assertTest(riderLogisticsShipmentsRes.status === 403, "Logistics Security: Rider token receives 403 on /api/logistics/shipments");

    const riderLogisticsSingleRes = await request(app)
      .get("/api/logistics/shipments/pkg_PKG-REAL-1")
      .set("Authorization", `Bearer ${riderAAuth.token}`);
    assertTest(riderLogisticsSingleRes.status === 403, "Logistics Security: Rider token receives 403 on /api/logistics/shipments/:id");

    const riderLogisticsImportJobsRes = await request(app)
      .get("/api/logistics/import-jobs")
      .set("Authorization", `Bearer ${riderAAuth.token}`);
    assertTest(riderLogisticsImportJobsRes.status === 403, "Logistics Security: Rider token receives 403 on /api/logistics/import-jobs");

    const riderLogisticsExceptionsRes = await request(app)
      .get("/api/logistics/exceptions")
      .set("Authorization", `Bearer ${riderAAuth.token}`);
    assertTest(riderLogisticsExceptionsRes.status === 403, "Logistics Security: Rider token receives 403 on /api/logistics/exceptions");

    const riderLogisticsPerfRes = await request(app)
      .get("/api/logistics/reports/courier-performance")
      .set("Authorization", `Bearer ${riderAAuth.token}`);
    assertTest(riderLogisticsPerfRes.status === 403, "Logistics Security: Rider token receives 403 on /api/logistics/reports/courier-performance");

    const riderLogisticsMappingsRes = await request(app)
      .get("/api/logistics/courier-mappings")
      .set("Authorization", `Bearer ${riderAAuth.token}`);
    assertTest(riderLogisticsMappingsRes.status === 403, "Logistics Security: Rider token receives 403 on /api/logistics/courier-mappings");

    const dispatchLogisticsDashRes = await request(app)
      .get("/api/logistics/dashboard")
      .set("Authorization", `Bearer ${dispatchAuth.token}`);
    assertTest(dispatchLogisticsDashRes.status === 200, "Logistics Security: Dispatch Manager token successfully accesses /api/logistics/dashboard");

    // 6. Security Headers Check
    const healthRes = await request(app).get("/api/health");
    assertTest(healthRes.headers["x-content-type-options"] === "nosniff", "Security Headers: Helmet sets X-Content-Type-Options: nosniff");

    // 7. Repository Search Checks
    const serverCode = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
    const functionsCode = fs.readFileSync(path.join(process.cwd(), "functions/src/index.ts"), "utf8");
    const rulesCode = fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8");

    const serverPkgDocCalculations = (serverCode.match(/`pkg_\$\{/g) || []).length;
    const functionsPkgDocCalculations = (functionsCode.match(/`pkg_\$\{/g) || []).length;
    assertTest(serverPkgDocCalculations === 0 && functionsPkgDocCalculations === 0, "Repo Check: Zero `pkg_${...}` package-ID calculations outside buildPackageDocumentId");

    const serverPkgEx = (serverCode.match(/pkg_ex_/g) || []).length;
    const functionsPkgEx = (functionsCode.match(/pkg_ex_/g) || []).length;
    assertTest(serverPkgEx === 0 && functionsPkgEx === 0, "Repo Check: Zero `pkg_ex_${...}` package IDs");

    const cfFallbackGen = /alloc\.packageId\s*\|\|\s*`pkg_/.test(functionsCode);
    assertTest(!cfFallbackGen, "Repo Check: Zero Cloud Function fallback package-ID generation");

    const packageItemRiderIdCheckInRules = /match\s+\/packageItems\/\{docId\}[^}]*resource\.data\.riderId/.test(rulesCode);
    assertTest(!packageItemRiderIdCheckInRules, "Production Schema: Repository search returns zero package-item ownership checks using resource.data.riderId");

    console.log("================================================================");
    console.log(`REAL INTEGRATION TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
    console.log("================================================================");

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await testEnv.cleanup();
  }
}

runSecurityIntegrationTests().catch(err => {
  console.error("❌ Integration test suite failed with error:", err);
  process.exit(1);
});
