const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// ─── Paths ────────────────────────────────────────────────────────────────────
const collectionsPath = path.join(__dirname, '../results/collections.json');
const collectionsXlsxPath = path.join(__dirname, '../results/collections.xlsx');
const productsPath = path.join(__dirname, '../results/products.json');
const outputXlsxPath = path.join(__dirname, '../results/matrixify-product-collections.xlsx');

// ─── Load data ─────────────────────────────────────────────────────────────────
const collectionsRaw = JSON.parse(fs.readFileSync(collectionsPath, 'utf8'));
const collections = Array.isArray(collectionsRaw)
    ? collectionsRaw
    : (Array.isArray(collectionsRaw.list) ? collectionsRaw.list : []);

const productsRaw = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
const products = Array.isArray(productsRaw)
    ? productsRaw
    : (Array.isArray(productsRaw.list) ? productsRaw.list : []);

// ─── Load authoritative Shopify handles from collections.xlsx ─────────────────
// collections.xlsx was the file imported into Shopify, so its Handle column is
// the ground truth. Build title → shopifyHandle from it.
const titleToShopifyHandle = {};
{
    const wb = XLSX.readFile(collectionsXlsxPath);
    const ws = wb.Sheets['Custom Collections'];
    const rows = XLSX.utils.sheet_to_json(ws);
    for (const row of rows) {
        if (row['Handle'] && row['Title']) {
            titleToShopifyHandle[row['Title'].trim()] = row['Handle'].trim();
        }
    }
}
console.log(`Loaded ${Object.keys(titleToShopifyHandle).length} existing Shopify collection handles from collections.xlsx`);

// ─── Build collection ID → collection map ────────────────────────────────────
const idToCollection = {};
for (const col of collections) {
    idToCollection[col.id] = col;
}

// ─── Helpers (mirrors exportMatrixifyCollections.js exactly) ─────────────────
function slugify(str) {
    return str
        .toLowerCase()
        .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

function rawName(col) {
    return ((col.name && (col.name.sv || col.name.en)) || '').trim();
}

function ancestorPath(col) {
    const parts = [];
    let current = col;
    const visited = new Set();
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        const name = rawName(current);
        if (name) parts.unshift(name);
        current = current.parent_id ? idToCollection[current.parent_id] : null;
    }
    return parts;
}

const leafNameToIds = {};
for (const col of collections) {
    const name = rawName(col);
    if (!name) continue;
    if (!leafNameToIds[name]) leafNameToIds[name] = [];
    leafNameToIds[name].push(col.id);
}

function collectionTitle(col) {
    const name = rawName(col);
    if (!name) return '';
    const p = ancestorPath(col);
    if (p.length <= 1) return name;
    const sameNameIds = (leafNameToIds[name] || []).filter(id => id !== col.id);
    for (let depth = 2; depth <= p.length; depth++) {
        const candidate = p.slice(p.length - depth).join(' - ');
        const hasConflict = sameNameIds.some(id => {
            const other = idToCollection[id];
            if (!other) return false;
            const otherPath = ancestorPath(other);
            return otherPath.slice(otherPath.length - depth).join(' - ') === candidate;
        });
        if (!hasConflict) return candidate;
    }
    return p.join(' - ') + ' (' + col.id + ')';
}

// ─── Build ID → disambiguated title (used to look up Shopify handles) ──────────
const idToTitle = {};

for (const col of collections) {
    const title = collectionTitle(col);
    if (!title) continue;
    idToTitle[col.id] = title;
}

console.log(`Total Vendre collections : ${collections.length}`);

// ─── Walk up ancestry chain for a collection ID ──────────────────────────────
function getAncestorIds(catId) {
    const ids = [];
    let current = idToCollection[catId];
    const visited = new Set();
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        ids.push(current.id);
        current = current.parent_id ? idToCollection[current.parent_id] : null;
    }
    return ids;
}

// ─── Product handle ───────────────────────────────────────────────────────────
function productHandle(product) {
    const seoLink = (product.seo_link && (product.seo_link.sv || product.seo_link.en)) || '';
    if (seoLink) {
        const parts = seoLink.replace(/\/+$/, '').split('/');
        const slug = parts[parts.length - 1];
        if (slug) return slug;
    }
    const name = (product.name && (product.name.sv || product.name.en)) || 'product-' + product.id;
    return name
        .toLowerCase()
        .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

// ─── Build product ID → handle map (for complementary_products lookup) ────────
const productIdToHandle = {};
for (const product of products) {
    const h = productHandle(product);
    if (h) productIdToHandle[product.id] = h;
}

// ─── Build Products rows — only assign to existing Shopify collections ────────
const productRows = [];
let skippedProducts = 0;

for (const product of products) {
    const handle = productHandle(product);
    if (!handle) { skippedProducts++; continue; }

    const catIds = product.category_ids;
    if (!catIds || catIds.length === 0) { skippedProducts++; continue; }

    // Collect this collection + all ancestors; resolve handle directly from collections.xlsx
    const assignedHandles = new Set();
    for (const catId of catIds) {
        for (const ancestorId of getAncestorIds(catId)) {
            const title = idToTitle[ancestorId];
            const h = title && titleToShopifyHandle[title];
            if (h) assignedHandles.add(h);
        }
    }

    if (assignedHandles.size === 0) { skippedProducts++; continue; }

    // Build complementary_products list from associated_products IDs
    const complementaryHandles = [];
    if (Array.isArray(product.associated_products)) {
        for (const assoc of product.associated_products) {
            const h = productIdToHandle[assoc.id];
            if (h) complementaryHandles.push(h);
        }
    }

    const row = {
        'Handle': handle,
        'Custom Collections': [...assignedHandles].join(', '),
    };
    if (complementaryHandles.length > 0) {
        row['Metafield: shopify--discovery--product_recommendation.complementary_products [list.product_reference]'] = complementaryHandles.join(', ');
    }

    productRows.push(row);
}

// ─── Write XLSX (Products sheet only) ────────────────────────────────────────
const ws = XLSX.utils.json_to_sheet(productRows);
if (productRows.length > 0) {
    ws['!cols'] = Object.keys(productRows[0]).map(key => ({
        wch: Math.max(key.length, ...productRows.slice(0, 200).map(r => String(r[key] || '').length)),
    }));
}

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Products');
XLSX.writeFile(wb, outputXlsxPath);

console.log(`\nProducts assigned : ${productRows.length}`);
console.log(`Skipped products  : ${skippedProducts} (no handle, no category, or no matching Shopify collection)`);
console.log(`Output            : ${outputXlsxPath}`);
console.log('\nImport this file via Matrixify (Products sheet only) to update collection assignments.');
