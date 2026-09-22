#!/usr/bin/env node
/**
 * Build a Matrixify workbook that updates only product SEO fields and the
 * short description metafield.
 */

require('dotenv').config({
    path: process.env.ENV_FILE || '.env',
});

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { loadVendreData, ensureDirectory } = require('../../src/utils/file-io');
const { getProductHandle } = require('../../src/utils/handles');
const { stripHtml } = require('../../src/utils/html');

const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');
const OUTPUT_BASENAME = 'matrixify-product-update.xlsx';
const UPDATE_COLUMNS = [
    'Handle',
    'Command',
    'SEO Title',
    'SEO Description',
    'Metafield: custom.description_short [single_line_text_field]',
];

function normalizeText(value) {
    return stripHtml(String(value || ''))
        .replace(/\s+/g, ' ')
        .trim();
}

function getLocalizedValue(field) {
    if (!field) return '';
    return field.sv || field.en || '';
}

function getShortDescription(product) {
    const short = getLocalizedValue(product.description_short);
    return normalizeText(short);
}

function getSeoTitle(product) {
    return normalizeText(getLocalizedValue(product.meta_title));
}

function getSeoDescription(product) {
    return normalizeText(getLocalizedValue(product.meta_description));
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
        `Could not find a products JSON file. Looked in: ${candidates.join(', ')}. ` +
        `Set STORE_NAME or run the npm script with the correct ENV_FILE.`
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

function buildUpdateRows(products) {
    const rows = [];
    let skippedNoHandle = 0;

    for (const product of products) {
        const handle = getProductHandle(product);
        if (!handle) {
            skippedNoHandle++;
            continue;
        }

        rows.push({
            Handle: handle,
            Command: 'UPDATE',
            'SEO Title': getSeoTitle(product),
            'SEO Description': getSeoDescription(product),
            'Metafield: custom.description_short [single_line_text_field]': getShortDescription(product),
        });
    }

    return { rows, skippedNoHandle };
}

function main() {
    const storeName = process.env.STORE_NAME || '';
    const productsPath = resolveProductsPath(storeName);
    const outputPath = resolveOutputPath(storeName);

    const products = loadVendreData(productsPath);
    console.log(`Loaded ${products.length} products from ${productsPath}`);

    const { rows, skippedNoHandle } = buildUpdateRows(products);

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: UPDATE_COLUMNS });
    autoFitColumns(worksheet, rows, UPDATE_COLUMNS);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
    XLSX.writeFile(workbook, outputPath);

    console.log(`Rows written      : ${rows.length}`);
    console.log(`Skipped no handle : ${skippedNoHandle}`);
    console.log(`Done. Matrixify workbook written to ${outputPath}`);
}

main();
