const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { buildStoreApiArtifacts, approvedLookup, matrixifyRows, imageFilename } = require('../src/importers/fyrklovern/build-collection-content-import');
const { normalizeStoreApiComponents, reconcileCsvComponents } = require('../src/importers/fyrklovern/norce-storeapi-content');
const { discoverPairs, main: fetchPublishedContent } = require('../src/importers/fyrklovern/fetch-norce-published-content');
const { CATEGORY_QUERY } = require('../src/api/norce-storeapi-client');

const property = (name, type, value, valueType = 'StringValue') => ({
    name, type, valueType: type === 'image' ? 'SCALAR' : 'SCALAR',
    value: value == null ? null : { __typename: valueType, value },
});
const node = (name, type, properties = [], children = []) => ({ name, type, properties, children });
const campaign = (name, image) => node(name, 'Campaign Item', [
    property('heading', 'text', `${name} heading`),
    property('text', 'text', `${name} copy`),
    property('image', 'image', image),
    property('tallImage', 'image', image.replace('.jpg', '-tall.jpg')),
    property('imageFocus', 'dropdown', 'center center'),
    property('published', 'boolean', true, 'BoolValue'),
]);

const apiCategory = {
    id: '1', parentId: null, name: 'Kampanjer', mainHeader: 'Kampanjer', content: '',
    primaryRoute: { path: '/kampanjer' }, images: [],
    data: { id: 'content-1', name: '', tags: [], items: [
        node('Kampanjer', 'Category Page Header', [
            property('heading', 'text', 'Kampanjer'), property('text', 'text', 'StoreAPI page introduction'),
            property('categoryImage', 'image', null),
        ]),
        campaign('Julens serviser 2026', 'https://www.fyrklovern.com/pub_docs/files/dinner-setting-TJ-09.jpg'),
        campaign('Nordic Dawn höst 2026', 'https://www.fyrklovern.com/pub_docs/files/dinner-setting-ND-dew-07.jpg'),
        campaign('Scene mars-26', 'https://www.fyrklovern.com/pub_docs/files/dinner-setting-SCE-13.jpg'),
    ] },
};
const apiComponents = normalizeStoreApiComponents(apiCategory);
assert.deepEqual(apiComponents.map(component => component.itemName), [
    'Kampanjer', 'Julens serviser 2026', 'Nordic Dawn höst 2026', 'Scene mars-26',
], 'category 1 fixture includes the header and only three currently returned campaigns, in StoreAPI order');
assert.equal(apiComponents[1].items.find(item => item.propertyName === 'published').value, true,
    'BoolValue property values are retained as booleans');
assert.equal(apiComponents[1].items.find(item => item.propertyName === 'image').value,
    'https://www.fyrklovern.com/pub_docs/files/dinner-setting-TJ-09.jpg');

const csvComponents = [
    ...apiComponents.map(component => ({ ...component, componentType: 'root' })),
    { itemName: 'FLASH-SALE 20%', componentType: 'root', componentId: '', items: [] },
    { itemName: 'NALLE PUH SEPT 26', componentType: 'root', componentId: '', items: [] },
];
const cms = { contents: [{ contentId: 'content-1', culture: 'sv-SE', components: csvComponents }] };
const translatedComponents = structuredClone(apiComponents);
translatedComponents[0].items.find(item => item.propertyName === 'text').value = 'English localized category description';
translatedComponents[1].items.find(item => item.propertyName === 'text').value = 'CSV English campaign copy';
translatedComponents.push({ itemName: 'FLASH-SALE 20%', componentType: 'root', componentId: '', items: [] });
const cmsWithTranslations = { contents: [...cms.contents,
    { contentId: 'content-1', culture: 'en-GB', components: translatedComponents }] };
const englishCategory = structuredClone(apiCategory);
englishCategory.data.items[0].properties.find(item => item.name === 'text').value.value = 'English localized category description';
englishCategory.data.items[1].properties.find(item => item.name === 'text').value.value = 'Christmas tableware copy';
const categoryData = { categories: [
    { categoryId: '1', culture: 'sv-SE', key: '1\0sv-SE',
        source: { name: 'Kampanjer', text: '<p>Category workbook description</p>' } },
    { categoryId: '1', culture: 'en-GB', key: '1\0en-GB',
        source: { name: 'Campaigns', text: '<p>Localized workbook description</p>' } },
] };
const collections = [{ ID: '7001', Handle: 'kampanjer', Title: 'Kampanjer', 'Top Row': true }];
const approvals = approvedLookup([{ CategoryID: '1', Culture: 'sv-SE', ShopifyID: '7001', ManualApproval: 'Approved' }]);
const snapshot = {
    fileFormat: 'fyrklovern-norce-storeapi-published-content/v1', generatedAt: '2026-10-16T09:00:00.000Z',
    cultures: ['sv-SE', 'en-GB'], requestedCount: 2,
    records: [{ categoryId: '1', culture: 'sv-SE', retrievedAt: '2026-10-16T08:59:00.000Z',
        contentId: 'content-1', status: 'fetched', category: apiCategory },
    { categoryId: '1', culture: 'en-GB', retrievedAt: '2026-10-16T08:58:00.000Z',
        contentId: 'content-1', status: 'fetched', category: englishCategory }],
};

