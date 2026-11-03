#!/usr/bin/env node
/** Offline, fail-closed Matrixify updates derived from the Norce Excel caches. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { loadCache, GROUPS } = require('./norce-extraction/cache');
const { REQUIRED_GROUPS, requiredComplete } = require('./norce-extraction/extract');
const { CHANNELS } = require('./norce-extraction/channels');
const { productInventoryCsv } = require('./norce-extraction/inventory');
const { imageFilename, semanticComponentKeys } = require('./build-collection-content-import');
const { verifiedDefinitions, cachedComponents, buildCollectionCmsMetafieldUpdates } = require('./norce-extraction/collection-cms-metafields');
const { buildVerifiedCollectionFileReferences } = require('./norce-extraction/verified-file-references');
const TRANSFORM = require('./norce-transform-config.json');

const ROOT = path.resolve(__dirname, '../../..');
const DEFAULTS = {
    productsCache: path.join(ROOT, 'cache/norce-products-cache.xlsx'),
    collectionsCache: path.join(ROOT, 'cache/norce-collections-cache.xlsx'),
    productsExport: path.join(ROOT, 'exports/Shopify_Products_2026-10-21.csv'),
    previousProductsExport: path.join(ROOT, 'exports/Export_2026-09-29_101146 (1).xlsx'),
    collectionsExport: path.join(ROOT, 'exports/Export_2026-10-22_142102.xlsx'),
    collectionApprovals: path.join(ROOT, 'outputs/Fyrklovern/Matrixify files/Collections/Content updates/Collection content - approved URL mappings.json'),
    productPermalinks: 'C:/Users/Eddie Peters/Desktop/Fyrklövern/fyrklovern_productpermalinks.xlsx',
    categoryPermalinks: 'C:/Users/Eddie Peters/Desktop/Fyrklövern/fyrklovern_custom_export.xlsx',
    outDir: path.join(ROOT, 'norcemigration'),
};
const ARTICLE_FIELD = 'Metafield: custom.external_id [single_line_text_field]';
const clean = value => String(value == null ? '' : value).trim();
const isTop = row => row['Top Row'] === true || clean(row['Top Row']).toLowerCase() === 'true';
const validId = value => /^\d+$/.test(clean(value));
const key = (...parts) => parts.map(clean).join('\u0000');
// These Norce product attributes are localized text values. External ID is a
// product identifier and is intentionally excluded from translations.
const TRANSLATABLE_PRODUCT_ATTRIBUTE_KEYS = new Set([
    'articletype', 'brand', 'category', 'collection', 'colour', 'design',
    'family', 'itemcategorycode', 'material', 'volume',
]);

function readSheet(file, sheet, required = true) {
    if (!fs.existsSync(file)) {
        if (!required) return [];
        throw new Error(`Required workbook is missing: ${file}`);
    }
    const workbook = XLSX.readFile(file);
    const name = path.extname(file).toLowerCase() === '.csv' ? workbook.SheetNames[0] : workbook.SheetNames.find(item => item.toLowerCase() === sheet.toLowerCase());
    if (!name) {
        if (!required) return [];
        throw new Error(`${file} has no ${sheet} sheet.`);
    }
    return XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: '' });
}
function readPermalinkSheet(file, sheet) {
    if (!file || !fs.existsSync(file)) return [];
    const workbook = XLSX.readFile(file);
    const name = workbook.SheetNames.find(item => item.toLowerCase() === sheet.toLowerCase());
    if (!name) throw new Error(`${file} has no ${sheet} sheet.`);
    return XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: '' });
}

function productIdentity(records) {
    const byArticle = new Map();
    const byId = new Map();
    const byHandle = new Map();
    const issues = [];
    for (const record of records) {
        const article = clean(record.articleNumber);
        const handle = clean(record.shopifyHandle);
        const id = clean(record.shopifyProductId);
        if (!article || !handle) { issues.push({ Type: 'missing_product_identity', Article: article, Handle: handle }); continue; }
        if (id && !validId(id)) { issues.push({ Type: 'invalid_product_id', ID: id, Handle: handle }); continue; }
        const existing = byHandle.get(handle);
        const existingId = clean(existing?.shopifyProductId);
        if (existingId && id && existingId !== id) {
            issues.push({ Type: 'conflicting_product_handle_ids', Handle: handle, IDs: [existingId, id].join(', ') });
            continue;
        }
        if (!existing) byHandle.set(handle, { ...record });
        else if (!existingId && id) byHandle.get(handle).shopifyProductId = id;
        if (id) {
            if (byId.has(id) && byId.get(id).shopifyHandle !== handle) issues.push({ Type: 'duplicate_product_id', ID: id, Handles: [byId.get(id).shopifyHandle, handle].join(', ') });
            byId.set(id, record);
        }
        if (!byArticle.has(article)) byArticle.set(article, new Set());
        byArticle.get(article).add(handle);
    }
    for (const [article, handles] of byArticle) if (handles.size > 1) issues.push({ Type: 'ambiguous_article', Article: article, Handles: [...handles].join(', ') });
    return { byArticle, byHandle, byId, issues };
}

function collectionIdentity(rows, approvals) {
    const byId = new Map(rows.filter(isTop).filter(row => validId(row.ID)).map(row => [clean(row.ID), row]));
    const byCategory = new Map();
    const byCategorySwedish = new Map();
    const reverse = new Map();
    const issues = [];
    const metafieldColumns = Object.keys(rows[0] || {}).filter(name => /^Metafield: custom\.[^ ]+ \[[^\]]+\]$/.test(name));
    if (!metafieldColumns.length) issues.push({ Type: 'missing_collection_metafield_columns' });
    const definitions = new Map();
    for (const column of metafieldColumns) {
        const match = /^Metafield: custom\.([^ ]+) \[([^\]]+)\]$/.exec(column);
        const previous = definitions.get(match[1]);
        if (previous && previous !== match[2]) issues.push({ Type: 'conflicting_collection_metafield_type', Key: match[1], Types: `${previous}, ${match[2]}` });
        definitions.set(match[1], match[2]);
    }
    for (const row of approvals) {
        if (!/^(approved|yes|true)$/i.test(clean(row.ManualApproval ?? row.approved))) continue;
        const category = clean(row.CategoryID ?? row.categoryId);
        const id = clean(row.ShopifyID ?? row.shopifyId);
        if (!category || !validId(id) || !byId.has(id)) {
            issues.push({ Type: 'invalid_collection_approval', Category: category, ID: id });
            continue;
        }
        if (!byCategory.has(category)) byCategory.set(category, new Set());
        byCategory.get(category).add(id);
        if (clean(row.Culture ?? row.culture) === 'sv-SE') {
            if (!byCategorySwedish.has(category)) byCategorySwedish.set(category, new Set());
            byCategorySwedish.get(category).add(id);
        }
        const reverseKey = key(id, row.Culture ?? row.culture);
        if (!reverse.has(reverseKey)) reverse.set(reverseKey, new Set());
        reverse.get(reverseKey).add(category);
    }
    for (const [idAndCulture, categories] of reverse) if (categories.size > 1) issues.push({ Type: 'collection_reverse_conflict', IDAndCulture: idAndCulture, Categories: [...categories].join(', ') });
    return { byCategory, byCategorySwedish, byId, metafieldColumns, issues };
}

function inspect(options = {}) {
    const config = { ...DEFAULTS, ...options };
    const sourceInventory = productInventoryCsv(config.productsExport, config.previousProductsExport);
    const currentProductRows = readSheet(config.productsExport, 'Products');
    const currentProductHeaders = new Set(Object.keys(currentProductRows[0] || {}));
    const historicalProductHeaders = new Set(Object.keys(readSheet(config.previousProductsExport, 'Products')[0] || {}));
    const collectionExport = readSheet(config.collectionsExport, 'Collections');
    const productCache = loadCache(config.productsCache, 'products');
    const collectionCache = loadCache(config.collectionsCache, 'collections');
    const products = productCache.sheets.Products;
    const collections = collectionCache.sheets.Collections;
    const productProgress = productCache.sheets.Progress;
    const collectionProgress = collectionCache.sheets.Progress;
    const attributes = productCache.sheets['Product Attributes'];
    const productImages = productCache.sheets['Product Images'];
    const collectionImages = collectionCache.sheets['Collection Images'];
    const cmsComponents = collectionCache.sheets['CMS Components'];
    const cmsProperties = collectionCache.sheets['CMS Properties'];
    const approvals = JSON.parse(fs.readFileSync(config.collectionApprovals, 'utf8'));
    const pid = productIdentity(sourceInventory.records);
    const cid = collectionIdentity(collectionExport, Array.isArray(approvals) ? approvals : approvals.mappings || []);
    const productPermalinks = readPermalinkSheet(config.productPermalinks, 'Sheet1');
    const categoryPermalinks = readPermalinkSheet(config.categoryPermalinks, 'categorypermalinks');
    const collectionDefinitions = verifiedDefinitions(config.collectionsExport);
    const issues = [...pid.issues, ...cid.issues,
        ...(sourceInventory.conflicts || []).map(item => ({ Type: 'source_product_conflict', ...item })),
        ...(sourceInventory.handleConflicts || []).map(item => ({ Type: 'source_product_handle_conflict', ...item })),
        ...(sourceInventory.mismatches || []).map(item => ({ Type: 'source_product_article_sku_difference', ...item, Blocking: false }))];
    const cacheProducts = new Set(products.map(row => key(row['Article Number'], row['Channel ID'])));
    const cacheCollections = new Set(collections.map(row => key(row['Category ID'], row['Channel ID'])));
    const unavailableProducts = new Set(products.filter(row => clean(row['Fetch Status']).toUpperCase() === 'NOT_AVAILABLE').map(row => key(row['Article Number'], row['Channel ID'])));
    const unavailableCollections = new Set(collections.filter(row => clean(row['Fetch Status']).toUpperCase() === 'NOT_AVAILABLE').map(row => key(row['Category ID'], row['Channel ID'])));
    const indexedProductProgress = new Map(productProgress.map(row => [key(row['Article Number'], row['Channel ID'], row['Query Group']), row]));
    const indexedCollectionProgress = new Map(collectionProgress.map(row => [key(row['Category ID'], row['Channel ID'], row['Query Group']), row]));
    for (const article of pid.byArticle.keys()) for (let channel = 1; channel <= 8; channel += 1) {
        if (!cacheProducts.has(key(article, channel))) issues.push({ Type: 'missing_product_cache', Article: article, Channel: channel });
    }
    for (const category of cid.byCategory.keys()) for (let channel = 1; channel <= 8; channel += 1) {
        if (!cacheCollections.has(key(category, channel))) issues.push({ Type: 'missing_collection_cache', Category: category, Channel: channel });
    }
    function checkProgress(index, id, channel, groups, entity) {
        for (const group of groups) {
            const progress = index.get(key(id, channel, group));
            const status = clean(progress?.Status).toUpperCase();
            const entityUnavailable = (entity === 'product' ? unavailableProducts : unavailableCollections).has(key(id, channel));
            if (!progress || !['COMPLETE', 'NOT_AVAILABLE'].includes(status) || (REQUIRED_GROUPS[entity === 'product' ? 'products' : 'collections'].includes(group) && status !== 'COMPLETE' && !entityUnavailable)) {
                issues.push({ Type: `incomplete_${entity}_group`, ID: id, Channel: channel, Group: group, Status: clean(progress?.Status) || 'PENDING' });
            }
        }
    }
    for (const article of pid.byArticle.keys()) for (let channel = 1; channel <= 8; channel += 1) checkProgress(indexedProductProgress, article, channel, GROUPS.products, 'product');
    for (const category of cid.byCategory.keys()) for (let channel = 1; channel <= 8; channel += 1) checkProgress(indexedCollectionProgress, category, channel, GROUPS.collections, 'collection');
    const productRows = [];
    for (const row of products) {
        const article = clean(row['Article Number']);
        const channel = clean(row['Channel ID']);
        const handles = pid.byArticle.get(article) || new Set();
        const status = clean(row['Fetch Status']).toUpperCase();
        const handle = handles.size === 1 ? [...handles][0] : '';
        const identity = pid.byHandle.get(handle);
        const match = clean(identity?.shopifyProductId);
        const cachedId = clean(row['Shopify Product ID']);
        const complete = requiredComplete(productCache, article, channel);
        const reason = handles.size > 1 ? 'ambiguous_product_match' : !handle ? 'unmatched_product' : cachedId && cachedId !== match ? 'unverified_product_id' : !complete && status !== 'NOT_AVAILABLE' ? 'incomplete_product' : '';
        const expected = pid.byArticle.has(article);
        if (reason) issues.push({ Type: expected ? reason : 'out_of_inventory_product', Article: article, Channel: channel, Status: status, Blocking: expected });
        productRows.push({ Article: article, Channel: channel, Culture: clean(row.Culture), 'Shopify ID': match, 'Shopify Handle': handle, Status: status, Issue: reason, Expected: expected, Source: row });
    }
    const collectionRows = [];
    for (const row of collections) {
        const category = clean(row['Category ID']);
        const channel = clean(row['Channel ID']);
        const ids = cid.byCategory.get(category) || new Set();
        const match = ids.size === 1 ? [...ids][0] : '';
        const status = clean(row['Fetch Status']).toUpperCase();
        const cachedId = clean(row['Shopify Collection ID']);
        const complete = requiredComplete(collectionCache, category, channel);
        const reason = ids.size > 1 ? 'ambiguous_collection_match' : !match ? 'unmatched_collection' : cachedId && cachedId !== match ? 'collection_id_mismatch' : !complete && status !== 'NOT_AVAILABLE' ? 'incomplete_collection' : '';
        const expected = cid.byCategory.has(category);
        if (reason) issues.push({ Type: expected ? reason : 'out_of_inventory_collection', Category: category, Channel: channel, Status: status, Blocking: expected });
        collectionRows.push({ Category: category, Channel: channel, Culture: clean(row.Culture), 'Shopify ID': match, 'Shopify Handle': clean(cid.byId.get(match)?.Handle), Status: status, Issue: reason, Expected: expected, Source: row });
    }
    return { config, pid, cid, products: productRows, collections: collectionRows, productCache, collectionCache,
        collectionDefinitions, productPermalinks, categoryPermalinks, productProgress, collectionProgress, attributes, productImages, collectionImages,
        cmsComponents, cmsProperties, currentProductRows, currentProductHeaders, historicalProductHeaders, issues };
}

function productImageReview(state) {
    const filename = value => {
        try { return decodeURIComponent(path.posix.basename(new URL(clean(value)).pathname)).toLowerCase(); }
        catch { return ''; }
    };
    const current = new Map();
    for (const row of state.currentProductRows || []) {
        const handle = clean(row.Handle), url = clean(row['Image Src']);
        if (!handle || !url) continue;
        if (!current.has(handle)) current.set(handle, []);
        current.get(handle).push({ filename: filename(url), position: clean(row['Image Position']), url });
    }
    const review = [], checked = new Set();
    for (const row of state.productImages || []) {
        if (clean(row['Channel ID']) !== '1') continue;
        const handleSet = state.pid?.byArticle.get(clean(row['Article Number'])) || new Set();
        if (handleSet.size !== 1) continue;
        const handle = [...handleSet][0], url = clean(row['Image URL']), name = filename(url);
        const identity = key(handle, url, row.Position);
        if (checked.has(identity)) continue;
        checked.add(identity);
        const context = { Handle: handle, Article: row['Article Number'], NorceURL: url,
            NorceFilename: name, NorcePosition: row.Position };
        if (!name) { review.push({ ...context, Issue: 'invalid_norce_product_image_url' }); continue; }
        const matches = (current.get(handle) || []).filter(image => image.filename === name);
        if (!matches.length) review.push({ ...context, Issue: 'filename_absent_from_current_shopify_export' });
        else if (clean(row.Position) && !matches.some(image => image.position === clean(row.Position)))
            review.push({ ...context, Issue: 'image_position_differs', ShopifyPositions: matches.map(image => image.position).join(', ') });
    }
    return review;
}

function writeWorkbook(file, sheets) {
    const workbook = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Status: 'No rows' }]), name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    XLSX.writeFile(workbook, file);
}

function writeReports(state) {
    const dir = path.join(state.config.outDir, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const productMapping = state.products.map(({ Source, ...row }) => row);
    const collectionMapping = state.collections.map(({ Source, ...row }) => row);
    writeWorkbook(path.join(dir, 'product-mapping.xlsx'), { 'Product Mapping': productMapping });
    writeWorkbook(path.join(dir, 'collection-mapping.xlsx'), { 'Collection Mapping': collectionMapping });
    writeWorkbook(path.join(dir, 'collection-metafield-definitions.xlsx'), { Definitions: state.cid.metafieldColumns.map(column => ({ Column: column })) });
    const coverage = [...state.products.map(row => ({ Entity: 'Product', Channel: row.Channel, Culture: row.Culture, Status: row.Status })), ...state.collections.map(row => ({ Entity: 'Collection', Channel: row.Channel, Culture: row.Culture, Status: row.Status }))];
    writeWorkbook(path.join(dir, 'translation-coverage.xlsx'), { Coverage: coverage });
    writeWorkbook(path.join(dir, 'image-coverage.xlsx'), { 'Product Images': state.productImages, 'Collection Images': state.collectionImages });
    writeWorkbook(path.join(dir, 'attribute-mapping.xlsx'), { Attributes: state.attributes.map(row => {
        const mapping = TRANSFORM.productAttributes[clean(row['Attribute Key'])];
        return { ...row, Destination: mapping ? `Metafield: custom.${mapping.key} [${mapping.type}]` : '', Mapping: mapping ? 'Configured' : 'Review' };
    }) });
    writeWorkbook(path.join(dir, 'extraction-errors.xlsx'), { Issues: state.issues });
    const translationReview = translationRows(state);
    const imagesReview = fileRows(state);
    const productImagesReview = productImageReview(state);
    const preview = matrixifyRows(state);
    writeWorkbook(path.join(dir, 'translation-review.xlsx'), { Review: translationReview.review });
    writeWorkbook(path.join(dir, 'image-review.xlsx'), { Review: imagesReview.review });
    writeWorkbook(path.join(dir, 'product-image-review.xlsx'), { Review: productImagesReview });
    writeWorkbook(path.join(dir, 'collection-cms-review.xlsx'), { Mapped: preview.cms.mapped, Unsupported: preview.cms.unsupported });
    writeWorkbook(path.join(dir, 'file-reference-review.xlsx'), { Verified: preview.verifiedFiles.verifiedCandidates, Review: preview.verifiedFiles.review });
    writeWorkbook(path.join(dir, 'migration-preview.xlsx'), { Products: preview.productUpdates, Collections: preview.collectionUpdates, Conflicts: preview.conflicts });
    const summary = {
        generatedAt: new Date().toISOString(), shopifyProducts: state.pid.byHandle.size,
        shopifyProductsWithIds: state.pid.byId.size,
        shopifyProductsAwaitingIds: state.pid.byHandle.size - state.pid.byId.size,
        shopifyCollections: state.cid.byId.size, productCacheRows: state.products.length,
        collectionCacheRows: state.collections.length, collectionMetafieldColumns: state.cid.metafieldColumns.length, issues: state.issues.length,
        blockingIssues: state.issues.filter(issue => issue.Blocking !== false).length,
        complete: state.issues.every(issue => issue.Blocking === false),
        translationReview: translationReview.review.length,
        imageReview: imagesReview.review.length,
        productImageReview: productImagesReview.length,
        previewConflicts: preview.conflicts.length,
        cmsMetafieldRows: preview.cms.rows.length,
        cmsUnsupported: preview.cms.unsupported.length,
        cmsLocalizedTranslationRows: Object.values(translationReview.byLocale).flat()
            .filter(row => row.Entity === 'Collection' && row.Field.startsWith('Metafield: ')).length,
        cmsLocalizedTranslationReview: translationReview.review.filter(row => row.Issue === 'cms_translation_not_reconciled').length,
        verifiedFileReferenceRows: preview.verifiedFiles.rows.length,
        fileReferenceReview: preview.verifiedFiles.review.length,
        productStatus: countBy(state.products, 'Status'), collectionStatus: countBy(state.collections, 'Status'),
        channelCoverage: channelCoverage(state, translationReview.review),
        attributes: {
            cached: state.attributes.length,
            configured: state.attributes.filter(row => Boolean(TRANSFORM.productAttributes[clean(row['Attribute Key'])])).length,
            unmapped: state.attributes.filter(row => !TRANSFORM.productAttributes[clean(row['Attribute Key'])]).length,
            localizedTranslationRows: Object.values(translationReview.byLocale).flat().filter(row => row.Field.startsWith('Metafield: ')).length,
            incompatibleLocalized: translationReview.review.filter(row => row.Issue === 'incompatible_or_unconfigured_attribute_translation').length,
            unmappedLocalized: translationReview.review.filter(row => row.Issue === 'unmapped_localized_attribute').length,
        },
        cmsComponents: state.cmsComponents.length,
        cmsProperties: state.cmsProperties.length,
        productImages: state.productImages.length,
        collectionImages: state.collectionImages.length,
    };
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    return summary;
}
function countBy(rows, field) { const counts = {}; for (const row of rows) counts[row[field] || 'UNKNOWN'] = (counts[row[field] || 'UNKNOWN'] || 0) + 1; return counts; }
function channelCoverage(state, translationReview) {
    return CHANNELS.map(channel => {
        const id = String(channel.id);
        const locale = TRANSFORM.cultureToShopifyLocale[channel.culture] || '';
        const products = state.products.filter(row => row.Channel === id && row.Expected);
        const collections = state.collections.filter(row => row.Channel === id && row.Expected);
        return { channelId: id, culture: channel.culture, locale,
            expectedProducts: state.pid.byArticle.size, expectedCollections: state.cid.byCategory.size,
            cachedProducts: products.length, cachedCollections: collections.length,
            missingProductCache: Math.max(0, state.pid.byArticle.size - new Set(products.map(row => row.Article)).size),
            missingCollectionCache: Math.max(0, state.cid.byCategory.size - new Set(collections.map(row => row.Category)).size),
            productStatuses: countBy(products, 'Status'), collectionStatuses: countBy(collections, 'Status'),
            unavailableProducts: products.filter(row => row.Status === 'NOT_AVAILABLE').length,
            unavailableCollections: collections.filter(row => row.Status === 'NOT_AVAILABLE').length,
            missingOrConflictingTranslations: translationReview.filter(row => row.Locale === locale &&
                /missing|empty|conflict|ambiguous|incompatible|unverified|fallback|not_reconciled/.test(clean(row.Issue))).length };
    });
}

function collectionBody(state, row) {
    const native = clean(row.Source['Body HTML']);
    if (native) return native;
    const fallback = collectionBodyFallback(state, row);
    return fallback.safe ? fallback.value : '';
}
function collectionBodyFallback(state, row) {
    // The current category workbook's native content cells are empty. Reuse
    // the project's established first live StoreAPI component text fallback.
    const first = (state.cmsProperties || []).filter(property =>
        clean(property['Category ID']) === row.Category &&
        clean(property['Channel ID']) === row.Channel &&
        clean(property['Property Name']).toLowerCase() === 'text' &&
        clean(property['Property Value']))
        .sort((a, b) => {
            const position = item => clean(item['Component Path']).split('/').map(Number);
            const left = position(a), right = position(b);
            for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
                if (left[i] === undefined) return -1;
                if (right[i] === undefined) return 1;
                if (left[i] !== right[i]) return left[i] - right[i];
            }
            return 0;
        })[0];
    const value = clean(first?.['Property Value']);
    let structured = false;
    if (/^[\[{]/.test(value)) {
        try { structured = typeof JSON.parse(value) === 'object'; } catch { /* ordinary text */ }
    }
    const unsafe = structured || /<\s*\/?\s*(script|style|iframe|object|embed|form|svg|math)\b|\bon[a-z]+\s*=|javascript\s*:|data\s*:/i.test(value);
    return { value, safe: !unsafe, property: first };
}

