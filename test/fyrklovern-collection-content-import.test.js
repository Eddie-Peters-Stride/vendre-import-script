const assert = require('assert');
const {
    propertyHtml, componentKeys, approvedLookup, contentMapLookup,
    approveUrlCandidates, buildArtifacts, matrixifyRows, componentCategoryIds,
    resolveCategoryReference, buildCategoryReferenceLookup,
} = require('../src/importers/fyrklovern/build-collection-content-import');

assert.equal(propertyHtml({ propertyName: 'heading', value: '<Intro>' }), '<h2>&lt;Intro&gt;</h2>');
assert.equal(propertyHtml({ propertyName: 'text', value: '<p>Body</p>' }), '<p>Body</p>');
assert.equal(propertyHtml({ propertyName: 'alt', value: 'not content' }), '');
assert.deepEqual(componentKeys([
    { componentType: 'headingAndParagraphs', order: 1 },
    { componentType: 'headingAndParagraphs', order: 2 },
]), [
    { componentType: 'headingAndParagraphs', order: 1, sectionNumber: 1, metafieldKey: 'section_1' },
    { componentType: 'headingAndParagraphs', order: 2, sectionNumber: 2, metafieldKey: 'section_2' },
]);

const category = (culture, text, categoryId = '149') => ({
    categoryId, culture, key: `${categoryId}\0${culture}`, source: { text },
});
const categories = [category('sv-SE', 'Beskrivning'), category('en-GB', 'Description')];
const component = (value, sourceRow) => ({
    componentType: 'headingAndParagraphs', order: 1, sourceOrder: sourceRow,
    items: [{ propertyName: 'heading', value, sourceRow, order: sourceRow }],
});
const rootText = (value, sourceRow) => ({
    componentType: 'root', order: 0, sourceOrder: sourceRow,
    items: [{ propertyName: 'text', value, sourceRow, order: sourceRow }],
});
const namedText = (itemName, value, sourceRow, targetCategoryIds = []) => ({
    itemName, componentType: 'root', order: sourceRow, sourceOrder: sourceRow,
    items: [
        { propertyName: 'text', value, sourceRow, order: sourceRow },
        { propertyName: 'linktext', value: 'Shop now', sourceRow: sourceRow + 10, order: sourceRow + 10 },
        { propertyName: 'link', value: 'https://example.com/collection', sourceRow: sourceRow + 11, order: sourceRow + 11 },
        ...targetCategoryIds.map((id, index) => ({
            propertyName: ['catIdDK', 'catIdFI', 'catIdNO'][index] || `catIdM${index}`,
            value: id, cultureValues: { 'sv-SE': id, 'da-DK': '9999' }, sourceRow: sourceRow + index + 1, order: sourceRow + index + 1,
        })),
    ],
});
const categoryData = { categories: [...categories, category('sv-SE', '', '1810')], diagnostics: { categoryConflicts: [], permalinkConflicts: [] } };
const contentMap = contentMapLookup({ mappings: [{ categoryId: '149', culture: 'sv-SE', contentId: 'content-149' }] });
const cms = { contents: [
    { contentId: 'content-149', culture: 'sv-SE', components: [
        rootText('CMS description', 1), component('Rubrik', 2), namedText('Julens serviser 2026', 'Promotional section copy', 3, ['1810', '1810']),
    ] },
    { contentId: 'content-149', culture: 'en-GB', components: [
        rootText('CMS description EN', 2), component('Heading', 3), namedText('Julens serviser 2026', 'Localized section copy', 4, ['1810', '1810']),
    ] },
] };
const approvalRows = [
    { CategoryID: '149', Culture: 'sv-SE', ShopifyID: '7001', ManualApproval: 'Approved' },
    { CategoryID: '1810', Culture: 'sv-SE', ShopifyID: '8100', ManualApproval: 'Approved' },
];
const approvals = approvedLookup(approvalRows);
const collectionRows = [
    { ID: '7001', Handle: 'test-collection', Title: 'Test', 'Top Row': true },
    { ID: '8100', Handle: 'julens-serviser', Title: 'Julens serviser', 'Top Row': true },
];
const artifacts = buildArtifacts({
    categoryData, contentMap, cms, approvals,
    collections: collectionRows,
});
assert.equal(artifacts.importable.length, 1, 'only explicit Swedish approval becomes an import row');
assert.equal(artifacts.review.find(row => row.Culture === 'en-GB').Status, 'unapproved collection match');
assert.equal(artifacts.importable[0].description, 'CMS description', 'CMS root text becomes collection description');
assert.deepEqual(artifacts.importable[0].metafields.map(field => field.key), [
    'section_2_header', 'section_3_text', 'section_3_linktext', 'section_3_link', 'section_3_collection',
], 'metafield keys identify section order and CMS field type');
assert.equal(artifacts.importable[0].metafields[1].value, 'Promotional section copy',
    'later text fields remain section metafields instead of being appended to the collection description');
