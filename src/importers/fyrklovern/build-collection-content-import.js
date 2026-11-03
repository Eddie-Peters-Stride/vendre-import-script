#!/usr/bin/env node
/** Build approval-gated, offline Matrixify collection content imports. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const {
    readCategoryWorkbook, readCmsCsv, normalizeCms, normalizeContentMap, clean,
} = require('./norce-source-ingestion');
const {
    normalizeStoreApiComponents, categoryLookup,
    loadComponentExceptions, reconcileCsvComponents, componentIdentity,
} = require('./norce-storeapi-content');

const TEXT_PROPERTIES = /^(text|html|heading|paragraph\d*|caption|bigtext|smalltext|linktext|tagtext|title|description)$/i;
const IMAGE_PROPERTIES = /^(image|tallimage|categoryimage|imageurl|src|source)$/i;
const LOCALES = ['da-DK', 'de-DE', 'en-GB', 'fi-FI', 'nb-NO', 'nl-NL', 'sv-SE'];
const COLLECTION_BASE_HEADERS = ['ID', 'Command', 'Body HTML'];

function key(categoryId, culture) { return `${clean(categoryId)}\0${clean(culture)}`; }
function slug(value) {
    return clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'component';
}
function isHttpUrl(value) {
    try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function propertyHtml(item) {
    const name = clean(item.propertyName).toLowerCase();
    const value = clean(item.value);
    if (!value || !TEXT_PROPERTIES.test(name)) return '';
    if (name === 'html' || name === 'text') return value;
    if (name === 'heading' || name === 'title') return `<h2>${escapeHtml(value)}</h2>`;
    if (/^paragraph/.test(name)) return `<p>${escapeHtml(value)}</p>`;
    return `<p>${escapeHtml(value)}</p>`;
}
function firstTextItem(cmsContent) {
    return (cmsContent?.components || [])
        .flatMap(component => component.items.map(item => ({ component, item })))
        .filter(({ item }) => clean(item.propertyName).toLowerCase() === 'text' && clean(item.value))
        .map(({ component, item }) => ({ ...item, component }))[0] || null;
}
function isDescriptionProperty(_component, item, descriptionItem = null) {
    return Boolean(descriptionItem && item.sourceRow === descriptionItem.sourceRow);
}
function componentLabel(component) {
    return clean(component.itemName || component.componentName || component.componentType || 'component');
}
function componentPropertyLayout(component) {
    const names = (component.items || []).map(item => clean(item.propertyName).toLowerCase()).filter(Boolean);
    const has = pattern => names.some(name => pattern.test(name));
    const hasImage = (component.items || []).some(item => clean(item.propertyType).toLowerCase() === 'image') ||
        has(/^(image|categoryimage|imageurl|src|source|tallimage)$/);
    const hasHeading = has(/^(heading|title|minititle)$/);
    const hasText = has(/^(text|html|content|description|caption|bigtext|smalltext|paragraph\d*)$/);
    const hasLink = has(/^(link|url|href|linktext|linkurl|linklabel|label)$/);
    const hasCollection = has(/^catid[a-z]{2}$/) || has(/^category$/);
    const hasProduct = has(/^product(item|category)?$/);
    const hasVideo = has(/^video(id|type)?$/);
    const hasOverlay = has(/^(applyimageoverlay|textappearonimage|textbgcolor)$/);
    const hasImageLayout = has(/^(imageplacement|imageratio|imagefocus)$/);
    const hasLinkStyle = has(/^(linkappearance|linksastext|renderasbuttons|rendervertically)$/);

    if (hasVideo) return 'video';
    if (hasProduct) return hasLink ? 'product_links' : 'product';
    if (hasCollection && hasImage && hasHeading && hasText) return 'collection_card';
    if (hasImage && hasHeading && hasText) return `image_heading_text${hasOverlay ? '_overlay' : ''}`;
    if (hasImage && hasText && hasLink) return `image_text_link${hasOverlay ? '_overlay' : ''}`;
    if (hasImage && hasHeading && hasLink) return 'image_heading_link';
    if (hasHeading && hasText) return `heading_text${hasOverlay ? '_overlay' : ''}`;
    if (hasImage && hasLink) return 'image_link';
    if (hasImage && hasHeading) return 'image_heading';
    if (hasImage) return hasImageLayout ? 'image_section' : 'image';
    if (hasHeading && hasLink) return 'heading_link';
    if (hasHeading) return 'heading';
    if (hasText) return 'text_block';
    if (hasLink) return hasLinkStyle ? 'link_group' : 'link';
    if (has(/^themename$/)) return 'theme';
    if (hasImageLayout || has(/^layout$/)) return 'image_section';
    if (hasLinkStyle) return 'link_group';
    return 'other';
}
function collectionDescription(category, cmsContent) {
    const cmsText = clean(firstTextItem(cmsContent)?.value);
    if (cmsText) return cmsText;
    return clean(category.source.content || category.source.Content || category.source.text || category.source.Text || '');
}
function componentKeys(components) {
    return components.map((component, index) => ({
        ...component,
        sectionNumber: index + 1,
        metafieldKey: `section_${index + 1}`,
    }));
}
function semanticComponentKeys(components) {
    return components.map(component => {
        const layoutType = componentPropertyLayout(component);
        const normalized = slug(`layout_${layoutType}`);
        const metafieldKey = normalized.length <= 43 ? normalized :
            `${normalized.slice(0, 34).replace(/_+$/g, '')}_${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8)}`;
        return { ...component, layoutType, metafieldKey };
    });
}
function semanticTextFields(component, descriptionItem = null) {
    const fields = sectionTextFields(component, descriptionItem);
    const heading = fields.find(field => field.key === `${component.metafieldKey}_header`);
    const text = fields.find(field => field.key === `${component.metafieldKey}_text`);
    if (heading && text) {
        const combined = {
            ...heading,
            key: `${component.metafieldKey}_content`,
            value: [heading.value, text.value].filter(Boolean).join('\n'),
            sourceRows: [...(heading.sourceRows || []), ...(text.sourceRows || [])],
            sourceProperties: [...(heading.sourceProperties || []), ...(text.sourceProperties || [])],
        };
        return fields.filter(field => field !== heading && field !== text)
            .concat(combined)
            .map(field => field.type === 'single_line_text_field'
                ? { ...field, key: `${component.metafieldKey}_links`, type: 'list.single_line_text_field', value: JSON.stringify([field.value]) }
                : field);
    }
    return fields.map(field => field.type === 'single_line_text_field'
        ? { ...field, key: `${component.metafieldKey}_links`, type: 'list.single_line_text_field', value: JSON.stringify([field.value]) }
        : field);
}
function combineMetafieldFields(fields) {
    const grouped = new Map();
    for (const field of fields) {
        if (!grouped.has(field.key)) grouped.set(field.key, { ...field });
        else {
            const current = grouped.get(field.key);
            if (current.type !== field.type) throw new Error(`Conflicting metafield types for custom.${field.key}.`);
            if (field.type === 'rich_text_field') current.value = [current.value, field.value].filter(Boolean).join('\n');
            else if (field.type.startsWith('list.')) {
                const values = value => {
                    try { return JSON.parse(value); } catch { return [value]; }
                };
                current.value = JSON.stringify([...new Set([...values(current.value), ...values(field.value)])]);
            } else if (current.value !== field.value) {
                throw new Error(`Repeated custom.${field.key} values must use a list field.`);
            }
            current.sourceRows = [...(current.sourceRows || []), ...(field.sourceRows || [])];
            current.sourceProperties = [...(current.sourceProperties || []), ...(field.sourceProperties || [])];
        }
    }
    return [...grouped.values()];
}
function sectionTextFields(component, descriptionItem = null) {
    const aliases = new Map([
        ['heading', 'header'], ['header', 'header'], ['title', 'header'],
        ['text', 'text'], ['paragraph', 'text'], ['paragraph1', 'text'],
        ['caption', 'text'], ['bigtext', 'text'], ['smalltext', 'text'],
        ['linktext', 'linktext'], ['tagtext', 'tagtext'],
    ]);
    const groups = new Map();
    for (const item of component.items) {
        if (isDescriptionProperty(component, item, descriptionItem)) continue;
        const property = clean(item.propertyName).toLowerCase();
        const field = aliases.get(property) || (/^paragraph\d+$/.test(property) ? 'text' : '');
        if (!field || !propertyHtml(item)) continue;
        if (!groups.has(field)) groups.set(field, []);
        groups.get(field).push(item);
    }
    const textFields = [...groups].map(([field, items]) => ({
        key: `${component.metafieldKey}_${field}`,
        type: 'rich_text_field',
        value: items.map(propertyHtml).join('\n'),
        componentName: componentLabel(component),
        componentOrder: component.order,
        sourceRows: items.map(item => item.sourceRow),
        sourceProperties: items.map(item => item.propertyName),
    }));
    const links = component.items.filter(item =>
        !isDescriptionProperty(component, item, descriptionItem) &&
        /^(link|url|href)$/i.test(clean(item.propertyName)) && clean(item.value));
    if (links.length) textFields.push({
        key: `${component.metafieldKey}_links`, type: 'list.single_line_text_field',
        value: JSON.stringify([...new Set(links.map(item => clean(item.value)))]), componentName: componentLabel(component),
        componentOrder: component.order, sourceRows: links.map(item => item.sourceRow),
        sourceProperties: links.map(item => item.propertyName),
    });
    return textFields;
}
function readCollectionRows(file) {
    const workbook = XLSX.readFile(file);
    const name = workbook.SheetNames.find(sheet => sheet.toLowerCase() === 'collections');
    if (!name) throw new Error('Shopify export must contain a Collections sheet.');
    return XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: '' }).filter(row =>
        row['Top Row'] === true || String(row['Top Row']).toLowerCase() === 'true'
    );
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function loadApprovals(file) {
    if (!file) return [];
    const raw = readJson(file);
    return Array.isArray(raw) ? raw : (raw.mappings || raw.approvals || raw.review || []);
}
function approvedLookup(rows) {
    const groups = new Map();
    for (const row of rows) {
        const categoryId = clean(row.categoryId ?? row.CategoryID);
        const culture = clean(row.culture ?? row.Culture);
        const shopifyId = clean(row.shopifyId ?? row.ShopifyID ?? row.CandidateShopifyID);
        const approved = row.approved === true || row.Approved === true ||
            /^(approved|yes|true)$/i.test(clean(row.ManualApproval ?? row.ApprovalStatus));
        if (!categoryId || !culture || !approved || !shopifyId) continue;
        const k = key(categoryId, culture);
        if (!groups.has(k)) groups.set(k, new Set());
        groups.get(k).add(shopifyId);
    }
    return groups;
}
function componentCategoryIds(component, culture = 'sv-SE') {
    return [...new Set(component.items
        .filter(item => /^catId[a-z]{2}$/i.test(clean(item.propertyName)))
        // Localized cells are alternate values for the same catIdXX field,
        // not separate market assignments. Use the canonical Swedish value.
        .map(item => item.cultureValues?.[culture] ?? item.value)
        .flatMap(value => clean(value).split(/[;,|]/).map(part => clean(part)).filter(Boolean)))].sort();
}
function collectionReferenceKey(component) {
    const fullKey = `${component.metafieldKey}_collection`;
    if (fullKey.length <= 64) return fullKey;
    const hash = crypto.createHash('sha256').update(fullKey).digest('hex').slice(0, 8);
    return `norce_${slug(componentLabel(component)).slice(0, 36)}_${hash}_collection`;
}
function semanticCollectionReferenceKey(component) {
    return `${component.metafieldKey}_related_collections`;
}
function buildCategoryReferenceLookup(approvals, collections) {
    const approvedIdsByCategory = new Map();
    const rowsById = new Map();
    const rowCountsById = new Map();
    for (const row of collections) {
        const id = clean(row.ID);
        if (!id) continue;
        rowsById.set(id, row);
        rowCountsById.set(id, (rowCountsById.get(id) || 0) + 1);
    }
    for (const [approvalKey, ids] of approvals) {
        const categoryId = approvalKey.split('\0')[0];
        if (!approvedIdsByCategory.has(categoryId)) approvedIdsByCategory.set(categoryId, new Set());
        for (const id of ids) approvedIdsByCategory.get(categoryId).add(id);
    }
    const lookup = new Map();
    for (const [categoryId, ids] of approvedIdsByCategory) {
        if (ids.size !== 1) {
            lookup.set(categoryId, { status: 'ambiguous approved Shopify collection mapping', shopifyIds: [...ids].sort() });
            continue;
        }
        const shopifyId = [...ids][0];
        const collection = rowsById.get(shopifyId);
        if (!collection || rowCountsById.get(shopifyId) !== 1) {
            lookup.set(categoryId, { status: collection ? 'duplicate Shopify collection ID in export' : 'approved Shopify collection missing from export', shopifyId });
            continue;
        }
        const handle = clean(collection.Handle);
        lookup.set(categoryId, handle
            ? { status: 'resolved', shopifyId, handle }
            : { status: 'Shopify collection handle missing', shopifyId });
    }
    return lookup;
}
function resolveCategoryReference(categoryIds, lookup) {
    if (!categoryIds.length) return { status: 'no market category assignment in CMS export' };
    if (categoryIds.length > 1) return { status: 'multiple market category IDs; manual review required', categoryIds };
    const categoryId = categoryIds[0];
    const target = lookup.get(categoryId);
    return target
        ? { ...target, categoryId }
        : { status: 'no approved Shopify collection mapping for target category', categoryId };
}
function approveUrlCandidates(review) {
    return (review?.mappings || []).filter(row => row.Status === 'URL candidate - manual approval required')
        .filter(row => clean(row.ShopifyID))
        .map(row => ({ CategoryID: row.CategoryID, Culture: row.Culture, ShopifyID: row.ShopifyID, ManualApproval: 'Approved' }));
}
function contentMapLookup(input) {
    const raw = typeof input === 'string' ? readJson(input) : input;
    const entries = normalizeContentMap(raw);
    const groups = new Map();
    for (const item of entries) {
        const k = key(item.categoryId, item.culture);
        if (!groups.has(k)) groups.set(k, new Set());
        if (item.contentId) groups.get(k).add(item.contentId);
    }
    return groups;
}
function buildPlan({ categoryData, collections, contentMap, cms, approvals }) {
    const collectionById = new Map();
    const collectionIdCounts = new Map();
    for (const row of collections) {
        const id = clean(row.ID);
        if (!id) continue;
        collectionIdCounts.set(id, (collectionIdCounts.get(id) || 0) + 1);
        collectionById.set(id, row);
    }
    const categoryReferenceLookup = buildCategoryReferenceLookup(approvals, collections);
    const cmsByKey = new Map(cms.contents.map(item => [key(item.contentId, item.culture), item]));
    const categoriesById = new Map();
    for (const category of categoryData.categories) {
        if (!categoriesById.has(category.categoryId)) categoriesById.set(category.categoryId, []);
        categoriesById.get(category.categoryId).push(category);
    }
    const mapIdsByCategory = new Map();
    const approvedTargetCategories = new Map();
    for (const [approvalKey, ids] of approvals) if (ids.size === 1) {
        const id = [...ids][0];
        const categoryId = approvalKey.split('\0')[0];
        if (!approvedTargetCategories.has(id)) approvedTargetCategories.set(id, new Set());
        approvedTargetCategories.get(id).add(categoryId);
    }
    for (const category of categoryData.categories) {
        const ids = contentMap.get(key(category.categoryId, category.culture));
        if (ids?.size) mapIdsByCategory.set(key(category.categoryId, category.culture), ids);
    }

    const review = [];
    const prepared = [];
    const mapConflicts = [];
    const unresolvedCategoryReferences = [];
    for (const category of categoryData.categories) {
        const categoryKey = key(category.categoryId, category.culture);
        let contentIds = mapIdsByCategory.get(categoryKey);
        let contentIdCulture = category.culture;
        // StoreAPI map is currently Swedish-only. A unique sv-SE ContentId is
        // stable per category and is used to obtain the matching CMS locale.
        if (!contentIds && category.culture !== 'sv-SE') {
            contentIds = mapIdsByCategory.get(key(category.categoryId, 'sv-SE'));
            if (contentIds?.size === 1) contentIdCulture = 'sv-SE';
        }
        const contentId = contentIds?.size === 1 ? [...contentIds][0] : '';
        const approvalIds = approvals.get(categoryKey);
        const approvedId = approvalIds?.size === 1 ? [...approvalIds][0] : '';
        const collection = approvedId ? collectionById.get(approvedId) : null;
        const cmsContent = contentId ? cmsByKey.get(key(contentId, category.culture)) : null;
        let status = 'unapproved collection match';
        if (contentIds?.size > 1) status = 'ambiguous contentId mapping';
        else if (!contentId) status = 'missing contentId mapping';
        else if (!cmsContent) status = 'CMS content not found for locale';
        else if (!approvalIds) status = 'unapproved collection match';
        else if (approvalIds.size !== 1) status = 'ambiguous approved collection mapping';
        else if (!collection) status = 'approved Shopify ID not found';
        else if (collectionIdCounts.get(approvedId) !== 1) status = 'duplicate Shopify ID in export';
        else if (approvedTargetCategories.get(approvedId)?.size !== 1) status = 'duplicate approved target across categories';
        else status = 'ready';

        const description = collectionDescription(category, cmsContent);
        review.push({
            CategoryID: category.categoryId, Culture: category.culture,
            ContentId: contentId || '', ContentIdSourceCulture: contentIdCulture,
            CMSFound: Boolean(cmsContent), ShopifyID: approvedId || '',
            ShopifyHandle: collection?.Handle || '', Status: status,
            DescriptionPresent: Boolean(description),
        });
        if (status !== 'ready') continue;
        const components = componentKeys(cmsContent.components);
        const descriptionItem = firstTextItem(cmsContent);
        const metafields = [];
        const images = [];
        for (const component of components) {
            metafields.push(...sectionTextFields(component, descriptionItem));
            const targetCategoryIds = componentCategoryIds(component);
            const categoryReference = resolveCategoryReference(targetCategoryIds, categoryReferenceLookup);
            if (categoryReference.status === 'resolved') {
                metafields.push({
                    key: collectionReferenceKey(component), type: 'collection_reference', value: categoryReference.handle,
                    componentName: componentLabel(component), componentOrder: component.order,
                    sourceRows: component.items.filter(item => /^catId[a-z]{2}$/i.test(clean(item.propertyName)) &&
                        clean(item.cultureValues?.['sv-SE'] ?? item.value))
                        .map(item => item.sourceRow),
                    sourceCategoryIds: targetCategoryIds, targetShopifyId: categoryReference.shopifyId,
                    targetHandle: categoryReference.handle,
                });
            } else if (targetCategoryIds.length) {
                unresolvedCategoryReferences.push({
                    categoryId: category.categoryId, culture: category.culture, contentId,
                    component: componentLabel(component), componentOrder: component.order,
                    sourceCategoryIds: targetCategoryIds, status: categoryReference.status,
                });
            }
            const urls = component.items.filter(item => IMAGE_PROPERTIES.test(clean(item.propertyName)) && isHttpUrl(clean(item.value)));
            const uniqueUrls = [...new Set(urls.map(item => clean(item.value)))];
            if (uniqueUrls.length) images.push({
                key: `${component.metafieldKey}_image`, type: 'list.file_reference', urls: uniqueUrls,
                componentName: componentLabel(component), componentOrder: component.order,
                sourceRows: urls.map(item => item.sourceRow),
            });
        }
        const unresolvedImages = components.flatMap(component => component.items
            .filter(item => IMAGE_PROPERTIES.test(clean(item.propertyName)) && clean(item.value))
            .filter(item => !isHttpUrl(clean(item.value)))
            .map(item => ({ categoryId: category.categoryId, culture: category.culture,
                contentId, componentName: componentLabel(component), property: item.propertyName,
                sourceRow: item.sourceRow, reason: 'image value is not a direct HTTP(S) URL' })));
        const imageComponentsMissingSource = components.filter(component =>
            /image|picture/i.test(component.componentType) &&
            !component.items.some(item => IMAGE_PROPERTIES.test(clean(item.propertyName)) && isHttpUrl(clean(item.value)))
        ).map(component => ({ categoryId: category.categoryId, culture: category.culture,
            contentId, componentName: componentLabel(component), sourceRow: component.sourceOrder,
            reason: 'CMS image component has no directly resolvable image URL' }));
        prepared.push({ category, collection, contentId, cmsContent, description, metafields, images,
            unresolvedImages, imageComponentsMissingSource });
    }
    return { review, prepared, mapConflicts, categoryReferenceLookup, unresolvedCategoryReferences };
}

function isStoreApiImageProperty(item) {
    return clean(item.propertyType).toLowerCase() === 'image' || IMAGE_PROPERTIES.test(clean(item.propertyName));
}

function sectionImageFields(components) {
    const byPath = new Map(components
        .filter(component => component.hierarchyPath?.length)
        .map(component => [component.hierarchyPath.join('.'), component]));
    const groups = new Map();
    for (const component of components) {
        const imageItems = component.items.filter(item =>
            isStoreApiImageProperty(item) && isHttpUrl(clean(item.value)));
        if (!imageItems.length) continue;
        const parentPath = (component.hierarchyPath || []).slice(0, -1).join('.');
        const section = parentPath ? byPath.get(parentPath) || component : component;
        if (!groups.has(section.metafieldKey)) groups.set(section.metafieldKey, {
            key: `${section.metafieldKey}_images`, type: 'list.file_reference', urls: [],
            layoutType: section.layoutType,
            componentName: componentLabel(section), componentOrder: section.order,
            hierarchyPath: section.hierarchyPath || [], sourceRows: [], sourceProperties: [],
            sourceComponents: [],
        });
        const field = groups.get(section.metafieldKey);
        field.urls.push(...imageItems.map(item => clean(item.value)));
        field.sourceRows.push(...imageItems.map(item => item.sourceRow));
        field.sourceProperties.push(...imageItems.map(item => item.propertyName));
        field.sourceComponents.push(componentLabel(component));
    }
    return [...groups.values()].map(field => ({
        ...field,
        urls: [...new Set(field.urls)],
        sourceComponents: [...new Set(field.sourceComponents)],
    }));
}

function snapshotDescription(category) {
    return clean(category?.source?.text ?? category?.source?.Text ?? '');
}

function buildStoreApiArtifacts({ categoryData, collections, snapshot, cms, approvals, exceptions = [], excludedHandles = new Set(), excludedHandlePrefixes = [] }) {
    const snapshots = categoryLookup(snapshot);
    const cmsByKey = new Map((cms?.contents || []).map(item => [key(item.contentId, item.culture), item]));
    const collectionById = new Map();
    const collectionIdCounts = new Map();
    for (const row of collections) {
        const id = clean(row.ID);
        if (!id) continue;
        collectionIdCounts.set(id, (collectionIdCounts.get(id) || 0) + 1);
        collectionById.set(id, row);
    }
    const approvalsByCategory = new Map();
    const approvedTargetCategories = new Map();
    for (const [approvalKey, ids] of approvals) {
        const [categoryId, culture] = approvalKey.split('\0');
        if (ids.size === 1) {
            const id = [...ids][0];
            if (!approvedTargetCategories.has(id)) approvedTargetCategories.set(id, new Set());
            approvedTargetCategories.get(id).add(categoryId);
        }
        approvalsByCategory.set(`${categoryId}\0${culture}`, ids);
    }
    const categoryReferenceLookup = buildCategoryReferenceLookup(approvals, collections);
    const review = [];
    const prepared = [];
    const unresolvedCategoryReferences = [];
    const unresolvedImages = [];
    const missingImageSources = [];
    const csvComponents = [];
    const unmatchedExceptions = [];
    const localizedContent = new Map();
    const categoriesByKey = new Map(categoryData.categories.map(category => [
        key(category.categoryId, category.culture), category,
    ]));

    for (const category of categoryData.categories) {
        const categoryId = clean(category.categoryId);
        const culture = clean(category.culture);
        const k = key(categoryId, culture);
        const record = snapshots.get(k);
        const categoryNode = record?.category || null;
        const apiComponents = record?.status === 'fetched' && categoryNode
            ? normalizeStoreApiComponents(categoryNode) : [];
        const contentId = clean(record?.contentId || categoryNode?.data?.id);
        const cmsContent = contentId ? cmsByKey.get(key(contentId, culture)) : null;
        const reconciliation = record?.status === 'fetched'
            ? reconcileCsvComponents({ categoryId, culture, contentId, apiComponents, cmsContent, exceptions })
            : { missingFromApi: [], approvedExceptions: [], unmatchedApprovals: [] };
        csvComponents.push(...reconciliation.missingFromApi);
        unmatchedExceptions.push(...reconciliation.unmatchedApprovals);
        const components = semanticComponentKeys([
            ...apiComponents,
            ...reconciliation.approvedExceptions,
        ]);
        const approvalIds = approvalsByCategory.get(k);
        const approvedId = approvalIds?.size === 1 ? [...approvalIds][0] : '';
        const collection = approvedId ? collectionById.get(approvedId) : null;
        const descriptionItem = firstTextItem({ components });
        const description = clean(descriptionItem?.value) || snapshotDescription(category);
        if (record?.status === 'fetched' && categoryNode) localizedContent.set(k, {
            category, contentId, storeApiRecord: record, description, components, descriptionItem,
        });

        let status;
        if (!record) status = 'missing StoreAPI snapshot';
        else if (record.status !== 'fetched' || !categoryNode) status = `StoreAPI ${record.status || 'response missing'}`;
        else if (clean(categoryNode.id) && clean(categoryNode.id) !== categoryId) status = 'StoreAPI category ID mismatch';
        else if (!approvalIds) status = 'unapproved collection match';
        else if (approvalIds.size !== 1) status = 'ambiguous approved collection mapping';
        else if (!collection) status = 'approved Shopify ID not found';
        else if (collectionIdCounts.get(approvedId) !== 1) status = 'duplicate Shopify ID in export';
        else if (approvedTargetCategories.get(approvedId)?.size !== 1) status = 'duplicate approved target across categories';
        else status = 'ready';

        review.push({
            CategoryID: categoryId, Culture: culture, StoreAPIStatus: record?.status || 'missing snapshot',
            StoreAPIRetrievedAt: record?.retrievedAt || '', ContentId: contentId,
            StoreAPIError: record?.error || '',
            StoreAPIComponentCount: apiComponents.length,
            CSVComponentCount: cmsContent?.components?.length ?? null,
            CSVOnlyComponentCount: reconciliation.missingFromApi.length,
            ApprovedCSVExceptionCount: reconciliation.approvedExceptions.length,
            ShopifyID: approvedId, ShopifyHandle: collection?.Handle || '',
            Status: status, DescriptionPresent: Boolean(description),
        });
        if (status !== 'ready') continue;

        const metafields = [];
        const images = sectionImageFields(components);
        for (const component of components) {
            metafields.push(...semanticTextFields(component, descriptionItem));
            const targetCategoryIds = componentCategoryIds(component);
            const categoryReference = resolveCategoryReference(targetCategoryIds, categoryReferenceLookup);
            if (categoryReference.status === 'resolved') metafields.push({
                key: semanticCollectionReferenceKey(component), type: 'list.collection_reference',
                value: JSON.stringify([categoryReference.handle]),
                componentName: componentLabel(component), componentOrder: component.order,
                hierarchyPath: component.hierarchyPath || [], sourceCategoryIds: targetCategoryIds,
                targetShopifyId: categoryReference.shopifyId, targetHandle: categoryReference.handle,
            });
            else if (targetCategoryIds.length) unresolvedCategoryReferences.push({
                categoryId, culture, contentId, component: componentLabel(component),
                hierarchyPath: component.hierarchyPath || [], sourceCategoryIds: targetCategoryIds,
                status: categoryReference.status,
            });

            for (const item of component.items.filter(property => isStoreApiImageProperty(property) && clean(property.value) && !isHttpUrl(clean(property.value)))) {
                unresolvedImages.push({ CategoryID: categoryId, Culture: culture, ContentId: contentId,
                    Component: componentLabel(component), Property: item.propertyName,
                    Value: clean(item.value), Reason: 'StoreAPI image property is not a direct HTTP(S) URL' });
            }
            const resolvableImageItems = component.items.filter(item =>
                isStoreApiImageProperty(item) && isHttpUrl(clean(item.value)));
            if (component.items.some(isStoreApiImageProperty) && !resolvableImageItems.length) missingImageSources.push({
                CategoryID: categoryId, Culture: culture, ContentId: contentId,
                Component: componentLabel(component), HierarchyPath: component.hierarchyPath,
                Reason: 'StoreAPI component has image properties but no resolvable direct URL',
            });
        }
        prepared.push({ category, collection, contentId, storeApiRecord: record, components,
            description, descriptionItem, metafields: combineMetafieldFields(metafields), images, csvContent: cmsContent });
    }

    const importable = prepared.filter(item => item.category.culture === 'sv-SE' &&
        !excludedHandles.has(clean(item.collection.Handle).toLowerCase()) &&
        !excludedHandlePrefixes.some(prefix => clean(item.collection.Handle).toLowerCase().startsWith(prefix)) &&
        (item.description || item.metafields.length || item.images.length));
    const translationData = new Map(LOCALES.filter(locale => locale !== 'sv-SE').map(locale => [locale, []]));
    const translationDiagnostics = [];
    for (const base of importable) {
        const handle = clean(base.collection.Handle);
        const baseKeys = new Set(base.metafields.map(field => field.key));
        for (const locale of LOCALES.filter(value => value !== 'sv-SE')) {
            const localized = localizedContent.get(key(base.category.categoryId, locale));
            const localeCategory = categoriesByKey.get(key(base.category.categoryId, locale));
            const localizedCsv = base.contentId ? cmsByKey.get(key(base.contentId, locale)) : null;
            const translationColumn = `Translation Value: ${locale.slice(0, 2)}`;
            const rows = translationData.get(locale);
            // Prefer a successful localized StoreAPI snapshot. If that market
            // channel is unavailable, use the CSV as a translation source only
            // for components already confirmed by the Swedish publication snapshot.
            const localizedComponents = localized?.storeApiRecord.status === 'fetched'
                ? localized.components
                : localizedCsv ? componentKeys(localizedCsv.components) : [];
            let localizedDescription = '';
            if (base.descriptionItem && base.descriptionItem.component) {
                const descriptionIdentity = `${componentIdentity(base.descriptionItem.component)}\0${clean(base.descriptionItem.component.componentType).toLowerCase()}`;
                const localizedDescriptionComponent = localizedComponents.find(component =>
                    `${componentIdentity(component)}\0${clean(component.componentType).toLowerCase()}` === descriptionIdentity);
                localizedDescription = clean(localizedDescriptionComponent?.items
                    .find(item => clean(item.propertyName).toLowerCase() === 'text' && clean(item.value))?.value);
            }
            localizedDescription ||= snapshotDescription(localeCategory);
            if (base.description && localizedDescription) rows.push({ Entity: 'Collection', 'Entity Handle': handle,
                Field: 'Body HTML', [translationColumn]: localizedDescription });
            const localizedQueues = new Map();
            for (const component of localizedComponents) {
                const identity = `${componentIdentity(component)}\0${clean(component.componentType).toLowerCase()}`;
                if (!localizedQueues.has(identity)) localizedQueues.set(identity, []);
                localizedQueues.get(identity).push(component);
            }
            const localizedMetafieldFields = [];
            for (const baseComponent of base.components) {
                const identity = `${componentIdentity(baseComponent)}\0${clean(baseComponent.componentType).toLowerCase()}`;
                const localizedComponent = localizedQueues.get(identity)?.shift();
                const baseFields = semanticTextFields(baseComponent, base.descriptionItem);
                if (!localizedComponent) {
                    if (baseFields.some(field => baseKeys.has(field.key))) translationDiagnostics.push({
                        categoryId: base.category.categoryId, culture: locale,
                        component: componentLabel(baseComponent),
                        source: localizedCsv ? 'Norce CSV' : 'none',
                        status: localized ? 'localized component not returned by StoreAPI' : 'localized translation not found',
                    });
                    continue;
                }
                const localizedDescriptionItem = base.descriptionItem?.component &&
                    componentIdentity(localizedComponent) === componentIdentity(base.descriptionItem.component)
                    ? firstTextItem({ components: [localizedComponent] }) : null;
                localizedMetafieldFields.push(...semanticTextFields({ ...localizedComponent,
                    metafieldKey: baseComponent.metafieldKey }, localizedDescriptionItem));
            }
            for (const field of combineMetafieldFields(localizedMetafieldFields)) {
                if (!baseKeys.has(field.key) || field.type.startsWith('list.')) continue;
                rows.push({ Entity: 'Collection', 'Entity Handle': handle,
                    Field: `Metafield: custom.${field.key}`, [translationColumn]: field.value });
            }
        }
    }

    const mapRows = [];
    const textAssignmentReview = [];
    for (const item of prepared) {
        for (const component of item.components) {
            for (const field of semanticTextFields(component, item.descriptionItem)) mapRows.push({
                CategoryID: item.category.categoryId, Culture: item.category.culture,
                ContentId: item.contentId, StoreAPIRetrievedAt: item.storeApiRecord.retrievedAt,
                Component: componentLabel(component), ComponentType: component.componentType,
                LayoutType: component.layoutType,
                ComponentOrder: component.order, HierarchyPath: (component.hierarchyPath || []).join('.'),
                Namespace: 'custom', Key: field.key, Type: field.type,
                SourceProperties: field.sourceProperties.join(','), Status: 'from_storeapi',
            });
            const targetCategoryIds = componentCategoryIds(component);
            const categoryReference = resolveCategoryReference(targetCategoryIds, categoryReferenceLookup);
            if (targetCategoryIds.length) mapRows.push({
                CategoryID: item.category.categoryId, Culture: item.category.culture,
                ContentId: item.contentId, StoreAPIRetrievedAt: item.storeApiRecord.retrievedAt,
                Component: componentLabel(component), ComponentType: component.componentType,
                LayoutType: component.layoutType,
                ComponentOrder: component.order, HierarchyPath: (component.hierarchyPath || []).join('.'),
                Namespace: 'custom', Key: semanticCollectionReferenceKey(component),
                Type: categoryReference.status === 'resolved' ? 'list.collection_reference' : '',
                SourceCategoryIDs: targetCategoryIds.join(','), ShopifyTargetHandle: categoryReference.handle || '',
                ReferenceStatus: categoryReference.status, Status: 'from_storeapi',
            });
        }
        for (const image of item.images) mapRows.push({
                CategoryID: item.category.categoryId, Culture: item.category.culture,
                ContentId: item.contentId, StoreAPIRetrievedAt: item.storeApiRecord.retrievedAt,
                Component: image.componentName, ComponentOrder: image.componentOrder,
                LayoutType: image.layoutType,
                HierarchyPath: image.hierarchyPath.join('.'), Namespace: 'custom', Key: image.key,
                Type: image.type, SourceRows: image.sourceRows.join(','),
                SourceProperties: image.sourceProperties.join(','), SourceComponents: image.sourceComponents.join(','),
                ImageCount: image.urls.length, Status: 'from_storeapi',
            });
        for (const component of item.components) {
            const textItems = component.items.filter(value => TEXT_PROPERTIES.test(clean(value.propertyName)) &&
                clean(value.value) && !isDescriptionProperty(component, value, item.descriptionItem));
            if (textItems.length) textAssignmentReview.push({
                CategoryID: item.category.categoryId, Culture: item.category.culture,
                ContentId: item.contentId, StoreAPIRetrievedAt: item.storeApiRecord.retrievedAt,
                Component: componentLabel(component), ComponentType: component.componentType,
                LayoutType: component.layoutType,
                ComponentOrder: component.order, HierarchyPath: (component.hierarchyPath || []).join('.'),
                'StoreAPI CMS text content': textItems.map(value => `${value.propertyName}: ${clean(value.value)}`).join('\n'),
                'Import source': component.exceptionApproval ? 'approved CSV exception' : 'StoreAPI published snapshot',
            });
        }
    }
    const consolidatedMapRows = new Map();
    for (const row of mapRows) {
        const identity = [row.CategoryID, row.Culture, row.ShopifyID, row.Key, row.Type].join('\0');
        if (!consolidatedMapRows.has(identity)) {
            consolidatedMapRows.set(identity, { ...row });
            continue;
        }
        const current = consolidatedMapRows.get(identity);
        for (const field of ['Component', 'ComponentOrder', 'HierarchyPath', 'SourceRows', 'SourceProperties', 'SourceComponents', 'SourceCategoryIDs']) {
            const values = [...new Set([...(String(current[field] || '')).split(',').filter(Boolean), ...(String(row[field] || '')).split(',').filter(Boolean)])];
            if (values.length) current[field] = values.join(',');
        }
        if (row.ImageCount) current.ImageCount = (current.ImageCount || 0) + row.ImageCount;
    }
    return {
        review, prepared, importable, translationData, mapRows: [...consolidatedMapRows.values()], textAssignmentReview,
        unresolvedCategoryReferences, unresolvedImages, missingImageSources,
        csvComponents, unmatchedExceptions, translationDiagnostics,
        snapshotDiagnostics: {
            fileFormat: snapshot.fileFormat || '', generatedAt: snapshot.generatedAt || '',
            cultures: snapshot.cultures || [], requestedCount: snapshot.requestedCount ?? snapshot.records?.length ?? 0,
            fetchedCount: (snapshot.records || []).filter(record => record.status === 'fetched').length,
            failedCount: (snapshot.records || []).filter(record => record.status !== 'fetched').length,
            missingPairs: categoryData.categories.filter(category => !snapshots.has(key(category.categoryId, category.culture)))
                .map(category => ({ categoryId: category.categoryId, culture: category.culture })),
        },
    };
}

function imageFilename(url) {
    const parsed = new URL(url);
    const source = path.posix.basename(parsed.pathname) || 'image';
    const ext = path.posix.extname(source).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8) || '.img';
    const stem = slug(path.posix.basename(source, path.posix.extname(source))).slice(0, 45) || 'image';
    const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 10);
    return `${stem}-${hash}${ext}`;
}
function matrixifyRows(prepared, { includeBodyHtml = true } = {}) {
    // Matrixify's Collections sheet declares metafield namespace, key, and type
    // directly in each column header: Metafield: namespace.key [type].
    const allFields = prepared.flatMap(item => [
        ...item.metafields,
        ...item.images.map(field => ({ ...field, value: JSON.stringify(field.urls.map(imageFilename)) })),
    ]);
    const fieldTypes = new Map();
    for (const field of allFields) {
        if (fieldTypes.has(field.key) && fieldTypes.get(field.key) !== field.type) {
            throw new Error(`Conflicting Matrixify metafield types for custom.${field.key}.`);
        }
        fieldTypes.set(field.key, field.type);
    }
    const columnByKey = new Map([...fieldTypes].map(([keyName, type]) => [
        keyName, `Metafield: custom.${keyName} [${type}]`,
    ]));
    const headers = [
        'ID', 'Command', ...(includeBodyHtml ? ['Body HTML'] : []), ...columnByKey.values(),
    ];
    const rows = prepared.map(item => {
        const row = { ID: item.collection.ID, Command: 'UPDATE' };
        if (includeBodyHtml && item.description) row['Body HTML'] = item.description;
        for (const field of [
            ...item.metafields,
            ...item.images.map(image => ({ ...image, value: JSON.stringify(image.urls.map(imageFilename)) })),
        ]) row[columnByKey.get(field.key)] = field.value;
        return row;
    });
    return { headers, rows };
}
function writeWorkbook(file, sheetName, headers, rows) {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers, skipHeader: false });
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    XLSX.writeFile(workbook, file);
}
function csvCell(value) {
    const text = value == null ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
}
function writeCsv(file, headers, rows) {
    const lines = [headers, ...rows.map(row => headers.map(header => row[header] ?? ''))]
        .map(row => row.map(csvCell).join(','));
    fs.writeFileSync(file, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}
function makeTranslations(prepared, cmsByKey) {
    const rowsByLocale = new Map(LOCALES.filter(locale => locale !== 'sv-SE').map(locale => [locale, []]));
    for (const item of prepared) {
        const handle = clean(item.collection.Handle);
        if (!handle || !item.contentId) continue;
        for (const locale of LOCALES.filter(value => value !== 'sv-SE')) {
            const content = cmsByKey.get(key(item.contentId, locale));
            const category = item.category;
            if (category.culture !== 'sv-SE' || !content) continue;
            const translationColumn = `Translation Value: ${locale.slice(0, 2)}`;
            const localeRows = rowsByLocale.get(locale);
            const localizedCategory = item._categoryByLocale?.get(locale);
            const desc = collectionDescription(localizedCategory || item.category, content);
            if (item.description && desc) localeRows.push({ Entity: 'Collection', 'Entity Handle': handle, Field: 'Body HTML', [translationColumn]: desc });
            const baseKeys = new Set(item.metafields.map(field => field.key));
            const descriptionItem = firstTextItem(content);
            for (const component of componentKeys(content.components)) {
                for (const field of sectionTextFields(component, descriptionItem)) {
                    if (baseKeys.has(field.key)) localeRows.push({ Entity: 'Collection', 'Entity Handle': handle,
                        Field: `Metafield: custom.${field.key}`, [translationColumn]: field.value });
                }
            }
        }
    }
    return rowsByLocale;
}
function buildArtifacts({ categoryData, collections, contentMap, cms, approvals, matchingReview = null }) {
    const built = buildPlan({ categoryData, collections, contentMap, cms, approvals });
    const cmsByKey = new Map(cms.contents.map(item => [key(item.contentId, item.culture), item]));
    const categoriesById = new Map();
    const candidateByKey = new Map((matchingReview?.mappings || []).map(row => [key(row.CategoryID, row.Culture), row]));
    for (const row of built.review) {
        const candidate = candidateByKey.get(key(row.CategoryID, row.Culture));
        if (!candidate) continue;
        row.OriginalURL = candidate.OriginalURL;
        row.MatchReviewStatus = candidate.Status;
        row.CandidateShopifyID = candidate.ShopifyID;
        row.CandidateShopifyHandle = candidate.ShopifyHandle;
        row.CandidateShopifyTitle = candidate.ShopifyTitle;
        row.ManualApproval = candidate.ManualApproval || '';
    }
    for (const category of categoryData.categories) {
        if (!categoriesById.has(category.categoryId)) categoriesById.set(category.categoryId, new Map());
        categoriesById.get(category.categoryId).set(category.culture, category);
    }
    for (const item of built.prepared) {
        item._cmsByLocale = new Map(LOCALES.map(locale => [locale, cmsByKey.get(key(item.contentId, locale))]));
        item._categoryByLocale = categoriesById.get(item.category.categoryId) || new Map();
    }
    const importable = built.prepared.filter(item => item.category.culture === 'sv-SE' &&
        (item.description || item.metafields.length || item.images.length));
    const translationData = makeTranslations(importable, cmsByKey);
    const mapRows = [];
    const textAssignmentReview = [];
    const unresolvedImages = [];
    const missingImageSources = [];
    for (const row of built.review) {
        if (!row.ContentId || !row.CMSFound) continue;
        const content = cmsByKey.get(key(row.ContentId, row.Culture));
        if (!content) continue;
        const descriptionItem = firstTextItem(content);
        for (const component of componentKeys(content.components)) {
            for (const field of sectionTextFields(component, descriptionItem)) mapRows.push({
                CategoryID: row.CategoryID, Culture: row.Culture,
                ContentId: row.ContentId, ShopifyID: row.Status === 'ready' ? row.ShopifyID : '',
                ShopifyHandle: row.Status === 'ready' ? row.ShopifyHandle : '', Component: componentLabel(component),
                ComponentOrder: component.order, Namespace: 'custom', Key: field.key, Type: field.type,
                SourceRows: field.sourceRows.join(','), SourceProperties: field.sourceProperties.join(','), Status: row.Status,
            });
            const targetCategoryIds = componentCategoryIds(component);
            const categoryReference = resolveCategoryReference(targetCategoryIds, built.categoryReferenceLookup);
            if (targetCategoryIds.length) mapRows.push({ CategoryID: row.CategoryID, Culture: row.Culture,
                ContentId: row.ContentId, ShopifyID: row.Status === 'ready' ? row.ShopifyID : '',
                ShopifyHandle: row.Status === 'ready' ? row.ShopifyHandle : '', Component: componentLabel(component),
                ComponentOrder: component.order, Namespace: 'custom', Key: collectionReferenceKey(component),
                Type: categoryReference.status === 'resolved' ? 'collection_reference' : '',
                SourceRows: component.items.filter(item => /^catId[a-z]{2}$/i.test(clean(item.propertyName)) &&
                    clean(item.cultureValues?.['sv-SE'] ?? item.value))
                    .map(item => item.sourceRow).join(','),
                SourceCategoryIDs: targetCategoryIds.join(','),
                ShopifyTargetHandle: categoryReference.handle || '',
                ReferenceStatus: categoryReference.status,
                Status: row.Status });
            const reviewText = component.items.filter(item => TEXT_PROPERTIES.test(clean(item.propertyName)) && clean(item.value));
            if (reviewText.length) textAssignmentReview.push({
                CategoryID: row.CategoryID, Culture: row.Culture, ContentId: row.ContentId,
                OriginalURL: row.OriginalURL || '', ShopifyID: row.Status === 'ready' ? row.ShopifyID : '',
                ShopifyHandle: row.Status === 'ready' ? row.ShopifyHandle : '',
                Component: componentLabel(component), ComponentOrder: component.order,
                'CMS text content': reviewText.map(item => `${item.propertyName}: ${clean(item.value)}`).join('\n'),
                'Norce target category IDs': targetCategoryIds.join(','),
                'Norce assignment status': targetCategoryIds.length ? 'one or more catId market fields are populated' : 'no catId market assignment in export',
                'Shopify reference status': categoryReference.status,
                'Shopify target handle': categoryReference.handle || '',
                'Storefront display check': 'unverified: CMS export contains no publish/visibility status',
                'Collection import status': row.Status,
            });
            const imageItems = component.items.filter(item => IMAGE_PROPERTIES.test(clean(item.propertyName)) && isHttpUrl(clean(item.value)));
            const imageUrls = [...new Set(imageItems.map(item => clean(item.value)))];
            if (imageUrls.length) mapRows.push({ CategoryID: row.CategoryID, Culture: row.Culture,
                ContentId: row.ContentId, ShopifyID: row.Status === 'ready' ? row.ShopifyID : '',
                ShopifyHandle: row.Status === 'ready' ? row.ShopifyHandle : '', Component: componentLabel(component),
                ComponentOrder: component.order, Namespace: 'custom', Key: `${component.metafieldKey}_image`,
                Type: 'list.file_reference', SourceRows: imageItems.map(item => item.sourceRow).join(','), Status: row.Status });
            for (const image of component.items.filter(item => IMAGE_PROPERTIES.test(clean(item.propertyName)) && clean(item.value) && !isHttpUrl(clean(item.value)))) {
                unresolvedImages.push({ CategoryID: row.CategoryID, Culture: row.Culture, ContentId: row.ContentId,
                    Component: componentLabel(component), Property: image.propertyName, SourceRow: image.sourceRow,
                    Reason: 'image value is not a direct HTTP(S) URL' });
            }
            if (/image|picture/i.test(component.componentType) && !imageUrls.length) missingImageSources.push({
                CategoryID: row.CategoryID, Culture: row.Culture, ContentId: row.ContentId,
                Component: componentLabel(component), SourceRow: component.sourceOrder,
                Reason: 'CMS image component has no directly resolvable image URL',
            });
        }
    }
    return { ...built, importable, translationData, mapRows,
        textAssignmentReview,
        unresolvedImages,
        missingImageSources,
    };
}
function parseArgs(argv) {
    const args = {};
    for (const item of argv) {
        const match = item.match(/^--([^=]+)=(.*)$/);
        if (match) args[match[1]] = match[2];
        else if (item.startsWith('--')) args[item.slice(2)] = true;
    }
    return args;
}
function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log('Usage: npm run build:fyrklovern-collection-content -- --categories=<xlsx> --storeapi-snapshot=<json> --shopify=<xlsx> [--cms=<csv>] [--approved-map=<json>] [--component-exceptions=<json>] [--exclude-handles=<comma-separated-handles>] [--exclude-handle-prefixes=<comma-separated-prefixes>] [--output-dir=<dir>] [--overwrite]');
        console.log('Approval JSON: an array, {"mappings": [...]}, or this command\'s mapping_report.json. Set ManualApproval="Approved"; use ShopifyID or CandidateShopifyID as the target.');
        return null;
    }
    const required = ['categories', 'storeapi-snapshot', 'shopify'];
    const missing = required.filter(name => !args[name]);
    if (missing.length) throw new Error(`Usage: npm run build:fyrklovern-collection-content -- --categories=<xlsx> --storeapi-snapshot=<json> --shopify=<xlsx> [--cms=<csv>] [--approved-map=<json>] [--component-exceptions=<json>] [--output-dir=<dir>] (missing: ${missing.join(', ')})`);
    const categoryData = readCategoryWorkbook(path.resolve(args.categories));
    const snapshot = readJson(path.resolve(args['storeapi-snapshot']));
    if (!Array.isArray(snapshot.records)) throw new Error('StoreAPI snapshot must contain a records array.');
    const cmsPath = args.cms && args.cms !== 'none' ? path.resolve(args.cms) : null;
    const cmsCsv = cmsPath ? readCmsCsv(cmsPath) : null;
    const cms = cmsCsv ? normalizeCms(cmsCsv.records, cmsCsv.headers) : { contents: [] };
    const collections = readCollectionRows(path.resolve(args.shopify));
    const approvalRows = loadApprovals(args['approved-map'] ? path.resolve(args['approved-map']) : null);
    const exceptionRows = loadComponentExceptions(args['component-exceptions'] ? path.resolve(args['component-exceptions']) : null);
    const excludedHandles = new Set(String(args['exclude-handles'] || '').split(',')
        .map(handle => clean(handle).toLowerCase()).filter(Boolean));
    const excludedHandlePrefixes = String(args['exclude-handle-prefixes'] || '').split(',')
        .map(handle => clean(handle).toLowerCase()).filter(Boolean);
    const normalizedContentMap = snapshot.records.filter(record => record.contentId).map(record => ({
        categoryId: record.categoryId, culture: record.culture, contentId: record.contentId,
        source: `StoreAPI snapshot retrieved ${record.retrievedAt || 'at unknown time'}`,
    }));
    const effectiveApprovalRows = approvalRows;
    const approvals = approvedLookup(effectiveApprovalRows);
    const artifacts = buildStoreApiArtifacts({ categoryData, collections, snapshot, cms, approvals, exceptions: exceptionRows, excludedHandles, excludedHandlePrefixes });
    const outputDir = path.resolve(args['output-dir'] || 'outputs/Fyrklovern/Matrixify files/Collections/Content updates');
    const reportPath = path.join(outputDir, 'Collection content - mapping and QA report.json');
    const textReviewPath = path.join(outputDir, 'Collection text assignment and storefront review.csv');
    if (!args.overwrite && fs.existsSync(outputDir) && fs.readdirSync(outputDir).length) {
        throw new Error(`Refusing to overwrite non-empty output directory: ${outputDir}`);
    }
    fs.mkdirSync(outputDir, { recursive: true });
    const outputs = [];
    if (artifacts.textAssignmentReview.length) {
        writeCsv(textReviewPath, [
            'CategoryID', 'Culture', 'ContentId', 'StoreAPIRetrievedAt', 'Component',
            'ComponentType', 'LayoutType', 'ComponentOrder', 'HierarchyPath', 'StoreAPI CMS text content', 'Import source',
        ], artifacts.textAssignmentReview);
        outputs.push(path.basename(textReviewPath));
    }
    if (effectiveApprovalRows.length) {
        const approvalPath = path.join(outputDir, 'Collection content - approved URL mappings.json');
        fs.writeFileSync(approvalPath, `${JSON.stringify(effectiveApprovalRows, null, 2)}\n`, 'utf8');
        outputs.push(path.basename(approvalPath));
    }
    if (artifacts.importable.length) {
        const withDescriptions = artifacts.importable.filter(item => item.description);
        const withoutDescriptions = artifacts.importable.filter(item => !item.description);
        if (withDescriptions.length) {
            const table = matrixifyRows(withDescriptions, { includeBodyHtml: true });
            const collectionsPath = path.join(outputDir, 'Collection content - Matrixify update.xlsx');
            writeWorkbook(collectionsPath, 'Collections', table.headers, table.rows);
            outputs.push(path.basename(collectionsPath));
        }
        if (withoutDescriptions.length) {
            const table = matrixifyRows(withoutDescriptions, { includeBodyHtml: false });
            const collectionsPath = path.join(outputDir, 'Collection metafields only - Matrixify update.xlsx');
            writeWorkbook(collectionsPath, 'Collections', table.headers, table.rows);
            outputs.push(path.basename(collectionsPath));
        }
        const fileRecords = new Map();
        for (const item of artifacts.importable) for (const field of item.images) {
            for (const url of field.urls) fileRecords.set(url, { url, name: imageFilename(url) });
        }
        if (fileRecords.size) {
            const filesPath = path.join(outputDir, 'Collection images - Matrixify Files import.xlsx');
            writeWorkbook(filesPath, 'Files', ['Command', 'File Name', 'Link'],
                [...fileRecords.values()].map(file => ({ Command: 'NEW', 'File Name': file.name, Link: file.url })));
            outputs.unshift(path.basename(filesPath));
        }
        for (const [locale, rows] of artifacts.translationData) {
            if (!rows.length) continue;
            const file = `Collection translations - ${locale.slice(0, 2)}.xlsx`;
            writeWorkbook(path.join(outputDir, file), 'Translations',
                ['Entity', 'Entity Handle', 'Field', `Translation Value: ${locale.slice(0, 2)}`], rows);
            outputs.push(file);
        }
        const instructionsPath = path.join(outputDir, 'Collection content - import instructions.txt');
        fs.writeFileSync(instructionsPath,
            'FYRKLOVERN COLLECTION CONTENT IMPORT\n\n' +
            '1. The Collections workbook declares each metafield as a typed Matrixify column: Metafield: custom.<key> [<type>]. Shopify metafield definitions still need to exist before importing rich text and reference types; create them in Shopify Admin > Settings > Custom data.\n' +
            '2. If Collection images - Matrixify Files import.xlsx exists, import its Files sheet first and confirm success.\n' +
            '3. Import Collection content - Matrixify update.xlsx and, if present, Collection metafields only - Matrixify update.xlsx (Collections sheets). Both contain UPDATE rows; metafields are row-based to avoid clearing omitted fields.\n' +
            '4. Import the Collection translations - <language>.xlsx workbooks for enabled Shopify languages.\n' +
            '5. Consult the mapping/QA report for StoreAPI snapshot time, culture, CSV-only components, approved exceptions, and unresolved image/reference values. CSV-only components are excluded unless explicitly allowlisted.\n\n' +
            'StoreAPI content is the publication-state snapshot used for import. No expiration or scheduling inference is made. No Shopify API calls or imports are performed by this script.\n', 'utf8');
        outputs.push(path.basename(instructionsPath));
    }
    const report = {
        schemaVersion: 2, generatedAt: new Date().toISOString(), mode: 'offline Matrixify files; no Shopify API calls',
        summary: {
            localizedCategories: artifacts.review.length,
            readyRows: artifacts.prepared.length,
            approvedSwedishCollections: artifacts.importable.length,
            excludedCollections: [...new Set(collections
                .filter(collection => {
                    const handle = clean(collection.Handle).toLowerCase();
                    return excludedHandles.has(handle) || excludedHandlePrefixes.some(prefix => handle.startsWith(prefix));
                })
                .map(collection => `${clean(collection.Handle)} (${clean(collection.ID)})`))],
            mappingStatuses: artifacts.review.reduce((counts, row) => ({ ...counts, [row.Status]: (counts[row.Status] || 0) + 1 }), {}),
            StoreAPIComponents: artifacts.prepared.reduce((count, item) => count + item.components.length, 0),
            csvComponentsNotReturnedByStoreAPI: artifacts.csvComponents.length,
            approvedCsvExceptionComponents: artifacts.csvComponents.filter(row => row.exceptionStatus === 'approved_csv_exception').length,
            missingStoreApiSnapshots: artifacts.snapshotDiagnostics.missingPairs.length,
            textMetafields: artifacts.mapRows.filter(row => row.Type === 'rich_text_field').length,
            metafieldValues: artifacts.importable.reduce((count, item) =>
                count + item.metafields.length + item.images.length, 0),
            metafieldDefinitions: new Set(artifacts.importable.flatMap(item => [
                ...item.metafields.map(field => `${field.key}\0${field.type}`),
                ...item.images.map(field => `${field.key}\0${field.type}`),
            ])).size,
            collectionReferenceMetafields: artifacts.importable.reduce((count, item) =>
                count + item.metafields.filter(field => ['collection_reference', 'list.collection_reference'].includes(field.type)).length, 0),
            unresolvedCategoryReferences: artifacts.unresolvedCategoryReferences.length,
            textAssignmentReviewRows: artifacts.textAssignmentReview.length,
            imageListMetafields: artifacts.mapRows.filter(row => row.Type === 'list.file_reference').length,
            unresolvedImageValues: artifacts.unresolvedImages.length,
            imageComponentsWithoutDirectSource: artifacts.missingImageSources.length,
            outputs,
        },
        assumptions: [
            'Only explicitly approved CategoryID/Culture to ShopifyID rows are importable.',
            'The first nonempty StoreAPI component text supplies Body HTML and is not duplicated as a section metafield; the category workbook localized text is the fallback when StoreAPI has no text.',
            'The CMS CSV may provide non-Swedish translations only for components confirmed in the Swedish StoreAPI snapshot; CSV-only components are never imported by default.',
            'StoreAPI record retrieval time and culture define the publication-state snapshot imported.',
            'Typed Matrixify column headers declare each metafield namespace, key, and type. Create Shopify definitions first for fields that need rich text or reference types; otherwise Shopify may store these as metafields without definitions.',
            'Generic section keys use normalized component property names as the layout type, not Norce component or category names. Repeated matching layouts combine in source order.',
            'Only StoreAPI image properties containing direct HTTP(S) URLs are imported as images.',
        ],
        approval: {
            mode: 'Shopify collection approval map plus optional component exception allowlist',
            approvalMapRows: effectiveApprovalRows.length,
            componentExceptionAllowlistRows: exceptionRows.length,
        },
        storeApiSnapshot: artifacts.snapshotDiagnostics,
        review: artifacts.review,
        metafieldMapping: artifacts.mapRows,
        unresolvedCategoryReferences: artifacts.unresolvedCategoryReferences,
        textAssignmentReview: artifacts.textAssignmentReview,
        unresolvedImages: artifacts.unresolvedImages,
        imageComponentsMissingSource: artifacts.missingImageSources,
        csvComponentsNotReturnedByStoreAPI: artifacts.csvComponents,
        componentExceptionDiagnostics: artifacts.unmatchedExceptions,
        translationDiagnostics: artifacts.translationDiagnostics,
        cmsCsvDiagnostics: cmsCsv?.diagnostics || null,
        importReady: artifacts.importable.length > 0,
        filesImportFirst: outputs.includes('Collection images - Matrixify Files import.xlsx'),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${report.summary.readyRows} approved locale rows; ${report.summary.approvedSwedishCollections} Swedish collection imports are ready.`);
    console.log(`Review report: ${reportPath}`);
    if (!report.importReady) console.log('No import workbooks were emitted because no Swedish mappings passed approval and validation.');
    return report;
}

module.exports = {
    TEXT_PROPERTIES, LOCALES, key, slug, propertyHtml, firstTextItem, isDescriptionProperty, collectionDescription, componentLabel, componentKeys, semanticComponentKeys, sectionTextFields, readCollectionRows,
    loadApprovals, approvedLookup, componentCategoryIds, collectionReferenceKey,
    buildCategoryReferenceLookup, resolveCategoryReference,
    approveUrlCandidates, contentMapLookup, buildPlan, matrixifyRows,
    buildArtifacts, buildStoreApiArtifacts, isStoreApiImageProperty, imageFilename, parseArgs, main,
};
if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
