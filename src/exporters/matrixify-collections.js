/**
 * Matrixify Collections Exporter
 * Exports normalized collections to Matrixify Excel format
 */

const { COLLECTION_COLUMNS, COLLECTION_METAFIELD_COLUMNS } = require('../config/matrixify');

/**
 * Export collections to Matrixify format
 * @param {Array} collections - Array of normalized collections
 * @param {Object} maps - Collection maps (idToTitle, idToHandle, idToCollection)
 * @param {Object} config - Store configuration
 * @returns {Array} Array of Matrixify collection rows
 */
function exportCollections(collections, maps, config = {}) {
    const rows = [];

    for (const collection of collections) {
        // Only export active collections
        if (!collection.isActive) continue;

        const row = buildCollectionRow(collection, config);
        rows.push(row);
    }

    console.log(`Exported ${rows.length} collections`);
    return rows;
}

/**
 * Build a single Matrixify collection row
 * @param {Object} collection - Normalized collection
 * @param {Object} config - Store configuration
 * @returns {Object} Matrixify row
 */
function buildCollectionRow(collection, config = {}) {
    const C = COLLECTION_COLUMNS;
    const includeVendreData = config.exportSettings?.includeVendreData || false;

    // Use raw Vendre data if configured, otherwise use processed/disambiguated names
    const handle = includeVendreData ? collection.vendreRawHandle : collection.handle;
    const title = includeVendreData ? collection.vendreRawName : collection.title;

    const row = {
        [C.COMMAND]: "MERGE",
        [C.HANDLE]: handle,
        [C.TITLE]: title,
        [C.BODY_HTML]: collection.description,
        [C.PUBLISHED]: collection.published ? 'TRUE' : 'FALSE',
        [C.PUBLISHED_SCOPE]: 'global',
        [C.SORT_ORDER]: collection.sortOrder || 'manual',
        [C.IMAGE_SRC]: collection.image ? collection.image.src : '',
        [C.IMAGE_ALT_TEXT]: collection.image ? collection.image.altText : '',
        [C.SEO_TITLE]: collection.seoTitle,
        [C.SEO_DESCRIPTION]: collection.seoDescription,
    };

    return row;
}

/**
 * Export collection metafields for parent-child relationships
 * @param {Array} collections - Array of normalized collections
 * @param {Object} maps - Collection maps
 * @returns {Array} Array of Matrixify collection metafield rows
 */
function exportCollectionMetafields(collections, maps) {
    const rows = [];

    for (const collection of collections) {
        if (!collection.parentId || !collection.isActive) continue;

        const parentHandle = maps.idToHandle[collection.parentId];
        if (!parentHandle) continue;

        rows.push({
            'Handle': collection.handle,
            'Metafield: custom.parent_collection [single_line_text_field]': parentHandle,
        });
    }

    console.log(`Exported ${rows.length} collection metafields`);
    return rows;
}

/**
 * Export product-collection assignments
 * @param {Array} products - Array of normalized products
 * @param {Object} collectionMaps - Collection maps
 * @returns {Array} Array of product-collection assignment rows
 */
function exportProductCollections(products, collections, config = {}) {
    const rows = [];
    const includeVendreData = config.exportSettings?.includeVendreData || false;

    // Build handle map based on config
    const collectionHandleMap = {};
    for (const collection of collections) {
        const handle = includeVendreData ? collection.vendreRawHandle : collection.handle;
        collectionHandleMap[collection.vendreId] = handle;
    }

    for (const product of products) {
        if (!product.isActive || !product.show || !product.categoryIds || product.categoryIds.length === 0) {
            continue;
        }

        // Create one row per collection assignment
        for (const categoryId of product.categoryIds) {
            const collectionHandle = collectionHandleMap[categoryId];
            if (!collectionHandle) continue;

            rows.push({
                'Handle': product.handle,
                'Collection': collectionHandle,
            });
        }
    }

    console.log(`Exported ${rows.length} product-collection assignments`);
    return rows;
}

/**
 * Export subcollection relationships (parent-child hierarchy)
 * @param {Array} collections - Array of normalized collections
 * @param {Object} config - Store configuration
 * @returns {Array} Array of subcollection update rows
 */
function exportSubcollections(collections, config = {}) {
    const rows = [];
    const includeVendreData = config.exportSettings?.includeVendreData || false;

    // Group subcollections by parent ID
    const subcollectionsByParent = {};

    for (const collection of collections) {
        if (!collection.parentId || !collection.isActive) continue;

        if (!subcollectionsByParent[collection.parentId]) {
            subcollectionsByParent[collection.parentId] = [];
        }

        const childHandle = includeVendreData ? collection.vendreRawHandle : collection.handle;
        subcollectionsByParent[collection.parentId].push(childHandle);
    }

    // Create rows for parent collections with their subcollections
    for (const parentId in subcollectionsByParent) {
        const parentCollection = collections.find(c => c.vendreId === parseInt(parentId));
        if (!parentCollection) continue;

        const parentHandle = includeVendreData ? parentCollection.vendreRawHandle : parentCollection.handle;
        const subcollectionHandles = subcollectionsByParent[parentId].join(',');

        rows.push({
            'Handle': parentHandle,
            'Metafield: custom.subcollections [list.collection_reference]': subcollectionHandles,
        });
    }

    console.log(`Exported ${rows.length} subcollection relationships`);
    return rows;
}

module.exports = {
    exportCollections,
    exportCollectionMetafields,
    exportProductCollections,
    exportSubcollections,
};
