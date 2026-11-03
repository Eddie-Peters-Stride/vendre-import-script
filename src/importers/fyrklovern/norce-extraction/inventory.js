const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { readCategoryWorkbook, parseDelimited, clean } = require('../norce-source-ingestion');

const PRODUCT_EXPORT = 'exports/Shopify_Products_2026-10-21.csv';
const LEGACY_PRODUCT_EXPORT = 'exports/Export_2026-09-29_101146 (1).xlsx';
const COLLECTION_EXPORT = 'exports/Export_2026-10-22_142102.xlsx';
const APPROVED_CATEGORY_MAP = 'outputs/Fyrklovern/Matrixify files/Collections/Content updates/Collection content - approved URL mappings.json';

function rows(file, sheet) {
  if (!fs.existsSync(file)) throw new Error(`Source export does not exist: ${file}`);
  const workbook = XLSX.readFile(file, { raw: false });
  if (!workbook.Sheets[sheet]) throw new Error(`Expected ${sheet} sheet in ${file}`);
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { defval: '', raw: false });
}
function productInventoryXlsx(file) {
  const byArticle = new Map();
  const conflicts = [];
  const mismatches = [];
  for (const row of rows(path.resolve(file), 'Products')) {
    const sku = clean(row['Variant SKU']);
    const external = clean(row['Metafield: custom.external_id [single_line_text_field]']);
    if (external && sku && external !== sku) {
      mismatches.push({ externalId: external, variantSku: sku, shopifyProductId: clean(row.ID) });
    }
    const productId = clean(row.ID);
    if (!productId) continue;
    for (const [article, source] of [[external, 'external_id'], [sku, 'variant_sku']]) {
      if (!article) continue;
      const existing = byArticle.get(article);
      if (existing && existing.shopifyProductId !== productId) {
        conflicts.push({ articleNumber: article, productIds: [existing.shopifyProductId, productId] });
        byArticle.delete(article);
        continue;
      }
      if (!existing) byArticle.set(article, { articleNumber: article, shopifyProductId: productId, shopifyHandle: clean(row.Handle), variantSku: sku, source });
      else if (source === 'external_id') existing.source = 'external_id';
    }
  }
  const rejected = new Set(conflicts.map(item => item.articleNumber));
  return { records: [...byArticle.values()].filter(item => !rejected.has(item.articleNumber)), conflicts, mismatches };
}
function productInventoryCsv(file = PRODUCT_EXPORT, historicalFile = LEGACY_PRODUCT_EXPORT) {
  if (!fs.existsSync(file)) throw new Error(`Shopify Products CSV does not exist: ${file}`);
  const parsed = parseDelimited(fs.readFileSync(file, 'utf8'), ',');
  const headers = parsed.shift() || [];
  const header = predicate => headers.findIndex(predicate);
  const handleIndex = header(value => /^handle$/i.test(value));
  const skuIndex = header(value => /^variant sku$/i.test(value));
  const externalIndex = header(value => /external.?id/i.test(value));
  if ([handleIndex, skuIndex, externalIndex].some(index => index < 0)) throw new Error(`Shopify Products CSV requires Handle, Variant SKU and External ID headers: ${file}`);

  const historical = new Map();
  const articleValue = value => clean(value).replace(/^'(?=\d)/, '');
  for (const row of rows(path.resolve(historicalFile), 'Products')) {
    const handle = clean(row.Handle), id = clean(row.ID);
    if (!handle || !id) continue;
    const articles = new Set([articleValue(row['Metafield: custom.external_id [single_line_text_field]']), articleValue(row['Variant SKU'])].filter(Boolean));
    for (const article of articles) {
      const key = `${handle}\u0000${article}`;
      if (!historical.has(key)) historical.set(key, new Set());
      historical.get(key).add(id);
    }
  }

  const byHandle = new Map(), mismatches = [], conflicts = [], handleConflicts = [];
  for (const row of parsed) {
    const handle = clean(row[handleIndex]), external = articleValue(row[externalIndex]), sku = articleValue(row[skuIndex]);
    if (!handle) continue;
    if (!byHandle.has(handle)) byHandle.set(handle, { articles: new Map(), externalIds: new Set(), skus: new Set() });
    const group = byHandle.get(handle);
    if (external) group.externalIds.add(external);
    if (sku) group.skus.add(sku);
    if (external && sku && external !== sku) mismatches.push({ shopifyHandle: handle, externalId: external, variantSku: sku });
    for (const [article, source] of [[external, 'external_id'], [sku, 'variant_sku']]) {
      if (!article) continue;
      const existing = group.articles.get(article);
      if (!existing || source === 'external_id') group.articles.set(article, { articleNumber: article, shopifyHandle: handle,
        shopifyProductId: '', variantSku: sku, source });
    }
  }
  const byArticle = new Map();
  for (const [handle, group] of byHandle) {
    if (group.externalIds.size > 1) {
      handleConflicts.push({ shopifyHandle: handle, externalIds: [...group.externalIds] });
      continue;
    }
    for (const record of group.articles.values()) {
      const ids = historical.get(`${handle}\u0000${record.articleNumber}`) || new Set();
      if (ids.size > 1) conflicts.push({ articleNumber: record.articleNumber, shopifyHandle: handle, reason: 'historical handle/article maps to multiple Shopify IDs', productIds: [...ids] });
      else if (ids.size === 1) record.shopifyProductId = [...ids][0];
      if (!byArticle.has(record.articleNumber)) byArticle.set(record.articleNumber, []);
      byArticle.get(record.articleNumber).push(record);
    }
  }
  const records = [];
  for (const [articleNumber, matches] of byArticle) {
    if (matches.length > 1) {
      conflicts.push({ articleNumber, reason: 'article appears under multiple current Shopify handles', handles: matches.map(item => item.shopifyHandle) });
      continue;
    }
    if (!conflicts.some(item => item.articleNumber === articleNumber)) records.push(matches[0]);
  }
  return { records, conflicts, mismatches, handleConflicts, currentHandleCount: byHandle.size,
    matchedProductCount: new Set(records.filter(item => item.shopifyProductId).map(item => item.shopifyHandle)).size,
    unmatchedProductCount: new Set(records.filter(item => !item.shopifyProductId).map(item => item.shopifyHandle)).size };
}
function productInventory(file = PRODUCT_EXPORT, historicalFile = LEGACY_PRODUCT_EXPORT) {
  return path.extname(file).toLowerCase() === '.csv' ? productInventoryCsv(file, historicalFile) : productInventoryXlsx(file);
}
function collectionInventory(categoryFile, shopifyFile = COLLECTION_EXPORT, approvedMapFile = APPROVED_CATEGORY_MAP) {
  const categories = readCategoryWorkbook(path.resolve(categoryFile));
  const ids = new Map();
  for (const row of categories.categories) {
    const categoryId = clean(row.categoryId);
    if (!categoryId) continue;
    if (!ids.has(categoryId)) ids.set(categoryId, { categoryId, localized: {} });
    ids.get(categoryId).localized[row.culture] = row;
  }
  const shopify = rows(path.resolve(shopifyFile), 'Collections');
  const shopifyById = new Map(shopify.filter(row => clean(row.ID)).map(row => [clean(row.ID), { id: clean(row.ID), handle: clean(row.Handle) }]));
  const approved = JSON.parse(fs.readFileSync(path.resolve(approvedMapFile), 'utf8'));
  const mappingConflicts = [];
  const selected = new Map();
  for (const row of approved) {
    if (clean(row.ManualApproval).toLowerCase() !== 'approved') continue;
    const categoryId = clean(row.CategoryID), shopifyId = clean(row.ShopifyID);
    const category = ids.get(categoryId), destination = shopifyById.get(shopifyId);
    if (!category || !destination) continue;
    const prior = selected.get(categoryId);
    if (prior && prior.shopifyCollectionId !== shopifyId) {
      mappingConflicts.push({ categoryId, shopifyIds: [prior.shopifyCollectionId, shopifyId] });
      selected.delete(categoryId);
      continue;
    }
    selected.set(categoryId, { ...category, shopifyCollectionId: shopifyId, shopifyHandle: destination.handle });
  }
  const rejected = new Set(mappingConflicts.map(item => item.categoryId));
  return { records: [...selected.values()].filter(item => !rejected.has(item.categoryId)), shopifyCount: shopifyById.size,
    categoryDiagnostics: categories.diagnostics, mappingConflicts };
}
module.exports = { PRODUCT_EXPORT, LEGACY_PRODUCT_EXPORT, COLLECTION_EXPORT, APPROVED_CATEGORY_MAP,
  productInventory, productInventoryCsv, productInventoryXlsx, collectionInventory };