function matrixifyRows(state) {
    const productUpdates = new Map();
    const collectionUpdates = new Map();
    const conflicts = [];
    for (const row of state.products.filter(item => item.Channel === '1' && !item.Issue)) {
        const body = clean(row.Source.Description);
        const handle = clean(row['Shopify Handle']);
        if (!handle) { conflicts.push({ Type: 'missing_product_handle', Article: row.Article }); continue; }
        const update = { ...(validId(row['Shopify ID']) ? { ID: row['Shopify ID'] } : {}), Handle: handle, Command: 'UPDATE' };
        if (body) update['Body HTML'] = body;
        if (TRANSFORM.updateProductTitle && clean(row.Source.Name)) update.Title = clean(row.Source.Name);
        for (const attribute of (state.attributes || []).filter(item => clean(item['Article Number']) === row.Article && clean(item['Channel ID']) === '1')) {
            const mapping = TRANSFORM.productAttributes[clean(attribute['Attribute Key'])];
            if (!mapping) continue;
            const column = `Metafield: custom.${mapping.key} [${mapping.type}]`;
            const inCurrentExport = [...(state.currentProductHeaders || [])].some(name => name.endsWith(`(product.metafields.custom.${mapping.key})`));
            const typedInHistoricalExport = state.historicalProductHeaders?.has(column);
            if (!inCurrentExport || !typedInHistoricalExport) {
                conflicts.push({ Type: 'unverified_metafield_definition', Handle: handle, Attribute: attribute['Attribute Key'], Column: column });
                continue;
            }
            const value = formatAttributeValue(attribute['Attribute Value'], mapping.type);
            if (value === null) {
                // A boolean value outside the recognized true/false vocabulary is not
                // evidence for either Shopify value. Leave it blank instead of blocking
                // the product update or writing a guessed value.
                if (mapping.type === 'boolean') continue;
                conflicts.push({ Type: 'invalid_attribute_value', ID: row['Shopify ID'], Attribute: attribute['Attribute Key'] });
                continue;
            }
            if (value) update[column] = value;
        }
        if (!body && !update.Title && !Object.keys(update).some(name => name.startsWith('Metafield: '))) continue;
        const previous = productUpdates.get(handle);
        if (previous && JSON.stringify(previous) !== JSON.stringify(update)) {
            conflicts.push({ Type: 'product_update_conflict', Handle: handle, Article: row.Article });
            productUpdates.delete(handle);
            continue;
        }
        productUpdates.set(handle, update);
    }
    for (const row of state.collections.filter(item => item.Channel === '1' && !item.Issue)) {
        if (!clean(row.Source['Body HTML'])) {
            const fallback = collectionBodyFallback(state, row);
            if (!fallback.safe) {
                conflicts.push({ Type: 'unsafe_collection_body_fallback', ID: row['Shopify ID'], Category: row.Category,
                    ComponentPath: fallback.property?.['Component Path'] });
                continue;
            }
        }
        const body = collectionBody(state, row);
        if (!body) continue;
        const previous = collectionUpdates.get(row['Shopify ID']);
        if (previous && previous['Body HTML'] !== body) {
            conflicts.push({ Type: 'collection_body_conflict', ID: row['Shopify ID'], Category: row.Category });
            collectionUpdates.delete(row['Shopify ID']);
            continue;
        }
        collectionUpdates.set(row['Shopify ID'], { ID: row['Shopify ID'], Command: 'UPDATE', 'Body HTML': body });
    }
    const cms = state.collectionCache ? buildCollectionCmsMetafieldUpdates(state.collectionCache,
        { definitions: state.collectionDefinitions }) : { rows: [], mapped: [], unsupported: [] };
    const verifiedFiles = state.config?.filesResults && state.collectionCache
        ? buildVerifiedCollectionFileReferences(state.collectionCache, state.config.filesResults,
            { definitions: state.collectionDefinitions })
        : { rows: [], verifiedCandidates: [], review: (state.collectionImages || []).map(image => ({
            categoryId: image['Category ID'], channelId: image['Channel ID'], url: image['Image URL'],
            reason: 'Files results/export not supplied; file reference update withheld' })) };
    const blockedCollections = new Set();
    for (const sparse of cms.rows.concat(verifiedFiles.rows)) {
        const id = clean(sparse.ID);
        if (!validId(id) || blockedCollections.has(id)) {
            conflicts.push({ Type: 'invalid_or_blocked_collection_metafield_row', ID: id });
            continue;
        }
        const update = collectionUpdates.get(id) || { ID: id, Command: 'UPDATE' };
        for (const [column, value] of Object.entries(sparse)) {
            if (column === 'ID' || column === 'Command') continue;
            if (Object.hasOwn(update, column) && update[column] !== value) {
                conflicts.push({ Type: 'collection_metafield_conflict', ID: id, Column: column,
                    ExistingValue: update[column], NewValue: value });
                blockedCollections.add(id);
                collectionUpdates.delete(id);
                break;
            }
            update[column] = value;
        }
        if (!blockedCollections.has(id)) collectionUpdates.set(id, update);
    }
    return { productUpdates: [...productUpdates.values()], collectionUpdates: [...collectionUpdates.values()],
        conflicts, cms, verifiedFiles };
}

