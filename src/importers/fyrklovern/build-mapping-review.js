#!/usr/bin/env node
/** Offline Norce-to-Shopify mapping review; never writes to Shopify. */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { readCategoryWorkbook, readCmsCsv, normalizeCms, normalizeContentMap, clean } = require('./norce-source-ingestion');

function normalizePath(value) {
    return clean(value).replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/, 1)[0]
        .replace(/^\/+|\/+$/g, '').replace(/\/+/g, '-').toLowerCase();
}
function collectionRows(file) {
    const book = XLSX.readFile(file);
    const sheet = book.SheetNames.find(n => n.toLowerCase() === 'collections');
    if (!sheet) throw new Error('Shopify export has no Collections sheet.');
    return XLSX.utils.sheet_to_json(book.Sheets[sheet], { defval: '' })
        .filter(row => row['Top Row'] === true || String(row['Top Row']).toLowerCase() === 'true');
}
function readSuppliedContentMap(file) {
    if (!file) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw?.results)) {
        const culture = raw.culture || raw.config?.culture || '';
        return normalizeContentMap(raw.results.filter(row => row.category?.CategoryID && row.category?.ContentId).map(row => ({
            categoryId: row.category.CategoryID || row.requestedId,
            culture: row.culture || culture,
            contentId: row.category.ContentId,
            source: 'explicit StoreAPI fetch output',
        })));
    }
    if (raw?.categoryPreview?.categoryId && raw.categoryPreview.contentId) {
        const preview = raw.categoryPreview;
        return normalizeContentMap([{ categoryId: preview.categoryId, culture: preview.culture, contentId: preview.contentId, source: preview.contentIdSource || 'supplied audit report' }]);
    }
    return normalizeContentMap(raw).filter(item => item.contentId);
}
function buildMappingReview({ categoryData, collections, approvedMap = [], contentMap = [], cmsContentIds = null, categoryId = '149', culture = 'sv-SE' }) {
    const relationsByKey = new Map();
    for (const relation of contentMap) {
        const key = `${relation.categoryId}\0${relation.culture}`;
        if (!relationsByKey.has(key)) relationsByKey.set(key, new Map());
        if (relation.contentId) relationsByKey.get(key).set(relation.contentId, relation);
    }
    const contentMapConflicts = [...relationsByKey].filter(([, values]) => values.size > 1)
        .map(([key, values]) => ({ key, contentIds: [...values.keys()], reason: 'conflicting supplied ContentId relationships; excluded' }));
    const approvalGroups = new Map();
    const approvalRowCounts = new Map();
    for (const item of approvedMap) {
        const key = `${item.categoryId ?? item.CategoryID}\0${item.culture ?? item.Culture}`;
        approvalRowCounts.set(key, (approvalRowCounts.get(key) || 0) + 1);
        if (!approvalGroups.has(key)) approvalGroups.set(key, new Set());
        const id = clean(item.shopifyId ?? item.ShopifyID);
        if (id) approvalGroups.get(key).add(id);
    }
    const approvedMapConflicts = [...approvalGroups].filter(([, ids]) => ids.size > 1)
        .map(([key, ids]) => ({ key, shopifyIds: [...ids], reason: 'multiple approved target IDs for one category/culture; excluded' }));
    const approvedIds = new Map([...approvalGroups].filter(([, ids]) => ids.size === 1).map(([key, ids]) => [key, [...ids][0]]));
    const byPath = new Map();
    const byTitle = new Map();
    const idCounts = new Map();
    const handleCounts = new Map();
    for (const row of collections) {
        const id = clean(row.ID);
        const handle = clean(row.Handle).toLowerCase();
        if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
        if (handle) handleCounts.set(handle, (handleCounts.get(handle) || 0) + 1);
        const p = normalizePath(row.Handle);
        if (p) byPath.set(p, [...(byPath.get(p) || []), row]);
        const title = clean(row.Title).toLocaleLowerCase();
        if (title) byTitle.set(title, [...(byTitle.get(title) || []), row]);
    }
    const categoryConflicts = new Set(categoryData.diagnostics.categoryConflicts.map(x => x.key));
    const permalinkConflicts = new Set(categoryData.diagnostics.permalinkConflicts.map(x => x.key));
    const canonical = categoryData.categories.map(category => {
        const key = category.key;
        const originalUrl = category.permalinks[0] && (category.permalinks[0].Link || category.permalinks[0].Url || category.permalinks[0].Permalink) || '';
        const pathKey = normalizePath(originalUrl);
        const exact = pathKey ? (byPath.get(pathKey) || []) : [];
        const approvalConflict = approvedMapConflicts.some(item => item.key === key);
        const approvedId = approvedIds.get(key);
        const approvedCollection = approvedId && collections.find(row => String(row.ID) === approvedId);
        const title = clean(category.source.name);
        const titleMatches = byTitle.get(title.toLocaleLowerCase()) || [];
        const relationGroup = relationsByKey.get(key);
        const relationshipConflict = relationGroup?.size > 1;
        const contentId = relationshipConflict ? '' : (relationGroup ? [...relationGroup.keys()][0] : '');
        const conflicted = categoryConflicts.has(key) || permalinkConflicts.has(key);
        let status = 'unmatched';
        let match = null;
        if (approvalConflict) status = 'ambiguous - conflicting approved map';
        else if (approvedIds.has(key) && !approvedCollection) status = 'invalid approved mapping - unmatched Shopify ID';
        else if (approvalGroups.has(key) && !approvedIds.has(key)) status = 'invalid approved mapping - missing Shopify ID';
        else if (approvedCollection) {
            const validIdentity = clean(approvedCollection.ID) && clean(approvedCollection.Handle) &&
                idCounts.get(String(approvedCollection.ID)) === 1 && handleCounts.get(String(approvedCollection.Handle).toLowerCase()) === 1;
            if (validIdentity) { status = 'approved mapping'; match = approvedCollection; }
            else status = 'invalid approved mapping - Shopify identity issue';
        }
        else if (conflicted) status = 'ambiguous - source conflict';
        else if (exact.length === 1) {
            const target = exact[0];
            const badId = !clean(target.ID) || idCounts.get(String(target.ID)) > 1;
            const badHandle = !clean(target.Handle) || handleCounts.get(String(target.Handle).toLowerCase()) > 1;
            if (badId || badHandle) status = 'ambiguous - invalid or duplicate Shopify identity';
            else { status = 'URL candidate - manual approval required'; match = target; }
        }
        else if (exact.length > 1) status = 'ambiguous - duplicate Shopify handles';
        else if (titleMatches.length) status = 'title-only suggestion - unverified';
        const identityRow = match || approvedCollection || (exact.length === 1 ? exact[0] : null);
        return {
            CategoryID: category.categoryId, Culture: category.culture,
            NorceTitle: title, OriginalURL: originalUrl,
            ShopifyID: match ? String(match.ID) : '', ShopifyHandle: match ? match.Handle : '',
            ShopifyTitle: match ? match.Title : '', Status: status,
            TitleSuggestionCount: titleMatches.length,
            Candidate: Boolean(match), ManualApproval: status === 'URL candidate - manual approval required' ? 'Pending' : '',
            ContentId: contentId,
            ContentFound: cmsContentIds == null || !contentId ? '' : (cmsContentIds.has(contentId) ? 'Found' : 'Not found in supplied CMS export'),
            ContentRelationshipStatus: relationshipConflict ? 'ambiguous supplied mapping' : (contentId ? 'supplied mapping' : 'not supplied'),
            StoreAPIStatus: 'not fetched in this review run',
            ShopifyIdentityIssue: identityRow ? [
                idCounts.get(String(identityRow.ID)) > 1 ? 'duplicate Shopify ID' : '',
                handleCounts.get(String(identityRow.Handle).toLowerCase()) > 1 ? 'duplicate Shopify handle' : '',
                !clean(identityRow.ID) ? 'missing Shopify ID' : '', !clean(identityRow.Handle) ? 'missing Shopify handle' : '',
            ].filter(Boolean).join('; ') : '',
        };
    });
    const candidate149 = canonical.find(row => row.CategoryID === String(categoryId) && row.Culture === culture && row.Status === 'URL candidate - manual approval required');
    return {
        generatedAt: new Date().toISOString(), mode: 'offline review only; no Shopify writes',
        source: { canonicalShopifyCollectionCount: collections.length, norceLocalizedCategoryCount: canonical.length },
        explicitCandidate: candidate149 || null,
        mappings: canonical,
        diagnostics: categoryData.diagnostics,
        contentMapConflicts,
        approvedMapConflicts,
        approvedMapDuplicateCount: [...approvalRowCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
        shopifyIdentityDiagnostics: {
            missingIds: collections.map((row, index) => ({ row: index + 2, handle: row.Handle })).filter(item => !clean(collections[item.row - 2].ID)),
            missingHandles: collections.map((row, index) => ({ row: index + 2, id: row.ID })).filter(item => !clean(collections[item.row - 2].Handle)),
            duplicateIds: [...idCounts].filter(([, count]) => count > 1).map(([id, count]) => ({ id, count })),
            duplicateHandles: [...handleCounts].filter(([, count]) => count > 1).map(([handle, count]) => ({ handle, count })),
        },
    };
}
function writeMappingWorkbook(review, outputPath) {
    const wb = XLSX.utils.book_new();
    const mappingColumns = ['CategoryID','Culture','NorceTitle','OriginalURL','ShopifyID','ShopifyHandle','ShopifyTitle','Status','TitleSuggestionCount','Candidate','ManualApproval','ContentId','ContentFound','ContentRelationshipStatus','StoreAPIStatus','ShopifyIdentityIssue'];
    const summary = [
        ['Fyrklövern Norce to Shopify mapping review'],
        [`Offline review only. ${review.source.norceLocalizedCategoryCount} localized categories; ${review.source.canonicalShopifyCollectionCount} canonical Shopify collections. URL matches require manual approval; title-only matches are unverified. Content relationships are shown only when explicitly supplied.`],
        [], mappingColumns,
        ...review.mappings.map(row => mappingColumns.map(key => row[key] ?? '')),
    ];
    const mappingSheet = XLSX.utils.aoa_to_sheet(summary);
    mappingSheet['!cols'] = [12,12,24,38,18,38,24,42,18,14,20,40,32,32,28,34].map(wch => ({ wch }));
    mappingSheet['!freeze'] = { xSplit: 0, ySplit: 4, topLeftCell: 'A5', activePane: 'bottomLeft', state: 'frozen' };
    XLSX.utils.book_append_sheet(wb, mappingSheet, 'Mapping Review');
    const diagnostics = [
        ['Review diagnostics','Count / detail'],
        ['URL candidates requiring manual approval', review.mappings.filter(row => row.Status === 'URL candidate - manual approval required').length],
        ['Title-only suggestions (unverified)', review.mappings.filter(row => row.Status === 'title-only suggestion - unverified').length],
        ['Unmatched or ambiguous rows', review.mappings.filter(row => /unmatched|ambiguous/.test(row.Status)).length],
        ['Shopify rows missing ID', review.shopifyIdentityDiagnostics.missingIds.length],
        ['Shopify rows missing handle', review.shopifyIdentityDiagnostics.missingHandles.length],
        ['Duplicate Shopify IDs', review.shopifyIdentityDiagnostics.duplicateIds.length],
        ['Duplicate Shopify handles', review.shopifyIdentityDiagnostics.duplicateHandles.length],
        ['Conflicting supplied ContentId relationships', review.contentMapConflicts.length],
        ['Conflicting approved-map keys', review.approvedMapConflicts.length],
        ['Duplicate identical approved-map rows deduped', review.approvedMapDuplicateCount],
        [], ['Shopify source','Collections sheet; Top Row=true only'],
        ['Norce source','Categories localized/permalinks/structure workbook'],
        ['Content mapping','Only explicit supplied map rows are included; ContentFound is populated only when a CMS CSV is supplied.'],
        ['Safety','No Shopify writes or Matrixify imports are performed.'],
    ];
    const diagSheet = XLSX.utils.aoa_to_sheet(diagnostics);
    diagSheet['!cols'] = [{ wch: 42 }, { wch: 110 }];
    XLSX.utils.book_append_sheet(wb, diagSheet, 'Diagnostics');
    XLSX.writeFile(wb, outputPath);
}
function parseArgs(argv) {
    const args = {};
    for (const item of argv) { const m = item.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; }
    return args;
}
function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (!args.categories || !args.shopify) throw new Error('Usage: node build-mapping-review.js --categories=<xlsx> --shopify=<xlsx> [--content-map=<json>] [--cms=<csv>] [--json=<path>]');
    const data = readCategoryWorkbook(path.resolve(args.categories));
    const approvedMap = args['approved-map'] ? JSON.parse(fs.readFileSync(path.resolve(args['approved-map']), 'utf8')) : [];
    const contentMap = args['content-map'] ? readSuppliedContentMap(path.resolve(args['content-map'])) : [];
    const cmsCsv = args.cms ? readCmsCsv(path.resolve(args.cms)) : null;
    const cms = cmsCsv ? normalizeCms(cmsCsv.records, cmsCsv.headers) : null;
    const cmsContentIds = cms ? new Set(cms.contents.map(item => item.contentId)) : null;
    const review = buildMappingReview({ categoryData: data, collections: collectionRows(path.resolve(args.shopify)), approvedMap, contentMap, cmsContentIds });
    const output = path.resolve(args.json || 'outputs/Fyrklovern/Reports and source maps/Collection mapping review.json');
    const xlsxOutput = path.resolve(args.xlsx || 'outputs/Fyrklovern/Reports and source maps/Collection mapping review.xlsx');
    if (args.overwrite !== 'true') {
        const existing = [output, xlsxOutput].filter(file => fs.existsSync(file));
        if (existing.length) throw new Error(`Refusing to overwrite existing output(s): ${existing.join(', ')}; pass --overwrite=true`);
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.mkdirSync(path.dirname(xlsxOutput), { recursive: true });
    writeMappingWorkbook(review, xlsxOutput);
    fs.writeFileSync(output, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${review.mappings.length} localized mapping-review rows to ${output} and ${xlsxOutput}`);
    return review;
}
if (require.main === module) { try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; } }
module.exports = { normalizePath, collectionRows, readSuppliedContentMap, buildMappingReview, writeMappingWorkbook, parseArgs, main };
