/**
 * Matrixify Products Exporter
 * Exports normalized products to Matrixify Excel format
 */

const { PRODUCT_COLUMNS } = require('../config/matrixify');
const { sanitizeForShopify } = require('../utils/html');
const { calculatePricing } = require('../transformers/product-transformer');

function formatMetafieldValue(key, value, config) {
    if (config.booleanMetafieldKeys?.includes(key)) {
        const normalized = String(value).trim().toLowerCase();
        if (['ja', 'true', 'yes', '1'].includes(normalized)) return 'true';
        if (['nej', 'false', 'no', '0'].includes(normalized)) return 'false';
        return null;
    }

    if (config.dateMetafieldKeys?.includes(key)) {
        const match = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
        if (!match) return null;

        const [, month, day, year] = match;
        return `20${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    return value;
}

/**
 * Export products to Matrixify format
 * @param {Array} products - Array of normalized products
 * @param {Object} config - Store configuration
 * @returns {Array} Array of Matrixify product rows
 */
function exportProducts(products, config) {
    const rows = [];
    let skipped = 0;

    // Build a map of Vendre ID to handle for all products
    const idToHandleMap = {};
    for (const product of products) {
        idToHandleMap[product.vendreId] = product.handle;
    }

    for (const product of products) {
        try {
            const row = buildProductRow(product, config, idToHandleMap);
            if (row) {
                rows.push(row);
            } else {
                skipped++;
            }
        } catch (error) {
            console.warn(`Error exporting product ${product.vendreId}: ${error.message}`);
            skipped++;
        }
    }

    console.log(`Exported ${rows.length} products, skipped ${skipped}`);
    return rows;
}

/**
 * Build a single Matrixify product row
 * @param {Object} product - Normalized product
 * @param {Object} config - Store configuration
 * @param {Object} idToHandleMap - Map of Vendre product ID to handle
 * @returns {Object|null} Matrixify row or null if should skip
 */
function buildProductRow(product, config, idToHandleMap) {
    // Skip inactive products
    // if (!product.isActive || !product.show) {
    //     return null;
    // }

    const pricing = calculatePricing(product, config);
    const C = PRODUCT_COLUMNS;
    const sku = product.sku || '';
    const externalId = product.externalId || '';

    const row = {
        [C.HANDLE]: product.handle,
        [C.TITLE]: product.title,
        [C.BODY_HTML]: sanitizeForShopify(product.description),
        [C.VENDOR]: config.blankVendor ? '' : (product.vendor || ''),
        [C.TYPE]: product.productType || '',
        [C.TAGS]: product.tags.join(', '),
        [C.PUBLISHED]: product.isActive || product.show ? 'TRUE' : 'FALSE',
        [C.VARIANT_SKU]: sku,
        [C.VARIANT_BARCODE]: product.ean || '',
        [C.VARIANT_PRICE]: pricing.price,
        [C.VARIANT_COMPARE_AT_PRICE]: pricing.compareAtPrice || '',
        [C.VARIANT_FULFILLMENT_SERVICE]: 'manual',
        [C.VARIANT_REQUIRES_SHIPPING]: 'TRUE',
        [C.VARIANT_TAXABLE]: 'TRUE',
        [C.VARIANT_WEIGHT]: '', // Not provided by Vendre
        [C.VARIANT_WEIGHT_UNIT]: 'kg',
        [C.IMAGE_SRC]: product.images.length > 0 ? product.images[0].src : '',
        [C.IMAGE_POSITION]: product.images.length > 0 ? String(product.images[0].position) : '',
        [C.IMAGE_ALT_TEXT]: product.images.length > 0 ? product.images[0].altText : '',
        [C.SEO_TITLE]: product.seoTitle,
        [C.SEO_DESCRIPTION]: product.seoDescription,
    };

    if (config.includeInventoryFields !== false) {
        row[C.VARIANT_INVENTORY_QTY] = product.quantity || product.stock || 0;
        row[C.VARIANT_INVENTORY_POLICY] = 'deny'; // Don't allow overselling
    }

    if (config.includeDescriptionShort !== false) {
        row['Metafield: custom.description_short [single_line_text_field]'] = product.descriptionShort
            ? String(product.descriptionShort).replace(/\s+/g, ' ').trim()
            : '';
    }

    // Add manufacturer metafields
    if (config.includeManufacturerName !== false && product.manufacturerName) {
        row['Metafield: custom.manufacturer_name [single_line_text_field]'] = product.manufacturerName;
    }
    if (product.manufacturerModel) {
        row['Metafield: custom.manufacturer_model [single_line_text_field]'] = product.manufacturerModel;
    }
    if (externalId) {
        row['Metafield: custom.external_id [single_line_text_field]'] = externalId;
    }

    // Add dynamic metafields from specifications
    for (const [key, value] of Object.entries(product.specifications)) {
        if (config.excludedMetafieldKeys?.includes(key)) continue;

        const isList = Array.isArray(value);
        const type = config.booleanMetafieldKeys?.includes(key)
            ? 'boolean'
            : config.dateMetafieldKeys?.includes(key)
                ? 'date'
                : isList
                    ? 'list.single_line_text_field'
                    : 'single_line_text_field';
        const metafieldKey = `Metafield: custom.${key.toLowerCase()} [${type}]`;
        const formattedValue = isList
            ? JSON.stringify(value)
            : formatMetafieldValue(key, value, config);

        if (formattedValue == null) continue;

        /*
         * List values retain Matrixify's JSON-array format. Scalar boolean and
         * date values are normalized above to Shopify's accepted formats.
         */
        row[metafieldKey] = formattedValue;
    }

    // Add related products metafield
    if (product.associatedProductIds && product.associatedProductIds.length > 0) {
        const relatedHandles = product.associatedProductIds
            .map(id => idToHandleMap[id])
            .filter(Boolean) // Filter out any IDs that couldn't be mapped
            .join(',');
        row['Metafield: custom.related_products [list.product_reference]'] = relatedHandles;
    }

    // Add additional image rows
    const imageRows = [];
    for (let i = 1; i < product.images.length; i++) {
        const img = product.images[i];
        const imgRow = {
            [C.HANDLE]: product.handle,
            [C.IMAGE_SRC]: img.src,
            [C.IMAGE_POSITION]: String(img.position),
            [C.IMAGE_ALT_TEXT]: img.altText,
        };
        // Fill other columns with empty strings
        const productColumns = Object.values(C).filter(col =>
            config.includeInventoryFields !== false || (
                col !== C.VARIANT_INVENTORY_QTY &&
                col !== C.VARIANT_INVENTORY_POLICY
            )
        );
        for (const col of productColumns) {
            if (!(col in imgRow)) {
                imgRow[col] = '';
            }
        }
        imageRows.push(imgRow);
    }

    return imageRows.length > 0 ? [row, ...imageRows] : [row];
}

/**
 * Export products for price updates only
 * @param {Array} products - Array of normalized products
 * @param {Object} config - Store configuration
 * @returns {Array} Array of Matrixify price update rows
 */
function exportPriceUpdate(products, config) {
    const rows = [];
    let skipped = 0;

    for (const product of products) {
        // Skip products with no price or no tax class
        if (product.price == null || !product.taxClassId) {
            skipped++;
            continue;
        }

        const pricing = calculatePricing(product, config);

        rows.push({
            'Handle': product.handle,
            'Variant Price': pricing.price,
            'Variant Compare At Price': pricing.compareAtPrice || '',
        });
    }

    console.log(`Exported ${rows.length} price updates, skipped ${skipped}`);
    return rows;
}

/**
 * Export products for vendor updates only
 * @param {Array} products - Array of normalized products
 * @returns {Array} Array of Matrixify vendor update rows
 */
function exportVendorUpdate(products) {
    return products
        .filter(p => p.vendor)
        .map(p => ({
            'Handle': p.handle,
            'Vendor': p.vendor,
        }));
}

module.exports = {
    exportProducts,
    buildProductRow,
    exportPriceUpdate,
    exportVendorUpdate,
};