function formatAttributeValue(source, type) {
    let value = clean(source);
    if (!value) return '';
    if (type === 'boolean') {
        if (value.startsWith('[')) {
            try {
                const parsed = JSON.parse(value);
                if (!Array.isArray(parsed) || parsed.length !== 1) return null;
                value = clean(parsed[0]);
            } catch { return null; }
        }
        if (/^(ja|yes|true|1)$/i.test(value)) return 'TRUE';
        if (/^(nej|no|false|0)$/i.test(value)) return 'FALSE';
        return null;
    }
    if (type === 'list.single_line_text_field') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? JSON.stringify(parsed) : null;
        } catch { return null; }
    }
    return value;
}

const TRANSLATION_CHANNELS = Object.freeze(Object.fromEntries(CHANNELS
    .filter(channel => String(channel.id) !== '1' && String(channel.id) !== '8')
    .map(channel => [TRANSFORM.cultureToShopifyLocale[channel.culture], String(channel.id)])
    .filter(([locale]) => locale)));
function translationRows(state) {
    const rows = [];
    const review = [];
    const byLocale = Object.fromEntries(Object.keys(TRANSLATION_CHANNELS).map(locale => [locale, []]));
    for (const [entity, records, sourceFields] of [
        ['Product', state.products, [['Title', 'Name'], ['Body HTML', 'Description']]],
        ['Collection', state.collections, [['Title', 'Name'], ['Body HTML', 'Body HTML']]],
    ]) {
        const byId = new Map();
        for (const row of records) {
            if (row.Issue) continue;
            const entityKey = validId(row['Shopify ID']) ? String(row['Shopify ID']) : row['Shopify Handle'] ? `handle:${row['Shopify Handle']}` : '';
            if (!entityKey) continue;
            if (!byId.has(entityKey)) byId.set(entityKey, new Map());
            const byChannel = byId.get(entityKey);
            if (!byChannel.has(row.Channel)) byChannel.set(row.Channel, []);
            byChannel.get(row.Channel).push(row);
        }
        for (const [entityKey, channels] of byId) for (const [field, sourceField] of sourceFields) {
            const values = {};
            let conflict = false;
            const handle = clean((channels.get('1') || [])[0]?.['Shopify Handle']);
            const entityId = entityKey.startsWith('handle:') ? '' : entityKey;
            if (!handle) { review.push({ Entity: entity, ID: entityId, Field: field, Issue: 'missing_entity_handle' }); continue; }
            const primaryValues = [...new Set((channels.get('1') || []).map(item =>
                entity === 'Collection' && field === 'Body HTML' ? collectionBody(state, item) : clean(item.Source[sourceField])
            ).filter(Boolean))];
            for (const [locale, channel] of Object.entries(TRANSLATION_CHANNELS)) {
                const distinct = [...new Set((channels.get(channel) || []).map(item =>
                    entity === 'Collection' && field === 'Body HTML' ? collectionBody(state, item) : clean(item.Source[sourceField])
                ).filter(Boolean))];
                if (distinct.length !== 1) {
                    review.push({ Entity: entity, ID: entityId, Handle: handle, Field: field, Locale: locale, Issue: distinct.length > 1 ? 'conflicting_source_values' : 'missing_source_value' });
                    conflict = true;
                } else if (primaryValues.length === 1 && distinct[0] === primaryValues[0]) {
                    review.push({ Entity: entity, ID: entityId, Handle: handle, Field: field, Locale: locale, Issue: 'possible_source_fallback' });
                    conflict = true;
                } else values[`Translation Value: ${locale}`] = distinct[0];
            }
            if (field === 'Body HTML' || field === 'Title') {
                const de = values['Translation Value: de'];
                const at = [...new Set((channels.get('8') || []).map(item =>
                    entity === 'Collection' && field === 'Body HTML' ? collectionBody(state, item) : clean(item.Source[sourceField])
                ).filter(Boolean))];
                if (de && at.length && (at.length !== 1 || at[0] !== de)) {
                    review.push({ Entity: entity, ID: entityId, Handle: handle, Field: field, Locale: 'de-AT', Issue: 'DE_AT_market_conflict' });
                    conflict = true;
                    delete values['Translation Value: de'];
                }
            }
            if (!conflict) rows.push({ Entity: entity, ...(entityId ? { 'Entity ID': entityId } : {}),
                'Entity Handle': handle, Field: field, ...values });
            else for (const [locale, value] of Object.entries(values)) {
                const code = locale.slice('Translation Value: '.length);
                byLocale[code].push({ Entity: entity, ...(entityId ? { 'Entity ID': entityId } : {}), 'Entity Handle': handle, Field: field, [locale]: value });
            }
        }
    }
    productAttributeTranslationRows(state, rows, byLocale, review);
    collectionCmsTranslationRows(state, rows, byLocale, review);
    permalinkTranslationRows(state, rows, byLocale, review);
    return { rows, byLocale, review };
}

