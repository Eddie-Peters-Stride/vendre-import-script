require('dotenv').config();
const axios = require('axios');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ─── Paths ────────────────────────────────────────────────────────────────────
const BASE_URL = 'https://dragonslair.se/API/1/products';
const PAGE_SIZE = 250;
const BASELINE_PATH = path.join(__dirname, '..', 'results', 'products.json');
const TOPUP_PATH = path.join(__dirname, '..', 'results', 'products-topup.json');
const OUTPUT_XLSX = path.join(__dirname, '..', 'results', 'matrixify-topup.xlsx');
const TAGS_PATH = path.join(__dirname, '..', 'tags.json');
const COLLECTIONS_PATH = path.join(__dirname, '..', 'results', 'collections.json');
const COLLECTIONS_XLSX = path.join(__dirname, '..', 'results', 'collections.xlsx');

// ─── Load tags ────────────────────────────────────────────────────────────────
const tagsMap = JSON.parse(fs.readFileSync(TAGS_PATH, 'utf8'));

// ─── Build existing product ID set from baseline products.json ────────────────
console.log('Loading baseline products.json...');
const baselineData = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
const baselineProducts = Array.isArray(baselineData)
    ? baselineData
    : (Array.isArray(baselineData.list) ? baselineData.list : []);
const existingIds = new Set(baselineProducts.map(p => p.id));
console.log(`Baseline: ${existingIds.size} existing product IDs loaded.`);

// ─── Load collections — same approach as updateProductCollections.js ──────────
const collectionsRaw = JSON.parse(fs.readFileSync(COLLECTIONS_PATH, 'utf8'));
const collections = Array.isArray(collectionsRaw)
    ? collectionsRaw
    : (Array.isArray(collectionsRaw.list) ? collectionsRaw.list : []);

// Build collection ID → collection object map
const idToCollection = {};
for (const col of collections) { idToCollection[col.id] = col; }

// Disambiguation helpers (mirrors updateProductCollections.js / exportMatrixifyCollections.js)
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

// Build ID → disambiguated title map
const idToTitle = {};
for (const col of collections) {
    const title = collectionTitle(col);
    if (title) idToTitle[col.id] = title;
}

// Load authoritative title → Shopify handle map from collections.xlsx
const titleToShopifyHandle = {};
{
    const wb = XLSX.readFile(COLLECTIONS_XLSX);
    const ws = wb.Sheets['Custom Collections'];
    const rows = XLSX.utils.sheet_to_json(ws);
    for (const row of rows) {
        if (row['Handle'] && row['Title']) {
            titleToShopifyHandle[row['Title'].trim()] = row['Handle'].trim();
        }
    }
}
console.log(`Loaded ${Object.keys(titleToShopifyHandle).length} collection handles from collections.xlsx.`);

// Walk up the ancestor chain from a given category ID (leaf → root)
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

// Resolve a product's category_ids → Shopify collection handles (leaf + all ancestors)
function getShopifyCollections(product) {
    const catIds = product.category_ids;
    if (!catIds || catIds.length === 0) return '';
    const assignedHandles = new Set();
    for (const catId of catIds) {
        for (const ancestorId of getAncestorIds(catId)) {
            const title = idToTitle[ancestorId];
            const h = title && titleToShopifyHandle[title];
            if (h) assignedHandles.add(h);
        }
    }
    return [...assignedHandles].join(', ');
}

// ─── Vendre spec field IDs ────────────────────────────────────────────────────
const SPEC = {
    BGG_ID: 1603,
    YEAR_PUBLISHED: 1604,
    MIN_PLAYERS: 1605,
    MAX_PLAYERS: 1606,
    PLAY_TIME: 1608,
    MIN_AGE: 1609,
    BGG_WEIGHT: 1610,
    BGG_COMPLEXITY: 1611,
    MECHANICS: 1612,
    DESIGNERS: 1613,
    PUBLISHERS: 1614,
};

// ─── Helper functions (mirrors exportToExcel.js exactly) ─────────────────────
function getSpec(specifications, id, lang = 'sv') {
    if (!specifications || !specifications.text) return '';
    const spec = specifications.text.find(s => s.id === id);
    if (!spec) return '';
    return (spec.value && spec.value[lang]) || '';
}

function getHandle(product) {
    const seoLink = (product.seo_link && (product.seo_link.sv || product.seo_link.en)) || '';
    if (seoLink) {
        const parts = seoLink.replace(/\/+$/, '').split('/');
        const slug = parts[parts.length - 1];
        if (slug) return slug;
    }
    const name = (product.name && (product.name.sv || product.name.en)) || 'product-' + product.id;
    return name
        .toLowerCase()
        .replace(/[^a-z0-9åäöÅÄÖ]+/g, '-')
        .replace(/^-|-$/g, '');
}

function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

function getShortDesc(product, lang) {
    const short = product.description_short && product.description_short[lang];
    if (short && short.trim()) return stripHtml(short);
    const desc = product.description && product.description[lang];
    if (!desc) return '';
    const match = desc.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (match) return stripHtml(match[1]);
    return stripHtml(desc).split(/\n/)[0].trim();
}

