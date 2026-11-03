const assert = require('assert');
const { loadCache, upsert, setProgress } = require('../src/importers/fyrklovern/norce-extraction/cache');
const { imageFilename } = require('../src/importers/fyrklovern/build-collection-content-import');
const { buildVerifiedCollectionFileReferences } = require('../src/importers/fyrklovern/norce-extraction/verified-file-references');

const cache = loadCache('unused-verified-files.xlsx', 'collections');
upsert(cache, 'Collections', ['Category ID', 'Channel ID'], { 'Category ID': '149', 'Channel ID': '1', 'Shopify Collection ID': '728776376660' });
setProgress(cache, '149', '1', 'category', { Status: 'COMPLETE' });
cache.sheets['CMS Components'].push({ 'Category ID': '149', 'Channel ID': '1', 'Component Path': '0', 'Component Name': 'Image section', 'Component Type': 'Section' });
for (const [name, value] of [['heading', 'Welcome'], ['text', 'Description'], ['image', 'https://example.com/image-a.jpg']]) {
  cache.sheets['CMS Properties'].push({ 'Category ID': '149', 'Channel ID': '1', 'Component Path': '0', 'Property Name': name,
    'Property Type': name === 'image' ? 'image' : 'string', 'Property Value': value });
}
const url = 'https://example.com/image-a.jpg';
cache.sheets['Collection Images'].push({ 'Category ID': '149', 'Channel ID': '1', 'Component Path': '0', 'Image URL': url });
const filename = imageFilename(url);
const verified = buildVerifiedCollectionFileReferences(cache, [{ 'File Name': filename, Status: 'Ready' }]);
assert.equal(verified.rows.length, 1);
assert.equal(verified.rows[0].Command, 'UPDATE');
assert.deepEqual(JSON.parse(verified.rows[0]['Metafield: custom.layout_image_heading_text_images [list.file_reference]']), [filename]);
assert.equal(verified.verifiedCandidates.length, 1);
const pending = buildVerifiedCollectionFileReferences(cache, [{ 'File Name': filename, Status: 'Processing' }]);
assert.equal(pending.rows.length, 0);
assert.equal(pending.review.some(row => row.reason === 'File Name is not successful or Ready'), true);
const ambiguous = buildVerifiedCollectionFileReferences(cache, [{ 'File Name': filename, Status: 'Ready' }, { 'File Name': filename, Status: 'Ready' }]);
assert.equal(ambiguous.rows.length, 0);
assert.equal(ambiguous.review.some(row => row.reason === 'ambiguous File Name in Files result/export'), true);
upsert(cache, 'Collections', ['Category ID', 'Channel ID'], { 'Category ID': '150', 'Channel ID': '1', 'Shopify Collection ID': '728776376660' });
setProgress(cache, '150', '1', 'category', { Status: 'COMPLETE' });
const aliases = buildVerifiedCollectionFileReferences(cache, [{ 'File Name': filename, Status: 'Ready' }]);
assert.equal(aliases.rows.length, 0);
assert.equal(aliases.review.some(row => /approved alias handling/.test(row.reason)), true);
console.log('Norce verified Files reconciliation test passed');
