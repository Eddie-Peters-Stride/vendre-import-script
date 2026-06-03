/**
 * Collection transformer
 * Converts Vendre category data to normalized collection format
 */

const { getName, getSeoLink, getDescription } = require('../utils/fields');
const { buildCollectionMaps, getParentId, isActiveCollection } = require('../utils/collections');
const { sanitizeForShopify } = require('../utils/html');

/**
 * Transform Vendre collections to normalized format with disambiguation
 * @param {Array} collections - Raw Vendre collections
 * @returns {Object} { collections: Array, maps: Object }
 */
function transformCollections(collections) {
    // Build disambiguation maps
    const { idToTitle, idToHandle, idToCollection } = buildCollectionMaps(collections);

    // Transform each collection
    const transformed = collections.map(col => transformCollection(
        col,
        idToTitle,
        idToHandle
    )).filter(c => c !== null);

    return {
        collections: transformed,
        maps: { idToTitle, idToHandle, idToCollection },
    };
}

/**
 * Transform a single Vendre collection
 * @param {Object} collection - Raw Vendre collection
 * @param {Object} idToTitle - Map of collection ID to title
 * @param {Object} idToHandle - Map of collection ID to handle
 * @returns {Object|null} Normalized collection or null if invalid
 */
function transformCollection(collection, idToTitle, idToHandle) {
    const title = idToTitle[collection.id];
    if (!title) return null;

    const handle = idToHandle[collection.id];
    const description = getDescription(collection);

    return {
        // Identity
        vendreId: collection.id,
        handle,
        title,

        // Hierarchy
        parentId: getParentId(collection),

        // Content
        description: sanitizeForShopify(description),
        descriptionPlain: description ? description.replace(/<[^>]*>/g, ' ').trim() : '',

        // Media
        image: extractCollectionImage(collection),

        // SEO
        seoLink: getSeoLink(collection),
        seoTitle: title,
        seoDescription: extractCollectionSeoDescription(collection),

        // Status
        isActive: isActiveCollection(collection),

        // Settings
        sortOrder: 'manual', // Default Shopify collection sort
        published: true,

        // Raw data
        _raw: collection,
    };
}

/**
 * Extract collection image
 * @param {Object} collection - Vendre collection
 * @returns {Object|null} Image object or null
 */
function extractCollectionImage(collection) {
    if (collection.image && collection.image.url) {
        return {
            src: collection.image.url,
            altText: getName(collection),
        };
    }
    return null;
}

/**
 * Extract SEO description for collection
 * @param {Object} collection - Vendre collection
 * @returns {string} SEO description
 */
function extractCollectionSeoDescription(collection) {
    const description = getDescription(collection);
    if (!description) return '';

    // Strip HTML and limit to 160 chars
    const plain = description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return plain.substring(0, 160);
}

/**
 * Build collection hierarchy (parent-child relationships)
 * @param {Array} collections - Normalized collections
 * @returns {Object} Map of parent ID to array of child collections
 */
function buildCollectionHierarchy(collections) {
    const hierarchy = {};

    for (const col of collections) {
        const parentId = col.parentId || 'root';
        if (!hierarchy[parentId]) {
            hierarchy[parentId] = [];
        }
        hierarchy[parentId].push(col);
    }

    return hierarchy;
}

/**
 * Get all ancestor IDs for a collection
 * @param {Object} collection - Normalized collection
 * @param {Object} idToCollection - Map of ID to collection
 * @returns {Array<number>} Array of ancestor IDs (root to parent)
 */
function getAncestorIds(collection, idToCollection) {
    const ancestors = [];
    let current = collection;
    const visited = new Set();

    while (current && current.parentId && !visited.has(current.vendreId)) {
        visited.add(current.vendreId);
        ancestors.unshift(current.parentId);
        current = idToCollection[current.parentId];
    }

    return ancestors;
}

module.exports = {
    transformCollections,
    transformCollection,
    buildCollectionHierarchy,
    getAncestorIds,
};