function permalinkTranslationRows(state, rows, byLocale, review) {
    if (!state.pid || !state.cid) return;
    const add = (entity, identityId, handle, localeValues, context) => {
        const valueMap = new Map();
        for (const [culture, url] of localeValues) {
            const locale = TRANSFORM.cultureToShopifyLocale[culture] ?? (culture === 'sv-SE' ? '' : undefined);
            const segments = clean(url).split('/').filter(Boolean);
            const slug = entity === 'Collection' ? segments.join('-').replace(/-+/g, '-') : segments.at(-1);
            if (!locale || !slug) continue;
            if (!valueMap.has(locale)) valueMap.set(locale, new Set());
            valueMap.get(locale).add(slug);
        }
        const base = [...(valueMap.get('') || [])][0];
        const translated = new Map();
        for (const [locale, set] of valueMap) {
            if (set.size !== 1) { review.push({ Entity: entity, ID: identityId, Handle: handle, Field: 'Handle', Locale: locale, Issue: 'conflicting_handle_permalinks', Context: context }); continue; }
            const value = [...set][0];
            if (locale && value !== base) translated.set(locale, value);
        }
        if (!translated.size) return;
        const row = { Entity: entity, ...(validId(identityId) ? { 'Entity ID': identityId } : {}), 'Entity Handle': handle, Field: 'Handle' };
        for (const [locale, value] of translated) {
            row[`Translation Value: ${locale}`] = value;
            byLocale[locale]?.push({ Entity: entity, ...(validId(identityId) ? { 'Entity ID': identityId } : {}),
                'Entity Handle': handle, Field: 'Handle', [`Translation Value: ${locale}`]: value });
        }
        rows.push(row);
    };
    for (const product of state.pid.byArticle.keys()) {
        const matches = state.productPermalinks.filter(row => clean(row.ArticleNumber) === product);
        const identities = state.pid.byArticle.get(product);
        const handle = identities?.size === 1 ? [...identities][0] : '';
        if (!handle) continue;
        const id = clean(state.pid.byHandle.get(handle)?.shopifyProductId);
        add('Product', id, handle, matches.map(row => [row.Culture, row.Permalink]), product);
    }
    for (const [category, ids] of state.cid.byCategory) {
        if (ids.size !== 1) continue;
        const id = [...ids][0], handle = clean(state.cid.byId.get(id)?.Handle);
        if (!handle) continue;
        const matches = state.categoryPermalinks.filter(row => clean(row.CategoryID) === category);
        add('Collection', id, handle, matches.map(row => [row.Culture, row.Link]), category);
    }
}

