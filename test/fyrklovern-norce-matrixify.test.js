const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCache, upsert, setProgress } = require('../src/importers/fyrklovern/norce-extraction/cache');
const { imageFilename } = require('../src/importers/fyrklovern/build-collection-content-import');
const { productIdentity, collectionIdentity, collectionBody, formatAttributeValue, matrixifyRows, translationRows, channelCoverage, fileRows, publishMatrixifyRun } = require('../src/importers/fyrklovern/norce-matrixify');

const products = productIdentity([
    { articleNumber: 'source-1', shopifyProductId: '101', shopifyHandle: 'one' },
    { articleNumber: 'sku-2', shopifyProductId: '101', shopifyHandle: 'one' },
    { articleNumber: 'source-2', shopifyProductId: '', shopifyHandle: 'two' },
    { articleNumber: 'source-3', shopifyProductId: '', shopifyHandle: 'three' },
    { articleNumber: 'variant-3', shopifyProductId: '103', shopifyHandle: 'three' },
]);
assert.deepEqual([...products.byArticle.get('sku-2')], ['one']);
assert.deepEqual([...products.byArticle.get('source-1')], ['one']);
assert.equal(products.byId.size, 2);
assert.equal(products.byHandle.size, 3);
assert.equal(products.byHandle.get('three').shopifyProductId, '103');
assert.equal(products.issues.length, 0);

const collections = collectionIdentity(
    [{ ID: '201', 'Top Row': true, Handle: 'collection', 'Metafield: custom.layout_text_block_text [rich_text_field]': '' }],
    [{ CategoryID: '149', Culture: 'sv-SE', ShopifyID: '201', ManualApproval: 'Approved' }],
);
assert.deepEqual([...collections.byCategory.get('149')], ['201']);
assert.equal(collections.metafieldColumns.length, 1);
assert.equal(formatAttributeValue('["Ja"]', 'boolean'), 'TRUE');
assert.equal(formatAttributeValue('["Nej"]', 'boolean'), 'FALSE');
assert.equal(collectionBody({ cmsProperties: [
    { 'Category ID': '149', 'Channel ID': '1', 'Component Path': '10', 'Property Name': 'text', 'Property Value': 'Later' },
    { 'Category ID': '149', 'Channel ID': '1', 'Component Path': '3', 'Property Name': 'text', 'Property Value': 'Earlier' },
] }, { Category: '149', Channel: '1', Source: { 'Body HTML': '' } }), 'Earlier');

const state = {
    products: [
        { Article: 'source-1', Channel: '1', 'Shopify ID': '101', 'Shopify Handle': 'one', Issue: '', Source: { Name: 'Swedish', Description: '<p>Swedish</p>' } },
        { Article: 'source-1', Channel: '2', 'Shopify ID': '101', 'Shopify Handle': 'one', Issue: '', Source: { Name: 'Norwegian', Description: '<p>Norwegian</p>' } },
        { Article: 'source-1', Channel: '3', 'Shopify ID': '101', 'Shopify Handle': 'one', Issue: '', Source: { Name: 'Danish', Description: '<p>Danish</p>' } },
        { Article: 'source-1', Channel: '4', 'Shopify ID': '101', 'Shopify Handle': 'one', Issue: '', Source: { Name: 'Finnish', Description: '<p>Finnish</p>' } },
        { Article: 'source-1', Channel: '5', 'Shopify ID': '101', 'Shopify Handle': 'one', Issue: '', Source: { Name: 'German', Description: '<p>German</p>' } },
        { Article: 'source-1', Channel: '6', 'Shopify ID': '101', 'Shopify Handle': 'one', Issue: '', Source: { Name: 'English', Description: '<p>English</p>' } },
        { Article: 'source-1', Channel: '7', 'Shopify ID': '101', 'Shopify Handle': 'one', Issue: '', Source: { Name: 'Dutch', Description: '<p>Dutch</p>' } },
        { Article: 'source-1', Channel: '8', 'Shopify ID': '101', 'Shopify Handle': 'one', Issue: '', Source: { Name: 'Austrian', Description: '<p>Austrian</p>' } },
        { Article: 'source-2', Channel: '1', 'Shopify ID': '', 'Shopify Handle': 'two', Issue: '', Expected: true, Source: { Name: 'Handle only', Description: '<p>New</p>' } },
        { Article: 'source-2', Channel: '2', 'Shopify ID': '', 'Shopify Handle': 'two', Issue: '', Expected: true, Source: { Name: 'Norwegian new', Description: '<p>New Norwegian</p>' } },
    ],
    collections: [{ Category: '149', Channel: '1', 'Shopify ID': '201', 'Shopify Handle': 'collection', Issue: '', Source: { Name: 'Collection', 'Body HTML': '<p>Collection</p>' } }],
};
const updates = matrixifyRows(state);
assert.deepEqual(updates.productUpdates, [
    { ID: '101', Handle: 'one', Command: 'UPDATE', 'Body HTML': '<p>Swedish</p>' },
    { Handle: 'two', Command: 'UPDATE', 'Body HTML': '<p>New</p>' },
]);
assert.deepEqual(updates.collectionUpdates, [{ ID: '201', Command: 'UPDATE', 'Body HTML': '<p>Collection</p>' }]);
state.currentProductHeaders = new Set([
    'Family (product.metafields.custom.family)',
    'Microwave safe (product.metafields.custom.microwave_safe)',
    'Dishwasher safe (product.metafields.custom.dishwasher_safe)',
]);
state.historicalProductHeaders = new Set([
    'Metafield: custom.family [single_line_text_field]',
    'Metafield: custom.microwave_safe [boolean]',
    'Metafield: custom.dishwasher_safe [boolean]',
]);
state.attributes = [
    { 'Article Number': 'source-1', 'Channel ID': '1', 'Attribute Key': 'microwavesafe', 'Attribute Value': 'unknown' },
    { 'Article Number': 'source-1', 'Channel ID': '1', 'Attribute Key': 'dishwashersafe', 'Attribute Value': '' },
];
const blankBooleanUpdates = matrixifyRows(state);
assert.equal(blankBooleanUpdates.conflicts.length, 0, 'missing boolean data should not block export');
assert.equal(Object.keys(blankBooleanUpdates.productUpdates[0]).some(column => column.includes('microwave_safe') || column.includes('dishwasher_safe')), false,
    'missing boolean data must leave the Shopify metafields blank');
