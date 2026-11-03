const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const root = path.resolve(__dirname, '..');
const translations = JSON.parse(fs.readFileSync(path.join(__dirname, 'fyrklovern-collection-seo-source.json'), 'utf8'));
const baseUpdates = JSON.parse(fs.readFileSync(path.join(__dirname, 'fyrklovern-collection-seo-base-source.json'), 'utf8'));
const sourceWorkbook = XLSX.readFile(path.join(root, 'exports', 'Export_2026-10-22_142102.xlsx'), { sheets: 'Collections' });
const collections = XLSX.utils.sheet_to_json(sourceWorkbook.Sheets.Collections, { defval: '' });

const baseByKey = new Map();
for (const collection of collections) {
  if (!collection.ID) continue;
  for (const [field, column] of [
    ['SEO Title', 'Metafield: title_tag [string]'],
    ['SEO Description', 'Metafield: description_tag [string]'],
  ]) {
    const value = String(collection[column] ?? '').trim();
    if (value) baseByKey.set(`${collection.ID}|${field}`, value);
  }
}
for (const [kind, field] of [['title', 'SEO Title'], ['description', 'SEO Description']]) {
  for (const row of baseUpdates[kind]) baseByKey.set(`${row.id}|${field}`, row.value);
}

const header = ['Type', 'Identification', 'Field', 'Locale', 'Market', 'Status', 'Default content', 'Translated content'];
const escapeCsv = value => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const seen = new Set();
const lines = [header.join(',')];
for (const row of translations) {
  const field = row.field === 'SEO Title' ? 'meta_title' : row.field === 'SEO Description' ? 'meta_description' : null;
  if (!field || !row.value) throw new Error(`Invalid translation row: ${JSON.stringify(row)}`);
  const key = `${row.id}|${field}|${row.locale}`;
  if (seen.has(key)) throw new Error(`Duplicate translation: ${key}`);
  seen.add(key);
  const base = baseByKey.get(`${row.id}|${row.field}`);
  if (!base) throw new Error(`Missing Swedish base SEO for ${key}`);
  lines.push(['COLLECTION', row.id, field, row.locale, '', '', base, row.value].map(escapeCsv).join(','));
}

const output = path.join(root, 'outputs', 'Fyrklovern', 'Shopify language import', 'Fyrklovern collection SEO translations - all languages.csv');
fs.writeFileSync(output, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
console.log(JSON.stringify({ output, rows: translations.length, locales: [...new Set(translations.map(row => row.locale))], baseUpdatesRequired: { title: baseUpdates.title.length, description: baseUpdates.description.length } }, null, 2));
