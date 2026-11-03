const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const HEADERS = Object.freeze({
  products: {
    Products: ['Norce Product ID', 'Article Number', 'Channel ID', 'Culture', 'Country', 'Currency', 'Name', 'Sub Name', 'Main Header', 'Short Description', 'Description', 'Barcode', 'Published Date', 'Product URL', 'Shopify Product ID', 'Shopify Handle', 'Fetch Status', 'Fetched At', 'Last Error'],
    'Product Attributes': ['Article Number', 'Norce Product ID', 'Channel ID', 'Culture', 'Attribute Key', 'Attribute Title', 'Attribute Type', 'Attribute Value'],
    'Product Variants': ['Article Number', 'Norce Product ID', 'Channel ID', 'Culture', 'Variant ID', 'Variant Article Number', 'SKU', 'Barcode', 'Option Values', 'Raw Value'],
    'Product Images': ['Article Number', 'Norce Product ID', 'Channel ID', 'Culture', 'Image URL', 'Alt Text', 'Position', 'Relationship', 'Raw Value'],
    Progress: ['Article Number', 'Channel ID', 'Query Group', 'Status', 'Attempts', 'Last Attempt', 'Last Success', 'Error'],
    Errors: ['Article Number', 'Channel ID', 'Query Group', 'At', 'Error'],
    'Raw Responses': ['Source ID', 'Channel ID', 'Query Group', 'Response JSON'],
    'Long Values': ['Value ID', 'Part', 'Text'],
  },
  collections: {
    Collections: ['Category ID', 'Content ID', 'Parent Category ID', 'Channel ID', 'Culture', 'Name', 'Main Header', 'Original URL', 'Body HTML', 'SEO Title', 'SEO Description', 'SEO Keywords', 'Source Permalinks JSON', 'Source Hierarchy JSON', 'Localized Source JSON', 'Shopify Collection ID', 'Shopify Handle', 'Fetch Status', 'Fetched At', 'Last Error'],
    'CMS Components': ['Category ID', 'Content ID', 'Channel ID', 'Culture', 'Component Path', 'Component Position', 'Component Name', 'Component Type'],
    'CMS Properties': ['Category ID', 'Content ID', 'Channel ID', 'Culture', 'Component Path', 'Property Name', 'Property Type', 'Property Value'],
    'Collection Images': ['Category ID', 'Content ID', 'Channel ID', 'Culture', 'Image URL', 'Alt Text', 'Placement', 'Position', 'Component Path', 'Raw Value'],
    Progress: ['Category ID', 'Channel ID', 'Query Group', 'Status', 'Attempts', 'Last Attempt', 'Last Success', 'Error'],
    Errors: ['Category ID', 'Channel ID', 'Query Group', 'At', 'Error'],
    'Raw Responses': ['Source ID', 'Channel ID', 'Query Group', 'Response JSON'],
    'Long Values': ['Value ID', 'Part', 'Text'],
  },
});
const GROUPS = Object.freeze({ products: ['basic', 'attributes', 'images', 'variants', 'relationships'], collections: ['category'] });
const CELL_LIMIT = 32000;

function loadCache(filePath, kind) {
  if (!HEADERS[kind]) throw new Error(`Unknown cache kind: ${kind}`);
  const cache = { path: path.resolve(filePath), kind, sheets: Object.fromEntries(Object.keys(HEADERS[kind]).map(name => [name, []])) };
  if (!fs.existsSync(cache.path)) return cache;
  const workbook = XLSX.readFile(cache.path, { raw: false });
  for (const name of Object.keys(cache.sheets)) {
    const sheet = workbook.Sheets[name];
    if (!sheet) throw new Error(`Cache ${cache.path} is missing sheet ${name}`);
    cache.sheets[name] = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  }
  for (const [name, records] of Object.entries(cache.sheets)) {
    if (name === 'Long Values') continue;
    for (const record of records) for (const [field, value] of Object.entries(record)) record[field] = resolveLong(cache, value);
  }
  return cache;
}

