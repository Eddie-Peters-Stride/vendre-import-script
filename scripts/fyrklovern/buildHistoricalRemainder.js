#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { readCsv } = require('./buildHistoricalMatrixify');
const { transform, ORDER_HEADERS, CUSTOMER_HEADERS } = require('../../src/importers/fyrklovern/historical-matrixify');
const { reviewDuplicates } = require('../../src/importers/fyrklovern/historical-duplicates');

const value = input => String(input ?? '').trim();
const exists = file => fs.stat(file).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));

async function writeSheet(file, sheetName, columns, rows) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: false, useSharedStrings: false });
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(columns).commit();
  for (const row of rows) sheet.addRow(columns.map(column => row[column] ?? '')).commit();
  sheet.commit();
  await workbook.commit();
}

async function writeExceptions(file, customerRows, orderRows) {
  const workbook = new ExcelJS.Workbook();
  for (const [name, columns, rows] of [
    ['Customers', ['Source Row', 'Reasons', ...CUSTOMER_HEADERS], customerRows],
    ['Orders', ['Source Row', 'Reasons', ...ORDER_HEADERS], orderRows],
  ]) {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(columns);
    for (const row of rows) sheet.addRow(columns.map(column => row[column] ?? '') );
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  await workbook.xlsx.writeFile(file);
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = /^--(orders|customers|output-dir)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    args[match[1]] = match[2];
  }
  return {
    orders: path.resolve(args.orders || 'exports/export_to_Shopify_orders.csv'),
    customers: path.resolve(args.customers || 'exports/export_to_Shopify_customers.csv'),
    outputDir: path.resolve(args['output-dir'] || 'outputs/fyrklovern-historical/full-remainder'),
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [orders, customers] = await Promise.all([
    readCsv(args.orders, ORDER_HEADERS, 'Orders'),
    readCsv(args.customers, CUSTOMER_HEADERS, 'Customers'),
  ]);
  const review = reviewDuplicates(orders, customers);
  const reviewCustomerNumbers = new Set(review.customers.map(row => value(row.number)));
  const reviewOrderNumbers = new Set(review.orders.map(row => value(row.orderNo)));
  const remainingCustomers = customers.filter(row => !reviewCustomerNumbers.has(value(row.number)));
  const remainingOrders = orders.filter(row => !reviewOrderNumbers.has(value(row.orderNo)));
  const result = transform(remainingOrders, remainingCustomers, { mode: 'full', approveFull: true });

  const sourceOrderNumbers = new Set(orders.map(row => value(row.orderNo)));
  const remainingOrderNumbers = new Set(remainingOrders.map(row => value(row.orderNo)));
  if (result.report.included.customers + result.report.omitted.customers.length + reviewCustomerNumbers.size !== customers.length) throw new Error('Customer counts do not reconcile');
  if (result.report.included.orders + result.report.omitted.orders.length + reviewOrderNumbers.size !== sourceOrderNumbers.size) throw new Error('Order counts do not reconcile');
  if (result.customerBatches.some(batch => batch.rows.length > 20000) || result.report.batches.orders.some(count => count > 10000)) throw new Error('Batch size exceeds limit');
  if ([...remainingOrderNumbers].some(number => reviewOrderNumbers.has(number))) throw new Error('Review order leaked into the import');

  const omittedCustomers = new Map(result.report.omitted.customers.map(row => [row.sourceId, row.reasons.join('; ')]));
  const omittedOrders = new Map(result.report.omitted.orders.map(row => [row.sourceId, row.reasons.join('; ')]));
  const exceptionCustomers = remainingCustomers.flatMap((row, index) => omittedCustomers.has(value(row.number)) ? [{ 'Source Row': customers.indexOf(row) + 2, Reasons: omittedCustomers.get(value(row.number)), ...row }] : []);
  const exceptionOrders = orders.flatMap((row, index) => omittedOrders.has(value(row.orderNo)) ? [{ 'Source Row': index + 1, Reasons: omittedOrders.get(value(row.orderNo)), ...row }] : []);
  if (exceptionCustomers.length !== result.report.omitted.customers.length) throw new Error('Customer exceptions do not reconcile');
  if (new Set(exceptionOrders.map(row => value(row.orderNo))).size !== result.report.omitted.orders.length) throw new Error('Order exceptions do not reconcile');

  const files = {
    customers: result.customerBatches.map((_, index) => path.join(args.outputDir, `full-remainder-customers-${String(index + 1).padStart(2, '0')}.xlsx`)),
    orders: result.orderBatches.map((_, index) => path.join(args.outputDir, `full-remainder-orders-${String(index + 1).padStart(2, '0')}.xlsx`)),
    exceptions: path.join(args.outputDir, 'source-exceptions.xlsx'),
    report: path.join(args.outputDir, 'full-remainder-reconciliation.json'),
  };
  const outputPaths = [...files.customers, ...files.orders, files.exceptions, files.report];
  if (outputPaths.some(file => [args.orders, args.customers].includes(file))) throw new Error('Input and output paths must differ');
  for (const file of outputPaths) if (await exists(file)) throw new Error(`Output already exists: ${file}`);
  await fs.mkdir(args.outputDir, { recursive: true });

  for (let index = 0; index < files.customers.length; index++) await writeSheet(files.customers[index], 'Customers', result.customerBatches[index].columns, result.customerBatches[index].rows);
  for (let index = 0; index < files.orders.length; index++) await writeSheet(files.orders[index], 'Orders', result.orderColumns, result.orderBatches[index]);
  await writeExceptions(files.exceptions, exceptionCustomers, exceptionOrders);
  const report = {
    source: { customers: customers.length, orders: sourceOrderNumbers.size, orderRows: orders.length },
    heldForDuplicateReview: { customers: reviewCustomerNumbers.size, orders: reviewOrderNumbers.size, orderRows: review.orders.length },
    sourceExceptions: { customers: exceptionCustomers.length, orders: omittedOrders.size, orderRows: exceptionOrders.length, customerIds: [...omittedCustomers.keys()], orderIds: [...omittedOrders.keys()] },
    import: { customers: result.report.included.customers, orders: result.report.included.orders, customerBatches: result.report.batches.customers, orderBatches: result.report.batches.orders, priceSplitOrders: result.report.priceSplitOrders, totals: result.report.totals },
    checks: { customerCountReconciles: true, orderCountReconciles: true, maxCustomersPerFile: 20000, maxOrdersPerFile: 10000 },
    warnings: result.report.warnings,
  };
  await fs.writeFile(files.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ files, counts: { source: report.source, duplicateReview: report.heldForDuplicateReview, exceptions: { customers: report.sourceExceptions.customers, orders: report.sourceExceptions.orders }, import: { customers: report.import.customers, orders: report.import.orders } } }, null, 2)}\n`);
  return { files, report };
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
module.exports = { main };
