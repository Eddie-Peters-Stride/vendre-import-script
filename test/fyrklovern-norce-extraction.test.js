const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { extractKind, requiredComplete } = require('../src/importers/fyrklovern/norce-extraction/extract');
const { loadCache, checkpointCache, upsert, setProgress, rawOf } = require('../src/importers/fyrklovern/norce-extraction/cache');
const { CHANNELS } = require('../src/importers/fyrklovern/norce-extraction/channels');
const { appendJournal, readJournal, journalPath } = require('../src/importers/fyrklovern/norce-extraction/journal');
const { acquireCacheLock, lockPath } = require('../src/importers/fyrklovern/norce-extraction/lock');
const { productInventory, productInventoryCsv } = require('../src/importers/fyrklovern/norce-extraction/inventory');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norce-extraction-'));
  try {
    const lockFile = path.join(dir, 'locked.xlsx');
    const release = acquireCacheLock(lockFile);
    assert.throws(() => acquireCacheLock(lockFile), /already in use/);
    release();
    assert.equal(fs.existsSync(lockPath(lockFile)), false);
    fs.writeFileSync(lockPath(lockFile), JSON.stringify({ pid: 2147483647 }));
    acquireCacheLock(lockFile)();
    const inventoryFile = path.join(dir, 'shopify-products.xlsx');
    const inventoryWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(inventoryWorkbook, XLSX.utils.json_to_sheet([
      { ID: '10', Handle: 'one', 'Metafield: custom.external_id [single_line_text_field]': 'A', 'Variant SKU': 'B' },
      { ID: '10', Handle: 'one', 'Variant SKU': 'C' },
      { ID: '20', Handle: 'two', 'Variant SKU': 'B' },
    ]), 'Products');
    XLSX.writeFile(inventoryWorkbook, inventoryFile);
    const inventory = productInventory(inventoryFile);
    assert.deepEqual(inventory.records.map(row => row.articleNumber).sort(), ['A', 'C']);
    assert.equal(inventory.conflicts.length, 1);
    assert.equal(inventory.mismatches.length, 1);
    const historicalFile = path.join(dir, 'historical.xlsx');
    const historicalWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(historicalWorkbook, XLSX.utils.json_to_sheet([
      { ID: '10', Handle: 'one', 'Metafield: custom.external_id [single_line_text_field]': '100', 'Variant SKU': '100' },
    ]), 'Products');
    XLSX.writeFile(historicalWorkbook, historicalFile);
    const nativeCsv = path.join(dir, 'current.csv');
    fs.writeFileSync(nativeCsv, [
      'Handle,Variant SKU,External ID (product.metafields.custom.external_id)',
      "one,'100,100", "new,'200,200", "dup-one,'300,300", "dup-two,'300,300", "mixed,'401,401", "mixed,'402,402",
    ].join('\n'));
    const current = productInventoryCsv(nativeCsv, historicalFile);
    assert.deepEqual(current.records.map(row => [row.articleNumber, row.shopifyProductId]), [['100', '10'], ['200', '']]);
    assert.equal(current.matchedProductCount, 1);
    assert.equal(current.unmatchedProductCount, 1);
    assert.equal(current.conflicts.length, 1);
    assert.equal(current.handleConflicts.length, 1);
    const file = path.join(dir, 'products.xlsx');
    const calls = [];
    const client = { async productGroup(id, channel, group) {
      calls.push(`${id}/${channel.id}/${group}`);
      if (group === 'basic') return { id: 2204, articleNumber: id, name: 'Mugg', description: 'A'.repeat(70000) };
      if (group === 'attributes') return { id: 2204, articleNumber: id, customFields: [{ key: 'material', type: 'LIST', value: ['Porcelain'] }] };
      return undefined;
    } };
    const options = { cachePath: file, records: [{ articleNumber: '10014062', shopifyProductId: '1', shopifyHandle: 'mugg' }], channels: [CHANNELS[0]], client, checkpointInterval: 2 };
    await extractKind('products', options);
    assert.equal(calls.length, 5);
    let cache = loadCache(file, 'products');
    assert.equal(cache.sheets.Products[0].Description.length, 70000);
    assert.equal(cache.sheets.Products[0]['Fetch Status'], 'PARTIAL');
    assert.equal(requiredComplete(cache, '10014062', '1'), true, 'optional unsupported groups must not block required scope');
    assert.deepEqual(JSON.parse(cache.sheets['Product Attributes'][0]['Attribute Value']), ['Porcelain']);
    assert.equal(rawOf(cache, '10014062', '1', 'basic').name, 'Mugg');
    await extractKind('products', options);
    assert.equal(calls.length, 5, 'resume must skip completed and unsupported groups');
    cache = loadCache(file, 'products');
    assert.equal(cache.sheets.Products.length, 1);
    assert.equal(cache.sheets.Progress.length, 5);
    const refreshClient = { async productGroup() { return null; } };
    await extractKind('products', { ...options, client: refreshClient, refresh: true });
    cache = loadCache(file, 'products');
    assert.equal(cache.sheets.Products[0].Description.length, 70000, 'failed refresh must preserve previous data');
    assert.equal(cache.sheets.Progress.find(row => row['Query Group'] === 'basic').Status, 'COMPLETE');
    const collectionFile = path.join(dir, 'collections.xlsx');
    const collectionClient = { async category(id) { return { id, name: 'Tallrikar', mainHeader: 'Tallrikar',
      primaryRoute: { path: '/tallrikar' }, images: [{ url: 'https://example.com/image.jpg' }],
      data: { id: 'content-149', items: [{ name: 'Intro', type: 'Text', properties: [{ name: 'Text', type: 'STRING', value: { __typename: 'StringValue', value: 'Hej' } }], children: [{ name: 'Child', type: 'Text', properties: [] }] }] } }; } };
    await extractKind('collections', { cachePath: collectionFile, records: [{ categoryId: '149', shopifyCollectionId: '2', shopifyHandle: 'tallrikar', localized: { 'sv-SE': { source: { content: '<p>Body</p>', pagetitle: 'SEO title', metadescription: 'SEO description', metakeywords: 'plates' }, permalinks: [{ url: '/source-url' }], structures: [{ path: 'Tableware/Plates' }] } } }],
      channels: [CHANNELS[0]], client: collectionClient, checkpointInterval: 1 });
    const collection = loadCache(collectionFile, 'collections');
    assert.equal(collection.sheets.Collections[0]['Body HTML'], '<p>Body</p>');
    assert.equal(collection.sheets.Collections[0]['SEO Title'], 'SEO title');
    assert.equal(collection.sheets.Collections[0]['SEO Description'], 'SEO description');
    assert.equal(collection.sheets.Collections[0]['SEO Keywords'], 'plates');
    assert.deepEqual(JSON.parse(collection.sheets.Collections[0]['Source Permalinks JSON']), [{ url: '/source-url' }]);
    assert.deepEqual(JSON.parse(collection.sheets.Collections[0]['Source Hierarchy JSON']), [{ path: 'Tableware/Plates' }]);
    assert.equal(collection.sheets.Collections[0]['Shopify Collection ID'], '2');
    assert.deepEqual(collection.sheets['CMS Components'].map(row => row['Component Path']), ['0', '0/0']);
    assert.equal(collection.sheets['CMS Properties'][0]['Property Value'], 'Hej');
    assert.equal(collection.sheets['Collection Images'].length, 1);
    const legacyFile = path.join(dir, 'legacy-collections.xlsx');
    const legacy = loadCache(legacyFile, 'collections');
    upsert(legacy, 'Collections', ['Category ID', 'Channel ID'], { 'Category ID': '149', 'Channel ID': '1', 'Content ID': 'content-149', 'Fetch Status': 'COMPLETE' });
    setProgress(legacy, '149', '1', 'category', { Status: 'COMPLETE', Attempts: 1 });
    checkpointCache(legacy);
    await extractKind('collections', { cachePath: legacyFile, records: [{ categoryId: '149', localized: { 'sv-SE': { source: { pagetitle: 'Backfilled SEO' }, permalinks: [], structures: [] } } }],
      channels: [CHANNELS[0]], client: { async category() { throw new Error('must not refetch'); } } });
    assert.equal(loadCache(legacyFile, 'collections').sheets.Collections[0]['SEO Title'], 'Backfilled SEO');
    const identityFile = path.join(dir, 'legacy-product-identity.xlsx');
    const identity = loadCache(identityFile, 'products');
    upsert(identity, 'Products', ['Article Number', 'Channel ID'], { 'Article Number': '10014062', 'Channel ID': '1', Name: 'Mugg' });
    setProgress(identity, '10014062', '1', 'basic', { Status: 'COMPLETE', Attempts: 1 });
    checkpointCache(identity);
    await extractKind('products', { ...options, cachePath: identityFile, limit: 1,
      client: { async productGroup() { return undefined; } } });
    assert.equal(loadCache(identityFile, 'products').sheets.Products[0]['Shopify Handle'], 'mugg');
    const journalFile = path.join(dir, 'replay.xlsx');
    const savedAt = '2026-10-20T12:00:00.000Z';
    appendJournal(journalFile, { kind: 'products', id: '10014062', channel: CHANNELS[0], group: 'basic', at: savedAt,
      attempts: 1, previousStatus: 'PENDING', availability: 'data', inventory: { shopifyProductId: '1', shopifyHandle: 'mugg' },
      result: { id: 2204, articleNumber: '10014062', name: 'Recovered' } });
    fs.appendFileSync(journalPath(journalFile), '{"sha256":"incomplete');
    const warnings = [];
    assert.equal(readJournal(journalFile, { onWarning: message => warnings.push(message) }).length, 1);
    assert.match(warnings[0], /incomplete final extraction journal line/);
    assert.throws(() => appendJournal(journalFile, { kind: 'products' }), /incomplete tail/);
    const tailOnlyFile = path.join(dir, 'tail-only.xlsx');
    fs.writeFileSync(journalPath(tailOnlyFile), '{"broken":');
    await extractKind('products', { ...options, cachePath: tailOnlyFile, client: { async productGroup() { return undefined; } }, limit: 1 });
    assert.equal(fs.existsSync(journalPath(tailOnlyFile)), false, 'tail-only journal should be cleared before next request');
    const replayCalls = [];
    await extractKind('products', { ...options, cachePath: journalFile, client: { async productGroup(id, channel, group) {
      replayCalls.push(group); return undefined;
    } }, checkpointInterval: 20 });
    assert.equal(replayCalls.includes('basic'), false, 'durable journal should prevent repeat basic request');
    assert.equal(loadCache(journalFile, 'products').sheets.Products[0].Name, 'Recovered');
    assert.equal(loadCache(journalFile, 'products').sheets.Products[0]['Fetched At'], savedAt);
    assert.equal(fs.existsSync(journalPath(journalFile)), false, 'journal should clear after workbook checkpoint');
    const missingFile = path.join(dir, 'missing-product.xlsx');
    let missingCalls = 0;
    const missing = await extractKind('products', { ...options, cachePath: missingFile, checkpointInterval: 1,
      client: { async productGroup() { missingCalls += 1; const error = new Error('ProductNotFound'); error.code = 'ProductNotFound'; throw error; } } });
    assert.equal(missing.failures, 0);
    assert.equal(missingCalls, 1, 'confirmed missing product needs only the basic request in a channel');
    assert.equal(loadCache(missingFile, 'products').sheets.Progress.every(row => row.Status === 'NOT_AVAILABLE'), true);
    console.log('Norce extraction cache/resume test passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
