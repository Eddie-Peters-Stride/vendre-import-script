const fs = require('fs');
const path = require('path');

// ─── Paths ────────────────────────────────────────────────────────────────────
const RESULTS_DIR = path.join(__dirname, '..', 'results');
const TOPUP_PATH = path.join(RESULTS_DIR, 'products-topup.json');
const MAX_SIZE = 15 * 1024 * 1024; // 15 MB

// ─── Load products-topup.json ─────────────────────────────────────────────────
if (!fs.existsSync(TOPUP_PATH)) {
    console.error(`ERROR: ${TOPUP_PATH} not found.`);
    console.error('Run "npm run topup-products" first to fetch and save the new product batch.');
    process.exit(1);
}
const topupData = JSON.parse(fs.readFileSync(TOPUP_PATH, 'utf8'));
const products = Array.isArray(topupData) ? topupData : (Array.isArray(topupData.list) ? topupData.list : []);
console.log(`Loaded ${products.length} top-up products from products-topup.json.`);

// ─── CSV parser (same as exportToExcel.js) ────────────────────────────────────
function parseShopifyExportCsv(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const lines = [];
    let cur = '', inQ = false;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '"') { inQ = !inQ; cur += c; }
        else if (c === '\n' && !inQ) { lines.push(cur); cur = ''; }
        else { cur += c; }
    }
    if (cur) lines.push(cur);
    const splitLine = (line) => {
        const fields = []; let f = '', q = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') {
                if (q && line[i + 1] === '"') { f += '"'; i++; }
                else q = !q;
            } else if (c === ',' && !q) { fields.push(f); f = ''; }
            else f += c;
        }
        fields.push(f);
        return fields;
    };
    const headers = splitLine(lines[0]);
    return lines.slice(1).filter(l => l.trim()).map(l => {
        const vals = splitLine(l);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
        return obj;
    });
}

// ─── Build SKU→handle from ALL products_export_*.csv in results/ ─────────────
const skuToShopifyHandle = {};
const exportFiles = fs.readdirSync(RESULTS_DIR)
    .filter(f => /^products_export_.*\.csv$/i.test(f))
    .sort();
