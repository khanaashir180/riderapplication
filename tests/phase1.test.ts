import { processOMSImportRows, calculateSHA256, classifyOperationalStatus, classifyDeliveryChannel } from '../src/services/csvImporter';

function runPhase1Tests() {
  console.log('================================================================');
  console.log('RUNNING PHASE 1 AUTOMATED ACCEPTANCE TESTS');
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

  // TEST 1: CSV OMS Grouping (6,884 rows -> 6,679 packages)
  // 6,675 unique single-item packages (6,675 rows)
  // + 2 packages for G#43312 (G#43312_1 and G#43312_2) (2 rows)
  // + 2 packages for G#44087 (G#44087_1: 102 rows, G#44087_2: 105 rows -> total 207 rows)
  // Total rows = 6,675 + 2 + 207 = 6,884 rows.
  // Unique packages = 6,675 + 2 + 2 = 6,679 packages!
  const sampleRows: any[] = [];

  for (let i = 1; i <= 6675; i++) {
    sampleRows.push({
      'Order number': `G#${30000 + i}_1`,
      'Parent order number': `G#${30000 + i}`,
      'Shipping Name': `Customer ${i}`,
      'Shipping Phone': '03001234567',
      'Shipping Address1': 'Street 1, Main Road',
      'Shipping City': 'Lahore',
      'Total': '12500',
      'Captured Amount': '0',
      'Lineitem Title': 'Gomila Oxford Shoe',
      'Lineitem quantity': '1',
      'Lineitem price': '12500',
      'Dispatched': '2026-07-31T08:00:00Z'
    });
  }

  // Ambiguous Parent G#43312: 2 physical packages (G#43312_1: 9,450; G#43312_2: 10,000 -> Parent Total = 19,450; Captured = 10,000; Balance = 9,450)
  sampleRows.push({
    'Order number': 'G#43312_1',
    'Parent order number': 'G#43312',
    'Shipping Name': 'Tariq Malik',
    'Shipping Phone': '03214567890',
    'Shipping Address1': 'DHA Phase 5, Villa 12',
    'Shipping City': 'Lahore',
    'Total': '9450',
    'Captured Amount': '10000',
    'Lineitem Title': 'Gomila Sovereign Oxford',
    'Lineitem quantity': '1',
    'Lineitem price': '9450',
    'Dispatched': '2026-07-31T08:00:00Z'
  });
  sampleRows.push({
    'Order number': 'G#43312_2',
    'Parent order number': 'G#43312',
    'Shipping Name': 'Tariq Malik',
    'Shipping Phone': '03214567890',
    'Shipping Address1': 'DHA Phase 5, Villa 12',
    'Shipping City': 'Lahore',
    'Total': '10000',
    'Captured Amount': '10000',
    'Lineitem Title': 'Gomila Belt Leather',
    'Lineitem quantity': '1',
    'Lineitem price': '10000',
    'Dispatched': '2026-07-31T08:00:00Z'
  });

  // Ambiguous Parent G#44087: 2 physical packages across 207 rows (G#44087_1: 1,998; G#44087_2: 5,000 -> Parent Total = 6,998; Captured = 5,000; Balance = 1,998)
  for (let item = 1; item <= 102; item++) {
    sampleRows.push({
      'Order number': 'G#44087_1',
      'Parent order number': 'G#44087',
      'Shipping Name': 'Javed Iqbal',
      'Shipping Phone': '03008889999',
      'Shipping Address1': 'Clifton Block 4',
      'Shipping City': 'Karachi',
      'Total': '1998',
      'Captured Amount': '5000',
      'Lineitem Title': `Gomila Item ${item}`,
      'Lineitem quantity': '1',
      'Lineitem price': '19.58',
      'Dispatched': '2026-07-31T08:00:00Z'
    });
  }

  for (let item = 1; item <= 105; item++) {
    sampleRows.push({
      'Order number': 'G#44087_2',
      'Parent order number': 'G#44087',
      'Shipping Name': 'Javed Iqbal',
      'Shipping Phone': '03008889999',
      'Shipping Address1': 'Clifton Block 4',
      'Shipping City': 'Karachi',
      'Total': '5000',
      'Captured Amount': '5000',
      'Lineitem Title': `Gomila Extra Item ${item}`,
      'Lineitem quantity': '1',
      'Lineitem price': '47.61',
      'Dispatched': '2026-07-31T08:00:00Z'
    });
  }

  const checksum = calculateSHA256(JSON.stringify(sampleRows));
  const res = processOMSImportRows(sampleRows, checksum);

  assert(res.total_rows === 6884, `Total source rows processed: ${res.total_rows} (Expected 6,884)`);
  assert(res.unique_packages_count === 6679, `Unique physical packages count: ${res.unique_packages_count} (Expected 6,679)`);

  // TEST 2: Header mapping & bad field rejection
  const badRow = {
    'Order Weight Type': 'G#99999_1',
    'Order number': 'G#10000_1',
    'Shipping Name': 'Ali Khan'
  };
  const badRes = processOMSImportRows([badRow], 'checksum-bad');
  assert(badRes.packages[0].package_number === 'G#10000_1', 'Correctly mapped Order number over Order Weight Type');

  // TEST 3: COD Allocation Review Queue for G#43312 and G#44087
  const reviewParent43312 = res.cod_allocation_reviews.find(r => r.parent_order_number === 'G#43312');
  const reviewParent44087 = res.cod_allocation_reviews.find(r => r.parent_order_number === 'G#44087');

  assert(reviewParent43312 !== undefined, 'Ambiguous parent G#43312 correctly placed in COD Allocation Review Queue');
  assert(reviewParent44087 !== undefined, 'Ambiguous parent G#44087 correctly placed in COD Allocation Review Queue');
  if (reviewParent43312) {
    assert(reviewParent43312.remaining_balance === 9450, `G#43312 remaining balance calculated as 9,450 (Found: ${reviewParent43312.remaining_balance})`);
  }
  if (reviewParent44087) {
    assert(reviewParent44087.remaining_balance === 1998, `G#44087 remaining balance calculated as 1,998 (Found: ${reviewParent44087.remaining_balance})`);
  }

  // TEST 4: Promised Delivery Date is null when absent (No tomorrow default)
  const pkgWithoutDate = res.packages.find(p => p.package_number === 'G#30001_1');
  assert(pkgWithoutDate?.promised_delivery_date === null, 'Promised delivery date is null when missing in CSV (No tomorrow default)');

  // TEST 5: Operational status precedence and delivery channel classification
  const statusDelivered = classifyOperationalStatus({ 'Delivered': '2026-07-31T09:00:00Z', 'Order Status': 'Dispatched' });
  assert(statusDelivered === 'delivered', 'Delivered timestamp takes precedence over dispatched status');

  const statusReturned = classifyOperationalStatus({ 'Returned': '2026-07-31T09:00:00Z' });
  assert(statusReturned === 'returned', 'Returned timestamp correctly sets status to returned');

  const channelRider = classifyDeliveryChannel('Lahore Rider - Kashif');
  assert(channelRider === 'internal_rider', 'Courier containing Rider classified as internal_rider');

  const channelTcs = classifyDeliveryChannel('TCS Express');
  assert(channelTcs === 'external_courier', 'Courier TCS classified as external_courier');

  console.log('================================================================');
  console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase1Tests();
