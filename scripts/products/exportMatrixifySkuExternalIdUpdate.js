#!/usr/bin/env node
/**
 * Build a Matrixify workbook that updates product Variant SKU and
 * custom.external_id for a single store.
 */

require('dotenv').config({
    path: process.env.ENV_FILE || '.env',
});

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { loadVendreData, ensureDirectory } = require('../../src/utils/file-io');
const { getStoreConfig } = require('../../src/config/stores');
const { transformProduct } = require('../../src/transformers/product-transformer');

const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');
const OUTPUT_BASENAME = 'matrixify-sku-external-id-update.xlsx';
const OUTPUT_COLUMNS = [
    'Handle',
    'Command',
    'Variant SKU',
    'Metafield: custom.external_id [single_line_text_field]',
];

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

function buildRows(products, config) {
    const rows = [];
    let skipped = 0;

    for (const rawProduct of products) {
        const product = transformProduct(rawProduct, config, {});

        if (!product.handle) {
            skipped++;
            continue;
        }

        rows.push({
            Handle: product.handle,
            Command: 'MERGE',
            'Variant SKU': product.sku || '',
            'Metafield: custom.external_id [single_line_text_field]': product.externalId || '',
        });
    }

    return { rows, skipped };
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

function main() {
    const config = getStoreConfig();
    const productsPath = resolveProductsPath(config.outputPrefix);
    const outputPath = resolveOutputPath(config.outputPrefix);

    const products = loadVendreData(productsPath);
    console.log(`Loaded ${products.length} products from ${productsPath}`);

    const { rows, skipped } = buildRows(products, config);

    const worksheet = XLSX.utils.json_to_sheet(rows, { header: OUTPUT_COLUMNS });
    autoFitColumns(worksheet, rows, OUTPUT_COLUMNS);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
    XLSX.writeFile(workbook, outputPath);

    console.log(`Rows written: ${rows.length}`);
    console.log(`Skipped      : ${skipped}`);
    console.log(`Done. Matrixify workbook written to ${outputPath}`);
}

main();
