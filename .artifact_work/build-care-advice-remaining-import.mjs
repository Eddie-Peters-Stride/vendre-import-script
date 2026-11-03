import fs from 'node:fs/promises';
import path from 'node:path';
import xlsx from 'xlsx';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const root = process.cwd();
const sourcePath = 'C:/Users/Eddie Peters/Desktop/Fyrklövern/Care advice translation review - all 10 texts.xlsx';
const mapPath = path.join(root, '.artifact_work/care-advice-all-products.json');
const outputPath = path.join(root, 'outputs/Fyrklovern/Matrixify files/Products/Care advice translations/Care advice translations - remaining CA1-CA3 - Matrixify import.xlsx');
const locales = ['no', 'da', 'fi', 'de', 'en', 'nl'];

const sourceBook = xlsx.readFile(sourcePath);
const review = xlsx.utils.sheet_to_json(sourceBook.Sheets['Care advice review'], { defval: '' });
const products = JSON.parse(await fs.readFile(mapPath, 'utf8')).rows;
const completedElsewhere = review.filter(row => !['CA1', 'CA2', 'CA3'].includes(row.CA));
if (review.length !== 10 || completedElsewhere.length !== 7) throw new Error('Unexpected care advice source groups.');

const headers = ['Entity', 'Entity ID', 'Entity Handle', 'Field', 'Original Value', ...locales.map(locale => `Translation Value: ${locale}`)];
const rows = [];
for (const group of ['CA1', 'CA2', 'CA3']) {
  const source = review.find(row => row.CA === group);
  if (!source) throw new Error(`Missing ${group} in source workbook.`);
  const matches = products.filter(product => product.swedish === source['Swedish care advice']);
  if (matches.length !== Number(source.Products)) throw new Error(`${group}: product count differs from source workbook.`);
  for (const locale of locales) if (!String(source[locale.toUpperCase()] || '').trim()) throw new Error(`${group}: ${locale} translation is blank.`);
  for (const product of matches) {
    if (!/^\d{14}$/.test(String(product.id)) || !product.handle) throw new Error(`${group}: invalid product identity.`);
    rows.push(['Product', String(product.id), product.handle, 'Metafield: custom.care_advice', source['Swedish care advice'], ...locales.map(locale => source[locale.toUpperCase()])]);
  }
}
rows.sort((a, b) => a[2].localeCompare(b[2]));
if (rows.length !== 44 || new Set(rows.map(row => row[1])).size !== rows.length) throw new Error('Duplicate or missing products.');

const workbook = Workbook.create();
const sheet = workbook.worksheets.add('Translations');
sheet.showGridLines = false;
sheet.getRangeByIndexes(0, 0, rows.length + 1, headers.length).values = [headers, ...rows];
sheet.getRange('A1:K1').format.fill = '#DCE8F3';
sheet.getRange('A1:K1').format.font.bold = true;
sheet.getRange('A:A').format.columnWidth = 13;
sheet.getRange('B:B').format.columnWidth = 20;
sheet.getRange('B:B').setNumberFormat('@');
sheet.getRange('C:C').format.columnWidth = 60;
sheet.getRange('D:D').format.columnWidth = 38;
sheet.getRange('E:K').format.columnWidth = 60;
sheet.getRangeByIndexes(1, 0, rows.length, headers.length).format.wrapText = true;
sheet.getRangeByIndexes(1, 0, rows.length, headers.length).format.rowHeight = 72;
sheet.freezePanes.freezeRows(1);
workbook.recalculate();

const check = await workbook.inspect({ kind: 'table', range: 'Translations!A1:K4', tableMaxRows: 4, tableMaxCols: 11, maxChars: 2000 });
console.log(check.ndjson);
const preview = await workbook.render({ sheetName: 'Translations', range: 'A1:K4', scale: 1, format: 'png' });
await fs.writeFile(path.join(root, '.artifact_work/care-advice-remaining-import-preview.png'), new Uint8Array(await preview.arrayBuffer()));
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, products: rows.length, translations: rows.length * locales.length, groups: ['CA1', 'CA2', 'CA3'] }));
