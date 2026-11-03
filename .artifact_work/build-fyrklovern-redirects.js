const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const root = path.resolve(__dirname, '..');
const source = path.resolve(root, '..', '..', 'Fyrklövern');
const output = path.join(root, 'outputs', 'Fyrklovern', '301 redirects', 'Full collection handles');

function rows(file, sheet) {
  const workbook = XLSX.readFile(file);
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { defval: '' });
}
function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(file, headers, data) {
  fs.writeFileSync(file, [headers, ...data.map(row => headers.map(h => row[h] ?? ''))]
    .map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');
}
function cleanPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[?#]/.test(raw)) return '';
  return raw.replace(/\/+$/, '') || '/';
}
const marketConfigPath = path.join(__dirname, 'fyrklovern-market-prefixes.json');
const marketConfig = fs.existsSync(marketConfigPath)
  ? JSON.parse(fs.readFileSync(marketConfigPath, 'utf8')) : {};
const marketLocale = { '2': 'no', '3': 'da', '4': 'fi', '5': 'de',
  '6': 'en', '7': 'nl', '8': 'de' };
const marketCulture = { '2': 'nb-NO', '3': 'da-DK', '4': 'fi-FI', '5': 'de-DE',
  '6': 'en-GB', '7': 'nl-NL', '8': 'de-DE' };
const oldPrefix = { '2': '/no', '3': '/dk', '4': '/fi', '5': '/de',
  '6': '/eu', '7': '/nl', '8': '/de' };
const marketFrom = (channel, route) => `${oldPrefix[channel]}${cleanPath(route)}`;
const marketTo = (channel, route) => `${marketConfig[channel]}${cleanPath(route)}`;

const redirects = new Map();
const review = [];
const audit = (type, sourceId, oldPath, destination, reason) =>
  review.push({ Type: type, 'Source ID': sourceId, 'Redirect from': oldPath,
    'Redirect to': destination, Issue: reason });

function add(type, id, oldPath, destination) {
  const from = cleanPath(oldPath);
  const to = cleanPath(destination);
  if (!from || !to || from === to) return;
  if (/^\/(apps?|application|carts?|orders|services|shop)(\/|$)/i.test(from) ||
      /^\/(products|collections)(\/|$)/i.test(from)) {
    audit(type, id, from, to, 'Shopify reserved source path'); return;
  }
  const existing = redirects.get(from);
  if (existing && existing.to !== to) {
    audit(type, id, from, to, `Conflicting destination: ${existing.to}`);
    return;
  }
  if (!existing) redirects.set(from, { from, to, type, id });
}

const productExport = rows(path.join(root, 'exports', 'Export_2026-09-29_101146 (1).xlsx'), 'Products');
const productHandles = new Set(productExport.filter(r => r.Status === 'Active' && r.Handle).map(r => String(r.Handle)));
const sourceProducts = JSON.parse(fs.readFileSync(path.join(root, 'results', 'fyrklovern', 'fyrklovern-products.json'))).list;
const productById = new Map(sourceProducts.map(p => [String(p.id), p]));
const productPaths = rows(path.join(source, 'fyrklovern_productpermalinks.xlsx'), 'Sheet1');
for (const row of productPaths) {
  if (row.Culture !== 'sv-SE') continue;
  const id = String(row.ProductID);
  const product = productById.get(id);
  if (!product || !productHandles.has(product.handle)) continue;
  add('Product', id, row.Permalink, `/products/${product.handle}`);
}
for (const product of sourceProducts) {
  if (!productHandles.has(product.handle)) audit('Product', product.id, '', `/products/${product.handle}`, 'No active Shopify product in supplied export');
}

const collectionExport = rows(path.join(root, 'exports', 'Export_2026-10-22_142102.xlsx'), 'Collections');
const collectionById = new Map(collectionExport.filter(r => r.ID && r.Handle && r['Published: Online Store'] === true)
  .map(r => [String(r.ID), String(r.Handle)]));
const approved = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'Fyrklovern', 'Matrixify files', 'Collections', 'Content updates', 'Collection content - approved URL mappings.json')));
const approvedByCategory = new Map(approved.filter(r => r.Culture === 'sv-SE' && r.ManualApproval === 'Approved')
  .map(r => [String(r.CategoryID), String(r.ShopifyID)]));
const categories = rows(path.join(source, 'fyrklovern_custom_export.xlsx'), 'categorypermalinks');
for (const row of categories) {
  if (row.Culture !== 'sv-SE') continue;
  const id = String(row.CategoryID);
  const shopifyId = approvedByCategory.get(id);
  const handle = collectionById.get(shopifyId);
  if (handle) add('Collection', id, row.Link, `/collections/${handle}`);
  else audit('Collection', id, row.Link, '', 'No approved and published Shopify collection match');
}