state.currentProductHeaders = new Set(['Family (product.metafields.custom.family)', 'Material (product.metafields.custom.material)', 'Brand (product.metafields.custom.brand)']);
state.historicalProductHeaders = new Set(['Metafield: custom.family [single_line_text_field]', 'Metafield: custom.material [list.single_line_text_field]', 'Metafield: custom.brand [single_line_text_field]']);
state.attributes = [
    { 'Article Number': 'source-1', 'Channel ID': '1', 'Attribute Key': 'family', 'Attribute Value': 'Julminnen' },
    { 'Article Number': 'source-1', 'Channel ID': '2', 'Attribute Key': 'family', 'Attribute Value': 'Juleminner' },
    { 'Article Number': 'source-1', 'Channel ID': '4', 'Attribute Key': 'family', 'Attribute Value': 'Joulumuistot' },
    { 'Article Number': 'source-1', 'Channel ID': '5', 'Attribute Key': 'family', 'Attribute Value': 'Weihnachtserinnerungen' },
    { 'Article Number': 'source-1', 'Channel ID': '8', 'Attribute Key': 'family', 'Attribute Value': 'Andere Weihnachtserinnerungen' },
    { 'Article Number': 'source-1', 'Channel ID': '1', 'Attribute Key': 'material', 'Attribute Value': '["Porslin"]' },
    { 'Article Number': 'source-1', 'Channel ID': '4', 'Attribute Key': 'material', 'Attribute Value': '["Posliini"]' },
    { 'Article Number': 'source-1', 'Channel ID': '1', 'Attribute Key': 'Brand', 'Attribute Value': 'Fyrklövern' },
    { 'Article Number': 'source-1', 'Channel ID': '4', 'Attribute Key': 'Brand', 'Attribute Value': 'Fyrklövern' },
    { 'Article Number': 'source-1', 'Channel ID': '4', 'Attribute Key': 'careadvice', 'Attribute Value': 'Pese varovasti' },
    { 'Article Number': 'source-2', 'Channel ID': '1', 'Attribute Key': 'family', 'Attribute Value': 'Julminnen' },
    { 'Article Number': 'source-2', 'Channel ID': '2', 'Attribute Key': 'family', 'Attribute Value': 'Juleminner' },
];
const translations = translationRows(state);
const permalinkTranslations = translationRows({
    ...state,
    pid: products,
    cid: collections,
    productPermalinks: [],
    categoryPermalinks: [
        { CategoryID: '149', Culture: 'sv-SE', Link: '/dukning-servering/bestick/' },
        { CategoryID: '149', Culture: 'fi-FI', Link: '/kattaus-tarjoilu/aterimet/' },
    ],
});
assert.equal(permalinkTranslations.rows.find(row => row.Entity === 'Collection' && row.Field === 'Handle')['Translation Value: fi'],
    'kattaus-tarjoilu-aterimet', 'collection handle translation preserves the full source path');
