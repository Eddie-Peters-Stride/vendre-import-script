#!/usr/bin/env node
/**
 * Build a Matrixify Translations workbook for newly added Fyrklövern products.
 * Only source translations that actually exist are exported.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { buildHandleByProductId } = require('../../src/importers/fyrklovern/productdata');
const { sanitizeForShopify } = require('../../src/utils/html');
const { slugify } = require('../../src/utils/handles');

const ROOT = path.resolve(__dirname, '..', '..');
const FYRKLOVERN_DIR = path.resolve(ROOT, '..', '..', 'Fyrklövern');
const RESULTS_DIR = path.join(ROOT, 'results', 'fyrklovern');
const NEW_PRODUCT_SOURCE = path.join(FYRKLOVERN_DIR, 'fyrklovern_productdata_newexport.xlsx');
const MULTILINGUAL_SOURCE = path.join(FYRKLOVERN_DIR, 'fyrklovern_custom_export.xlsx');
const PERMALINKS = path.join(FYRKLOVERN_DIR, 'fyrklovern_productpermalinks.xlsx');
const STAGED_PRODUCTS = path.join(RESULTS_DIR, 'fyrklovern-products.json');
const OUTPUT = path.join(RESULTS_DIR, 'fyrklovern-matrixify-new-products-translations.xlsx');
const REPORT = path.join(RESULTS_DIR, 'fyrklovern-matrixify-new-products-translations-report.json');

const TARGET_LOCALES = {
    da: 'da-DK',
    de: 'de-DE',
    en: 'en-US',
    fi: 'fi-FI',
    nl: 'nl-NL',
};
const FIELDS = [
    ['Title', 'name'],
    ['Body HTML', 'description'],
    ['SEO Title', 'pagetitle'],
    ['SEO Description', 'metadescription'],
];
const HEADERS = [
    'Entity',
    'Entity ID',
    'Entity Handle',
    'Field',
    'Original Value',
    ...Object.keys(TARGET_LOCALES).map(locale => `Translation Value: ${locale}`),
];

function clean(value) {
    return value == null || value === 'NULL' ? '' : String(value).trim();
}

function readRows(filePath, sheetName) {
    const workbook = XLSX.readFile(filePath, { raw: false });
    const worksheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];
    if (!worksheet) throw new Error(`Worksheet not found: ${sheetName || '(first worksheet)'}`);
    return XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });
}

function toHtml(value) {
    return clean(value) ? sanitizeForShopify(clean(value)) : '';
}

function main() {
    const staged = JSON.parse(fs.readFileSync(STAGED_PRODUCTS, 'utf8')).list || [];
    const stagedIds = new Set(staged.map(product => clean(product.id)).filter(Boolean));
    const newSourceRows = readRows(NEW_PRODUCT_SOURCE)
        .filter(row => clean(row.ProductID) && clean(row.ArticleNumber));
    const newProducts = newSourceRows.filter(row => !stagedIds.has(clean(row.ProductID)));
    const permalinkRows = readRows(PERMALINKS, 'Sheet1');
    const handleByProductId = buildHandleByProductId(permalinkRows);
    const localizedRows = readRows(MULTILINGUAL_SOURCE, 'productslocalized');

    const localizedByProductId = new Map();
    for (const row of localizedRows) {
        const id = clean(row.productid);
        if (!id) continue;
        if (!localizedByProductId.has(id)) localizedByProductId.set(id, new Map());
        localizedByProductId.get(id).set(clean(row.culture), row);
    }

    const rows = [];
    const missingTranslations = [];
    for (const product of newProducts) {
        const id = clean(product.ProductID);
        // Match the product-import workbook: use the supplied Swedish handle
        // where available and otherwise use its title-derived Shopify handle.
        const handle = handleByProductId[id] || slugify(product.ProductName);
        if (!handle) throw new Error(`No Shopify handle could be resolved for ProductID ${id}`);
        const translations = localizedByProductId.get(id);
        if (!translations) {
            missingTranslations.push({ productId: id, articleNumber: clean(product.ArticleNumber), title: clean(product.ProductName) });
            continue;
        }

        for (const [matrixifyField, sourceField] of FIELDS) {
            const original = matrixifyField === 'Body HTML'
                ? toHtml(product.Description)
                : clean(product[{ Title: 'ProductName', 'SEO Title': 'PageTitle', 'SEO Description': 'MetaDescription' }[matrixifyField]]);
            const row = {
                Entity: 'Product',
                'Entity ID': '',
                'Entity Handle': handle,
                Field: matrixifyField,
                'Original Value': original,
            };
            let hasTranslation = false;
            for (const [locale, sourceLocale] of Object.entries(TARGET_LOCALES)) {
                const source = translations.get(sourceLocale);
                const value = matrixifyField === 'Body HTML'
                    ? toHtml(source?.[sourceField])
                    : clean(source?.[sourceField]);
                row[`Translation Value: ${locale}`] = value;
                hasTranslation ||= Boolean(value);
            }
            if (hasTranslation) rows.push(row);
        }
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, { header: HEADERS }), 'Translations');
    XLSX.writeFile(workbook, OUTPUT);
    const report = {
        comparedNewProducts: newProducts.length,
        productsWithTranslations: newProducts.length - missingTranslations.length,
        translationRows: rows.length,
        targetLocales: Object.keys(TARGET_LOCALES),
        productsWithoutSourceTranslations: missingTranslations,
    };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${rows.length} Matrixify translation rows for ${report.productsWithTranslations} products.`);
    console.log(`Products without source translations: ${missingTranslations.length}.`);
    console.log(`Workbook: ${OUTPUT}`);
}

main();
