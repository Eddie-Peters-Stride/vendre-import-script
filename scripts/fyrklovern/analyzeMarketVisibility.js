const path = require('path');
const XLSX = require('xlsx');

const visibilityFile = process.argv[2]
    || 'C:\\Users\\Eddie Peters\\Desktop\\Fyrklövern\\fyrklovern_hidden_visible_products.xlsx';
const shopifyExportFile = process.argv[3]
    || path.join('exports', 'Export_2026-09-29_101146 (1).xlsx');
const newProductsFile = process.argv[4]
    || path.join('results', 'fyrklovern', 'fyrklovern-matrixify-new-products.xlsx');

function readRows(filePath, sheetName) {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[sheetName || workbook.SheetNames[0]];
    if (!sheet) throw new Error(`Sheet not found: ${sheetName || '(first sheet)'}`);
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

const visibilityRows = readRows(visibilityFile);
const productRows = [
    ...readRows(shopifyExportFile, 'Products'),
    ...readRows(newProductsFile, 'Products'),
];

const visibilityByArticleAndList = new Map(
    visibilityRows.map((row) => [`${row.ArticleNumber}:${row.ListName}`, row.HideProduct === true])
);
const shopifySkus = [...new Set(productRows
    .map((row) => String(row['Variant SKU'] || '').trim())
    .filter(Boolean))];

function summaryFor(listName) {
    const output = { included: 0, excluded: 0, unmatched: 0 };
    for (const sku of shopifySkus) {
        const hidden = visibilityByArticleAndList.get(`${sku}:${listName}`);
        if (hidden === undefined) output.unmatched += 1;
        else if (hidden) output.excluded += 1;
        else output.included += 1;
    }
    return output;
}

function visibleForEvery(listNames) {
    const result = { included: 0, excluded: 0, unmatched: 0 };
    for (const sku of shopifySkus) {
        const flags = listNames.map((list) => visibilityByArticleAndList.get(`${sku}:${list}`));
        if (flags.some((flag) => flag === undefined)) result.unmatched += 1;
        else if (flags.every((flag) => flag === false)) result.included += 1;
        else result.excluded += 1;
    }
    return result;
}

const marketLists = {
    Sweden: ['Standard'],
    Norway: ['NO'],
    Denmark: ['DK'],
    Finland: ['FI'],
    Germany: ['DE'],
    'EU generic': ['EU'],
    Netherlands: ['NL'],
    Austria: ['AT'],
};

console.log(`Shopify products (unique SKUs): ${shopifySkus.length}`);
for (const [market, [list]] of Object.entries(marketLists)) {
    console.log(`${market} (${list}):`, summaryFor(list));
}
console.log('EU combined, only products visible in every source EU list (FI, DE, EU, NL, AT):',
    visibleForEvery(['FI', 'DE', 'EU', 'NL', 'AT']));