function getProductTags(product) {
    const ids = product.tag_ids;
    if (!ids || !Array.isArray(ids)) return '';
    const tagSet = new Set();
    ids.forEach(id => {
        const full = tagsMap[String(id)];
        if (!full) return;
        const parts = full.split(' » ');
        tagSet.add(parts[parts.length - 1].trim());
    });
    return [...tagSet].join(', ');
}

function getTagsByPrefix(product, prefix) {
    if (!product.tag_ids || !Array.isArray(product.tag_ids)) return [];
    const values = [];
    for (const id of product.tag_ids) {
        const tag = tagsMap[String(id)];
        if (tag && tag.startsWith(prefix)) {
            const parts = tag.split(' » ');
            values.push(parts[parts.length - 1].trim());
        }
    }
    return [...new Set(values)];
}

function getPricing(product) {
    const price = product.price;
    const priceRek = product.price_rek;
    const priceSpecial = product.price_special;
    if (priceSpecial && priceSpecial < price) {
        return { variantPrice: priceSpecial, compareAtPrice: price };
    }
    if (priceRek && priceRek > price) {
        return { variantPrice: price, compareAtPrice: priceRek };
    }
    return { variantPrice: price, compareAtPrice: '' };
}

function toSingleLineList(val) {
    if (!val) return '';
    return val.split(/;/).map(v => v.trim()).filter(Boolean).join(', ');
}

// Built after new products are loaded (for related_products resolution within the new batch)
let productHandleMap = {};

function toMatrixifyRow(product) {
    const handle = getHandle(product);
    const title = (product.name && (product.name.sv || product.name.en)) || '';
    const bodyHtml = (product.description && (product.description.sv || product.description.en)) || '';
    const descShortHtml = getShortDesc(product, 'sv');
    const vendor = 'dragonslair-se';
    const customCollections = getShopifyCollections(product);
    const status = product.status ? 'Active' : 'Draft';
    const published = (product.show && product.status) ? 'TRUE' : 'FALSE';
    const imageSrc = product.images && product.images.length > 0
        ? product.images.map(img => img.url.full).join(';')
        : '';
    const imageAlt = product.images && product.images.length > 0
        ? product.images[0].description || title
        : '';
    const sku = product.external_id || '';
    const barcode = product.ean1 || '';
    const { variantPrice, compareAtPrice } = getPricing(product);
    const weight = product.weight || '';
    const weightUnit = weight ? 'kg' : '';
    const inventoryPolicy = product.stock_allow_checkout ? 'continue' : 'deny';
    const warehouseSvea = product.warehouses ? product.warehouses.find(w => w.external_id === 'svea') : null;
    const warehouseKung = product.warehouses ? product.warehouses.find(w => w.external_id === 'kung') : null;
    const metaTitle = (product.meta_title && (product.meta_title.sv || product.meta_title.en)) || '';
    const metaDescription = (product.meta_description && (product.meta_description.sv || product.meta_description.en)) || '';
    const bestPlayerCount = getTagsByPrefix(product, 'Sortera efter Bäst på Antal Spelare');
    const theme = getTagsByPrefix(product, 'Sortera efter Teman');
    const spelmekanik = getTagsByPrefix(product, 'Sortera efter Spelmekanik');
    const storlek = getTagsByPrefix(product, 'Sortera efter Storlek');
    const awards = getTagsByPrefix(product, 'Spel som vunnit priser');
    const mechanicsRaw = getSpec(product.specifications, SPEC.MECHANICS);
    const publishersRaw = getSpec(product.specifications, SPEC.PUBLISHERS);

    return {
        Handle: handle,
        Command: 'MERGE',
        Title: title,
        'Body HTML': bodyHtml,
        Vendor: vendor,
        Type: '',
        Tags: getProductTags(product),
        Status: status,
        Published: published,
        'Template Suffix': '',
        'Custom Collections': customCollections,
        'Image Src': imageSrc,
        'Image Alt Text': imageAlt,
        'Image Position': imageSrc ? 1 : '',
        'Variant SKU': sku,
        'Variant Barcode': barcode,
        'Variant Price': variantPrice,
        'Variant Compare At Price': compareAtPrice,
        'Variant Weight': weight,
        'Variant Weight Unit': weightUnit,
        'Variant Inventory Tracker': 'shopify',
        'Variant Inventory Policy': inventoryPolicy,
        'Variant Requires Shipping': 'TRUE',
        'Variant Taxable': 'TRUE',
        'Variant Fulfillment Service': 'manual',
        'Inventory Available: Sveavägen 118': warehouseSvea != null ? warehouseSvea.quantity : '',
        'Inventory Available: Kungsholmstorg 8': warehouseKung != null ? warehouseKung.quantity : '',
        'Metafield: title_tag [string]': metaTitle,
        'Metafield: description_tag [string]': metaDescription,
        'Metafield: custom.description_short [multi_line_text_field]': descShortHtml,
        'Metafield: custom.manufacturer_sku [single_line_text_field]': product.manufacturer_model || '',
        'Metafield: custom.bgg_id [single_line_text_field]': getSpec(product.specifications, SPEC.BGG_ID),
        'Metafield: custom.year_published [single_line_text_field]': getSpec(product.specifications, SPEC.YEAR_PUBLISHED),
        'Metafield: custom.min_players [single_line_text_field]': getSpec(product.specifications, SPEC.MIN_PLAYERS),
        'Metafield: custom.max_players [single_line_text_field]': getSpec(product.specifications, SPEC.MAX_PLAYERS),
        'Metafield: custom.play_time_minutes [single_line_text_field]': getSpec(product.specifications, SPEC.PLAY_TIME),
        'Metafield: custom.min_age [single_line_text_field]': getSpec(product.specifications, SPEC.MIN_AGE),
        'Metafield: custom.bgg_weight [single_line_text_field]': getSpec(product.specifications, SPEC.BGG_WEIGHT),
        'Metafield: custom.bgg_complexity [single_line_text_field]': getSpec(product.specifications, SPEC.BGG_COMPLEXITY),
        'Metafield: custom.mechanics [list.single_line_text_field]': toSingleLineList(mechanicsRaw),
        'Metafield: custom.designers [list.single_line_text_field]': toSingleLineList(getSpec(product.specifications, SPEC.DESIGNERS)),
        'Metafield: custom.publishers [list.single_line_text_field]': toSingleLineList(publishersRaw),
        'Metafield: custom.best_player_count [list.single_line_text_field]': bestPlayerCount.join(', '),
        'Metafield: custom.theme [list.single_line_text_field]': theme.join(', '),
        'Metafield: custom.spelmekanik [list.single_line_text_field]': spelmekanik.join(', '),
        'Metafield: custom.storlek [list.single_line_text_field]': storlek.join(', '),
        'Metafield: custom.awards [list.single_line_text_field]': awards.join(', '),
        'Metafield: custom.related_products [list.product_reference]': (() => {
            if (!product.associated_products || product.associated_products.length === 0) return '';
            return product.associated_products
                .map(ap => productHandleMap[ap.id])
                .filter(Boolean)
                .join(', ');
        })(),
    };
}

