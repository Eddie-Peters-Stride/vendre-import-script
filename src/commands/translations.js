/**
 * Standalone translations export command.
 * Generates a Matrixify "Translations" workbook for products and collections.
 */

const path = require('path');
const fs = require('fs');
const { loadVendreData, writeExcelFile, safeReadJson, ensureDirectory } = require('../utils/file-io');
const { transformProduct } = require('../transformers/product-transformer');
const { transformCollections } = require('../transformers/collection-transformer');
const {
    exportProductTranslations,
    exportCollectionTranslations,
    buildSkuToHandleMap,
    buildEntityHandleToIdMaps,
    parseShopifyCsv,
} = require('../exporters/matrixify-translations');

/**
 * Export product and collection translations to a Matrixify workbook.
 * @param {Object} config - Store configuration
 * @param {string} dataDir - Directory with source JSON files
 * @param {string} outputDir - Directory for Matrixify output
 * @returns {Promise<{rows: Array, outputPath: string|null}>} Export result
 */
async function exportTranslationsCommand(config, dataDir, outputDir) {
    console.log('\nExporting translations...\n');
    ensureDirectory(outputDir);

    const productsPath = path.join(dataDir, `${config.outputPrefix}-products.json`);
    const collectionsPath = path.join(dataDir, `${config.outputPrefix}-collections.json`);
    const tagsPath = path.join(__dirname, '..', '..', 'tags.json');

    const vendreProducts = loadVendreData(productsPath);
    const vendreCollections = loadVendreData(collectionsPath);
    const tagsMap = safeReadJson(tagsPath);

    const products = vendreProducts.map(product => transformProduct(product, config, tagsMap));
    const collections = transformCollections(vendreCollections, config).collections;
    const sourceLocale = 'sv';
    const targetLocales = discoverTargetLocales(vendreProducts, vendreCollections, sourceLocale);
    const localeFallbacks = {
        en: ['gb'],
    };

    const skuToHandle = loadSkuToHandleMap(outputDir);
    const handleToId = loadEntityHandleToIdMaps(outputDir);

    console.log(`Source locale: ${sourceLocale}`);
    console.log(`Target locales: ${targetLocales.join(', ') || '(none)'}`);

    const rows = [
        ...exportProductTranslations(
            products,
            {
                skuToHandle,
                handleToId: handleToId.Product,
            },
            {
                sourceLocale,
                targetLocales,
                localeFallbacks,
                specFields: config.specFields,
            }
        ),
        ...exportCollectionTranslations(
            collections,
            {
                handleToId: handleToId.Collection,
            },
            {
                sourceLocale,
                targetLocales,
                localeFallbacks,
                includeVendreData: config.exportSettings?.includeVendreData === true,
                onlyActive: true,
            }
        ),
    ].sort(compareTranslationRows);

    if (rows.length === 0) {
        console.log('No translation rows generated.');
        return { rows: [], outputPath: null };
    }

    ensureDirectory(outputDir);
    const outputPath = writeTranslationsWorkbook(rows, outputDir, config.outputPrefix);
    console.log(`Saved translations to ${outputPath}`);

    return {
        rows,
        outputPath,
    };
}

/**
 * Build a SKU to Shopify handle map from product export CSVs.
 * @param {string} outputDir - Store output directory
 * @returns {Object} SKU to handle map
 */
