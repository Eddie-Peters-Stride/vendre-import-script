#!/usr/bin/env node
/**
 * Import Fyrklövern's Swedish product-data worksheet into the shared product
 * staging file. Product, price, stock and category exports are intentionally
 * kept separate until their remaining source worksheets are mapped.
 */

const fs = require('fs');
const path = require('path');
const { readProductdata } = require('./productdata');
const { ensureDirectory, safeWriteJson } = require('../../utils/file-io');

const DEFAULT_INPUT_PATH = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'Fyrklövern',
    'fyrklovern_custom_export.xlsx'
);
const DEFAULT_PERMALINK_PATH = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'Fyrklövern',
    'fyrklovern_productpermalinks.xlsx'
);
const DEFAULT_IMAGE_ORDER_PATH = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'Fyrklövern',
    'fyrklovern_produkter_bildordning.xlsx'
);

function getInputPath() {
    const argument = process.argv.find(value => value.startsWith('--input='));
    return argument ? path.resolve(argument.slice('--input='.length)) :
        process.env.FYRKLOVERN_INPUT_FILE || DEFAULT_INPUT_PATH;
}

function getPermalinkPath() {
    const argument = process.argv.find(value => value.startsWith('--permalinks='));
    return argument ? path.resolve(argument.slice('--permalinks='.length)) :
        process.env.FYRKLOVERN_PRODUCT_PERMALINK_FILE || DEFAULT_PERMALINK_PATH;
}

function getImageOrderPath() {
    const argument = process.argv.find(value => value.startsWith('--image-order='));
    return argument ? path.resolve(argument.slice('--image-order='.length)) :
        process.env.FYRKLOVERN_IMAGE_ORDER_FILE || DEFAULT_IMAGE_ORDER_PATH;
}

function main() {
    const inputPath = getInputPath();
    const permalinkPath = getPermalinkPath();
    const imageOrderPath = getImageOrderPath();
    if (!fs.existsSync(inputPath)) {
        throw new Error(
            `Fyrklövern input file not found: ${inputPath}\n` +
            'Pass --input=<path> or set FYRKLOVERN_INPUT_FILE.'
        );
    }
    if (!fs.existsSync(permalinkPath)) {
        throw new Error(
            `Fyrklövern product permalink file not found: ${permalinkPath}\n` +
            'Pass --permalinks=<path> or set FYRKLOVERN_PRODUCT_PERMALINK_FILE.'
        );
    }
    if (!fs.existsSync(imageOrderPath)) {
        throw new Error(
            `Fyrklövern image-order file not found: ${imageOrderPath}\n` +
            'Pass --image-order=<path> or set FYRKLOVERN_IMAGE_ORDER_FILE.'
        );
    }

    const products = readProductdata(inputPath, permalinkPath, imageOrderPath);
    const outputDir = path.join(__dirname, '..', '..', '..', 'results', 'fyrklovern');
    const outputPath = path.join(outputDir, 'fyrklovern-products.json');

    ensureDirectory(outputDir);
    safeWriteJson(outputPath, { list: products });
    console.log(`Imported ${products.length} Fyrklövern products to ${outputPath}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`Fyrklövern import failed: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { getInputPath, getPermalinkPath, getImageOrderPath, main };
