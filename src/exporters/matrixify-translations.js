/**
 * Matrixify Translations Exporter
 * Exports product translations in Shopify "Translate & Adapt" CSV format
 */

const { TRANSLATION_COLUMNS } = require('../config/matrixify');
const { getShortDesc } = require('../utils/html');

/**
 * Export product translations for Shopify Translate & Adapt
 * @param {Array} products - Array of normalized products
 * @param {Object} shopifyMappings - Maps for SKU→Handle and Handle→ID
 * @param {Object} options - Export options (sourceLocale, targetLocale)
 * @returns {Array} Array of translation rows
 */
function exportProductTranslations(products, shopifyMappings, options = {}) {
    const sourceLocale = options.sourceLocale || 'sv';
    const targetLocale = options.targetLocale || 'en';

    const { skuToHandle, handleToId } = shopifyMappings;

    const rows = [];
    let skipped = 0;

    for (const product of products) {
        try {
            const sku = product.sku;
            if (!sku) {
                skipped++;
                continue;
            }

            // Map SKU → Handle → Shopify ID
            const shopifyHandle = skuToHandle[sku];
            if (!shopifyHandle) {
                skipped++;
                continue;
            }

            const shopifyId = handleToId[shopifyHandle];
            if (!shopifyId) {
                skipped++;
                continue;
            }

            // Generate translation rows for this product
            const translationRows = buildProductTranslationRows(
                product,
                shopifyId,
                sourceLocale,
                targetLocale
            );

            rows.push(...translationRows);
        } catch (error) {
            console.warn(`Error exporting translations for product ${product.vendreId}: ${error.message}`);
            skipped++;
        }
    }

    console.log(`Exported ${rows.length} translation rows, skipped ${skipped} products`);
    return rows;
}

/**
 * Build translation rows for a single product
 * @param {Object} product - Normalized product
 * @param {string} shopifyId - Shopify product ID
 * @param {string} sourceLocale - Source language code
 * @param {string} targetLocale - Target language code
 * @returns {Array} Array of translation rows
 */
function buildProductTranslationRows(product, shopifyId, sourceLocale, targetLocale) {
    const rows = [];
    const C = TRANSLATION_COLUMNS;

    // Helper to add a translation row
    const addTranslation = (field, defaultValue, translatedValue) => {
        if (defaultValue && defaultValue.trim() && translatedValue && translatedValue.trim()) {
            rows.push({
                [C.TYPE]: 'PRODUCT',
                [C.IDENTIFICATION]: shopifyId,
                [C.FIELD]: field,
                [C.LOCALE]: targetLocale,
                [C.MARKET]: '',
                [C.STATUS]: '',
                [C.DEFAULT_CONTENT]: defaultValue,
                [C.TRANSLATED_CONTENT]: translatedValue,
            });
        }
    };

    // Title translation
    const titleDefault = product._raw.name && product._raw.name[sourceLocale];
    const titleTranslated = product._raw.name && product._raw.name[targetLocale];
    addTranslation('title', titleDefault, titleTranslated);

    // Body HTML (description) translation
    const bodyDefault = product._raw.description && product._raw.description[sourceLocale];
    const bodyTranslated = product._raw.description && product._raw.description[targetLocale];
    addTranslation('body_html', bodyDefault, bodyTranslated);

    // Meta title translation
    const metaTitleDefault = product._raw.seo_title && product._raw.seo_title[sourceLocale];
    const metaTitleTranslated = product._raw.seo_title && product._raw.seo_title[targetLocale];
    addTranslation('meta_title', metaTitleDefault, metaTitleTranslated);

    // Meta description translation
    const metaDescDefault = product._raw.seo_description && product._raw.seo_description[sourceLocale];
    const metaDescTranslated = product._raw.seo_description && product._raw.seo_description[targetLocale];
    addTranslation('meta_description', metaDescDefault, metaDescTranslated);

    // Short description metafield translation
    const shortDescDefault = getShortDesc(product._raw, sourceLocale);
    const shortDescTranslated = getShortDesc(product._raw, targetLocale);
    addTranslation('metafield.custom.description_short', shortDescDefault, shortDescTranslated);

    return rows;
}

/**
 * Build SKU to Shopify handle mapping from exported product CSVs
 * @param {Array} shopifyExportRows - Rows from Shopify product export CSV
 * @returns {Object} Map of SKU to handle
 */
function buildSkuToHandleMap(shopifyExportRows) {
    const skuToHandle = {};

    for (const row of shopifyExportRows) {
        const handle = row['Handle'];
        const sku = row['Variant SKU'] && row['Variant SKU'].replace(/^'/, '');

        if (handle && sku && !skuToHandle[sku]) {
            skuToHandle[sku] = handle;
        }
    }

    return skuToHandle;
}

/**
 * Build handle to Shopify product ID mapping from translation export CSVs
 * @param {Array} translationExportRows - Rows from Shopify translation export CSV
 * @returns {Object} Map of handle to Shopify ID
 */
function buildHandleToIdMap(translationExportRows) {
    const handleToId = {};

    for (const row of translationExportRows) {
        if (row['Field'] === 'handle' && row['Identification'] && row['Default content']) {
            const id = row['Identification'].replace(/^'/, '');
            const handle = row['Default content'].trim();

            if (handle && id && !handleToId[handle]) {
                handleToId[handle] = id;
            }
        }
    }

    return handleToId;
}

/**
 * Parse Shopify CSV export file
 * Handles quoted fields and multiline content properly
 * @param {string} csvContent - Raw CSV content
 * @returns {Array} Array of row objects
 */
function parseShopifyCsv(csvContent) {
    // Remove BOM if present
    const raw = csvContent.replace(/^\uFEFF/, '');

    // Split into lines while respecting quoted content
    const lines = [];
    let currentLine = '';
    let inQuotes = false;

    for (let i = 0; i < raw.length; i++) {
        const char = raw[i];
        if (char === '"') {
            inQuotes = !inQuotes;
            currentLine += char;
        } else if (char === '\n' && !inQuotes) {
            lines.push(currentLine);
            currentLine = '';
        } else {
            currentLine += char;
        }
    }
    if (currentLine) lines.push(currentLine);

    // Split line into fields
    const splitLine = (line) => {
        const fields = [];
        let field = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                fields.push(field);
                field = '';
            } else {
                field += char;
            }
        }
        fields.push(field);
        return fields;
    };

    const headers = splitLine(lines[0]);
    return lines.slice(1)
        .filter(line => line.trim())
        .map(line => {
            const values = splitLine(line);
            const obj = {};
            headers.forEach((header, index) => {
                obj[header] = (values[index] || '').trim();
            });
            return obj;
        });
}

module.exports = {
    exportProductTranslations,
    buildProductTranslationRows,
    buildSkuToHandleMap,
    buildHandleToIdMap,
    parseShopifyCsv,
};
