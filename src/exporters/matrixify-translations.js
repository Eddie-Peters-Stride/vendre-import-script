/**
 * Matrixify Translations Exporter
 * Builds Matrixify "Translations" sheet rows for Products and Collections.
 */

const { TRANSLATION_COLUMNS, getTranslationValueColumn } = require('../config/matrixify');
const { sanitizeForShopify, stripHtml, getShortDesc } = require('../utils/html');
const { getHandleFromSeoLink } = require('../utils/handles');

/**
 * Export product translations to Matrixify format.
 * @param {Array} products - Normalized products
 * @param {Object} shopifyMappings - Maps for SKU to handle and handle to ID
 * @param {Object} options - Export options
 * @returns {Array} Translation rows
 */
function exportProductTranslations(products, shopifyMappings = {}, options = {}) {
    const sourceLocale = options.sourceLocale || 'sv';
    const targetLocales = normalizeTargetLocales(options.targetLocales || options.targetLocale || 'en');
    const localeFallbacks = options.localeFallbacks || {};
    const specFields = options.specFields || {};
    const skuToHandle = shopifyMappings.skuToHandle || {};
    const handleToId = shopifyMappings.handleToId || {};

    const baseHandles = new Map();
    for (const product of products) {
        const sku = normalizeText(product.sku);
        const entityHandle = (sku && skuToHandle[sku]) || product.handle;
        if (entityHandle) {
            baseHandles.set(product.vendreId, entityHandle);
        }
    }

    const translatedHandlesByLocale = buildLocalizedHandleMaps(
        products,
        targetLocales,
        (product, locale) => getLocalizedProductHandle(product._raw, locale, localeFallbacks)
    );

    const rows = [];
    let skipped = 0;

    for (const product of products) {
        const entityHandle = baseHandles.get(product.vendreId) || product.handle;
        if (!entityHandle) {
            skipped++;
            continue;
        }

        const entityId = handleToId[entityHandle] || '';
        const raw = product._raw || {};

        addTranslationRow(rows, {
            entity: 'Product',
            entityId,
            entityHandle,
            field: 'Title',
            originalValue: getLocalizedValue(raw.name, sourceLocale, localeFallbacks) || product.title,
            targetLocales,
            translationValues: buildTranslationValues(targetLocales, locale =>
                getLocalizedValue(raw.name, locale, localeFallbacks)
            ),
        });

        addTranslationRow(rows, {
            entity: 'Product',
            entityId,
            entityHandle,
            field: 'Handle',
            originalValue: entityHandle,
            targetLocales,
            translationValues: buildTranslationValues(targetLocales, locale => {
                const localizedHandles = translatedHandlesByLocale[locale];
                return localizedHandles ? localizedHandles.get(product.vendreId) || '' : '';
            }),
        });

        addTranslationRow(rows, {
            entity: 'Product',
            entityId,
            entityHandle,
            field: 'Body HTML',
            originalValue: normalizeHtml(getLocalizedValue(raw.description, sourceLocale, localeFallbacks)),
            targetLocales,
            translationValues: buildTranslationValues(targetLocales, locale =>
                normalizeHtml(getLocalizedValue(raw.description, locale, localeFallbacks))
            ),
        });

        addTranslationRow(rows, {
            entity: 'Product',
            entityId,
            entityHandle,
            field: 'SEO Title',
            originalValue: getLocalizedSeoTitle(raw, sourceLocale, localeFallbacks) || product.title || '',
            targetLocales,
            translationValues: buildTranslationValues(targetLocales, locale =>
                getLocalizedSeoTitle(raw, locale, localeFallbacks) ||
                getLocalizedValue(raw.name, locale, localeFallbacks)
            ),
        });

        addTranslationRow(rows, {
            entity: 'Product',
            entityId,
            entityHandle,
            field: 'SEO Description',
            originalValue: getLocalizedSeoDescription(raw, sourceLocale, localeFallbacks) ||
                buildSeoDescriptionFallback(raw, sourceLocale, localeFallbacks),
            targetLocales,
            translationValues: buildTranslationValues(targetLocales, locale =>
                getLocalizedSeoDescription(raw, locale, localeFallbacks) ||
                buildSeoDescriptionFallback(raw, locale, localeFallbacks)
            ),
        });

        addTranslationRow(rows, {
            entity: 'Product',
            entityId,
            entityHandle,
            field: 'Metafield: custom.description_short',
            originalValue: getShortDescWithFallback(raw, sourceLocale, localeFallbacks),
            targetLocales,
            translationValues: buildTranslationValues(targetLocales, locale =>
                getShortDescWithFallback(raw, locale, localeFallbacks)
            ),
        });

        for (const specTranslation of buildSpecificationTranslationRows(raw, specFields, sourceLocale, targetLocales, localeFallbacks)) {
            addTranslationRow(rows, {
                entity: 'Product',
                entityId,
                entityHandle,
                field: specTranslation.field,
                originalValue: specTranslation.originalValue,
                targetLocales,
                translationValues: specTranslation.translationValues,
            });
        }
    }

    console.log(
        `Exported ${rows.length} product translation rows across ${targetLocales.join(', ') || '(none)'}; ` +
        `skipped ${skipped} products with no handle`
    );
    return rows;
}

