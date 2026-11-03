import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const root = process.cwd();
const scan = JSON.parse(await fs.readFile(path.join(root, '.artifact_work/care-advice-live-scan.json'), 'utf8'));
const products = JSON.parse(await fs.readFile(path.join(root, '.artifact_work/care-advice-all-products.json'), 'utf8'));
const locales = ['no', 'da', 'fi', 'de', 'en', 'nl'];
const channels = { no: 'NO', da: 'DK', fi: 'FI', de: 'DE', en: 'EU', nl: 'NL' };
const ca3English = 'Care instructions: Machine wash at 40 degrees. Tumble drying is not recommended. Iron on high heat when the fabric is slightly damp.';
const ca3Dutch = 'Wasinstructie: Wassen in de wasmachine op 40 graden. Drogen in de wasdroger wordt niet aanbevolen. Strijken op hoge temperatuur als de stof nog een beetje vochtig is.';

const headers = ['CA', 'Swedish care advice', 'Products', 'Example article number (SKU)', 'Status', ...locales.map(locale => locale.toUpperCase())];
const rows = scan.records.map((record, index) => {
  const ca = `CA${index + 1}`;
  const swedish = record.locales.SE.careFields[0]?.value;
  const matches = products.rows.filter(product => product.swedish === swedish);
  if (!matches.length || !matches.some(product => product.handle === record.handle)) throw new Error(`No Shopify matches for ${ca}`);
  const values = locales.map(locale => {
    if (ca === 'CA3' && locale === 'en') return ca3English;
    if (ca === 'CA3' && locale === 'nl') return ca3Dutch;
    const source = record.locales[channels[locale]]?.careFields?.[0]?.value;
    return source && source.trim() !== swedish.trim() ? source : '';
  });
  if (index < 3 && values.some(value => !value)) throw new Error(`Incomplete verified translations for ${ca}`);
  if (index >= 3 && values.some(value => value)) throw new Error(`Unexpected localized value for ${ca}`);
  return [ca, swedish, matches.length, String(record.article), index < 3 ? 'Norce translations available' : 'Translations needed', ...values];
});
if (rows.length !== 10 || rows.reduce((sum, row) => sum + row[2], 0) !== 58) throw new Error('Care advice coverage mismatch.');

const workbook = Workbook.create();
const sheet = workbook.worksheets.add('Care advice review');
sheet.showGridLines = false;
sheet.getRangeByIndexes(0, 0, rows.length + 1, headers.length).values = [headers, ...rows];
sheet.getRangeByIndexes(0, 0, 1, headers.length).format.font.bold = true;
sheet.getRangeByIndexes(0, 0, 1, headers.length).format.fill = '#DCE8F3';
sheet.getRange('A:A').format.columnWidth = 9;
sheet.getRange('B:B').format.columnWidth = 70;
sheet.getRange('C:C').format.columnWidth = 11;
sheet.getRange('D:D').format.columnWidth = 32;
sheet.getRange('E:E').format.columnWidth = 32;
sheet.getRange('F:K').format.columnWidth = 60;
sheet.getRangeByIndexes(1, 0, rows.length, headers.length).format.wrapText = true;
sheet.getRangeByIndexes(1, 0, rows.length, headers.length).format.rowHeight = 75;
sheet.freezePanes.freezeRows(1);
workbook.recalculate();

const outputDir = path.join(root, 'outputs/Fyrklovern/Matrixify files/Products/Care advice translations');
await fs.mkdir(outputDir, { recursive: true });
const file = path.join(outputDir, 'Care advice translation review - all 10 texts.xlsx');
const blob = await SpreadsheetFile.exportXlsx(workbook);
await blob.save(file);
const preview = await workbook.render({ sheetName: 'Care advice review', range: 'A1:K5', scale: 1, format: 'png' });
await fs.writeFile(path.join(root, '.artifact_work/care-advice-review-preview.png'), new Uint8Array(await preview.arrayBuffer()));
console.log(JSON.stringify({ file, rows: rows.length, products: 58, translatedTexts: 3, untranslatedTexts: 7 }));
