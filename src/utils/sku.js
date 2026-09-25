/**
 * SKU helpers
 * Most stores use `external_id` as the product SKU source of truth.
 * Mickiofsweden and Fyrklövern use `article_number` instead.
 */

/**
 * Normalize a SKU-like value to a trimmed string.
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
 * Legacy raw-Vendre SKU helper.
 * Prefer `getStoreSku()` for exports so store-specific overrides are respected.
 * @param {Object} entity - Raw Vendre entity or normalized product
 * @returns {string} SKU value or empty string
 */
function getVendreSku(entity) {
    if (!entity) return '';

    return normalizeSku(entity.external_id ?? entity.externalId);
}

/**
 * Read the product SKU for a store-specific export.
 * Mickiofsweden and Fyrklövern use `article_number` as the Shopify Variant SKU.
 * Normalized products can also pass through their precomputed `sku` field.
 * @param {Object} entity - Raw Vendre entity or normalized product
 * @param {Object|string} [storeOrConfig] - Store name or config object
 * @returns {string} SKU value or empty string
 */
function getStoreSku(entity, storeOrConfig) {
    if (!entity) return '';

    if (entity.sku != null && entity.sku !== '') {
        return normalizeSku(entity.sku);
    }

    const storeName = typeof storeOrConfig === 'string'
        ? storeOrConfig
        : storeOrConfig?.storeName || storeOrConfig?.outputPrefix || storeOrConfig?.name;

    if (storeName === 'mickiofsweden' || storeName === 'fyrklovern') {
        return normalizeSku(
            entity.article_number ??
            entity.articleNumber ??
            entity.external_id ??
            entity.externalId
        );
    }

    return normalizeSku(
        entity.external_id ??
        entity.externalId ??
        entity.article_number ??
        entity.articleNumber
    );
}

/**
 * Read the external ID for a product.
 * @param {Object} entity - Raw Vendre entity or normalized product
 * @returns {string} External ID value or empty string
 */
function getVendreExternalId(entity) {
    if (!entity) return '';

    return normalizeSku(entity.external_id ?? entity.externalId);
}

module.exports = {
    normalizeSku,
    getVendreSku,
    getStoreSku,
    getVendreExternalId,
};
