import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationsAnalytics } from '../src/server/analytics/operationsAnalytics.js';
import { buildFinanceAnalytics } from '../src/server/analytics/financeAnalytics.js';
import { buildReturnsAnalytics } from '../src/server/analytics/returnsAnalytics.js';
import { buildActivityAnalytics } from '../src/server/analytics/activityAnalytics.js';
import { buildExceptionsAnalytics } from '../src/server/analytics/exceptionsAnalytics.js';
import { LoadedAnalyticsDataset, ManagementFilters } from '../src/server/analytics/analyticsTypes.js';

function emptyDataset(): LoadedAnalyticsDataset {
  return {
    packages: [],
    riders: [],
    profiles: [],
    assignments: [],
    dispatchRuns: [],
    custodyScans: [],
    deliveryAttempts: [],
    deliveryContactEvents: [],
    returns: [],
    returnReceipts: [],
    returnCustodyEvents: [],
    codCollections: [],
    codCollectionDiscrepancies: [],
    financialPostings: [],
    riderSettlements: [],
    digitalPaymentVerifications: [],
    auditLogs: [],
    auditEvents: [],
    financialAuditEvents: [],
    exceptions: [],
    customerServiceCases: [],
    customerContactAttempts: [],
    reattemptRequests: [],
    importBatches: []
  };
}

function filters(date: string): ManagementFilters {
  return {
    datePreset: 'custom',
    fromDate: date,
    toDate: date
  };
}

function metricValue(metrics: Array<{ key: string; value: number | null }>, key: string) {
  return metrics.find((metric) => metric.key === key)?.value ?? null;
}

test('dashboard date accuracy uses Asia/Karachi day boundaries for Delivered Today', () => {
  const dataset = emptyDataset();
  for (let i = 1; i <= 30; i++) {
    dataset.packages.push({
      id: `pkg_${i}`,
      packageNumber: `G#${i}`,
      city: 'Lahore',
      createdAt: '2026-08-22T09:00:00+05:00',
      updatedAt: '2026-08-22T09:00:00+05:00',
      operationalStatus: 'delivered'
    });
  }
  for (let i = 1; i <= 10; i++) {
    dataset.deliveryAttempts.push({
      id: `att_y_${i}`,
      packageId: `pkg_${i}`,
      riderId: 'r1',
      status: 'DELIVERED',
      createdAt: '2026-08-21T15:00:00+05:00'
    });
  }
  for (let i = 11; i <= 30; i++) {
    dataset.deliveryAttempts.push({
      id: `att_t_${i}`,
      packageId: `pkg_${i}`,
      riderId: 'r1',
      status: 'DELIVERED',
      createdAt: '2026-08-22T12:00:00+05:00'
    });
  }

  const analytics = buildOperationsAnalytics(dataset, filters('2026-08-22'));
  assert.equal(metricValue(analytics.topStats, 'deliveredToday'), 20);
});

test('first attempt success formula is computed from actual attempts', () => {
  const dataset = emptyDataset();
  for (let i = 1; i <= 100; i++) {
    dataset.packages.push({
      id: `pkg_${i}`,
      packageNumber: `G#${i}`,
      city: 'Lahore',
      createdAt: '2026-08-22T08:00:00+05:00',
      updatedAt: '2026-08-22T08:00:00+05:00',
      operationalStatus: i <= 90 ? 'delivered' : 'customer_unavailable'
    });
  }

  for (let i = 1; i <= 80; i++) {
    dataset.deliveryAttempts.push({
      id: `att_1_${i}`,
      packageId: `pkg_${i}`,
      riderId: 'r1',
      attemptNumber: 1,
      status: 'DELIVERED',
      createdAt: '2026-08-22T10:00:00+05:00'
    });
  }

  for (let i = 81; i <= 90; i++) {
    dataset.deliveryAttempts.push({
      id: `att_1_fail_${i}`,
      packageId: `pkg_${i}`,
      riderId: 'r1',
      attemptNumber: 1,
      status: 'CUSTOMER_UNAVAILABLE',
      createdAt: '2026-08-22T10:00:00+05:00'
    });
    dataset.deliveryAttempts.push({
      id: `att_2_del_${i}`,
      packageId: `pkg_${i}`,
      riderId: 'r1',
      attemptNumber: 2,
      status: 'DELIVERED',
      createdAt: '2026-08-22T14:00:00+05:00'
    });
  }

  for (let i = 91; i <= 100; i++) {
    dataset.deliveryAttempts.push({
      id: `att_fail_${i}`,
      packageId: `pkg_${i}`,
      riderId: 'r1',
      attemptNumber: 1,
      status: 'REFUSED',
      createdAt: '2026-08-22T16:00:00+05:00'
    });
  }

  const analytics = buildOperationsAnalytics(dataset, filters('2026-08-22'));
  assert.equal(Number(metricValue(analytics.deliveryPerformance, 'firstAttemptSuccessRate')?.toFixed(1)), 80.0);
});

