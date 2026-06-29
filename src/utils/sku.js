/**
 * SKU helpers
 * Vendre uses `external_id` as the product SKU source of truth.
 */

/**
 * Read a SKU value from a raw Vendre entity or normalized product.
 * Prefers the raw `external_id`, then the normalized `externalId`.
 * @param {Object} entity - Raw Vendre entity or normalized product
 * @returns {string} SKU value or empty string
 */
function getVendreSku(entity) {
    if (!entity) return '';

    const value = entity.external_id ?? entity.externalId;
    if (value === null || value === undefined || value === false || value === '') {
        return '';
    }

    return String(value).trim();
}

module.exports = {
    getVendreSku,
};
