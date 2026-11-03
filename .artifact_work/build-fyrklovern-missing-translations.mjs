import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const require = createRequire(import.meta.url);
const XLSX = require('../node_modules/xlsx');
const root = path.resolve('.');
const inputPath = path.join(root, '.artifact_work/Fyrklovern_translations_Oct-29-2026.csv');
const outputPath = path.join(root, 'outputs/Fyrklovern/Fyrklovern missing translations - sourced 2026-10-29.xlsx');
const readCsv = file => {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const book = XLSX.read(text, { type: 'string' });
  return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { defval: '' });
};
const readSheet = (file, sheet) => {
  const book = XLSX.readFile(file);
  return XLSX.utils.sheet_to_json(book.Sheets[sheet || book.SheetNames[0]], { defval: '' });
};
const cleanId = value => String(value || '').replace(/^'/, '');
const cleanText = value => String(value || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const locales = { no: 'nb-NO', da: 'da-DK', fi: 'fi-FI', de: 'de-DE', en: 'en-GB', nl: 'nl-NL' };
const input = readCsv(inputPath);

const cacheBook = XLSX.readFile('cache/norce-products-cache.xlsx');
const cacheProducts = XLSX.utils.sheet_to_json(cacheBook.Sheets.Products, { defval: '' });
const cacheAttributes = XLSX.utils.sheet_to_json(cacheBook.Sheets['Product Attributes'], { defval: '' });
const productMap = readSheet('norcemigration/product-metafield-translation-run-final/reports/product-mapping.xlsx');
const idToArticle = new Map(productMap.filter(row => row['Shopify ID']).map(row => [cleanId(row['Shopify ID']), String(row.Article)]));
const articleCulture = new Map(cacheProducts.map(row => [`${row['Article Number']}|${row.Culture}`, row]));
const bySwedishTitle = new Map();
const bySwedishBody = new Map();
for (const row of cacheProducts.filter(row => row.Culture === 'sv-SE')) {
  for (const [index, value] of [[bySwedishTitle, row.Name], [bySwedishBody, row.Description]]) {
    const key = cleanText(value);
    if (!key) continue;
    const set = index.get(key) || new Set();
    set.add(String(row['Article Number']));
    index.set(key, set);
  }
}
const single = set => set?.size === 1 ? [...set][0] : '';
const idToArticleFallback = new Map();
for (const row of input.filter(row => row.Type === 'PRODUCT')) {
  const id = cleanId(row.Identification);
  if (idToArticle.has(id)) continue;
  const index = row.Field === 'title' ? bySwedishTitle : row.Field === 'body_html' ? bySwedishBody : null;
  const article = index && single(index.get(cleanText(row['Default content'])));
  if (article) idToArticleFallback.set(id, article);
}

const translationBook = XLSX.readFile('outputs/Fyrklovern/Matrixify files/Products/Translations/Product metafields and translations - Matrixify import.xlsx');
const translationRows = XLSX.utils.sheet_to_json(translationBook.Sheets.Translations, { defval: '' });
const handleMap = new Map(translationRows.filter(row => row.Field === 'Handle').map(row => [cleanId(row['Entity ID']), row]));
const newProductRows = readSheet('outputs/Fyrklovern/Matrixify files/Products/Translations/Fyrklovern new product translations - Matrixify import.xlsx');
const newProductBase = readSheet('outputs/Fyrklovern/Matrixify files/Products/Fyrklovern new products - Matrixify import.xlsx', 'Products');
const newTitleToHandle = new Map(newProductBase.filter(row => row.Title).map(row => [cleanText(row.Title), row.Handle]));
const newTranslated = new Map(newProductRows.map(row => [`${row['Entity Handle']}|${row.Field}`, row]));
const specialRows = readSheet('outputs/Fyrklovern/Matrixify files/Products/Translations/Product 15854966931796 - missing translations.xlsx');
const specialMap = new Map(specialRows.map(row => [`${cleanId(row['Entity ID'])}|${row.Field}`, row]));

// Only use a metafield translation when every matching Norce or project value agrees.
const memory = new Map();
const remember = (original, locale, translated) => {
  if (!original || !translated) return;
  const key = `${original}|${locale}`;
  const set = memory.get(key) || new Set();
  set.add(String(translated));
  memory.set(key, set);
};
const attrByArticle = new Map(cacheAttributes.map(row => [`${row['Article Number']}|${row['Attribute Key']}|${row.Culture}`, row['Attribute Value']]));
for (const row of cacheAttributes.filter(row => row.Culture === 'sv-SE')) {
  for (const [locale, culture] of Object.entries(locales)) {
    remember(row['Attribute Value'], locale, attrByArticle.get(`${row['Article Number']}|${row['Attribute Key']}|${culture}`));
  }
}
const baseProducts = readSheet('outputs/Fyrklovern/Matrixify files/Products/Fyrklovern products - updated Matrixify import.xlsx', 'Products');
const baseByHandle = new Map(baseProducts.filter(row => row.Title).map(row => [row.Handle, row]));
for (const row of translationRows.filter(row => row.Field.startsWith('Metafield:'))) {
  const base = baseByHandle.get(row['Entity Handle']);
  if (!base) continue;
  const column = Object.keys(base).find(key => key.startsWith(`${row.Field} [`));
  if (!column) continue;
  for (const locale of Object.keys(locales)) remember(base[column], locale, row[`Translation Value: ${locale}`]);
}

const headers = ['Type', 'Identification', 'Field', 'Locale', 'Market', 'Status', 'Default content', 'Translated content'];
const filled = [], unresolved = [], counts = new Map(), sourceCounts = new Map();
for (const row of input) {
  if (row.Type === 'PRODUCT_OPTION' || row.Type === 'PRODUCT_OPTION_VALUE') continue;
  const id = cleanId(row.Identification);
  const locale = row.Locale;
  let value = '', source = '';
  if (row.Type === 'PRODUCT') {
    const article = idToArticle.get(id) || idToArticleFallback.get(id);
    if (row.Field === 'handle') {
      value = handleMap.get(id)?.[`Translation Value: ${locale}`] || '';
      source = value ? 'project handle workbook' : '';
    } else if (article) {
      const product = articleCulture.get(`${article}|${locales[locale]}`);
      value = product && (row.Field === 'title' ? product.Name : row.Field === 'body_html' ? product.Description : '') || '';
      source = value ? 'Norce product cache' : '';
    }
    if (!value) {
      const handle = newTitleToHandle.get(cleanText(row['Default content'])) || '';
      const field = row.Field === 'title' ? 'Title' : row.Field === 'body_html' ? 'Body HTML' : '';
      const candidate = specialMap.get(`${id}|${field}`) || newTranslated.get(`${handle}|${field}`);
      value = candidate?.[`Translation Value: ${locale}`] || '';
      source = value ? 'project new product workbook' : '';
    }
  } else if (row.Type === 'METAFIELD') {
    const candidates = memory.get(`${row['Default content']}|${locale}`);
    value = single(candidates);
    source = value ? 'unambiguous Norce/project metafield match' : '';
  }
  const key = `${row.Type}|${row.Field}|${locale}`;
  const count = counts.get(key) || { total: 0, filled: 0, missing: 0 };
  count.total++;
  if (value) {
    count.filled++;
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    filled.push({ ...row, 'Translated content': value });
  } else {
    count.missing++;
    unresolved.push({ ...row, Reason: row.Type === 'PRODUCT' ? 'No verified localized product text or handle' : 'No unique matching localized metafield value' });
  }
  counts.set(key, count);
}

const workbook = Workbook.create();
const translations = workbook.worksheets.add('Translations');
const needsSource = workbook.worksheets.add('Needs source');
const coverage = workbook.worksheets.add('Coverage');
const write = (sheet, matrix) => {
  for (let start = 0; start < matrix.length; start += 500) {
    const block = matrix.slice(start, start + 500);
    sheet.getRange(`A${start + 1}:I${start + block.length}`).write(block);
  }
};
// Keep the import sheet's eight columns and header exactly as in the supplied CSV.
const writeEight = (sheet, matrix) => {
  for (let start = 0; start < matrix.length; start += 500) {
    const block = matrix.slice(start, start + 500);
    sheet.getRange(`A${start + 1}:H${start + block.length}`).write(block);
  }
};
writeEight(translations, [headers, ...filled.map(row => headers.map(header => String(row[header] ?? '')))]);
write(needsSource, [[...headers, 'Reason'], ...unresolved.map(row => [...headers.map(header => String(row[header] ?? '')), row.Reason])]);
const coverageRows = [['Type', 'Field', 'Locale', 'Input rows', 'Filled', 'Needs source', 'Note', '', '']];
for (const [key, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
  coverageRows.push([...key.split('|'), count.total, count.filled, count.missing, '', '', '']);
}
coverageRows.push(['PRODUCT_OPTION', 'name', 'all', 5934, 0, 0, 'Excluded: placeholder option name Title', '', '']);
coverageRows.push(['PRODUCT_OPTION_VALUE', 'name', 'all', 5934, 0, 0, 'Excluded: placeholder option value Default Title', '', '']);
coverageRows.push(['Source', 'Norce product cache', '', sourceCounts.get('Norce product cache') || 0, '', '', '', '', '']);
coverageRows.push(['Source', 'Project handle workbook', '', sourceCounts.get('project handle workbook') || 0, '', '', '', '', '']);
coverageRows.push(['Source', 'Project new product workbook', '', sourceCounts.get('project new product workbook') || 0, '', '', '', '', '']);
coverageRows.push(['Source', 'Norce/project metafield match', '', sourceCounts.get('unambiguous Norce/project metafield match') || 0, '', '', '', '', '']);
write(coverage, coverageRows);
for (const sheet of [translations, needsSource, coverage]) sheet.getRange('A1:I1').format.fill = '#DCE9F4';
workbook.recalculate();
const blob = await SpreadsheetFile.exportXlsx(workbook);
await blob.save(outputPath);
console.log(JSON.stringify({ outputPath, inputRows: input.length, filledRows: filled.length, unresolvedRows: unresolved.length, excludedPlaceholderRows: input.length - filled.length - unresolved.length, sources: Object.fromEntries(sourceCounts) }, null, 2));
