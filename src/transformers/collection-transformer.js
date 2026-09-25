/**
 * Collection transformer
 * Converts Vendre category data to normalized collection format
 */

const { getName, getSeoLink, getDescription, getMultilingualField } = require('../utils/fields');
const { buildCollectionMaps, getParentId, isActiveCollection } = require('../utils/collections');
const { sanitizeForShopify } = require('../utils/html');

/**
 * Transform Vendre collections to normalized format with disambiguation
 * @param {Array} collections - Raw Vendre collections
 * @param {Object} config - Store configuration
 * @returns {Object} { collections: Array, maps: Object }
 */
function transformCollections(collections, config = {}) {
    // Build disambiguation maps
    const { idToTitle, idToHandle, idToCollection } = buildCollectionMaps(collections, config);

    // Transform each collection
    const transformed = collections.map(col => transformCollection(
        col,
        idToTitle,
        idToHandle,
        config
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
 * @param {Object} config - Store configuration
 * @returns {Object|null} Normalized collection or null if invalid
 */
function transformCollection(collection, idToTitle, idToHandle, config = {}) {
    const sourceTitle = getName(collection);
    const title = config.preserveCollectionTitles ? sourceTitle : idToTitle[collection.id];
    if (!title) return null;

    const handle = idToHandle[collection.id];
    const description = getDescription(collection);
    const vendreRawName = sourceTitle;

    // Build Vendre handle from full path, excluding language prefix
    // Example: sv/leksaker/utkladnad-rollek/kokslek/ -> leksaker-utkladnad-rollek-kokslek
    let vendreRawHandle = '';
    if (collection.seo_link) {
        const seoLinkPath = collection.seo_link.sv || collection.seo_link.en || '';
        const segments = seoLinkPath.split('/').filter(s => s.length > 0);
        // Skip first segment (language code) and join the rest with hyphens
        if (segments.length > 1) {
            vendreRawHandle = segments.slice(1).join('-');
        } else if (segments.length === 1) {
            // If only one segment, use it as is (shouldn't happen with language prefix, but fallback)
            vendreRawHandle = segments[0];
        }
    }

    return {
        // Identity
        vendreId: collection.id,
        handle,
        title,

        // Vendre raw data
        vendreRawName,
        vendreRawHandle,

        // Hierarchy
        parentId: getParentId(collection),

        // Content
        description: sanitizeForShopify(description),
        descriptionPlain: description ? description.replace(/<[^>]*>/g, ' ').trim() : '',

        // Media
        image: extractCollectionImage(collection, config),

        // SEO
        seoLink: getSeoLink(collection),
        seoTitle: getMultilingualField(collection, 'meta_title') || title,
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
 * @param {Object} config - Store configuration
 * @returns {Object|null} Image object or null
 */
function extractCollectionImage(collection, config = {}) {
    // Try different image URL formats used by different Vendre stores
    let imageUrl = null;
    let imageId = null;

    // Check for nested image object (dragonslair format)
    if (collection.image && collection.image.url) {
        imageUrl = collection.image.url;
        imageId = collection.image.id;
    }
    // Check for flat image_url field (mickieofsweden format)
    else if (collection.image_url) {
        imageUrl = collection.image_url;
        imageId = collection.image_id;
    }

    if (imageUrl) {
        // Build full URL if we have image_id and apiUrl
        let fullUrl = imageUrl;
        if (imageId && config.apiUrl && imageUrl.startsWith('/')) {
            // Extract filename from path (e.g., /path/to/image.jpg -> image.jpg)
            const filename = imageUrl.split('/').pop();
            // Extract domain from apiUrl (e.g., https://mickiofsweden.com/API/1 -> mickiofsweden.com)
            const domain = config.apiUrl.split('/')[2];
            fullUrl = `https://${domain}/image/${imageId}/${filename}`;
        }

        return {
            src: fullUrl,
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
    const metaDescription = getMultilingualField(collection, 'meta_description');
    if (metaDescription) return metaDescription;

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
