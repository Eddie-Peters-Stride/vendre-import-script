#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { CHANNELS, selectedChannels, channelsFromFile } = require('./channels');
const { NorceExtractionClient } = require('./client');
const { loadCache } = require('./cache');
const { productInventory, collectionInventory } = require('./inventory');
const { extractKind } = require('./extract');
const { findDefaultCategoryWorkbook } = require('../fetch-norce-categories');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (const arg of rest) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    options[match[1]] = match[2] === undefined ? true : match[2];
  }
  return { command, options };
}
function status(cache) {
  const counts = {};
  for (const row of cache.sheets.Progress) {
    const key = `${row['Channel ID'] || '?'} ${row.Status || 'PENDING'}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return { path: cache.path, progressRows: cache.sheets.Progress.length, counts };
}
async function main(argv = process.argv.slice(2), env = process.env) {
  dotenv.config({ path: env.ENV_FILE || '.env' });
  const { command, options } = parseArgs(argv);
  if (!['extract-products', 'extract-collections', 'extract-all', 'resume', 'status', 'refresh-channels'].includes(command)) throw new Error('Usage: cli.js <extract-products|extract-collections|extract-all|resume|status|refresh-channels> [--channel=4] [--article-number=10014062] [--category-id=149] [--limit=10] [--refresh] [--dry-run] [--collections-first] [--categories=path] [--products=path] [--collections=path] [--channels-file=path] [--cache-dir=path]');
  const cacheDir = path.resolve(options['cache-dir'] || env.NORCE_CACHE_DIR || 'cache');
  const cachePath = kind => path.join(cacheDir, `norce-${kind}-cache.xlsx`);
  if (command === 'refresh-channels') {
    const client = new NorceExtractionClient();
    const queryFields = await client.type('Query');
    const field = queryFields.find(item => item.name === 'channels');
    if (!field) throw new Error('StoreAPI Query schema has no channels field.');
    if (field.args?.some(arg => arg.type.kind === 'NON_NULL')) throw new Error('StoreAPI channels query requires arguments; inspect schema before refreshing.');
    const channelType = client.namedType(field.type);
    const fields = (await client.type(channelType)).filter(item => {
      const type = item.type.kind === 'NON_NULL' ? item.type.ofType : item.type;
      return ['id', 'name', 'code', 'culture', 'country', 'currency'].includes(item.name) && ['SCALAR', 'ENUM'].includes(type?.kind);
    });
    if (!fields.length) throw new Error('StoreAPI channels type exposes no recognized scalar fields.');
    const result = await client.query(`query GetChannels { channels { ${fields.map(item => item.name).join(' ')} } }`);
    const raw = result.channels;
    const suggestedChannels = Array.isArray(raw) ? raw.map(row => ({ code: row.code || row.name || '', id: String(row.id || ''), culture: row.culture || '', country: row.country || '', currency: row.currency || '' })) : [];
    fs.mkdirSync(cacheDir, { recursive: true });
    const destination = path.join(cacheDir, 'norce-channels-discovery.json');
    fs.writeFileSync(destination, JSON.stringify({ fetchedAt: new Date().toISOString(), raw, suggestedChannels }, null, 2));
    console.log(`Saved StoreAPI channel discovery to ${destination}; review all contexts before using --channels-file.`);
    return;
  }
  if (command === 'status') {
    for (const kind of ['products', 'collections']) {
      if (fs.existsSync(cachePath(kind))) console.log(JSON.stringify({ kind, ...status(loadCache(cachePath(kind), kind)) }, null, 2));
      else console.log(`${kind}: no cache at ${cachePath(kind)}`);
    }
    return;
  }
  const channels = selectedChannels(options.channel, channelsFromFile(options['channels-file'] || env.NORCE_CHANNELS_FILE));
  const checkpointInterval = Number(options['checkpoint-interval'] || env.NORCE_CHECKPOINT_INTERVAL || 20);
  if (!Number.isInteger(checkpointInterval) || checkpointInterval < 1) throw new Error('Checkpoint interval must be a positive integer');
  const limit = options.limit === undefined ? Infinity : Number(options.limit);
  if (!(limit > 0)) throw new Error('Limit must be positive');
  let interrupted = false;
  const onSignal = () => { interrupted = true; console.error('Interruption requested; finishing current request and saving checkpoint.'); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const kinds = command === 'extract-products' ? ['products'] : command === 'extract-collections' ? ['collections']
      : options['collections-first'] ? ['collections', 'products'] : ['products', 'collections'];
    for (const kind of kinds) {
      let records, inventoryReport;
      if (kind === 'products') {
        const inventory = productInventory(options.products || env.SHOPIFY_PRODUCTS_EXPORT_PATH);
        records = inventory.records;
        inventoryReport = { kind, sourceCount: records.length, currentHandleCount: inventory.currentHandleCount || null,
          idBackedRecordCount: records.filter(item => item.shopifyProductId).length,
          handleOnlyRecordCount: records.filter(item => !item.shopifyProductId).length,
          conflicts: inventory.conflicts, handleConflicts: inventory.handleConflicts || [], mismatches: inventory.mismatches };
        if (options['article-number']) {
          records = records.filter(item => item.articleNumber === String(options['article-number']));
          if (!records.length) records = [{ articleNumber: String(options['article-number']), shopifyProductId: '', shopifyHandle: '', source: 'targeted_unmapped' }];
        }
        if (inventory.conflicts.length || inventory.handleConflicts?.length || inventory.mismatches.length) console.error(`Product inventory excluded ${inventory.conflicts.length} ambiguous articles and ${inventory.handleConflicts?.length || 0} ambiguous handles; ${inventory.mismatches.length} external ID/SKU mismatches were retained for review.`);
      } else {
        const categoryFile = options.categories || env.NORCE_CATEGORY_EXPORT_PATH || findDefaultCategoryWorkbook();
        if (!categoryFile) throw new Error('Category export missing; set --categories or NORCE_CATEGORY_EXPORT_PATH');
        const inventory = collectionInventory(categoryFile, options.collections || env.SHOPIFY_COLLECTIONS_EXPORT_PATH);
        records = inventory.records;
        inventoryReport = { kind, sourceCount: records.length, shopifyCount: inventory.shopifyCount,
          mappingConflicts: inventory.mappingConflicts, categoryDiagnostics: inventory.categoryDiagnostics };
        if (options['category-id']) records = records.filter(item => item.categoryId === String(options['category-id']));
      }
      if (!records.length) throw new Error(`No ${kind} found in source inventory.`);
      if (!options['dry-run']) {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, `norce-${kind}-inventory-coverage.json`), `${JSON.stringify(inventoryReport, null, 2)}\n`);
      }
      const result = await extractKind(kind, { records, channels, cachePath: cachePath(kind), checkpointInterval, limit,
        refresh: Boolean(options.refresh || options.force), dryRun: Boolean(options['dry-run']), stopRequested: () => interrupted,
        onCheckpoint: count => console.log(`${kind}: saved ${count} work items`) });
      console.log(`${kind}: processed=${result.processed}, failed=${result.failures}, cache=${result.cache.path}`);
      if (result.failures) process.exitCode = 1;
      if (interrupted) { process.exitCode = 130; break; }
    }
  } finally { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, parseArgs, status };