const pages = rows(path.join(root, 'exports', 'Export_2026-10-22_150343.xlsx'), 'Pages');
const pageHandles = new Set(pages.filter(r => r.Published === true && r.Handle).map(r => String(r.Handle)));
const norcePages = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'norce-pages', 'channel-1.json')));
const publishedIds = new Set(norcePages.publishedPageIds.map(String));
for (const page of norcePages.pages) {
  const from = cleanPath(page.primaryRoute?.path);
  if (!from || !publishedIds.has(String(page.id))) continue;
  const handle = from.split('/').pop();
  if (pageHandles.has(handle)) add('Page', page.id, from, `/pages/${handle}`);
  else audit('Page', page.id, from, '', 'No exact published Shopify page handle match');
}

const swedishBase = [...redirects.values()];

if (Object.keys(marketConfig).length) {
  for (const [channel, prefix] of Object.entries(marketConfig))
    audit('Market', channel, oldPrefix[channel], prefix,
      `Assumed Shopify destination prefix for ${marketCulture[channel]}; verify in Shopify Markets before import`);
  const productByArticle = new Map(productExport.filter(r => r.Handle && r['Variant SKU'])
    .map(r => [String(r['Variant SKU']), String(r.Handle)]));
  const translatedProductHandles = new Map(rows(path.join(root, 'outputs', 'Fyrklovern', 'Matrixify files',
    'Products', 'Translations', 'Product metafields and translations - Matrixify import.xlsx'), 'Translations')
    .filter(r => r.Field === 'Handle').map(r => [String(r['Entity Handle']), r]));
  const productCache = rows(path.join(root, 'cache', 'norce-products-cache.xlsx'), 'Raw Responses');
  for (const row of productCache) {
    const channel = String(row['Channel ID']);
    if (!marketConfig[channel] || row['Query Group'] !== 'relationships') continue;
    const handle = productByArticle.get(String(row['Source ID']));
    if (!handle || !productHandles.has(handle)) continue;
    const translated = translatedProductHandles.get(handle)?.[`Translation Value: ${marketLocale[channel]}`];
    const route = JSON.parse(row['Response JSON']).primaryRoute?.canonicalPath;
    if (translated && route) add('Product', row['Source ID'], marketFrom(channel, route),
      marketTo(channel, `/products/${translated}`));
    else audit('Product', row['Source ID'], route, '', `Missing canonical route or Shopify handle translation for channel ${channel}`);
  }

  const collectionCache = rows(path.join(root, 'cache', 'norce-collections-cache.xlsx'), 'Collections');
  for (const row of collectionCache) {
    const channel = String(row['Channel ID']);
    if (!marketConfig[channel]) continue;
    const id = String(row['Category ID']);
    const shopifyId = approvedByCategory.get(id);
    const handle = collectionById.get(shopifyId);
    const localizedHandle = cleanPath(row['Original URL']).split('/').filter(Boolean).join('-').replace(/-+/g, '-');
    if (handle && shopifyId === String(row['Shopify Collection ID']) && localizedHandle)
      add('Collection', id, marketFrom(channel, row['Original URL']), marketTo(channel, `/collections/${localizedHandle}`));
  }

  const swedishPageHandle = new Map(norcePages.pages.filter(p => publishedIds.has(String(p.id)) && p.primaryRoute?.path)
    .map(p => [String(p.id), cleanPath(p.primaryRoute.path).split('/').pop()]));
  for (const channel of Object.keys(marketConfig)) {
    const file = path.join(root, 'cache', 'norce-pages', `channel-${channel}.json`);
    const data = JSON.parse(fs.readFileSync(file));
    const published = new Set(data.publishedPageIds.map(String));
    for (const page of data.pages) {
      const handle = swedishPageHandle.get(String(page.id));
      if (published.has(String(page.id)) && handle && pageHandles.has(handle) && page.primaryRoute?.path)
        add('Page', page.id, marketFrom(channel, page.primaryRoute.path), marketTo(channel, `/pages/${handle}`));
    }
  }

}

for (const row of swedishBase) {
  if (row.from !== '/' && !row.from.startsWith('/se/')) {
    const from = `/se${row.from}`;
    if (!redirects.has(from)) redirects.set(from, { ...row, from });
  }
}
const sorted = [...redirects.values()].sort((a, b) => a.from.localeCompare(b.from, 'en'));
const csvRows = sorted.map(row => ({ 'Redirect from': row.from, 'Redirect to': row.to }));
fs.mkdirSync(output, { recursive: true });
writeCsv(path.join(output, 'fyrklovern-301-redirects-staged.csv'), ['Redirect from', 'Redirect to'], csvRows);
writeCsv(path.join(output, 'fyrklovern-301-redirect-review.csv'),
  ['Type', 'Source ID', 'Redirect from', 'Redirect to', 'Issue'], review);
const counts = Object.fromEntries(['Product', 'Collection', 'Page', 'Blog'].map(type =>
  [type, sorted.filter(row => row.type === type).length]));
console.log(JSON.stringify({ output, redirects: sorted.length, counts, review: review.length,
  productHandles: productHandles.size, sourceProducts: sourceProducts.length,
  first: sorted.slice(0, 4), last: sorted.slice(-4) }, null, 2));
