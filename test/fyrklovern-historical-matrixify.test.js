const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { transform, validateHeaders, ORDER_HEADERS, CUSTOMER_HEADERS } = require('../src/importers/fyrklovern/historical-matrixify');
const { main } = require('../scripts/fyrklovern/buildHistoricalMatrixify');

const customer = (number = 'C1', email = 'one@example.test') => ({ number, name: 'Example Person', email, country: 'SE', addressLine1: 'Street 1', city: 'Stockholm', postalCode: '12345', phoneNumber: '' });
const line = (overrides = {}) => ({ orderNo: '100', orderDate: '2024-01-16', sellToCountry: 'SE', sellToCustomerNo: 'C1', itemID: 'SKU1', itemName: 'Plate', quantity: '2', unitPriceInclVAT: '100.00', amountInclVAT: '80.00', discount: '20.00', VAT: '16.00', currencyCode: 'SEK', ...overrides });

test('quantity two uses the source line total and VAT-inclusive discount', () => {
  const result = transform([line()], [customer()], { mode: 'full', approveFull: true });
  const rows = result.orderRows;
  assert.equal(rows.find(r => r['Line: Type'] === 'Line Item')['Line: Price'], '50.00');
  assert.equal(rows.find(r => r['Line: Type'] === 'Line Item')['Line: Discount'], '-20.00');
  assert.equal(rows.find(r => r['Line: Type'] === 'Line Item')['Line: Tax 1 Price'], '16.00');
  assert.equal(rows.find(r => r['Line: Type'] === 'Transaction')['Transaction: Amount'], '80.00');
  assert.equal(rows.find(r => r['Line: Type'] === 'Fulfillment Line')['Fulfillment: Status'], 'success');
  assert.equal(rows.find(r => r['Line: Type'] === 'Fulfillment Line')['Line: SKU'], undefined);
  assert.equal(result.report.included.orders, 1);
  assert.equal(rows.find(r => r['Line: Type'] === 'Line Item')['Line: ID'], 1);
});

test('freight, all currencies, and customer-only records reconcile', () => {
  const currencies = ['SEK', 'EUR', 'NOK', 'DKK'];
  const orders = currencies.flatMap((currencyCode, i) => [line({ orderNo: String(i + 1), sellToCustomerNo: `C${i + 1}`, currencyCode, quantity: '1' }), line({ orderNo: String(i + 1), sellToCustomerNo: `C${i + 1}`, currencyCode, itemID: 'Freight', itemName: 'Freight', quantity: '1', unitPriceInclVAT: '20.00', amountInclVAT: '20.00', discount: '0.00', VAT: '4.00' })]);
  const customers = currencies.map((_, i) => customer(`C${i + 1}`, `c${i + 1}@example.test`)).concat(customer('C5', 'extra@example.test'));
  const result = transform(orders, customers, { mode: 'full', approveFull: true });
  assert.equal(result.report.included.customers, 5);
  assert.equal(result.report.included.orders, 4);
  for (const currency of currencies) assert.deepEqual(result.report.totals[currency], { source: '100.00', included: '100.00', output: '100.00', sourceVat: '20.00', includedVat: '20.00', outputVat: '20.00' });
  assert.equal(result.orderRows.filter(r => r['Line: Type'] === 'Shipping Line').length, 4);
});

test('omits duplicate and invalid customers, absent joins, and invalid order money', () => {
  const customers = [customer('C1', 'bad'), customer('C2', 'dup@example.test'), customer('C3', 'dup@example.test'), customer('C4', ''), customer('C5', 'ok@example.test'), customer('C5', 'other@example.test')];
  const orders = [line({ orderNo: '1' }), line({ orderNo: '2', sellToCustomerNo: 'C2' }), line({ orderNo: '3', sellToCustomerNo: 'C5' }), line({ orderNo: '4', sellToCustomerNo: 'C9' }), line({ orderNo: '5', sellToCustomerNo: 'C1', amountInclVAT: '81.00' })];
  const result = transform(orders, customers, { mode: 'pilot' });
  assert.equal(result.report.included.orders, 0);
  assert.equal(result.report.omitted.customers.length, 6);
  assert.equal(result.report.omitted.orders.length, 5);
});

test('pilot selection spans currencies and full mode requires approval', () => {
  const currencies = ['SEK', 'EUR', 'NOK', 'DKK'];
  const orders = Array.from({ length: 14 }, (_, i) => line({ orderNo: String(i + 1), sellToCustomerNo: `C${i + 1}`, currencyCode: currencies[i % 4], quantity: '1' }));
  const customers = orders.map((_, i) => customer(`C${i + 1}`, `c${i + 1}@example.test`)).concat(customer('C15', 'extra@example.test'));
  assert.throws(() => transform(orders, customers, { mode: 'full' }), /approve-full/);
  const result = transform(orders, customers);
  assert.equal(result.report.included.orders, 10);
  assert.equal(result.report.included.customers, 11);
  assert.deepEqual(Object.keys(result.report.totals).sort(), currencies.sort());
});

