#!/usr/bin/env node
/** Build or explicitly apply an idempotent Norce collection content-block migration. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const XLSX = require('xlsx');
const { readCategoryWorkbook, readCmsCsv, normalizeCms, clean } = require('./norce-source-ingestion');
const { normalizeStoreApiComponents } = require('./norce-storeapi-content');
const {
    readCollectionRows, loadApprovals, approvedLookup, buildStoreApiArtifacts, propertyHtml,
    componentCategoryIds, buildCategoryReferenceLookup, resolveCategoryReference,
} = require('./build-collection-content-import');

const API_VERSION = '2026-10';
const BLOCK_TYPES = Object.freeze({
    rich_text: 'norce_collection_rich_text',
    image_text: 'norce_collection_image_text',
    banner: 'norce_collection_banner',
    gallery: 'norce_collection_gallery',
    video: 'norce_collection_video',
    link: 'norce_collection_link',
    product: 'norce_collection_product_block',
    fallback: 'norce_collection_fallback',
});
const BODY_PROPERTIES = /^(text|html|paragraph\d*|caption|bigtext|smalltext|content|description)$/i;
const TRANSLATION_FIELDS = Object.freeze({ header: 'heading', text: 'content_html', linktext: 'link_label', tagtext: 'tag_text' });
const FIELD_DEFINITIONS = [
    ['source_category_id', 'Source category ID', 'single_line_text_field'],
    ['source_id', 'Source component ID', 'single_line_text_field'],
    ['source_name', 'Norce component name', 'single_line_text_field'],
    ['source_type', 'Norce component type', 'single_line_text_field'],
    ['identity_mode', 'Source identity method', 'single_line_text_field'],
    ['parent_name', 'Parent component name', 'single_line_text_field'],
    ['source_order', 'Source order and hierarchy', 'json'],
    ['heading', 'Heading', 'single_line_text_field'],
    ['content_html', 'Content HTML', 'multi_line_text_field'],
    ['link_label', 'Link label', 'single_line_text_field'],
    ['link_url', 'Link URL', 'single_line_text_field'],
    ['tag_text', 'Tag text', 'single_line_text_field'],
    ['alt_text', 'Image alternative text', 'single_line_text_field'],
    ['video_type', 'Video type', 'single_line_text_field'],
    ['video_id', 'Video ID', 'single_line_text_field'],
    ['image', 'Image', 'file_reference'],
    ['images', 'Images', 'list.file_reference'],
    ['related_collections', 'Related collections', 'list.collection_reference'],
    ['image_focus', 'Image focus', 'single_line_text_field'],
    ['layout', 'Layout settings', 'json'],
    ['source_payload', 'Original Norce properties', 'json'],
    ['source_hash', 'Last imported source hash', 'single_line_text_field'],
    ['content_hash', 'Last imported content hash', 'single_line_text_field'],
];

function parseArgs(argv) {
    const args = {};
    for (const item of argv) {
        const match = item.match(/^--([^=]+)=(.*)$/);
        if (match) args[match[1]] = match[2];
        else if (item.startsWith('--')) args[item.slice(2)] = true;
    }
    return args;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function slug(value) {
    return clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'component';
}
function scalar(component, names) {
    const wanted = new Set(names.map(name => name.toLowerCase()));
    return component.items.find(item => wanted.has(clean(item.propertyName).toLowerCase()) && clean(item.value))?.value ?? '';
}
function classify(component) {
    const type = clean(component.componentType || component.type).toLowerCase();
    const names = component.items.map(item => clean(item.propertyName).toLowerCase());
    if (/video/.test(type) || names.some(name => name === 'videoid' || name === 'videotype')) return 'video';
    if (/product/.test(type)) return 'product';
    if (/gallery|carousel|inspirationblock/.test(type)) return 'gallery';
    if (/campaign|banner/.test(type)) return 'banner';
    if (/link/.test(type)) return 'link';
    if (names.some(name => /^(image|tallimage|categoryimage|imageurl|src|source)$/.test(name))) return 'image_text';
    if (names.some(name => /^(text|html|content|paragraph\d*|bigtext|smalltext)$/.test(name))) return 'rich_text';
    return 'fallback';
}
function contentBlocksForCategory(categoryId, components, descriptionItem = null) {
    const occurrences = new Map();
    return components.map((component, index) => {
        const type = classify(component);
        const label = clean(component.componentType || component.type || component.itemName || 'component');
        const baseIdentity = clean(component.componentId) || `${slug(label)}-${slug(component.itemName || 'unnamed')}`;
        const occurrence = occurrences.get(baseIdentity) || 0;
        occurrences.set(baseIdentity, occurrence + 1);
        const sourceId = `${baseIdentity}-${occurrence + 1}`;
        const identityMode = clean(component.componentId) ? 'norce_component_id' : 'component_type_name_occurrence';
        const handle = `norce-category-${slug(categoryId)}-${slug(sourceId)}`.slice(0, 255);
        const retainedItems = component.items.filter(item => !(descriptionItem && item.sourceRow === descriptionItem.sourceRow));
        const retainedComponent = { ...component, items: retainedItems };
        const payload = retainedItems.map(item => ({
            name: item.propertyName, type: item.propertyType, valueType: item.valueType,
            value: item.value, rawValue: item.rawValue, order: item.order,
        }));
        const sourcePayload = { tags: component.tags || [], properties: payload };
        const imageItems = retainedItems.filter(item => /^(image|tallimage|categoryimage|imageurl|src|source)$/i.test(clean(item.propertyName)) &&
            /^https?:\/\//i.test(clean(item.value)));
        const images = [...new Set(imageItems.map(item => clean(item.value)))];
        const layout = retainedItems.filter(item => /layout|placement|focus|ratio|padding|overlay|appearance|color|width|spacer|align|render/i.test(clean(item.propertyName)))
            .map(item => ({ name: item.propertyName, value: item.value }));
        const fields = {
            source_category_id: String(categoryId), source_id: sourceId, source_name: clean(component.itemName || component.componentName || ''), source_type: label,
            identity_mode: identityMode,
            parent_name: clean(component.parentName || ''),
            source_order: JSON.stringify({ order: component.order ?? index + 1, hierarchyPath: component.hierarchyPath || [] }),
            heading: clean(scalar(retainedComponent, ['heading', 'title', 'miniTitle', 'label', 'name'])),
            content_html: retainedItems.filter(item => BODY_PROPERTIES.test(clean(item.propertyName))).map(propertyHtml).filter(Boolean).join('\n'),
            link_label: clean(scalar(retainedComponent, ['linkText', 'linkLabel', 'label', 'button'])),
            link_url: clean(scalar(retainedComponent, ['linkUrl', 'href', 'url', 'link'])),
            tag_text: clean(scalar(retainedComponent, ['tagText'])),
            alt_text: clean(scalar(retainedComponent, ['alt', 'imageAlt', 'altText'])),
            video_type: clean(scalar(retainedComponent, ['videoType'])),
            video_id: clean(scalar(retainedComponent, ['videoId'])),
            image: '', images: '[]', image_focus: clean(scalar(retainedComponent, ['imageFocus', 'imagePlacement'])),
            related_collections: JSON.stringify(component.relatedCollectionIds || []),
            layout: JSON.stringify(layout), source_payload: JSON.stringify(sourcePayload),
        };
        const sourceHash = hash({ type, fields: { ...fields, source_payload: sourcePayload }, images });
        fields.source_hash = sourceHash;
        fields.content_hash = hash({ ...fields, image: '', images: images.length ? images : [] });
        return { handle, type: BLOCK_TYPES[type], blockType: type, sourceId, identityMode, sourceOrder: component.order ?? index + 1,
            hierarchyPath: component.hierarchyPath || [], imageUrls: images, imagePropertyNames: imageItems.map(item => item.propertyName), fields };
    });
}
function buildMigrationPlan({ categoryData, collections, snapshot, cms, approvals, exceptions = [], translationWorkbooks = new Map(), translationSource = '' }) {
    const artifacts = buildStoreApiArtifacts({ categoryData, collections, snapshot, cms, approvals, exceptions });
    const categoryReferenceLookup = buildCategoryReferenceLookup(approvals, collections);
    const byKey = new Map((snapshot.records || []).map(record => [`${clean(record.categoryId)}\0${clean(record.culture)}`, record]));
    const rows = [];
    const skipped = [];
    for (const item of artifacts.prepared.filter(row => row.category.culture === 'sv-SE')) {
        const categoryId = clean(item.category.categoryId);
        const record = byKey.get(`${categoryId}\0sv-SE`);
        const components = record?.category ? normalizeStoreApiComponents(record.category) : item.components;
        const blocks = contentBlocksForCategory(categoryId, components.map(component => {
            const reference = resolveCategoryReference(componentCategoryIds(component), categoryReferenceLookup);
            return { ...component, relatedCollectionIds: reference.status === 'resolved' ? [collectionGid(reference.shopifyId)] : [] };
        }), item.descriptionItem);
        const translationData = new Map(artifacts.translationData);
        const fullLocales = { da: 'da-DK', de: 'de-DE', en: 'en-GB', fi: 'fi-FI', nb: 'nb-NO', nl: 'nl-NL' };
        for (const [locale, rows] of translationWorkbooks) {
            const fullLocale = fullLocales[locale];
            if (fullLocale) translationData.set(fullLocale, [...(translationData.get(fullLocale) || []), ...rows]);
        }
        attachTranslations(blocks, translationData, clean(item.collection.Handle));
        rows.push({ categoryId, collectionId: clean(item.collection.ID), collectionHandle: clean(item.collection.Handle),
            descriptionPresent: Boolean(item.description), blockCount: blocks.length, blocks });
    }
    for (const row of artifacts.review.filter(row => row.Culture === 'sv-SE' && row.Status !== 'ready')) {
        skipped.push({ categoryId: row.CategoryID, status: row.Status, shopifyId: row.ShopifyID || '' });
    }
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), apiVersion: API_VERSION, translationSource,
        policy: 'Dry-run by default; preserve existing content_blocks unless exact match or --sync-content-blocks=true; never delete metaobjects.',
        definitions: BLOCK_TYPES, fields: FIELD_DEFINITIONS.map(([key, name, type]) => ({ key, name, type })),
        summary: { collections: rows.length, blocks: rows.reduce((n, row) => n + row.blockCount, 0),
            maxBlocksPerCollection: Math.max(0, ...rows.map(row => row.blockCount)), skipped: skipped.length,
            translatedBlocks: rows.reduce((n, row) => n + row.blocks.filter(block => Object.keys(block.translations || {}).length).length, 0),
            translationCounts: rows.reduce((counts, row) => {
                for (const block of row.blocks) for (const locale of Object.keys(block.translations || {})) counts[locale] = (counts[locale] || 0) + 1;
                return counts;
            }, {}),
            blocksUsingFallbackIdentity: rows.reduce((n, row) => n + row.blocks.filter(block => block.identityMode !== 'norce_component_id').length, 0),
            unimportableImages: artifacts.unresolvedImages.length + artifacts.missingImageSources.length,
            unresolvedCategoryReferences: artifacts.unresolvedCategoryReferences.length,
            csvOnlyComponentsExcluded: artifacts.csvComponents.length },
        collections: rows, skipped,
        diagnostics: { identityLimitation: 'StoreAPI component IDs are not included in the saved source snapshot; handles use component type, component name, and same-identity occurrence. Reordering repeated unnamed components cannot be mapped to persistent source identities.',
            unresolvedImages: artifacts.unresolvedImages, missingImageSources: artifacts.missingImageSources,
            unresolvedCategoryReferences: artifacts.unresolvedCategoryReferences, csvComponentsNotReturnedByStoreAPI: artifacts.csvComponents },
    };
}
function plainTextFromHtml(value) {
    return String(value).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").trim();
}
function attachTranslations(blocks, translationData, collectionHandle) {
    for (const [locale, rows] of translationData || []) {
        const targetLocale = locale.slice(0, 2);
        for (const row of rows) {
            if (clean(row['Entity Handle']) !== collectionHandle) continue;
            const match = clean(row.Field).match(/^Metafield: custom\.section_(\d+)_(header|text|linktext|tagtext)$/i);
            if (!match) continue;
            const block = blocks[Number(match[1]) - 1];
            const field = TRANSLATION_FIELDS[match[2].toLowerCase()];
            const value = row[`Translation Value: ${targetLocale}`];
            if (!block || !field || !clean(value)) continue;
            block.translations ||= {};
            block.translations[targetLocale] ||= {};
            block.translations[targetLocale][field] = field === 'heading' ? plainTextFromHtml(value) : String(value);
        }
    }
    return blocks;
}
function readTranslationWorkbooks(directory) {
    if (!directory) return new Map();
    const result = new Map();
    if (!fs.existsSync(directory)) throw new Error(`Translation workbook directory does not exist: ${directory}`);
    for (const filename of fs.readdirSync(directory).filter(name => /^Collection translations - [a-z]{2}\.xlsx$/i.test(name))) {
        const locale = filename.match(/- ([a-z]{2})\.xlsx$/i)[1].toLowerCase();
        const workbook = XLSX.readFile(path.join(directory, filename));
        const sheetName = workbook.SheetNames.find(name => name.toLowerCase() === 'translations');
        if (!sheetName) continue;
        if (!result.has(locale)) result.set(locale, []);
        result.get(locale).push(...XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' }));
    }
    return result;
}
function inputPlan(args) {
    const required = ['categories', 'storeapi-snapshot', 'shopify', 'approved-map'];
    const missing = required.filter(name => !args[name]);
    if (missing.length) throw new Error(`Missing required options: ${missing.join(', ')}`);
    const categoryData = readCategoryWorkbook(path.resolve(args.categories));
    const snapshot = JSON.parse(fs.readFileSync(path.resolve(args['storeapi-snapshot']), 'utf8'));
    if (!Array.isArray(snapshot.records)) throw new Error('StoreAPI snapshot must contain a records array.');
    const collections = readCollectionRows(path.resolve(args.shopify));
    const approvalRows = loadApprovals(path.resolve(args['approved-map']));
    const cmsCsv = args.cms && args.cms !== 'none' ? readCmsCsv(path.resolve(args.cms)) : null;
    const cms = cmsCsv ? normalizeCms(cmsCsv.records, cmsCsv.headers) : { contents: [] };
    const exceptionRows = args['component-exceptions'] ? require('./norce-storeapi-content').loadComponentExceptions(path.resolve(args['component-exceptions'])) : [];
    const translationSource = args['translations-dir'] ? path.resolve(args['translations-dir']) : '';
    const translationWorkbooks = readTranslationWorkbooks(translationSource);
    return buildMigrationPlan({ categoryData, collections, snapshot, cms, approvals: approvedLookup(approvalRows), exceptions: exceptionRows,
        translationWorkbooks, translationSource });
}

class ShopifyAdminClient {
    constructor({ shop, token, version = API_VERSION, fetchImpl = globalThis.fetch }) {
        if (!shop || !token) throw new Error('Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN in the environment before using --apply.');
        this.endpoint = `https://${shop.replace(/^https?:\/\//, '').replace(/\/$/, '')}/admin/api/${version}/graphql.json`;
        this.token = token; this.fetch = fetchImpl; this.availableCost = Infinity; this.restoreRate = 50;
    }
    async query(query, variables = {}) {
        for (let attempt = 0; attempt <= 5; attempt += 1) {
            if (this.availableCost < 80) {
                const waitMs = Math.ceil((80 - this.availableCost) / this.restoreRate * 1000);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
            const response = await this.fetch(this.endpoint, { method: 'POST', headers: {
                'content-type': 'application/json', 'x-shopify-access-token': this.token,
            }, body: JSON.stringify({ query, variables }) });
            if (response.status === 429) {
                if (attempt === 5) throw new Error('Shopify GraphQL rate limit persisted after 5 retries.');
                const retryAfter = Number(response.headers?.get?.('retry-after'));
                await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1)));
                continue;
            }
            const body = await response.json();
            const throttled = (body.errors || []).some(error => error.extensions?.code === 'THROTTLED' || /throttl/i.test(error.message || ''));
            if (throttled && attempt < 5) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                continue;
            }
            if (!response.ok || body.errors?.length) throw new Error(`Shopify GraphQL request failed: ${JSON.stringify(body.errors || body).slice(0, 1500)}`);
            const status = body.extensions?.cost?.throttleStatus;
            if (status) { this.availableCost = status.currentlyAvailable; this.restoreRate = status.restoreRate || this.restoreRate; }
            return body.data;
        }
        throw new Error('Shopify GraphQL request failed after rate-limit retries.');
    }
}
function assertNoUserErrors(payload, name) {
    const errors = payload?.userErrors || [];
    if (errors.length) throw new Error(`${name}: ${errors.map(error => error.message).join('; ')}`);
    return payload;
}
async function ensureDefinitions(client) {
    const existingQuery = `query Definitions { metaobjectDefinitions(first: 250) { nodes { id type capabilities { translatable { enabled } } fieldDefinitions { key type { name } } } } }`;
    const existing = await client.query(existingQuery);
    const definitions = new Map((existing.metaobjectDefinitions?.nodes || []).map(item => [item.type, item]));
    const createDefinition = `mutation CreateDefinition($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) { metaobjectDefinition { id type } userErrors { field message } }
    }`;
    for (const type of Object.values(BLOCK_TYPES)) {
        const fields = FIELD_DEFINITIONS.map(([key, name, fieldType]) => ({ key, name, type: fieldType }));
        if (!definitions.has(type)) {
            const result = await client.query(createDefinition, { definition: { type, name: type.replace(/^norce_collection_/, 'Collection ').replace(/_/g, ' '),
                fieldDefinitions: fields, access: { admin: 'MERCHANT_READ_WRITE', storefront: 'PUBLIC_READ' },
                capabilities: { translatable: { enabled: true } } } });
            const created = assertNoUserErrors(result.metaobjectDefinitionCreate, `Create ${type}`).metaobjectDefinition;
            definitions.set(type, { ...created, fieldDefinitions: fields, capabilities: { translatable: { enabled: true } } });
        } else {
            const current = new Map(definitions.get(type).fieldDefinitions.map(field => [field.key, field.type.name]));
            const incompatible = fields.filter(field => current.has(field.key) && current.get(field.key) !== field.type);
            const missing = fields.filter(field => !current.has(field.key));
            if (incompatible.length) throw new Error(`Existing metaobject ${type} has incompatible field types: ${incompatible.map(field => `${field.key}=${current.get(field.key)}`).join(', ')}`);
            if (missing.length) throw new Error(`Existing metaobject ${type} is missing fields (${missing.map(field => field.key).join(', ')}); add them in Shopify before applying.`);
        }
    }
    const mixedType = `list.mixed_reference`;
    const referenceIds = Object.values(BLOCK_TYPES).map(type => definitions.get(type).id);
    const metafieldQuery = `query CollectionDefinition { metafieldDefinitions(first: 20, ownerType: COLLECTION, query: "namespace:custom key:content_blocks") { nodes { id namespace key type { name } validations { name value } } } }`;
    const current = await client.query(metafieldQuery);
    const nodes = current.metafieldDefinitions?.nodes || [];
    if (nodes.length) {
        const definition = nodes[0];
        if (definition.type.name !== mixedType) throw new Error(`Existing custom.content_blocks has type ${definition.type.name}; expected ${mixedType}.`);
        const rule = definition.validations?.find(item => item.name === 'metaobject_definition_ids');
        const allowed = new Set(JSON.parse(rule?.value || '[]'));
        if (referenceIds.some(id => !allowed.has(id))) throw new Error('Existing custom.content_blocks definition does not allow all Norce metaobject types; update its allowed definitions in Shopify before applying.');
    } else {
        const createMetafield = `mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) { createdDefinition { id type } userErrors { field message } }
        }`;
        const result = await client.query(createMetafield, { definition: { name: 'Collection content blocks', namespace: 'custom', key: 'content_blocks',
            ownerType: 'COLLECTION', type: mixedType, description: 'Ordered Norce collection page content blocks.',
            validations: [{ name: 'metaobject_definition_ids', value: JSON.stringify(referenceIds) }] } });
        assertNoUserErrors(result.metafieldDefinitionCreate, 'Create custom.content_blocks definition');
    }
    return definitions;
}
function contentValueHash(fields) {
    const clone = { ...fields };
    delete clone.source_hash; delete clone.content_hash;
    return hash(clone);
}
function collectionGid(id) {
    const value = clean(id);
    return value.startsWith('gid://shopify/Collection/') ? value : `gid://shopify/Collection/${value}`;
}
async function applyPlan(plan, client, { syncContentBlocks = false, overwriteManualMetaobjects = false, applyTranslations = false, syncTranslations = false } = {}) {
    if (plan.summary.translatedBlocks > 0 && !applyTranslations) {
        throw new Error('This plan contains translations; review them and pass --apply-translations=true to include them.');
    }
    if (plan.summary.maxBlocksPerCollection > 1024) throw new Error('Shopify list metafields support at most 1,024 metaobject references.');
    const definitions = await ensureDefinitions(client);
    if (plan.summary.translatedBlocks > 0 && Object.values(BLOCK_TYPES).some(type => !definitions.get(type)?.capabilities?.translatable?.enabled)) {
        throw new Error('Existing Norce Metaobject definitions must have translations enabled before translated content can be applied.');
    }
    const upsert = `mutation UpsertBlock($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { id handle fields { key value } } userErrors { field message code } }
    }`;
    const collectionQuery = `query CollectionBlocks($id: ID!) { collection(id: $id) { id metafield(namespace: "custom", key: "content_blocks") { type value references(first: 1024) { nodes { ... on Metaobject { id handle type } } } } } }`;
    const existingMetaobject = `query ExistingMetaobject($handle: MetaobjectHandleInput!) { metaobject(handle: $handle) { id handle type fields { key value } } }`;
    const localeCodes = ['da', 'de', 'en', 'fi', 'nb', 'nl'];
    const translationAliases = localeCodes.map(locale => `${locale}: translations(locale: "${locale}") { key value }`).join('\n');
    const translationsQuery = `query BlockTranslations($id: ID!) { translatableResource(resourceId: $id) {
      translatableContent { key digest locale } ${translationAliases}
    } }`;
    const registerTranslations = `mutation RegisterBlockTranslations($id: ID!, $translations: [TranslationInput!]!) {
      translationsRegister(resourceId: $id, translations: $translations) { translations { locale key value } userErrors { field message code } }
    }`;
    const setCollection = `mutation SetCollectionBlocks($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { id namespace key type value } userErrors { field message code } }
    }`;
    const fileCache = new Map();
    const fileSearch = `query ExistingFiles($query: String!) { files(first: 20, query: $query) { nodes { id ... on MediaImage { image { url } } } } }`;
    const staged = `mutation StageFile($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`;
    const fileCreate = `mutation CreateFile($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus } userErrors { field message } } }`;
    async function ensureFile(url) {
        if (fileCache.has(url)) return fileCache.get(url);
        const filename = `${hash(url).slice(0, 10)}-${path.posix.basename(new URL(url).pathname) || 'image'}`.slice(0, 100);
        const found = await client.query(fileSearch, { query: `filename:${filename}` });
        const reusable = found.files?.nodes?.find(item => item.image?.url);
        if (reusable) { fileCache.set(url, reusable.id); return reusable.id; }
        const source = await client.fetch(url);
        if (!source.ok) throw new Error(`Image download failed (${source.status}): ${url}`);
        const blob = await source.blob();
        const mimeType = blob.type || 'application/octet-stream';
        const targetResponse = await client.query(staged, { input: [{ filename, mimeType, fileSize: String(blob.size), httpMethod: 'POST', resource: 'IMAGE' }] });
        const target = assertNoUserErrors(targetResponse.stagedUploadsCreate, `Stage image ${filename}`).stagedTargets?.[0];
        if (!target) throw new Error(`No staged upload target was returned for ${filename}.`);
        const form = new FormData();
        for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
        form.append('file', blob, filename);
        const uploaded = await client.fetch(target.url, { method: 'POST', body: form });
        if (!uploaded.ok) throw new Error(`Staged image upload failed (${uploaded.status}): ${filename}`);
        const created = await client.query(fileCreate, { files: [{ originalSource: target.resourceUrl, filename, contentType: 'IMAGE' }] });
        const file = assertNoUserErrors(created.fileCreate, `Create Shopify image ${filename}`).files?.[0];
        if (!file?.id) throw new Error(`Shopify did not return a file ID for ${filename}.`);
        fileCache.set(url, file.id);
        return file.id;
    }
    const results = [];
    const preflight = new Map();
    for (const collection of plan.collections) {
        if (collection.blockCount > 1024) throw new Error(`Collection ${collection.categoryId} has ${collection.blockCount} blocks; maximum is 1,024.`);
        const live = (await client.query(collectionQuery, { id: collectionGid(collection.collectionId) })).collection;
        if (!live) throw new Error(`Shopify collection ${collection.collectionId} was not found.`);
        const existing = live.metafield;
        const currentHandles = existing?.references?.nodes?.map(node => node.handle) || [];
        const targetHandles = collection.blocks.map(block => block.handle);
        if (existing?.value && JSON.stringify(currentHandles) !== JSON.stringify(targetHandles) && !syncContentBlocks) {
            throw new Error(`Collection ${collection.collectionId} already has different custom.content_blocks. Review the current list, then rerun with --sync-content-blocks=true to replace it.`);
        }
        preflight.set(collection.collectionId, { live, currentHandles, targetHandles });
    }
    for (const collection of plan.collections) for (const block of collection.blocks) {
        const response = await client.query(existingMetaobject, { handle: { type: block.type, handle: block.handle } });
        const entry = response.metaobject;
        if (!entry) continue;
        const currentFields = Object.fromEntries((entry.fields || []).map(field => [field.key, field.value ?? '']));
        const recordedHash = currentFields.content_hash;
        const actualHash = contentValueHash(currentFields);
        if (!recordedHash || recordedHash !== actualHash) {
            if (overwriteManualMetaobjects) continue;
            throw new Error(`Metaobject ${block.handle} has content that differs from the last import hash; refusing to overwrite possible manual edits.`);
        }
        if (Object.keys(block.translations || {}).length) {
            const localized = (await client.query(translationsQuery, { id: entry.id })).translatableResource;
            if (!localized) throw new Error(`Metaobject ${block.handle} is not available for translation; enable translations on its definition.`);
            const digestByKey = new Map((localized.translatableContent || []).map(item => [item.key, item.digest]));
            for (const [locale, fields] of Object.entries(block.translations)) {
                const currentByKey = new Map((localized[locale] || []).map(item => [item.key, item.value]));
                for (const [fieldKey, value] of Object.entries(fields)) if (currentByKey.has(fieldKey) &&
                    currentByKey.get(fieldKey) !== value && !syncTranslations) {
                    throw new Error(`Metaobject ${block.handle} has a different ${locale} translation for ${fieldKey}; refusing to overwrite possible manual edits.`);
                }
                for (const fieldKey of Object.keys(fields)) if (!digestByKey.has(fieldKey)) {
                    throw new Error(`Metaobject ${block.handle} field ${fieldKey} is not translatable; enable translation support for the definition.`);
                }
            }
        }
    }
    for (const collection of plan.collections) {
        const blocks = [];
        for (const block of collection.blocks) {
            const values = { ...block.fields };
            const imageIds = [];
            for (const url of block.imageUrls) {
                try { imageIds.push(await ensureFile(url)); }
                catch (error) { throw new Error(`Image upload failed for category ${collection.categoryId}, block ${block.sourceId}: ${error.message}`); }
            }
            const firstImageProperty = block.imagePropertyNames[0]?.toLowerCase();
            if (imageIds.length) {
                values.images = JSON.stringify(imageIds);
                values.image = imageIds[0];
                const originalContentHash = contentValueHash(values);
                values.content_hash = originalContentHash;
            } else {
                values.images = '[]';
                values.image = '';
                values.content_hash = contentValueHash(values);
            }
            const response = await client.query(upsert, { handle: { type: block.type, handle: block.handle },
                metaobject: { fields: Object.entries(values).map(([key, value]) => ({ key, value: String(value) })) } });
            const entry = assertNoUserErrors(response.metaobjectUpsert, `Upsert block ${block.handle}`).metaobject;
            if (!entry?.id) throw new Error(`Shopify did not return a metaobject ID for ${block.handle}.`);
            if (Object.keys(block.translations || {}).length) {
                const localized = (await client.query(translationsQuery, { id: entry.id })).translatableResource;
                if (!localized) throw new Error(`Metaobject ${block.handle} is not translatable.`);
                const digestByKey = new Map((localized.translatableContent || []).map(item => [item.key, item.digest]));
                const translations = [];
                for (const [locale, fields] of Object.entries(block.translations)) {
                    const currentByKey = new Map((localized[locale] || []).map(item => [item.key, item.value]));
                    for (const [fieldKey, value] of Object.entries(fields)) {
                        if (currentByKey.get(fieldKey) === value) continue;
                        const digest = digestByKey.get(fieldKey);
                        if (!digest) throw new Error(`No translation digest returned for ${block.handle}.${fieldKey}.`);
                        translations.push({ locale, key: fieldKey, value, translatableContentDigest: digest });
                    }
                }
                if (translations.length) {
                    const result = await client.query(registerTranslations, { id: entry.id, translations });
                    assertNoUserErrors(result.translationsRegister, `Register translations for ${block.handle}`);
                }
            }
            blocks.push({ id: entry.id, handle: entry.handle, imageProperty: firstImageProperty });
        }
        const live = preflight.get(collection.collectionId).live;
        const existing = live.metafield;
        const targetIds = blocks.map(block => block.id);
        if (existing?.value) {
            let previous;
            try { previous = JSON.parse(existing.value); } catch { throw new Error(`Collection ${collection.collectionId} has invalid custom.content_blocks JSON.`); }
            if (JSON.stringify(previous) !== JSON.stringify(targetIds) && !syncContentBlocks) {
                throw new Error(`Collection ${collection.collectionId} already has custom.content_blocks; rerun with --sync-content-blocks=true only after reviewing the existing list.`);
            }
        }
        if (!existing?.value || JSON.stringify(JSON.parse(existing.value)) !== JSON.stringify(targetIds)) {
            const result = await client.query(setCollection, { metafields: [{ ownerId: live.id, namespace: 'custom', key: 'content_blocks', type: 'list.mixed_reference', value: JSON.stringify(targetIds) }] });
            assertNoUserErrors(result.metafieldsSet, `Attach blocks to collection ${collection.collectionId}`);
        }
        results.push({ categoryId: collection.categoryId, collectionId: collection.collectionId, blockCount: targetIds.length, ids: targetIds });
        console.log(`Attached ${targetIds.length} blocks to collection ${collection.collectionHandle} (${collection.categoryId}).`);
    }
    return results;
}
async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl } = {}) {
    if (env === process.env) dotenv.config({ path: env.ENV_FILE || '.env' });
    const args = parseArgs(argv);
    if (args.help) {
        console.log('Usage: npm run migrate:fyrklovern-collection-content -- --categories=<xlsx> --storeapi-snapshot=<json> --shopify=<xlsx> --approved-map=<json> [--cms=<csv>] [--translations-dir=<dir>] [--component-exceptions=<json>] [--output=<json>] [--apply] [--apply-translations=true] [--sync-content-blocks=true]');
        console.log('Default is an offline plan. --apply requires SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN; translations require explicit --apply-translations=true; --sync-translations=true permits replacing existing translated fields.');
        return null;
    }
    const plan = inputPlan(args);
    const output = path.resolve(args.output || 'outputs/Fyrklovern/Matrixify files/Collections/Metaobject migration/Collection content metaobject migration plan.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    console.log(`Wrote plan for ${plan.summary.collections} collections and ${plan.summary.blocks} content blocks: ${output}`);
    if (!args.apply) return plan;
    if (plan.summary.maxBlocksPerCollection > 1024) throw new Error('Apply stopped: Shopify supports at most 1,024 references in this list metafield.');
    const client = new ShopifyAdminClient({ shop: env.SHOPIFY_STORE_DOMAIN, token: env.SHOPIFY_ADMIN_ACCESS_TOKEN,
        version: env.SHOPIFY_API_VERSION || API_VERSION, fetchImpl });
    const applied = await applyPlan(plan, client, { syncContentBlocks: args['sync-content-blocks'] === 'true',
        overwriteManualMetaobjects: args['overwrite-manual-metaobjects'] === 'true', applyTranslations: args['apply-translations'] === 'true',
        syncTranslations: args['sync-translations'] === 'true' });
    const resultPath = output.replace(/\.json$/i, ' - apply report.json');
    fs.writeFileSync(resultPath, `${JSON.stringify({ appliedAt: new Date().toISOString(), apiVersion: env.SHOPIFY_API_VERSION || API_VERSION,
        collections: applied }, null, 2)}\n`, 'utf8');
    console.log(`Apply report: ${resultPath}`);
    return applied;
}

module.exports = { API_VERSION, BLOCK_TYPES, FIELD_DEFINITIONS, parseArgs, classify, contentBlocksForCategory,
    buildMigrationPlan, ShopifyAdminClient, ensureDefinitions, contentValueHash, collectionGid, attachTranslations, readTranslationWorkbooks, applyPlan, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
