const assert = require('assert');
const {
    propertyHtml, componentKeys, approvedLookup, contentMapLookup,
    approveUrlCandidates, buildArtifacts, matrixifyRows,
} = require('../src/importers/fyrklovern/build-collection-content-import');

assert.equal(propertyHtml({ propertyName: 'heading', value: '<Intro>' }), '<h2>&lt;Intro&gt;</h2>');
assert.equal(propertyHtml({ propertyName: 'text', value: '<p>Body</p>' }), '<p>Body</p>');
assert.equal(propertyHtml({ propertyName: 'alt', value: 'not content' }), '');
assert.deepEqual(componentKeys([
    { componentType: 'headingAndParagraphs', order: 1 },
    { componentType: 'headingAndParagraphs', order: 2 },
]), [
    { componentType: 'headingAndParagraphs', order: 1, metafieldKey: 'norce_headingandparagraphs_01' },
    { componentType: 'headingAndParagraphs', order: 2, metafieldKey: 'norce_headingandparagraphs_02' },
]);

const category = (culture, text) => ({
    categoryId: '149', culture, key: `149\0${culture}`, source: { text },
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
const categoryData = { categories, diagnostics: { categoryConflicts: [], permalinkConflicts: [] } };
const contentMap = contentMapLookup({ mappings: [{ categoryId: '149', culture: 'sv-SE', contentId: 'content-149' }] });
const cms = { contents: [
    { contentId: 'content-149', culture: 'sv-SE', components: [rootText('CMS description', 1), component('Rubrik', 2)] },
    { contentId: 'content-149', culture: 'en-GB', components: [rootText('CMS description EN', 2), component('Heading', 3)] },
] };
const approvals = approvedLookup([{ CategoryID: '149', Culture: 'sv-SE', ShopifyID: '7001', ManualApproval: 'Approved' }]);
const artifacts = buildArtifacts({
    categoryData, contentMap, cms, approvals,
    collections: [{ ID: '7001', Handle: 'test-collection', Title: 'Test', 'Top Row': true }],
});
assert.equal(artifacts.importable.length, 1, 'only explicit Swedish approval becomes an import row');
assert.equal(artifacts.review.find(row => row.Culture === 'en-GB').Status, 'unapproved collection match');
assert.equal(artifacts.importable[0].description, 'CMS description', 'CMS root text becomes collection description');
assert.equal(artifacts.translationData.get('en-GB').length, 2, 'description and metafield translation are generated');
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
assert.equal(matrixify.rows.length, 1);
assert.equal(matrixify.rows[0].Command, 'UPDATE');
assert.equal(matrixify.rows[0]['Metafield Value Type'], 'rich_text_field');
assert.equal(matrixify.rows[0]['Metafield Value'], '<h2>Rubrik</h2>');
assert.equal(matrixify.rows.length, 1, 'root text is not duplicated as a rich-text metafield');
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