/**
 * Export collection translations to Matrixify format.
 * @param {Array} collections - Normalized collections
 * @param {Object} shopifyMappings - Maps for collection handle to Shopify ID
 * @param {Object} options - Export options
 * @returns {Array} Translation rows
 */
function exportCollectionTranslations(collections, shopifyMappings = {}, options = {}) {
    const sourceLocale = options.sourceLocale || 'sv';
    const targetLocales = normalizeTargetLocales(options.targetLocales || options.targetLocale || 'en');
    const localeFallbacks = options.localeFallbacks || {};
    const handleToId = shopifyMappings.handleToId || {};
    const includeVendreData = options.includeVendreData === true;
    const onlyActive = options.onlyActive !== false;

    const sourceCollections = onlyActive
        ? collections.filter(collection => collection.isActive)
        : collections;

    const baseHandles = new Map();
    for (const collection of sourceCollections) {
        const entityHandle = getCollectionEntityHandle(collection, includeVendreData);
        if (entityHandle) {
            baseHandles.set(collection.vendreId, entityHandle);
        }
    }

    const translatedHandlesByLocale = buildLocalizedHandleMaps(
        sourceCollections,
        targetLocales,
        (collection, locale) => getLocalizedCollectionHandle(collection._raw, locale, includeVendreData, localeFallbacks)
    );

    const rows = [];
    let skipped = 0;

    for (const collection of sourceCollections) {
        const entityHandle = baseHandles.get(collection.vendreId) || getCollectionEntityHandle(collection, includeVendreData);
        if (!entityHandle) {
            skipped++;
            continue;
        }

        const entityId = handleToId[entityHandle] || '';
        const raw = collection._raw || {};

        addTranslationRow(rows, {
            entity: 'Collection',
            entityId,
            entityHandle,
            field: 'Title',
            originalValue: includeVendreData
                ? (getLocalizedValue(raw.name, sourceLocale, localeFallbacks) || collection.title)
                : collection.title,
            targetLocales,
            translationValues: buildTranslationValues(targetLocales, locale =>
                getLocalizedValue(raw.name, locale, localeFallbacks)
            ),
        });

        addTranslationRow(rows, {
            entity: 'Collection',
            entityId,
            entityHandle,
            field: 'Handle',
            originalValue: entityHandle,
            targetLocales,
            translationValues: buildTranslationValues(targetLocales, locale => {
                const localizedHandles = translatedHandlesByLocale[locale];
                return localizedHandles ? localizedHandles.get(collection.vendreId) || '' : '';
            }),
        });

        addTranslationRow(rows, {
            entity: 'Collection',
            entityId,
            entityHandle,
            field: 'Body HTML',
            originalValue: normalizeHtml(getLocalizedValue(raw.description, sourceLocale, localeFallbacks)),
            targetLocales,
            translationValues: buildTranslationValues(targetLocales, locale =>
                normalizeHtml(getLocalizedValue(raw.description, locale, localeFallbacks))
            ),
        });

        addTranslationRow(rows, {
            entity: 'Collection',
            entityId,
            entityHandle,
            field: 'SEO Title',
            originalValue: getLocalizedSeoTitle(raw, sourceLocale, localeFallbacks) || collection.title || '',
            targetLocales,
            translationValues: buildTranslationValues(targetLocales, locale =>
                getLocalizedSeoTitle(raw, locale, localeFallbacks) ||
                getLocalizedValue(raw.name, locale, localeFallbacks)
            ),
        });

        addTranslationRow(rows, {
            entity: 'Collection',
            entityId,
            entityHandle,
            field: 'SEO Description',
            originalValue: getLocalizedSeoDescription(raw, sourceLocale, localeFallbacks) ||
                buildSeoDescriptionFallback(raw, sourceLocale, localeFallbacks),
            targetLocales,
            translationValues: buildTranslationValues(targetLocales, locale =>
                getLocalizedSeoDescription(raw, locale, localeFallbacks) ||
                buildSeoDescriptionFallback(raw, locale, localeFallbacks)
            ),
        });
    }

    console.log(
        `Exported ${rows.length} collection translation rows across ${targetLocales.join(', ') || '(none)'}; ` +
        `skipped ${skipped} collections with no handle`
    );
    return rows;
}

