import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));
const { OLD_FIELD, NEW_FIELD, readRows, buildFromFiles } = require('./src/importers/fyrklovern/product-collection-link-mapping');
const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('='))
    .map(arg => { const split = arg.indexOf('='); return [arg.slice(2, split), arg.slice(split + 1)]; }));
const categories = path.resolve(args.categories || 'C:/Users/Eddie Peters/Desktop/Fyrklövern/fyrklovern_custom_export.xlsx');
const collections = path.resolve(args.collections || path.join(root, 'exports/Export_2026-10-06_132403.xlsx'));
if (!args['live-products']) throw new Error('Pass --live-products=<fresh Shopify Products export.xlsx or CSV>.');
const liveProducts = path.resolve(args['live-products']);
const outputDir = path.resolve(args['output-dir'] || path.join(root, 'outputs/Fyrklovern/Matrixify files/Products/Collection link migration'));
const approvedMapPath = args['approved-map'] ? path.resolve(args['approved-map']) : '';
const approvedMap = approvedMapPath ? JSON.parse(await fs.readFile(approvedMapPath, 'utf8')) : {};
const result = buildFromFiles('', categories, collections, liveProducts, approvedMap);
if (result.errors.length) throw new Error(`Mapping failed:\n${result.errors.join('\n')}`);

const workbook = Workbook.create();
const sheet = workbook.worksheets.add('Products');
const includeIds = result.mapped.every(item => item.shopifyProductId);
const headers = [...(includeIds ? ['ID'] : []), 'Handle', 'Variant SKU [ID]', 'Command', NEW_FIELD, OLD_FIELD];
sheet.getRangeByIndexes(0, 0, result.rows.length + 1, headers.length).values =
    [headers, ...result.rows.map(row => headers.map(header => row[header]))];
for (let index = 0; index < headers.length; index++) {
    sheet.getRangeByIndexes(0, index, result.rows.length + 1, 1).format.columnWidth =
        headers[index] === 'Handle' ? 52 : headers[index] === OLD_FIELD ? 65 : headers[index] === NEW_FIELD ? 57 : 19;
}
sheet.getRangeByIndexes(0, 0, result.rows.length + 1, headers.length).format.font = { name: 'Arial', size: 11 };
sheet.getRangeByIndexes(0, 0, 1, headers.length).format = { fill: '#17365D', font: { name: 'Arial', bold: true, color: '#FFFFFF' }, rowHeight: 27 };
workbook.recalculate();
console.log((await workbook.inspect({ kind: 'table', range: `Products!A1:${includeIds ? 'F' : 'E'}5`, include: 'values', tableMaxRows: 5, tableMaxCols: headers.length, maxChars: 1800 })).ndjson);
await fs.mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, 'Fyrklovern product collection links - Matrixify update.xlsx');
await (await SpreadsheetFile.exportXlsx(workbook)).save(output);
await fs.rm(`${output}.inspect.ndjson`, { force: true });
const shopifyRows = readRows(collections, 'Collections').filter(row => String(row['Top Row']).toLowerCase() === 'true');
const stagedProducts = path.join(root, 'outputs/Fyrklovern/Matrixify files/Products/Fyrklovern products - updated Matrixify import.xlsx');
const stagedByExternalId = new Map(readRows(stagedProducts, 'Products').map(row => [
    String(row['Metafield: custom.external_id [single_line_text_field]'] || '').trim(), row,
]));
const shopifyByHandle = new Map(shopifyRows.map(row => [String(row.Handle).trim(), row]));
const unresolvedGroups = new Map();
for (const item of result.unresolved.filter(item => !item.reason.includes('live Shopify export') && !item.reason.includes('Variant SKU for Matrixify'))) {
    if (!unresolvedGroups.has(item.sourceCategoryId)) unresolvedGroups.set(item.sourceCategoryId, []);
    unresolvedGroups.get(item.sourceCategoryId).push(item);
}
const unresolvedCategoryReview = [...unresolvedGroups].map(([sourceCategoryId, items]) => {
    const names = [...new Set(items.flatMap(item => {
        try { return JSON.parse(item.sourceCollectionName); } catch { return []; }
    }).filter(Boolean))];
    const exactTitleCandidates = shopifyRows.filter(row => names.some(name =>
        String(row.Title).trim().toLocaleLowerCase() === String(name).trim().toLocaleLowerCase()
    )).map(row => ({
        shopifyId: String(row.ID), handle: String(row.Handle), title: String(row.Title),
        assignedProductCount: items.filter(item => item.assignedCollections.split(',').map(value => value.trim()).includes(String(row.Handle))).length,
    }));
    const membershipCounts = new Map();
    for (const item of items) {
        const staged = stagedByExternalId.get(item.productExternalId);
        for (const handle of new Set(String(staged?.['Custom Collections'] || '').split(',').map(value => value.trim()).filter(Boolean))) {
            if (shopifyByHandle.has(handle)) membershipCounts.set(handle, (membershipCounts.get(handle) || 0) + 1);
        }
    }
    const membershipCandidates = [...membershipCounts].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([handle, count]) => ({
        shopifyId: String(shopifyByHandle.get(handle).ID), handle,
        title: String(shopifyByHandle.get(handle).Title), stagedProductCount: count,
    }));
    return { sourceCategoryId, productCount: items.length, names, exactTitleCandidates, membershipCandidates,
        exampleProductHandles: items.slice(0, 5).map(item => item.productHandle) };
});
const review = {
    categories, collections, liveProducts, approvedMapPath, output,
    oldField: OLD_FIELD, newField: NEW_FIELD,
    categoryIdSource: 'dynamicfields / Collection category ID / sv-SE / ArticleNumber',
    productIdentitySource: 'fresh Shopify Products export / Handle + Variant SKU + custom.external_id',
    selectedProducts: result.selectedCount,
    mappedProducts: result.mapped.length,
    unresolvedProducts: result.unresolved.length,
    shopifyIdsAvailable: includeIds,
    sourceIdDiscrepancies: [...result.mapped, ...result.unresolved].filter(item =>
        item.shopifyOldCategoryId && item.shopifyOldCategoryId !== item.sourceCategoryId
    ).map(item => ({ handle: item.productHandle, articleNumber: item.productExternalId,
        dynamicFieldsCategoryId: item.sourceCategoryId, shopifyTextCategoryId: item.shopifyOldCategoryId })),
    unresolvedCategoryIds: [...new Set(result.unresolved.filter(item => !item.reason.includes('live Shopify export') && !item.reason.includes('Variant SKU for Matrixify')).map(item => item.sourceCategoryId))].sort((a, b) => Number(a) - Number(b)),
    unresolvedCategoryReview,
    mapped: result.mapped,
    unresolved: result.unresolved,
};
await fs.writeFile(path.join(outputDir, 'Fyrklovern product collection links - mapping review.json'), JSON.stringify(review, null, 2) + '\n');
if (!approvedMapPath && unresolvedCategoryReview.length) {
    const template = Object.fromEntries(unresolvedCategoryReview.map(item => [item.sourceCategoryId, '']));
    await fs.writeFile(path.join(outputDir, 'Fyrklovern product collection links - approved map template.json'), JSON.stringify(template, null, 2) + '\n');
}
console.log(`Wrote ${result.rows.length} product updates verified by current Shopify SKU and handle; ${result.unresolved.length} live products excluded for missing category mappings.`);
