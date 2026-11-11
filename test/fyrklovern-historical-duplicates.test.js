const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { reviewDuplicates } = require('../src/importers/fyrklovern/historical-duplicates');
const { readCsv, main: buildMatrixify } = require('../scripts/fyrklovern/buildHistoricalMatrixify');
const { ORDER_HEADERS, CUSTOMER_HEADERS, transform } = require('../src/importers/fyrklovern/historical-matrixify');

const customer = (number, email, phoneNumber) => ({ number, name: `Person ${number}`, email, country: 'SE', addressLine1: 'Street', city: 'Stockholm', postalCode: '11111', phoneNumber });
const order = (orderNo, sellToCustomerNo) => ({ orderNo, orderDate: '2024-01-16', sellToCountry: 'SE', sellToCustomerNo, itemID: 'SKU', itemName: 'Plate', quantity: '1', unitPriceInclVAT: '10.00', amountInclVAT: '10.00', discount: '0.00', VAT: '2.00', currencyCode: 'SEK' });

test('review includes whole histories for shared contacts and repeated order rows', () => {
  const customers = [customer('C1', 'same@example.test', '070-123'), customer('C2', 'same@example.test', '070-456'), customer('C3', 'other@example.test', '070 456'), customer('C4', '', '070-999'), customer('C5', 'solo@example.test', '070-888')];
  const orders = [order('1', 'C1'), order('2', 'C1'), order('3', 'C3'), order('4', 'C4'), order('5', 'C5'), order('5', 'C5'), order('6', 'C5')];
  const result = reviewDuplicates(orders, customers);
  assert.deepEqual(result.summary.signals, { sharedEmailCustomers: 2, sharedPhoneCustomers: 2, missingEmailCustomers: 1, ordersWithIdenticalRows: 1 });
  assert.equal(result.summary.review.customers, 5);
  assert.equal(result.summary.review.orders, 6);
  assert.equal(result.summary.review.orderRows, 7);
  assert.equal(result.orders.filter(row => row.orderNo === '5').length, 2);
  assert.equal(result.decisions.filter(row => row.Entity === 'Order').length, 1);
  assert.equal(result.customers.find(row => row.number === 'C5')['Review Reasons'], 'linked order review');
  assert.equal(result.customers.find(row => row.number === 'C1')['Review Groups'], result.customers.find(row => row.number === 'C2')['Review Groups'].split('; ')[0]);
  assert(result.orders.find(row => row.orderNo === '5')['Review Groups'].includes('O5'));
  assert(result.orders.find(row => row.orderNo === '6')['Review Groups'].includes('O5'));
  assert(result.decisions.find(row => row['Source ID'] === 'C4')['Review Groups'].startsWith('M'));
});

test('headerless orders and customer address alias are parsed; full output is gated', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fyrklovern-history-input-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const orderFile = path.join(directory, 'orders.csv');
  const customerFile = path.join(directory, 'customers.csv');
  const sourceOrder = order('1', 'C1');
  await fs.writeFile(orderFile, `${ORDER_HEADERS.map(header => sourceOrder[header]).join(',')}\n`);
  await fs.writeFile(customerFile, `number,name,email,country,addressLine,city,postalCode,phoneNumber\nC1,Person,one@example.test,SE,Street,Stockholm,11111,\n`);
  const orderRows = await readCsv(orderFile, ORDER_HEADERS, 'Orders');
  const customerRows = await readCsv(customerFile, CUSTOMER_HEADERS, 'Customers');
  assert.equal(orderRows.length, 1);
  assert.equal(customerRows[0].addressLine1, 'Street');
  await assert.rejects(buildMatrixify([`--orders=${orderFile}`, `--customers=${customerFile}`, '--mode=full', '--approve-full']), /reviewed duplicate decisions/);
});

test('batch limits count customers and complete orders, not line rows', () => {
  const customers = Array.from({ length: 20001 }, (_, i) => customer(`C${i + 1}`, `person${i + 1}@example.test`, ''));
  const orders = Array.from({ length: 10001 }, (_, i) => order(String(i + 1), `C${i + 1}`));
  orders.push(order('10001', 'C10001'));
  const result = transform(orders, customers, { mode: 'full', approveFull: true });
  assert.deepEqual(result.report.batches.customers, [20000, 1]);
  assert.deepEqual(result.report.batches.orders, [10000, 1]);
  assert.equal(result.orderBatches[1].filter(row => row.Name === 'F-10001').length, 4);
});