function key(row, fields) { return fields.map(field => String(row[field] ?? '')).join('\u0000'); }
function indexFor(cache, sheet, fields) {
  cache._indexes ||= new Map();
  const indexKey = `${sheet}:${fields.join('|')}`;
  if (!cache._indexes.has(indexKey)) {
    const index = new Map();
    cache.sheets[sheet].forEach((row, position) => { if (row) index.set(key(row, fields), position); });
    cache._indexes.set(indexKey, index);
  }
  return cache._indexes.get(indexKey);
}
function upsert(cache, sheet, fields, row) {
  const rows = cache.sheets[sheet];
  const match = key(row, fields);
  const index = indexFor(cache, sheet, fields);
  const position = index.get(match);
  if (position === undefined) { index.set(match, rows.length); rows.push(row); }
  else rows[position] = { ...rows[position], ...row };
}
function replaceGroupRows(cache, sheet, idField, id, channelId, rows) {
  const target = cache.sheets[sheet];
  cache._groupIndexes ||= new Map();
  if (!cache._groupIndexes.has(sheet)) {
    const index = new Map();
    target.forEach((row, position) => {
      if (!row) return;
      const groupKey = key(row, [idField, 'Channel ID']);
      if (!index.has(groupKey)) index.set(groupKey, []);
      index.get(groupKey).push(position);
    });
    cache._groupIndexes.set(sheet, index);
  }
  const index = cache._groupIndexes.get(sheet);
  const groupKey = [String(id), String(channelId)].join('\u0000');
  for (const position of index.get(groupKey) || []) target[position] = null;
  const positions = [];
  for (const row of rows) { positions.push(target.length); target.push(row); }
  index.set(groupKey, positions);
}
function progressOf(cache, id, channelId, group) {
  const idField = cache.kind === 'products' ? 'Article Number' : 'Category ID';
  const position = indexFor(cache, 'Progress', [idField, 'Channel ID', 'Query Group']).get([String(id), String(channelId), group].join('\u0000'));
  return position === undefined ? undefined : cache.sheets.Progress[position];
}
function setProgress(cache, id, channelId, group, update) {
  const idField = cache.kind === 'products' ? 'Article Number' : 'Category ID';
  upsert(cache, 'Progress', [idField, 'Channel ID', 'Query Group'], { [idField]: String(id), 'Channel ID': String(channelId), 'Query Group': group, ...update });
}
function addError(cache, id, channelId, group, error) {
  const idField = cache.kind === 'products' ? 'Article Number' : 'Category ID';
  cache.sheets.Errors.push({ [idField]: String(id), 'Channel ID': String(channelId), 'Query Group': group, At: new Date().toISOString(), Error: String(error) });
}
function setRaw(cache, id, channelId, group, value) {
  upsert(cache, 'Raw Responses', ['Source ID', 'Channel ID', 'Query Group'], { 'Source ID': String(id), 'Channel ID': String(channelId), 'Query Group': group, 'Response JSON': JSON.stringify(value) });
}
function rawOf(cache, id, channelId, group) {
  const position = indexFor(cache, 'Raw Responses', ['Source ID', 'Channel ID', 'Query Group']).get([String(id), String(channelId), group].join('\u0000'));
  const row = position === undefined ? null : cache.sheets['Raw Responses'][position];
  if (!row) return null;
  return JSON.parse(resolveLong(cache, row['Response JSON']));
}
function resolveLong(cache, value) {
  if (!String(value).startsWith('@long:')) return value;
  const valueId = String(value).slice(6);
  return cache.sheets['Long Values'].filter(row => row['Value ID'] === valueId).sort((a, b) => Number(a.Part) - Number(b.Part)).map(row => row.Text).join('');
}
function buildWorkbook(cache) {
  const workbook = XLSX.utils.book_new();
  const longRows = [];
  let longId = 0;
  for (const [name, headers] of Object.entries(HEADERS[cache.kind])) {
    const rows = name === 'Long Values' ? longRows : cache.sheets[name].filter(Boolean).map(row => {
      const safe = {};
      for (const header of headers) {
        const value = row[header] == null ? '' : row[header];
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (serialized.length <= CELL_LIMIT) safe[header] = serialized;
        else {
          const id = `v${++longId}`;
          safe[header] = `@long:${id}`;
          for (let offset = 0, part = 0; offset < serialized.length; offset += CELL_LIMIT, part += 1) longRows.push({ 'Value ID': id, Part: part, Text: serialized.slice(offset, offset + CELL_LIMIT) });
        }
      }
      return safe;
    });
    const sheet = XLSX.utils.json_to_sheet(rows, { header: headers, skipHeader: false });
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  return workbook;
}
function checkpointCache(cache) {
  fs.mkdirSync(path.dirname(cache.path), { recursive: true });
  const temp = `${cache.path}.${process.pid}.tmp.xlsx`;
  const backup = `${cache.path}.previous.xlsx`;
  try {
    XLSX.writeFile(buildWorkbook(cache), temp);
    const reopened = XLSX.readFile(temp, { raw: false });
    if (Object.keys(HEADERS[cache.kind]).some(name => !reopened.Sheets[name])) throw new Error('Checkpoint validation failed: missing sheet');
    if (fs.existsSync(cache.path)) fs.copyFileSync(cache.path, backup);
    fs.renameSync(temp, cache.path);
  } catch (error) {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    throw error;
  }
}

module.exports = { HEADERS, GROUPS, loadCache, checkpointCache, upsert, replaceGroupRows, progressOf, setProgress, addError, setRaw, rawOf, resolveLong };
