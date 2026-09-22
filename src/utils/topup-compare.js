/**
 * Top-up comparison utilities
 * Compare Shopify exports with Vendre data to identify new products
 */

const fs = require('fs');
const path = require('path');
const { getProductHandle } = require('./handles');
const { getStoreSku } = require('./sku');

/**
 * Normalize SKU-like values so Shopify export CSVs and Vendre data can be
 * compared reliably.
 * Shopify exports sometimes prefix numeric SKUs with a single quote to keep
 * Excel from reformatting them. We strip that marker here.
 * @param {any} value - Raw SKU value
 * @returns {string} Normalized SKU
 */
function normalizeSku(value) {
    if (value == null) return '';

    return String(value)
        .replace(/^\uFEFF/, '')
        .trim()
        .replace(/^'+/, '');
}

/**
 * Normalize a Shopify handle for comparison.
 * @param {any} value - Raw handle value
 * @returns {string} Normalized handle
 */
function normalizeHandle(value) {
    if (value == null) return '';

    return String(value)
        .replace(/^\uFEFF/, '')
        .trim()
        .toLowerCase();
}

/**
 * Parse Shopify CSV export and extract product SKUs plus handles
 * @param {string} csvContent - CSV file content
 * @returns {Object} Sets of SKU and handle values
 */
function extractProductKeysFromShopifyCsv(csvContent) {
    const skus = new Set();
    const handles = new Set();
    const lines = csvContent.replace(/^\uFEFF/, '').split('\n');

    if (lines.length === 0) return { skus, handles };

    // Find the "Variant SKU" column index
    const headerLine = lines[0];
    const headers = parseCSVLine(headerLine).map(h => h.trim());
    const handleIndex = headers.findIndex(h => h === 'Handle');
    const skuIndex = headers.findIndex(h => h === 'Variant SKU');

    if (skuIndex === -1 && handleIndex === -1) {
        console.warn('Warning: "Variant SKU" column not found in CSV');
        return { skus, handles };
    }

    // Extract SKUs from data rows
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Simple CSV parsing (handles quoted values)
        const values = parseCSVLine(line);
        if (handleIndex !== -1 && values[handleIndex]) {
            const handle = normalizeHandle(values[handleIndex]);
            if (handle) {
                handles.add(handle);
            }
        }
        if (values[skuIndex]) {
            const sku = normalizeSku(values[skuIndex]);
            if (sku) {
                skus.add(sku);
            }
        }
    }

    return { skus, handles };
}

/**
 * Simple CSV line parser that handles quoted values
 * @param {string} line - CSV line
 * @returns {Array} Parsed values
 */
function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            values.push(current);
            current = '';
        } else {
            current += char;
        }
    }

    values.push(current);
    return values;
}

/**
 * Get SKU from a Vendre product.
 * @param {Object} product - Vendre product
 * @param {Object|string} [options] - Store-specific SKU resolution options
 * @returns {string} SKU value or empty string
 */
function getProductSku(product, options = {}) {
    if (product?.sku) {
        return normalizeSku(product.sku);
    }

    return normalizeSku(getStoreSku(product, options.storeName || options));
}

/**
 * Get handle from a Vendre product for top-up comparisons
 * @param {Object} product - Vendre product
 * @returns {string} Handle value or empty string
 */
function getProductTopupHandle(product) {
    return normalizeHandle(getProductHandle(product));
}

/**
 * Compare Vendre products with Shopify exports
 * @param {Array} vendreProducts - Array of Vendre products
 * @param {Object|Set} shopifyProducts - Shopify SKU/handle sets or legacy SKU set
 * @param {Object} [options] - Store-specific SKU resolution options
 * @returns {Object} { newProducts, existingProducts, skipped }
 */