console.log(`Found product export CSVs: ${exportFiles.join(', ') || '(none)'}`);
exportFiles.forEach(fname => {
    parseShopifyExportCsv(path.join(RESULTS_DIR, fname)).forEach(row => {
        const handle = row['Handle'];
        const sku = row['Variant SKU'] && row['Variant SKU'].replace(/^'/, '');
        if (handle && sku && !skuToShopifyHandle[sku]) {
            skuToShopifyHandle[sku] = handle;
        }
    });
});
console.log(`Loaded ${Object.keys(skuToShopifyHandle).length} SKU→handle mappings.`);

// ─── Build handle→Shopify ID from ALL dragonslair-se_translations_*.csv ───────
const handleToShopifyId = {};
const translationFiles = fs.readdirSync(RESULTS_DIR)
    .filter(f => /^dragonslair-se_translations_.*\.csv$/i.test(f))
    .sort();
console.log(`Found translation export CSVs: ${translationFiles.join(', ') || '(none)'}`);
translationFiles.forEach(fname => {
    parseShopifyExportCsv(path.join(RESULTS_DIR, fname)).forEach(row => {
        if (row['Field'] === 'handle' && row['Identification'] && row['Default content']) {
            const id = row['Identification'].replace(/^'/, '');
            const handle = row['Default content'].trim();
            if (handle && id && !handleToShopifyId[handle]) {
                handleToShopifyId[handle] = id;
            }
        }
    });
});
console.log(`Loaded ${Object.keys(handleToShopifyId).length} handle→ID mappings.`);

// ─── Helper functions ─────────────────────────────────────────────────────────
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

function toTranslationRows(product, shopifyId) {
    const rows = [];
    const push = (field, defaultValue, translatedValue) => {
        if (defaultValue && defaultValue.trim() && translatedValue && translatedValue.trim()) {
            rows.push({
                Type: 'PRODUCT',
                Identification: shopifyId,
                Field: field,
                Locale: 'en',
                Market: '',
                Status: '',
                'Default content': defaultValue || '',
                'Translated content': translatedValue,
            });
        }
    };
    push('title', product.name && product.name.sv, product.name && product.name.en);
    push('body_html', product.description && product.description.sv, product.description && product.description.en);
    push('meta_title', product.meta_title && product.meta_title.sv, product.meta_title && product.meta_title.en);
    push('meta_description', product.meta_description && product.meta_description.sv, product.meta_description && product.meta_description.en);
    const shortSv = getShortDesc(product, 'sv');
    const shortEn = getShortDesc(product, 'en');
    if (shortSv && shortEn) push('metafield.custom.description_short', shortSv, shortEn);
    return rows;
}

function escapeCsvField(val) {
    let s = val != null ? String(val) : '';
    if (s.includes('"')) s = s.replace(/"/g, '""');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) s = `"${s}"`;
    return s;
}

function writeCsvParts(allRows, headers, baseFilename) {
    const headerLine = headers.join(',');
    const csvLines = [headerLine];
    allRows.forEach(row => {
        csvLines.push(headers.map(h => escapeCsvField(row[h])).join(','));
    });

    let part = 1;
    let currentRows = [csvLines[0]];
    let currentSize = Buffer.byteLength('\uFEFF' + csvLines[0] + '\r\n', 'utf8');

    for (let i = 1; i < csvLines.length; i++) {
        const rowStr = csvLines[i];
        const rowSize = Buffer.byteLength(rowStr + '\r\n', 'utf8');
        if (currentSize + rowSize > MAX_SIZE && currentRows.length > 1) {
            const outPath = path.join(RESULTS_DIR, `${baseFilename}-part${part}.csv`);
            fs.writeFileSync(outPath, '\uFEFF' + currentRows.join('\r\n'), { encoding: 'utf8' });
            console.log(`Written: ${outPath}`);
            part++;
            currentRows = [csvLines[0]];
            currentSize = Buffer.byteLength('\uFEFF' + csvLines[0] + '\r\n', 'utf8');
        }
        currentRows.push(rowStr);
        currentSize += rowSize;
    }
    if (currentRows.length > 1) {
        const outPath = path.join(RESULTS_DIR, `${baseFilename}-part${part}.csv`);
        fs.writeFileSync(outPath, '\uFEFF' + currentRows.join('\r\n'), { encoding: 'utf8' });
        console.log(`Written: ${outPath}`);
    }
}

// ─── Build translation rows for top-up products ───────────────────────────────
const CSV_HEADERS = ['Type', 'Identification', 'Field', 'Locale', 'Market', 'Status', 'Default content', 'Translated content'];
const translationRows = [];
let skipped = 0;

products.forEach(product => {
    const sku = product.external_id || '';
    const shopifyHandle = skuToShopifyHandle[sku];
    if (!shopifyHandle) { skipped++; return; }
    const shopifyId = handleToShopifyId[shopifyHandle];
    if (!shopifyId) { skipped++; return; }
    translationRows.push(...toTranslationRows(product, shopifyId));
});

console.log(`\nBuilt ${translationRows.length} translation rows. Skipped ${skipped} products (no matching Shopify ID).`);

if (translationRows.length === 0) {
    console.log('No translations to write.');
    console.log('Make sure you have placed the fresh Shopify product export CSVs and translation export CSVs in the results/ folder after the Matrixify import.');
    process.exit(0);
}

// ─── Write full translations CSV ──────────────────────────────────────────────
writeCsvParts(translationRows, CSV_HEADERS, 'shopify-topup-translations');

// ─── Write short-desc-only translations CSV ───────────────────────────────────
const shortDescRows = translationRows.filter(r => r['Field'] === 'metafield.custom.description_short');
if (shortDescRows.length > 0) {
    console.log(`\nWriting ${shortDescRows.length} short-description translation rows...`);
    writeCsvParts(shortDescRows, CSV_HEADERS, 'shopify-topup-short-desc-translations');
} else {
    console.log('No short-description translation rows found.');
}

console.log('\nDone.');
