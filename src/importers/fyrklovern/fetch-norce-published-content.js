#!/usr/bin/env node
/** Fetch read-only StoreAPI publication snapshots for Fyrklövern categories. */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { readCategoryWorkbook, clean } = require('./norce-source-ingestion');
const { NorceStoreApiClient, storeApiConfigFromEnv } = require('../../api/norce-storeapi-client');

function parseArgs(argv) {
    const options = {};
    for (const arg of argv) {
        const match = arg.match(/^--([^=]+)=(.*)$/);
        if (match) options[match[1]] = match[2];
    }
    return options;
}

function loadChannelConfig(filePath) {
    if (!filePath) return {};
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) throw new Error(`Channel config does not exist: ${resolved}`);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
    catch (error) { throw new Error(`Could not parse channel config JSON: ${error.message}`); }
    const channels = parsed.channels || parsed;
    if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
        throw new Error('Channel config must be an object keyed by culture, or contain a "channels" object.');
    }
    for (const [culture, channel] of Object.entries(channels)) {
        if (!channel || typeof channel !== 'object' || Array.isArray(channel) || !clean(channel.shopId)) {
            throw new Error(`Channel config for ${culture} must include a nonempty shopId.`);
        }
    }
    return channels;
}

function discoverPairs(categoryWorkbookPath, { ids = '', culture = '', cultures = '', defaultCulture = 'sv-SE' } = {}) {
    const data = readCategoryWorkbook(categoryWorkbookPath);
    const conflictingIds = new Set(data.diagnostics.categoryConflicts.map(item => String(item.key).split('\0')[0]));
    const categoryIds = ids
        ? [...new Set(ids.split(',').map(clean).filter(Boolean))]
        : [...new Set(data.categories.map(item => clean(item.categoryId)).filter(id => id && !conflictingIds.has(id)))];
    const requestedCultures = cultures
        ? [...new Set(cultures.split(',').map(clean).filter(Boolean))]
        : culture ? [clean(culture)] : ids ? [clean(defaultCulture)]
            : [...new Set(data.categories.map(item => clean(item.culture)).filter(Boolean))].sort();
    const available = new Set(data.categories.map(item => `${clean(item.categoryId)}\0${clean(item.culture)}`));
    const pairs = categoryIds.flatMap(categoryId => requestedCultures
        .filter(locale => ids || available.has(`${categoryId}\0${locale}`))
        .map(locale => ({ categoryId, culture: locale })));
    return {
        pairs: pairs.sort((a, b) => a.categoryId.localeCompare(b.categoryId, undefined, { numeric: true }) || a.culture.localeCompare(b.culture)),
        excludedConflictIds: [...conflictingIds].sort(),
    };
}

async function main(argv = process.argv.slice(2), { env = process.env, transport } = {}) {
    if (env === process.env) dotenv.config({ path: env.ENV_FILE || '.env' });
    const options = parseArgs(argv);
    if (options.help) {
        console.log('Usage: npm run fetch:fyrklovern-norce-published-content -- --categories=<xlsx> [--ids=1,2] [--culture=sv-SE | --cultures=sv-SE,en-GB] [--channel-config=<json>] [--output=<json>] [--overwrite=true]');
        console.log('With no ID or culture filter, fetches every category/culture pair in the category workbook. Requests are read-only.');
        return null;
    }
    const config = storeApiConfigFromEnv(env);
    if (!config.token) throw new Error('Norce StoreAPI token is missing (NORCE_STOREAPI_TOKEN). No requests were made.');

    const categoriesPath = path.resolve(options.categories || env.NORCE_CATEGORY_EXPORT_PATH ||
        path.resolve(process.cwd(), '../..', 'Fyrklövern', 'fyrklovern_custom_export.xlsx'));
    if (!fs.existsSync(categoriesPath)) throw new Error(`Category workbook does not exist: ${categoriesPath}`);
    const { pairs, excludedConflictIds } = discoverPairs(categoriesPath, {
        ids: options.ids || '', culture: options.culture || '', cultures: options.cultures || '', defaultCulture: config.culture,
    });
    const channels = loadChannelConfig(options['channel-config']);
    if (!pairs.length) throw new Error('No category/culture pairs were found to fetch.');

    const output = path.resolve(options.output || env.NORCE_STOREAPI_SNAPSHOT_PATH ||
        'outputs/Fyrklovern/Reports and source maps/Norce StoreAPI published content snapshot.json');
    if (fs.existsSync(output) && options.overwrite !== 'true') {
        throw new Error(`Refusing to overwrite existing snapshot: ${output}; pass --overwrite=true or use a new --output path`);
    }
    const client = new NorceStoreApiClient({ config, ...(transport ? { transport } : {}) });
    const records = [];
    for (const [index, pair] of pairs.entries()) {
        const channel = channels[pair.culture] || {};
        const requestContext = {
            shopId: clean(channel.shopId) || config.shopId,
            country: clean(channel.country) || config.country,
            currency: clean(channel.currency) || config.currency,
        };
        try {
            const category = await client.fetchCategory(pair.categoryId, { culture: pair.culture, ...requestContext });
            const returnedId = clean(category?.id);
            if (returnedId && returnedId !== pair.categoryId) {
                throw new Error(`StoreAPI returned CategoryID ${returnedId} for requested CategoryID ${pair.categoryId}.`);
            }
            records.push({
                categoryId: pair.categoryId,
                culture: pair.culture,
                ...requestContext,
                retrievedAt: new Date().toISOString(),
                contentId: clean(category?.data?.id) || null,
                status: category ? 'fetched' : 'category not found',
                category: category || null,
            });
        } catch (error) {
            records.push({ categoryId: pair.categoryId, culture: pair.culture, ...requestContext,
                retrievedAt: new Date().toISOString(), contentId: null, status: 'error', error: error.message });
        }
        if ((index + 1) % 25 === 0 || index + 1 === pairs.length) {
            console.log(`Fetched ${index + 1}/${pairs.length} category/culture snapshots.`);
        }
    }

    fs.mkdirSync(path.dirname(output), { recursive: true });
    const snapshot = {
        fileFormat: 'fyrklovern-norce-storeapi-published-content/v1',
        generatedAt: new Date().toISOString(),
        channelConfigSource: options['channel-config'] ? path.resolve(options['channel-config']) : null,
        sourceCategories: categoriesPath,
        cultures: [...new Set(pairs.map(pair => pair.culture))],
        excludedConflictCategoryIds: excludedConflictIds,
        requestedCount: pairs.length,
        successCount: records.filter(record => record.status === 'fetched').length,
        errorCount: records.filter(record => record.status === 'error').length,
        categoryNotFoundCount: records.filter(record => record.status === 'category not found').length,
        records,
    };
    fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${records.length} snapshots to ${output}`);
    if (snapshot.errorCount > 0 || snapshot.categoryNotFoundCount > 0) process.exitCode = 1;
    return snapshot;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, discoverPairs, loadChannelConfig, main };