function compareProducts(vendreProducts, shopifyProducts, options = {}) {
    const shopifySKUs = shopifyProducts instanceof Set
        ? shopifyProducts
        : (shopifyProducts?.skus || new Set());
    const shopifyHandles = shopifyProducts instanceof Set
        ? new Set()
        : (shopifyProducts?.handles || new Set());

    const newProducts = [];
    const existingProducts = [];
    let skipped = 0;
    let matchedBySku = 0;
    let matchedByHandle = 0;
    let matchedByBoth = 0;

    for (const product of vendreProducts) {
        const sku = getProductSku(product, options);
        const handle = getProductTopupHandle(product);

        if (!sku) {
            skipped++;
            continue;
        }

        const skuMatch = shopifySKUs.has(sku);
        const handleMatch = handle ? shopifyHandles.has(handle) : false;

        if (skuMatch || handleMatch) {
            existingProducts.push(product);
            if (skuMatch) matchedBySku++;
            if (handleMatch) matchedByHandle++;
            if (skuMatch && handleMatch) matchedByBoth++;
        } else {
            newProducts.push(product);
        }
    }

    return {
        newProducts,
        existingProducts,
        skipped,
        matchedBySku,
        matchedByHandle,
        matchedByBoth,
    };
}

/**
 * Find and parse specific Shopify product export files
 * @param {string} outputDir - Directory containing exports
 * @param {Array<string>} fileNames - Exact Shopify export file names to read
 * @returns {Object} Combined sets of all SKUs and handles from the requested export files
 */
function loadShopifyProductKeysFromFiles(outputDir, fileNames) {
    const allSkus = new Set();
    const allHandles = new Set();
    const missingFiles = [];

    for (const file of fileNames) {
        const filePath = path.join(outputDir, file);

        if (!fs.existsSync(filePath)) {
            missingFiles.push(file);
            continue;
        }

        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const { skus, handles } = extractProductKeysFromShopifyCsv(content);
            console.log(`    ${file}: ${skus.size} SKU(s), ${handles.size} handle(s)`);
            skus.forEach(sku => allSkus.add(sku));
            handles.forEach(handle => allHandles.add(handle));
        } catch (error) {
            throw new Error(`Failed reading ${file}: ${error.message}`);
        }
    }

    if (missingFiles.length > 0) {
        throw new Error(
            `Missing Shopify product export CSV file(s) in ${outputDir}: ${missingFiles.join(', ')}`
        );
    }

    return { skus: allSkus, handles: allHandles };
}

/**
 * Legacy helper retained for compatibility.
 * @param {string} outputDir - Directory containing exports
 * @param {Array<string>} fileNames - Exact Shopify export file names to read
 * @returns {Set} Combined set of SKU values
 */
function loadShopifySkusFromFiles(outputDir, fileNames) {
    return loadShopifyProductKeysFromFiles(outputDir, fileNames).skus;
}

/**
 * Find and parse all Shopify product export files in a directory.
 * Falls back to every products_export*.csv file if the preferred pair is not present.
 * @param {string} outputDir - Directory containing exports
 * @returns {Object} Combined sets of all SKUs and handles from all export files
 */
function loadShopifySkusFromDirectory(outputDir) {
    try {
        const preferredFiles = ['products_export_1.csv', 'products_export_2.csv'];
        const preferredPaths = preferredFiles.filter(file =>
            fs.existsSync(path.join(outputDir, file))
        );

        if (preferredPaths.length > 0) {
            console.log(
                `Reading Shopify product export file(s): ${preferredPaths.join(', ')}`
            );
            return loadShopifyProductKeysFromFiles(outputDir, preferredPaths);
        }

        const files = fs.readdirSync(outputDir);
        const productExportFiles = files.filter(f => /^products_export.*\.csv$/i.test(f));

        if (productExportFiles.length === 0) {
            throw new Error(`No Shopify product export CSV files found in ${outputDir}`);
        }

        console.log(`Reading Shopify product export file(s): ${productExportFiles.join(', ')}`);
        return loadShopifyProductKeysFromFiles(outputDir, productExportFiles);
    } catch (error) {
        throw new Error(`Failed to load Shopify export SKUs: ${error.message}`);
    }
}

module.exports = {
    normalizeSku,
    normalizeHandle,
    extractProductKeysFromShopifyCsv,
    parseCSVLine,
    getProductSku,
    getProductTopupHandle,
    compareProducts,
    loadShopifyProductKeysFromFiles,
    loadShopifySkusFromFiles,
    loadShopifySkusFromDirectory,
};
