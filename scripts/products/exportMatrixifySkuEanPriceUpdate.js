#!/usr/bin/env node
/**
 * Build a single Matrixify workbook that updates product SKU, EAN, and price.
 *
 * Each product is written as one row in a single worksheet so the import only
 * needs one file.
 */

require('dotenv').config({
    path: process.env.ENV_FILE || '.env',
});

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { loadVendreData, ensureDirectory } = require('../../src/utils/file-io');
const { getProductHandle } = require('../../src/utils/handles');
const { calculatePricing } = require('../../src/transformers/product-transformer');
const { getStoreSku } = require('../../src/utils/sku');

const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');
const OUTPUT_BASENAME = 'matrixify-sku-ean-price-update.xlsx';
const UPDATE_COLUMNS = [
    'Handle',
    'Command',
    'Variant SKU',
    'Variant Barcode',
    'Variant Price',
    'Variant Compare At Price',
];

function toText(value) {
    if (value == null) return '';
    return String(value).trim();
}

function loadPricingConfig() {
    const storeName = process.env.STORE_NAME || '';
    const taxClasses = {};

    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('TAX_CLASS_')) continue;
        const classId = key.replace('TAX_CLASS_', '');
        taxClasses[classId] = Number.parseInt(value, 10);
    }

    if (Object.keys(taxClasses).length === 0) {
        throw new Error('No TAX_CLASS_* environment variables found. Price updates need tax class mappings.');
    }

    return {
        storeName,
        taxClasses,
    };
}

function resolveProductsPath(storeName) {
    const candidates = [];

    if (storeName) {
        candidates.push(path.join(RESULTS_DIR, storeName, `${storeName}-products.json`));
    }

    candidates.push(path.join(RESULTS_DIR, 'products.json'));

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        `Could not find a products JSON file. Looked in: ${candidates.join(', ')}`
    );
}

function resolveOutputPath(storeName) {
    if (storeName) {
        const outputDir = path.join(RESULTS_DIR, storeName);
        ensureDirectory(outputDir);
        return path.join(outputDir, `${storeName}-${OUTPUT_BASENAME}`);
    }

    ensureDirectory(RESULTS_DIR);
    return path.join(RESULTS_DIR, OUTPUT_BASENAME);
}

function autoFitColumns(worksheet, rows, headers) {
    if (!rows || rows.length === 0) return;

    worksheet['!cols'] = headers.map((header) => {
        const maxLen = Math.max(
            header.length,
            ...rows.map((row) => {
                const value = row[header] != null ? String(row[header]) : '';
                return Math.min(value.length, 80);
            })
        );

        return { wch: Math.min(maxLen + 2, 80) };
    });
}

function buildUpdateRows(products, config) {
    const rows = [];
    let skipped = 0;
    let skuCount = 0;
    let barcodeCount = 0;
    let priceCount = 0;

    for (const product of products) {
        const handle = getProductHandle(product);
        if (!handle) {
            skipped++;
            continue;
        }

        const row = {
            Handle: handle,
            Command: 'MERGE',
        };

        const sku = getStoreSku(product, config.storeName);
        if (sku) {
            row['Variant SKU'] = sku;
            skuCount++;
        }

        const ean = toText(product.ean1);
        if (ean) {
            row['Variant Barcode'] = ean;
            barcodeCount++;
        }

        if (product.price != null && product.tax_class_id) {
            const pricing = calculatePricing(
                {
                    vendreId: product.id,
                    price: product.price,
                    priceSpecial: product.price_special ?? null,
                    taxClassId: product.tax_class_id,
                },
                config
            );

            row['Variant Price'] = pricing.price;
            row['Variant Compare At Price'] = pricing.compareAtPrice || '';
            priceCount++;
        }

        if (
            row['Variant SKU'] == null &&
            row['Variant Barcode'] == null &&
            row['Variant Price'] == null &&
            row['Variant Compare At Price'] == null
        ) {
            skipped++;
            continue;
        }

        rows.push(row);
    }

    return { rows, skipped, skuCount, barcodeCount, priceCount };
}

function buildWorksheet(workbook, sheetName, rows, headers) {
    if (!rows || rows.length === 0) {
        return;
    }

    const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
    autoFitColumns(worksheet, rows, headers);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
}

async function main() {
    const config = loadPricingConfig();
    const productsPath = resolveProductsPath(config.storeName);
    const outputPath = resolveOutputPath(config.storeName);

    const products = loadVendreData(productsPath);
    console.log(`Loaded ${products.length} products from ${productsPath}`);

    const updateRows = buildUpdateRows(products, config);

    const workbook = XLSX.utils.book_new();
    buildWorksheet(workbook, 'Updates', updateRows.rows, UPDATE_COLUMNS);

    XLSX.writeFile(workbook, outputPath);

    console.log(`Rows written: ${updateRows.rows.length}`);
    console.log(`SKU values   : ${updateRows.skuCount}`);
    console.log(`EAN values   : ${updateRows.barcodeCount}`);
    console.log(`Price values : ${updateRows.priceCount}`);
    console.log(`Skipped      : ${updateRows.skipped}`);
    console.log(`Done. Matrixify workbook written to ${outputPath}`);
}

main().catch((error) => {
    console.error(`\nError: ${error.message}\n`);
    if (process.env.DEBUG && error.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});
