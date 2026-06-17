/**
 * Export command - Transform and export data to Matrixify Excel files
 */

const path = require('path');
const fs = require('fs');
const { loadVendreData, writeExcelFile, safeReadJson, safeWriteJson, ensureDirectory } = require('../utils/file-io');
const { transformProduct } = require('../transformers/product-transformer');
const { transformCollections } = require('../transformers/collection-transformer');
const { transformCustomer } = require('../transformers/customer-transformer');
const { exportProducts, buildProductRow, exportPriceUpdate, exportVendorUpdate } = require('../exporters/matrixify-products');
const { exportCollections, exportCollectionMetafields, exportProductCollections, exportSubcollections } = require('../exporters/matrixify-collections');
const { exportCustomers, exportCustomersWithoutPhone } = require('../exporters/matrixify-customers');
const { exportProductTranslations, buildSkuToHandleMap, buildHandleToIdMap, parseShopifyCsv } = require('../exporters/matrixify-translations');
const { compareProducts, loadShopifyProductKeysFromFiles } = require('../utils/topup-compare');

/**
 * Export products to Matrixify Excel
 * @param {Object} config - Store configuration
 * @param {string} dataDir - Directory with JSON data files
 * @param {string} outputDir - Output directory for Excel files
 * @param {Object} options - Export options
 * @returns {Promise<Object>} Result with file paths
 */
async function exportProductsCommand(config, dataDir, outputDir, options = {}) {
    console.log('\nExporting products...\n');

    // Load data
    const productsPath = path.join(dataDir, `${config.outputPrefix}-products.json`);
    const vendreProducts = loadVendreData(productsPath);

    // Load tags map
    const tagsPath = path.join(__dirname, '..', '..', 'tags.json');
    const tagsMap = safeReadJson(tagsPath);

    // Transform
    const products = vendreProducts.map(p => transformProduct(p, config, tagsMap));

    ensureDirectory(outputDir);
    const results = {};

    // Full product export
    if (options.full !== false) {
        const rows = exportProducts(products, config);
        const flatRows = rows.flat(); // Flatten image rows
        const outputPath = path.join(outputDir, `${config.outputPrefix}-matrixify-products.xlsx`);
        writeExcelFile(flatRows, outputPath, 'Products');
        console.log(`✓ Saved to ${outputPath}`);
        results.products = outputPath;
    }

    // Price update export
    if (options.priceUpdate) {
        const rows = exportPriceUpdate(products, config);
        const outputPath = path.join(outputDir, `${config.outputPrefix}-matrixify-price-update.xlsx`);
        writeExcelFile(rows, outputPath, 'Products');
        console.log(`✓ Saved price update to ${outputPath}`);
        results.priceUpdate = outputPath;
    }

    // Vendor update export
    if (options.vendorUpdate) {
        const rows = exportVendorUpdate(products);
        const outputPath = path.join(outputDir, `${config.outputPrefix}-vendor-update.xlsx`);
        writeExcelFile(rows, outputPath, 'Products');
        console.log(`✓ Saved vendor update to ${outputPath}`);
        results.vendorUpdate = outputPath;
    }

    // Translations export
    if (options.translations) {
        const translationRows = await exportTranslations(config, dataDir, outputDir, products);
        if (translationRows && translationRows.length > 0) {
            const outputPath = path.join(outputDir, `${config.outputPrefix}-translations.xlsx`);
            writeExcelFile(translationRows, outputPath, 'Translations');
            console.log(`✓ Saved translations to ${outputPath}`);
            results.translations = outputPath;
        }
    }

    return results;
}

/**
 * Export translations for products
 * @param {Object} config - Store configuration
 * @param {string} dataDir - Directory with JSON data files
 * @param {string} outputDir - Output directory for Excel files
 * @param {Array} products - Optional pre-transformed products
 * @returns {Promise<Array>} Translation rows
 */
