/**
 * Utilities for generating Shopify-compatible handles from Vendre entities
 */

const { getSeoLink, getName, normalizeSwedenText } = require('./fields');

/**
 * Slugify a string into a Shopify-compatible handle
 * @param {string} str - Input string
 * @returns {string} Slugified handle
 */
function slugify(str) {
    if (!str) return '';
    return normalizeSwedenText(str)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

/**
 * Extract handle from SEO link (last path segment)
 * @param {string} seoLink - Full SEO link
 * @returns {string} Handle (last segment)
 */
function getHandleFromSeoLink(seoLink) {
    if (!seoLink) return '';
    const parts = seoLink.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || '';
}

/**
 * Get product handle from Vendre product
 * Prefers seo_link last segment, falls back to slugified name
 * @param {Object} product - Vendre product object
 * @returns {string} Product handle
 */
function getProductHandle(product) {
    const seoLink = getSeoLink(product);
    if (seoLink) {
        const slug = getHandleFromSeoLink(seoLink);
        if (slug) return slug;
    }

    // Fallback: slugify the name
    const name = getName(product) || `product-${product.id}`;
    return slugify(name);
}

/**
 * Get collection handle from Vendre collection
 * Uses seo_link last segment (matches Vendre/Shopify URL slugs)
 * @param {Object} collection - Vendre collection object
 * @returns {string} Collection handle
 */
function getCollectionHandle(collection) {
    const seoLink = getSeoLink(collection);
    if (seoLink) {
        const slug = getHandleFromSeoLink(seoLink);
        if (slug) return slug;
    }

    // Fallback: slugify the name
    const name = getName(collection) || `collection-${collection.id}`;
    return slugify(name);
}

/**
 * Resolve handle collisions by appending IDs
 * @param {Object} idToHandle - Map of entity ID to handle
 * @returns {Object} Updated map with unique handles
 */
function resolveHandleCollisions(idToHandle) {
    const handleCount = {};
    Object.values(idToHandle).forEach(h => {
        handleCount[h] = (handleCount[h] || 0) + 1;
    });

    const duplicateHandles = new Set(
        Object.keys(handleCount).filter(h => handleCount[h] > 1)
    );

    if (duplicateHandles.size > 0) {
        const updated = { ...idToHandle };
        for (const [id, handle] of Object.entries(idToHandle)) {
            if (duplicateHandles.has(handle)) {
                updated[id] = `${handle}-${id}`;
            }
        }
        return updated;
    }

    return idToHandle;
}

module.exports = {
    slugify,
    getHandleFromSeoLink,
    getProductHandle,
    getCollectionHandle,
    resolveHandleCollisions,
};
