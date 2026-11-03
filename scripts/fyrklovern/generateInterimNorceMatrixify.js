#!/usr/bin/env node
// Publish only currently verified rows while the full Norce extraction continues.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const migration = require('../../src/importers/fyrklovern/norce-matrixify');

function workbook(file, sheet, rows) {
  if (!rows.length) return;
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), sheet);
  XLSX.writeFile(book, file);
}

function main() {
  const state = migration.inspect();
  const updates = migration.matrixifyRows(state);
  const translations = migration.translationRows(state);
  const allowable = updates.conflicts.filter(row => row.Type === 'invalid_attribute_value' && row.ID);
  if (allowable.length !== updates.conflicts.length) {
    throw new Error('Unexpected content conflicts; interim import withheld.');
  }
  const blockedIds = new Set(allowable.map(row => String(row.ID)));
  const products = updates.productUpdates.filter(row => !blockedIds.has(String(row.ID)));
  const safeTranslations = translations.rows.filter(row => !(
    String(row.Entity || '').toLowerCase() === 'product' && blockedIds.has(String(row['Entity ID']))
  ));
  if (!products.length || !updates.collectionUpdates.length) {
    throw new Error('No verified interim product and collection updates available.');
  }
  const out = path.resolve('norcemigration', `interim-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(out, { recursive: true });
  workbook(path.join(out, 'INTERIM-products.xlsx'), 'Products', products);
  workbook(path.join(out, 'INTERIM-collections.xlsx'), 'Collections', updates.collectionUpdates);
  workbook(path.join(out, 'INTERIM-translations.xlsx'), 'Translations', safeTranslations);
  const manifest = {
    generatedAt: new Date().toISOString(),
    complete: false,
    purpose: 'Verified interim subset while full Norce product extraction continues',
    sourceProducts: 989,
    productUpdates: products.length,
    collectionUpdates: updates.collectionUpdates.length,
    translations: safeTranslations.length,
    excludedConflicts: allowable,
    note: 'Importing this subset does not complete the product migration. Use the final validated run for remaining records.'
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ directory: out, ...manifest }, null, 2));
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
