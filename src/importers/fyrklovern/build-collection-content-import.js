#!/usr/bin/env node
/** Build approval-gated, offline Matrixify collection content imports. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const {
    readCategoryWorkbook, readCmsCsv, normalizeCms, normalizeContentMap, clean,
} = require('./norce-source-ingestion');
const { buildMappingReview } = require('./build-mapping-review');

const TEXT_PROPERTIES = /^(text|html|heading|paragraph\d*|caption|bigtext|smalltext|linktext|title|description)$/i;
const IMAGE_PROPERTIES = /^(image|imageurl|src|source)$/i;
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
function isDescriptionProperty(component, item) {
    return clean(component.componentType).toLowerCase() === 'root' && clean(item.propertyName).toLowerCase() === 'text';
}
function collectionDescription(category, cmsContent) {
    const cmsText = (cmsContent?.components || []).filter(component => clean(component.componentType).toLowerCase() === 'root')
        .flatMap(component => component.items.filter(item => clean(item.propertyName).toLowerCase() === 'text'))
        .map(item => clean(item.value)).filter(Boolean).join('\n\n');
    if (cmsText) return cmsText;
    return clean(category.source.content || category.source.Content || category.source.text || category.source.Text || '');
}
function componentKeys(components) {
    const counts = new Map();
    return components.map(component => {
        const name = slug(component.componentType || component.itemName || 'root');
        const occurrence = (counts.get(name) || 0) + 1;
        counts.set(name, occurrence);
        return { ...component, metafieldKey: `norce_${name}_${String(occurrence).padStart(2, '0')}` };
    });
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
        const metafields = [];
        const images = [];
        for (const component of components) {
            const html = component.items.filter(item => !isDescriptionProperty(component, item)).map(propertyHtml).filter(Boolean).join('\n');
            if (html) metafields.push({
                key: component.metafieldKey, type: 'rich_text_field', value: html,
                componentName: component.componentType || 'root', componentOrder: component.order,
                sourceRows: component.items.filter(item => !isDescriptionProperty(component, item) && propertyHtml(item)).map(item => item.sourceRow),
            });
            const urls = component.items.filter(item => IMAGE_PROPERTIES.test(clean(item.propertyName)) && isHttpUrl(clean(item.value)));
            const uniqueUrls = [...new Set(urls.map(item => clean(item.value)))];
            if (uniqueUrls.length) images.push({
                key: `${component.metafieldKey}_images`, type: 'list.file_reference', urls: uniqueUrls,
                componentName: component.componentType || 'root', componentOrder: component.order,
                sourceRows: urls.map(item => item.sourceRow),
            });
        }
        const unresolvedImages = components.flatMap(component => component.items
            .filter(item => IMAGE_PROPERTIES.test(clean(item.propertyName)) && clean(item.value))
            .filter(item => !isHttpUrl(clean(item.value)))
            .map(item => ({ categoryId: category.categoryId, culture: category.culture,
                contentId, componentName: component.componentType, property: item.propertyName,
                sourceRow: item.sourceRow, reason: 'image value is not a direct HTTP(S) URL' })));
        const imageComponentsMissingSource = components.filter(component =>
            /image|picture/i.test(component.componentType) &&
            !component.items.some(item => IMAGE_PROPERTIES.test(clean(item.propertyName)) && isHttpUrl(clean(item.value)))
        ).map(component => ({ categoryId: category.categoryId, culture: category.culture,
            contentId, componentName: component.componentType, sourceRow: component.sourceOrder,
            reason: 'CMS image component has no directly resolvable image URL' }));
        prepared.push({ category, collection, contentId, cmsContent, description, metafields, images,
            unresolvedImages, imageComponentsMissingSource });
    }
    return { review, prepared, mapConflicts };
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
    // Row-based metafields avoid blank wide columns, which Matrixify treats as
    // deletion requests for that item's metafield.
    const headers = [
        'ID', 'Command', ...(includeBodyHtml ? ['Body HTML'] : []),
        'Metafield Namespace', 'Metafield Key', 'Metafield Value Type', 'Metafield Value',
    ];
    const rows = prepared.flatMap(item => {
        const fields = [
            ...item.metafields.map(field => ({ key: field.key, type: field.type, value: field.value })),
            ...item.images.map(field => ({ key: field.key, type: field.type, value: JSON.stringify(field.urls.map(imageFilename)) })),
        ];
        return (fields.length ? fields : [{ key: '', type: '', value: '' }]).map(field => {
            const row = { ID: item.collection.ID, Command: 'UPDATE' };
            if (includeBodyHtml && item.description) row['Body HTML'] = item.description;
            if (field.key) Object.assign(row, {
                'Metafield Namespace': 'custom', 'Metafield Key': field.key,
                'Metafield Value Type': field.type, 'Metafield Value': field.value,
            });
            return row;
        });
    });
    return { headers, rows };
}
function writeWorkbook(file, sheetName, headers, rows) {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers, skipHeader: false });
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    XLSX.writeFile(workbook, file);
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
            for (const component of componentKeys(content.components)) {
                const value = component.items.filter(item => !isDescriptionProperty(component, item)).map(propertyHtml).filter(Boolean).join('\n');
                if (value && baseKeys.has(component.metafieldKey)) localeRows.push({ Entity: 'Collection', 'Entity Handle': handle,
                    Field: `Metafield: custom.${component.metafieldKey}`, [translationColumn]: value });
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
    const unresolvedImages = [];
    const missingImageSources = [];
    for (const row of built.review) {
        if (!row.ContentId || !row.CMSFound) continue;
        const content = cmsByKey.get(key(row.ContentId, row.Culture));
        if (!content) continue;
        for (const component of componentKeys(content.components)) {
            const textItems = component.items.filter(item => !isDescriptionProperty(component, item) && propertyHtml(item));
            if (textItems.length) mapRows.push({ CategoryID: row.CategoryID, Culture: row.Culture,
                ContentId: row.ContentId, ShopifyID: row.Status === 'ready' ? row.ShopifyID : '',
                ShopifyHandle: row.Status === 'ready' ? row.ShopifyHandle : '', Component: component.componentType || 'root',
                ComponentOrder: component.order, Namespace: 'custom', Key: component.metafieldKey,
                Type: 'rich_text_field', SourceRows: textItems.map(item => item.sourceRow).join(','), Status: row.Status });
            const imageItems = component.items.filter(item => IMAGE_PROPERTIES.test(clean(item.propertyName)) && isHttpUrl(clean(item.value)));
            const imageUrls = [...new Set(imageItems.map(item => clean(item.value)))];
            if (imageUrls.length) mapRows.push({ CategoryID: row.CategoryID, Culture: row.Culture,
                ContentId: row.ContentId, ShopifyID: row.Status === 'ready' ? row.ShopifyID : '',
                ShopifyHandle: row.Status === 'ready' ? row.ShopifyHandle : '', Component: component.componentType || 'root',
                ComponentOrder: component.order, Namespace: 'custom', Key: `${component.metafieldKey}_images`,
                Type: 'list.file_reference', SourceRows: imageItems.map(item => item.sourceRow).join(','), Status: row.Status });
            for (const image of component.items.filter(item => IMAGE_PROPERTIES.test(clean(item.propertyName)) && clean(item.value) && !isHttpUrl(clean(item.value)))) {
                unresolvedImages.push({ CategoryID: row.CategoryID, Culture: row.Culture, ContentId: row.ContentId,
                    Component: component.componentType, Property: image.propertyName, SourceRow: image.sourceRow,
                    Reason: 'image value is not a direct HTTP(S) URL' });
            }
            if (/image|picture/i.test(component.componentType) && !imageUrls.length) missingImageSources.push({
                CategoryID: row.CategoryID, Culture: row.Culture, ContentId: row.ContentId,
                Component: component.componentType, SourceRow: component.sourceOrder,
                Reason: 'CMS image component has no directly resolvable image URL',
            });
        }
    }
    return { ...built, importable, translationData, mapRows,
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
        console.log('Usage: npm run build:fyrklovern-collection-content -- --categories=<xlsx> --cms=<csv> --content-map=<json> --shopify=<xlsx> [--approved-map=<json>] [--approve-url-candidates=true] [--output-dir=<dir>]');
        console.log('Approval JSON: an array, {"mappings": [...]}, or this command\'s mapping_report.json. Set ManualApproval="Approved"; use ShopifyID or CandidateShopifyID as the target.');
        return null;
    }
    const required = ['categories', 'cms', 'content-map', 'shopify'];
    const missing = required.filter(name => !args[name]);
    if (missing.length) throw new Error(`Usage: npm run build:fyrklovern-collection-content -- --categories=<xlsx> --cms=<csv> --content-map=<json> --shopify=<xlsx> [--approved-map=<json>] [--output-dir=<dir>] (missing: ${missing.join(', ')})`);
    const categoryData = readCategoryWorkbook(path.resolve(args.categories));
    const cmsCsv = readCmsCsv(path.resolve(args.cms));
    const cms = normalizeCms(cmsCsv.records, cmsCsv.headers);
    const contentMap = contentMapLookup(path.resolve(args['content-map']));
    const collections = readCollectionRows(path.resolve(args.shopify));
    const approvalRows = loadApprovals(args['approved-map'] ? path.resolve(args['approved-map']) : null);
    const normalizedContentMap = normalizeContentMap(readJson(path.resolve(args['content-map'])));
    const cmsContentIds = new Set(cms.contents.map(item => item.contentId));
    const matchingReview = buildMappingReview({ categoryData, collections, approvedMap: approvalRows,
        contentMap: normalizedContentMap, cmsContentIds });
    const autoApprovedRows = /^(true|yes)$/i.test(String(args['approve-url-candidates'] || ''))
        ? approveUrlCandidates(matchingReview) : [];
    const effectiveApprovalRows = [...approvalRows, ...autoApprovedRows];
    const approvals = approvedLookup(effectiveApprovalRows);
    const artifacts = buildArtifacts({ categoryData, collections, contentMap, cms, approvals, matchingReview });
    const outputDir = path.resolve(args['output-dir'] || 'outputs/Fyrklovern/Matrixify files/Collections/Content updates');
    const reportPath = path.join(outputDir, 'Collection content - mapping and QA report.json');
    if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length) {
        throw new Error(`Refusing to overwrite non-empty output directory: ${outputDir}`);
    }
    fs.mkdirSync(outputDir, { recursive: true });
    const outputs = [];
    if (autoApprovedRows.length) {
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
            '1. Create Shopify collection metafield definitions for every key/type in Collection content - mapping and QA report.json.\n' +
            '2. If Collection images - Matrixify Files import.xlsx exists, import its Files sheet first and confirm success.\n' +
            '3. Import Collection content - Matrixify update.xlsx and, if present, Collection metafields only - Matrixify update.xlsx (Collections sheets). Both contain UPDATE rows; metafields are row-based to avoid clearing omitted fields.\n' +
            '4. Import the Collection translations - <language>.xlsx workbooks for enabled Shopify languages.\n\n' +
            'No Shopify API calls or imports are performed by this script.\n', 'utf8');
        outputs.push(path.basename(instructionsPath));
    }
    const report = {
        schemaVersion: 1, generatedAt: new Date().toISOString(), mode: 'offline Matrixify files; no Shopify API calls',
        summary: {
            localizedCategories: artifacts.review.length,
            readyRows: artifacts.prepared.length,
            approvedSwedishCollections: artifacts.importable.length,
            mappingStatuses: artifacts.review.reduce((counts, row) => ({ ...counts, [row.Status]: (counts[row.Status] || 0) + 1 }), {}),
            textMetafields: artifacts.mapRows.filter(row => row.Type === 'rich_text_field').length,
            imageListMetafields: artifacts.mapRows.filter(row => row.Type === 'list.file_reference').length,
            unresolvedImageValues: artifacts.unresolvedImages.length,
            imageComponentsWithoutDirectSource: artifacts.missingImageSources.length,
            outputs,
        },
        assumptions: [
            'Only explicitly approved CategoryID/Culture to ShopifyID rows are importable.',
            'The unique sv-SE StoreAPI ContentId for a CategoryID is reused to look up the other CMS locales.',
            'Metafield definitions must be created in Shopify before importing these values.',
            'Only CMS image/source properties containing direct HTTP(S) URLs are treated as images.',
        ],
        approval: {
            mode: autoApprovedRows.length ? 'all unambiguous exact-URL candidates explicitly approved by CLI flag' : 'approval map only',
            approvedUrlCandidateCount: autoApprovedRows.length,
            approvalMapRows: effectiveApprovalRows.length,
        },
        review: artifacts.review,
        metafieldMapping: artifacts.mapRows,
        unresolvedImages: artifacts.unresolvedImages,
        imageComponentsMissingSource: artifacts.missingImageSources,
        cmsCsvDiagnostics: cmsCsv.diagnostics || null,
        importReady: artifacts.importable.length > 0,
        filesImportFirst: outputs.includes('01_files.xlsx'),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${report.summary.readyRows} approved locale rows; ${report.summary.approvedSwedishCollections} Swedish collection imports are ready.`);
    console.log(`Review report: ${reportPath}`);
    if (!report.importReady) console.log('No import workbooks were emitted because no Swedish mappings passed approval and validation.');
    return report;
}

module.exports = {
    TEXT_PROPERTIES, LOCALES, key, slug, propertyHtml, isDescriptionProperty, collectionDescription, componentKeys, readCollectionRows,
    loadApprovals, approvedLookup, approveUrlCandidates, contentMapLookup, buildPlan, matrixifyRows,
    buildArtifacts, parseArgs, main,
};
if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