const result = buildStoreApiArtifacts({ categoryData, collections, snapshot, cms, approvals });
assert.equal(result.importable.length, 1);
assert.equal(result.importable[0].description, 'StoreAPI page introduction',
    'the first returned StoreAPI text supplies collection Body HTML');
assert.equal(result.importable[0].components.length, 4);
assert(result.csvComponents.length === 2 && result.csvComponents.every(row => row.status === 'not_returned_by_storeapi'),
    'CSV-only campaign components are reported without inferring expiration');
assert.deepEqual(result.importable[0].components.map(component => component.itemName), [
    'Kampanjer', 'Julens serviser 2026', 'Nordic Dawn höst 2026', 'Scene mars-26',
]);
assert(result.importable[0].components.every(component => !['FLASH-SALE 20%', 'NALLE PUH SEPT 26'].includes(component.itemName)),
    'CSV-only components do not enter Matrixify content without explicit approval');
assert.equal(result.review[0].StoreAPIRetrievedAt, '2026-10-16T08:59:00.000Z');
assert(result.translationData.get('en-GB').some(row => row.Field === 'Metafield: custom.campaign_item_julens_serviser_2026_text' &&
    row['Translation Value: en'] === 'Christmas tableware copy'),
    'localized StoreAPI text maps to the same section key as the Swedish base content');
assert(result.translationData.get('en-GB').some(row => row.Field === 'Body HTML' &&
    row['Translation Value: en'] === 'English localized category description'),
    'the matching first StoreAPI text component supplies the localized Body HTML');
const swedishOnlySnapshot = { ...snapshot, cultures: ['sv-SE'], requestedCount: 1,
    records: [snapshot.records[0]] };
const csvTranslationResult = buildStoreApiArtifacts({
    categoryData, collections, snapshot: swedishOnlySnapshot, cms: cmsWithTranslations, approvals,
});
assert(csvTranslationResult.translationData.get('en-GB').some(row =>
    row.Field === 'Metafield: custom.campaign_item_julens_serviser_2026_text' && row['Translation Value: en'] === 'CSV English campaign copy'),
    'when only Swedish StoreAPI is available, matching CSV component text supplies the translation');
assert(csvTranslationResult.translationData.get('en-GB').some(row =>
    row.Field === 'Body HTML' && row['Translation Value: en'] === 'English localized category description'),
    'matching localized CSV text supplies Body HTML translation when only Swedish StoreAPI is available');
assert(!csvTranslationResult.translationData.get('en-GB').some(row =>
    row['Translation Value: en']?.includes('FLASH-SALE')),
    'CSV-only components absent from the Swedish publication snapshot are never added to translations');
assert(result.importable[0].metafields.some(field => field.key === 'campaign_item_julens_serviser_2026_header'));
assert(result.importable[0].metafields.some(field => field.key === 'campaign_item_julens_serviser_2026_text'));
assert(!result.importable[0].metafields.some(field => field.key === 'category_page_header_text'),
    'the collection description is not duplicated in section text metafields');
const imageLists = result.importable[0].images;
assert.equal(imageLists.length, 3, 'image properties from currently returned category components become image lists');
assert.deepEqual(imageLists[0].sourceProperties, ['image', 'tallImage']);
assert(!imageLists.flatMap(field => field.urls).some(url => url.includes('center center')),
    'non-image properties are not mistaken for URLs');
const rows = matrixifyRows(result.importable).rows;
assert(rows.some(row => row['Metafield Key'] === 'campaign_item_julens_serviser_2026_images' && row['Metafield Value Type'] === 'list.file_reference'));
assert(rows.every(row => row['Body HTML'] === 'StoreAPI page introduction'));
assert(imageFilename('https://cdn.example.test/jul.jpg').endsWith('.jpg'));

const nested = normalizeStoreApiComponents({ data: { items: [node('Parent', 'Group', [], [node('Child', 'Text')])] } });
assert.deepEqual(nested.map(component => component.hierarchyPath), [[1], [1, 1]], 'nested component hierarchy is retained');

const withException = buildStoreApiArtifacts({
    categoryData, collections, snapshot, cms, approvals,
    exceptions: [{ categoryId: '1', culture: 'sv-SE', contentId: 'content-1', componentName: 'FLASH-SALE 20%', approved: true, reason: 'Reviewed exception', approvedBy: 'Eddie' }],
});
assert(withException.importable[0].components.some(component => component.itemName === 'FLASH-SALE 20%'),
    'an explicitly approved CSV-only exception can be included');
assert.equal(withException.csvComponents.find(row => row.componentName === 'FLASH-SALE 20%').status,
    'not_returned_by_storeapi', 'an exception does not overwrite the factual StoreAPI absence status');
