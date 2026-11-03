import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const root = path.resolve('.');
const data = JSON.parse(await fs.readFile(path.join(root, '.artifact_work', 'fyrklovern-collection-seo-base-source.json'), 'utf8'));
const directory = path.join(root, 'outputs', 'Fyrklovern', 'Matrixify files', 'Collections', 'SEO translations');
const fields = [
  ['title', 'Metafield: title_tag [string]', 'Collection SEO title - Swedish update.xlsx'],
  ['description', 'Metafield: description_tag [string]', 'Collection SEO description - Swedish update.xlsx'],
];
await fs.mkdir(directory, { recursive: true });
for (const [kind, column, name] of fields) {
  const rows = data[kind];
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add('Collections');
  sheet.getRange(`A1:D${rows.length + 1}`).values = [
    ['ID', 'Handle', 'Command', column],
    ...rows.map(row => [String(row.id), row.handle, 'UPDATE', row.value]),
  ];
  sheet.getRange('A:A').format.columnWidth = 20;
  sheet.getRange('B:B').format.columnWidth = 48;
  sheet.getRange('C:C').format.columnWidth = 16;
  sheet.getRange('D:D').format.columnWidth = 95;
  workbook.recalculate();
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(path.join(directory, name));
  console.log(JSON.stringify({ file: path.join(directory, name), rows: rows.length }));
}
