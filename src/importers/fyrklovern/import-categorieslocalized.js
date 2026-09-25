#!/usr/bin/env node
/** Stage Fyrklövern's Swedish categories for the migration. */

const fs = require('fs');
const path = require('path');
const { readCategorieslocalized } = require('./categorieslocalized');
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

function getInputPath() {
    const argument = process.argv.find(value => value.startsWith('--input='));
    return argument ? path.resolve(argument.slice('--input='.length)) :
        process.env.FYRKLOVERN_INPUT_FILE || DEFAULT_INPUT_PATH;
}

function main() {
    const inputPath = getInputPath();
    if (!fs.existsSync(inputPath)) {
        throw new Error(
            `Fyrklövern input file not found: ${inputPath}\n` +
            'Pass --input=<path> or set FYRKLOVERN_INPUT_FILE.'
        );
    }

    const categories = readCategorieslocalized(inputPath);
    const outputDir = path.join(__dirname, '..', '..', '..', 'results', 'fyrklovern');
    const outputPath = path.join(outputDir, 'fyrklovern-categories.json');

    ensureDirectory(outputDir);
    safeWriteJson(outputPath, { list: categories });
    console.log(`Imported ${categories.length} Fyrklövern categories to ${outputPath}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`Fyrklövern category import failed: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { getInputPath, main };
