#!/usr/bin/env node
/** Explicit opt-in, read-only Norce StoreAPI category discovery/fetch. */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const {
    readCategoryWorkbook, readCmsCsv, normalizeCms, clean,
} = require('./norce-source-ingestion');
const { NorceStoreApiClient, storeApiConfigFromEnv } = require('../../api/norce-storeapi-client');


function parseArgs(argv) {
    const options = {};
    for (const arg of argv) { const match = arg.match(/^--([^=]+)=(.*)$/); if (match) options[match[1]] = match[2]; }
    return options;
}
function firstExistingPath(explicitPath, defaults, label) {
    if (explicitPath) {
        const resolved = path.resolve(explicitPath);
        if (!fs.existsSync(resolved)) throw new Error(`${label} file does not exist: ${resolved}`);
        return resolved;
    }
    return defaults.map(candidate => path.resolve(candidate)).find(candidate => fs.existsSync(candidate)) || null;
}
function discoverCategories(categoryWorkbookPath, culture = 'sv-SE') {
    const data = readCategoryWorkbook(categoryWorkbookPath);
    const excludedConflictIds = new Set(data.diagnostics.categoryConflicts.map(item => String(item.key).split('\0')[0]));
    const unique = new Map();
    for (const category of data.categories) {
        const categoryId = clean(category.categoryId);
        if (categoryId && !excludedConflictIds.has(categoryId)) unique.set(categoryId, { categoryId, culture: clean(culture) });
    }
    return {
        pairs: [...unique.values()].sort((left, right) => left.categoryId.localeCompare(right.categoryId, undefined, { numeric: true })),
        excludedConflictIds: [...excludedConflictIds],
    };
}
function discoverCategoryPairs(categoryWorkbookPath, culture = 'sv-SE') {
    return discoverCategories(categoryWorkbookPath, culture).pairs;
}
function findDefaultCategoryWorkbook() {
    const desktop = path.resolve(process.cwd(), '../..');
    if (!fs.existsSync(desktop)) return null;
    const normalized = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const directory = fs.readdirSync(desktop, { withFileTypes: true })
        .find(entry => entry.isDirectory() && normalized(entry.name) === 'fyrklovern');
    if (!directory) return null;
    const candidate = path.join(desktop, directory.name, 'fyrklovern_custom_export.xlsx');
    return fs.existsSync(candidate) ? candidate : null;
}
function cmsKeys(csvPath) {
    if (!csvPath) return null;
    const csv = readCmsCsv(csvPath);
    const cms = normalizeCms(csv.records, csv.headers);
    return new Set(cms.contents.map(item => `${clean(item.contentId)}\0${clean(item.culture)}`));
}
async function main(argv = process.argv.slice(2), { env = process.env, transport } = {}) {
    if (env === process.env) dotenv.config({ path: env.ENV_FILE || '.env' });
    const options = parseArgs(argv);
    options.ids = options.ids || env.npm_config_ids || '';
    const config = storeApiConfigFromEnv(env);
    if (!config.token) throw new Error('Norce StoreAPI token is missing (NORCE_STOREAPI_TOKEN). No requests were made. Add it locally to .env or configure ENV_FILE.');

    let pairs;
    let categoriesPath = null;
    let excludedConflictIds = [];
    if (options.ids) {
        const ids = [...new Set(options.ids.split(',').map(clean).filter(Boolean))];
        const culture = clean(options.culture || config.culture);
        pairs = ids.map(categoryId => ({ categoryId, culture }));
    } else {
        const configuredCategoriesPath = options.categories || env.NORCE_CATEGORY_EXPORT_PATH;
        categoriesPath = configuredCategoriesPath
            ? firstExistingPath(configuredCategoriesPath, [], 'Category workbook')
            : findDefaultCategoryWorkbook();
        if (!categoriesPath) throw new Error('No category workbook found. Pass --categories=<path> or set NORCE_CATEGORY_EXPORT_PATH. Default: ../../<Fyrklovern folder>/fyrklovern_custom_export.xlsx (folder match ignores accents).');
        const discovery = discoverCategories(categoriesPath, options.culture || config.culture);
        pairs = discovery.pairs;
        excludedConflictIds = discovery.excludedConflictIds;
    }
    if (!pairs.length) throw new Error('No CategoryID/culture pairs were found to fetch.');

    const configuredCmsPath = options.cms || env.NORCE_CMS_EXPORT_PATH;
    const cmsPath = options.cms === 'none' ? null : firstExistingPath(configuredCmsPath, [], 'CMS CSV');
    const cmsContentKeys = cmsKeys(cmsPath);
    const output = path.resolve(options.output || env.NORCE_STOREAPI_OUTPUT_PATH || 'outputs/Fyrklovern/Reports and source maps/StoreAPI category ContentId map.json');
    if (fs.existsSync(output) && options.overwrite !== 'true') {
        let knownCache = false;
        if (!options.ids && !options.output && !env.NORCE_STOREAPI_OUTPUT_PATH) {
            try {
                const existing = JSON.parse(fs.readFileSync(output, 'utf8'));
                knownCache = existing.fileFormat === 'fyrklovern-storeapi-category-content-map/v1' &&
                    path.resolve(existing.sourceCategories || '') === path.resolve(categoriesPath || '') &&
                    existing.culture === (options.culture || config.culture) &&
                    path.resolve(existing.cmsSource || '') === path.resolve(cmsPath || '');
            } catch { /* Non-cache or malformed output remains protected. */ }
        }
        if (!knownCache) throw new Error(`Refusing to overwrite existing output: ${output}; pass --overwrite=true`);
    }
    const client = new NorceStoreApiClient({ config, ...(transport ? { transport } : {}) });
    const records = [];
    for (const [index, pair] of pairs.entries()) {
        try {
            const category = await client.fetchCategory(pair.categoryId, { culture: pair.culture });
            const returnedId = clean(category?.id);
            if (returnedId && returnedId !== pair.categoryId) {
                throw new Error(`StoreAPI returned CategoryID ${returnedId} for requested CategoryID ${pair.categoryId}.`);
            }
            const contentId = clean(category?.ContentId);
            const found = cmsContentKeys == null || !contentId
                ? null : cmsContentKeys.has(`${contentId}\0${pair.culture}`);
            records.push({
                categoryId: pair.categoryId, culture: pair.culture,
                contentId: contentId || null,
                cmsFound: found,
                cmsStatus: !contentId ? 'no ContentId returned' : (found == null ? 'CMS export not supplied' : (found ? 'found' : 'not found')),
                status: category ? 'fetched' : 'category not found',
                category: category || null,
            });
        } catch (error) {
            records.push({
                categoryId: pair.categoryId, culture: pair.culture,
                contentId: null, cmsFound: null, cmsStatus: cmsPath ? 'not checked' : 'CMS export not supplied',
                status: 'error', error: error.message,
            });
        }
        if ((index + 1) % 25 === 0 || index + 1 === pairs.length) {
            const errors = records.filter(record => record.status === 'error').length;
            console.log(`Processed ${index + 1}/${pairs.length} category/culture pairs; errors=${errors}.`);
        }
    }

    fs.mkdirSync(path.dirname(output), { recursive: true });
    const mappings = records.map(record => ({
        categoryId: record.categoryId, culture: record.culture, contentId: record.contentId,
        cmsFound: record.cmsFound, cmsStatus: record.cmsStatus,
        status: record.status,
        source: 'explicit StoreAPI fetch output',
    }));
    fs.writeFileSync(output, `${JSON.stringify({
        fileFormat: 'fyrklovern-storeapi-category-content-map/v1',
        fetchedAt: new Date().toISOString(), culture: options.culture || config.culture, country: config.country,
        sourceCategories: categoriesPath, cmsSource: cmsPath, requestedCount: pairs.length,
        excludedConflictCategoryIds: excludedConflictIds,
        excludedConflictCategoryCount: excludedConflictIds.length,
        successCount: records.filter(record => record.status === 'fetched').length,
        errorCount: records.filter(record => record.status === 'error').length,
        mappings, records,
    }, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${records.length} category/culture records and ${mappings.length} category/culture mapping rows to ${output}`);
    return records;
}

function applyFetchExitStatus(records, processLike = process) {
    const hasErrors = records.some(record => record.status === 'error');
    if (hasErrors) {
        console.error('One or more category fetches failed; the complete success/error cache was still written.');
        processLike.exitCode = 1;
    }
    return hasErrors;
}
if (require.main === module) main().then(records => { applyFetchExitStatus(records); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, discoverCategories, discoverCategoryPairs, findDefaultCategoryWorkbook, cmsKeys, applyFetchExitStatus, main };
