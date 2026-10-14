#!/usr/bin/env node
/**
 * Create a Matrixify Products workbook containing only products added since
 * the current Fyrklövern staging import.
 *
 * Usage:
 *   node scripts/fyrklovern/exportMissingProductsMatrixify.js
 *   node scripts/fyrklovern/exportMissingProductsMatrixify.js --input=C:\path\to\productdata.xlsx
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const {
    adaptProduct,
    buildDynamicFieldsByProductId,
    buildHandleByProductId,
    buildImagesByArticleNumber,
} = require('../../src/importers/fyrklovern/productdata');
const { transformProduct } = require('../../src/transformers/product-transformer');
const { buildProductRow } = require('../../src/exporters/matrixify-products');
const { loadVendreData } = require('../../src/utils/file-io');

const ROOT = path.resolve(__dirname, '..', '..');
const FYRKLOVERN_DIR = path.resolve(ROOT, '..', '..', 'Fyrklövern');
const RESULTS_DIR = path.join(ROOT, 'results', 'fyrklovern');
const DEFAULT_INPUT = path.join(FYRKLOVERN_DIR, 'fyrklovern_productdata_newexport.xlsx');
const PERMALINKS = path.join(FYRKLOVERN_DIR, 'fyrklovern_productpermalinks.xlsx');
const IMAGE_ORDER = path.join(FYRKLOVERN_DIR, 'fyrklovern_produkter_bildordning.xlsx');
const EXISTING_PRODUCTS = path.join(RESULTS_DIR, 'fyrklovern-products.json');
const CATEGORIES = path.join(RESULTS_DIR, 'fyrklovern-categories.json');
const OUTPUT = path.join(RESULTS_DIR, 'fyrklovern-matrixify-new-products.xlsx');
const METAFIELD_UPDATE_OUTPUT = path.join(
    RESULTS_DIR,
    'fyrklovern-matrixify-new-products-metafields-update.xlsx'
);

const CONFIG = {
    taxClasses: { 2: 25 },
    specFields: {},
    blankVendor: true,
    includeManufacturerName: false,
    includeInventoryFields: false,
    includeDescriptionShort: false,
    excludedMetafieldKeys: ['price_history_cutoff_date_yyyy_mm_dd'],
    booleanMetafieldKeys: [
        'chargeable',
        'dimmer',
        'dishwasher_safe',
        'lights_included',
        'microwave_safe',
    ],
};

function clean(value) {
    return value == null ? '' : String(value).trim();
}

function getArgument(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.find(value => value.startsWith(prefix));
    return argument ? path.resolve(argument.slice(prefix.length)) : null;
}

function readRows(filePath, sheetName) {
    const workbook = XLSX.readFile(filePath, { raw: false });
    const worksheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];
    if (!worksheet) throw new Error(`Worksheet not found in ${filePath}`);
    return XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });
}

function getSourceProducts(inputPath) {
    const workbook = XLSX.readFile(inputPath, { raw: false });
    const worksheet = workbook.Sheets['productdata (standard sv-SE)'] || workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });
    const dynamicFieldsByProductId = buildDynamicFieldsByProductId(
        workbook.Sheets.dynamicfields
            ? XLSX.utils.sheet_to_json(workbook.Sheets.dynamicfields, { defval: '', raw: false })
            : []
    );
    const permalinkRows = readRows(PERMALINKS, 'Sheet1');
    const imageRows = readRows(IMAGE_ORDER, 'Sheet1');
    const handleByProductId = buildHandleByProductId(permalinkRows);
    const imagesByArticleNumber = buildImagesByArticleNumber(imageRows);

    return rows
        .filter(row => clean(row.ProductID) && clean(row.ArticleNumber))
        .map(row => adaptProduct(row, dynamicFieldsByProductId, handleByProductId, imagesByArticleNumber));
}

function makeRows(products, categoryHandleById) {
    const normalized = products.map(product => transformProduct(product, CONFIG));
    const rows = [];

    for (const product of normalized) {
        if (!product.handle) {
            throw new Error(`No Swedish handle found for ProductID ${product.vendreId}`);
        }

        const productRows = buildProductRow(product, CONFIG, {});
        productRows[0].Command = 'NEW';
        const collectionHandles = (product.categoryIds || [])
            .map(id => categoryHandleById[String(id)])
            .filter(Boolean);
        if (collectionHandles.length > 0) {
            productRows[0]['Custom Collections'] = [...new Set(collectionHandles)].join(', ');
        }
        rows.push(...productRows);
    }

    return rows;
}

function makeMetafieldUpdateRows(productRows) {
    return productRows
        // The first row is the product row; subsequent rows only carry images.
        .filter(row => row.Handle && row['Variant SKU'])
        .map(row => Object.fromEntries(
            Object.entries(row).filter(([header]) =>
                header === 'Handle' ||
                header === 'Command' ||
                header.startsWith('Metafield: ')
            )
        ))
        .map(row => ({ ...row, Command: 'MERGE' }));
}

function main() {
    const inputPath = getArgument('input') || DEFAULT_INPUT;
    if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);

    const importedProducts = loadVendreData(EXISTING_PRODUCTS);
    const importedIds = new Set(importedProducts.map(product => clean(product.id)).filter(Boolean));
    const sourceProducts = getSourceProducts(inputPath);
    const missingProducts = sourceProducts.filter(product => !importedIds.has(clean(product.id)));
    const categories = loadVendreData(CATEGORIES);
    const categoryHandleById = Object.fromEntries(
        categories.map(category => [clean(category.id), clean(category.handle)])
    );
    const rows = makeRows(missingProducts, categoryHandleById);
    const metafieldUpdateRows = makeMetafieldUpdateRows(rows);

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
    XLSX.writeFile(workbook, OUTPUT);

    const metafieldWorksheet = XLSX.utils.json_to_sheet(metafieldUpdateRows);
    const metafieldWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(metafieldWorkbook, metafieldWorksheet, 'Products');
    XLSX.writeFile(metafieldWorkbook, METAFIELD_UPDATE_OUTPUT);

    const missingWithoutCollections = missingProducts.filter(product =>
        !(product.category_ids || []).some(id => categoryHandleById[clean(id)])
    );
    console.log(`Compared ${sourceProducts.length} source products with ${importedProducts.length} staged products.`);
    console.log(`New products: ${missingProducts.length}; Matrixify rows: ${rows.length}.`);
    console.log(`Products without matched custom collections: ${missingWithoutCollections.length}.`);
    console.log(`Wrote ${OUTPUT}`);
    console.log(`Wrote ${METAFIELD_UPDATE_OUTPUT}`);
}

main();
