import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const root = path.resolve('.');
const source = path.join(root, '.artifact_work', 'fyrklovern-collection-seo-source.json');
const directory = path.join(root, 'outputs', 'Fyrklovern', 'Matrixify files', 'Collections', 'SEO translations');
const data = JSON.parse(await fs.readFile(source, 'utf8'));
const locales = ['no', 'da', 'fi', 'de', 'en', 'nl'];
const results = [];
await fs.mkdir(directory, { recursive: true });

for (const locale of locales) {
  const rows = data.filter(row => row.locale === locale);
  if (!rows.length || rows.some(row => !row.value || !row.id || !row.handle || !['SEO Title', 'SEO Description'].includes(row.field)))
    throw new Error(`Missing or invalid ${locale} SEO translation`);
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add('Translations');
  const headers = ['Entity', 'Entity ID', 'Entity Handle', 'Field', `Translation Value: ${locale}`];
  const values = rows.map(row => ['Collection', String(row.id), row.handle, row.field, row.value]);
  sheet.getRange(`A1:E${values.length + 1}`).values = [headers, ...values];
  sheet.getRange('A:A').format.columnWidth = 16;
  sheet.getRange('B:B').format.columnWidth = 20;
  sheet.getRange('C:C').format.columnWidth = 48;
  sheet.getRange('D:D').format.columnWidth = 23;
  sheet.getRange('E:E').format.columnWidth = 95;
  workbook.recalculate();
  if (locale === 'fi') {
    const preview = await workbook.render({ sheetName: 'Translations', range: 'C1:E5', scale: 1.2 });
    await fs.writeFile(path.join(root, '.artifact_work', 'collection-seo-preview.png'),
      new Uint8Array(await preview.arrayBuffer()));
  }
  const file = path.join(directory, `Collection SEO translations - ${locale}.xlsx`);
  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(file);
  results.push({ locale, rows: rows.length, file });
}
console.log(JSON.stringify(results, null, 2));
