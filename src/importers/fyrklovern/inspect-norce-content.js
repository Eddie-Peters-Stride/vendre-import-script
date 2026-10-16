#!/usr/bin/env node
/** Build a source-only Norce category/CMS audit; never writes Shopify data. */

const path = require('path');
const { safeWriteJson } = require('../../utils/file-io');
const {
    readCategoryWorkbook, readCmsCsv, normalizeCms, normalizeContentMap, buildAudit,
} = require('./norce-source-ingestion');

function parseArguments(argv) {
    const options = {};
    for (const argument of argv) {
        const match = argument.match(/^--([^=]+)=(.*)$/);
        if (match) options[match[1]] = match[2];
    }
    return options;
}

function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (!options.categories || !options.cms) {
        throw new Error(
            'Usage: node src/importers/fyrklovern/inspect-norce-content.js ' +
            '--categories=<category-export.xlsx> --cms=<cms-export.csv> ' +
            '[--content-map=<verified-map.json>] [--category-id=149 --culture=sv-SE --content-id=<id>] ' +
            '[--output=<audit.json>]'
        );
    }
    const categoryPath = path.resolve(options.categories);
    const cmsPath = path.resolve(options.cms);
    const categoryData = readCategoryWorkbook(categoryPath);
    const csv = readCmsCsv(cmsPath);
    const cms = normalizeCms(csv.records, csv.headers);
    const contentMap = options['content-map'] ? normalizeContentMap(path.resolve(options['content-map'])) : [];
    if (options['content-id']) {
        if (!options['category-id'] || !options.culture) {
            throw new Error('--content-id requires explicit --category-id and --culture values.');
        }
        contentMap.push({
            categoryId: options['category-id'], culture: options.culture,
            contentId: options['content-id'], source: 'explicit CLI mapping',
        });
    }
    const audit = buildAudit({
        categories: categoryData.categories,
        categoryDiagnostics: categoryData.diagnostics,
        cms,
        cmsCsvDiagnostics: csv.diagnostics,
        contentMap,
        categoryId: options['category-id'] || '149',
        culture: options.culture || 'sv-SE',
    });
    const outputPath = path.resolve(options.output || path.join(
        __dirname, '..', '..', '..', 'outputs', 'Fyrklovern', 'Reports and source maps', 'Norce CMS source audit.json'
    ));
    safeWriteJson(outputPath, audit);
    console.log(`Audited ${categoryData.categories.length} localized categories and ${cms.contents.length} CMS content/culture groups.`);
    console.log(`Missing ContentId relationships: ${audit.missingContentIds.length}; CMS rows without relationships: ${audit.missingCmsRelationships.length}.`);
    console.log(`Wrote source audit to ${outputPath}`);
    return audit;
}

if (require.main === module) {
    try { main(); }
    catch (error) {
        console.error(`Norce source audit failed: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { parseArguments, main };
