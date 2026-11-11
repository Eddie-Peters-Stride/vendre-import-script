#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const csv = require('csv-parser');
const ExcelJS = require('exceljs');
const { transform, validateHeaders, ORDER_HEADERS, CUSTOMER_HEADERS } = require('../../src/importers/fyrklovern/historical-matrixify');

async function readCsv(file, headers, label) {
  const content = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  const firstLine = content.split(/\r?\n/, 1)[0];
  const hasHeader = firstLine.split(',').map(part => part.replace(/^"|"$/g, '').replace(/^addressLine$/, 'addressLine1')).every((part, i) => part === headers[i]);
  if (label === 'Customers' && !hasHeader) throw new Error('Customers CSV must have headers');
  return new Promise((resolve, reject) => {
    const rows = [];
    let seenHeaders = !hasHeader;
    Readable.from([content]).pipe(csv(hasHeader ? { strict: true } : { headers, strict: true }))
      .on('headers', actual => { try { validateHeaders(actual.map(header => header === 'addressLine' ? 'addressLine1' : header), headers, label); seenHeaders = true; } catch (error) { reject(error); } })
      .on('data', row => { if (seenHeaders) { if (Object.hasOwn(row, 'addressLine')) { row.addressLine1 = row.addressLine; delete row.addressLine; } rows.push(row); } })
      .on('end', () => seenHeaders ? resolve(rows) : reject(new Error(`${label} CSV has no headers`)))
      .on('error', reject);
  });
}

async function writeWorkbook(file, sheetName, columns, rows) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(sheetName);
  sheet.addRow(columns);
  for (const row of rows) sheet.addRow(columns.map(column => row[column] ?? ''));
  await book.xlsx.writeFile(file);
}

function argumentsFrom(argv) {
  const args = {};
  const accepted = new Set(['orders', 'customers', 'mode', 'output-dir', 'customer-output', 'order-output', 'report-output', 'approve-full']);
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    if (!accepted.has(match[1])) throw new Error(`Unknown option: --${match[1]}`);
    if (match[1] === 'approve-full') {
      if (match[2] !== undefined) throw new Error('--approve-full takes no value');
      args.approveFull = true;
    }
    else if (match[2] !== undefined) args[match[1]] = match[2];
    else throw new Error(`Expected --${match[1]}=value`);
  }
  if (!args.orders || !args.customers) throw new Error('Provide --orders=path and --customers=path');
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = argumentsFrom(argv);
  const mode = args.mode || 'pilot';
  if (mode === 'full') throw new Error('Full Matrixify workbooks require reviewed duplicate decisions, customer-to-Shopify-ID mapping, and pilot approval; use the duplicates review workflow first');
  const outputDir = path.resolve(args['output-dir'] || 'outputs/fyrklovern-historical');
  const [orders, customers] = await Promise.all([readCsv(args.orders, ORDER_HEADERS, 'Orders'), readCsv(args.customers, CUSTOMER_HEADERS, 'Customers')]);
  const result = transform(orders, customers, { mode, approveFull: args.approveFull });
  const customerBase = path.resolve(args['customer-output'] || path.join(outputDir, `${mode}-customers.xlsx`));
  const customerFiles = result.customerBatches.map((_, i) => i === 0 ? customerBase : customerBase.replace(/\.xlsx$/i, `-${i + 1}.xlsx`));
  if (result.customerBatches.length > 1 && customerFiles.some(file => !file.toLowerCase().endsWith('.xlsx'))) throw new Error('Customer output must end in .xlsx when multiple workbooks are needed');
  const orderBase = path.resolve(args['order-output'] || path.join(outputDir, `${mode}-orders.xlsx`));
  const orderFiles = result.orderBatches.map((_, i) => i === 0 ? orderBase : orderBase.replace(/\.xlsx$/i, `-${i + 1}.xlsx`));
  if (result.orderBatches.length > 1 && orderFiles.some(file => !file.toLowerCase().endsWith('.xlsx'))) throw new Error('Order output must end in .xlsx when multiple workbooks are needed');
  const files = {
    customers: customerFiles,
    orders: orderFiles,
    report: path.resolve(args['report-output'] || path.join(outputDir, `${mode}-reconciliation.json`)),
  };
  const outputPaths = [...files.customers, ...files.orders, files.report];
  const allPaths = [path.resolve(args.orders), path.resolve(args.customers), ...outputPaths].map(p => p.toLowerCase());
  if (new Set(allPaths).size !== allPaths.length) throw new Error('Input and output paths must be distinct');
  for (const file of outputPaths) {
    if (await fs.stat(file).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error(`Output already exists: ${file}`);
  }
  await Promise.all(outputPaths.map(file => fs.mkdir(path.dirname(file), { recursive: true })));
  for (let i = 0; i < customerFiles.length; i++) await writeWorkbook(customerFiles[i], 'Customers', result.customerBatches[i].columns, result.customerBatches[i].rows);
  for (let i = 0; i < orderFiles.length; i++) await writeWorkbook(orderFiles[i], 'Orders', result.orderColumns, result.orderBatches[i]);
  await fs.writeFile(files.report, `${JSON.stringify(result.report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ files, included: result.report.included, omitted: { customers: result.report.omitted.customers.length, orders: result.report.omitted.orders.length } }, null, 2)}\n`);
  return result;
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main, readCsv };
