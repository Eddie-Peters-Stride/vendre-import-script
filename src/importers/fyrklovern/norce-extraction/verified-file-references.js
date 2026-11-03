const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { parseDelimited } = require('../norce-source-ingestion');
const { imageFilename, semanticComponentKeys } = require('../build-collection-content-import');
const { verifiedDefinitions, cachedComponents } = require('./collection-cms-metafields');
const { progressOf } = require('./cache');

function fileRows(input) {
  if (Array.isArray(input)) return input;
  const file = path.resolve(input);
  if (!fs.existsSync(file)) throw new Error(`Files reconciliation source does not exist: ${file}`);
  if (path.extname(file).toLowerCase() === '.csv') {
    const [headers, ...records] = parseDelimited(fs.readFileSync(file, 'utf8'), ',');
    return records.map(record => Object.fromEntries(headers.map((header, index) => [header, record[index] || ''])));
  }
  const workbook = XLSX.readFile(file, { raw: false });
  const sheet = workbook.Sheets.Files;
  if (!sheet) throw new Error(`Files sheet missing from ${file}`);
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}
function column(row, names) {
  const found = Object.keys(row).find(key => names.includes(key.toLowerCase().trim()));
  return found ? String(row[found] ?? '').trim() : '';
}
function verifiedFileLookup(input) {
  const byName = new Map();
  for (const row of fileRows(input)) {
    const name = column(row, ['file name', 'filename']);
    if (!name) continue;
    const status = column(row, ['status']);
    const importResult = column(row, ['import result', 'result']);
    const good = value => /^(ready|success|succeeded|successful|complete|completed|imported|ok)$/i.test(value);
    const bad = value => /fail|error|reject|cancel|pending|processing/i.test(value);
    const verified = !bad(status) && !bad(importResult) && (good(status) || good(importResult));
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ name, status, importResult, verified });
  }
  return byName;
}
function buildVerifiedCollectionFileReferences(cache, filesInput, { channelId = '1', definitions = verifiedDefinitions() } = {}) {
  if (cache.kind !== 'collections') throw new Error('Collection cache required');
  const files = verifiedFileLookup(filesInput);
  const rows = [], verifiedCandidates = [], review = [];
  const aliases = new Map();
  for (const collection of cache.sheets.Collections.filter(row => String(row['Channel ID']) === String(channelId))) {
    const id = String(collection['Shopify Collection ID'] || '');
    if (!id) continue;
    if (!aliases.has(id)) aliases.set(id, new Set());
    aliases.get(id).add(String(collection['Category ID']));
  }
  for (const collection of cache.sheets.Collections.filter(row => String(row['Channel ID']) === String(channelId))) {
    const categoryId = String(collection['Category ID']), collectionId = String(collection['Shopify Collection ID'] || '');
    if (progressOf(cache, categoryId, channelId, 'category')?.Status !== 'COMPLETE' || !collectionId) {
      review.push({ categoryId, channelId, reason: 'collection extraction or verified Shopify ID missing' });
      continue;
    }
    if (aliases.get(collectionId)?.size > 1) {
      review.push({ categoryId, channelId, shopifyCollectionId: collectionId, categoryIds: [...aliases.get(collectionId)],
        reason: 'multiple Norce categories share one Shopify collection ID; approved alias handling required' });
      continue;
    }
    const components = semanticComponentKeys(cachedComponents(cache, categoryId, channelId));
    const byPath = new Map(components.map(component => [component.componentPath, component]));
    const grouped = new Map();
    const seenCandidates = new Set();
    for (const image of cache.sheets['Collection Images'].filter(row =>
      String(row['Category ID']) === categoryId && String(row['Channel ID']) === String(channelId))) {
      const url = String(image['Image URL'] || '').trim();
      const componentPath = String(image['Component Path'] || '');
      if (!/^https?:\/\//i.test(url)) { review.push({ categoryId, channelId, componentPath, url, reason: 'source image URL missing or invalid' }); continue; }
      const component = byPath.get(componentPath);
      if (!component) { review.push({ categoryId, channelId, componentPath, url, reason: 'image has no mapped CMS component' }); continue; }
      const parentPath = componentPath.split('/').slice(0, -1).join('/');
      const section = byPath.get(parentPath) || component;
      const key = `${section.metafieldKey}_images`;
      const sourceKey = `${key}\u0000${url}`;
      if (seenCandidates.has(sourceKey)) continue;
      seenCandidates.add(sourceKey);
      const definition = definitions.get(key);
      if (!definition || definition.type !== 'list.file_reference') {
        review.push({ categoryId, channelId, componentPath, url, candidateKey: key, reason: 'image metafield definition is not verified' });
        continue;
      }
      const filename = imageFilename(url);
      const fileMatches = files.get(filename) || [];
      const verified = fileMatches.length === 1 && fileMatches[0].verified;
      const groupKey = `${collectionId}\u0000${key}`;
      if (!grouped.has(groupKey)) grouped.set(groupKey, { definition, filenames: [], blocked: false, categoryId, componentPaths: [] });
      const group = grouped.get(groupKey);
      if (!group.filenames.includes(filename)) group.filenames.push(filename);
      group.componentPaths.push(componentPath);
      if (verified) verifiedCandidates.push({ categoryId, channelId, componentPath, url, filename, key });
      else {
        group.blocked = true;
        review.push({ categoryId, channelId, componentPath, url, filename, candidateKey: key,
          reason: fileMatches.length > 1 ? 'ambiguous File Name in Files result/export' : fileMatches.length === 0 ? 'File Name absent from Files result/export' : 'File Name is not successful or Ready',
          matches: fileMatches });
      }
    }
    for (const group of grouped.values()) {
      if (group.blocked) continue;
      rows.push({ ID: collectionId, Command: 'UPDATE', [group.definition.column]: JSON.stringify(group.filenames) });
    }
  }
  return { rows, verifiedCandidates, review };
}

module.exports = { fileRows, verifiedFileLookup, buildVerifiedCollectionFileReferences };
