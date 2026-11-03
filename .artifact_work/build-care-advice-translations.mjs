import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const root = process.cwd();
const scan = JSON.parse(await fs.readFile(path.join(root, '.artifact_work/care-advice-live-scan.json'), 'utf8'));
const outputDir = path.join(root, 'outputs/Fyrklovern/Matrixify files/Products/Care advice translations');
const ids = new Map([
  ['julminnen-tallriksset-36-delar-12-pers', '15795172770132'],
  ['crown-glasset-8-delar-gron', '15795093438804'],
  ['breath-of-nature-bordsduk-north-sea-green-145x250-cm', '15795008700756'],
]);
const localeChannels = { no: 'NO', da: 'DK', fi: 'FI', de: 'DE', en: 'EU', nl: 'NL' };

function translation(record, locale) {
  const channel = localeChannels[locale];
  const localized = record.locales[channel];
  const swedish = record.locales.SE?.careFields?.[0]?.value;
  const value = localized?.careFields?.[0]?.value;
  if (localized?.status !== 'ok' || !value || value.trim() === swedish?.trim()) {
    throw new Error(`No distinct ${locale} care advice for ${record.handle}`);
  }
  if (locale === 'de' && record.locales.AT?.careFields?.[0]?.value !== value) {
    throw new Error(`DE/AT mismatch for ${record.handle}`);
  }
  return value;
}

async function build(name, handles, locales) {
  const headers = ['Entity', 'Entity ID', 'Entity Handle', 'Field', ...locales.map(locale => `Translation Value: ${locale}`)];
  const rows = handles.map(handle => {
    const record = scan.records.find(item => item.handle === handle);
    if (!record || !ids.has(handle)) throw new Error(`Missing mapped product: ${handle}`);
    return ['Product', ids.get(handle), handle, 'Metafield: custom.care_advice', ...locales.map(locale => translation(record, locale))];
  });
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add('Translations');
  sheet.showGridLines = false;
  sheet.getRangeByIndexes(0, 0, rows.length + 1, headers.length).values = [headers, ...rows];
  sheet.getRangeByIndexes(0, 0, 1, headers.length).format.font.bold = true;
  sheet.getRangeByIndexes(0, 0, 1, headers.length).format.fill = '#DCE8F3';
  sheet.getRange('A:A').format.columnWidth = 13;
  sheet.getRange('B:B').format.columnWidth = 20;
  sheet.getRange('C:C').format.columnWidth = 62;
  sheet.getRange('D:D').format.columnWidth = 38;
  sheet.getRangeByIndexes(0, 4, rows.length + 1, locales.length).format.columnWidth = 60;
  sheet.getRangeByIndexes(1, 0, rows.length, headers.length).format.wrapText = true;
  sheet.getRangeByIndexes(1, 0, rows.length, headers.length).format.rowHeight = 75;
  sheet.freezePanes.freezeRows(1);
  workbook.recalculate();
  const check = await workbook.inspect({ kind: 'table', range: `Translations!A1:${String.fromCharCode(64 + headers.length)}${rows.length + 1}`, tableMaxRows: 5, tableMaxCols: headers.length, maxChars: 2500 });
  console.log(name, check.ndjson);
  await fs.mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, name);
  const blob = await SpreadsheetFile.exportXlsx(workbook);
  await blob.save(file);
  const preview = await workbook.render({ sheetName: 'Translations', range: `A1:${String.fromCharCode(64 + headers.length)}${rows.length + 1}`, scale: 1, format: 'png' });
  await fs.writeFile(path.join(root, '.artifact_work', name.replace('.xlsx', '.png')), new Uint8Array(await preview.arrayBuffer()));
  console.log(`Saved ${file}`);
}

await build('Care advice translations - no-da-fi-de.xlsx', [...ids.keys()], ['no', 'da', 'fi', 'de']);
await build('Care advice translations - en-nl.xlsx', [...ids.keys()].slice(0, 2), ['en', 'nl']);
