const assert = require('node:assert/strict');
const { test } = require('node:test');
const { OLD_FIELD, NEW_FIELD, buildProductCollectionLinks } = require('../src/importers/fyrklovern/product-collection-link-mapping');

test('converts one source category ID to one Shopify collection reference', () => {
    const products = [{ Handle: 'old-plate', 'Metafield: custom.external_id [single_line_text_field]': '1001', [OLD_FIELD]: '149' }];
    const categories = [{ id: '149', handle: 'plates' }];
    const collections = [{ ID: '728776376660', Handle: 'plates', 'Top Row': true }];
    const live = [{ ID: '15794895913300', Handle: 'current-plate', 'Variant SKU': '1001' }];
    const result = buildProductCollectionLinks(products, categories, collections, live);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.rows, [{ ID: '15794895913300', Handle: 'current-plate', 'Variant SKU [ID]': '1001', Command: 'UPDATE', [NEW_FIELD]: '728776376660', [OLD_FIELD]: '' }]);
});

test('leaves an unmapped source ID out of the import and reports it', () => {
    const result = buildProductCollectionLinks(
        [{ Handle: 'plate', 'Metafield: custom.external_id [single_line_text_field]': '1001', [OLD_FIELD]: '999' }], [], [],
        [{ ID: '15794895913300', Handle: 'plate', 'Variant SKU': '1001' }]
    );
    assert.equal(result.rows.length, 0);
    assert.equal(result.unresolved[0].sourceCategoryId, '999');
});

test('uses only an explicitly approved target when the source category is missing', () => {
    const result = buildProductCollectionLinks(
        [{ Handle: 'plate', 'Metafield: custom.external_id [single_line_text_field]': '1001', [OLD_FIELD]: '999' }], [],
        [{ ID: '728776376660', Handle: 'plates', 'Top Row': true }],
        [{ ID: '15794895913300', Handle: 'plate', 'Variant SKU': '1001' }],
        { 999: '728776376660' }
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0][NEW_FIELD], '728776376660');
    assert.equal(result.mapped[0].mappingSource, 'approved map');
});

test('excludes a product absent from the live SKU export', () => {
    const result = buildProductCollectionLinks(
        [{ Handle: 'old-plate', 'Metafield: custom.external_id [single_line_text_field]': '1001', [OLD_FIELD]: '149' }],
        [{ id: '149', handle: 'plates' }],
        [{ ID: '728776376660', Handle: 'plates', 'Top Row': true }],
        [{ ID: '15794895913300', Handle: 'other', 'Variant SKU': '2002' }]
    );
    assert.equal(result.rows.length, 0);
    assert.equal(result.unresolved[0].reason, 'product absent from live Shopify export');
});

test('matches by external ID when the live Shopify SKU differs', () => {
    const result = buildProductCollectionLinks(
        [{ Handle: 'old-plate', 'Metafield: custom.external_id [single_line_text_field]': '1001', [OLD_FIELD]: '149' }],
        [{ id: '149', handle: 'plates' }],
        [{ ID: '728776376660', Handle: 'plates', 'Top Row': true }],
        [{ Handle: 'current-plate', 'Variant SKU': '34-0501', 'External ID (product.metafields.custom.external_id)': '1001' }]
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0].Handle, 'current-plate');
    assert.equal(result.rows[0]['Variant SKU [ID]'], '34-0501');
});

test('strips the Excel text prefix from numeric SKUs in a Shopify CSV', () => {
    const result = buildProductCollectionLinks(
        [{ Handle: 'old-plate', 'Metafield: custom.external_id [single_line_text_field]': '1001', [OLD_FIELD]: '149' }],
        [{ id: '149', handle: 'plates' }],
        [{ ID: '728776376660', Handle: 'plates', 'Top Row': true }],
        [{ Handle: 'current-plate', 'Variant SKU': "'1001", 'External ID (product.metafields.custom.external_id)': '1001' }]
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0]['Variant SKU [ID]'], '1001');
});

test('takes current category ID and handle from the live Shopify export', () => {
    const result = buildProductCollectionLinks(
        [{ Handle: 'stale-product', 'Metafield: custom.external_id [single_line_text_field]': '1001', [OLD_FIELD]: '149' }],
        [{ id: '149', handle: 'plates' }],
        [{ ID: '728776376660', Handle: 'plates', 'Top Row': true }],
        [
            { Handle: 'current-product', 'Variant SKU': "'1001", 'Collection Category ID (product.metafields.custom.collection_category_id)': '149' },
            { Handle: 'another-product', 'Variant SKU': '1002', 'Collection Category ID (product.metafields.custom.collection_category_id)': '' },
        ]
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.selectedCount, 1);
    assert.deepEqual(result.rows, [{ ID: '', Handle: 'current-product', 'Variant SKU [ID]': '1001', Command: 'UPDATE', [NEW_FIELD]: '728776376660', [OLD_FIELD]: '' }]);
});

test('excludes live products whose category IDs have no verified collection mapping', () => {
    const result = buildProductCollectionLinks(
        [], [], [],
        [{ Handle: 'current-product', 'Variant SKU': '1001', 'Collection Category ID (product.metafields.custom.collection_category_id)': '999' }]
    );
    assert.equal(result.selectedCount, 1);
    assert.equal(result.rows.length, 0);
    assert.equal(result.unresolved[0].sourceCategoryId, '999');
});

test('uses the Swedish DynamicFields category ID when Shopify holds a different ID', () => {
    const result = buildProductCollectionLinks(
        [], [{ id: '1343', handle: 'silhouette' }],
        [{ ID: '728776376660', Handle: 'silhouette', 'Top Row': true }],
        [{ Handle: 'current-product', 'Variant SKU': '1001',
            'External ID (product.metafields.custom.external_id)': '1001',
            'Collection Category ID (product.metafields.custom.collection_category_id)': '1344' }],
        {}, [{ ArticleNumber: '1001', ItemName: 'Collection category ID', Culture: 'sv-SE', Value: '1343' }]
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0][NEW_FIELD], '728776376660');
    assert.equal(result.mapped[0].sourceCategoryId, '1343');
    assert.equal(result.mapped[0].shopifyOldCategoryId, '1344');
});
