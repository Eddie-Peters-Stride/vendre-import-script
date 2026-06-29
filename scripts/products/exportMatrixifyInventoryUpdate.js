#!/usr/bin/env node
/**
 * Build a Matrixify workbook that enables tracked inventory on all products
 * and pushes Vendre stock counts into Shopify.
 */

require('dotenv').config({
    path: process.env.ENV_FILE || '.env',
});

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { loadVendreData, ensureDirectory } = require('../../src/utils/file-io');
const { getProductHandle } = require('../../src/utils/handles');

const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');
const OUTPUT_BASENAME = 'matrixify-inventory-update.xlsx';

const INVENTORY_LOCATIONS = [
    { externalId: 'svea', column: 'Inventory Available: Sveavägen 118' },
    { externalId: 'kung', column: 'Inventory Available: Kungsholmstorg 8' },
];

const UPDATE_COLUMNS = [
    'Handle',
    'Command',
    'Variant Inventory Tracker',
    'Variant Inventory Policy',
    'Variant Inventory Qty',
    ...INVENTORY_LOCATIONS.map((location) => location.column),
];

function toNumber(value) {
    if (value == null || value === '') return '';
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : '';
}

function getWarehouses(product) {
    return Array.isArray(product?.warehouses)
        ? product.warehouses
        : (Array.isArray(product?._raw?.warehouses) ? product._raw.warehouses : []);
}

function getWarehouseEntry(product, externalId) {
    return getWarehouses(product).find((entry) => entry.external_id === externalId) || null;
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
        `Set STORE_NAME or run the npm script so ENV_FILE points at the right store.`
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

function getWarehouseQuantity(product, externalId) {
    const warehouse = getWarehouseEntry(product, externalId);
    if (!warehouse || warehouse.quantity == null) {
        return 0;
    }

    const parsed = Number(warehouse.quantity);
    return Number.isFinite(parsed) ? parsed : 0;
}

function getFallbackQuantity(product) {
    const directQuantity = toNumber(product?.quantity);
    if (directQuantity !== '') return directQuantity;

    const stockQuantity = toNumber(product?.stock);
    if (stockQuantity !== '') return stockQuantity;

    const warehouses = getWarehouses(product);

    if (warehouses.length > 0) {
        const total = warehouses
            .map((warehouse) => toNumber(warehouse.quantity))
            .filter((value) => value !== '');

        if (total.length > 0) {
            return total.reduce((sum, value) => sum + value, 0);
        }
    }

    return 0;
}

function getInventoryPolicy(product) {
    return product?.stock_allow_checkout ? 'continue' : 'deny';
}

function buildUpdateRows(products) {
    const rows = [];
    let skipped = 0;
    let fallbackCount = 0;

    for (const product of products) {
        const handle = getProductHandle(product);
        if (!handle) {
            skipped++;
            continue;
        }

        const row = {
            Handle: handle,
            Command: 'MERGE',
            'Variant Inventory Tracker': 'shopify',
            'Variant Inventory Policy': getInventoryPolicy(product),
            'Variant Inventory Qty': '',
        };

        let hasLocationInventory = false;

        for (const location of INVENTORY_LOCATIONS) {
            const warehouse = getWarehouseEntry(product, location.externalId);
            const quantity = getWarehouseQuantity(product, location.externalId);
            row[location.column] = quantity;
            if (warehouse && warehouse.quantity != null) {
                hasLocationInventory = true;
            }
        }

        if (!hasLocationInventory) {
            row['Variant Inventory Qty'] = getFallbackQuantity(product);
            fallbackCount++;
        }

        rows.push(row);
    }

    return { rows, skipped, fallbackCount };
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

async function main() {
    const storeName = process.env.STORE_NAME || '';
    const productsPath = resolveProductsPath(storeName);
    const outputPath = resolveOutputPath(storeName);

    const products = loadVendreData(productsPath);
    console.log(`Loaded ${products.length} products from ${productsPath}`);

    const { rows, skipped, fallbackCount } = buildUpdateRows(products);

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: UPDATE_COLUMNS });
    autoFitColumns(worksheet, rows, UPDATE_COLUMNS);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
    XLSX.writeFile(workbook, outputPath);

    console.log(`Rows written           : ${rows.length}`);
    console.log(`Inventory tracker set  : ${rows.length}`);
    console.log(`Rows using qty fallback: ${fallbackCount}`);
    console.log(`Skipped                : ${skipped}`);
    console.log(`Done. Matrixify workbook written to ${outputPath}`);
}

main().catch((error) => {
    console.error(`\nError: ${error.message}\n`);
    if (process.env.DEBUG && error.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});
