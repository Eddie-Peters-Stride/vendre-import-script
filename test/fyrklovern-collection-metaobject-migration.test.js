const assert = require('node:assert/strict');
const {
    BLOCK_TYPES, FIELD_DEFINITIONS, classify, contentBlocksForCategory, collectionGid, attachTranslations, applyPlan,
} = require('../src/importers/fyrklovern/collection-metaobject-migration');

function component(type, name, properties, extra = {}) {
    return { componentType: type, itemName: name, componentId: extra.id || '', order: extra.order || 1,
        hierarchyPath: extra.path || [extra.order || 1], relatedCollectionIds: extra.relatedCollectionIds || [], items: properties.map(([propertyName, value], index) => ({
            propertyName, propertyType: 'String', valueType: 'String', value, rawValue: { value },
            order: index + 1, sourceRow: `${extra.order || 1}.${index + 1}`,
        })) };
}

assert.equal(classify(component('Text Block', 'Intro', [['text', 'Hello']])), 'rich_text');
assert.equal(classify(component('Campaign Item', 'Campaign', [['image', 'https://cdn.example/a.jpg']])), 'banner');
assert.equal(classify(component('InspirationBlock', 'Gallery', [['image', 'https://cdn.example/a.jpg']])), 'gallery');
assert.equal(classify(component('Video', 'Film', [['videoId', 'abc']])), 'video');
assert.equal(classify(component('themeSelector', 'Theme', [['themeName', 'Warm']])), 'fallback');

const blocks = contentBlocksForCategory('123', [
    component('Category Page Header', 'Collection', [['heading', 'Plates'], ['text', '<p>Intro</p>']], { id: 'header', order: 1 }),
    component('Content Page Image Section', 'Story', [['heading', 'Story'], ['text', '<p>More</p>'], ['image', 'https://cdn.example/story.jpg'], ['imageFocus', 'center']], { id: 'story', order: 2 }),
    component('Unknown Widget', 'Odd', [['opaque', 'keep-me']], { id: 'odd', order: 3 }),
], { sourceRow: '1.2' });
assert.deepEqual(blocks.map(block => block.type), [BLOCK_TYPES.rich_text, BLOCK_TYPES.image_text, BLOCK_TYPES.fallback]);
assert.equal(blocks[0].fields.heading, 'Plates');
assert.equal(blocks[0].fields.content_html, '');
assert.equal(blocks[0].fields.source_payload.includes('Intro'), false, 'collection Body HTML text is not duplicated in blocks');
assert.equal(blocks[0].fields.source_payload.includes('Plates'), true);
assert.equal(blocks[1].fields.heading, 'Story');
assert.equal(blocks[1].fields.content_html, '<p>More</p>');
assert.equal(blocks[1].fields.source_payload.includes('imageFocus'), true);
assert.equal(blocks[1].imageUrls[0], 'https://cdn.example/story.jpg');
assert.equal(blocks[2].fields.source_payload.includes('keep-me'), true, 'unknown source fields are retained');
const linked = contentBlocksForCategory('123', [component('Campaign Item', 'Campaign', [
    ['linkText', 'Shop now'], ['linkUrl', '/collections/summer'], ['alt', 'Summer table'],
], { id: 'campaign', relatedCollectionIds: ['gid://shopify/Collection/99'] })])[0];
assert.equal(linked.fields.link_label, 'Shop now');
assert.equal(linked.fields.link_url, '/collections/summer');
assert.equal(linked.fields.alt_text, 'Summer table');
assert.equal(linked.fields.related_collections, '["gid://shopify/Collection/99"]');
const translationBlocks = contentBlocksForCategory('123', [component('Text Block', 'Translated', [['heading', 'Hello'], ['text', 'Body']], { id: 'translated' })]);
attachTranslations(translationBlocks, new Map([['en-GB', [
    { 'Entity Handle': 'plates', Field: 'Metafield: custom.section_1_header', 'Translation Value: en': '<h2>Hello &amp; world</h2>' },
    { 'Entity Handle': 'plates', Field: 'Metafield: custom.section_1_text', 'Translation Value: en': '<p>Translated body</p>' },
]]]), 'plates');
assert.deepEqual(translationBlocks[0].translations.en, { heading: 'Hello & world', content_html: '<p>Translated body</p>' });
assert.equal(blocks[1].handle, contentBlocksForCategory('123', [
    component('Content Page Image Section', 'Story', [['heading', 'Changed'], ['text', '<p>More</p>'], ['image', 'https://cdn.example/story.jpg']], { id: 'story', order: 2 }),
])[0].handle, 'content changes retain a deterministic handle');

const many = contentBlocksForCategory('123', Array.from({ length: 34 }, (_, index) =>
    component('Text Block', `Block ${index + 1}`, [['text', `Text ${index + 1}`]], { id: `block-${index + 1}`, order: index + 1 })));
