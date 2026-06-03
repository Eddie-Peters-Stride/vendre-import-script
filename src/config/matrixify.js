/**
 * Matrixify column schemas
 * Defines the expected column structure for different Matrixify export types
 */

/**
 * Product export columns (full product import)
 */
const PRODUCT_COLUMNS = {
    HANDLE: 'Handle',
    TITLE: 'Title',
    BODY_HTML: 'Body HTML',
    VENDOR: 'Vendor',
    TYPE: 'Type',
    TAGS: 'Tags',
    PUBLISHED: 'Published',
    VARIANT_SKU: 'Variant SKU',
    VARIANT_PRICE: 'Variant Price',
    VARIANT_COMPARE_AT_PRICE: 'Variant Compare At Price',
    VARIANT_INVENTORY_QTY: 'Variant Inventory Qty',
    VARIANT_INVENTORY_POLICY: 'Variant Inventory Policy',
    VARIANT_FULFILLMENT_SERVICE: 'Variant Fulfillment Service',
    VARIANT_REQUIRES_SHIPPING: 'Variant Requires Shipping',
    VARIANT_TAXABLE: 'Variant Taxable',
    VARIANT_WEIGHT: 'Variant Weight',
    VARIANT_WEIGHT_UNIT: 'Variant Weight Unit',
    IMAGE_SRC: 'Image Src',
    IMAGE_POSITION: 'Image Position',
    IMAGE_ALT_TEXT: 'Image Alt Text',
    SEO_TITLE: 'SEO Title',
    SEO_DESCRIPTION: 'SEO Description',
};

/**
 * Price update columns (update prices only)
 */
const PRICE_UPDATE_COLUMNS = {
    HANDLE: 'Handle',
    VARIANT_PRICE: 'Variant Price',
    VARIANT_COMPARE_AT_PRICE: 'Variant Compare At Price',
};

/**
 * Vendor update columns (update vendor only)
 */
const VENDOR_UPDATE_COLUMNS = {
    HANDLE: 'Handle',
    VENDOR: 'Vendor',
};

/**
 * Collection export columns
 */
const COLLECTION_COLUMNS = {
    HANDLE: 'Handle',
    TITLE: 'Title',
    BODY_HTML: 'Body HTML',
    PUBLISHED: 'Published',
    PUBLISHED_SCOPE: 'Published Scope',
    SORT_ORDER: 'Sort Order',
    TEMPLATE_SUFFIX: 'Template Suffix',
    DISJUNCTIVE: 'Disjunctive',
    RULES: 'Rules',
    PUBLISHED_AT: 'Published At',
    IMAGE_SRC: 'Image Src',
    IMAGE_ALT_TEXT: 'Image Alt Text',
    SEO_TITLE: 'SEO Title',
    SEO_DESCRIPTION: 'SEO Description',
};

/**
 * Product collections assignment columns
 */
const PRODUCT_COLLECTION_COLUMNS = {
    HANDLE: 'Handle',
    COLLECTION: 'Collection',
};

/**
 * Collection metafields update columns
 */
const COLLECTION_METAFIELD_COLUMNS = {
    HANDLE: 'Handle',
    METAFIELD_NAMESPACE: 'Metafield: custom.parent_collection [single_line_text_field]',
};

/**
 * Customer export columns
 */
const CUSTOMER_COLUMNS = {
    EMAIL: 'Email',
    FIRST_NAME: 'First Name',
    LAST_NAME: 'Last Name',
    PHONE: 'Phone',
    COMPANY: 'Company',
    ADDRESS1: 'Address1',
    ADDRESS2: 'Address2',
    CITY: 'City',
    PROVINCE: 'Province',
    PROVINCE_CODE: 'Province Code',
    COUNTRY: 'Country',
    COUNTRY_CODE: 'Country Code',
    ZIP: 'Zip',
    TAGS: 'Tags',
    NOTE: 'Note',
    TAX_EXEMPT: 'Tax Exempt',
    ACCEPTS_MARKETING: 'Accepts Marketing',
};

/**
 * Translation export columns (for Shopify Translate & Adapt)
 */
const TRANSLATION_COLUMNS = {
    TYPE: 'Type',
    IDENTIFICATION: 'Identification',
    FIELD: 'Field',
    LOCALE: 'Locale',
    MARKET: 'Market',
    STATUS: 'Status',
    DEFAULT_CONTENT: 'Default content',
    TRANSLATED_CONTENT: 'Translated content',
};

/**
 * Get column headers for a specific export type
 * @param {string} type - Export type ('products', 'price-update', 'collections', etc.)
 * @returns {Object} Column mapping object
 */
function getColumns(type) {
    const columnMaps = {
        'products': PRODUCT_COLUMNS,
        'price-update': PRICE_UPDATE_COLUMNS,
        'vendor-update': VENDOR_UPDATE_COLUMNS,
        'collections': COLLECTION_COLUMNS,
        'product-collections': PRODUCT_COLLECTION_COLUMNS,
        'collection-metafields': COLLECTION_METAFIELD_COLUMNS,
        'customers': CUSTOMER_COLUMNS,
        'translations': TRANSLATION_COLUMNS,
    };

    const columns = columnMaps[type];
    if (!columns) {
        throw new Error(`Unknown export type: ${type}`);
    }

    return columns;
}

/**
 * Create an empty row template with all columns for a given type
 * @param {string} type - Export type
 * @returns {Object} Empty row object with all columns
 */
function createEmptyRow(type) {
    const columns = getColumns(type);
    const row = {};

    for (const key of Object.values(columns)) {
        row[key] = '';
    }

    return row;
}

module.exports = {
    PRODUCT_COLUMNS,
    PRICE_UPDATE_COLUMNS,
    VENDOR_UPDATE_COLUMNS,
    COLLECTION_COLUMNS,
    PRODUCT_COLLECTION_COLUMNS,
    COLLECTION_METAFIELD_COLUMNS,
    CUSTOMER_COLUMNS,
    TRANSLATION_COLUMNS,
    getColumns,
    createEmptyRow,
};
