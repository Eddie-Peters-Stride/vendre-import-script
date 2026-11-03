const { GROUPS, loadCache, checkpointCache, upsert, replaceGroupRows, progressOf, setProgress, addError, setRaw, rawOf } = require('./cache');
const { CHANNELS } = require('./channels');
const { NorceExtractionClient } = require('./client');
const { productInventory, collectionInventory } = require('./inventory');
const { appendJournal, readJournal, clearJournal } = require('./journal');
const { acquireCacheLock } = require('./lock');
const { clean } = require('../norce-source-ingestion');

const iso = () => new Date().toISOString();
const scalar = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value];
const REQUIRED_GROUPS = Object.freeze({ products: ['basic', 'attributes'], collections: ['category'] });
function requiredComplete(cache, id, channelId) {
  return REQUIRED_GROUPS[cache.kind].every(group => progressOf(cache, id, channelId, group)?.Status === 'COMPLETE');
}
function deriveStatus(cache, id, channelId) {
  const groups = GROUPS[cache.kind].map(group => progressOf(cache, id, channelId, group)?.Status || 'PENDING');
  if (groups[0] === 'NOT_AVAILABLE') return 'NOT_AVAILABLE';
  if (groups.every(status => status === 'COMPLETE')) return 'COMPLETE';
  if (groups.some(status => status === 'COMPLETE')) return 'PARTIAL';
  if (groups.some(status => status === 'FAILED' || status === 'RETRY_PENDING')) return 'RETRY_PENDING';
  return 'PENDING';
}
function productRows(cache, id, channel, group, product, inventory, fetchedAt = iso()) {
  const common = { 'Article Number': id, 'Norce Product ID': scalar(product.id), 'Channel ID': channel.id, Culture: channel.culture };
  const base = { ...common, Country: channel.country, Currency: channel.currency,
    'Shopify Product ID': inventory.shopifyProductId || '', 'Shopify Handle': inventory.shopifyHandle || '' };
  if (group === 'basic') upsert(cache, 'Products', ['Article Number', 'Channel ID'], {
    ...base, Name: scalar(product.name), 'Sub Name': scalar(product.subName), 'Main Header': scalar(product.mainHeader),
    'Short Description': scalar(product.shortDescription), Description: scalar(product.description), Barcode: scalar(product.barcode),
    'Published Date': scalar(product.publishedDate), 'Product URL': scalar(product.url), 'Fetched At': fetchedAt,
  });
  if (group === 'attributes') replaceGroupRows(cache, 'Product Attributes', 'Article Number', id, channel.id,
    asArray(product.customFields).map(attribute => ({ ...common, 'Attribute Key': scalar(attribute.key),
      'Attribute Title': scalar(attribute.title), 'Attribute Type': scalar(attribute.type || attribute.__typename),
      'Attribute Value': scalar(attribute.value === undefined ? attribute.items : attribute.value) })));
  if (group === 'images') {
    const images = [product.primaryImage, ...asArray(product.images)].filter(Boolean);
    replaceGroupRows(cache, 'Product Images', 'Article Number', id, channel.id, images.map((image, index) => ({ ...common,
      'Image URL': scalar(image.url || image.src), 'Alt Text': scalar(image.altText || image.alt),
      Position: scalar(image.position ?? index + 1), Relationship: image === product.primaryImage ? 'primary' : 'product', 'Raw Value': JSON.stringify(image) })));
  }
  if (group === 'variants') replaceGroupRows(cache, 'Product Variants', 'Article Number', id, channel.id,
    asArray(product.variants).map(variant => ({ ...common, 'Variant ID': scalar(variant.id),
      'Variant Article Number': scalar(variant.articleNumber), SKU: scalar(variant.sku || variant.articleNumber),
      Barcode: scalar(variant.barcode), 'Option Values': scalar(variant.options || variant.optionValues), 'Raw Value': JSON.stringify(variant) })));
}
function componentRows(categoryId, contentId, channel, items) {
  const components = [], properties = [], images = [];
  const visit = (items, prefix = '') => {
    for (const [index, item] of (items || []).entries()) {
      const componentPath = prefix ? `${prefix}/${index}` : String(index);
      const common = { 'Category ID': categoryId, 'Content ID': contentId, 'Channel ID': channel.id, Culture: channel.culture, 'Component Path': componentPath };
      components.push({ ...common, 'Component Position': index, 'Component Name': scalar(item.name), 'Component Type': scalar(item.type) });
      const altProperty = (item.properties || []).find(property => /alt/i.test(String(property.name || '')));
      const altText = altProperty?.value?.value ?? altProperty?.value ?? '';
      for (const property of item.properties || []) {
        const value = property.value?.value ?? property.value;
        properties.push({ ...common, 'Property Name': scalar(property.name), 'Property Type': scalar(property.valueType || property.type), 'Property Value': scalar(value) });
        if (/image|url|src|asset/i.test(String(property.name)) && /^https?:\/\//i.test(String(value || ''))) images.push({ ...common,
          'Image URL': String(value), 'Alt Text': scalar(altText), Placement: scalar(property.name), Position: index, 'Raw Value': JSON.stringify(property) });
      }
      visit(item.children, componentPath);
    }
  };
  visit(items);
  return { components, properties, images };
}
function collectionRows(cache, id, channel, category, inventory, fetchedAt = iso()) {
  const localizedRecord = inventory.localized?.[channel.culture] || {};
  const localized = localizedRecord.source || {};
  const contentId = scalar(category.data?.id);
  const common = { 'Category ID': id, 'Content ID': contentId, 'Channel ID': channel.id, Culture: channel.culture };
  upsert(cache, 'Collections', ['Category ID', 'Channel ID'], { ...common, 'Parent Category ID': scalar(category.parentId), Name: scalar(category.name),
    'Main Header': scalar(category.mainHeader), 'Original URL': scalar(category.primaryRoute?.path),
    'Body HTML': scalar(localized.content ?? localized.Content ?? localized.text ?? localized.Text),
    'SEO Title': scalar(localized.pagetitle ?? localized.PageTitle),
    'SEO Description': scalar(localized.metadescription ?? localized.MetaDescription),
    'SEO Keywords': scalar(localized.metakeywords ?? localized.MetaKeywords),
    'Source Permalinks JSON': JSON.stringify(localizedRecord.permalinks || []),
    'Source Hierarchy JSON': JSON.stringify(localizedRecord.structures || []),
    'Localized Source JSON': JSON.stringify(localized),
    'Shopify Collection ID': inventory.shopifyCollectionId || '', 'Shopify Handle': inventory.shopifyHandle || '', 'Fetched At': fetchedAt });
  const cms = componentRows(id, contentId, channel, category.data?.items);
  replaceGroupRows(cache, 'CMS Components', 'Category ID', id, channel.id, cms.components);
  replaceGroupRows(cache, 'CMS Properties', 'Category ID', id, channel.id, cms.properties);
  const directImages = asArray(category.images).map((image, index) => ({ ...common, 'Image URL': scalar(image.url),
    'Alt Text': scalar(image.altText || image.alt), Placement: 'category', Position: index, 'Component Path': '', 'Raw Value': JSON.stringify(image) }));
  replaceGroupRows(cache, 'Collection Images', 'Category ID', id, channel.id, [...directImages, ...cms.images]);
}
function backfillCollectionSource(cache, source, channels) {
  const sourceById = new Map(source.map(item => [String(item.categoryId), item]));
  const channelById = new Map(channels.map(channel => [String(channel.id), channel]));
  let changed = false;
  for (const row of cache.sheets.Collections) {
    const inventory = sourceById.get(String(row['Category ID']));
    const channel = channelById.get(String(row['Channel ID']));
    if (!inventory || !channel) continue;
    const localizedRecord = inventory.localized?.[channel.culture] || {};
    const localized = localizedRecord.source || {};
    const rawCategory = rawOf(cache, row['Category ID'], row['Channel ID'], 'category');
    const fields = {
      'Parent Category ID': scalar(rawCategory?.parentId),
      'SEO Title': scalar(localized.pagetitle ?? localized.PageTitle),
      'SEO Description': scalar(localized.metadescription ?? localized.MetaDescription),
      'SEO Keywords': scalar(localized.metakeywords ?? localized.MetaKeywords),
      'Source Permalinks JSON': JSON.stringify(localizedRecord.permalinks || []),
      'Source Hierarchy JSON': JSON.stringify(localizedRecord.structures || []),
      'Localized Source JSON': JSON.stringify(localized),
    };
    for (const [field, value] of Object.entries(fields)) if (!row[field] && value) { row[field] = value; changed = true; }
  }
  return changed;
}
function backfillProductIdentity(cache, source) {
  const byArticle = new Map(source.map(item => [String(item.articleNumber), item]));
  let changed = false;
  for (const row of cache.sheets.Products) {
    const item = byArticle.get(String(row['Article Number']));
    if (!item) continue;
    if (!row['Shopify Product ID'] && item.shopifyProductId) {
      row['Shopify Product ID'] = item.shopifyProductId;
      changed = true;
    }
    if (!row['Shopify Handle'] && item.shopifyHandle) {
      row['Shopify Handle'] = item.shopifyHandle;
      changed = true;
    }
  }
  return changed;
}
function applySuccessful(cache, kind, event) {
  const { id, channel, group, result, availability, inventory, at, attempts, previousStatus } = event;
  const idField = kind === 'products' ? 'Article Number' : 'Category ID';
  const mainSheet = kind === 'products' ? 'Products' : 'Collections';
  if (availability === 'data') {
    setRaw(cache, id, channel.id, group, result);
    if (kind === 'products') productRows(cache, id, channel, group, result, inventory, at);
    else collectionRows(cache, id, channel, result, inventory, at);
    setProgress(cache, id, channel.id, group, { Status: 'COMPLETE', Attempts: attempts, 'Last Attempt': at, 'Last Success': at, Error: '' });
  } else if (previousStatus === 'COMPLETE') {
    setProgress(cache, id, channel.id, group, { Status: 'COMPLETE', Attempts: attempts, 'Last Attempt': at,
      Error: availability === 'unsupported' ? 'Refresh returned unsupported group; prior result preserved' : 'Refresh returned no record; prior result preserved' });
  } else {
    setProgress(cache, id, channel.id, group, { Status: 'NOT_AVAILABLE', Attempts: attempts, 'Last Attempt': at,
      'Last Success': at, Error: availability === 'unsupported' ? 'Unsupported by StoreAPI schema' : 'Unavailable in channel' });
  }
  const status = deriveStatus(cache, id, channel.id);
  upsert(cache, mainSheet, [idField, 'Channel ID'], { [idField]: String(id), 'Channel ID': channel.id, Culture: channel.culture,
    'Fetch Status': status, 'Last Error': '' });
}
async function extractKind(kind, { cachePath, records, channels = CHANNELS, client, checkpointInterval = 20,
  refresh = false, limit = Infinity, dryRun = false, stopRequested = () => false, onCheckpoint = () => {} } = {}) {
  if (!['products', 'collections'].includes(kind)) throw new Error(`Unknown extraction kind ${kind}`);
  const resolvedCachePath = cachePath || `cache/norce-${kind}-cache.xlsx`;
  const releaseLock = dryRun ? () => {} : acquireCacheLock(resolvedCachePath);
  try {
  const cache = loadCache(resolvedCachePath, kind);
  const source = records || (kind === 'products' ? productInventory().records : (() => { throw new Error('Category workbook is required'); })());
  const idField = kind === 'products' ? 'Article Number' : 'Category ID';
  const mainSheet = kind === 'products' ? 'Products' : 'Collections';
  if (!dryRun) {
    const journal = readJournal(cache.path);
    if (journal.length || journal.truncatedTail) {
      for (const event of journal) {
        if (event.kind !== kind) throw new Error(`Extraction journal kind mismatch: ${event.kind}`);
        applySuccessful(cache, kind, event);
      }
      checkpointCache(cache);
      clearJournal(cache.path);
    }
    let seeded = false;
    for (const item of source) for (const channel of channels) for (const group of GROUPS[kind]) {
      const id = kind === 'products' ? item.articleNumber : item.categoryId;
      if (progressOf(cache, id, channel.id, group)) continue;
      setProgress(cache, id, channel.id, group, { Status: 'PENDING', Attempts: 0, 'Last Attempt': '', 'Last Success': '', Error: '' });
      seeded = true;
    }
    if (kind === 'products') seeded = backfillProductIdentity(cache, source) || seeded;
    if (kind === 'collections') seeded = backfillCollectionSource(cache, source, channels) || seeded;
    if (seeded) checkpointCache(cache);
  }
  const api = dryRun ? null : (client || new NorceExtractionClient());
  let done = 0, failures = 0, dirty = false;
  for (const item of source) {
    const id = kind === 'products' ? item.articleNumber : item.categoryId;
    for (const channel of channels) {
      for (const group of GROUPS[kind]) {
        if (stopRequested() || done >= limit) break;
        const previous = progressOf(cache, id, channel.id, group);
        if (!refresh && ['COMPLETE', 'NOT_AVAILABLE'].includes(previous?.Status)) continue;
        if (dryRun) { done += 1; continue; }
        const now = iso();
        setProgress(cache, id, channel.id, group, { Status: 'IN_PROGRESS', Attempts: Number(previous?.Attempts || 0) + 1, 'Last Attempt': now,
          'Last Success': previous?.['Last Success'] || '', Error: '' });
        let pendingJournal = false;
        try {
          const productUnavailable = kind === 'products' && group !== 'basic'
            && progressOf(cache, id, channel.id, 'basic')?.Status === 'NOT_AVAILABLE';
          const result = productUnavailable ? null
            : kind === 'products' ? await api.productGroup(id, channel, group) : await api.category(id, channel);
          if (result && String(result.id) !== String(id) && kind === 'collections') throw new Error(`Category ID mismatch: requested ${id}, returned ${result.id}`);
          if (result && kind === 'products' && result.articleNumber && String(result.articleNumber) !== String(id)) throw new Error(`Article number mismatch: requested ${id}, returned ${result.articleNumber}`);
          const event = { kind, id, channel, group, at: now, attempts: Number(previous?.Attempts || 0) + 1,
            previousStatus: previous?.Status || '', availability: result === undefined ? 'unsupported' : result === null ? 'unavailable' : 'data',
            inventory: item, ...(result === undefined ? {} : { result }) };
          appendJournal(cache.path, event);
          pendingJournal = true;
          applySuccessful(cache, kind, event);
          pendingJournal = false;
        } catch (error) {
          if (pendingJournal) throw error;
          if ((kind === 'products' && error?.code === 'ProductNotFound')
            || (kind === 'collections' && error?.code === 'CategoryNotFound')) {
            const event = { kind, id, channel, group, at: now, attempts: Number(previous?.Attempts || 0) + 1,
              previousStatus: previous?.Status || '', availability: 'unavailable', inventory: item, result: null };
            appendJournal(cache.path, event);
            applySuccessful(cache, kind, event);
          } else {
            failures += 1;
            const detail = error?.message || String(error) || 'Unknown extraction error';
            addError(cache, id, channel.id, group, detail);
            setProgress(cache, id, channel.id, group, { Status: previous?.Status === 'COMPLETE' ? 'COMPLETE' : 'RETRY_PENDING', Error: detail });
          }
        }
        const status = deriveStatus(cache, id, channel.id);
        upsert(cache, mainSheet, [idField, 'Channel ID'], { [idField]: String(id), 'Channel ID': channel.id, Culture: channel.culture,
          'Fetch Status': status, 'Last Error': status === 'RETRY_PENDING' ? progressOf(cache, id, channel.id, group)?.Error || '' : '' });
        done += 1; dirty = true;
        if (done % checkpointInterval === 0) { checkpointCache(cache); clearJournal(cache.path); dirty = false; onCheckpoint(done, cache); }
      }
      if (stopRequested() || done >= limit) break;
    }
    if (stopRequested() || done >= limit) break;
  }
  if (dirty) { checkpointCache(cache); clearJournal(cache.path); onCheckpoint(done, cache); }
  return { cache, processed: done, failures };
  } finally { releaseLock(); }
}

module.exports = { extractKind, deriveStatus, requiredComplete, REQUIRED_GROUPS, componentRows };