function collectionCmsTranslationRows(state, rows, byLocale, review) {
    if (!state.collectionCache || !state.collectionDefinitions) return;
    const cache = state.collectionCache, definitions = state.collectionDefinitions;
    const primary = buildCollectionCmsMetafieldUpdates(cache, { channelId: '1', definitions });
    const primaryValues = new Map(primary.rows.flatMap(row => Object.entries(row)
        .filter(([column]) => column.startsWith('Metafield: '))
        .map(([column, value]) => [key(row.ID, column), value])));
    const primaryMapped = new Map(primary.mapped.map(row => [key(row.categoryId, row.key), row]));
    const structure = (category, channel) => JSON.stringify(semanticComponentKeys(cachedComponents(cache, category, channel))
        .map(component => [component.componentPath, component.componentName, component.componentType, component.layoutType]));
    const cacheRows = new Map(cache.sheets.Collections.map(row => [key(row['Category ID'], row['Channel ID']), row]));
    const localized = new Map();
    for (const channel of ['2', '3', '4', '5', '6', '7', '8'])
        localized.set(channel, buildCollectionCmsMetafieldUpdates(cache, { channelId: channel, definitions }));
    const mappedCount = new Map();
    const mergedRows = new Map();
    for (const [locale, channel] of Object.entries(TRANSLATION_CHANNELS)) {
        const result = localized.get(channel);
        for (const unsupported of result.unsupported) review.push({ Entity: 'Collection',
            Category: unsupported.categoryId, Locale: locale,
            Field: unsupported.candidateKey ? `Metafield: custom.${unsupported.candidateKey}` : '',
            ComponentPath: unsupported.componentPath || '', Issue: 'cms_translation_not_reconciled',
            Detail: unsupported.reason });
        const values = new Map(result.rows.flatMap(row => Object.entries(row)
            .filter(([column]) => column.startsWith('Metafield: '))
            .map(([column, value]) => [key(row.ID, column), value])));
        for (const candidate of result.mapped) {
            const definition = definitions.get(candidate.key);
            if (definition?.type !== 'rich_text_field') continue;
            const context = { Entity: 'Collection', Category: candidate.categoryId,
                ID: candidate.shopifyCollectionId, Locale: locale, Field: `Metafield: custom.${candidate.key}` };
            const base = primaryMapped.get(key(candidate.categoryId, candidate.key));
            const baseValue = primaryValues.get(key(candidate.shopifyCollectionId, definition.column));
            const value = values.get(key(candidate.shopifyCollectionId, definition.column));
            const sourceRow = cacheRows.get(key(candidate.categoryId, channel));
            const primaryRow = cacheRows.get(key(candidate.categoryId, '1'));
            const identity = state.cid?.byId.get(clean(candidate.shopifyCollectionId));
            if (!base || !baseValue || !value || !identity || !sourceRow || !primaryRow ||
                clean(sourceRow['Shopify Collection ID']) !== clean(primaryRow['Shopify Collection ID']) ||
                JSON.stringify(base.componentPaths) !== JSON.stringify(candidate.componentPaths) ||
                structure(candidate.categoryId, '1') !== structure(candidate.categoryId, channel)) {
                review.push({ ...context, Issue: 'cms_translation_not_reconciled',
                    Detail: 'Verified primary source, collection identity, or component structure differs' });
                continue;
            }
            if (value === baseValue) {
                review.push({ ...context, Issue: 'possible_source_fallback' });
                continue;
            }
            if (locale === 'de') {
                const austrian = localized.get('8');
                const atValue = austrian.rows.flatMap(row => row.ID === candidate.shopifyCollectionId
                    ? [row[definition.column]] : []).filter(Boolean);
                if (atValue.length && (atValue.length !== 1 || atValue[0] !== value ||
                    structure(candidate.categoryId, '8') !== structure(candidate.categoryId, channel))) {
                    review.push({ ...context, Locale: 'de-AT', Issue: 'DE_AT_market_conflict' });
                    continue;
                }
            }
            const translationColumn = `Translation Value: ${locale}`;
            byLocale[locale].push({ Entity: 'Collection', 'Entity ID': candidate.shopifyCollectionId,
                'Entity Handle': clean(identity.Handle), Field: context.Field, [translationColumn]: value });
            const mergedKey = key(candidate.shopifyCollectionId, context.Field);
            const merged = mergedRows.get(mergedKey) || { Entity: 'Collection', 'Entity ID': candidate.shopifyCollectionId,
                'Entity Handle': clean(identity.Handle), Field: context.Field };
            if (merged[translationColumn] && merged[translationColumn] !== value) {
                review.push({ ...context, Issue: 'conflicting_cms_translation_values' });
                continue;
            }
            merged[translationColumn] = value;
            mergedRows.set(mergedKey, merged);
            const categoryChannel = key(candidate.categoryId, channel);
            mappedCount.set(categoryChannel, (mappedCount.get(categoryChannel) || 0) + 1);
        }
    }
    rows.push(...mergedRows.values());
    const counts = new Map();
    for (const property of state.cmsProperties || []) {
        const channel = clean(property['Channel ID']);
        if (channel === '1' || !clean(property['Property Value']) || !Object.values(TRANSLATION_CHANNELS).includes(channel)) continue;
        const categoryChannel = key(property['Category ID'], channel);
        counts.set(categoryChannel, (counts.get(categoryChannel) || 0) + 1);
    }
    for (const [categoryChannel, count] of counts) if (!mappedCount.has(categoryChannel)) {
        const [category, channel] = categoryChannel.split('\u0000');
        review.push({ Entity: 'Collection', Category: category,
            Locale: Object.entries(TRANSLATION_CHANNELS).find(([, id]) => id === channel)?.[0],
            Issue: 'cms_translation_not_reconciled', PropertyCount: count,
            Detail: 'No safe localized rich-text metafield mapping for this channel' });
    }
}

