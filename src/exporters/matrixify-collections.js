/**
 * Matrixify Collections Exporter
 * Exports normalized collections to Matrixify Excel format
 */

const { COLLECTION_COLUMNS, COLLECTION_METAFIELD_COLUMNS } = require('../config/matrixify');

/**
 * Export collections to Matrixify format
 * @param {Array} collections - Array of normalized collections
 * @param {Object} maps - Collection maps (idToTitle, idToHandle, idToCollection)
 * @returns {Array} Array of Matrixify collection rows
 */
function exportCollections(collections, maps) {
    const rows = [];

    for (const collection of collections) {
        // Only export active collections
        if (!collection.isActive) continue;

        const row = buildCollectionRow(collection);
        rows.push(row);
    }

    console.log(`Exported ${rows.length} collections`);
    return rows;
}

/**
 * Build a single Matrixify collection row
 * @param {Object} collection - Normalized collection
 * @returns {Object} Matrixify row
 */
function buildCollectionRow(collection) {
    const C = COLLECTION_COLUMNS;

    return {
        [C.HANDLE]: collection.handle,
        [C.TITLE]: collection.title,
        [C.BODY_HTML]: collection.description,
        [C.PUBLISHED]: collection.published ? 'TRUE' : 'FALSE',
        [C.PUBLISHED_SCOPE]: 'global',
        [C.SORT_ORDER]: collection.sortOrder || 'manual',
        [C.TEMPLATE_SUFFIX]: '',
        [C.DISJUNCTIVE]: '',
        [C.RULES]: '',
        [C.PUBLISHED_AT]: '',
        [C.IMAGE_SRC]: collection.image ? collection.image.src : '',
        [C.IMAGE_ALT_TEXT]: collection.image ? collection.image.altText : '',
        [C.SEO_TITLE]: collection.seoTitle,
        [C.SEO_DESCRIPTION]: collection.seoDescription,
    };
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
function exportProductCollections(products, collectionMaps) {
    const rows = [];

    for (const product of products) {
        if (!product.isActive || !product.show || !product.categoryIds || product.categoryIds.length === 0) {
            continue;
        }

        // Create one row per collection assignment
        for (const categoryId of product.categoryIds) {
            const collectionHandle = collectionMaps.idToHandle[categoryId];
            if (!collectionHandle) continue;

            const collectionTitle = collectionMaps.idToTitle[categoryId];
            if (!collectionTitle) continue;

            rows.push({
                'Handle': product.handle,
                'Collection': collectionTitle, // Matrixify expects title, not handle
            });
        }
    }

    console.log(`Exported ${rows.length} product-collection assignments`);
    return rows;
}

/**
 * Export subcollection relationships (parent-child hierarchy)
 * @param {Array} collections - Array of normalized collections
 * @param {Object} maps - Collection maps
 * @returns {Array} Array of subcollection update rows
 */
function exportSubcollections(collections, maps) {
    const rows = [];

    for (const collection of collections) {
        if (!collection.parentId || !collection.isActive) continue;

        const parentTitle = maps.idToTitle[collection.parentId];
        if (!parentTitle) continue;

        rows.push({
            'Handle': collection.handle,
            'Title': collection.title,
            'Parent Collection': parentTitle,
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