test('COD dashboard reconciles exact known financial batch values', () => {
  const dataset = emptyDataset();
  dataset.riders.push({ id: 'r1', fullName: 'Zahid', active: true });
  dataset.riders.push({ id: 'r2', fullName: 'Raheel', active: true });

  for (let i = 1; i <= 5; i++) {
    dataset.packages.push({
      id: `pkg_${i}`,
      packageNumber: `G#${i}`,
      city: 'Lahore',
      createdAt: '2026-08-22T08:00:00+05:00',
      updatedAt: '2026-08-22T08:00:00+05:00',
      operationalStatus: 'delivered'
    });
  }

  dataset.codCollections.push(
    { id: 'cod_1', packageId: 'pkg_1', riderId: 'r1', expectedCod: 100000, collectedAmount: 100000, paymentMethod: 'cash', createdAt: '2026-08-22T10:00:00+05:00' },
    { id: 'cod_2', packageId: 'pkg_2', riderId: 'r1', expectedCod: 50000, collectedAmount: 50000, paymentMethod: 'cash', createdAt: '2026-08-22T11:00:00+05:00' },
    { id: 'cod_3', packageId: 'pkg_3', riderId: 'r2', expectedCod: 70000, collectedAmount: 70000, paymentMethod: 'cash', createdAt: '2026-08-22T11:30:00+05:00' },
    { id: 'cod_4', packageId: 'pkg_4', riderId: 'r2', expectedCod: 60000, collectedAmount: 60000, paymentMethod: 'jazzcash', createdAt: '2026-08-22T12:00:00+05:00' },
    { id: 'cod_5', packageId: 'pkg_5', riderId: 'r2', expectedCod: 20000, collectedAmount: 20000, paymentMethod: 'easypaisa', createdAt: '2026-08-22T13:00:00+05:00' }
  );

  dataset.financialPostings.push(
    { id: 'post_1', accountCode: 'RIDER_CASH_WALLET', riderId: 'r1', debitAmount: 150000, creditAmount: 0, createdAt: '2026-08-22T10:00:00+05:00' },
    { id: 'post_2', accountCode: 'RIDER_CASH_WALLET', riderId: 'r2', debitAmount: 70000, creditAmount: 0, createdAt: '2026-08-22T11:30:00+05:00' },
    { id: 'post_3', accountCode: 'RIDER_CASH_WALLET', riderId: 'r1', debitAmount: 0, creditAmount: 90000, createdAt: '2026-08-22T17:00:00+05:00' },
    { id: 'post_4', accountCode: 'RIDER_CASH_WALLET', riderId: 'r2', debitAmount: 0, creditAmount: 30000, createdAt: '2026-08-22T17:05:00+05:00' },
    { id: 'post_5', accountCode: 'RIDER_CASH_WALLET', riderId: 'r2', debitAmount: 0, creditAmount: 2500, createdAt: '2026-08-22T18:00:00+05:00' }
  );

  dataset.riderSettlements.push(
    { id: 'stl_1', settlementNumber: 'SET-1', riderId: 'r1', declaredCashAmount: 90000, physicallyReceivedAmount: 90000, totalSettlementVariance: 0, status: 'cashier_received', submittedAt: '2026-08-22T16:30:00+05:00', receivedAt: '2026-08-22T17:00:00+05:00' },
    { id: 'stl_2', settlementNumber: 'SET-2', riderId: 'r2', declaredCashAmount: 160000, physicallyReceivedAmount: 156000, totalSettlementVariance: -4000, status: 'discrepancy', submittedAt: '2026-08-22T16:40:00+05:00', receivedAt: '2026-08-22T17:10:00+05:00' },
    { id: 'stl_3', settlementNumber: 'SET-3', riderId: 'r2', declaredCashAmount: 1500, physicallyReceivedAmount: 0, totalSettlementVariance: 1500, status: 'discrepancy', submittedAt: '2026-08-22T18:10:00+05:00' }
  );

  dataset.digitalPaymentVerifications.push(
    { id: 'dig_1', packageId: 'pkg_4', digitalReference: 'TX1', amount: 60000, paymentMethod: 'jazzcash', status: 'pending', createdAt: '2026-08-22T12:00:00+05:00' },
    { id: 'dig_2', packageId: 'pkg_5', digitalReference: 'TX2', amount: 20000, paymentMethod: 'easypaisa', status: 'pending', createdAt: '2026-08-22T13:00:00+05:00' }
  );

  const finance = buildFinanceAnalytics(dataset, filters('2026-08-22'));
  assert.equal(metricValue(finance.summary, 'codExpected'), 300000);
  assert.equal(metricValue(finance.summary, 'codCollected'), 300000);
  assert.equal(metricValue(finance.summary, 'cashCod'), 220000);
  assert.equal(metricValue(finance.summary, 'digitalCod'), 80000);
  assert.equal(metricValue(finance.summary, 'cashWithRiders'), 97500);
  assert.equal(metricValue(finance.summary, 'cashierReceived'), 246000);
  assert.equal(metricValue(finance.summary, 'openShortage'), 4000);
  assert.equal(metricValue(finance.summary, 'openExcess'), 1500);
  assert.equal(metricValue(finance.summary, 'digitalVerificationPending'), 80000);
  assert.equal(finance.drilldowns.cashWithRiders.reduce((sum: number, row: any) => sum + row.amount, 0), metricValue(finance.summary, 'cashWithRiders'));
});