function productAttributeTranslationRows(state, rows, byLocale, review) {
    const productByArticleChannel = new Map(state.products.map(row => [key(row.Article, row.Channel), row]));
    const primary = new Map();
    const localized = new Map();
    for (const attribute of state.attributes || []) {
        const article = clean(attribute['Article Number']);
        const channel = clean(attribute['Channel ID']);
        const product = productByArticleChannel.get(key(article, channel));
        if (!product || product.Issue || product.Expected === false) continue;
        const handle = clean(product['Shopify Handle']);
        const attributeKey = clean(attribute['Attribute Key']);
        if (!handle || !attributeKey) continue;
        const target = channel === '1' ? primary : localized;
        const lookup = key(handle, attributeKey, channel);
        if (!target.has(lookup)) target.set(lookup, { product, attributeKey, attributes: [] });
        target.get(lookup).attributes.push(attribute);
    }
    const candidates = new Map();
    for (const { product, attributeKey, attributes } of localized.values()) {
        const channel = clean(attributes[0]['Channel ID']);
        const locale = Object.entries(TRANSLATION_CHANNELS).find(([, id]) => id === channel)?.[0];
        if (!locale) continue;
        const mapping = TRANSFORM.productAttributes[attributeKey];
        const values = [...new Set(attributes.map(item => clean(item['Attribute Value'])).filter(Boolean))];
        const context = { Entity: 'Product', Article: product.Article, Handle: product['Shopify Handle'], Locale: locale, Attribute: attributeKey };
        if (!mapping) {
            if (values.length) review.push({ ...context, Issue: 'unmapped_localized_attribute' });
            continue;
        }
        if (!['single_line_text_field', 'list.single_line_text_field'].includes(mapping.type) || !TRANSLATABLE_PRODUCT_ATTRIBUTE_KEYS.has(attributeKey.toLowerCase())) {
            if (values.length) review.push({ ...context, Issue: 'incompatible_or_unconfigured_attribute_translation', DestinationType: mapping.type });
            continue;
        }
        const column = `Metafield: custom.${mapping.key} [${mapping.type}]`;
        const currentField = [...(state.currentProductHeaders || [])].some(name => name.endsWith(`(product.metafields.custom.${mapping.key})`));
        if (!currentField || !state.historicalProductHeaders?.has(column)) {
            review.push({ ...context, Issue: 'unverified_attribute_definition', Column: column });
            continue;
        }
        const base = primary.get(key(product['Shopify Handle'], attributeKey, '1'));
        const baseValues = [...new Set((base?.attributes || []).map(item => clean(item['Attribute Value'])).filter(Boolean))];
        if (baseValues.length !== 1 || !safeAttributeTranslation(baseValues[0], mapping.type)) {
            review.push({ ...context, Issue: 'missing_or_ambiguous_primary_attribute' });
            continue;
        }
        if (values.length !== 1 || !safeAttributeTranslation(values[0], mapping.type)) {
            review.push({ ...context, Issue: values.length ? 'ambiguous_or_incompatible_localized_attribute' : 'empty_localized_attribute' });
            continue;
        }
        const field = `Metafield: custom.${mapping.key}`;
        const identity = validId(product['Shopify ID']) ? product['Shopify ID'] : product['Shopify Handle'];
        if (!identity) {
            review.push({ ...context, Issue: 'missing_product_identity_for_attribute_translation' });
            continue;
        }
        const candidateKey = key(identity, field, locale);
        if (!candidates.has(candidateKey)) candidates.set(candidateKey, { product, field, locale, value: values[0], attributeKey, context });
        else if (candidates.get(candidateKey).value !== values[0]) {
            candidates.get(candidateKey).conflict = true;
            review.push({ ...context, Issue: 'conflicting_variant_attribute_translations' });
        }
    }
    const mergedRows = new Map();
    for (const candidate of candidates.values()) {
        if (candidate.conflict) continue;
        if (candidate.locale === 'de') {
            const at = localized.get(key(candidate.product['Shopify Handle'], candidate.attributeKey, '8'));
            const atValues = [...new Set((at?.attributes || []).map(item => clean(item['Attribute Value'])).filter(Boolean))];
            if (atValues.length && (atValues.length !== 1 || atValues[0] !== candidate.value)) {
                review.push({ ...candidate.context, Locale: 'de-AT', Issue: 'DE_AT_market_conflict' });
                continue;
            }
        }
        const translationColumn = `Translation Value: ${candidate.locale}`;
        const identity = validId(candidate.product['Shopify ID']) ? candidate.product['Shopify ID'] : candidate.product['Shopify Handle'];
        byLocale[candidate.locale].push({ Entity: 'Product', ...(validId(candidate.product['Shopify ID']) ? { 'Entity ID': candidate.product['Shopify ID'] } : {}),
            'Entity Handle': candidate.product['Shopify Handle'], Field: candidate.field, [translationColumn]: candidate.value });
        const mergedKey = key(identity, candidate.field);
        const merged = mergedRows.get(mergedKey) || { Entity: 'Product', ...(validId(candidate.product['Shopify ID']) ? { 'Entity ID': candidate.product['Shopify ID'] } : {}),
            'Entity Handle': candidate.product['Shopify Handle'], Field: candidate.field };
        if (merged[translationColumn] && merged[translationColumn] !== candidate.value) {
            review.push({ ...candidate.context, Issue: 'conflicting_variant_attribute_translations' });
            continue;
        }
        merged[translationColumn] = candidate.value;
        mergedRows.set(mergedKey, merged);
    }
    rows.push(...mergedRows.values());
}

