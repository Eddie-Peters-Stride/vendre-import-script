#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { readCsv } = require('./buildHistoricalMatrixify');
const { ORDER_HEADERS, CUSTOMER_HEADERS } = require('../../src/importers/fyrklovern/historical-matrixify');
const { reviewDuplicates } = require('../../src/importers/fyrklovern/historical-duplicates');

async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (const arg of argv) {
    const match = /^--(orders|customers|output-dir)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    options[match[1]] = match[2];
  }
  const ordersFile = path.resolve(options.orders || 'exports/export_to_Shopify_orders.csv');
  const customersFile = path.resolve(options.customers || 'exports/export_to_Shopify_customers.csv');
  const outputDir = path.resolve(options['output-dir'] || 'outputs/fyrklovern-historical');
  const files = {
    review: path.join(outputDir, 'duplicates-review.xlsx'),
    decisions: path.join(outputDir, 'duplicates-decisions.csv'),
    summary: path.join(outputDir, 'duplicates-summary.json'),
  };
  for (const file of Object.values(files)) {
    if (await fs.stat(file).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
      throw new Error(`Output already exists: ${file}`);
    }
  }
  const [orders, customers] = await Promise.all([
    readCsv(ordersFile, ORDER_HEADERS, 'Orders'),
    readCsv(customersFile, CUSTOMER_HEADERS, 'Customers'),
  ]);
  const result = reviewDuplicates(orders, customers);
  const book = new ExcelJS.Workbook();
  const sheets = [
    ['Customers', ['Source Row', 'Review Groups', 'Review Reasons', ...CUSTOMER_HEADERS], result.customers],
    ['Orders', ['Source Row', 'Review Groups', 'Review Reasons', ...ORDER_HEADERS], result.orders],
  ];
  for (const [name, columns, rows] of sheets) {
    const sheet = book.addWorksheet(name);
    sheet.addRow(columns);
    for (const row of rows) sheet.addRow(columns.map(column => row[column] ?? ''));
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: `${sheet.getColumn(columns.length).letter}1` };
  }
  const decisionColumns = ['Entity', 'Source ID', 'Review Groups', 'Reasons', 'Decision', 'Canonical Source Number', 'Shopify Customer ID', 'Approved Repeated Line Count', 'Notes'];
  const csvCell = input => `"${String(input ?? '').replace(/"/g, '""')}"`;
  const csv = [decisionColumns, ...result.decisions.map(row => decisionColumns.map(column => row[column] ?? ''))].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  await fs.mkdir(outputDir, { recursive: true });
  await book.xlsx.writeFile(files.review);
  await fs.writeFile(files.decisions, csv, { flag: 'wx' });
  await fs.writeFile(files.summary, `${JSON.stringify(result.summary, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ files, summary: result.summary }, null, 2)}\n`);
  return result;
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