/**
 * Build SKU to handle map from Shopify product export CSV rows.
 * @param {Array} shopifyExportRows - Product export rows
 * @returns {Object} SKU to handle map
 */
function buildSkuToHandleMap(shopifyExportRows) {
    const skuToHandle = {};

    for (const row of shopifyExportRows) {
        const handle = normalizeText(row['Handle']);
        const sku = normalizeText(row['Variant SKU']).replace(/^'/, '');

        if (handle && sku && !skuToHandle[sku]) {
            skuToHandle[sku] = handle;
        }
    }

    return skuToHandle;
}

/**
 * Build per-entity handle to Shopify ID maps from translation export rows.
 * Supports both old Translate & Adapt CSV exports and Matrixify Translations exports.
 * @param {Array} translationExportRows - Translation export rows
 * @returns {{Product: Object, Collection: Object}} Entity-specific handle maps
 */
function buildEntityHandleToIdMaps(translationExportRows) {
    const handleToId = {
        Product: {},
        Collection: {},
    };

    for (const row of translationExportRows) {
        const entity = normalizeEntityValue(row['Entity'] || row['Type']);
        if (!entity || !handleToId[entity]) continue;

        const field = normalizeText(row['Field']);
        if (!/^handle$/i.test(field)) continue;

        const entityId = normalizeText(row['Entity ID'] || row['Identification']).replace(/^'/, '');
        const entityHandle = normalizeText(
            row['Entity Handle'] ||
            row['Original Value'] ||
            row['Default content']
        );

        if (entityId && entityHandle && !handleToId[entity][entityHandle]) {
            handleToId[entity][entityHandle] = entityId;
        }
    }

    return handleToId;
}

/**
 * Backwards-compatible product-only handle to ID map.
 * @param {Array} translationExportRows - Translation export rows
 * @returns {Object} Product handle to ID map
 */
function buildHandleToIdMap(translationExportRows) {
    return buildEntityHandleToIdMaps(translationExportRows).Product;
}

/**
 * Parse Shopify/Matrixify CSV content while preserving quoted multiline fields.
 * @param {string} csvContent - Raw CSV text
 * @returns {Array} Parsed row objects
 */
function parseShopifyCsv(csvContent) {
    const raw = csvContent.replace(/^\uFEFF/, '');
    const lines = [];
    let currentLine = '';
    let inQuotes = false;

    for (let i = 0; i < raw.length; i++) {
        const char = raw[i];
        if (char === '"') {
            inQuotes = !inQuotes;
            currentLine += char;
        } else if (char === '\n' && !inQuotes) {
            lines.push(currentLine);
            currentLine = '';
        } else {
            currentLine += char;
        }
    }

    if (currentLine) {
        lines.push(currentLine);
    }

    if (lines.length === 0) {
        return [];
    }

    const splitLine = (line) => {
        const fields = [];
        let field = '';
        let quoted = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                if (quoted && line[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    quoted = !quoted;
                }
            } else if (char === ',' && !quoted) {
                fields.push(field);
                field = '';
            } else {
                field += char;
            }
        }

        fields.push(field);
        return fields;
    };

    const headers = splitLine(lines[0]);

    return lines
        .slice(1)
        .filter(line => line.trim())
        .map(line => {
            const values = splitLine(line);
            const row = {};

            headers.forEach((header, index) => {
                row[header] = normalizeText(values[index] || '');
            });

            return row;
        });
}

/**
 * Add a single Matrixify translation row if it has at least one translated value.
 * @param {Array} rows - Output rows
 * @param {Object} params - Translation row params
 */
function addTranslationRow(rows, params) {
    const C = TRANSLATION_COLUMNS;
    const row = {
        [C.ENTITY]: params.entity,
        [C.ENTITY_ID]: params.entityId ? String(params.entityId) : '',
        [C.ENTITY_HANDLE]: params.entityHandle,
        [C.FIELD]: params.field,
        [C.ORIGINAL_VALUE]: params.originalValue != null ? String(params.originalValue) : '',
    };

    let hasTranslation = false;

    for (const locale of params.targetLocales || []) {
        const value = normalizeText(params.translationValues?.[locale]);
        if (value) {
            hasTranslation = true;
        }

        row[getTranslationValueColumn(locale)] = value;
    }

    if (!params.entityHandle || !params.field || !hasTranslation) {
        return;
    }

    rows.push(row);
}

/**
 * Normalize target locale input to a de-duplicated array.
 * @param {string|string[]} locales - Locale or locale array
 * @returns {string[]} Normalized locale array
 */
function normalizeTargetLocales(locales) {
    const list = Array.isArray(locales) ? locales : [locales];
    const seen = new Set();
    const normalized = [];

    for (const locale of list) {
        const value = normalizeText(locale);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        normalized.push(value);
    }

    return normalized;
}

/**
 * Build a locale-value object from a getter function.
 * @param {string[]} targetLocales - Locales to populate
 * @param {Function} getter - Getter function receiving locale
 * @returns {Object} Locale-value map
 */
function buildTranslationValues(targetLocales, getter) {
    const values = {};

    for (const locale of targetLocales) {
        values[locale] = normalizeText(getter(locale));
    }

    return values;
}

/**
 * Build resolved localized handle maps for each target locale.
 * @param {Array} entities - Normalized entities
 * @param {string[]} targetLocales - Target locales
 * @param {Function} getCandidateHandle - Receives entity and locale
 * @returns {Object<string, Map<number, string>>} Locale to resolved handle map
 */
function buildLocalizedHandleMaps(entities, targetLocales, getCandidateHandle) {
    const maps = {};

    for (const locale of targetLocales) {
        maps[locale] = resolveLocalizedHandleCollisions(
            entities,
            entity => getCandidateHandle(entity, locale)
        );
    }

    return maps;
}

/**
 * Build Matrixify translation payloads for configured specification metafields.
 * @param {Object} rawProduct - Raw Vendre product
 * @param {Object} specFields - Configured spec field map
 * @param {string} sourceLocale - Source locale code
 * @param {string[]} targetLocales - Target locales
 * @param {Object<string, string[]>} localeFallbacks - Locale fallback map
 * @returns {Array<{field: string, originalValue: string, translationValues: Object}>} Spec translation payloads
 */
function buildSpecificationTranslationRows(rawProduct, specFields, sourceLocale, targetLocales, localeFallbacks = {}) {
    if (!rawProduct?.specifications?.text || !specFields || Object.keys(specFields).length === 0) {
        return [];
    }

    const rows = [];

    for (const [specKey, fieldId] of Object.entries(specFields)) {
        const field = `Metafield: custom.${String(specKey).toLowerCase()}`;
        const originalValue = getLocalizedSpecificationValue(rawProduct, fieldId, sourceLocale, localeFallbacks);
        const translationValues = buildTranslationValues(targetLocales, locale =>
            getLocalizedSpecificationValue(rawProduct, fieldId, locale, localeFallbacks)
        );

        rows.push({
            field,
            originalValue,
            translationValues,
        });
    }

    return rows;
}

/**
 * Normalize plain-text cell values.
 * @param {any} value - Raw value
 * @returns {string} Normalized string
 */
function normalizeText(value) {
    if (value == null) return '';
    return String(value).trim();
}

/**
 * Normalize HTML translation values.
 * @param {string} value - Raw HTML
 * @returns {string} Sanitized HTML
 */
function normalizeHtml(value) {
    return normalizeText(sanitizeForShopify(value || ''));
}

/**
 * Get a localized value from a multilingual Vendre field with optional locale fallback.
 * @param {Object} fieldValue - Multilingual field object
 * @param {string} locale - Locale code
 * @param {Object<string, string[]>} fallbackLocales - Locale fallback map
 * @returns {string} Localized string
 */
function getLocalizedValue(fieldValue, locale, fallbackLocales = {}) {
    if (!fieldValue || typeof fieldValue !== 'object') return '';

    const primaryValue = normalizeText(fieldValue[locale]);
    if (primaryValue) {
        return primaryValue;
    }

    const fallbacks = fallbackLocales[locale] || [];
    for (const fallbackLocale of fallbacks) {
        const fallbackValue = normalizeText(fieldValue[fallbackLocale]);
        if (fallbackValue) {
            return fallbackValue;
        }
    }

    return '';
}

/**
 * Get SEO title from either seo_title or meta_title.
 * @param {Object} entity - Raw Vendre entity
 * @param {string} locale - Locale code
 * @param {Object<string, string[]>} fallbackLocales - Locale fallback map
 * @returns {string} SEO title
 */
function getLocalizedSeoTitle(entity, locale, fallbackLocales = {}) {
    return getLocalizedValue(entity.seo_title, locale, fallbackLocales) ||
        getLocalizedValue(entity.meta_title, locale, fallbackLocales);
}

/**
 * Get SEO description from either seo_description or meta_description.
 * @param {Object} entity - Raw Vendre entity
 * @param {string} locale - Locale code
 * @param {Object<string, string[]>} fallbackLocales - Locale fallback map
 * @returns {string} SEO description
 */
function getLocalizedSeoDescription(entity, locale, fallbackLocales = {}) {
    return getLocalizedValue(entity.seo_description, locale, fallbackLocales) ||
        getLocalizedValue(entity.meta_description, locale, fallbackLocales);
}

/**
 * Build SEO description fallback from description HTML.
 * @param {Object} entity - Raw Vendre entity
 * @param {string} locale - Locale code
 * @param {Object<string, string[]>} fallbackLocales - Locale fallback map
 * @returns {string} Plain-text fallback
 */
function buildSeoDescriptionFallback(entity, locale, fallbackLocales = {}) {
    const description = getLocalizedValue(entity.description, locale, fallbackLocales);
    if (!description) return '';
    return stripHtml(description).substring(0, 160);
}

/**
 * Get short description with fallback to alternate locale values.
 * @param {Object} rawProduct - Raw Vendre product
 * @param {string} locale - Locale code
 * @param {Object<string, string[]>} fallbackLocales - Locale fallback map
 * @returns {string} Short description
 */
function getShortDescWithFallback(rawProduct, locale, fallbackLocales = {}) {
    const shortValue = getLocalizedValue(rawProduct.description_short, locale, fallbackLocales);
    if (shortValue) {
        return stripHtml(shortValue);
    }

    const descriptionValue = getLocalizedValue(rawProduct.description, locale, fallbackLocales);
    if (!descriptionValue) {
        return '';
    }

    return getShortDesc(
        {
            description_short: { [locale]: shortValue },
            description: { [locale]: descriptionValue },
        },
        locale
    );
}

/**
 * Get the translated product handle from localized seo_link.
 * @param {Object} rawProduct - Raw Vendre product
 * @param {string} locale - Locale code
 * @param {Object<string, string[]>} fallbackLocales - Locale fallback map
 * @returns {string} Localized handle
 */
function getLocalizedProductHandle(rawProduct, locale, fallbackLocales = {}) {
    return getHandleFromSeoLink(getLocalizedValue(rawProduct.seo_link, locale, fallbackLocales));
}

/**
 * Get the current collection handle used in Shopify imports.
 * @param {Object} collection - Normalized collection
 * @param {boolean} includeVendreData - Whether to use raw Vendre path handles
 * @returns {string} Collection handle
 */
function getCollectionEntityHandle(collection, includeVendreData) {
    return includeVendreData ? collection.vendreRawHandle : collection.handle;
}

/**
 * Build a localized collection handle using the same mode as the base import.
 * @param {Object} rawCollection - Raw Vendre collection
 * @param {string} locale - Locale code
 * @param {boolean} includeVendreData - Whether the store uses raw Vendre path handles
 * @param {Object<string, string[]>} fallbackLocales - Locale fallback map
 * @returns {string} Localized handle
 */
function getLocalizedCollectionHandle(rawCollection, locale, includeVendreData, fallbackLocales = {}) {
    const seoLink = getLocalizedValue(rawCollection.seo_link, locale, fallbackLocales);
    if (!seoLink) return '';

    if (!includeVendreData) {
        return getHandleFromSeoLink(seoLink);
    }

    const segments = seoLink.split('/').filter(Boolean);
    if (segments.length === 0) return '';

    const firstSegment = segments[0].toLowerCase();
    const pathSegments = /^[a-z]{2}(?:-[a-z]{2})?$/.test(firstSegment)
        ? segments.slice(1)
        : segments;

    return pathSegments.join('-');
}

/**
 * Get a localized specification value for a configured spec field id.
 * Falls back from `value` to `short_value` when needed.
 * @param {Object} rawProduct - Raw Vendre product
 * @param {number|string} fieldId - Configured Vendre spec field id
 * @param {string} locale - Locale code
 * @param {Object<string, string[]>} fallbackLocales - Locale fallback map
 * @returns {string} Localized specification value
 */
function getLocalizedSpecificationValue(rawProduct, fieldId, locale, fallbackLocales = {}) {
    const textSpecs = rawProduct?.specifications?.text;
    if (!Array.isArray(textSpecs)) {
        return '';
    }

    const numericFieldId = Number(fieldId);
    const spec = textSpecs.find(item => Number(item?.id) === numericFieldId);
    if (!spec) {
        return '';
    }

    return getLocalizedValue(spec.value, locale, fallbackLocales) ||
        getLocalizedValue(spec.short_value, locale, fallbackLocales);
}

/**
 * Resolve duplicate localized handles by appending the entity ID.
 * @param {Array} entities - Normalized entities
 * @param {Function} getCandidateHandle - Function returning localized handle
 * @returns {Map<number, string>} Map of entity ID to resolved handle
 */
function resolveLocalizedHandleCollisions(entities, getCandidateHandle) {
    const candidateCounts = {};
    const candidateById = new Map();

    for (const entity of entities) {
        const entityId = entity.vendreId || entity.id;
        const candidate = normalizeText(getCandidateHandle(entity));
        if (!entityId || !candidate) continue;

        candidateById.set(entityId, candidate);
        candidateCounts[candidate] = (candidateCounts[candidate] || 0) + 1;
    }

    const duplicates = new Set(
        Object.keys(candidateCounts).filter(handle => candidateCounts[handle] > 1)
    );

    const resolved = new Map();
    for (const entity of entities) {
        const entityId = entity.vendreId || entity.id;
        if (!entityId) continue;

        const candidate = candidateById.get(entityId);
        if (!candidate) {
            resolved.set(entityId, '');
            continue;
        }

        resolved.set(
            entityId,
            duplicates.has(candidate) ? `${candidate}-${entityId}` : candidate
        );
    }

    return resolved;
}

/**
 * Normalize entity names from export files.
 * @param {string} value - Raw entity value
 * @returns {string} Normalized entity name
 */
function normalizeEntityValue(value) {
    const normalized = normalizeText(value).toLowerCase();
    if (normalized === 'product') return 'Product';
    if (normalized === 'collection') return 'Collection';
    return '';
}

module.exports = {
    exportProductTranslations,
    exportCollectionTranslations,
    buildSkuToHandleMap,
    buildHandleToIdMap,
    buildEntityHandleToIdMaps,
    parseShopifyCsv,
};