function safeSingleLine(value) {
    const text = clean(value);
    return Boolean(text) && !/[\r\n]/.test(text) && !/^[\[{]/.test(text);
}

function safeAttributeTranslation(value, type) {
    if (type !== 'list.single_line_text_field') return safeSingleLine(value);
    try {
        const parsed = JSON.parse(clean(value));
        return Array.isArray(parsed) && parsed.length > 0 && parsed.every(item =>
            typeof item === 'string' && Boolean(item.trim()) && !/[\r\n]/.test(item));
    } catch {
        return false;
    }
}

function fileRows(state) {
    const files = new Map();
    const review = [];
    for (const image of state.collectionImages) {
        const url = clean(image['Image URL']);
        if (!url) continue;
        let filename;
        try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
            filename = imageFilename(url);
            if (!filename) throw new Error('Missing filename');
        } catch {
            review.push({ Type: 'invalid_image_url', Category: image['Category ID'], URL: url });
            continue;
        }
        if (files.has(filename) && files.get(filename).Link !== url) {
            review.push({ Type: 'duplicate_filename', File: filename, URL: url });
            continue;
        }
        files.set(filename, { Command: 'NEW', 'File Name': filename, Link: url });
    }
    return { rows: [...files.values()], review };
}

function publishMatrixifyRun(outDir, workbooks, metadata = {}) {
    const runsDir = path.join(outDir, 'matrixify-runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const staging = fs.mkdtempSync(path.join(runsDir, '.staging-'));
    const files = [];
    for (const [filename, sheets] of Object.entries(workbooks)) {
        if (!Object.values(sheets).some(rows => rows.length)) continue;
        writeWorkbook(path.join(staging, filename), sheets);
        files.push(filename);
    }
    if (!files.includes('02-products.xlsx') || !files.includes('03-collections.xlsx')) throw new Error(`Incomplete Matrixify staging directory: ${staging}`);
    const manifest = { generatedAt: new Date().toISOString(), files, ...metadata };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const published = path.join(runsDir, `run-${manifest.generatedAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`);
    fs.renameSync(staging, published);
    return { directory: published, files };
}

function generate(options = {}) {
    const state = inspect(options);
    const summary = writeReports(state);
    const selectedProductCount = state.products.filter(row => row.Channel === '1').length;
    const selectedCollectionCount = state.collections.filter(row => row.Channel === '1').length;
    const unresolved = state.products.concat(state.collections).some(row => row.Expected && row.Issue);
    if (!selectedProductCount || !selectedCollectionCount || unresolved || !summary.complete) {
        throw new Error('Caches are missing or incomplete; review reports before generating Matrixify imports.');
    }
    const rows = matrixifyRows(state);
    const translations = translationRows(state);
    const files = fileRows(state);
    if (!rows.productUpdates.length || !rows.collectionUpdates.length) {
        throw new Error('No safe product or collection updates were found; inspect the source caches and review reports.');
    }
    if (rows.conflicts.length) {
        writeWorkbook(path.join(state.config.outDir, 'reports/migration-preview.xlsx'), { Conflicts: rows.conflicts });
        throw new Error('Conflicting product or collection content requires review.');
    }
    const workbooks = {
        '01-files.xlsx': { Files: files.rows },
        '02-products.xlsx': { Products: rows.productUpdates },
        '03-collections.xlsx': { Collections: rows.collectionUpdates },
        '04-translations.xlsx': { Translations: translations.rows },
    };
    const published = publishMatrixifyRun(state.config.outDir, workbooks, {
        sourceCaches: [state.config.productsCache, state.config.collectionsCache],
        productUpdates: rows.productUpdates.length, collectionUpdates: rows.collectionUpdates.length,
        translationReviewRows: translations.review.length, imageReviewRows: files.review.length,
        cmsMetafieldRows: rows.cms.rows.length, cmsUnsupportedRows: rows.cms.unsupported.length,
        verifiedFileReferenceRows: rows.verifiedFiles.rows.length,
        filesResults: state.config.filesResults || null,
    });
    writeWorkbook(path.join(state.config.outDir, 'reports/migration-preview.xlsx'), { Products: rows.productUpdates, Collections: rows.collectionUpdates });
    writeWorkbook(path.join(state.config.outDir, 'reports/translation-review.xlsx'), { Review: translations.review });
    writeWorkbook(path.join(state.config.outDir, 'reports/image-review.xlsx'), { Review: files.review });
    writeWorkbook(path.join(state.config.outDir, 'reports/collection-cms-review.xlsx'), { Mapped: rows.cms.mapped, Unsupported: rows.cms.unsupported });
    writeWorkbook(path.join(state.config.outDir, 'reports/file-reference-review.xlsx'), { Verified: rows.verifiedFiles.verifiedCandidates, Review: rows.verifiedFiles.review });
    return { ...summary, generatedProducts: rows.productUpdates.length, generatedCollections: rows.collectionUpdates.length,
        generatedTranslations: translations.rows.length, generatedLocaleTranslations: Object.fromEntries(Object.entries(translations.byLocale).map(([locale, localeRows]) => [locale, localeRows.length])), generatedFiles: files.rows.length,
        translationReview: translations.review.length, imageReview: files.review.length,
        cmsMetafieldRows: rows.cms.rows.length, cmsUnsupported: rows.cms.unsupported.length,
        verifiedFileReferenceRows: rows.verifiedFiles.rows.length, fileReferenceReview: rows.verifiedFiles.review.length,
        outputDirectory: published.directory, outputFiles: published.files };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const operation = args[0] || 'validate';
    const options = {};
    for (const arg of args.slice(1)) {
        const m = /^--([^=]+)=(.*)$/.exec(arg);
        if (m) options[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = path.resolve(m[2]);
    }
    try {
        const result = operation === 'validate' ? writeReports(inspect(options)) : operation === 'generate' ? generate(options) : null;
        if (!result) throw new Error('Use validate or generate.');
        console.log(JSON.stringify(result, null, 2));
        if (operation === 'validate' && !result.complete) process.exitCode = 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { DEFAULTS, readSheet, productIdentity, collectionIdentity, inspect, writeReports, channelCoverage, collectionBody, formatAttributeValue, matrixifyRows, translationRows, fileRows, publishMatrixifyRun, generate };
