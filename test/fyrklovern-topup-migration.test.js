const assert = require('assert');
const { normalizeSku, normalizeUrl, normalizeList, sameValue, parseCsvRecord, indexLiveProducts } = require('../src/fyrklovern/topup-migration');

assert.equal(normalizeSku("'10014060"), '10014060');
assert.equal(normalizeUrl('http://Example.test/pic.jpg?x=1'), 'https://example.test/pic.jpg');
assert.deepEqual(normalizeList('["one", "two"]'), ['one', 'two']);
assert.equal(sameValue('Metafield: custom.collection [list.single_line_text_field]', 'one,two', '["one","two"]'), true);
assert.deepEqual(parseCsvRecord('"A, B",plain,"say ""hi"""'), ['A, B', 'plain', 'say "hi"']);

const live = indexLiveProducts([
    { ID: '1', Handle: 'nordic-dawn', 'Variant SKU': '10014060', 'Image Src': 'https://example.test/one.jpg', 'Image Position': '1' },
    { ID: '1', Handle: 'nordic-dawn', 'Image Src': 'https://example.test/two.jpg', 'Image Position': '2' },
]);
assert.equal(live.bySku.get('10014060').handle, 'nordic-dawn');
assert.equal(live.byHandle.get('nordic-dawn').rows.length, 2);
console.log('fyrklovern top-up utility tests passed');
