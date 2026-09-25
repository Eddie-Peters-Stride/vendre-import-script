/**
 * Product transformer
 * Converts Vendre product data to normalized format
 */

const { getName, getSeoLink, getDescription, getShortDescription } = require('../utils/fields');
const { getProductHandle } = require('../utils/handles');
const { getStoreSku, getVendreExternalId } = require('../utils/sku');
const { stripHtml, getShortDesc } = require('../utils/html');

/**
 * Transform a Vendre product to normalized format
 * @param {Object} product - Raw Vendre product
 * @param {Object} config - Store configuration
 * @param {Object} tagsMap - Tag ID to name mapping
 * @returns {Object} Normalized product
 */
function transformProduct(product, config, tagsMap = {}) {
    const handle = getProductHandle(product);
    const name = getName(product);

    return {
        // Identity
        vendreId: product.id,
        handle,
        title: name,
        sku: getStoreSku(product, config),

        // Manufacturer & Product Info
        manufacturerName: product.manufacturer_name || '',
        manufacturerModel: product.manufacturer_model || '',
        ean: product.ean1 || '',
        externalId: getVendreExternalId(product),

        // Pricing
        price: product.price || 0,
        priceSpecial: product.price_special || null,
        taxClassId: product.tax_class_id,

        // Content
        description: getDescription(product),
        descriptionShort: getShortDesc(product, 'sv'),

        // Organization
        vendor: product.brand_name || '',
        productType: extractProductType(product),
        tags: extractTags(product, tagsMap),

        // Categories
        categoryPaths: product.category_paths || [],
        categoryIds: product.category_ids || [],

        // Inventory
        stock: product.stock || 0,
        stockStatus: product.stock_status,
        quantity: product.quantity || 0,

        // Specifications (for metafields)
        specifications: extractSpecifications(product, config),

        // Media
        images: extractImages(product),

        // SEO
        seoLink: getSeoLink(product),
        seoTitle: extractSeoTitle(product),
        seoDescription: extractSeoDescription(product),

        // Associations
        associatedProductIds: (product.associated_products || []).map(p => p.id),

        // Status
        isActive: product.is_active === true || product.is_active === 1 || product.status === true || product.status === 1,
        show: product.show === true || product.show === 1,

        // Raw data (for debugging)
        _raw: product,
    };
}

/**
 * Extract product type from Vendre data
 * @param {Object} product - Vendre product
 * @returns {string} Product type
 */
function extractProductType(product) {
    // Use first category as product type
    if (product.category_paths && product.category_paths.length > 0) {
        const parts = product.category_paths[0].split('|');
        return parts[0].trim();
    }
    return '';
}

/**
 * Extract tags from Vendre product
 * @param {Object} product - Vendre product
 * @param {Object} tagsMap - Tag ID to name mapping
 * @returns {Array<string>} Array of tag strings
 */
function extractTags(product, tagsMap = {}) {
    const tags = new Set();

    // Add tags from tag_ids
    if (product.tag_ids && Array.isArray(product.tag_ids)) {
        product.tag_ids.forEach(id => {
            const fullTag = tagsMap[String(id)];
            if (fullTag) {
                // Extract leaf tag name (last segment after »)
                const parts = fullTag.split(' » ');
                tags.add(parts[parts.length - 1].trim());
            }
        });
    }

    return Array.from(tags);
}

/**
 * Extract specifications from Vendre product
 * @param {Object} product - Vendre product
 * @param {Object} config - Store configuration
 * @returns {Object} Specifications object
 */
function extractSpecifications(product, config) {
    // Fyrklövern's Excel export provides already named dynamic fields rather
    // than Vendre's numeric specification IDs.
    if (product.specifications?.metafields) {
        return product.specifications.metafields;
    }

    if (!product.specifications || !product.specifications.text) {
        return {};
    }

    const specs = {};
    const specFields = config.specFields || {};

    for (const [key, fieldId] of Object.entries(specFields)) {
        const spec = product.specifications.text.find(s => s.id === fieldId);
        if (spec && spec.value) {
            specs[key] = spec.value.sv || spec.value.en || '';
        }
    }

    return specs;
}

/**
 * Extract images from Vendre product
 * @param {Object} product - Vendre product
 * @returns {Array<Object>} Array of image objects
 */
function extractImages(product) {
    if (!product.images || !Array.isArray(product.images)) {
        return [];
    }

    const imagesBySource = new Map();

    for (const [index, img] of product.images.entries()) {
        const src = String((img.url && img.url.full) || img.url || img.src || '').trim();
        if (!src) continue;

        // Matrixify keeps the later position when a source URL is repeated.
        // Mirror that behavior while retaining the source workbook's order.
        imagesBySource.set(src, {
            src,
            position: index + 1,
            altText: img.alt_text || img.description || '',
        });
    }

    return [...imagesBySource.values()].sort((a, b) => a.position - b.position);
}

/**
 * Extract SEO title from Vendre product
 * @param {Object} product - Vendre product
 * @returns {string} SEO title
 */
function extractSeoTitle(product) {
    const seoTitle = product.seo_title || product.meta_title;
    if (seoTitle) {
        return seoTitle.sv || seoTitle.en || '';
    }
    return getName(product);
}

/**
 * Extract SEO description from Vendre product
 * @param {Object} product - Vendre product
 * @returns {string} SEO description
 */
function extractSeoDescription(product) {
    const seoDescription = product.seo_description || product.meta_description;
    if (seoDescription) {
        return seoDescription.sv || seoDescription.en || '';
    }
    // Fallback to short description
    const shortDesc = getShortDesc(product, 'sv');
    return shortDesc.substring(0, 160); // Limit to 160 chars for SEO
}

/**
 * Calculate pricing with tax
 * @param {Object} product - Normalized product
 * @param {Object} config - Store configuration
 * @returns {Object} { price, compareAtPrice }
 */
function calculatePricing(product, config) {
    const taxRate = config.taxClasses[String(product.taxClassId)];
    if (taxRate == null) {
        console.warn(`Unknown tax class ${product.taxClassId} for product ${product.vendreId}`);
        return { price: product.price, compareAtPrice: null };
    }

    const priceWithTax = +(product.price * (1 + taxRate / 100)).toFixed(2);

    // Handle sale prices
    if (product.priceSpecial && product.priceSpecial > 0) {
        const specialWithTax = +(product.priceSpecial * (1 + taxRate / 100)).toFixed(2);
        return {
            price: specialWithTax,
            compareAtPrice: priceWithTax,
        };
    }

    return {
        price: priceWithTax,
        compareAtPrice: null,
    };
}

module.exports = {
    transformProduct,
    extractTags,
    extractSpecifications,
    calculatePricing,
};
