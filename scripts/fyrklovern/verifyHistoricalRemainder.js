#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');

async function sheetRows(file, expectedName, onRow) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(file);
  let found = false;
  for await (const sheet of workbook) {
    if (sheet.name !== expectedName) {
      const loaded = new ExcelJS.Workbook();
      await loaded.xlsx.readFile(file);
      if (loaded.worksheets.length !== 1 || loaded.worksheets[0].name !== expectedName) throw new Error(`${file}: expected ${expectedName} sheet, found ${sheet.name}`);
    }
    found = true;
    let headers;
    for await (const row of sheet) {
      if (!headers) { headers = row.values.slice(1).map(value => String(value ?? '')); continue; }
      onRow(Object.fromEntries(headers.map((header, index) => [header, row.getCell(index + 1).value])));
    }
  }
  if (!found) throw new Error(`${file}: no ${expectedName} sheet`);
}

async function main(directory = 'outputs/fyrklovern-historical/full-remainder') {
  const root = path.resolve(directory);
  const report = JSON.parse(await fs.readFile(path.join(root, 'full-remainder-reconciliation.json'), 'utf8'));
  const files = await fs.readdir(root);
  const customers = files.filter(name => /^full-remainder-customers-\d+\.xlsx$/.test(name)).sort();
  const orders = files.filter(name => /^full-remainder-orders-\d+\.xlsx$/.test(name)).sort();
  if (customers.length !== report.import.customerBatches.length || orders.length !== report.import.orderBatches.length) throw new Error('Workbook count differs from report');
  const emails = new Set(), orderNames = new Set();
  let customerCount = 0, orderCount = 0;
  for (let index = 0; index < customers.length; index++) {
    let count = 0;
    await sheetRows(path.join(root, customers[index]), 'Customers', row => {
      const email = String(row.Email ?? '').trim().toLowerCase();
      if (!email || emails.has(email)) throw new Error(`Missing or duplicate customer email: ${email}`);
      if (!row['Metafield: migration.fyrklovern_customer_number [single_line_text_field]']) throw new Error('Missing source customer number metafield');
      emails.add(email);
      count++;
    });
    if (count !== report.import.customerBatches[index] || count > 20000) throw new Error(`${customers[index]}: expected ${report.import.customerBatches[index]} customers, found ${count}`);
    customerCount += count;
  }
  for (let index = 0; index < orders.length; index++) {
    const perOrder = new Map();
    await sheetRows(path.join(root, orders[index]), 'Orders', row => {
      const name = String(row.Name ?? '');
      if (!name.startsWith('F-')) throw new Error(`Unexpected order name: ${name}`);
      const entry = perOrder.get(name) || { items: 0, fulfillment: 0, transactions: 0 };
      if (row['Line: Type'] === 'Line Item') entry.items++;
      if (row['Line: Type'] === 'Fulfillment Line') entry.fulfillment++;
      if (row['Line: Type'] === 'Transaction') entry.transactions++;
      perOrder.set(name, entry);
    });
    for (const [name, entry] of perOrder) {
      if (orderNames.has(name)) throw new Error(`Order split across workbooks: ${name}`);
      if (!entry.items || entry.fulfillment !== 1 || entry.transactions !== 1) throw new Error(`Incomplete order: ${name}`);
      orderNames.add(name);
    }
    if (perOrder.size !== report.import.orderBatches[index] || perOrder.size > 10000) throw new Error(`${orders[index]}: expected ${report.import.orderBatches[index]} orders, found ${perOrder.size}`);
    orderCount += perOrder.size;
  }
  if (customerCount !== report.import.customers || orderCount !== report.import.orders) throw new Error('Import totals differ from report');
  process.stdout.write(`${JSON.stringify({ customerFiles: customers.length, orderFiles: orders.length, customers: customerCount, orders: orderCount, completeOrders: true }, null, 2)}\n`);
}

if (require.main === module) main(process.argv[2]).catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
module.exports = { main };
