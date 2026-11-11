#!/usr/bin/env node
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const csv = require('csv-parser');
const ExcelJS = require('exceljs');
const { readCsv } = require('./buildHistoricalMatrixify');
const { transform, ORDER_HEADERS, CUSTOMER_HEADERS } = require('../../src/importers/fyrklovern/historical-matrixify');
const { reviewDuplicates } = require('../../src/importers/fyrklovern/historical-duplicates');

const value = input => String(input ?? '').trim();
const emailValid = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const SOURCE_NUMBER_HEADER = 'Norce Customer Number (customer.metafields.migration.fyrklovern_customer_number)';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg === '--overwrite') { args.overwrite = true; continue; }
    const match = /^--(orders|customers|shopify-customers|output-dir)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    args[match[1]] = match[2];
  }
  if (!args['shopify-customers']) throw new Error('Provide --shopify-customers=<Shopify customer export CSV>');
  return {
    orders: path.resolve(args.orders || 'exports/export_to_Shopify_orders.csv'),
    customers: path.resolve(args.customers || 'exports/export_to_Shopify_customers.csv'),
    shopifyCustomers: path.resolve(args['shopify-customers']),
    outputDir: path.resolve(args['output-dir'] || 'outputs/fyrklovern-historical/id-email-linked-2026-11-10'),
    overwrite: args.overwrite === true,
  };
}

