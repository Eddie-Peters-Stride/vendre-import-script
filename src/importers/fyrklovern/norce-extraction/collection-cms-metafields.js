const XLSX = require('xlsx');
const { semanticComponentKeys, sectionTextFields } = require('../build-collection-content-import');
const { progressOf } = require('./cache');
const { COLLECTION_EXPORT } = require('./inventory');

function verifiedDefinitions(file = COLLECTION_EXPORT) {
  const workbook = XLSX.readFile(file, { sheetRows: 1 });
  const sheet = workbook.Sheets.Collections;
  if (!sheet) throw new Error(`Collections sheet missing from ${file}`);
  const header = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] || [];
  const definitions = new Map();
  for (const column of header) {
    const match = /^Metafield: custom\.([^ ]+) \[([^\]]+)\]$/.exec(String(column));
    if (match) definitions.set(match[1], { key: match[1], type: match[2], column });
  }
  return definitions;
}
const orderPath = (left, right) => {
  const a = String(left).split('/').map(Number), b = String(right).split('/').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
};
const dangerousHtml = value => /<\s*\/?\s*(script|style|iframe|object|embed|form|svg|math)\b|\bon[a-z]+\s*=|javascript\s*:|data\s*:/i.test(String(value));
function isStructured(value) {
  const text = String(value || '').trim();
  if (!/^[\[{]/.test(text)) return false;
  try { return typeof JSON.parse(text) === 'object'; } catch { return false; }
}

function cachedComponents(cache, categoryId, channelId) {
  const matching = row => String(row['Category ID']) === String(categoryId) && String(row['Channel ID']) === String(channelId);
  const properties = new Map();
  for (const row of cache.sheets['CMS Properties'].filter(matching)) {
    const key = row['Component Path'];
    if (!properties.has(key)) properties.set(key, []);
    properties.get(key).push(row);
  }
  const rows = cache.sheets['CMS Components'].filter(matching).sort((a, b) => orderPath(a['Component Path'], b['Component Path']));
  return rows.map((row, index) => ({
    itemName: row['Component Name'], componentName: row['Component Name'], componentType: row['Component Type'],
    componentPath: row['Component Path'], order: index + 1, hierarchyPath: String(row['Component Path']).split('/').map(part => Number(part) + 1),
    items: (properties.get(row['Component Path']) || []).map((property, propertyIndex) => ({
      propertyName: property['Property Name'], propertyType: property['Property Type'],
      value: isStructured(property['Property Value']) ? '' : property['Property Value'],
      structuredValue: isStructured(property['Property Value']), rawValue: property['Property Value'],
      sourceRow: `${index + 1}.${propertyIndex + 1}`, order: propertyIndex + 1,
    })),
  }));
}
function semanticFields(component, descriptionItem) {
  const fields = sectionTextFields(component, descriptionItem);
  const heading = fields.find(field => field.key === `${component.metafieldKey}_header`);
  const text = fields.find(field => field.key === `${component.metafieldKey}_text`);
  if (!heading || !text) return fields;
  return fields.filter(field => field !== heading && field !== text).concat({ ...heading,
    key: `${component.metafieldKey}_content`, value: [heading.value, text.value].filter(Boolean).join('\n'),
    sourceProperties: [...(heading.sourceProperties || []), ...(text.sourceProperties || [])] });
}
function buildCollectionCmsMetafieldUpdates(cache, { channelId = '1', definitions = verifiedDefinitions() } = {}) {
  if (cache.kind !== 'collections') throw new Error('Collection cache required');
  const rows = [], unsupported = [], mapped = [];
  const aliases = new Map();
  for (const collection of cache.sheets.Collections.filter(row => String(row['Channel ID']) === String(channelId))) {
    const id = String(collection['Shopify Collection ID'] || '');
    if (!id) continue;
    if (!aliases.has(id)) aliases.set(id, new Set());
    aliases.get(id).add(String(collection['Category ID']));
  }
  for (const collection of cache.sheets.Collections.filter(row => String(row['Channel ID']) === String(channelId))) {
    const categoryId = String(collection['Category ID']), id = String(collection['Shopify Collection ID'] || '');
    const culture = collection.Culture || '';
    if (progressOf(cache, categoryId, channelId, 'category')?.Status !== 'COMPLETE') {
      unsupported.push({ categoryId, channelId, reason: 'category extraction incomplete' });
      continue;
    }
    if (!id) { unsupported.push({ categoryId, channelId, reason: 'verified Shopify collection ID missing' }); continue; }
    if (aliases.get(id)?.size > 1) {
      unsupported.push({ categoryId, channelId, shopifyCollectionId: id, categoryIds: [...aliases.get(id)],
        reason: 'multiple Norce categories share one Shopify collection ID; approved alias handling required' });
      continue;
    }
    const components = semanticComponentKeys(cachedComponents(cache, categoryId, channelId));
    const descriptionItem = String(channelId) === '1' && !String(collection['Body HTML'] || '').trim()
      ? components.flatMap(component => component.items).find(item =>
        String(item.propertyName).toLowerCase() === 'text' && String(item.value || '').trim()) : null;
    const grouped = new Map();
    for (const component of components) {
      const generated = semanticFields(component, descriptionItem);
      const represented = new Set();
      if (descriptionItem && component.items.some(item => item.sourceRow === descriptionItem.sourceRow)) represented.add('text');
      for (const originalField of generated) {
        let field = originalField;
        for (const name of field.sourceProperties || []) represented.add(String(name).toLowerCase());
        const definition = definitions.get(field.key);
        if (!definition) { unsupported.push({ categoryId, channelId, culture, componentPath: component.componentPath,
          propertyNames: field.sourceProperties, candidateKey: field.key, reason: 'metafield definition is not verified in current Shopify export' }); continue; }
        if (definition.type === 'single_line_text_field' && field.type === 'list.single_line_text_field') {
          let links;
          try { links = JSON.parse(field.value); } catch { links = []; }
          if (Array.isArray(links) && links.length === 1) field = { ...field, type: 'single_line_text_field', value: links[0] };
        }
        if (definition.type !== field.type) { unsupported.push({ categoryId, channelId, culture, componentPath: component.componentPath,
          propertyNames: field.sourceProperties, candidateKey: field.key, expectedType: definition.type, actualType: field.type,
          reason: 'metafield type differs from current Shopify export' }); continue; }
        if (!field.value || dangerousHtml(field.value)) { unsupported.push({ categoryId, channelId, culture, componentPath: component.componentPath,
          propertyNames: field.sourceProperties, candidateKey: field.key, reason: 'empty or unsafe CMS value' }); continue; }
        if (!grouped.has(field.key)) grouped.set(field.key, { definition, values: [], components: [] });
        grouped.get(field.key).values.push(field.value);
        grouped.get(field.key).components.push(component.componentPath);
      }
      for (const property of component.items) {
        if (property.structuredValue) {
          unsupported.push({ categoryId, channelId, culture, componentPath: component.componentPath,
            propertyName: property.propertyName, propertyType: property.propertyType, reason: 'structured CMS value needs an explicit mapping' });
          continue;
        }
        if (represented.has(String(property.propertyName).toLowerCase()) || !String(property.value || '').trim()) continue;
        unsupported.push({ categoryId, channelId, culture, componentPath: component.componentPath,
          propertyName: property.propertyName, propertyType: property.propertyType, reason: 'CMS property has no approved text mapping' });
      }
    }
    for (const [key, group] of grouped) {
      const value = group.definition.type === 'rich_text_field' ? group.values.join('\n') : group.values.length === 1 ? group.values[0] : null;
      if (!value) { unsupported.push({ categoryId, channelId, culture, candidateKey: key, reason: 'repeated non-rich-text values need an approved list mapping' }); continue; }
      rows.push({ ID: id, Command: 'UPDATE', [group.definition.column]: value });
      mapped.push({ categoryId, channelId, culture, shopifyCollectionId: id, key, type: group.definition.type,
        componentPaths: group.components });
    }
  }
  return { rows, mapped, unsupported };
}

module.exports = { verifiedDefinitions, cachedComponents, buildCollectionCmsMetafieldUpdates };