test('invalid amount is omitted while uneven unit prices split without changing totals', () => {
  const orders = [line({ orderNo: '1', amountInclVAT: '79.99' }), line({ orderNo: '2', quantity: '3' })];
  const result = transform(orders, [customer()]);
  assert.equal(result.report.included.orders, 1);
  assert.match(result.report.omitted.orders[0].reasons.join(' '), /equation/);
  assert.equal(result.report.priceSplitOrders, 1);
  const itemRows = result.orderRows.filter(row => row['Line: Type'] === 'Line Item');
  assert.deepEqual(itemRows.map(row => [row['Line: Quantity'], row['Line: Price']]), [[2, '33.33'], [1, '33.34']]);
  assert.equal(itemRows.reduce((sum, row) => sum + Number(row['Line: Discount']), 0), -20);
  assert.equal(itemRows.reduce((sum, row) => sum + Number(row['Line: Tax 1 Price']), 0), 16);
});

test('source 584.99 for three units preserves discount, VAT, and paid total', () => {
  const result = transform([line({ orderNo: '1', quantity: '3', unitPriceInclVAT: '584.99', amountInclVAT: '351.00', discount: '233.99', VAT: '67.94' })], [customer()]);
  const items = result.orderRows.filter(row => row['Line: Type'] === 'Line Item');
  assert.deepEqual(items.map(row => [row['Line: Quantity'], row['Line: Price']]), [[1, '194.99'], [2, '195.00']]);
  assert.equal(items.reduce((sum, row) => sum + Number(row['Line: Discount']), 0), -233.99);
  assert.equal(items.reduce((sum, row) => sum + Number(row['Line: Tax 1 Price']), 0), 67.94);
  assert.equal(result.report.totals.SEK.output, '351.00');
});

test('missing required CSV headers are rejected', () => {
  assert.throws(() => validateHeaders(ORDER_HEADERS.filter(h => h !== 'VAT'), ORDER_HEADERS, 'Orders'), /VAT/);
});

test('mixed customer completeness stays in one workbook below the batch limit', () => {
  const orders = [line({ orderNo: '1' }), line({ orderNo: '2', sellToCustomerNo: 'C2', itemID: 'SKU2' })];
  const customers = [customer(), { ...customer('C2', 'two@example.test'), name: '', addressLine1: '' }, customer('C3', 'only@example.test')];
  const result = transform(orders, customers);
  assert.equal(result.customerBatches.length, 1);
  const batch = result.customerBatches[0];
  assert.equal(batch.rows.length, 3);
  assert(batch.columns.includes('First Name'));
  assert(batch.columns.includes('Last Name'));
  assert(batch.columns.includes('Address Command'));
  assert.deepEqual(batch.rows.map(row => [row['First Name'], row['Last Name']]), [['Example', 'Person'], [undefined, undefined], ['Example', 'Person']]);
  assert.equal(result.report.included.customers, 3);
  assert.deepEqual(result.orderRows.filter(r => r['Line: Type'] === 'Line Item').map(r => r['Line: ID']), [1, 2]);
});

test('splits customer name after the first word and preserves remaining words', () => {
  const customers = [
    { ...customer('C1', 'one@example.test'), name: '  Anna   Maria von Berg  ' },
    { ...customer('C2', 'two@example.test'), name: 'Prince' },
    { ...customer('C3', 'three@example.test'), name: '' },
  ];
  const result = transform([], customers, { mode: 'full', approveFull: true });
  const rows = result.customerBatches.flatMap(batch => batch.rows);
  const byEmail = new Map(rows.map(row => [row.Email, row]));
  assert.deepEqual([byEmail.get('one@example.test')['First Name'], byEmail.get('one@example.test')['Last Name']], ['Anna', 'Maria von Berg']);
  assert.equal(byEmail.get('two@example.test')['First Name'], 'Prince');
  assert.equal(byEmail.get('two@example.test')['Last Name'], undefined);
  assert.equal(byEmail.get('three@example.test')['First Name'], undefined);
  assert.equal(byEmail.get('three@example.test')['Last Name'], undefined);
});

test('writer creates grouped customer workbooks and an Orders sheet with line IDs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fyrklovern-history-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ordersFile = path.join(dir, 'orders.csv'), customersFile = path.join(dir, 'customers.csv');
  const csv = (headers, records) => [headers.join(','), ...records.map(record => headers.map(key => record[key] ?? '').join(','))].join('\n');
  await fs.writeFile(ordersFile, csv(ORDER_HEADERS, [line(), line({ orderNo: '101', sellToCustomerNo: 'C2' })]));
  await fs.writeFile(customersFile, csv(CUSTOMER_HEADERS, [customer(), { ...customer('C2', 'two@example.test'), name: '', addressLine1: '' }]));
  const result = await main([`--orders=${ordersFile}`, `--customers=${customersFile}`, `--output-dir=${dir}`]);
  assert.equal(result.customerBatches.length, 1);
  for (const file of ['pilot-customers.xlsx', 'pilot-orders.xlsx']) {
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(path.join(dir, file));
    assert.equal(book.worksheets[0].name, file.includes('orders') ? 'Orders' : 'Customers');
  }
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(path.join(dir, 'pilot-orders.xlsx'));
  const sheet = book.worksheets[0];
  const headers = sheet.getRow(1).values.slice(1);
  const lineId = headers.indexOf('Line: ID') + 1;
  assert(lineId > 0);
  assert.deepEqual([sheet.getRow(2).getCell(lineId).value, sheet.getRow(5).getCell(lineId).value], [1, 2]);
});
