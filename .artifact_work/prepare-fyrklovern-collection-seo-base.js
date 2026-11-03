const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const root = path.resolve(__dirname, '..');
const source = path.resolve(root, '..', '..', 'Fyrklövern', 'fyrklovern_custom_export.xlsx');
const rows = (file, sheet) => XLSX.utils.sheet_to_json(XLSX.readFile(file, { sheets: sheet }).Sheets[sheet], { defval: '' });
const clean = value => {
  const text = String(value ?? '').trim();
  return text.toUpperCase() === 'NULL' ? '' : text;
};

const approved = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'Fyrklovern',
  'Matrixify files', 'Collections', 'Content updates', 'Collection content - approved URL mappings.json')));
const idByCategory = new Map(approved.filter(row => row.ManualApproval === 'Approved')
  .map(row => [clean(row.CategoryID), clean(row.ShopifyID)]));
const current = rows(path.join(root, 'exports', 'Export_2026-10-22_142102.xlsx'), 'Collections');
const shopifyById = new Map(current.filter(row => row.ID && row.Handle && row['Published: Online Store'] === true)
  .map(row => [clean(row.ID), row]));
const sourceRows = rows(source, 'categorieslocalized');
const result = { title: [], description: [] };
const seen = { title: new Set(), description: new Set() };
for (const row of sourceRows.filter(row => row.culture === 'sv-SE')) {
  const id = idByCategory.get(clean(row.categoryid));
  const shopify = shopifyById.get(id);
  if (!shopify) continue;
  for (const [field, sourceColumn, currentColumn] of [
    ['title', 'pagetitle', 'Metafield: title_tag [string]'],
    ['description', 'metadescription', 'Metafield: description_tag [string]'],
  ]) {
    const value = clean(row[sourceColumn]);
    if (!value || /^-?\d+(?:\.\d+)?$/.test(value) || clean(shopify[currentColumn])) continue;
    if (seen[field].has(id)) throw new Error(`Duplicate Swedish SEO ${field} for collection ${id}`);
    seen[field].add(id);
    result[field].push({ id, handle: clean(shopify.Handle), value });
  }
}
const target = path.join(__dirname, 'fyrklovern-collection-seo-base-source.json');
fs.writeFileSync(target, JSON.stringify(result), 'utf8');
console.log(JSON.stringify({ title: result.title.length, description: result.description.length, target }));