test('overall finance status stays attention required when cash matches but collection and digital exceptions remain', () => {
  const dataset = emptyDataset();
  dataset.packages.push({ id: 'pkg_1', packageNumber: 'G#1', city: 'Karachi', createdAt: '2026-08-22T08:00:00+05:00', updatedAt: '2026-08-22T08:00:00+05:00', operationalStatus: 'delivered' });
  dataset.codCollections.push({ id: 'cod_1', packageId: 'pkg_1', riderId: 'r1', expectedCod: 100000, collectedAmount: 95000, paymentMethod: 'cash', createdAt: '2026-08-22T10:00:00+05:00' });
  dataset.codCollectionDiscrepancies.push({ id: 'variance_1', packageId: 'pkg_1', riderId: 'r1', variance: -5000, status: 'OPEN', createdAt: '2026-08-22T10:00:00+05:00' });
  dataset.riderSettlements.push({ id: 'settlement_1', riderId: 'r1', declaredCashAmount: 95000, physicallyReceivedAmount: 95000, totalSettlementVariance: 0, status: 'cashier_received', submittedAt: '2026-08-22T16:00:00+05:00', receivedAt: '2026-08-22T17:00:00+05:00' });
  dataset.digitalPaymentVerifications.push({ id: 'digital_1', packageId: 'pkg_2', amount: 200000, paymentMethod: 'jazzcash', status: 'pending', createdAt: '2026-08-22T12:00:00+05:00' });

  const finance = buildFinanceAnalytics(dataset, filters('2026-08-22'));
  assert.equal(finance.reconciliation.status, 'ATTENTION_REQUIRED');
  assert.deepEqual(finance.reconciliation.reasonFlags, ['OPEN_COLLECTION_VARIANCE', 'DIGITAL_VERIFICATION_PENDING']);
  assert.equal(finance.reconciliation.components.cash.status, 'MATCHED');
  assert.equal(finance.reconciliation.components.ledger.status, 'MATCHED');
  assert.equal(finance.reconciliation.components.collection.status, 'ATTENTION_REQUIRED');
  assert.equal(finance.reconciliation.components.digital.status, 'ATTENTION_REQUIRED');
});