assert.deepEqual(componentCategoryIds(cms.contents[0].components[2]), ['1810'],
    'identical market-specific catId values collapse to one Norce target category');
const referenceField = artifacts.importable[0].metafields.find(field => field.type === 'collection_reference');
assert.deepEqual(referenceField, {
    key: 'section_3_collection', type: 'collection_reference', value: 'julens-serviser',
    componentName: 'Julens serviser 2026', componentOrder: 3, sourceRows: [4, 5],
    sourceCategoryIds: ['1810'], targetShopifyId: '8100', targetHandle: 'julens-serviser',
});
assert.equal(artifacts.textAssignmentReview.find(row => row.Component === 'Julens serviser 2026')['Storefront display check'],
    'unverified: CMS export contains no publish/visibility status', 'CMS assignment is not misrepresented as live display');
const referenceLookup = buildCategoryReferenceLookup(approvals, collectionRows);
assert.equal(resolveCategoryReference(['1810', '1811'], referenceLookup).status,
    'multiple market category IDs; manual review required');
assert.equal(artifacts.translationData.get('en-GB').length, 5, 'description and section metafield translations are generated');
assert.equal(approvedLookup([{ CategoryID: '149', Culture: 'sv-SE', CandidateShopifyID: '7001', ManualApproval: 'Pending' }]).size, 0,
    'a candidate remains unusable until explicitly approved');
assert.equal(approvedLookup([{ CategoryID: '149', Culture: 'sv-SE', CandidateShopifyID: '7001', ManualApproval: 'Approved' }]).get('149\0sv-SE').has('7001'), true,
    'a candidate target can be approved directly in the mapping report');
assert.deepEqual(approveUrlCandidates({ mappings: [
    { CategoryID: '1', Culture: 'sv-SE', ShopifyID: '7001', Status: 'URL candidate - manual approval required' },
    { CategoryID: '2', Culture: 'sv-SE', ShopifyID: '7002', Status: 'title-only suggestion - unverified' },
    { CategoryID: '3', Culture: 'sv-SE', ShopifyID: '', Status: 'URL candidate - manual approval required' },
]}), [{ CategoryID: '1', Culture: 'sv-SE', ShopifyID: '7001', ManualApproval: 'Approved' }],
'bulk approval targets only exact URL candidates');

const matrixify = matrixifyRows(artifacts.importable);
assert.deepEqual(matrixify.headers.slice(-4), [
    'Metafield Namespace', 'Metafield Key', 'Metafield Value Type', 'Metafield Value',
]);
assert.equal(matrixify.rows.length, 5);
assert.equal(matrixify.rows[0].Command, 'UPDATE');
assert.equal(matrixify.rows[0]['Metafield Value Type'], 'rich_text_field');
assert.equal(matrixify.rows[0]['Metafield Key'], 'section_2_header');
assert.equal(matrixify.rows[0]['Metafield Value'], '<h2>Rubrik</h2>');
assert.equal(matrixify.rows[1]['Metafield Key'], 'section_3_text');
assert.equal(matrixify.rows[1]['Metafield Value'], 'Promotional section copy');
assert.equal(matrixify.rows[2]['Metafield Key'], 'section_3_linktext');
assert.equal(matrixify.rows[3]['Metafield Value Type'], 'single_line_text_field');
assert.equal(matrixify.rows[3]['Metafield Key'], 'section_3_link');
assert.equal(matrixify.rows[4]['Metafield Value Type'], 'collection_reference');
assert.equal(matrixify.rows[4]['Metafield Key'], 'section_3_collection');
assert.equal(matrixify.rows[4]['Metafield Value'], 'julens-serviser');
assert(!('Handle' in matrixify.rows[0]), 'update workbook does not touch collection handles');

const twoFields = matrixifyRows([{
    collection: { ID: '7002' }, description: '',
    metafields: [
        { key: 'norce_root_01', type: 'rich_text_field', value: '<p>First</p>' },
        { key: 'norce_root_02', type: 'rich_text_field', value: '<p>Second</p>' },
    ], images: [],
}]);
assert.equal(twoFields.rows.length, 2, 'row-based metafields get separate rows');
assert(twoFields.rows.every(row => row['Metafield Value']), 'no blank metafield cells can request deletions');
const noDescription = matrixifyRows([{
    collection: { ID: '7003' }, description: '',
    metafields: [{ key: 'norce_root_01', type: 'rich_text_field', value: '<p>Only metadata</p>' }], images: [],
}], { includeBodyHtml: false });
assert(!noDescription.headers.includes('Body HTML'), 'metafield-only imports omit Body HTML entirely');

console.log('Fyrklövern collection content import tests passed.');
