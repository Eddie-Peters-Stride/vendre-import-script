const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const visibilityFile = process.argv[2]
    || 'C:\\Users\\Eddie Peters\\Desktop\\Fyrklövern\\fyrklovern_hidden_visible_products.xlsx';
const baseProductsFile = process.argv[3]
    || path.join('exports', 'Export_2026-09-29_101146 (1).xlsx');
const newProductsFile = process.argv[4]
    || path.join('outputs', 'Fyrklovern', 'Matrixify files', 'Products', 'Fyrklovern new products - Matrixify import.xlsx');
const outputFile = process.argv[5]
    || path.join('outputs', 'Fyrklovern', 'Matrixify files', 'Products', 'Fyrklovern product market inclusion - Matrixify update.xlsx');

function readRows(filePath, sheetName) {
    const workbook = XLSX.readFile(filePath);
    const worksheet = workbook.Sheets[sheetName || workbook.SheetNames[0]];
    if (!worksheet) throw new Error(`Sheet not found: ${sheetName || '(first sheet)'}`);
    return XLSX.utils.sheet_to_json(worksheet, { defval: '' });
}

const visibilityRows = readRows(visibilityFile);
const productRows = [
    ...readRows(baseProductsFile, 'Products'),
    ...readRows(newProductsFile, 'Products'),
];

const hiddenByArticleAndList = new Map(
    visibilityRows.map((row) => [`${row.ArticleNumber}:${row.ListName}`, row.HideProduct === true])
);

const catalogLists = {
    Denmark: 'DK',
    EU: 'EU',
    Norway: 'NO',
    Sweden: 'Standard',
};

// One row per Shopify product. Matrixify applies catalog inclusion at product level,
// so do not include image-only rows or duplicate variant rows in this update file.
const productsBySku = new Map();
for (const row of productRows) {
    const sku = String(row['Variant SKU'] || '').trim();
    const handle = String(row.Handle || '').trim();
    if (sku && handle && !productsBySku.has(sku)) productsBySku.set(sku, handle);
}

const records = [...productsBySku.entries()]
    .map(([sku, handle]) => {
        const record = { Handle: handle, 'Variant SKU': sku };
        for (const [catalogName, listName] of Object.entries(catalogLists)) {
            const hidden = hiddenByArticleAndList.get(`${sku}:${listName}`);
            if (hidden === undefined) {
                throw new Error(`No ${listName} visibility record for Shopify SKU ${sku}`);
            }
            record[`Included / ${catalogName}`] = !hidden;
        }
        return record;
    })
    .sort((a, b) => Number(a['Variant SKU']) - Number(b['Variant SKU']));

const headers = [
    'Handle',
    'Variant SKU',
    'Included / Denmark',
    'Included / EU',
    'Included / Norway',
    'Included / Sweden',
];
const worksheet = XLSX.utils.json_to_sheet(records, { header: headers });
worksheet['!autofilter'] = { ref: `A1:F${records.length + 1}` };
worksheet['!cols'] = [
    { wch: 46 }, { wch: 16 }, { wch: 22 }, { wch: 18 }, { wch: 21 }, { wch: 21 },
];

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
XLSX.writeFile(workbook, outputFile, { bookType: 'xlsx' });

const totals = Object.fromEntries(Object.keys(catalogLists).map((catalogName) => [
    catalogName,
    records.filter((record) => record[`Included / ${catalogName}`]).length,
]));
console.log(`Wrote ${records.length} product updates to ${outputFile}`);
console.log(JSON.stringify(totals));