assert.equal(many.length, 34);
assert.equal(new Set(many.map(block => block.handle)).size, 34);
assert.equal(collectionGid('12345'), 'gid://shopify/Collection/12345');
assert.equal(collectionGid('gid://shopify/Collection/12345'), 'gid://shopify/Collection/12345');

async function testApplyIdempotency() {
    const definitions = Object.values(BLOCK_TYPES).map((type, index) => ({ id: `gid://shopify/MetaobjectDefinition/${index + 1}`, type,
        fieldDefinitions: FIELD_DEFINITIONS.map(([key, , fieldType]) => ({ key, type: { name: fieldType } })) }));
    const definitionIds = JSON.stringify(definitions.map(item => item.id));
    const entries = new Map();
    let references = [];
    let setCount = 0;
    const client = { async query(query, variables = {}) {
        if (query.includes('metaobjectDefinitions(first: 250)')) return { metaobjectDefinitions: { nodes: definitions } };
        if (query.includes('metafieldDefinitions(first: 20')) return { metafieldDefinitions: { nodes: [{ id: 'gid://shopify/MetafieldDefinition/1',
            type: { name: 'list.mixed_reference' }, validations: [{ name: 'metaobject_definition_ids', value: definitionIds }] }] } };
        if (query.includes('query CollectionBlocks')) return { collection: { id: variables.id, metafield: references.length ? {
            type: 'list.mixed_reference', value: JSON.stringify(references.map(item => item.id)), references: { nodes: references },
        } : null } };
        if (query.includes('ExistingMetaobject')) return { metaobject: entries.get(`${variables.handle.type}/${variables.handle.handle}`) || null };
        if (query.includes('UpsertBlock')) {
            const key = `${variables.handle.type}/${variables.handle.handle}`;
            const entry = { id: entries.get(key)?.id || `gid://shopify/Metaobject/${entries.size + 1}`,
                handle: variables.handle.handle, type: variables.handle.type,
                fields: variables.metaobject.fields.map(({ key: fieldKey, value }) => ({ key: fieldKey, value })) };
            entries.set(key, entry);
            return { metaobjectUpsert: { metaobject: entry, userErrors: [] } };
        }
        if (query.includes('metafieldsSet')) {
            setCount += 1;
            const ids = JSON.parse(variables.metafields[0].value);
            references = ids.map(id => [...entries.values()].find(entry => entry.id === id));
            return { metafieldsSet: { metafields: [], userErrors: [] } };
        }
        throw new Error(`Unexpected mocked query: ${query.slice(0, 80)}`);
    } };
    const makePlan = components => ({ summary: { maxBlocksPerCollection: components.length }, collections: [{
        categoryId: '123', collectionId: '456', collectionHandle: 'plates',
        blocks: contentBlocksForCategory('123', components), blockCount: components.length,
    }] });
    const firstPlan = makePlan([
        component('Text Block', 'First', [['text', 'A']], { id: 'first' }),
        component('Text Block', 'Second', [['text', 'B']], { id: 'second', order: 2 }),
    ]);
    await applyPlan(firstPlan, client);
    await applyPlan(firstPlan, client);
    assert.equal(setCount, 1, 'reimporting the same collection does not write the list again');
    const firstEntry = entries.get(`${BLOCK_TYPES.rich_text}/${firstPlan.collections[0].blocks[0].handle}`);
    const savedFields = firstEntry.fields.map(field => ({ ...field }));
    firstEntry.fields.find(field => field.key === 'content_html').value = 'merchant edit';
    await assert.rejects(() => applyPlan(firstPlan, client), /refusing to overwrite possible manual edits/);
    firstEntry.fields = savedFields;
    const changedPlan = makePlan([
        component('Text Block', 'First', [['text', 'Updated by Norce']], { id: 'first' }),
        component('Text Block', 'Second', [['text', 'B']], { id: 'second', order: 2 }),
    ]);
    await applyPlan(changedPlan, client);
    assert.equal(entries.get(`${BLOCK_TYPES.rich_text}/${firstPlan.collections[0].blocks[0].handle}`).fields.find(field => field.key === 'content_html').value, 'Updated by Norce',
        'source changes update an unchanged, unedited metaobject');
    const updatedPlan = makePlan([
        component('Text Block', 'Second', [['text', 'B']], { id: 'second', order: 1 }),
    ]);
    await assert.rejects(() => applyPlan(updatedPlan, client), /different custom\.content_blocks/);
    await applyPlan(updatedPlan, client, { syncContentBlocks: true });
    assert.equal(setCount, 2, 'explicit sync updates the ordered reference list');
    assert.equal(references.length, 1, 'removed blocks are detached from the list');
    assert.equal(entries.size, 2, 'detached metaobjects are retained, not deleted');
}

testApplyIdempotency().then(() => console.log('Fyrklovern collection metaobject migration unit tests passed.'))
    .catch(error => { console.error(error); process.exitCode = 1; });