function makeSheet(dataRows) {
    const ws = XLSX.utils.json_to_sheet(dataRows);
    if (dataRows.length > 0) {
        const colWidths = Object.keys(dataRows[0]).map(key => {
            const maxLen = Math.max(
                key.length,
                ...dataRows.map(r => {
                    const val = r[key] != null ? String(r[key]) : '';
                    return Math.min(val.length, 80);
                })
            );
            return { wch: maxLen + 2 };
        });
        ws['!cols'] = colWidths;
    }
    return ws;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    // 1. Fetch all products fresh from Vendre API
    console.log('Fetching fresh products from Vendre API...');
    const freshProducts = [];
    let offset = 0;
    let remaining = 1;

    while (remaining > 0) {
        const response = await axios.get(BASE_URL, {
            params: { page_size: PAGE_SIZE, offset },
            headers: {
                Accept: 'application/json',
                'X-Authorization': process.env.SECRET_KEY,
            },
        });
        const data = response.data;
        freshProducts.push(...data.list);
        remaining = data.remaining;
        offset += PAGE_SIZE;
        console.log(`  Fetched ${freshProducts.length} products so far, ${remaining} remaining...`);
    }
    console.log(`Fresh fetch complete: ${freshProducts.length} total products from API.`);

    // 2. Filter to new products only
    const newProducts = freshProducts.filter(p => !existingIds.has(p.id));
    console.log(`\nComparison result:`);
    console.log(`  Existing (baseline) IDs : ${existingIds.size}`);
    console.log(`  Fresh fetch total       : ${freshProducts.length}`);
    console.log(`  New products (top-up)   : ${newProducts.length}`);

    if (newProducts.length === 0) {
        console.log('\nNo new products found. Nothing to export.');
        return;
    }

    // 3. Save new products to products-topup.json
    fs.writeFileSync(TOPUP_PATH, JSON.stringify({ list: newProducts }, null, 2), 'utf8');
    console.log(`\nSaved ${newProducts.length} new products to: ${TOPUP_PATH}`);

    // 4. Build id→handle map from the new batch (for related_products cross-references within new batch)
    newProducts.forEach(p => { productHandleMap[p.id] = getHandle(p); });

    // 5. Generate Matrixify rows
    const rows = newProducts.map(toMatrixifyRow);

    // 6. Write XLSX
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, makeSheet(rows), 'Products');
    XLSX.writeFile(wb, OUTPUT_XLSX);
    console.log(`Matrixify import file written to: ${OUTPUT_XLSX}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Import ${path.basename(OUTPUT_XLSX)} into Shopify via Matrixify`);
    console.log(`  2. Export fresh Shopify product CSVs to results/ (e.g. products_export_3.csv)`);
    console.log(`  3. Export fresh Shopify translation CSVs to results/`);
    console.log(`  4. Run: npm run topup-translations`);
}

main().catch(err => {
    if (err.response) {
        console.error(`HTTP ${err.response.status}:`, JSON.stringify(err.response.data, null, 2));
    } else {
        console.error(err.message);
    }
    process.exit(1);
});