assert.equal(translations.byLocale.no.find(row => row.Field === 'Title')['Translation Value: no'], 'Norwegian');
assert.equal(translations.byLocale.de.length, 0, 'DE/AT conflict must suppress German translation');
assert.ok(translations.review.some(row => row.Issue === 'DE_AT_market_conflict'));
assert.ok(translations.byLocale.fi.some(row => row.Field === 'Metafield: custom.family' && row['Translation Value: fi'] === 'Joulumuistot'));
assert.ok(translations.rows.some(row => row.Entity === 'Product' && row.Field === 'Metafield: custom.family'
    && row['Translation Value: fi'] === 'Joulumuistot'), 'combined translation sheet includes product metafield translations');
assert.ok(translations.byLocale.fi.some(row => row.Field === 'Metafield: custom.material'
    && row['Translation Value: fi'] === '["Posliini"]'), 'list metafield translations are emitted as JSON arrays');
assert.ok(translations.byLocale.fi.some(row => row.Field === 'Metafield: custom.brand'
    && row['Translation Value: fi'] === 'Fyrklövern'), 'matching localized values are still explicitly translated');
assert.equal(translations.byLocale.de.some(row => row.Field === 'Metafield: custom.family'), false);
assert.ok(translations.byLocale.no.some(row => row['Entity Handle'] === 'two' && row.Field === 'Metafield: custom.family'
    && !row['Entity ID']), 'metafield translations use the handle when Shopify ID is missing');
assert.equal(translations.rows.some(row => row.Field === 'Metafield: custom.external_id'), false, 'external IDs are never translated');
assert.ok(translations.review.some(row => row.Issue === 'unmapped_localized_attribute' && row.Attribute === 'careadvice'));
const fallbackState = { ...state, products: state.products.map(row => row.Article === 'source-1' && row.Channel === '2'
    ? { ...row, Source: { ...row.Source, Name: 'Swedish' } } : row) };
const fallbackTranslations = translationRows(fallbackState);
assert.ok(fallbackTranslations.review.some(row => row.Issue === 'possible_source_fallback' && row.Locale === 'no' && row.Field === 'Title'));
assert.equal(fallbackTranslations.byLocale.no.some(row => row.Field === 'Title' && row['Entity ID'] === '101'), false);
const coverage = channelCoverage({ ...state, pid: products, cid: collections }, translations.review);
assert.equal(coverage[0].expectedProducts, 5);
assert.equal(coverage[0].cachedProducts, 1);
assert.equal(coverage[0].missingProductCache, 4);
assert.equal(coverage[3].culture, 'fi-FI');
const imageUrl = 'https://example.com/image-a.jpg';
const imageCache = loadCache('unused-matrixify-integration.xlsx', 'collections');
upsert(imageCache, 'Collections', ['Category ID', 'Channel ID'], { 'Category ID': '149', 'Channel ID': '1', 'Shopify Collection ID': '201', 'Body HTML': '<p>Collection</p>' });
setProgress(imageCache, '149', '1', 'category', { Status: 'COMPLETE' });
imageCache.sheets['CMS Components'].push({ 'Category ID': '149', 'Channel ID': '1', 'Component Path': '0', 'Component Name': 'Image section', 'Component Type': 'Section' });
for (const [name, value] of [['heading', 'Welcome'], ['text', 'Description'], ['image', imageUrl]]) {
    imageCache.sheets['CMS Properties'].push({ 'Category ID': '149', 'Channel ID': '1', 'Component Path': '0',
        'Property Name': name, 'Property Type': name === 'image' ? 'image' : 'string', 'Property Value': value });
}
imageCache.sheets['Collection Images'].push({ 'Category ID': '149', 'Channel ID': '1', 'Component Path': '0', 'Image URL': imageUrl });
const candidate = fileRows({ collectionImages: imageCache.sheets['Collection Images'] });
assert.equal(candidate.rows[0]['File Name'], imageFilename(imageUrl));
const integrationDefinitions = new Map([
        ['layout_image_heading_text_content', { key: 'layout_image_heading_text_content', type: 'rich_text_field', column: 'Metafield: custom.layout_image_heading_text_content [rich_text_field]' }],
        ['layout_image_heading_text_images', { key: 'layout_image_heading_text_images', type: 'list.file_reference', column: 'Metafield: custom.layout_image_heading_text_images [list.file_reference]' }],
    ]);
