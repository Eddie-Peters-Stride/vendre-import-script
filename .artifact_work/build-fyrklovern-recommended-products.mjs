import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));
const { FIELD, readRows, buildRecommendedProducts } = require('./src/importers/fyrklovern/recommended-products-mapping');
const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('='))
    .map(arg => { const split = arg.indexOf('='); return [arg.slice(2, split), arg.slice(split + 1)]; }));
const relations = path.resolve(args.relations || 'C:/Users/Eddie Peters/Desktop/Fyrklövern/fyrklovern_relaterade_artiklar_,med_sortorder.xlsx');
if (!args['live-products']) throw new Error('Pass --live-products=<fresh Shopify Products export.xlsx or CSV>.');
const liveProducts = path.resolve(args['live-products']);
const outputDir = path.resolve(args['output-dir'] || path.join(root, 'outputs/Fyrklovern/Matrixify files/Products/Relations'));
const relationRows = readRows(relations, 'Sheet1');
const result = buildRecommendedProducts(relationRows, readRows(liveProducts, 'Products'));
if (result.errors.length) throw new Error(`Recommendation mapping failed:\n${result.errors.join('\n')}`);

const headers = ['Handle', 'Variant SKU [ID]', 'Command', FIELD];
const workbook = Workbook.create();
const sheet = workbook.worksheets.add('Products');
sheet.getRangeByIndexes(0, 0, result.rows.length + 1, headers.length).values =
    [headers, ...result.rows.map(row => headers.map(header => row[header]))];
for (let i = 0; i < headers.length; i++) {
    sheet.getRangeByIndexes(0, i, result.rows.length + 1, 1).format.columnWidth =
        headers[i] === 'Handle' ? 52 : headers[i] === FIELD ? 95 : 19;
}
sheet.getRangeByIndexes(0, 0, result.rows.length + 1, headers.length).format.font = { name: 'Arial', size: 11 };
sheet.getRangeByIndexes(0, 0, 1, headers.length).format =
    { fill: '#17365D', font: { name: 'Arial', bold: true, color: '#FFFFFF' }, rowHeight: 27 };
workbook.recalculate();
await fs.mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, 'Recommended products - Matrixify update.xlsx');
await (await SpreadsheetFile.exportXlsx(workbook)).save(output);
await fs.rm(`${output}.inspect.ndjson`, { force: true });

const statusCounts = Object.fromEntries([...new Set(result.review.map(item => item.status))].map(status =>
    [status, result.review.filter(item => item.status === status).length]));
const report = {
    relations, liveProducts, output,
    sourceRows: relationRows.length,
    sourceOwnerCount: result.sourceOwnerCount,
    liveProductCount: result.liveProductCount,
    statusCounts,
    updatedProducts: result.rows.length,
    updatesWithMissingTargets: result.review.filter(item => item.status === 'update' && item.unresolvedArticles.length).length,
    unresolvedTargetArticles: [...new Set(result.review.flatMap(item => item.unresolvedArticles || []))].sort(),
    review: result.review,
};
await fs.writeFile(path.join(outputDir, 'Recommended products - mapping review.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Wrote ${result.rows.length} changed recommendation updates; ${statusCounts['already current'] || 0} already current; ${statusCounts['no linked products in live Shopify export'] || 0} left unchanged because no target exists in the live export.`);
