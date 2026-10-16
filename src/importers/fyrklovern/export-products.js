#!/usr/bin/env node
/**
 * Export Fyrklövern's staged products as a Matrixify Products workbook.
 * Collection assignments use the collection handles generated from the staged
 * Swedish category data. No collection or product-collection workbook is
 * produced by this command.
 */

const path = require('path');
const { loadVendreData, writeExcelFile } = require('../../utils/file-io');
const { transformProduct } = require('../../transformers/product-transformer');
const { buildProductRow } = require('../../exporters/matrixify-products');
const { resolveHandleCollisions } = require('../../utils/handles');

const CONFIG = {
    name: 'fyrklovern',
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
const MIGRATABLE_STOCK_STATUS_CODE = '0 - Will not send Stock Status.';

function buildCollectionHandles(product, collectionHandleById) {
    const handles = new Set();

    for (const categoryId of product.categoryIds || []) {
        const handle = collectionHandleById[String(categoryId)];
        if (handle) handles.add(handle);
    }

    return [...handles].join(', ');
}

function main() {
    const root = path.join(__dirname, '..', '..', '..');
    const resultsDir = path.join(root, 'results', 'fyrklovern');
    const outputDir = path.join(root, 'outputs', 'Fyrklovern', 'Matrixify files', 'Products');
    const productsPath = path.join(resultsDir, 'fyrklovern-products.json');
    const categoriesPath = path.join(resultsDir, 'fyrklovern-categories.json');
    const rawProducts = loadVendreData(productsPath);
    const rawCategories = loadVendreData(categoriesPath);

    const migratableRawProducts = rawProducts.filter(product =>
        product.extra?.fyrklovern?.stockStatusCode === MIGRATABLE_STOCK_STATUS_CODE
    );
    const products = migratableRawProducts.map(product => transformProduct(product, CONFIG));
    const collectionHandleById = Object.fromEntries(
        rawCategories.map(category => [String(category.id), category.handle])
    );

    // The source has duplicate product names. Ensure every Matrixify Handle is
    // unique before adding collection references to the product rows.
    const idToProductHandle = resolveHandleCollisions(Object.fromEntries(
        products.map(product => [product.vendreId, product.handle])
    ));
    for (const product of products) {
        product.handle = idToProductHandle[product.vendreId];
    }

    const rows = [];
    const unresolvedCategoryIds = new Set();
    let productsWithCollections = 0;

    for (const product of products) {
        const productRows = buildProductRow(product, CONFIG, idToProductHandle);
        const collectionHandles = buildCollectionHandles(product, collectionHandleById);

        for (const categoryId of product.categoryIds || []) {
            if (!collectionHandleById[String(categoryId)]) {
                unresolvedCategoryIds.add(String(categoryId));
            }
        }

        if (collectionHandles) {
            productRows[0]['Custom Collections'] = collectionHandles;
            productsWithCollections++;
        }

        rows.push(...productRows);
    }

    const outputPath = path.join(outputDir, 'Fyrklovern products - full Matrixify import.xlsx');
    writeExcelFile(rows, outputPath, 'Products');

    console.log(
        `Exported ${products.length} Fyrklövern products with stock status code 0 to ${outputPath}`
    );
    console.log(`Linked ${productsWithCollections} products to collection handles.`);
    if (unresolvedCategoryIds.size > 0) {
        console.warn(
            `${unresolvedCategoryIds.size} source category IDs are absent from ` +
            'fyrklovern-categories.json and were not assigned.'
        );
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`Fyrklövern product export failed: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { buildCollectionHandles, MIGRATABLE_STOCK_STATUS_CODE, main };
