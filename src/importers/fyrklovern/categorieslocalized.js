/**
 * Fyrklövern category-localization import adapter.
 *
 * Stages the Swedish category content from the flat Excel export. Hierarchy is
 * deliberately left for the separate `category structure` worksheet.
 */

const XLSX = require('xlsx');
const { slugify } = require('../../utils/handles');

const CATEGORIESLOCALIZED_SHEET = 'categorieslocalized';
const CATEGORY_STRUCTURE_SHEET = 'category structure';
const CATEGORY_PERMALINKS_SHEET = 'categorypermalinks';
const SOURCE_CULTURE = 'sv-SE';

function cleanValue(value) {
    if (value == null || value === 'NULL') return '';
    return String(value).trim();
}

function buildHierarchyByCategoryId(rows) {
    const hierarchyByCategoryId = {};

    for (const row of rows) {
        if (cleanValue(row.Culture) !== SOURCE_CULTURE) continue;

        const categoryId = cleanValue(row['Last CategoryID']);
        const categoryIds = cleanValue(row['Hierarchy - CategoryID'])
            .split('>')
            .map(id => id.trim())
            .filter(Boolean);
        const breadcrumbs = cleanValue(row['Hierarchy - Breadcrumbs'])
            .split('>')
            .map(name => name.trim())
            .filter(Boolean);

        if (!categoryId || categoryIds.length === 0 || breadcrumbs.length === 0) continue;

        hierarchyByCategoryId[categoryId] = {
            categoryIds,
            breadcrumbs,
        };
    }

    return hierarchyByCategoryId;
}

function buildPermalinkByCategoryId(rows) {
    const permalinkByCategoryId = {};

    for (const row of rows) {
        if (cleanValue(row.Culture) !== SOURCE_CULTURE) continue;

        const categoryId = cleanValue(row.CategoryID);
        const permalink = cleanValue(row.Link);
        if (categoryId && permalink) permalinkByCategoryId[categoryId] = permalink;
    }

    return permalinkByCategoryId;
}

function permalinkToHandle(permalink) {
    return cleanValue(permalink)
        .replace(/[?#].*$/, '')
        .split('/')
        .filter(Boolean)
        .map(slugify)
        .filter(Boolean)
        .join('-');
}

function adaptCategory(row, hierarchyByCategoryId = {}, permalinkByCategoryId = {}) {
    const name = cleanValue(row.name);
    const categoryId = cleanValue(row.categoryid);
    const hierarchy = hierarchyByCategoryId[categoryId];
    const permalink = permalinkByCategoryId[categoryId];
    const hierarchyHandle = hierarchy
        ? slugify(hierarchy.breadcrumbs.join('-'))
        : slugify(name);

    return {
        id: categoryId,
        category_level: cleanValue(row.CategoryLevel),
        // Preserve the full Swedish category URL path as an ID-free Shopify
        // handle, e.g. /kampanjer/10-1/ -> kampanjer-10-1.
        handle: permalinkToHandle(permalink) || hierarchyHandle,
        parent_id: hierarchy && hierarchy.categoryIds.length > 1
            ? hierarchy.categoryIds.at(-2)
            : null,
        name: { sv: name },
        description: { sv: cleanValue(row.content) },
        meta_title: { sv: cleanValue(row.pagetitle) },
        meta_description: { sv: cleanValue(row.metadescription) },
        meta_keywords: { sv: cleanValue(row.metakeywords) },
        main_header: { sv: cleanValue(row.mainheader) },
        status: true,
    };
}

/**
 * Read the Swedish categories from Fyrklövern's localization worksheet.
 * @param {string} inputPath Path to `fyrklovern_custom_export.xlsx`
 * @returns {Array<Object>} Categories in the shared raw staging shape
 */
function readCategorieslocalized(inputPath) {
    const workbook = XLSX.readFile(inputPath, { raw: false });
    const worksheet = workbook.Sheets[CATEGORIESLOCALIZED_SHEET];
    const categoryStructureWorksheet = workbook.Sheets[CATEGORY_STRUCTURE_SHEET];
    const categoryPermalinksWorksheet = workbook.Sheets[CATEGORY_PERMALINKS_SHEET];

    if (!worksheet) {
        throw new Error(
            `Worksheet "${CATEGORIESLOCALIZED_SHEET}" was not found. ` +
            `Available sheets: ${workbook.SheetNames.join(', ')}`
        );
    }

    const categoryStructureRows = categoryStructureWorksheet
        ? XLSX.utils.sheet_to_json(categoryStructureWorksheet, { defval: '', raw: false })
        : [];
    const hierarchyByCategoryId = buildHierarchyByCategoryId(categoryStructureRows);
    const categoryPermalinkRows = categoryPermalinksWorksheet
        ? XLSX.utils.sheet_to_json(categoryPermalinksWorksheet, { defval: '', raw: false })
        : [];
    const permalinkByCategoryId = buildPermalinkByCategoryId(categoryPermalinkRows);

    return XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false })
        .filter(row => cleanValue(row.culture) === SOURCE_CULTURE)
        .filter(row => cleanValue(row.categoryid) && cleanValue(row.name))
        .map(row => adaptCategory(row, hierarchyByCategoryId, permalinkByCategoryId));
}

module.exports = {
    CATEGORIESLOCALIZED_SHEET,
    CATEGORY_STRUCTURE_SHEET,
    CATEGORY_PERMALINKS_SHEET,
    SOURCE_CULTURE,
    adaptCategory,
    buildHierarchyByCategoryId,
    buildPermalinkByCategoryId,
    permalinkToHandle,
    readCategorieslocalized,
};
