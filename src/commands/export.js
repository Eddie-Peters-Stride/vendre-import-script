/**
 * Export command - Transform and export data to Matrixify Excel files
 */

const path = require('path');
const fs = require('fs');
const { loadVendreData, writeExcelFile, safeReadJson, ensureDirectory } = require('../utils/file-io');
const { transformProduct } = require('../transformers/product-transformer');
const { transformCollections } = require('../transformers/collection-transformer');
const { transformCustomer } = require('../transformers/customer-transformer');
const { exportProducts, exportPriceUpdate, exportVendorUpdate } = require('../exporters/matrixify-products');
const { exportCollections, exportCollectionMetafields, exportProductCollections, exportSubcollections } = require('../exporters/matrixify-collections');
const { exportCustomers, exportCustomersWithoutPhone } = require('../exporters/matrixify-customers');
const { exportProductTranslations, buildSkuToHandleMap, buildHandleToIdMap, parseShopifyCsv } = require('../exporters/matrixify-translations');

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
    const { collections, maps } = transformCollections(vendreCollections);

    ensureDirectory(outputDir);
    const results = {};

    // Full collection export
    if (options.full !== false) {
        const rows = exportCollections(collections, maps);
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
        const rows = exportSubcollections(collections, maps);
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
    const { maps } = transformCollections(vendreCollections);
    const products = vendreProducts.map(p => transformProduct(p, config));

    // Export
    const rows = exportProductCollections(products, maps);

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

module.exports = {
    exportProductsCommand,
    exportCollectionsCommand,
    exportProductCollectionsCommand,
    exportTranslations,
    exportCustomersCommand,
    exportAll,
};