test('returns dashboard reflects exact required / received / pending counts', () => {
  const dataset = emptyDataset();
  for (let i = 1; i <= 20; i++) {
    dataset.packages.push({
      id: `pkg_${i}`,
      packageNumber: `G#${i}`,
      city: 'Lahore',
      createdAt: '2026-08-22T08:00:00+05:00',
      updatedAt: '2026-08-22T08:00:00+05:00',
      operationalStatus: i <= 15 ? 'warehouse_received' : 'rider_handed_back'
    });
    dataset.returns.push({
      id: `ret_${i}`,
      packageId: `pkg_${i}`,
      riderId: 'r1',
      returnStatus: i <= 15 ? 'warehouse_received' : 'rider_handed_back',
      returnReason: 'REFUSED',
      createdAt: '2026-08-22T10:00:00+05:00',
      updatedAt: '2026-08-22T10:00:00+05:00'
    });
    if (i <= 15) {
      dataset.returnReceipts.push({
        id: `rcpt_${i}`,
        packageId: `pkg_${i}`,
        receivedAt: '2026-08-22T12:00:00+05:00',
        packageCondition: 'sealed',
        createdAt: '2026-08-22T12:00:00+05:00'
      });
    }
  }

  const returns = buildReturnsAnalytics(dataset, filters('2026-08-22'));
  assert.equal(metricValue(returns.summary, 'returnRequired'), 20);
  assert.equal(metricValue(returns.summary, 'warehouseReceived'), 15);
  assert.equal(returns.discrepancies.riderHandedBackWarehouseMissing.length, 5);
});

test('staff actions count humans only and exclude system events', () => {
  const dataset = emptyDataset();
  for (let i = 1; i <= 50; i++) {
    dataset.auditLogs.push({
      id: `human_${i}`,
      action: 'PACKAGE_ASSIGNED',
      actorUid: `u_${(i % 5) + 1}`,
      actorRole: 'dispatch_manager',
      actorType: 'HUMAN',
      timestamp: '2026-08-22T09:00:00+05:00'
    });
  }
  for (let i = 1; i <= 100; i++) {
    dataset.auditLogs.push({
      id: `system_${i}`,
      action: 'SHOPIFY_SYNC',
      actorUid: 'system_shopify_sync',
      actorRole: 'system',
      actorType: 'SYSTEM',
      timestamp: '2026-08-22T09:10:00+05:00'
    });
  }

  const activity = buildActivityAnalytics(dataset, filters('2026-08-22'));
  assert.equal(activity.summary.humanActionCount, 50);
  assert.equal(activity.summary.systemActionCount, 100);
});

test('primary KPI totals reconcile to drilldown rows and values', () => {
  const dataset = emptyDataset();
  dataset.riders.push({ id: 'r1', fullName: 'Zahid', active: true });
  for (let i = 1; i <= 4; i++) {
    dataset.packages.push({
      id: `pkg_${i}`,
      packageNumber: `G#${i}`,
      city: 'Lahore',
      createdAt: '2026-08-22T09:00:00+05:00',
      updatedAt: '2026-08-22T09:00:00+05:00',
      operationalStatus: i <= 2 ? 'ready_for_dispatch' : 'delivered'
    });
  }
  dataset.deliveryAttempts.push(
    { id: 'att_1', packageId: 'pkg_3', riderId: 'r1', status: 'DELIVERED', createdAt: '2026-08-22T12:00:00+05:00' },
    { id: 'att_2', packageId: 'pkg_4', riderId: 'r1', status: 'DELIVERED', createdAt: '2026-08-22T13:00:00+05:00' }
  );
  dataset.codCollections.push(
    { id: 'cod_1', packageId: 'pkg_3', riderId: 'r1', expectedCod: 5000, collectedAmount: 5000, paymentMethod: 'cash', createdAt: '2026-08-22T12:00:00+05:00' },
    { id: 'cod_2', packageId: 'pkg_4', riderId: 'r1', expectedCod: 7000, collectedAmount: 7000, paymentMethod: 'cash', createdAt: '2026-08-22T13:00:00+05:00' }
  );
  dataset.financialPostings.push({ id: 'post_1', accountCode: 'RIDER_CASH_WALLET', riderId: 'r1', debitAmount: 12000, creditAmount: 0, createdAt: '2026-08-22T13:10:00+05:00' });

  const operations = buildOperationsAnalytics(dataset, filters('2026-08-22'));
  const finance = buildFinanceAnalytics(dataset, filters('2026-08-22'));
  assert.equal(metricValue(operations.topStats, 'deliveredToday'), 2);
  assert.equal(metricValue(finance.summary, 'cashWithRiders'), finance.drilldowns.cashWithRiders.reduce((sum: number, row: any) => sum + row.amount, 0));
});

