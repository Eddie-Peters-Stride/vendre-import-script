const assert = require('assert');
const { loadCache, upsert, setProgress } = require('../src/importers/fyrklovern/norce-extraction/cache');
const { verifiedDefinitions, buildCollectionCmsMetafieldUpdates } = require('../src/importers/fyrklovern/norce-extraction/collection-cms-metafields');

const cache = loadCache('unused-collection-cache.xlsx', 'collections');
upsert(cache, 'Collections', ['Category ID', 'Channel ID'], { 'Category ID': '149', 'Channel ID': '1', Culture: 'sv-SE', 'Shopify Collection ID': '728776376660', 'Body HTML': '' });
setProgress(cache, '149', '1', 'category', { Status: 'COMPLETE' });
function component(componentPath, name, properties) {
  cache.sheets['CMS Components'].push({ 'Category ID': '149', 'Channel ID': '1', Culture: 'sv-SE', 'Component Path': componentPath,
    'Component Position': Number(componentPath.split('/').at(-1)), 'Component Name': name, 'Component Type': 'Section' });
  for (const [propertyName, value] of properties) cache.sheets['CMS Properties'].push({ 'Category ID': '149', 'Channel ID': '1', Culture: 'sv-SE',
    'Component Path': componentPath, 'Property Name': propertyName, 'Property Type': 'STRING', 'Property Value': value });
}
component('0', 'Body source', [['text', '<p>Body</p>']]);
component('1', 'Introduction', [['heading', 'First heading'], ['text', '<p>First text</p>']]);
component('2', 'More introduction', [['heading', 'Second heading'], ['text', '<p>Second text</p>']]);
component('3', 'Extra text', [['text', '<p>Extra</p>']]);
component('4', 'Unknown', [['videoid', '1234']]);
component('5', 'Unsafe', [['text', '<script>alert(1)</script>']]);
component('6', 'Structured', [['text', '[{"type":"paragraph"}]']]);
component('7', 'Single link', [['link', 'https://example.com/page']]);
const definitions = verifiedDefinitions();
assert.equal(definitions.get('layout_heading_text_content').type, 'rich_text_field');
const result = buildCollectionCmsMetafieldUpdates(cache, { definitions });
const content = result.rows.find(row => row['Metafield: custom.layout_heading_text_content [rich_text_field]']);
assert.ok(content);
assert.equal(content.Command, 'UPDATE');
assert.equal(content.ID, '728776376660');
assert.ok(content['Metafield: custom.layout_heading_text_content [rich_text_field]'].indexOf('First heading') <
  content['Metafield: custom.layout_heading_text_content [rich_text_field]'].indexOf('Second heading'));
assert.equal(result.rows.some(row => row['Metafield: custom.layout_text_block_text [rich_text_field]'] === '<p>Extra</p>'), true);
assert.equal(result.rows.some(row => JSON.stringify(row).includes('<p>Body</p>')), false);
assert.equal(result.rows.some(row => row['Metafield: custom.layout_link_links [single_line_text_field]'] === 'https://example.com/page'), true);
assert.equal(result.rows.some(row => JSON.stringify(row).includes('<script>')), false);
assert.equal(result.unsupported.some(item => item.propertyName === 'videoid'), true);
assert.equal(result.unsupported.some(item => item.reason === 'empty or unsafe CMS value'), true);
assert.equal(result.unsupported.some(item => item.reason === 'structured CMS value needs an explicit mapping'), true);
upsert(cache, 'Collections', ['Category ID', 'Channel ID'], { 'Category ID': '150', 'Channel ID': '1', 'Shopify Collection ID': '728776376660' });
setProgress(cache, '150', '1', 'category', { Status: 'COMPLETE' });
const aliases = buildCollectionCmsMetafieldUpdates(cache, { definitions });
assert.equal(aliases.rows.length, 0);
assert.equal(aliases.unsupported.some(item => /approved alias handling/.test(item.reason)), true);
console.log('Norce collection CMS metafield test passed');
