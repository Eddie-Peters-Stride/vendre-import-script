#!/usr/bin/env node
/**
 * Build a Matrixify workbook that updates only product SKU, EAN, and price.
 *
 * The workbook uses separate row sets so each Matrixify row only touches the
 * intended field:
 * - SKU rows: Handle + Command + Variant SKU
 * - Price rows: Handle + Command + Variant Price + Variant Compare At Price
 * - EAN rows: Handle + Command + Variant Barcode
 *
 * This avoids blank cells from clearing unrelated Shopify fields.
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

const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');
const OUTPUT_BASENAME = 'matrixify-sku-ean-price-update.xlsx';

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

function autoFitColumns(worksheet, rows) {
    if (!rows || rows.length === 0) return;

    const headers = Object.keys(rows[0]);
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

function appendSheet(workbook, sheetName, rows) {
    if (rows.length === 0) {
        return;
    }

    const worksheet = XLSX.utils.json_to_sheet(rows);
    autoFitColumns(worksheet, rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
}

function buildSkuRows(products) {
    const rows = [];
    let skipped = 0;

    for (const product of products) {
        const handle = getProductHandle(product);
        const sku = toText(product.external_id);

        if (!handle || !sku) {
            skipped++;
            continue;
        }

        rows.push({
            Handle: handle,
            Command: 'MERGE',
            'Variant SKU': sku,
        });
    }

    return { rows, skipped };
}

function buildPriceRows(products, config) {
    const rows = [];
    let skipped = 0;

    for (const product of products) {
        const handle = getProductHandle(product);

        if (!handle || product.price == null) {
            skipped++;
            continue;
        }

        const pricing = calculatePricing(
            {
                vendreId: product.id,
                price: product.price,
                priceSpecial: product.price_special ?? null,
                taxClassId: product.tax_class_id,
            },
            config
        );

        rows.push({
            Handle: handle,
            Command: 'MERGE',
            'Variant Price': pricing.price,
            'Variant Compare At Price': pricing.compareAtPrice || '',
        });
    }

    return { rows, skipped };
}

function buildEanRows(products) {
    const rows = [];
    let skipped = 0;

    for (const product of products) {
        const handle = getProductHandle(product);
        const ean = toText(product.ean1);

        if (!handle || !ean) {
            skipped++;
            continue;
        }

        rows.push({
            Handle: handle,
            Command: 'MERGE',
            'Variant Barcode': ean,
        });
    }

    return { rows, skipped };
}

async function main() {
    const config = loadPricingConfig();
    const productsPath = resolveProductsPath(config.storeName);
    const outputPath = resolveOutputPath(config.storeName);

    const products = loadVendreData(productsPath);
    console.log(`Loaded ${products.length} products from ${productsPath}`);

    const skuRows = buildSkuRows(products);
    const priceRows = buildPriceRows(products, config);
    const eanRows = buildEanRows(products);

    const workbook = XLSX.utils.book_new();
    appendSheet(workbook, 'SKU Updates', skuRows.rows);
    appendSheet(workbook, 'Price Updates', priceRows.rows);
    appendSheet(workbook, 'EAN Updates', eanRows.rows);

    XLSX.writeFile(workbook, outputPath);

    console.log(`SKU rows   : ${skuRows.rows.length} written, ${skuRows.skipped} skipped`);
    console.log(`Price rows : ${priceRows.rows.length} written, ${priceRows.skipped} skipped`);
    console.log(`EAN rows   : ${eanRows.rows.length} written, ${eanRows.skipped} skipped`);
    console.log(`Done. Matrixify workbook written to ${outputPath}`);
}

main().catch((error) => {
    console.error(`\nError: ${error.message}\n`);
    if (process.env.DEBUG && error.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});
