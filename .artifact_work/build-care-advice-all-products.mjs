import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const root = process.cwd();
const products = JSON.parse(await fs.readFile(path.join(root, '.artifact_work/care-advice-all-products.json'), 'utf8'));
const scan = JSON.parse(await fs.readFile(path.join(root, '.artifact_work/care-advice-live-scan.json'), 'utf8'));
const locales = ['no', 'da', 'fi', 'de', 'en', 'nl'];
const channels = { no: 'NO', da: 'DK', fi: 'FI', de: 'DE', en: 'EU', nl: 'NL' };
const samples = Object.fromEntries(scan.records.slice(0, 3).map((record, index) => [`CA${index + 1}`, record]));
const ca3English = 'Care instructions: Machine wash at 40 degrees. Tumble drying is not recommended. Iron on high heat when the fabric is slightly damp.';
const ca3Dutch = 'Wasinstructie: Wassen in de wasmachine op 40 graden. Drogen in de wasdroger wordt niet aanbevolen. Strijken op hoge temperatuur als de stof nog een beetje vochtig is.';

function translated(group, locale) {
  if (group === 'CA3' && locale === 'en') return ca3English;
  if (group === 'CA3' && locale === 'nl') return ca3Dutch;
  const record = samples[group];
  const value = record?.locales?.[channels[locale]]?.careFields?.[0]?.value;
  if (!value || value.trim() === record.locales.SE.careFields[0].value.trim()) {
    throw new Error(`Missing localized care advice for ${group}/${locale}`);
  }
  if (locale === 'de' && value !== record.locales.AT.careFields[0]?.value) {
    throw new Error(`DE/AT mismatch for ${group}`);
  }
  return value;
}

const eligible = products.rows.filter(row => row.group).sort((a, b) => a.group.localeCompare(b.group) || a.handle.localeCompare(b.handle));
if (eligible.length !== 44 || products.rows.length !== 58) throw new Error('Product coverage changed; review the source export.');
const headers = ['Entity', 'Entity ID', 'Entity Handle', 'Field', 'Original Value', ...locales.map(locale => `Translation Value: ${locale}`)];
const rows = eligible.map(row => {
  if (!/^\d{14}$/.test(row.id) || row.swedish !== samples[row.group].locales.SE.careFields[0].value) {
    throw new Error(`Invalid identity or source value: ${row.handle}`);
  }
  return ['Product', row.id, row.handle, 'Metafield: custom.care_advice', row.swedish, ...locales.map(locale => translated(row.group, locale))];
});
if (rows.some(row => row.some(value => value === '' || value == null))) throw new Error('Blank import cell found.');

const workbook = Workbook.create();
const sheet = workbook.worksheets.add('Translations');
sheet.showGridLines = false;
sheet.getRangeByIndexes(0, 0, rows.length + 1, headers.length).values = [headers, ...rows];
sheet.getRangeByIndexes(0, 0, 1, headers.length).format.font.bold = true;
sheet.getRangeByIndexes(0, 0, 1, headers.length).format.fill = '#DCE8F3';
sheet.getRange('A:A').format.columnWidth = 13;
sheet.getRange('B:B').format.columnWidth = 20;
sheet.getRange('C:C').format.columnWidth = 60;
sheet.getRange('D:D').format.columnWidth = 38;
sheet.getRange('E:E').format.columnWidth = 60;
sheet.getRange('F:K').format.columnWidth = 60;
sheet.getRangeByIndexes(1, 0, rows.length, headers.length).format.wrapText = true;
sheet.getRangeByIndexes(1, 0, rows.length, headers.length).format.rowHeight = 72;
sheet.freezePanes.freezeRows(1);
workbook.recalculate();

const check = await workbook.inspect({ kind: 'table', range: 'Translations!A1:K4', tableMaxRows: 4, tableMaxCols: 11, maxChars: 1500 });
console.log(check.ndjson);
const outputDir = path.join(root, 'outputs/Fyrklovern/Matrixify files/Products/Care advice translations');
await fs.mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, 'Care advice translations - all matching products.xlsx');
const blob = await SpreadsheetFile.exportXlsx(workbook);
await blob.save(output);
const preview = await workbook.render({ sheetName: 'Translations', range: 'A1:K4', scale: 1, format: 'png' });
await fs.writeFile(path.join(root, '.artifact_work/care-advice-all-products-preview.png'), new Uint8Array(await preview.arrayBuffer()));
console.log(JSON.stringify({ output, products: rows.length, translationValues: rows.length * locales.length, excluded: products.rows.length - rows.length }));
