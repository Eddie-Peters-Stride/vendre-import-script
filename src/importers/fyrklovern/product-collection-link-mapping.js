const XLSX = require('xlsx');
const { readCategorieslocalized } = require('./categorieslocalized');

const OLD_FIELD = 'Metafield: custom.collection_category_id [single_line_text_field]';
const NEW_FIELD = 'Metafield: custom.collection_category [collection_reference]';
function cleanExportSku(value) {
    return String(value || '').trim().replace(/^'(?=\d+$)/, '');
}

function readRows(file, sheetName) {
    const book = XLSX.readFile(file);
    const sheet = book.Sheets[sheetName] || (file.toLowerCase().endsWith('.csv') ? book.Sheets[book.SheetNames[0]] : null);
    if (!sheet) throw new Error(`${file} has no ${sheetName} sheet.`);
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

function buildProductCollectionLinks(products, categories, collections, liveProducts, approvedMap = {}, dynamicFields = []) {
    const errors = [];
    const categoryById = new Map();
    const collectionByHandle = new Map();
    const collectionIds = new Set();
    const liveBySku = new Map();
    const liveByExternalId = new Map();
    const liveByHandle = new Map();
    const dynamicByArticle = new Map();
    const liveHasOldField = liveProducts.some(product =>
        Object.hasOwn(product, OLD_FIELD) ||
        Object.hasOwn(product, 'Collection Category ID (product.metafields.custom.collection_category_id)')
    );
    for (const category of categories) {
        const id = String(category.id || '').trim();
        if (!id || categoryById.has(id)) errors.push(`Missing or duplicate source category ID ${id}`);
        else categoryById.set(id, category);
    }
    for (const collection of collections) {
        if (String(collection['Top Row']).toLowerCase() !== 'true') continue;
        const handle = String(collection.Handle || '').trim().toLowerCase();
        const id = String(collection.ID || '').trim();
        if (!handle || !id || collectionByHandle.has(handle)) {
            errors.push(`Missing or duplicate Shopify collection ${id} / ${handle}`);
        } else {
            collectionByHandle.set(handle, id);
            collectionIds.add(id);
        }
    }
    for (const [sourceId, shopifyId] of Object.entries(approvedMap)) {
        if (!collectionIds.has(String(shopifyId))) errors.push(`Approved map ${sourceId} targets missing Shopify collection ${shopifyId}`);
    }
    for (const field of dynamicFields) {
        if (String(field.ItemName || '').trim().toLowerCase() !== 'collection category id' ||
            String(field.Culture || '').trim() !== 'sv-SE') continue;
        const article = cleanExportSku(field.ArticleNumber);
        const value = String(field.Value || '').trim();
        if (!article || !value) continue;
        if (dynamicByArticle.has(article) && dynamicByArticle.get(article) !== value) {
            errors.push(`DynamicFields has conflicting Collection category ID values for article ${article}`);
        } else dynamicByArticle.set(article, value);
    }
    for (const product of liveProducts) {
        const sku = cleanExportSku(product['Variant SKU']);
        const id = String(product.ID || '').trim();
        const handle = String(product.Handle || '').trim();
        const externalId = String(product['Metafield: custom.external_id [single_line_text_field]'] ||
            product['External ID (product.metafields.custom.external_id)'] || '').trim();
        const oldCategoryId = String(product[OLD_FIELD] ||
            product['Collection Category ID (product.metafields.custom.collection_category_id)'] || '').trim();
        if (!sku && !externalId && !oldCategoryId) continue;
        if (!handle) {
            errors.push(`Live export has SKU ${sku} or external ID ${externalId} without product handle`);
            continue;
        }
        let item = liveByHandle.get(handle);
        if (!item) {
            item = { id, handle, skus: new Set(), externalIds: new Set(), oldCategoryIds: new Set(), collectionNames: new Set() };
            liveByHandle.set(handle, item);
        }
        if (id && item.id && item.id !== id) errors.push(`Live handle ${handle} has conflicting product IDs`);
        if (id) item.id = id;
        if (sku) item.skus.add(sku);
        if (externalId) item.externalIds.add(externalId);
        if (oldCategoryId) item.oldCategoryIds.add(oldCategoryId);
        const collectionName = String(product['Collections (product.metafields.custom.collection)'] || '').trim();
        if (collectionName) item.collectionNames.add(collectionName);
    }
    for (const item of liveByHandle.values()) {
        if (item.oldCategoryIds.size > 1) errors.push(`Live handle ${item.handle} has conflicting source category IDs`);
        for (const sku of item.skus) {
            if (liveBySku.has(sku) && liveBySku.get(sku) !== item) errors.push(`Live export has duplicate SKU ${sku} across products`);
            else liveBySku.set(sku, item);
        }
        for (const externalId of item.externalIds) {
            if (liveByExternalId.has(externalId) && liveByExternalId.get(externalId) !== item) errors.push(`Live export has duplicate external ID ${externalId} across products`);
            else liveByExternalId.set(externalId, item);
        }
    }
    if (!liveByHandle.size) errors.push('Live product export has no Handle with Variant SKU or custom.external_id.');
    const selected = dynamicByArticle.size
        ? [...liveByHandle.values()].flatMap(item => {
            const matches = [...item.externalIds].filter(id => dynamicByArticle.has(id));
            if (new Set(matches.map(id => dynamicByArticle.get(id))).size > 1) {
                errors.push(`Live handle ${item.handle} matches conflicting DynamicFields category IDs`);
            }
            const article = matches[0];
            return article ? [{ Handle: item.handle,
                [OLD_FIELD]: dynamicByArticle.get(article),
                'Metafield: custom.external_id [single_line_text_field]': article,
                'Metafield: custom.collection [list.single_line_text_field]': [...item.collectionNames][0] || '',
            }] : [];
        })
        : liveHasOldField
        ? [...liveByHandle.values()].filter(item => item.oldCategoryIds.size).map(item => ({
            Handle: item.handle,
            [OLD_FIELD]: [...item.oldCategoryIds][0],
            'Metafield: custom.external_id [single_line_text_field]': [...item.externalIds][0] || [...item.skus][0] || '',
            'Metafield: custom.collection [list.single_line_text_field]': [...item.collectionNames][0] || '',
        }))
        : products.filter(product => String(product[OLD_FIELD] || '').trim());
    const handles = new Set();
    const mapped = [];
    const unresolved = [];
    for (const product of selected) {
        const stagedHandle = String(product.Handle || '').trim();
        const sku = String(product['Metafield: custom.external_id [single_line_text_field]'] || '').trim();
        const sourceCategoryId = String(product[OLD_FIELD]).trim();
        if (!stagedHandle || !sku || handles.has(sku)) {
            errors.push(`Missing staged product handle/SKU or duplicate SKU ${sku}`);
            continue;
        }
        handles.add(sku);
        const byExternal = liveByExternalId.get(sku);
        const bySku = liveBySku.get(sku);
        if (byExternal && bySku && byExternal !== bySku) errors.push(`Product ${sku}: external ID and SKU point to different Shopify products`);
        const live = (dynamicByArticle.size || liveHasOldField) ? liveByHandle.get(stagedHandle) : (byExternal || bySku);
        const liveSku = live ? (live.skus.has(sku) ? sku : [...live.skus][0] || '') : '';
        const category = categoryById.get(sourceCategoryId);
        const collectionHandle = category?.handle || '';
        const directId = collectionByHandle.get(collectionHandle.toLowerCase()) || '';
        const approvedId = approvedMap[sourceCategoryId] == null ? '' : String(approvedMap[sourceCategoryId]);
        if (directId && approvedId && directId !== approvedId) errors.push(`Approved map conflicts with direct mapping for category ${sourceCategoryId}`);
        const shopifyCollectionId = directId || approvedId;
        const item = {
            productHandle: live?.handle || '', stagedHandle,
            shopifyProductId: live?.id || '',
            liveSku,
            productExternalId: sku,
            sourceCategoryId, sourceCollectionName: String(product['Metafield: custom.collection [list.single_line_text_field]'] || '').trim(),
            shopifyOldCategoryId: live ? [...live.oldCategoryIds][0] || '' : '',
            shopifyCollectionHandle: collectionHandle, shopifyCollectionId,
            mappingSource: directId ? 'source category handle' : (approvedId ? 'approved map' : ''),
            assignedCollections: String(product['Custom Collections'] || '').trim(),
        };
        if (shopifyCollectionId && live && liveSku) mapped.push(item);
        else unresolved.push({ ...item, reason: !shopifyCollectionId
            ? (category ? 'no Shopify collection for source category handle' : 'source category ID absent from Swedish category export')
            : (live ? 'matched Shopify product has no Variant SKU for Matrixify identification' : 'product absent from live Shopify export') });
    }
    const rows = mapped.map(item => ({
        ID: item.shopifyProductId,
        Handle: item.productHandle,
        'Variant SKU [ID]': item.liveSku,
        Command: 'UPDATE',
        [NEW_FIELD]: item.shopifyCollectionId,
        [OLD_FIELD]: '',
    }));
    return { rows, mapped, unresolved, errors, selectedCount: selected.length };
}

function buildFromFiles(productWorkbook, categoryWorkbook, collectionExport, liveProductExport, approvedMap = {}) {
    if (!liveProductExport) throw new Error('A current Shopify Products export is required (--live-products).');
    const liveRows = readRows(liveProductExport, 'Products');
    const dynamicFields = readRows(categoryWorkbook, 'dynamicfields');
    if (!dynamicFields.some(row => String(row.ItemName || '').trim().toLowerCase() === 'collection category id' &&
        String(row.Culture || '').trim() === 'sv-SE' && String(row.Value || '').trim())) {
        throw new Error('The DynamicFields tab has no Swedish Collection category ID values.');
    }
    if (!liveRows.some(row => Object.hasOwn(row, OLD_FIELD) ||
        Object.hasOwn(row, 'Collection Category ID (product.metafields.custom.collection_category_id)'))) {
        throw new Error('The Shopify Products export must include the current custom.collection_category_id metafield.');
    }
    return buildProductCollectionLinks(
        [],
        readCategorieslocalized(categoryWorkbook),
        readRows(collectionExport, 'Collections'),
        liveRows, approvedMap, dynamicFields
    );
}

module.exports = { OLD_FIELD, NEW_FIELD, readRows, buildProductCollectionLinks, buildFromFiles };
