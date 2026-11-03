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
const localeByCulture = { 'nb-NO': 'no', 'da-DK': 'da', 'fi-FI': 'fi',
  'de-DE': 'de', 'en-GB': 'en', 'nl-NL': 'nl' };

const approved = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'Fyrklovern',
  'Matrixify files', 'Collections', 'Content updates', 'Collection content - approved URL mappings.json')));
const idByCategory = new Map();
for (const row of approved.filter(row => row.ManualApproval === 'Approved')) {
  const id = clean(row.ShopifyID), category = clean(row.CategoryID);
  if (idByCategory.has(category) && idByCategory.get(category) !== id)
    throw new Error(`Conflicting collection mapping for category ${category}`);
  idByCategory.set(category, id);
}
const shopify = rows(path.join(root, 'exports', 'Export_2026-10-22_142102.xlsx'), 'Collections');
const handleById = new Map(shopify.filter(row => row.ID && row.Handle && row['Published: Online Store'] === true)
  .map(row => [clean(row.ID), clean(row.Handle)]));
const sourceRows = rows(source, 'categorieslocalized');
const mapped = new Map();
const conflicts = [];
for (const sourceRow of sourceRows) {
  const locale = localeByCulture[sourceRow.culture];
  const id = idByCategory.get(clean(sourceRow.categoryid));
  const handle = handleById.get(id);
  if (!locale || !id || !handle) continue;
  for (const [field, column] of [['SEO Title', 'pagetitle'], ['SEO Description', 'metadescription']]) {
    const value = clean(sourceRow[column]);
    if (!value || /^-?\d+(?:\.\d+)?$/.test(value)) continue;
    const key = `${locale}\u0000${id}\u0000${field}`;
    const previous = mapped.get(key);
    if (previous && previous.value !== value) {
      conflicts.push({ locale, id, field, categories: [previous.category, clean(sourceRow.categoryid)] });
      mapped.delete(key);
      continue;
    }
    if (!previous) mapped.set(key, { locale, id, handle, field, value, category: clean(sourceRow.categoryid) });
  }
}
if (conflicts.length) throw new Error(`Conflicting SEO values: ${JSON.stringify(conflicts.slice(0, 5))}`);
const data = [...mapped.values()].sort((a, b) => a.locale.localeCompare(b.locale) || Number(a.id) - Number(b.id) || a.field.localeCompare(b.field));
const target = path.join(__dirname, 'fyrklovern-collection-seo-source.json');
fs.writeFileSync(target, JSON.stringify(data), 'utf8');
const counts = {};
for (const row of data) {
  const group = counts[row.locale] ||= { title: 0, description: 0 };
  group[row.field === 'SEO Title' ? 'title' : 'description']++;
}
console.log(JSON.stringify({ rows: data.length, counts, target }, null, 2));
