/**
 * Differential Fyrklovern to Shopify migration helpers.
 *
 * The module deliberately treats the Norce files as patches: an empty or
 * missing source value never clears Shopify.  This makes the command safe to
 * run for subsequent top-up exports which contain only changed data.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { adaptProduct, buildDynamicFieldsByProductId, buildHandleByProductId, buildImagesByArticleNumber } = require('../importers/fyrklovern/productdata');
const { readCategorieslocalized } = require('../importers/fyrklovern/categorieslocalized');
const { transformProduct } = require('../transformers/product-transformer');
const { buildProductRow } = require('../exporters/matrixify-products');
const { sanitizeForShopify } = require('../utils/html');
const { slugify } = require('../utils/handles');

const CONFIG = {
    taxClasses: { 2: 25 }, specFields: {}, blankVendor: true,
    includeManufacturerName: false, includeInventoryFields: false,
    includeDescriptionShort: false,
    excludedMetafieldKeys: ['price_history_cutoff_date_yyyy_mm_dd'],
    booleanMetafieldKeys: ['chargeable', 'dimmer', 'dishwasher_safe', 'lights_included', 'microwave_safe'],
};
const PRODUCT_FIELDS = ['Title', 'Body HTML', 'SEO Title', 'SEO Description'];
const TRANSLATION_FIELDS = {
    name: 'Title', description: 'Body HTML', pagetitle: 'SEO Title', metadescription: 'SEO Description',
};

function clean(value) { return value == null || value === 'NULL' ? '' : String(value).trim(); }
function key(value) { return clean(value).toLocaleLowerCase('sv-SE'); }
function normalizeSku(value) { return clean(value).replace(/^'+/, ''); }
function normalizeUrl(value) { return clean(value).replace(/^http:\/\//i, 'https://').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase(); }
function normalizeText(value) { return clean(value).replace(/\s+/g, ' '); }
function normalizeHtml(value) { return normalizeText(sanitizeForShopify(clean(value))); }
function normalizeList(value) {
    const raw = clean(value);
    if (!raw) return [];
    try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return parsed.map(normalizeText); } catch (_) { /* Matrixify also accepts comma lists. */ }
    return raw.split(/[;,\n]/).map(normalizeText).filter(Boolean);
}
function sameValue(header, left, right) {
    if (header.startsWith('Metafield:') && header.includes('[list.')) {
        return JSON.stringify(normalizeList(left)) === JSON.stringify(normalizeList(right));
    }
    if (header === 'Body HTML') return normalizeHtml(left) === normalizeHtml(right);
    return normalizeText(left) === normalizeText(right);
}
function readRows(filePath, sheetName) {
    if (!fs.existsSync(filePath)) throw new Error(`Required input file not found: ${filePath}`);
    const workbook = XLSX.readFile(filePath, { raw: false, codepage: 65001 });
    const sheet = workbook.Sheets[sheetName || workbook.SheetNames[0]];
    if (!sheet) throw new Error(`Worksheet "${sheetName}" was not found in ${filePath}`);
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}
function writeWorkbook(rows, headers, output, sheetName) {
    const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(Math.max(headers.length - 1, 0))}${Math.max(rows.length + 1, 1)}` };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, output);
}
function parseCsvRecord(text) {
    const values = []; let current = ''; let quoted = false;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '"') { if (quoted && text[i + 1] === '"') { current += '"'; i++; } else quoted = !quoted; }
        else if (text[i] === ',' && !quoted) { values.push(current); current = ''; } else current += text[i];
    }
    values.push(current); return values;
}
function readTranslationRows(filePath) {
    const wb = XLSX.readFile(filePath, { raw: false, codepage: 65001 });
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
    if (clean(matrix[0]?.[0]).startsWith('Type,Identification,Field,Locale,')) {
        const headers = parseCsvRecord(matrix[0][0]);
        return matrix.slice(1).filter(row => clean(row[0])).map(row => {
            const values = parseCsvRecord(row[0]); return Object.fromEntries(headers.map((h, i) => [h, values[i] || '']));
        });
    }
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
}
function sourceProducts(paths) {
    const latest = readRows(paths.productData);
    const fullWorkbook = XLSX.readFile(paths.customExport, { raw: false });
    const dynamic = buildDynamicFieldsByProductId(XLSX.utils.sheet_to_json(fullWorkbook.Sheets.dynamicfields, { defval: '', raw: false }));
    const permalink = buildHandleByProductId(readRows(paths.productPermalinks, 'Sheet1'));
    const imageOrder = buildImagesByArticleNumber(readRows(paths.imageOrder, 'Sheet1'));
    return latest.filter(row => clean(row.ProductID) && clean(row.ArticleNumber)).map(row =>
        adaptProduct(row, dynamic, permalink, imageOrder)
    );
}
function indexLiveProducts(rows) {
    const bySku = new Map(), byHandle = new Map();
    for (const row of rows) {
        const handle = clean(row.Handle); const sku = normalizeSku(row['Variant SKU']);
        if (!handle) continue;
        if (!byHandle.has(key(handle))) byHandle.set(key(handle), { handle, id: clean(row.ID), rows: [], base: row });
        const item = byHandle.get(key(handle)); item.rows.push(row);
        if (Object.keys(row).some(column => column.startsWith('Metafield:')) || sku) item.base = row;
        if (sku && !bySku.has(sku)) bySku.set(sku, item);
    }
    return { bySku, byHandle };
}
function liveProduct(index, product) { return index.bySku.get(normalizeSku(product.article_number)) || index.byHandle.get(key(product.handle)); }
function expectedProductRow(product, collectionsById) {
    const normalized = transformProduct(product, CONFIG);
    const row = buildProductRow(normalized, CONFIG, {})[0];
    const collections = (product.category_ids || []).map(id => collectionsById.get(clean(id))).filter(Boolean);
    if (collections.length) row['Custom Collections'] = [...new Set(collections)].join(', ');
    return row;
}
function expectedNewProductRows(product, collectionsById) {
    const normalized = transformProduct(product, CONFIG);
    const rows = buildProductRow(normalized, CONFIG, {});
    const collections = (product.category_ids || []).map(id => collectionsById.get(clean(id))).filter(Boolean);
    rows[0].Command = 'NEW';
    if (collections.length) rows[0]['Custom Collections'] = [...new Set(collections)].join(', ');
    return rows;
}
function productUpdates(products, liveIndex, collectionsById, report) {
    const rows = [];
    for (const product of products) {
        const expected = expectedProductRow(product, collectionsById); const current = liveProduct(liveIndex, product);
        const expectedFields = [...PRODUCT_FIELDS, ...Object.keys(expected).filter(h => h.startsWith('Metafield:'))];
        if (!current) {
            rows.push(...expectedNewProductRows(product, collectionsById)); report.products.new.push({ sku: product.article_number, handle: product.handle });
            if (!Object.keys(product.specifications.metafields || {}).length) report.sourceMissing.dynamicFields.push(product.article_number);
            continue;
        }
        const changed = { Handle: current.handle, Command: 'UPDATE' }; let count = 0;
        for (const field of expectedFields) {
            const desired = expected[field];
            if (!clean(desired) || sameValue(field, desired, current.base[field])) continue;
            changed[field] = desired; count++;
        }
        if (count) { rows.push(changed); report.products.updated.push({ sku: product.article_number, handle: current.handle, fields: count }); }
        else report.products.unchanged.push(product.article_number);
    }
    return rows;
}
function mediaUpdates(products, liveIndex, report) {
    const rows = [];
    for (const product of products) {
        const current = liveProduct(liveIndex, product); if (!current) continue;
        const liveMedia = new Map(current.rows.filter(r => clean(r['Image Src'])).map(r => [normalizeUrl(r['Image Src']), r]));
        for (const [offset, image] of (product.images || []).entries()) {
            const existing = liveMedia.get(normalizeUrl(image.url?.full)); const desiredPosition = String(offset + 1);
            if (existing && clean(existing['Image Position']) === desiredPosition && normalizeText(existing['Image Alt Text']) === normalizeText(product.name.sv)) continue;
            rows.push({ Handle: current.handle, Command: 'UPDATE', 'Image Command': 'MERGE', 'Image Src': image.url.full, 'Image Position': desiredPosition, 'Image Alt Text': product.name.sv });
        }
    }
    report.media.updated = rows.length; return rows;
}
function collectionUpdates(paths, products, liveIndex, categoryHandles, liveCollections, report) {
    const source = readRows(paths.categorySortOrder); const productBySku = new Map(products.map(product => [normalizeSku(product.article_number), product]));
    const byHandle = new Map();
    for (const row of liveCollections) {
        const handle = clean(row.Handle); if (!handle) continue;
        if (!byHandle.has(key(handle))) byHandle.set(key(handle), { handle, sortOrder: clean(row['Sort Order']), positions: new Map() });
        if (clean(row['Sort: Product Handle'])) byHandle.get(key(handle)).positions.set(key(row['Sort: Product Handle']), clean(row['Sort: Position']));
    }
    const result = []; const emittedManual = new Set();
    for (const row of source) {
        const product = productBySku.get(normalizeSku(row.ArticleNumber)); const sourceHandle = categoryHandles.get(clean(row.CategoryID));
        if (!product || !sourceHandle) { report.collections.unmatched.push({ sku: clean(row.ArticleNumber), categoryId: clean(row.CategoryID) }); continue; }
        const item = liveProduct(liveIndex, product); const productHandle = item?.handle || product.handle;
        const current = byHandle.get(key(sourceHandle));
        if (!current) { report.collections.unmatched.push({ sku: product.article_number, categoryId: clean(row.CategoryID), handle: sourceHandle }); continue; }
        const wanted = clean(row.SortOrder); if (!wanted || current.positions.get(key(productHandle)) === wanted && current.sortOrder.toLowerCase() === 'manual') continue;
        const update = { Handle: current.handle, Command: 'UPDATE', 'Sort: Product Handle': productHandle, 'Sort: Position': wanted };
        if (current.sortOrder.toLowerCase() !== 'manual' && !emittedManual.has(key(current.handle))) { update['Sort Order'] = 'Manual'; emittedManual.add(key(current.handle)); }
        result.push(update);
    }
    report.collections.updated = result.length; return result;
}
function recommendationUpdates(paths, products, liveIndex, report) {
    const productBySku = new Map(products.map(product => [normalizeSku(product.article_number), product])); const grouped = new Map();
    for (const row of readRows(paths.relatedProducts)) {
        const owner = normalizeSku(row['Huvudprodukt Artikelnummer']); if (!owner) continue;
        const targets = clean(row['Kopplad produkt Artikelnummer']).split(';').map(normalizeSku).filter(Boolean);
        if (!grouped.has(owner)) grouped.set(owner, []);
        grouped.get(owner).push({ order: Number(clean(row.SortOrder)) || 0, targets });
    }
    const field = 'Metafield: custom.recommended_products [list.product_reference]'; const rows = [];
    for (const [ownerSku, groups] of grouped) {
        const owner = productBySku.get(ownerSku); if (!owner) { report.recommendations.unmatched.push(ownerSku); continue; }
        const liveOwner = liveProduct(liveIndex, owner); if (!liveOwner) { report.recommendations.deferred.push(ownerSku); continue; }
        const handles = []; for (const group of groups.sort((a, b) => a.order - b.order)) for (const sku of group.targets) {
            const target = productBySku.get(sku); const liveTarget = target && liveProduct(liveIndex, target); const handle = liveTarget?.handle || target?.handle;
            if (handle && handle !== liveOwner.handle && !handles.includes(handle)) handles.push(handle); else if (!handle) report.recommendations.unresolvedTargets.push(sku);
        }
        if (handles.length && JSON.stringify(handles) !== JSON.stringify(normalizeList(liveOwner.base[field]))) rows.push({ Handle: liveOwner.handle, Command: 'UPDATE', [field]: handles.join(',') });
    }
    report.recommendations.updated = rows.length; return rows;
}
function translationPayload(paths, products, liveIndex, report) {
    const wb = XLSX.readFile(paths.customExport, { raw: false }); const localized = XLSX.utils.sheet_to_json(wb.Sheets.productslocalized, { defval: '', raw: false });
    const byProduct = new Map(); for (const row of localized) { const id = clean(row.productid); const locale = clean(row.culture); if (id && locale) { if (!byProduct.has(id)) byProduct.set(id, new Map()); byProduct.get(id).set(locale.split('-')[0], row); } }
    const translations = readTranslationRows(paths.translationExport); const liveByTitle = new Map(); const currentValues = new Map();
    for (const row of translations) {
        if (key(row.Type) !== 'product') continue; const field = key(row.Field); const locale = key(row.Locale).split('-')[0]; const id = clean(row.Identification).replace(/^'/, '');
        if (field === 'title' && key(row.Locale).startsWith('sv')) liveByTitle.set(key(row['Default content']), id);
        currentValues.set(`${id}|${field}|${locale}`, {
            value: clean(row['Translated content']),
            defaultContent: clean(row['Default content']),
            type: clean(row.Type), market: clean(row.Market), status: clean(row.Status),
        });
    }
    const matrix = []; const native = []; const matrixHeaders = ['Entity', 'Entity ID', 'Entity Handle', 'Field', 'Original Value', 'Translation Value: da', 'Translation Value: de', 'Translation Value: en', 'Translation Value: fi', 'Translation Value: nl'];
    for (const product of products) {
        const local = byProduct.get(clean(product.id)); if (!local) { report.translations.sourceMissing.push(product.article_number); continue; }
        const live = liveProduct(liveIndex, product); const entityId = live?.id || liveByTitle.get(key(product.name.sv)) || ''; const handle = live?.handle || product.handle;
        for (const [sourceField, matrixField] of Object.entries(TRANSLATION_FIELDS)) {
            const values = {}; for (const locale of ['da', 'de', 'en', 'fi', 'nl']) values[locale] = clean(local.get(locale)?.[sourceField]);
            if (!Object.values(values).some(Boolean)) continue;
            const changed = Object.entries(values).filter(([locale, value]) =>
                value && currentValues.get(`${entityId}|${key(matrixField)}|${locale}`)?.value !== value
            );
            if (!changed.length) continue;
            matrix.push({ Entity: 'Product', 'Entity ID': entityId, 'Entity Handle': handle, Field: matrixField, 'Original Value': product.name.sv, ...Object.fromEntries(Object.entries(values).map(([locale, value]) => [`Translation Value: ${locale}`, value])) });
            if (!entityId) { report.translations.deferred.push({ sku: product.article_number, field: matrixField }); continue; }
            for (const [locale, value] of changed) {
                const existing = currentValues.get(`${entityId}|${key(matrixField)}|${locale}`);
                native.push({
                    Type: existing?.type || 'PRODUCT', Identification: entityId,
                    Field: sourceField === 'name' ? 'title' : sourceField, Locale: locale,
                    Market: existing?.market || '', Status: existing?.status || '',
                    'Default content': existing?.defaultContent || product.name.sv,
                    'Translated content': value,
                });
            }
        }
    }
    report.translations.matrixify = matrix.length; report.translations.native = native.length;
    return { matrix, native, matrixHeaders };
}
function runMigration(paths) {
    const required = ['productData', 'customExport', 'productPermalinks', 'imageOrder', 'categorySortOrder', 'relatedProducts', 'liveProducts', 'liveCollections', 'translationExport'];
    for (const name of required) if (!paths[name]) throw new Error(`Missing required --${name} input.`);
    const outputDir = paths.outputDir; fs.mkdirSync(outputDir, { recursive: true });
    const report = { products: { new: [], updated: [], unchanged: [] }, media: {}, collections: { updated: 0, unmatched: [] }, recommendations: { updated: 0, unmatched: [], deferred: [], unresolvedTargets: [] }, translations: { matrixify: 0, native: 0, deferred: [], sourceMissing: [] }, sourceMissing: { dynamicFields: [] }, generatedAt: new Date().toISOString() };
    const products = sourceProducts(paths); const categories = readCategorieslocalized(paths.customExport); const categoryHandles = new Map(categories.map(c => [clean(c.id), clean(c.handle)]));
    const liveIndex = indexLiveProducts(readRows(paths.liveProducts, 'Products'));
    const productRows = productUpdates(products, liveIndex, categoryHandles, report);
    const mediaRows = mediaUpdates(products, liveIndex, report);
    const collectionRows = collectionUpdates(paths, products, liveIndex, categoryHandles, readRows(paths.liveCollections, 'Collections'), report);
    const recommendationRows = recommendationUpdates(paths, products, liveIndex, report);
    const translated = translationPayload(paths, products, liveIndex, report);
    const files = { products: path.join(outputDir, 'fyrklovern-topup-products.xlsx'), media: path.join(outputDir, 'fyrklovern-topup-media.xlsx'), collections: path.join(outputDir, 'fyrklovern-topup-collection-sortorder.xlsx'), recommendations: path.join(outputDir, 'fyrklovern-topup-recommendations.xlsx'), matrixifyTranslations: path.join(outputDir, 'fyrklovern-topup-translations.xlsx'), shopifyTranslations: path.join(outputDir, 'fyrklovern-topup-shopify-language-translations.csv'), report: path.join(outputDir, 'fyrklovern-topup-report.json') };
    writeWorkbook(productRows, [...new Set(productRows.flatMap(Object.keys))], files.products, 'Products');
    writeWorkbook(mediaRows, ['Handle', 'Command', 'Image Command', 'Image Src', 'Image Position', 'Image Alt Text'], files.media, 'Products');
    writeWorkbook(collectionRows, ['Handle', 'Command', 'Sort Order', 'Sort: Product Handle', 'Sort: Position'], files.collections, 'Collections');
    writeWorkbook(recommendationRows, ['Handle', 'Command', 'Metafield: custom.recommended_products [list.product_reference]'], files.recommendations, 'Products');
    writeWorkbook(translated.matrix, translated.matrixHeaders, files.matrixifyTranslations, 'Translations');
    const nativeHeaders = ['Type', 'Identification', 'Field', 'Locale', 'Market', 'Status', 'Default content', 'Translated content'];
    const csvWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(csvWorkbook, XLSX.utils.json_to_sheet(translated.native, { header: nativeHeaders }), 'Translations');
    XLSX.writeFile(csvWorkbook, files.shopifyTranslations, { bookType: 'csv', FS: ',', RS: '\n' });
    report.files = files; fs.writeFileSync(files.report, JSON.stringify(report, null, 2) + '\n'); return { files, report };
}

module.exports = { clean, normalizeSku, normalizeUrl, normalizeList, sameValue, parseCsvRecord, readTranslationRows, indexLiveProducts, sourceProducts, runMigration };
