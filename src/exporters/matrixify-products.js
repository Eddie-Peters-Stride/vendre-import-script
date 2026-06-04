/**
 * Matrixify Products Exporter
 * Exports normalized products to Matrixify Excel format
 */

const { PRODUCT_COLUMNS } = require('../config/matrixify');
const { sanitizeForShopify } = require('../utils/html');
const { calculatePricing } = require('../transformers/product-transformer');

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

    const row = {
        [C.HANDLE]: product.handle,
        [C.TITLE]: product.title,
        [C.BODY_HTML]: sanitizeForShopify(product.description),
        [C.VENDOR]: product.vendor || '',
        [C.TYPE]: product.productType || '',
        [C.TAGS]: product.tags.join(', '),
        [C.PUBLISHED]: product.isActive || product.show ? 'TRUE' : 'FALSE',
        [C.VARIANT_SKU]: product.sku,
        [C.VARIANT_PRICE]: pricing.price,
        [C.VARIANT_COMPARE_AT_PRICE]: pricing.compareAtPrice || '',
        [C.VARIANT_INVENTORY_QTY]: product.stock || 0,
        [C.VARIANT_INVENTORY_POLICY]: 'deny', // Don't allow overselling
        [C.VARIANT_FULFILLMENT_SERVICE]: 'manual',
        [C.VARIANT_REQUIRES_SHIPPING]: 'TRUE',
        [C.VARIANT_TAXABLE]: 'TRUE',
        [C.VARIANT_WEIGHT]: '', // Not provided by Vendre
        [C.VARIANT_WEIGHT_UNIT]: 'kg',
        [C.IMAGE_SRC]: product.images.length > 0 ? product.images[0].src : '',
        [C.IMAGE_POSITION]: product.images.length > 0 ? '1' : '',
        [C.IMAGE_ALT_TEXT]: product.images.length > 0 ? product.images[0].altText : '',
        [C.SEO_TITLE]: product.seoTitle,
        [C.SEO_DESCRIPTION]: product.seoDescription,
    };

    // Add dynamic metafields from specifications
    for (const [key, value] of Object.entries(product.specifications)) {
        const metafieldKey = `Metafield: custom.${key.toLowerCase()} [single_line_text_field]`;
        row[metafieldKey] = value;
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
            [C.IMAGE_POSITION]: String(i + 1),
            [C.IMAGE_ALT_TEXT]: img.altText,
        };
        // Fill other columns with empty strings
        for (const col of Object.values(C)) {
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
    exportPriceUpdate,
    exportVendorUpdate,
};