assert.equal(withException.csvComponents.find(row => row.componentName === 'FLASH-SALE 20%').exceptionStatus,
    'approved_csv_exception');

const failedSnapshot = { records: [{ categoryId: '1', culture: 'sv-SE', status: 'error', retrievedAt: '2026-10-16T09:00:00.000Z' }] };
const failed = buildStoreApiArtifacts({ categoryData, collections, snapshot: failedSnapshot, cms, approvals });
assert.equal(failed.importable.length, 0, 'failed StoreAPI snapshots never produce imports');
assert.equal(failed.review[0].Status, 'StoreAPI error');
const missing = buildStoreApiArtifacts({ categoryData, collections, snapshot: { records: [] }, cms, approvals });
assert.equal(missing.importable.length, 0, 'missing StoreAPI snapshots never produce imports');
assert.equal(missing.review[0].Status, 'missing StoreAPI snapshot');
const duplicateRecord = snapshot.records[0];
const duplicate = buildStoreApiArtifacts({ categoryData, collections,
    snapshot: { records: [duplicateRecord, duplicateRecord] }, cms, approvals });
assert.equal(duplicate.importable.length, 0, 'duplicate StoreAPI snapshots are treated as ambiguous');
assert.equal(duplicate.review[0].Status, 'StoreAPI duplicate snapshot records');

const unapproved = reconcileCsvComponents({ categoryId: '1', culture: 'sv-SE', contentId: 'content-1',
    apiComponents, cmsContent: cms.contents[0], exceptions: [] });
assert.equal(unapproved.missingFromApi.length, 2);
assert.equal(unapproved.approvedExceptions.length, 0);

async function testSnapshotFetcher() {
    assert(CATEGORY_QUERY.includes('items {') && CATEGORY_QUERY.includes('tallImage') === false,
        'query includes data.items without hardcoding CMS property names');
    assert(CATEGORY_QUERY.includes('... on BoolValue { value }'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norce-snapshot-test-'));
    try {
        const categoriesPath = path.join(dir, 'categories.xlsx');
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
            ['CategoryID', 'Culture', 'name'], ['1', 'sv-SE', 'Kampanjer'],
            ['1', 'en-GB', 'Campaigns'], ['2', 'sv-SE', 'Shop'],
        ]), 'categorieslocalized');
        XLSX.writeFile(workbook, categoriesPath);
        assert.deepEqual(discoverPairs(categoriesPath).pairs, [
            { categoryId: '1', culture: 'en-GB' }, { categoryId: '1', culture: 'sv-SE' },
            { categoryId: '2', culture: 'sv-SE' },
        ]);
        const outputPath = path.join(dir, 'snapshot.json');
        const channelConfigPath = path.join(dir, 'channels.json');
        fs.writeFileSync(channelConfigPath, JSON.stringify({ channels: {
            'sv-SE': { shopId: 'fyrklovern-se', country: 'SE', currency: 'SEK' },
            'en-GB': { shopId: 'fyrklovern-gb', country: 'GB', currency: 'GBP' },
        } }));
        const sentCultures = [];
        const snapshot = await fetchPublishedContent([
            `--categories=${categoriesPath}`, '--ids=1', '--cultures=sv-SE,en-GB',
            `--channel-config=${channelConfigPath}`, `--output=${outputPath}`,
        ], {
            env: { NORCE_STOREAPI_TOKEN: 'mock-token', NORCE_STOREAPI_RETRIES: '0', NORCE_STOREAPI_THROTTLE_MS: '0' },
            transport: async (_url, request) => {
                sentCultures.push({ culture: request.headers.Culture, shopId: request.headers.Shopid,
                    country: request.headers.Country, currency: request.headers.Currency });
                const id = JSON.parse(request.body).variables.id;
                return { ok: true, json: async () => ({ data: { category: {
                    id, data: { id: `content-${request.headers.Culture}`, items: [node('Published', 'Text', [])] },
                } } }) };
            },
        });
        assert.deepEqual(sentCultures.sort((a, b) => a.culture.localeCompare(b.culture)), [
            { culture: 'en-GB', shopId: 'fyrklovern-gb', country: 'GB', currency: 'GBP' },
            { culture: 'sv-SE', shopId: 'fyrklovern-se', country: 'SE', currency: 'SEK' },
        ]);
        assert.equal(snapshot.records.length, 2);
        assert(snapshot.records.every(record => record.status === 'fetched' && record.retrievedAt && record.culture));
        assert.equal(snapshot.records.find(record => record.culture === 'en-GB').shopId, 'fyrklovern-gb');
        assert.equal(snapshot.records.find(record => record.culture === 'en-GB').currency, 'GBP');
        assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).fileFormat,
            'fyrklovern-norce-storeapi-published-content/v1');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

testSnapshotFetcher().then(() => console.log('Fyrklövern StoreAPI-first content migration tests passed.'))
    .catch(error => { console.error(error); process.exitCode = 1; });