const integration = matrixifyRows({ ...state, collectionCache: imageCache,
    collectionDefinitions: integrationDefinitions, config: { filesResults: [{ 'File Name': candidate.rows[0]['File Name'], Status: 'Ready' }] },
    collectionImages: imageCache.sheets['Collection Images'] });
assert.deepEqual(integration.conflicts, []);
assert.equal(integration.collectionUpdates.length, 1);
assert.equal(integration.collectionUpdates[0]['Body HTML'], '<p>Collection</p>');
assert.deepEqual(JSON.parse(integration.collectionUpdates[0]['Metafield: custom.layout_image_heading_text_images [list.file_reference]']), [imageFilename(imageUrl)]);
assert.ok(integration.collectionUpdates[0]['Metafield: custom.layout_image_heading_text_content [rich_text_field]']);
const withheld = matrixifyRows({ ...state, collectionCache: imageCache, collectionDefinitions: integrationDefinitions,
    config: {}, collectionImages: imageCache.sheets['Collection Images'] });
assert.equal(withheld.verifiedFiles.rows.length, 0);
assert.equal(withheld.verifiedFiles.review[0].reason, 'Files results/export not supplied; file reference update withheld');
upsert(imageCache, 'Collections', ['Category ID', 'Channel ID'], { 'Category ID': '149', 'Channel ID': '4', 'Shopify Collection ID': '201', 'Body HTML': '<p>Finnish</p>' });
setProgress(imageCache, '149', '4', 'category', { Status: 'COMPLETE' });
imageCache.sheets['CMS Components'].push({ 'Category ID': '149', 'Channel ID': '4', 'Component Path': '0', 'Component Name': 'Image section', 'Component Type': 'Section' });
for (const [name, value] of [['heading', 'Tervetuloa'], ['text', 'Kuvaus'], ['image', imageUrl]]) {
    imageCache.sheets['CMS Properties'].push({ 'Category ID': '149', 'Channel ID': '4', 'Component Path': '0',
        'Property Name': name, 'Property Type': name === 'image' ? 'image' : 'string', 'Property Value': value });
}
const cmsTranslations = translationRows({ ...state, cid: collections, collectionCache: imageCache,
    collectionDefinitions: integrationDefinitions, cmsProperties: imageCache.sheets['CMS Properties'] });
assert.ok(cmsTranslations.byLocale.fi.some(row => row.Field === 'Metafield: custom.layout_image_heading_text_content'
    && row['Entity ID'] === '201' && row['Translation Value: fi'].includes('Tervetuloa')));
imageCache.sheets['CMS Components'].find(row => row['Channel ID'] === '4')['Component Name'] = 'Changed structure';
const changedCms = translationRows({ ...state, cid: collections, collectionCache: imageCache,
    collectionDefinitions: integrationDefinitions, cmsProperties: imageCache.sheets['CMS Properties'] });
assert.equal(changedCms.byLocale.fi.some(row => row.Field === 'Metafield: custom.layout_image_heading_text_content'), false);
assert.ok(changedCms.review.some(row => row.Issue === 'cms_translation_not_reconciled' && row.Locale === 'fi'));
const unsafeState = { ...state, collections: [{ ...state.collections[0], Source: { Name: 'Collection', 'Body HTML': '' } }],
    cmsProperties: [{ 'Category ID': '149', 'Channel ID': '1', 'Component Path': '0', 'Property Name': 'text', 'Property Value': '<script>alert(1)</script>' }] };
assert.equal(collectionBody(unsafeState, unsafeState.collections[0]), '');
assert.ok(matrixifyRows(unsafeState).conflicts.some(row => row.Type === 'unsafe_collection_body_fallback'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'norce-matrixify-runs-'));
try {
    const base = { '02-products.xlsx': { Products: updates.productUpdates }, '03-collections.xlsx': { Collections: updates.collectionUpdates } };
    const first = publishMatrixifyRun(temp, { ...base, '04-translations-no.xlsx': { Translations: translations.byLocale.no } });
    const second = publishMatrixifyRun(temp, { ...base, '04-translations-no.xlsx': { Translations: [] } });
    assert.notEqual(first.directory, second.directory);
    assert.ok(fs.existsSync(path.join(first.directory, '04-translations-no.xlsx')));
    assert.equal(fs.existsSync(path.join(second.directory, '04-translations-no.xlsx')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(second.directory, 'manifest.json'))).files.sort(), ['02-products.xlsx', '03-collections.xlsx']);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log('Norce Matrixify safety test passed');
