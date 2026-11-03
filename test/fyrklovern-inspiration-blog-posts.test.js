const assert = require('assert');
const { build, renderComponents, safeHtml, BLOG_HEADERS } = require('../src/importers/fyrklovern/build-inspiration-blog-posts');
const { loadCache, setProgress, setRaw } = require('../src/importers/fyrklovern/norce-extraction/cache');

const property = (name, value) => ({ name, value: { value } });
const image = url => ({ type: 'imageItem', properties: [property('image', url), property('alt', 'A table')] });
const items = [
  { type: 'Content Page Header', properties: [property('heading', 'Hello'), property('content', '<p>Intro <strong>text</strong></p>')] },
  { type: 'InspirationBlock', properties: [property('title', 'Next'), property('text', 'More detail about the table setting and how to make it memorable for guests.')], children: [image('https://example.com/photo.jpg'), { type: 'link', properties: [] }] },
  { type: 'ProductsBlock', properties: [], children: [{ type: 'productItem' }] },
];

const rendered = renderComponents(items);
assert(rendered.html.indexOf('Intro') < rendered.html.indexOf('Next'));
assert(rendered.html.indexOf('Next') < rendered.html.indexOf('photo.jpg'));
assert.strictEqual(rendered.images.length, 1);
assert(rendered.review.some(row => row.type === 'ProductsBlock'));
assert(rendered.review.some(row => row.type === 'InspirationBlock/link'));
assert(!safeHtml('<script>alert(1)</script><p onclick="bad()">Safe <a href="javascript:alert(1)">link</a></p>').includes('javascript:'));
assert(!safeHtml('<script>alert(1)</script>').includes('alert'));
assert(!BLOG_HEADERS.includes('SEO Title'));

const cache = loadCache('__nonexistent_inspiration_test_cache__.xlsx', 'collections');
setProgress(cache, '507', 1, 'category', { Status: 'COMPLETE' });
setRaw(cache, '507', 1, 'category', { id: 507, name: '5 dukningstips till påsk', data: { items } });
const categories = [{ categoryId: '507', culture: 'sv-SE', permalinkConflict: false, permalinks: [{ Link: '/inspiration/dukningstips/hogtider/5-dukningstips-till-pask/' }], source: {} }];
let result = build({ categories, cache });
assert.strictEqual(result.posts.length, 1);
assert.strictEqual(result.posts[0].Published, 'FALSE');
assert.strictEqual(result.posts[0].Command, 'NEW');
assert.strictEqual(result.posts[0]['Blog: Handle'], 'inspiration');
assert.strictEqual(result.redirects.length, 1);
assert(result.qa.some(row => row['Category ID'] === '610' && row.Status === 'HELD'));
assert(result.qa.some(row => row['Category ID'] === '500' && row.Status === 'HELD'));

// An incomplete current cache cannot produce an import row.
setProgress(cache, '507', 1, 'category', { Status: 'FAILED' });
result = build({ categories, cache });
assert.strictEqual(result.posts.length, 0);
assert.strictEqual(result.redirects.length, 0);
console.log('fyrklovern inspiration blog posts tests passed');
