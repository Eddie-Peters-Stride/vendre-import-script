import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const root = path.resolve('.');
const source = path.join(root, '.artifact_work', 'fyrklovern-category-permalinks.json');
const approvedFile = path.join(root, 'outputs', 'Fyrklovern', 'Matrixify files', 'Collections',
  'Content updates', 'Collection content - approved URL mappings.json');
const outputFile = path.join(root, 'outputs', 'Fyrklovern', 'Matrixify files', 'Collections',
  'Collection handle translations - Matrixify import.xlsx');

const approved = JSON.parse(await fs.readFile(approvedFile, 'utf8'));
const categoryToId = new Map();
for (const row of approved.filter(row => row.ManualApproval === 'Approved')) {
  const categoryId = String(row.CategoryID);
  const shopifyId = String(row.ShopifyID);
  if (categoryToId.has(categoryId) && categoryToId.get(categoryId) !== shopifyId)
    throw new Error(`Conflicting approved collection IDs for ${categoryId}`);
  categoryToId.set(categoryId, shopifyId);
}

const sourceRows = JSON.parse(await fs.readFile(source, 'utf8'));
if (!sourceRows.every(row => 'CategoryID' in row && 'Link' in row && 'Culture' in row))
  throw new Error('Missing category permalink columns');

const localizedById = new Map();
for (const row of sourceRows) {
  const categoryId = String(row.CategoryID ?? '');
  const id = categoryToId.get(categoryId);
  if (!id) continue;
  const culture = String(row.Culture ?? '');
  const permalink = String(row.Link ?? '');
  const slug = permalink.split('/').filter(Boolean).join('-').replace(/-+/g, '-');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new Error(`Invalid ${culture} handle for collection ${id}: ${permalink}`);
  if (!localizedById.has(id)) localizedById.set(id, new Map());
  const locales = localizedById.get(id);
  if (locales.has(culture) && locales.get(culture) !== slug)
    throw new Error(`Conflicting ${culture} handles for collection ${id}`);
  locales.set(culture, slug);
}

const localeColumns = [
  ['no', 'nb-NO'], ['da', 'da-DK'], ['fi', 'fi-FI'],
  ['de', 'de-DE'], ['en', 'en-GB'], ['nl', 'nl-NL'],
];
const used = new Map(localeColumns.map(([locale]) => [locale, new Map()]));
const outputRows = [];
for (const [id, locales] of [...localizedById].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  const base = locales.get('sv-SE');
  if (!base) throw new Error(`Missing Swedish base handle for collection ${id}`);
  const row = ['Collection', id, base, 'Handle'];
  for (const [locale, culture] of localeColumns) {
    const slug = locales.get(culture);
    if (!slug) throw new Error(`Missing ${culture} handle for collection ${id}`);
    const collision = used.get(locale).get(slug);
    if (collision && collision !== id)
      throw new Error(`Duplicate ${locale} handle ${slug}: collections ${collision} and ${id}`);
    used.get(locale).set(slug, id);
    row.push(slug);
  }
  outputRows.push(row);
}

const outputHeaders = ['Entity', 'Entity ID', 'Entity Handle', 'Field',
  ...localeColumns.map(([locale]) => `Translation Value: ${locale}`)];
const workbook = Workbook.create();
const sheet = workbook.worksheets.add('Translations');
sheet.getRange(`A1:J${outputRows.length + 1}`).values = [outputHeaders, ...outputRows];
sheet.getRange('A:A').format.columnWidth = 16;
sheet.getRange('B:B').format.columnWidth = 20;
sheet.getRange('C:C').format.columnWidth = 45;
sheet.getRange('D:D').format.columnWidth = 16;
sheet.getRange('E:J').format.columnWidth = 55;
workbook.recalculate();
const check = await workbook.inspect({ kind: 'table', range: 'Translations!A1:J3',
  include: 'values', tableMaxRows: 3, tableMaxCols: 10 });
console.log(check.ndjson);
const preview = await workbook.render({ sheetName: 'Translations', range: 'A1:D6', scale: 1.5 });
await fs.writeFile(path.join(root, '.artifact_work', 'collection-handle-translations-preview.png'),
  new Uint8Array(await preview.arrayBuffer()));
await fs.mkdir(path.dirname(outputFile), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputFile);
console.log(JSON.stringify({ outputFile, collections: outputRows.length,
  example: outputRows.find(row => row[2] === 'dukning-servering-bestick') }));