function loadSkuToHandleMap(outputDir) {
    const skuToHandle = {};
    const productExportFiles = fs.readdirSync(outputDir)
        .filter(file => /^products_export_.*\.csv$/i.test(file))
        .sort();

    console.log(`Found product export CSVs: ${productExportFiles.join(', ') || '(none)'}`);

    for (const file of productExportFiles) {
        const filePath = path.join(outputDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        Object.assign(skuToHandle, buildSkuToHandleMap(parseShopifyCsv(content)));
    }

    console.log(`Loaded ${Object.keys(skuToHandle).length} SKU to handle mappings`);
    return skuToHandle;
}

/**
 * Build entity-specific handle to Shopify ID maps from translation export CSVs.
 * @param {string} outputDir - Store output directory
 * @returns {{Product: Object, Collection: Object}} Handle to ID maps
 */
function loadEntityHandleToIdMaps(outputDir) {
    const handleToId = {
        Product: {},
        Collection: {},
    };
    const translationExportFiles = fs.readdirSync(outputDir)
        .filter(file => file.toLowerCase().endsWith('.csv'))
        .filter(file => /translation/i.test(file))
        .sort();

    console.log(`Found translation export CSVs: ${translationExportFiles.join(', ') || '(none)'}`);

    for (const file of translationExportFiles) {
        const filePath = path.join(outputDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const rows = parseShopifyCsv(content);
        const mapping = buildEntityHandleToIdMaps(rows);
        Object.assign(handleToId.Product, mapping.Product);
        Object.assign(handleToId.Collection, mapping.Collection);
    }

    console.log(
        `Loaded ${Object.keys(handleToId.Product).length} product handle to ID mappings and ` +
        `${Object.keys(handleToId.Collection).length} collection handle to ID mappings`
    );

    return handleToId;
}

/**
 * Deterministic sort for Matrixify translation rows.
 * @param {Object} left - First row
 * @param {Object} right - Second row
 * @returns {number} Sort result
 */
function compareTranslationRows(left, right) {
    if (left['Entity'] !== right['Entity']) {
        return left['Entity'].localeCompare(right['Entity']);
    }
    if (left['Entity Handle'] !== right['Entity Handle']) {
        return left['Entity Handle'].localeCompare(right['Entity Handle']);
    }
    return left['Field'].localeCompare(right['Field']);
}

/**
 * Discover translated locales from Vendre multilingual fields.
 * The source locale is excluded from the result.
 * @param {Array} products - Raw Vendre products
 * @param {Array} collections - Raw Vendre collections
 * @param {string} sourceLocale - Default/source locale
 * @returns {string[]} Ordered target locales
 */
function discoverTargetLocales(products, collections, sourceLocale) {
    const localeSet = new Set();
    const productFields = ['name', 'description', 'description_short', 'meta_title', 'meta_description', 'seo_link'];
    const collectionFields = ['name', 'description', 'meta_title', 'meta_description', 'seo_link'];

    collectLocales(products, productFields, localeSet);
    collectLocales(collections, collectionFields, localeSet);
    localeSet.delete(sourceLocale);

    // Keep GB content available as fallback input for EN, but do not emit a
    // separate GB import column in the Matrixify workbook.
    if (localeSet.has('gb')) {
        localeSet.add('en');
        localeSet.delete('gb');
    }

    return sortLocales([...localeSet]);
}

/**
 * Add locale keys from multilingual fields to the set.
 * @param {Array} items - Raw Vendre entities
 * @param {string[]} fields - Multilingual field names
 * @param {Set<string>} localeSet - Mutable locale set
 */
function collectLocales(items, fields, localeSet) {
    for (const item of items) {
        for (const field of fields) {
            const value = item[field];
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                continue;
            }

            for (const [locale, localizedValue] of Object.entries(value)) {
                if (String(localizedValue || '').trim()) {
                    localeSet.add(locale);
                }
            }
        }
    }
}

/**
 * Sort locales in the preferred storefront order.
 * @param {string[]} locales - Locale codes
 * @returns {string[]} Sorted locales
 */
function sortLocales(locales) {
    const preferredOrder = ['en', 'nb', 'de', 'da', 'fi'];
    const remaining = locales
        .filter(locale => !preferredOrder.includes(locale))
        .sort((left, right) => left.localeCompare(right));

    return [
        ...preferredOrder.filter(locale => locales.includes(locale)),
        ...remaining,
    ];
}

/**
 * Write the translations workbook, falling back to a generated filename when the
 * default output file is locked by another application.
 * @param {Array} rows - Translation rows
 * @param {string} outputDir - Store output directory
 * @param {string} outputPrefix - Store output prefix
 * @returns {string} Path to the written workbook
 */
function writeTranslationsWorkbook(rows, outputDir, outputPrefix) {
    const primaryPath = path.join(outputDir, `${outputPrefix}-translations.xlsx`);

    try {
        writeExcelFile(rows, primaryPath, 'Translations');
        return primaryPath;
    } catch (error) {
        if (!isFileLockError(error)) {
            throw error;
        }

        const fallbackPath = path.join(
            outputDir,
            `${outputPrefix}-translations-generated-${Date.now()}.xlsx`
        );
        writeExcelFile(rows, fallbackPath, 'Translations');
        console.warn(`Primary translations workbook was locked. Wrote fallback file: ${fallbackPath}`);
        return fallbackPath;
    }
}

/**
 * Check whether an Excel write error was caused by a locked/busy file.
 * @param {Error} error - Write error
 * @returns {boolean} True if it looks like a file lock issue
 */
function isFileLockError(error) {
    return /EBUSY|EACCES/i.test(String(error && error.message));
}

module.exports = {
    exportTranslationsCommand,
};
