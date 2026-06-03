/**
 * Utilities for handling bilingual fields and Swedish text normalization
 */

/**
 * Extract a multilingual field value (Swedish preferred, fallback to English)
 * @param {Object} obj - The object containing the field
 * @param {string} field - The field name to extract
 * @returns {string} The field value or empty string
 */
function getMultilingualField(obj, field) {
    if (!obj || !obj[field]) return '';
    return obj[field].sv || obj[field].en || '';
}

/**
 * Normalize Swedish characters for URL-safe strings
 * @param {string} str - Input string
 * @returns {string} Normalized string
 */
function normalizeSwedenText(str) {
    if (!str) return '';
    return str
        .replace(/å/g, 'a')
        .replace(/ä/g, 'a')
        .replace(/ö/g, 'o')
        .replace(/Å/g, 'A')
        .replace(/Ä/g, 'A')
        .replace(/Ö/g, 'O');
}

/**
 * Get trimmed name from a Vendre entity (collection or product)
 * @param {Object} entity - Vendre entity with name field
 * @returns {string} Trimmed name
 */
function getName(entity) {
    return getMultilingualField(entity, 'name').trim();
}

/**
 * Get SEO link from a Vendre entity
 * @param {Object} entity - Vendre entity with seo_link field
 * @returns {string} SEO link
 */
function getSeoLink(entity) {
    return getMultilingualField(entity, 'seo_link');
}

/**
 * Get description from a Vendre entity
 * @param {Object} entity - Vendre entity with description field
 * @returns {string} Description
 */
function getDescription(entity) {
    return getMultilingualField(entity, 'description');
}

/**
 * Get short description from a Vendre entity
 * @param {Object} entity - Vendre entity with description_short field
 * @returns {string} Short description
 */
function getShortDescription(entity) {
    return getMultilingualField(entity, 'description_short');
}

module.exports = {
    getMultilingualField,
    normalizeSwedenText,
    getName,
    getSeoLink,
    getDescription,
    getShortDescription,
};
