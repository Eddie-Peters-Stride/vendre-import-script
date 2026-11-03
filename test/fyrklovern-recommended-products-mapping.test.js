const assert = require('node:assert/strict');
const { test } = require('node:test');
const { FIELD, buildRecommendedProducts } = require('../src/importers/fyrklovern/recommended-products-mapping');

const live = (handle, article, sku = article, current = '') => ({
    Handle: handle, 'External ID (product.metafields.custom.external_id)': article,
    'Variant SKU': `'${sku}`,
    'Recommended products (product.metafields.custom.recommended_products)': current,
});
const relation = (owner, target, order) => ({
    'Huvudprodukt Artikelnummer': owner,
    'Kopplad produkt Artikelnummer': target,
    SortOrder: String(order),
});

test('updates an existing product using current handles, SKU and Norce sort order', () => {
    const result = buildRecommendedProducts(
        [relation('1001', '1003', 10), relation('1001', '1002', 0)],
        [live('owner-current', '1001', '1001', 'target-three'),
            live('target-two', '1002'), live('target-three', '1003')]
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.rows, [{ Handle: 'owner-current', 'Variant SKU [ID]': '1001',
        Command: 'UPDATE', [FIELD]: 'target-two; target-three' }]);
});

test('skips an unchanged list and excludes unavailable references', () => {
    const result = buildRecommendedProducts(
        [relation('1001', '1002', 0), relation('1001', '9999', 5), relation('1003', '9999', 0)],
        [live('owner-one', '1001', '1001', 'target-two'), live('target-two', '1002'), live('owner-three', '1003')]
    );
    assert.equal(result.rows.length, 0);
    assert.deepEqual(result.review.find(item => item.article === '1001').unresolvedArticles, ['9999']);
    assert.equal(result.review.find(item => item.article === '1003').status, 'no linked products in live Shopify export');
});

test('does not clear current recommendations when all Norce targets are absent', () => {
    const result = buildRecommendedProducts([relation('1001', '9999', 0)],
        [live('owner-one', '1001', '1001', 'existing-target')]);
    assert.equal(result.rows.length, 0);
    assert.equal(result.review[0].status, 'no linked products in live Shopify export');
});
