const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// ─── Paths ────────────────────────────────────────────────────────────────────
const collectionsPath = path.join(__dirname, '../results/collections.json');
const productsPath = path.join(__dirname, '../results/products.json');
const outputXlsxPath = path.join(__dirname, '../results/matrixify-collections.xlsx');

// ─── Load data ────────────────────────────────────────────────────────────────
const collectionsRaw = JSON.parse(fs.readFileSync(collectionsPath, 'utf8'));
const collections = Array.isArray(collectionsRaw)
    ? collectionsRaw
    : (Array.isArray(collectionsRaw.list) ? collectionsRaw.list : []);

const productsRaw = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
const products = Array.isArray(productsRaw)
    ? productsRaw
    : (Array.isArray(productsRaw.list) ? productsRaw.list : []);

// ─── Build collection ID → collection map ────────────────────────────────────
const idToCollection = {};
for (const col of collections) {
    idToCollection[col.id] = col;
}

// ─── Slugify a string into a Shopify-compatible handle ───────────────────────
function slugify(str) {
    return str
        .toLowerCase()
        .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

// ─── Extract handle from seo_link (last path segment) ────────────────────────
// Used only as fallback before titles are computed.
function collectionHandleFromSeo(col) {
    const seoLink = (col.seo_link && (col.seo_link.sv || col.seo_link.en)) || '';
    if (seoLink) {
        const parts = seoLink.replace(/\/+$/, '').split('/');
        const slug = parts[parts.length - 1];
        if (slug) return slug;
    }
    const name = (col.name && (col.name.sv || col.name.en)) || 'collection-' + col.id;
    return slugify(name);
}

// ─── Helper: get trimmed name for a collection ───────────────────────────────
function rawName(col) {
    return ((col.name && (col.name.sv || col.name.en)) || '').trim();
}

// ─── Build full ancestor path for a collection (root → leaf) ─────────────────
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
    return parts; // e.g. ["Plastfickor och Tillbehör", "Standardstorlek", "Med motiv", "Anime / Manga"]
}

// ─── Build unique titles: always "Parent - Child", or just name for top-level ─
// For deeper duplicates, keep prepending ancestors until unique.
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

    const path = ancestorPath(col); // root → leaf

    // Top-level collection (no parent): use name as-is
    if (path.length <= 1) return name;

    const sameNameIds = (leafNameToIds[name] || []).filter(id => id !== col.id);

    // Always include at least the immediate parent (depth=2: parent + leaf).
    // If that's still not unique, keep prepending until it is.
    const minDepth = 2;
    for (let depth = minDepth; depth <= path.length; depth++) {
        const candidate = path.slice(path.length - depth).join(' - ');
        const hasConflict = sameNameIds.some(id => {
            const other = idToCollection[id];
            if (!other) return false;
            const otherPath = ancestorPath(other);
            return otherPath.slice(otherPath.length - depth).join(' - ') === candidate;
        });
        if (!hasConflict) return candidate;
    }
    // Absolute last resort: full path + ID
    return path.join(' - ') + ' (' + col.id + ')';
}

// ─── Build ID → title and ID → handle maps (ALL collections, incl. inactive) ─
// Handles use the seo_link last segment (matches Vendre/Shopify URL slugs).
// Titles use the disambiguated parent-prefixed form for uniqueness in the Shopify UI.
const idToTitle = {};
const idToHandle = {};

function seoHandle(col) {
    const seoLink = (col.seo_link && (col.seo_link.sv || col.seo_link.en)) || '';
    if (seoLink) {
        const parts = seoLink.replace(/\/+$/, '').split('/');
        const slug = parts[parts.length - 1];
        if (slug) return slug;
    }
    return slugify((col.name && (col.name.sv || col.name.en)) || 'collection-' + col.id);
}

for (const col of collections) {
    const title = collectionTitle(col);
    if (!title) continue;
    idToTitle[col.id] = title;
    idToHandle[col.id] = seoHandle(col);
}

// Detect handle collisions (e.g. multiple leaf nodes with the same seo slug like 'kmc').
// Append the collection ID only for the colliding ones.
const handleCount = {};
Object.values(idToHandle).forEach(h => { handleCount[h] = (handleCount[h] || 0) + 1; });
const duplicateHandles = new Set(Object.keys(handleCount).filter(h => handleCount[h] > 1));
if (duplicateHandles.size > 0) {
    for (const col of collections) {
        if (col.id && duplicateHandles.has(idToHandle[col.id])) {
            idToHandle[col.id] = idToHandle[col.id] + '-' + col.id;
        }
    }
}

// ─── Product handle (last segment of seo_link) ───────────────────────────────
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

// ─── Sheet 1: Custom Collections (all collections; inactive = unpublished) ───
const collectionRows = [];
for (const col of collections) {
    const title = idToTitle[col.id];
    const handle = idToHandle[col.id];
    if (!title || !handle) continue;

    const bodyHtml = (col.description && (col.description.sv || col.description.en)) || '';
    const seoTitle = (col.seo_title && (col.seo_title.sv || col.seo_title.en)) || '';
    const seoDesc = (col.meta_description && (col.meta_description.sv || col.meta_description.en)) || '';

    collectionRows.push({
        'Handle': handle,
        'Title': title,
        'Body HTML': bodyHtml,
        'SEO Title': seoTitle,
        'SEO Description': seoDesc,
        'Published': col.status ? 'TRUE' : 'FALSE',
        'Sort Order': 'manual',
    });
}

// ─── Walk up ancestry chain for a collection ID ──────────────────────────────
// Returns all ancestor IDs including the id itself (leaf → root order)
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

// ─── Sheet 2: Products — assign each product to its collections + all ancestors
const productRows = [];
let skippedProducts = 0;

for (const product of products) {
    const handle = productHandle(product);
    if (!handle) { skippedProducts++; continue; }

    const catIds = product.category_ids;
    if (!catIds || catIds.length === 0) { skippedProducts++; continue; }

    // Collect this collection + all ancestor collections for each category_id
    const assignedHandles = new Set();
    for (const catId of catIds) {
        for (const ancestorId of getAncestorIds(catId)) {
            const h = idToHandle[ancestorId];
            if (h) assignedHandles.add(h);
        }
    }

    if (assignedHandles.size === 0) { skippedProducts++; continue; }

    productRows.push({
        'Handle': handle,
        'Custom Collections': [...assignedHandles].join(', '),
    });
}

// ─── Write XLSX with two sheets ───────────────────────────────────────────────
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(collectionRows), 'Custom Collections');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(productRows), 'Products');
XLSX.writeFile(wb, outputXlsxPath);

// ─── Write all-collections.json (all collections from real data) ─────────────
const allCollectionsJson = collectionRows.map(r => r['Title']).sort();
fs.writeFileSync(
    path.join(__dirname, '../results/all-collections.json'),
    JSON.stringify(allCollectionsJson, null, 2),
    'utf8'
);

const active = collections.filter(c => c.status).length;
const inactive = collections.filter(c => !c.status).length;
console.log(`Total collections : ${collections.length} (from collections.json)`);
console.log(`  Active (Published=TRUE)  : ${active}`);
console.log(`  Inactive (Published=FALSE): ${inactive}`);
console.log(`Collections sheet : ${collectionRows.length} total`);
console.log(`Products sheet    : ${productRows.length} products assigned`);
console.log(`Skipped products  : ${skippedProducts} (no handle or no matching collection)`);
console.log(`Output            : ${outputXlsxPath}`);