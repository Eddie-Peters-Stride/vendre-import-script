#!/usr/bin/env node
/**
 * Build a Matrixify update for Fyrklövern recommended- and family-product
 * metafields. Handles are used for owners and references so newly imported
 * products do not depend on a later Shopify product export.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { buildHandleByProductId } = require('../../src/importers/fyrklovern/productdata');

const FYRKLOVERN_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'Fyrklövern');
const DEFAULT_INPUT = path.join(FYRKLOVERN_DIR, 'fyrklovern_custom_export.xlsx');
const DEFAULT_LATEST_PRODUCTDATA = path.join(FYRKLOVERN_DIR, 'fyrklovern_productdata_newexport.xlsx');
const DEFAULT_PERMALINKS = path.join(FYRKLOVERN_DIR, 'fyrklovern_productpermalinks.xlsx');
const OUTPUT_FILE = path.resolve(__dirname, '../../outputs/fyrklovern-relations/fyrklovern-matrixify-product-references-update.xlsx');
const RELATED_FIELD = 'Metafield: custom.recommended_products [list.product_reference]';
const FAMILY_FIELD = 'Metafield: custom.family_products [list.product_reference]';

const text = value => String(value ?? '').trim();
const unique = values => [...new Set(values.filter(Boolean))];
function add(map, key, values) { map.set(key, unique([...(map.get(key) || []), ...values])); }
function argument(name, fallback) {
    const prefix = `--${name}=`;
    const value = process.argv.find(item => item.startsWith(prefix));
    return value ? path.resolve(value.slice(prefix.length)) : fallback;
}
function rows(workbook, sheetName) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) throw new Error(`Worksheet "${sheetName}" was not found. Available sheets: ${workbook.SheetNames.join(', ')}`);
    return XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });
}

function main() {
    const inputPath = argument('input', DEFAULT_INPUT);
    const latestProductdataPath = argument('latest-productdata', DEFAULT_LATEST_PRODUCTDATA);
    const permalinksPath = argument('permalinks', DEFAULT_PERMALINKS);
    const outputPath = argument('output', OUTPUT_FILE);
    for (const filePath of [inputPath, latestProductdataPath, permalinksPath]) {
        if (!fs.existsSync(filePath)) throw new Error(`Input file not found: ${filePath}`);
    }
    const source = XLSX.readFile(inputPath, { raw: false });
    const productData = rows(source, 'productdata (standard sv-SE)');
    // The latest export contains the 16 newly imported products on sheet1,
    // while the full export carries the relations sheet. Overlay by article so
    // family membership and handles use current source data.
    const latestWorkbook = XLSX.readFile(latestProductdataPath, { raw: false });
    const latestRows = XLSX.utils.sheet_to_json(latestWorkbook.Sheets[latestWorkbook.SheetNames[0]], { defval: '', raw: false });
    const productDataByArticle = new Map(productData.map(product => [text(product.ArticleNumber), product]));
    // The new-export file is intentionally leaner than the full export. Only
    // append new articles; replacing existing rows would discard their family
    // code and make family_products appear empty.
    for (const product of latestRows) {
        const article = text(product.ArticleNumber);
        if (article && !productDataByArticle.has(article)) productDataByArticle.set(article, product);
    }
    const currentProductData = [...productDataByArticle.values()].filter(product => text(product.ArticleNumber));
    const relations = rows(source, 'relations');
    const handleByProductId = buildHandleByProductId(rows(XLSX.readFile(permalinksPath, { raw: false }), 'Sheet1'));
    const handleByArticle = new Map(currentProductData.map(product => [
        text(product.ArticleNumber), handleByProductId[text(product.ProductID)],
    ]).filter(([article, handle]) => article && handle));

    const relatedByArticle = new Map();
    for (const relation of relations) {
        const article = text(relation['Huvudprodukt Artikelnummer']);
        const linked = unique(text(relation['Kopplade produkter Artikelnummer']).split(';').map(text).filter(value => value && value !== article));
        if (article && linked.length) add(relatedByArticle, article, linked);
    }
    const familyMembers = new Map();
    for (const product of currentProductData) {
        const article = text(product.ArticleNumber);
        const family = text(product['Item Family Code']);
        if (article && family && family.toUpperCase() !== 'NULL') add(familyMembers, family, [article]);
    }
    const familyByArticle = new Map();
    for (const members of familyMembers.values()) {
        if (members.length > 1) for (const article of members) add(familyByArticle, article, members.filter(other => other !== article));
    }

    const unresolved = new Set();
    const referenceHandles = (articles, owner) => unique(articles.map(article => {
        const handle = handleByArticle.get(article);
        if (!handle) unresolved.add(article);
        return handle;
    }).filter(handle => handle && handle !== owner));
    const updateRows = [];
    for (const article of unique([...relatedByArticle.keys(), ...familyByArticle.keys()])) {
        const handle = handleByArticle.get(article);
        if (!handle) { unresolved.add(article); continue; }
        const recommended = referenceHandles(relatedByArticle.get(article) || [], handle);
        const family = referenceHandles(familyByArticle.get(article) || [], handle);
        if (recommended.length || family.length) updateRows.push({
            Handle: handle, Command: 'MERGE',
            [RELATED_FIELD]: recommended.join(', '),
            [FAMILY_FIELD]: family.join(', '),
        });
    }
    updateRows.sort((a, b) => a.Handle.localeCompare(b.Handle));
    const worksheet = XLSX.utils.json_to_sheet(updateRows, { header: ['Handle', 'Command', RELATED_FIELD, FAMILY_FIELD] });
    worksheet['!cols'] = [{ wch: 55 }, { wch: 12 }, { wch: 72 }, { wch: 72 }];
    worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };
    worksheet['!autofilter'] = { ref: `A1:D${updateRows.length + 1}` };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    XLSX.writeFile(workbook, outputPath, { bookType: 'xlsx' });
    console.log(JSON.stringify({ output: outputPath, totalRows: updateRows.length, unresolvedArticleCount: unresolved.size, unresolvedArticles: [...unresolved].sort() }, null, 2));
}
main();
