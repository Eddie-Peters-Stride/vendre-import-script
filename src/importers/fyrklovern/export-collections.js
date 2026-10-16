#!/usr/bin/env node
/**
 * Export Fyrklövern's staged categories as a Matrixify Collections workbook.
 * This command intentionally does not read or write product data.
 */

const path = require('path');
const { loadVendreData, writeExcelFile } = require('../../utils/file-io');
const { transformCollections } = require('../../transformers/collection-transformer');
const { exportCollections } = require('../../exporters/matrixify-collections');

function main() {
    const root = path.join(__dirname, '..', '..', '..');
    const resultsDir = path.join(root, 'results', 'fyrklovern');
    const outputDir = path.join(root, 'outputs', 'Fyrklovern', 'Matrixify files', 'Collections');
    const categoriesPath = path.join(resultsDir, 'fyrklovern-categories.json');
    const stagedCategories = loadVendreData(categoriesPath);
    // Categories with the same original permalink are the same storefront
    // collection. Keep one Matrixify row while products can still reference it
    // through every source category ID.
    const categories = [...new Map(
        stagedCategories.map(category => [category.handle, category])
    ).values()];

    const { collections, maps } = transformCollections(categories, {
        resolveHandleCollisions: false,
        preserveCollectionTitles: true,
    });
    const rows = exportCollections(collections, maps, {
        exportSettings: { includeVendreData: false },
    });
    const outputPath = path.join(outputDir, 'Fyrklovern collections - full Matrixify import.xlsx');

    writeExcelFile(rows, outputPath, 'Collections');
    console.log(`Exported ${rows.length} Fyrklövern collections to ${outputPath}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`Fyrklövern collection export failed: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { main };