async function readShopifyCustomerLinks(file) {
  const links = new Map();
  const emails = new Map();
  const conflicts = new Set();
  let rows = 0;
  let missingSourceNumber = 0;
  await new Promise((resolve, reject) => {
    createReadStream(file).pipe(csv({ mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim() }))
      .on('headers', headers => {
        if (!headers.includes('Customer ID')) return reject(new Error('Shopify customer export is missing Customer ID'));
        if (!headers.includes(SOURCE_NUMBER_HEADER)) return reject(new Error(`Shopify customer export is missing ${SOURCE_NUMBER_HEADER}`));
      })
      .on('data', row => {
        rows++;
        const sourceNumber = value(row[SOURCE_NUMBER_HEADER]);
        const customerId = value(row['Customer ID']);
        const email = value(row.Email).toLowerCase();
        if (sourceNumber && customerId) {
          if (links.has(sourceNumber) && links.get(sourceNumber).value !== customerId) conflicts.add(sourceNumber);
          else links.set(sourceNumber, { kind: 'customerId', value: customerId });
        } else if (!sourceNumber) missingSourceNumber++;
        if (email && customerId) {
          if (!emails.has(email)) emails.set(email, new Set());
          emails.get(email).add(customerId);
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });
  for (const sourceNumber of conflicts) links.delete(sourceNumber);
  return { links, emails, conflicts: [...conflicts], rows, missingSourceNumber };
}

async function writeSheet(file, sheetName, columns, rows) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: false, useSharedStrings: false });
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(columns).commit();
  for (const row of rows) sheet.addRow(columns.map(column => row[column] ?? '')).commit();
  sheet.commit();
  await workbook.commit();
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [orders, customers, shopify] = await Promise.all([
    readCsv(args.orders, ORDER_HEADERS, 'Orders'),
    readCsv(args.customers, CUSTOMER_HEADERS, 'Customers'),
    readShopifyCustomerLinks(args.shopifyCustomers),
  ]);
  const review = reviewDuplicates(orders, customers);
  const reviewCustomerNumbers = new Set(review.customers.map(row => value(row.number)));
  const reviewOrderNumbers = new Set(review.orders.map(row => value(row.orderNo)));
  const remainingCustomers = customers.filter(row => !reviewCustomerNumbers.has(value(row.number)));
  const remainingOrders = orders.filter(row => !reviewOrderNumbers.has(value(row.orderNo)));
  const customerLinksByNumber = new Map(shopify.links);
  const emailFallbackStatus = { matchedOne: 0, matchedMultiple: 0, notFound: 0, invalidOrMissing: 0 };
  for (const customer of remainingCustomers) {
    const number = value(customer.number);
    if (customerLinksByNumber.has(number)) continue;
    const email = value(customer.email).toLowerCase();
    if (!emailValid(email)) { emailFallbackStatus.invalidOrMissing++; continue; }
    const matches = shopify.emails.get(email);
    if (matches?.size === 1) {
      customerLinksByNumber.set(number, { kind: 'email', value: email });
      emailFallbackStatus.matchedOne++;
    } else if (matches?.size > 1) emailFallbackStatus.matchedMultiple++;
    else emailFallbackStatus.notFound++;
  }
  const result = transform(remainingOrders, remainingCustomers, {
    mode: 'full', approveFull: true, customerLinksByNumber,
  });

  const idLinkedNumbers = new Set([...customerLinksByNumber].filter(([, link]) => link.kind === 'customerId').map(([number]) => number));
  const emailFallbackNumbers = new Set([...customerLinksByNumber].filter(([, link]) => link.kind === 'email').map(([number]) => number));
  const includedCustomerNumbers = new Set([...idLinkedNumbers, ...emailFallbackNumbers]);

  const fulfillmentIds = new Set();
  for (const row of result.orderRows) {
    const hasId = Boolean(value(row['Customer: ID']));
    const hasEmail = Boolean(value(row['Customer: Email']));
    if (hasId === hasEmail) throw new Error(`Order ${row.Name} must have exactly one customer association`);
    if (row['Send Receipt'] !== 'FALSE') throw new Error(`Order ${row.Name} has receipts enabled`);
    if (['Line Item', 'Shipping Line'].includes(row['Line: Type']) && (!Number.isFinite(row['Line: Tax 1 Rate']) || row['Line: Tax 1 Rate'] < 0)) throw new Error(`Order ${row.Name} has a missing or invalid Line: Tax 1 Rate`);
    if (row['Line: Type'] === 'Fulfillment Line') {
      const fulfillmentId = row['Fulfillment: ID'];
      if (!Number.isSafeInteger(fulfillmentId) || fulfillmentIds.has(fulfillmentId)) throw new Error(`Order ${row.Name} has a nonnumeric or duplicate Fulfillment: ID`);
      fulfillmentIds.add(fulfillmentId);
      if (row['Fulfillment: Send Receipt'] !== 'FALSE') throw new Error(`Order ${row.Name} has fulfillment receipts enabled`);
    }
  }
  if (fulfillmentIds.size !== result.report.included.orders) throw new Error('Fulfillment ID count does not match included orders');

  const omittedOrders = new Map(result.report.omitted.orders.map(row => [row.sourceId, row.reasons.join('; ')]));
  const unmatchedRows = [];
  for (const row of review.orders) unmatchedRows.push({ 'Source Row': row['Source Row'], Reasons: row['Review Reasons'], ...orders[row['Source Row'] - 1] });
  for (let index = 0; index < orders.length; index++) {
    const row = orders[index], reason = omittedOrders.get(value(row.orderNo));
    if (reason) unmatchedRows.push({ 'Source Row': index + 1, Reasons: reason, ...row });
  }
  if (new Set(unmatchedRows.map(row => value(row.orderNo))).size !== reviewOrderNumbers.size + omittedOrders.size) throw new Error('Unmatched order rows do not reconcile');

  const outputOrders = new Set(result.orderRows.map(row => value(row.Name).replace(/^F-/, '')));
  const exceptionOrderNumbers = new Set([...reviewOrderNumbers, ...omittedOrders.keys()]);
  const allOrderNumbers = new Set(orders.map(row => value(row.orderNo)));
  if (outputOrders.size + exceptionOrderNumbers.size !== allOrderNumbers.size) {
    throw new Error(`Order counts do not reconcile: ${outputOrders.size} import-ready + ${exceptionOrderNumbers.size} unmatched != ${allOrderNumbers.size} source`);
  }

  await fs.mkdir(args.outputDir, { recursive: true });
  const files = {
    orders: result.orderBatches.map((_, index) => path.join(args.outputDir, `orders-${String(index + 1).padStart(2, '0')}.xlsx`)),
    unmatchedOrders: path.join(args.outputDir, 'unmatched-orders.xlsx'),
    report: path.join(args.outputDir, 'reconciliation.json'),
  };
  const outputPaths = [...files.orders, files.unmatchedOrders, files.report];
  for (const file of outputPaths) {
    if (!args.overwrite && await fs.stat(file).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) throw new Error(`Output already exists: ${file}`);
  }
  for (let index = 0; index < files.orders.length; index++) await writeSheet(files.orders[index], 'Orders', result.orderColumns, result.orderBatches[index]);
  await writeSheet(files.unmatchedOrders, 'Orders', ['Source Row', 'Reasons', ...ORDER_HEADERS], unmatchedRows);

  const report = {
    source: { customers: customers.length, orders: allOrderNumbers.size, orderRows: orders.length },
    associations: {
      customerId: idLinkedNumbers.size,
      emailFallback: emailFallbackNumbers.size,
      emailFallbackExportStatus: emailFallbackStatus,
      unmatchedCustomerNumbers: remainingCustomers.length - includedCustomerNumbers.size,
      conflictingSourceNumberMappings: shopify.conflicts.length,
    },
    heldForDuplicateReview: { customers: review.customers.length, orders: reviewOrderNumbers.size, orderRows: review.orders.length, reasons: review.summary.signals },
    unmatched: { orders: exceptionOrderNumbers.size, orderRows: unmatchedRows.length },
    import: { orders: outputOrders.size, orderBatches: result.report.batches.orders, customerAssociationRows: result.report.customerAssociations, priceSplitOrders: result.report.priceSplitOrders, totals: result.report.totals },
    checks: { orderCountReconciles: true, orderAndFulfillmentReceiptsFalse: true, fulfillmentIdsNumericAndUnique: true, lineTaxRatesPresent: true, maxOrdersPerFile: 10000 },
    warnings: [
      'Email fallback is used only when exactly one existing Shopify customer with that email appears in the supplied export; unmatched emails are left out of import files.',
      ...result.report.warnings,
    ],
  };
  await fs.writeFile(files.report, `${JSON.stringify(report, null, 2)}\n`, { flag: args.overwrite ? 'w' : 'wx' });
  process.stdout.write(`${JSON.stringify({ files, source: report.source, associations: report.associations, heldForDuplicateReview: report.heldForDuplicateReview, unmatched: report.unmatched, import: { orders: report.import.orders, batches: report.import.orderBatches, customerAssociationRows: report.import.customerAssociationRows } }, null, 2)}\n`);
  return { files, report };
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
module.exports = { main, readShopifyCustomerLinks };
