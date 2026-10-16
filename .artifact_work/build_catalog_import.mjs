import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const root = 'C:/Users/Eddie Peters/Desktop/Dragons Lair/import_script';
const visibilityPath = 'C:/Users/Eddie Peters/Desktop/Fyrklövern/fyrklovern_hidden_visible_products.xlsx';
const productsPath = `${root}/exports/Export_2026-09-29_101146 (1).xlsx`;
const outputPath = `${root}/outputs/fyrklovern_market_catalog_inclusion.xlsx`;
const catalogs = [
  ['Standard', 'Sweden'], ['DK', 'Denmark'], ['NO', 'Norway'], ['EU', 'EU'],
  ['DE', 'Germany'], ['NL', 'Netherlands'], ['AT', 'Austria'], ['FI', 'Finland'],
];

const readSheet = async (path, sheetName) => {
  const wb = await SpreadsheetFile.importXlsx(await FileBlob.load(path));
  const sheet = wb.worksheets.getItem(sheetName);
  return { wb, sheet, values: sheet.getUsedRange().values };
};

const visibility = await readSheet(visibilityPath, 'Sheet1');
const exportData = await readSheet(productsPath, 'Products');
const old = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
const productsSheet = old.worksheets.getItem('Products');
const oldPreview = await old.render({ sheetName: 'Products', range: 'A1:F12', scale: 1, format: 'png' });
await fs.writeFile(`${root}/.artifact_work/existing_catalog_preview.png`, new Uint8Array(await oldPreview.arrayBuffer()));

const headerIndex = (row, name) => {
  const i = row.indexOf(name);
  if (i < 0) throw new Error(`Missing column: ${name}`);
  return i;
};
const visHeader = visibility.values[0];
const viSku = headerIndex(visHeader, 'ArticleNumber');
const viList = headerIndex(visHeader, 'ListName');
const viHide = headerIndex(visHeader, 'HideProduct');
const flags = new Map();
for (const row of visibility.values.slice(1)) {
  const sku = String(row[viSku] ?? '').trim();
  if (!sku) continue;
  const list = String(row[viList] ?? '').trim();
  if (!flags.has(sku)) flags.set(sku, new Map());
  const byList = flags.get(sku);
  if (byList.has(list)) throw new Error(`Duplicate visibility flag for ${sku}/${list}`);
  byList.set(list, row[viHide] === true || String(row[viHide]).toLowerCase() === 'true');
}

const expHeader = exportData.values[0];
const eiId = headerIndex(expHeader, 'ID');
const eiHandle = headerIndex(expHeader, 'Handle');
const eiSku = headerIndex(expHeader, 'Variant SKU');
const matched = new Map();
const unmatchedExportSkus = new Set();
for (const row of exportData.values.slice(1)) {
  const sku = String(row[eiSku] ?? '').trim();
  if (!sku) continue;
  if (!flags.has(sku)) continue;
  if (matched.has(sku)) throw new Error(`Duplicate Shopify SKU in export: ${sku}`);
  matched.set(sku, { id: String(row[eiId] ?? '').trim(), handle: String(row[eiHandle] ?? '').trim(), sku });
}
const unmatched = [...flags.keys()].filter(sku => !matched.has(sku));
const expectedCatalogCounts = {
  Sweden: [919, 54], Denmark: [919, 54], Norway: [919, 54], EU: [503, 470],
  Germany: [781, 192], Netherlands: [667, 306], Austria: [884, 89], Finland: [919, 54],
};
if (matched.size !== 973 || unmatched.length !== 361) throw new Error(`Coverage mismatch: ${matched.size} matched, ${unmatched.length} unmatched`);

const headers = ['ID', 'Handle', 'Variant SKU', ...catalogs.map(([, name]) => `Included / ${name}`)];
const rows = [];
const counts = Object.fromEntries(catalogs.map(([, name]) => [name, [0, 0]]));
for (const item of matched.values()) {
  const byList = flags.get(item.sku);
  const values = catalogs.map(([list, name]) => {
    if (!byList.has(list)) throw new Error(`Missing ${list} flag for ${item.sku}`);
    const included = !byList.get(list);
    counts[name][included ? 0 : 1]++;
    return included;
  });
  rows.push([item.id, item.handle, item.sku, ...values]);
}
for (const [name, expected] of Object.entries(expectedCatalogCounts)) {
  const actual = counts[name];
  if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
    throw new Error(`${name} count mismatch: ${actual.join('/')} vs ${expected.join('/')}`);
  }
}
const handles = rows.map(r => r[1]);
const skus = rows.map(r => r[2]);
if (new Set(handles).size !== rows.length || new Set(skus).size !== rows.length) throw new Error('Duplicate handles or SKUs in output');

// Preserve the existing Products sheet and its basic import styling/filter while rebuilding its requested data.
productsSheet.getRange('A1:J2000').clear({ applyTo: 'contents' });
productsSheet.getRangeByIndexes(0, 0, rows.length + 1, headers.length).values = [headers, ...rows];
productsSheet.getRange(`A1:K${rows.length + 1}`).format.font = { name: 'Arial', size: 10, color: '#222222' };
productsSheet.getRange('A1:K1').format = {
  fill: '#1F4E78',
  font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center',
  verticalAlignment: 'center',
  wrapText: false,
};
productsSheet.getRange(`D2:K${rows.length + 1}`).format.horizontalAlignment = 'center';
productsSheet.getRange(`A2:A${rows.length + 1}`).format.numberFormat = '@';
productsSheet.getRange(`C2:C${rows.length + 1}`).format.numberFormat = '@';
productsSheet.getRange('A:A').format.columnWidth = 17;
productsSheet.getRange('B:B').format.columnWidth = 49;
productsSheet.getRange('C:C').format.columnWidth = 18;
productsSheet.getRange('D:K').format.columnWidth = 22;
productsSheet.getRange('A1:K1').format.rowHeight = 28;
productsSheet.showGridLines = false;
productsSheet.freezePanes.freezeRows(1);
old.recalculate();

const check = await old.inspect({ kind: 'table', sheetId: 'Products', range: 'A1:K8', include: 'values', tableMaxRows: 8, tableMaxCols: 11, maxChars: 4000 });
console.log('SAMPLE\n' + check.ndjson);
console.log('RECONCILIATION ' + JSON.stringify({ matched: rows.length, unmatched: unmatched.length, counts, uniqueHandles: new Set(handles).size, uniqueSkus: new Set(skus).size }));
const preview = await old.render({ sheetName: 'Products', range: 'A1:K14', scale: 1, format: 'png' });
await fs.writeFile(`${root}/.artifact_work/final_catalog_preview.png`, new Uint8Array(await preview.arrayBuffer()));
const out = await SpreadsheetFile.exportXlsx(old);
await out.save(outputPath);
console.log(`EXPORTED ${outputPath}`);
