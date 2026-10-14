#!/usr/bin/env node
const path = require('path');
const { runMigration } = require('../../src/fyrklovern/topup-migration');

const root = path.resolve(__dirname, '..', '..');
const fyrklovern = path.resolve(root, '..', '..', 'Fyrklövern');
function arg(name, fallback) { const value = process.argv.find(item => item.startsWith(`--${name}=`)); return value ? path.resolve(value.slice(name.length + 3)) : fallback; }
try {
    const result = runMigration({
        productData: arg('product-data', path.join(fyrklovern, 'fyrklovern_productdata_newexport.xlsx')),
        customExport: arg('custom-export', path.join(fyrklovern, 'fyrklovern_custom_export.xlsx')),
        productPermalinks: arg('product-permalinks', path.join(fyrklovern, 'fyrklovern_productpermalinks.xlsx')),
        imageOrder: arg('image-order', path.join(fyrklovern, 'fyrklovern_produkter_bildordning.xlsx')),
        categorySortOrder: arg('category-sort-order', path.join(fyrklovern, 'fyrklovern_products_in_categories_sortorder.xlsx')),
        relatedProducts: arg('related-products', path.join(fyrklovern, 'fyrklovern_relaterade_artiklar_,med_sortorder.xlsx')),
        liveProducts: arg('live-products'), liveCollections: arg('live-collections'),
        translationExport: arg('translation-export', path.join(fyrklovern, 'translations.csv')),
        outputDir: arg('output-dir', path.join(root, 'outputs', 'fyrklovern-topup')),
    });
    console.log(JSON.stringify({
        files: result.files,
        newProducts: result.report.products.new.length,
        updatedProducts: result.report.products.updated.length,
        mediaRows: result.report.media.updated,
        collectionRows: result.report.collections.updated,
        recommendationRows: result.report.recommendations.updated,
        matrixifyTranslationRows: result.report.translations.matrixify,
        deferredNativeTranslations: result.report.translations.deferred.length,
    }, null, 2));
} catch (error) { console.error(`Fyrklövern top-up migration failed: ${error.message}`); process.exitCode = 1; }
