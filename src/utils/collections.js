/**
 * Collection disambiguation logic - handles hierarchy and name conflicts
 * Consolidates 300+ LOC previously duplicated across 4 files
 */

const { getName } = require('./fields');
const { getCollectionHandle, resolveHandleCollisions } = require('./handles');

/**
 * Build a map of collection ID to collection object
 * @param {Array} collections - Array of Vendre collections
 * @returns {Object} Map of ID to collection
 */
function buildCollectionMap(collections) {
    const idToCollection = {};
    for (const col of collections) {
        idToCollection[col.id] = col;
    }
    return idToCollection;
}

/**
 * Build full ancestor path for a collection (root → leaf)
 * @param {Object} collection - Vendre collection
 * @param {Object} idToCollection - Map of ID to collection
 * @returns {Array} Array of ancestor names from root to this collection
 */
function ancestorPath(collection, idToCollection) {
    const parts = [];
    let current = collection;
    const visited = new Set();

    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        const name = getName(current);
        if (name) parts.unshift(name);
        current = current.parent_id ? idToCollection[current.parent_id] : null;
    }

    return parts;
}

/**
 * Build unique titles for collections
 * - Top-level collections: use name as-is
 * - Child collections: always "Parent - Child" format
 * - For duplicates: keep prepending ancestors until unique
 * 
 * @param {Object} collection - Vendre collection
 * @param {Object} idToCollection - Map of ID to collection
 * @param {Object} leafNameToIds - Map of leaf names to array of collection IDs with that name
 * @returns {string} Unique collection title
 */
function buildCollectionTitle(collection, idToCollection, leafNameToIds) {
    const name = getName(collection);
    if (!name) return '';

    const path = ancestorPath(collection, idToCollection);

    // Top-level collection (no parent): use name as-is
    if (path.length <= 1) return name;

    const sameNameIds = (leafNameToIds[name] || []).filter(id => id !== collection.id);

    // Always include at least the immediate parent (depth=2: parent + leaf)
    const minDepth = 2;
    for (let depth = minDepth; depth <= path.length; depth++) {
        const candidate = path.slice(path.length - depth).join(' - ');
        const hasConflict = sameNameIds.some(id => {
            const other = idToCollection[id];
            if (!other) return false;
            const otherPath = ancestorPath(other, idToCollection);
            return otherPath.slice(otherPath.length - depth).join(' - ') === candidate;
        });
        if (!hasConflict) return candidate;
    }

    // Absolute last resort: full path + ID
    return path.join(' - ') + ' (' + collection.id + ')';
}

/**
 * Build maps of collection ID to title and handle for ALL collections
 * @param {Array} collections - Array of Vendre collections
 * @returns {Object} { idToTitle, idToHandle } maps
 */
function buildCollectionMaps(collections) {
    const idToCollection = buildCollectionMap(collections);

    // Group collections by leaf name to identify duplicates
    const leafNameToIds = {};
    for (const col of collections) {
        const name = getName(col);
        if (!name) continue;
        if (!leafNameToIds[name]) leafNameToIds[name] = [];
        leafNameToIds[name].push(col.id);
    }

    // Build title and handle maps
    const idToTitle = {};
    const idToHandle = {};

    for (const col of collections) {
        const title = buildCollectionTitle(col, idToCollection, leafNameToIds);
        if (!title) continue;

        idToTitle[col.id] = title;
        idToHandle[col.id] = getCollectionHandle(col);
    }

    // Resolve handle collisions
    const uniqueHandles = resolveHandleCollisions(idToHandle);

    return {
        idToTitle,
        idToHandle: uniqueHandles,
        idToCollection,
    };
}

/**
 * Get parent collection ID
 * @param {Object} collection - Vendre collection
 * @returns {number|null} Parent collection ID or null
 */
function getParentId(collection) {
    return collection.parent_id || null;
}

/**
 * Check if collection is active
 * @param {Object} collection - Vendre collection
 * @returns {boolean} True if active
 */
function isActiveCollection(collection) {
    return collection.is_active === true || collection.is_active === 1 || collection.status === true || collection.status === 1;
}

module.exports = {
    buildCollectionMap,
    ancestorPath,
    buildCollectionTitle,
    buildCollectionMaps,
    getParentId,
    isActiveCollection,
};