async function exportTranslations(config, dataDir, outputDir, products = null) {
    console.log('\nExporting translations...\n');

    // Load products if not provided
    if (!products) {
        const productsPath = path.join(dataDir, `${config.outputPrefix}-products.json`);
        const vendreProducts = loadVendreData(productsPath);
        const tagsPath = path.join(__dirname, '..', '..', 'tags.json');
        const tagsMap = safeReadJson(tagsPath);
        products = vendreProducts.map(p => transformProduct(p, config, tagsMap));
    }

    // Build SKU → Handle mapping from Shopify product exports
    const skuToHandle = {};
    const productExportPattern = /^products_export_.*\.csv$/i;
    const productExportFiles = fs.readdirSync(outputDir)
        .filter(f => productExportPattern.test(f))
        .sort();

    console.log(`Found product export CSVs: ${productExportFiles.join(', ') || '(none)'}`);

    for (const file of productExportFiles) {
        const filePath = path.join(outputDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const rows = parseShopifyCsv(content);
        const mapping = buildSkuToHandleMap(rows);
        Object.assign(skuToHandle, mapping);
    }

    console.log(`Loaded ${Object.keys(skuToHandle).length} SKU→handle mappings`);

    // Build Handle → ID mapping from Shopify translation exports
    const handleToId = {};
    const translationExportPattern = new RegExp(`^${config.outputPrefix}_translations_.*\\.csv$`, 'i');
    const translationExportFiles = fs.readdirSync(outputDir)
        .filter(f => translationExportPattern.test(f))
        .sort();

    console.log(`Found translation export CSVs: ${translationExportFiles.join(', ') || '(none)'}`);

    for (const file of translationExportFiles) {
        const filePath = path.join(outputDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const rows = parseShopifyCsv(content);
        const mapping = buildHandleToIdMap(rows);
        Object.assign(handleToId, mapping);
    }

    console.log(`Loaded ${Object.keys(handleToId).length} handle→ID mappings`);

    // Export translations
    const translationRows = exportProductTranslations(
        products,
        { skuToHandle, handleToId },
        {
            sourceLocale: 'sv',
            targetLocale: 'en',
        }
    );

    return translationRows;
}

/**
 * Command to export collections to Matrixify Excel files.
 * @param {object} config - The store configuration.
 * @param {string} dataDir - The directory containing the JSON data.
 * @param {string} outputDir - The directory to save the Excel files to.
 * @param {object} options - Export options.
 */
async function exportCollectionsCommand(config, dataDir, outputDir, options = {}) {
    console.log('\nExporting collections...\n');

    // Load data
    const collectionsPath = path.join(dataDir, `${config.outputPrefix}-collections.json`);
    const vendreCollections = loadVendreData(collectionsPath);

    // Transform
    const { collections, maps } = transformCollections(vendreCollections, config);

    ensureDirectory(outputDir);
    const results = {};

    // Full collection export
    if (options.full !== false) {
        const rows = exportCollections(collections, maps, config);
        const outputPath = path.join(outputDir, `${config.outputPrefix}-matrixify-collections.xlsx`);
        writeExcelFile(rows, outputPath, 'Collections');
        console.log(`✓ Saved to ${outputPath}`);
        results.collections = outputPath;
    }

    // Collection metafields (parent-child relationships)
    if (options.metafields) {
        const rows = exportCollectionMetafields(collections, maps);
        const outputPath = path.join(outputDir, `${config.outputPrefix}-collection-metafields.xlsx`);
        writeExcelFile(rows, outputPath, 'Collections');
        console.log(`✓ Saved metafields to ${outputPath}`);
        results.metafields = outputPath;
    }

    // Subcollections
    if (options.subcollections) {
        const rows = exportSubcollections(collections, config);
        const outputPath = path.join(outputDir, `${config.outputPrefix}-subcollections-update.xlsx`);
        writeExcelFile(rows, outputPath, 'Collections');
        console.log(`✓ Saved subcollections to ${outputPath}`);
        results.subcollections = outputPath;
    }

    // Store maps for product-collection export
    results._maps = maps;

    return results;
}

/**
 * Export product-collection assignments to Matrixify Excel
 * @param {Object} config - Store configuration
 * @param {string} dataDir - Directory with JSON data files
 * @param {string} outputDir - Output directory for Excel files
 * @returns {Promise<Object>} Result with file path
 */
async function exportProductCollectionsCommand(config, dataDir, outputDir) {
    console.log('\nExporting product-collection assignments...\n');

    // Load data
    const productsPath = path.join(dataDir, `${config.outputPrefix}-products.json`);
    const collectionsPath = path.join(dataDir, `${config.outputPrefix}-collections.json`);

    const vendreProducts = loadVendreData(productsPath);
    const vendreCollections = loadVendreData(collectionsPath);

    // Transform
    const { collections, maps } = transformCollections(vendreCollections, config);
    const products = vendreProducts.map(p => transformProduct(p, config));

    // Export
    const rows = exportProductCollections(products, collections, config);

    ensureDirectory(outputDir);
    const outputPath = path.join(outputDir, `${config.outputPrefix}-matrixify-product-collections.xlsx`);
    writeExcelFile(rows, outputPath, 'Products');

    console.log(`✓ Saved to ${outputPath}`);

    return { productCollections: outputPath };
}

/**
 * Export customers to Matrixify Excel
 * @param {Object} config - Store configuration
 * @param {string} dataDir - Directory with JSON data files
 * @param {string} outputDir - Output directory for Excel files
 * @param {Object} options - Export options
 * @returns {Promise<Object>} Result with file paths
 */
async function exportCustomersCommand(config, dataDir, outputDir, options = {}) {
    console.log('\nExporting customers...\n');

    // Load data
    const customersPath = path.join(dataDir, `${config.outputPrefix}-customers.json`);
    const vendreCustomers = loadVendreData(customersPath);

    // Transform
    const customers = vendreCustomers.map(c => transformCustomer(c, config));

    ensureDirectory(outputDir);
    const results = {};

    // Full customer export
    const rows = exportCustomers(customers);
    const outputPath = path.join(outputDir, `${config.outputPrefix}-customers-matrixify.xlsx`);
    writeExcelFile(rows, outputPath, 'Customers');
    console.log(`✓ Saved to ${outputPath}`);
    results.customers = outputPath;

    // Customers without phone
    if (options.noPhone) {
        const noPhoneRows = exportCustomersWithoutPhone(customers);
        const noPhonePath = path.join(outputDir, `${config.outputPrefix}-customers-no-phone-matrixify.xlsx`);
        writeExcelFile(noPhoneRows, noPhonePath, 'Customers');
        console.log(`✓ Saved customers without phone to ${noPhonePath}`);
        results.customersNoPhone = noPhonePath;
    }

    return results;
}

/**
 * Export all data types to Matrixify Excel
 * @param {Object} config - Store configuration
 * @param {string} dataDir - Directory with JSON data files
 * @param {string} outputDir - Output directory for Excel files
 * @returns {Promise<Object>} Results for all exports
 */
async function exportAll(config, dataDir, outputDir) {
    console.log(`\nExporting all data for ${config.name}...\n`);

    const results = {};

    // Products (with price and vendor updates)
    results.products = await exportProductsCommand(config, dataDir, outputDir, {
        full: true,
        priceUpdate: true,
        vendorUpdate: true,
    });

    // Collections (with metafields and subcollections)
    results.collections = await exportCollectionsCommand(config, dataDir, outputDir, {
        full: true,
        metafields: true,
        subcollections: true,
    });

    // Product-collection assignments
    results.productCollections = await exportProductCollectionsCommand(config, dataDir, outputDir);

    // Customers (with no-phone variant)
    results.customers = await exportCustomersCommand(config, dataDir, outputDir, {
        noPhone: true,
    });

    console.log('\n✓ Export complete!\n');
    return results;
}

/**
 * Normalize a Matrixify list field value to the comma-separated format Matrixify expects.
 * @param {string} value - Raw semicolon-separated value
 * @returns {string} Normalized list value
 */
function formatTopupListValue(value) {
    if (!value) return '';

    return String(value)
        .split(/;/)
        .map(part => part.trim())
        .filter(Boolean)
        .join(', ');
}

/**
 * Map the store's Vendre warehouse ids to Matrixify inventory column names.
 * @returns {Array<{externalId: string, column: string}>}
 */
function getTopupInventoryLocationColumns() {
    return [
        { externalId: 'svea', column: 'Inventory Available: Sveavägen 118' },
        { externalId: 'kung', column: 'Inventory Available: Kungsholmstorg 8' },
    ];
}

/**
 * Read inventory quantity for a warehouse from the raw Vendre product.
 * @param {Object} product - Normalized product with _raw data
 * @param {string} externalId - Vendre warehouse external id
 * @returns {number|string} Quantity or empty string if missing
 */
function getTopupWarehouseQuantity(product, externalId) {
    const warehouses = product?._raw?.warehouses;
    if (!Array.isArray(warehouses)) return '';

    const warehouse = warehouses.find(w => w.external_id === externalId);
    if (!warehouse || warehouse.quantity == null) return '';

    return warehouse.quantity;
}

/**
 * Build the full collection handle set for a product, including ancestor collections.
 * Uses the same collection hierarchy logic as the collection/product collection scripts.
 * @param {Object} product - Normalized product
 * @param {Object} collectionMaps - Maps from transformCollections
 * @returns {string} Comma-separated collection handles
 */
function getTopupCollectionHandles(product, collectionMaps) {
    const categoryIds = product.categoryIds || [];
    if (categoryIds.length === 0) return '';

    const assignedHandles = new Set();
    const visited = new Set();

    for (const categoryId of categoryIds) {
        let current = collectionMaps.idToCollection[categoryId];

        while (current && !visited.has(current.id)) {
            visited.add(current.id);

            const title = collectionMaps.idToTitle[current.id];
            const handle =
                (title && collectionMaps.titleToHandle && collectionMaps.titleToHandle[title]) ||
                collectionMaps.idToHandle[current.id];

            if (handle) {
                assignedHandles.add(handle);
            }

            current = current.parent_id ? collectionMaps.idToCollection[current.parent_id] : null;
        }
    }

    return [...assignedHandles].join(', ');
}

/**
 * Rewrite the product main row to match top-up requirements.
 * @param {Object} row - Matrixify product row from the base exporter
 * @param {Object} product - Normalized product
 * @param {Object} collectionMaps - Maps for resolving collection handles
 * @returns {Object} Adjusted Matrixify row
 */
function adjustTopupProductRow(row, product, collectionMaps) {
    const customCollections = getTopupCollectionHandles(product, collectionMaps);
    const adjustedRow = {};
    const inventoryLocations = getTopupInventoryLocationColumns();

    for (const [key, value] of Object.entries(row)) {
        if (key === 'Variant Inventory Qty') {
            // Replace the generic stock column with per-location inventory columns
            // so Matrixify can import multi-location quantities without warnings.
            continue;
        }

        if (key === 'Published' && customCollections) {
            adjustedRow[key] = value;
            adjustedRow['Custom Collections'] = customCollections;
            continue;
        }

        if (key === 'Metafield: custom.designers [single_line_text_field]') {
            adjustedRow['Metafield: custom.designers [list.single_line_text_field]'] = formatTopupListValue(value);
            continue;
        }

        if (key === 'Metafield: custom.mechanics [single_line_text_field]') {
            adjustedRow['Metafield: custom.mechanics [list.single_line_text_field]'] = formatTopupListValue(value);
            continue;
        }

        if (key === 'Metafield: custom.publishers [single_line_text_field]') {
            adjustedRow['Metafield: custom.publishers [list.single_line_text_field]'] = formatTopupListValue(value);
            continue;
        }

        adjustedRow[key] = value;
    }

    for (const location of inventoryLocations) {
        adjustedRow[location.column] = getTopupWarehouseQuantity(product, location.externalId);
    }

    if (!adjustedRow['Custom Collections'] && customCollections) {
        adjustedRow['Custom Collections'] = customCollections;
    }

    return adjustedRow;
}

/**
 * Remove the generic inventory quantity column from a Matrixify row.
 * Top-up exports must use location-specific inventory columns instead.
 * @param {Object} row - Matrixify product row
 * @returns {Object} Row without the generic quantity field
 */
function stripTopupVariantInventoryQty(row) {
    const adjustedRow = {};

    for (const [key, value] of Object.entries(row)) {
        if (key === 'Variant Inventory Qty') {
            continue;
        }

        adjustedRow[key] = value;
    }

    return adjustedRow;
}

/**
 * Export top-up products (new products not yet in Shopify)
 * @param {Object} config - Store configuration
 * @param {string} dataDir - Directory with JSON data files
 * @param {string} outputDir - Output directory for Excel files
 * @returns {Promise<Object>} Result with file paths and comparison info
 */
async function exportTopupCommand(config, dataDir, outputDir) {
    console.log('\nComparing Vendre products with Shopify exports...\n');

    // Load Vendre products
    const productsPath = path.join(dataDir, `${config.outputPrefix}-products.json`);
    const vendreProducts = loadVendreData(productsPath);
    console.log(`Loaded ${vendreProducts.length} products from Vendre`);

    // Load Shopify SKUs from the two exported product CSVs
    const shopifyExportFiles = ['products_export_1.csv', 'products_export_2.csv'];
    console.log(`Reading Shopify product exports: ${shopifyExportFiles.join(', ')}`);
    const shopifyProducts = loadShopifyProductKeysFromFiles(outputDir, shopifyExportFiles);
    console.log(
        `Loaded ${shopifyProducts.skus.size} SKUs and ${shopifyProducts.handles.size} handles from Shopify exports\n`
    );

    // Compare products
    const comparison = compareProducts(vendreProducts, shopifyProducts);
    console.log(`Comparison Results:`);
    console.log(`  - New products (to migrate): ${comparison.newProducts.length}`);
    console.log(`  - Already in Shopify: ${comparison.existingProducts.length}`);
    console.log(`  - Matched by SKU: ${comparison.matchedBySku}`);
    console.log(`  - Matched by handle: ${comparison.matchedByHandle}`);
    console.log(`  - Skipped (no SKU): ${comparison.skipped}\n`);

    if (comparison.newProducts.length === 0) {
        console.log('No new products to export.');
        return { newProducts: [] };
    }

    const results = {};

    // Load collections so the top-up workbook assigns products to the same
    // collection handles used by the existing Shopify collection import.
    const collectionsPath = path.join(dataDir, `${config.outputPrefix}-collections.json`);
    const vendreCollections = loadVendreData(collectionsPath);
    const { collections: normalizedCollections, maps: collectionMaps } = transformCollections(vendreCollections, config);
    collectionMaps.titleToHandle = {};
    for (const collection of normalizedCollections) {
        if (collection.title && collection.handle) {
            collectionMaps.titleToHandle[collection.title] = collection.handle;
        }
    }

    // Persist the raw top-up product batch for downstream workflows.
    const topupJsonPath = path.join(outputDir, `${config.outputPrefix}-topup-products.json`);
    safeWriteJson(topupJsonPath, { list: comparison.newProducts });
    console.log(`✓ Saved raw top-up products to ${topupJsonPath}`);
    results.topupJson = topupJsonPath;

    // Keep a compatibility copy at the legacy root path so the translation
    // workflow can continue to consume the same filename if needed.
    const legacyTopupJsonPath = path.join(__dirname, '..', '..', 'results', 'products-topup.json');
    safeWriteJson(legacyTopupJsonPath, { list: comparison.newProducts });
    console.log(`✓ Saved compatibility copy to ${legacyTopupJsonPath}`);
    results.legacyTopupJson = legacyTopupJsonPath;

    // Load tags map
    const tagsPath = path.join(__dirname, '..', '..', 'tags.json');
    const tagsMap = safeReadJson(tagsPath);

    // Transform new products only
    console.log(`Transforming ${comparison.newProducts.length} new products...\n`);
    const newProducts = comparison.newProducts.map(p => transformProduct(p, config, tagsMap));

    // Build the Matrixify rows with collection assignments and correct list metafields.
    const idToHandleMap = {};
    for (const product of newProducts) {
        idToHandleMap[product.vendreId] = product.handle;
    }

    ensureDirectory(outputDir);

    // Export products using the same Matrixify "Products" layout as the full export.
    const productRows = [];
    for (const product of newProducts) {
        const rowsForProduct = buildProductRow(product, config, idToHandleMap);
        if (!rowsForProduct || rowsForProduct.length === 0) {
            continue;
        }

        const [mainRow, ...imageRows] = rowsForProduct;
        productRows.push(
            adjustTopupProductRow(mainRow, product, collectionMaps),
            ...imageRows.map(stripTopupVariantInventoryQty)
        );
    }

    const outputPath = path.join(outputDir, `${config.outputPrefix}-topup-products.xlsx`);
    writeExcelFile(productRows, outputPath, 'Products');
    console.log(`✓ Saved to ${outputPath}`);
    results.topupProducts = outputPath;

    // Export price update
    const priceRows = exportPriceUpdate(newProducts, config);
    const priceOutputPath = path.join(outputDir, `${config.outputPrefix}-topup-price-update.xlsx`);
    writeExcelFile(priceRows, priceOutputPath, 'Price Update');
    console.log(`✓ Saved to ${priceOutputPath}`);
    results.topupPriceUpdate = priceOutputPath;

    // Export vendor update
    const vendorRows = exportVendorUpdate(newProducts);
    const vendorOutputPath = path.join(outputDir, `${config.outputPrefix}-topup-vendor-update.xlsx`);
    writeExcelFile(vendorRows, vendorOutputPath, 'Vendor Update');
    console.log(`✓ Saved to ${vendorOutputPath}`);
    results.topupVendorUpdate = vendorOutputPath;

    console.log('\n✓ Top-up export complete!\n');

    // Print summary
    console.log('Summary:');
    console.log(`  New products exported: ${newProducts.length}`);
    console.log(`  Output files:`);
    console.log(`    - ${path.basename(outputPath)}`);
    console.log(`    - ${path.basename(priceOutputPath)}`);
    console.log(`    - ${path.basename(vendorOutputPath)}\n`);

    return {
        newProducts: newProducts.length,
        existingProducts: comparison.existingProducts.length,
        skipped: comparison.skipped,
        ...results,
    };
}

module.exports = {
    exportProductsCommand,
    exportCollectionsCommand,
    exportProductCollectionsCommand,
    exportTranslations,
    exportCustomersCommand,
    exportAll,
    exportTopupCommand,
};