test('1,000-package management simulation reconciles operations, COD, returns, staff activity and exceptions', () => {
  const dataset = emptyDataset();
  const today = '2026-08-22';
  const riderIds = ['r1', 'r2', 'r3', 'r4', 'r5'];
  riderIds.forEach((riderId, index) => {
    dataset.riders.push({ id: riderId, fullName: `Rider ${index + 1}`, rider_code: `R${index + 1}`, active: true, assigned_zone: `Zone ${index + 1}`, city: index % 2 === 0 ? 'Lahore' : 'Karachi' });
  });

  let deliveredCount = 0;
  let failedCount = 0;
  let returnRequired = 0;
  let warehouseReceived = 0;
  let pendingReturns = 0;
  let humanActions = 0;
  let codExpected = 0;
  let codCollected = 0;
  let cashCod = 0;
  let digitalCod = 0;

  for (let i = 1; i <= 1000; i++) {
    const riderId = riderIds[i % riderIds.length];
    const isCod = i <= 700;
    const status =
      i <= 550 ? 'delivered' :
      i <= 650 ? 'delivered' :
      i <= 880 ? 'customer_unavailable' :
      i <= 930 ? 'out_for_delivery' :
      i <= 980 ? 'ready_for_dispatch' :
      'assigned';
    dataset.packages.push({
      id: `pkg_${i}`,
      packageNumber: `G#${i}`,
      customerName: `Customer ${i}`,
      city: i % 2 === 0 ? 'Lahore' : 'Karachi',
      assignedRiderId: riderId,
      createdAt: `${today}T08:00:00+05:00`,
      updatedAt: `${today}T08:00:00+05:00`,
      operationalStatus: status,
      cod_expected: isCod ? 1000 : 0
    });

    dataset.assignments.push({
      id: `pkg_${i}`,
      packageId: `pkg_${i}`,
      riderId,
      assignedAt: `${today}T08:30:00+05:00`,
      active: ['assigned', 'out_for_delivery', 'customer_unavailable'].includes(status)
    });

    if (i <= 650) {
      deliveredCount++;
      const attemptNumber = i <= 470 ? 1 : 2;
      if (attemptNumber === 2) {
        dataset.deliveryAttempts.push({
          id: `att_fail_${i}`,
          packageId: `pkg_${i}`,
          riderId,
          attemptNumber: 1,
          status: 'CUSTOMER_UNAVAILABLE',
          createdAt: `${today}T10:00:00+05:00`
        });
        humanActions++;
      }
      dataset.deliveryAttempts.push({
        id: `att_del_${i}`,
        packageId: `pkg_${i}`,
        riderId,
        attemptNumber,
        status: 'DELIVERED',
        createdAt: `${today}T12:00:00+05:00`,
        collectedAmount: isCod ? 1000 : 0,
        paymentMethod: isCod ? (i <= 400 ? 'cash' : i <= 550 ? 'jazzcash' : 'prepaid') : 'prepaid'
      });
      humanActions++;

      if (isCod) {
        dataset.codCollections.push({
          id: `cod_${i}`,
          packageId: `pkg_${i}`,
          riderId,
          expectedCod: 1000,
          collectedAmount: 1000,
          paymentMethod: i <= 400 ? 'cash' : 'jazzcash',
          createdAt: `${today}T12:00:00+05:00`
        });
        codExpected += 1000;
        codCollected += 1000;
        if (i <= 400) cashCod += 1000;
        else digitalCod += 1000;
      }
    }

    if (i >= 651 && i <= 880) {
      failedCount++;
      const outcome = i % 3 === 0 ? 'REFUSED' : i % 3 === 1 ? 'CUSTOMER_UNAVAILABLE' : 'ADDRESS_ISSUE';
      dataset.deliveryAttempts.push({
        id: `att_fail_${i}`,
        packageId: `pkg_${i}`,
        riderId,
        attemptNumber: 1,
        status: outcome,
        createdAt: `${today}T13:00:00+05:00`
      });
      humanActions++;
      dataset.returns.push({
        id: `ret_${i}`,
        packageId: `pkg_${i}`,
        riderId,
        returnStatus: i <= 860 ? 'warehouse_received' : 'rider_handed_back',
        returnReason: outcome,
        createdAt: `${today}T14:00:00+05:00`,
        updatedAt: `${today}T14:00:00+05:00`
      });
      returnRequired++;
      if (i <= 860) {
        warehouseReceived++;
        dataset.returnReceipts.push({
          id: `rcpt_${i}`,
          packageId: `pkg_${i}`,
          packageCondition: 'sealed',
          receivedAt: `${today}T15:00:00+05:00`,
          createdAt: `${today}T15:00:00+05:00`
        });
      } else {
        pendingReturns++;
      }
    }
  }

  dataset.financialPostings.push(
    { id: 'post_cash_debit', accountCode: 'RIDER_CASH_WALLET', riderId: 'r1', debitAmount: 400000, creditAmount: 0, createdAt: `${today}T12:10:00+05:00` },
    { id: 'post_cash_credit', accountCode: 'RIDER_CASH_WALLET', riderId: 'r1', debitAmount: 0, creditAmount: 246000, createdAt: `${today}T18:00:00+05:00` },
    { id: 'post_resolution_credit', accountCode: 'RIDER_CASH_WALLET', riderId: 'r1', debitAmount: 0, creditAmount: 2500, createdAt: `${today}T18:30:00+05:00` }
  );
  dataset.riderSettlements.push(
    { id: 'stl_a', riderId: 'r1', declaredCashAmount: 250000, physicallyReceivedAmount: 246000, totalSettlementVariance: -4000, status: 'discrepancy', submittedAt: `${today}T17:00:00+05:00`, receivedAt: `${today}T18:00:00+05:00` },
    { id: 'stl_b', riderId: 'r2', declaredCashAmount: 1500, physicallyReceivedAmount: 0, totalSettlementVariance: 1500, status: 'discrepancy', submittedAt: `${today}T18:20:00+05:00` }
  );

  for (let i = 1; i <= humanActions; i++) {
    dataset.auditLogs.push({
      id: `audit_h_${i}`,
      action: 'ACTION',
      actorUid: `u_${(i % 10) + 1}`,
      actorRole: i % 2 === 0 ? 'dispatch_manager' : 'rider',
      actorType: 'HUMAN',
      timestamp: `${today}T09:00:00+05:00`
    });
  }
  for (let i = 1; i <= 28; i++) {
    dataset.exceptions.push({
      id: `exc_${i}`,
      severity: i <= 3 ? 'CRITICAL' : i <= 11 ? 'HIGH' : 'MEDIUM',
      status: 'OPEN',
      details: 'Synthetic exception',
      createdAt: `${today}T11:00:00+05:00`
    });
  }

  const ops = buildOperationsAnalytics(dataset, filters(today));
  const fin = buildFinanceAnalytics(dataset, filters(today));
  const ret = buildReturnsAnalytics(dataset, filters(today));
  const act = buildActivityAnalytics(dataset, filters(today));
  const exc = buildExceptionsAnalytics(dataset, filters(today));

  assert.equal(metricValue(ops.topStats, 'ordersEntered'), 1000);
  assert.equal(metricValue(ops.topStats, 'deliveredToday'), deliveredCount);
  assert.equal(metricValue(ops.topStats, 'failedAttemptsToday'), failedCount + 180);
  assert.equal(metricValue(fin.summary, 'codExpected'), codExpected);
  assert.equal(metricValue(fin.summary, 'codCollected'), codCollected);
  assert.equal(metricValue(fin.summary, 'cashCod'), cashCod);
  assert.equal(metricValue(fin.summary, 'digitalCod'), digitalCod);
  assert.equal(metricValue(ret.summary, 'returnRequired'), returnRequired);
  assert.equal(metricValue(ret.summary, 'warehouseReceived'), warehouseReceived);
  assert.equal(ret.discrepancies.riderHandedBackWarehouseMissing.length, pendingReturns);
  assert.equal(act.summary.humanActionCount, humanActions + humanActions + 3);
  assert.equal(exc.counts.critical, 3);
  assert.equal(exc.counts.high, 8);
  assert.equal(exc.counts.medium, 17);
});
