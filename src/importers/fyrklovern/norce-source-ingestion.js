/**
 * Offline readers and audit helpers for Norce category workbooks and CMS CSVs.
 * Source fields are retained verbatim so new/unknown CMS component schemas are
 * visible in review output instead of being silently discarded.
 */

const fs = require('fs');
const XLSX = require('xlsx');

const SHEETS = {
    localized: 'categorieslocalized',
    permalinks: 'categorypermalinks',
    structure: 'category structure',
};

function clean(value) {
    if (value == null) return '';
    const text = String(value).trim();
    return text === 'NULL' ? '' : text;
}

function isImageComponentName(value) {
    return /image|picture/i.test(String(value || '')) ||
        (/media/i.test(String(value || '')) && !/socialmedia/i.test(String(value || '')));
}

function keyOf(id, culture) {
    return `${clean(id)}\u0000${clean(culture)}`;
}

function getField(row, candidates) {
    const byLowerName = new Map(Object.keys(row).map(name => [name.toLowerCase().trim(), name]));
    const field = candidates.map(candidate => byLowerName.get(candidate.toLowerCase())).find(Boolean);
    return field ? row[field] : '';
}

function sheetRows(workbook, name) {
    const sheetName = workbook.SheetNames.find(sheet => sheet.toLowerCase() === name.toLowerCase());
    return sheetName ? XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false }) : [];
}

function readCategoryWorkbook(inputPath) {
    const workbook = XLSX.readFile(inputPath, { raw: false });
    const localizedRows = sheetRows(workbook, SHEETS.localized);
    if (!workbook.SheetNames.some(sheet => sheet.toLowerCase() === SHEETS.localized.toLowerCase())) {
        throw new Error(`Worksheet "${SHEETS.localized}" was not found. Available sheets: ${workbook.SheetNames.join(', ')}`);
    }
    const permalinkRows = sheetRows(workbook, SHEETS.permalinks);
    const structureRows = sheetRows(workbook, SHEETS.structure);
    const diagnostics = {
        categoryDuplicates: [], categoryConflicts: [],
        permalinkDuplicates: [], permalinkConflicts: [],
        structureDuplicates: [], structureConflicts: [],
    };
    const resolvedCategories = resolveSourceRows(localizedRows, row => keyOf(
        getField(row, ['CategoryID', 'Category Id']), getField(row, ['Culture'])
    ), diagnostics.categoryDuplicates, diagnostics.categoryConflicts, 'category');
    const permalinksByKey = resolveSourceRows(permalinkRows, row => keyOf(
        getField(row, ['CategoryID', 'Category Id']), getField(row, ['Culture'])
    ), diagnostics.permalinkDuplicates, diagnostics.permalinkConflicts, 'permalink');
    const structureByKey = resolveSourceRows(structureRows, row => keyOf(
        getField(row, ['Last CategoryID', 'CategoryID', 'Category Id']), getField(row, ['Culture'])
    ), diagnostics.structureDuplicates, diagnostics.structureConflicts, 'structure');

    const categories = [];
    for (const [key, record] of resolvedCategories.entries()) {
        const row = record.row;
        const categoryId = clean(getField(row, ['CategoryID', 'Category Id']));
        const culture = clean(getField(row, ['Culture']));
        if (!categoryId || !culture) continue;
        categories.push({
            key, categoryId, culture, source: row, sourceRow: record.sourceRow,
            permalinks: permalinksByKey.get(key)?.row ? [permalinksByKey.get(key).row] : [],
            structures: structureByKey.get(key)?.row ? [structureByKey.get(key).row] : [],
            permalinkConflict: Boolean( !permalinksByKey.has(key) && diagnostics.permalinkConflicts.some(item => item.key === key)),
            structureConflict: Boolean(!structureByKey.has(key) && diagnostics.structureConflicts.some(item => item.key === key)),
        });
    }
    return { categories, diagnostics };
}

function resolveSourceRows(rows, getKey, duplicates, conflicts, label) {
    const result = new Map();
    const grouped = new Map();
    for (const [index, row] of rows.entries()) {
        const key = getKey(row);
        if (!key || key.startsWith('\u0000')) continue;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push({ row, sourceRow: index + 2 });
    }
    for (const [key, entries] of grouped) {
        const unique = new Map(entries.map(entry => [JSON.stringify(entry.row), entry]));
        if (entries.length > 1 && unique.size === 1) {
            duplicates.push({ key, sourceRows: entries.map(entry => entry.sourceRow), removedCount: entries.length - 1 });
        } else if (unique.size > 1) {
            conflicts.push({
                key, sourceRows: entries.map(entry => entry.sourceRow),
                rows: entries.map(entry => entry.row), reason: `conflicting ${label} rows; excluded from canonical data`,
            });
            continue;
        }
        result.set(key, entries[0]);
    }
    return result;
}

/** RFC 4180 style delimited parser (including escaped quotes and quoted newlines). */
function parseDelimited(text, delimiter = ';') {
    const input = String(text).replace(/^\uFEFF/, '');
    const records = [];
    let record = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < input.length; i += 1) {
        const char = input[i];
        if (quoted) {
            if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
            else if (char === '"') quoted = false;
            else field += char;
        } else if (char === '"' && field.length === 0) quoted = true;
        else if (char === delimiter) { record.push(field); field = ''; }
        else if (char === '\n' || char === '\r') {
            if (char === '\r' && input[i + 1] === '\n') i += 1;
            record.push(field); field = '';
            if (record.some(value => value !== '')) records.push(record);
            record = [];
        } else field += char;
    }
    if (quoted) throw new Error('Malformed delimited CSV: unterminated quoted field');
    if (field.length || record.length) {
        record.push(field);
        if (record.some(value => value !== '')) records.push(record);
    }
    return records;
}

function parseCmsCsvText(text) {
    const records = parseDelimited(text, ';');
    if (!records.length) return { records: [], headers: [] };
    const headerIssues = [];
    const normalizedHeaders = new Map();
    const headers = records[0].map((header, index) => {
        const cleanHeader = (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim();
        if (!cleanHeader) {
            headerIssues.push({ column: index + 1, reason: 'blank header', rejected: true });
            return `__blank_header_${index + 1}`;
        }
        const normalized = cleanHeader.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalizedHeaders.has(normalized)) {
            headerIssues.push({
                column: index + 1, header: cleanHeader, duplicateOf: normalizedHeaders.get(normalized),
                reason: 'duplicate normalized header', rejected: true,
            });
            return `__duplicate_${index + 1}_${cleanHeader}`;
        }
        normalizedHeaders.set(normalized, cleanHeader);
        return cleanHeader;
    });
    const rowWidthIssues = [];
    const rows = records.slice(1).map((values, index) => {
        const sourceRow = index + 2;
        if (values.length !== records[0].length) {
            rowWidthIssues.push({
                sourceRow, expectedColumns: records[0].length, actualColumns: values.length,
                kind: values.length < records[0].length ? 'short' : 'overflow',
                missingColumnCount: Math.max(0, records[0].length - values.length),
                missingColumns: headers.slice(values.length),
                rowValues: values,
                overflowValues: values.slice(records[0].length),
            });
        }
        const row = {};
        headers.forEach((header, column) => { row[header || `column_${column + 1}`] = values[column] ?? ''; });
        return {
            ...row, __sourceRow: sourceRow,
            __overflow: values.slice(headers.length),
            __shortCellCount: Math.max(0, headers.length - values.length),
        };
    });
    return { records: rows, headers, diagnostics: { headerIssues, rowWidthIssues } };
}

function readCmsCsv(inputPath) {
    return parseCmsCsvText(fs.readFileSync(inputPath, 'utf8'));
}

function findColumn(headers, aliases) {
    const normalized = new Map(headers.map(header => [header.toLowerCase().replace(/[^a-z0-9]/g, ''), header]));
    for (const alias of aliases) {
        const found = normalized.get(alias.toLowerCase().replace(/[^a-z0-9]/g, ''));
        if (found) return found;
    }
    return null;
}

function orderValue(row, headers, aliases) {
    const field = findColumn(headers, aliases);
    const value = field ? clean(row[field]) : '';
    const numeric = Number(value);
    return value && Number.isFinite(numeric) ? numeric : null;
}

function normalizeCms(records, headers) {
    const contentIdField = findColumn(headers, ['ContentId', 'Content ID']);
    const cultureField = findColumn(headers, ['Culture', 'Language', 'Locale']);
    const componentNameField = findColumn(headers, ['ComponentName', 'Component Name', 'ComponentType', 'Component Type', 'ComponentItemType', 'ComponentTypeName', 'TypeName', 'Component', 'Type']);
    const componentIdField = findColumn(headers, ['ComponentItemId', 'Component Item Id', 'ComponentId', 'Component ID', 'InstanceId']);
    const itemNameField = findColumn(headers, ['ItemName', 'Item Name']);
    const componentOrderField = findColumn(headers, ['ComponentPosition', 'ComponentOrder', 'ComponentIndex', 'Position']);
    const itemOrderField = findColumn(headers, ['ItemPosition', 'ItemOrder', 'ItemIndex', 'SortOrder']);
    const propertyField = findColumn(headers, ['PropertyName', 'Property', 'FieldName']);
    const propertyTypeField = findColumn(headers, ['PropertyType', 'ValueType', 'FieldType']);
    const valueField = findColumn(headers, ['PropertyValue', 'ItemValue', 'Value', 'Text']);
    const cultureColumns = headers.filter(header => /^[a-z]{2}-[A-Z]{2}$/.test(header));
    const wideLocalized = cultureColumns.length > 0;
    const contents = new Map();
    const missingRelationships = [];
    const inventory = {
        componentTypes: {}, propertyNames: {}, propertyTypes: {}, rows: records.length,
        cultures: cultureColumns,
        localizedRows: wideLocalized ? records.length * cultureColumns.length : records.length,
        imageRelatedHeaders: headers.filter(header => /(image|asset|alt)/i.test(header)),
        imageUrlHeaders: headers.filter(header => /(image|asset).*(url|uri|src|link)|(url|uri|src|link).*(image|asset)/i.test(header)),
        imageComponentRows: 0,
        imagePropertiesByComponent: {},
    };
    const inventoriedRows = new Set();

    for (const sourceRow of records) {
        const row = sourceRow;
        const contentId = clean(contentIdField ? row[contentIdField] : '');
        if (!contentId) {
            missingRelationships.push({ sourceRow: row.__sourceRow, reason: 'missing ContentId', source: row });
            continue;
        }
        const localizedRows = wideLocalized
            ? cultureColumns.map(culture => ({ culture, value: row[culture], cultureValues: Object.fromEntries(cultureColumns.map(column => [column, row[column]])) }))
            : [{ culture: clean(cultureField ? row[cultureField] : ''), value: valueField ? row[valueField] : '', cultureValues: null }];
        if (localizedRows.some(localized => !localized.culture)) {
            missingRelationships.push({ sourceRow: row.__sourceRow, contentId, reason: 'missing culture', source: row });
        }
        if (!inventoriedRows.has(row.__sourceRow)) {
            const componentName = clean(componentNameField ? row[componentNameField] : '') || '(root or unknown)';
            const propertyName = clean(propertyField ? row[propertyField] : '') || '(unknown)';
            const propertyType = clean(propertyTypeField ? row[propertyTypeField] : '') || '(not provided)';
            inventory.componentTypes[componentName] = (inventory.componentTypes[componentName] || 0) + 1;
            inventory.propertyNames[propertyName] = (inventory.propertyNames[propertyName] || 0) + 1;
            inventory.propertyTypes[propertyType] = (inventory.propertyTypes[propertyType] || 0) + 1;
            if (isImageComponentName(componentName)) {
                inventory.imageComponentRows += 1;
                if (!inventory.imagePropertiesByComponent[componentName]) inventory.imagePropertiesByComponent[componentName] = {};
                const imageProperties = inventory.imagePropertiesByComponent[componentName];
                imageProperties[propertyName] = (imageProperties[propertyName] || 0) + 1;
            }
            inventoriedRows.add(row.__sourceRow);
        }

        for (const localized of localizedRows) {
            const culture = localized.culture;
            if (!culture) continue;
            const rawComponentName = clean(componentNameField ? row[componentNameField] : '');
            const componentId = clean(componentIdField ? row[componentIdField] : '');
            const itemName = clean(itemNameField ? row[itemNameField] : '');
            const componentType = rawComponentName || (!componentId ? 'root' : '(unknown)');
            const propertyName = clean(propertyField ? row[propertyField] : '') || clean(itemNameField ? row[itemNameField] : '') || '(unknown)';
            const propertyType = clean(propertyTypeField ? row[propertyTypeField] : '') || '(not provided)';
            const key = keyOf(contentId, culture);
            if (!contents.has(key)) contents.set(key, { key, contentId, culture, components: [], sourceRows: [] });
            const content = contents.get(key);
            const componentOrder = orderValue(row, headers, ['ComponentPosition', 'ComponentOrder', 'ComponentIndex', 'Position']);
            const groupKey = JSON.stringify([contentId, culture, itemName, rawComponentName, componentId]);
            let component = content.components.find(item => item.groupKey === groupKey);
            if (!component) {
                component = {
                    groupKey, componentId, componentItemId: componentId, componentName: rawComponentName,
                    itemName, componentType, order: componentOrder ?? row.__sourceRow,
                    sourceOrder: row.__sourceRow, items: [],
                };
                content.components.push(component);
            }
            component.items.push({
                order: orderValue(row, headers, ['ItemPosition', 'ItemOrder', 'ItemIndex', 'SortOrder']) ?? row.__sourceRow,
                propertyName,
                propertyType,
                itemName,
                value: localized.value,
                cultureValues: localized.cultureValues,
                fields: Object.fromEntries(Object.entries(row).filter(([name]) => name !== '__sourceRow')),
                sourceRow: row.__sourceRow,
            });
            content.sourceRows.push(row.__sourceRow);
        }
    }

    const sorted = [...contents.values()].map(content => ({
        ...content,
        components: content.components.map(component => ({
            ...component,
            items: [...component.items].sort(compareOrdered),
        })).sort(compareOrdered),
    })).sort((a, b) => a.contentId.localeCompare(b.contentId) || a.culture.localeCompare(b.culture));
    return { contents: sorted, inventory, missingRelationships };
}

function compareOrdered(a, b) {
    const orderA = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
    const orderB = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
    if (orderA !== orderB) return orderA - orderB;
    const sourceA = a.sourceOrder ?? a.sourceRow ?? 0;
    const sourceB = b.sourceOrder ?? b.sourceRow ?? 0;
    return sourceA - sourceB;
}

function normalizeContentMap(input) {
    if (!input) return [];
    const value = typeof input === 'string' ? JSON.parse(fs.readFileSync(input, 'utf8')) : input;
    const entries = Array.isArray(value) ? value : (value.list || value.mappings || []);
    return entries.map(entry => ({
        categoryId: clean(entry.categoryId ?? entry.CategoryID),
        culture: clean(entry.culture ?? entry.Culture),
        contentId: clean(entry.contentId ?? entry.ContentId),
        source: entry.source || 'provided mapping',
    })).filter(entry => entry.categoryId && entry.culture);
}

function buildAudit({ categories, categoryDiagnostics = null, cms, cmsCsvDiagnostics = null, contentMap = [], categoryId = '149', culture = 'sv-SE' }) {
    const relationDiagnostics = { duplicates: [], conflicts: [] };
    const relationGroups = new Map();
    for (const relation of normalizeContentMap(contentMap)) {
        const key = keyOf(relation.categoryId, relation.culture);
        if (!relationGroups.has(key)) relationGroups.set(key, []);
        relationGroups.get(key).push(relation);
    }
    const relations = new Map();
    for (const [key, entries] of relationGroups) {
        const ids = new Set(entries.map(entry => entry.contentId));
        if (ids.size > 1) {
            relationDiagnostics.conflicts.push({ key, mappings: entries, reason: 'multiple ContentIds for one CategoryID/culture; excluded as ambiguous' });
            continue;
        }
        if (entries.length > 1) relationDiagnostics.duplicates.push({ key, count: entries.length - 1, contentId: entries[0].contentId });
        relations.set(key, entries[0]);
    }
    const cmsByKey = new Map(cms.contents.map(item => [keyOf(item.contentId, item.culture), item]));
    const missingContentIds = categories.filter(category => !relations.get(category.key)?.contentId).map(category => ({
        categoryId: category.categoryId, culture: category.culture,
    }));
    const previews = categories.map(category => {
        const relation = relations.get(category.key);
        const content = relation?.contentId ? cmsByKey.get(keyOf(relation.contentId, category.culture)) : null;
        const source = category.source;
        const candidates = [];
        const contentHeader = findColumn(Object.keys(source), ['content']);
        const textHeader = findColumn(Object.keys(source), ['text']);
        const bodyHeader = contentHeader || textHeader;
        const body = bodyHeader ? source[bodyHeader] : '';
        const seoTitle = getField(source, ['pagetitle', 'PageTitle']);
        const seoDescription = getField(source, ['metadescription', 'MetaDescription']);
        if (clean(body)) candidates.push({ source: `categorieslocalized.${bodyHeader}`, target: 'Body HTML', value: body });
        if (clean(seoTitle)) candidates.push({ source: 'categorieslocalized.pagetitle', target: 'SEO title candidate', value: seoTitle });
        if (clean(seoDescription)) candidates.push({ source: 'categorieslocalized.metadescription', target: 'SEO description candidate', value: seoDescription });
        for (const component of content?.components || []) {
            if (/text|root|headingandparagraphs/i.test(component.componentType) ||
                component.items.some(item => /^(text|html|heading|paragraph)$/i.test(item.propertyName))) candidates.push({
                source: `CMS ${component.componentType}`,
                target: 'unmapped review candidate',
                componentOrder: component.order,
                items: component.items,
            });
        }
        return {
            categoryId: category.categoryId,
            culture: category.culture,
            categoryName: clean(getField(source, ['name', 'CategoryName'])),
            originalUrlRows: category.permalinks,
            contentId: relation?.contentId || null,
            contentIdSource: relation?.source || null,
            cmsFound: Boolean(content),
            sourceFields: source,
            candidates,
            components: content?.components || [],
            imageAudit: auditImageFields(content),
            imageCoverage: {
                componentCount: (content?.components || []).filter(component => isImageComponentName(component.componentType)).length,
                sourceUrlCount: (content?.components || []).flatMap(component => component.items).filter(item =>
                    /^(image|imageurl|url|src|source)$/i.test(item.propertyName) && isHttpUrl(clean(item.value))
                ).length,
                status: content
                    ? ((content.components || []).some(component => isImageComponentName(component.componentType))
                        ? 'image components present; review imageAudit for URL and alt metadata'
                        : 'no image components are present for this ContentId in the CMS CSV')
                    : 'no matched CMS content for this category and culture',
            },
            bodyFieldDiagnostics: contentHeader && textHeader
                ? [{ reason: 'both content and text headers exist; content has priority', selected: contentHeader, fallbackIgnored: textHeader }]
                : [],
        };
    });
    const requested = previews.find(item => item.categoryId === String(categoryId) && (!culture || item.culture === culture));
    const result = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        candidatesOnly: true,
        categoryPreview: requested || null,
        missingContentIds,
        contentMapDuplicates: relationDiagnostics.duplicates,
        contentMapConflicts: relationDiagnostics.conflicts,
        categorySourceDiagnostics: categoryDiagnostics,
        cmsCsvDiagnostics,
        unmatchedContentRecords: cms.contents.filter(content => ![...relations.values()].some(rel =>
            rel.contentId === content.contentId && rel.culture === content.culture
        )).map(({ contentId, culture }) => ({ contentId, culture })),
        cmsInventory: {
            ...cms.inventory,
            imageRelatedProperties: Object.fromEntries(Object.entries(cms.inventory.propertyNames).filter(([name]) => /(image|asset|alt|url)/i.test(name))),
            imageRelatedComponents: Object.fromEntries(Object.entries(cms.inventory.componentTypes).filter(([name]) => /image/i.test(name))),
        },
        missingCmsRelationships: cms.missingRelationships,
        previews,
        notes: [
            'Candidate mappings are for review only; no Shopify metafield keys are assigned.',
            'Empty source values are omitted from candidate mappings.',
        ],
    };
    const hasImageUrlProperty = Object.entries(cms.inventory.imagePropertiesByComponent)
        .filter(([componentName]) => isImageComponentName(componentName))
        .some(([, properties]) => Object.keys(properties).some(name => /^(imageurl|url|src|source)$/i.test(name)));
    if (cms.inventory.imageComponentRows > 0 && cms.inventory.imageUrlHeaders.length === 0 && !hasImageUrlProperty) {
        result.notes.push('CMS image components include component item IDs and alt metadata but no image URL/source property; component item IDs are not treated as asset IDs.');
    }
    return result;
}

function auditImageFields(content) {
    const unresolved = [];
    for (const component of content?.components || []) {
        const isImageComponent = isImageComponentName(component.componentType);
        let hasImageSource = false;
        for (const item of component.items) {
            const property = clean(item.propertyName);
            if (/alt/i.test(property) && (isImageComponent || /image|asset/i.test(property))) {
                unresolved.push({
                    componentType: component.componentType, componentItemId: component.componentItemId,
                    itemName: component.itemName, sourceRow: item.sourceRow,
                    field: property, value: clean(item.value), kind: 'altText', unresolved: false,
                    note: 'Alt text is metadata; it is not an image URL or file reference.',
                });
                continue;
            }
            const isSourceProperty = /^(image|imageurl|url|src|source|asset|assetid|imageid|fileid|mediaid)$/i.test(property);
            if (!isSourceProperty || (!isImageComponent && !/image|asset|file|media/i.test(property))) continue;
            const value = clean(item.value);
            if (!value) continue;
            const validUrl = isHttpUrl(value);
            hasImageSource = hasImageSource || validUrl;
            unresolved.push({
                componentType: component.componentType, componentItemId: component.componentItemId,
                itemName: component.itemName, sourceRow: item.sourceRow,
                field: property, value, kind: validUrl ? 'imageUrl' : 'assetReference',
                unresolved: !validUrl,
                reason: validUrl ? null : (isHttpUrlLike(value) ? 'invalid image URL' : 'CMS value is an asset reference without a resolved URL'),
            });
        }
        if (isImageComponent && !hasImageSource) {
            unresolved.push({
                componentType: component.componentType, componentItemId: component.componentItemId,
                itemName: component.itemName, field: null, value: null,
                kind: 'imageSourceMissing', unresolved: true,
                reason: 'CMS component has no resolved image URL; ComponentItemId is a component identifier, not a verified asset reference.',
            });
        }
        /* Retain any legacy long-format explicit image URL/asset columns. */
        for (const item of component.items) {
            const associatedUrls = Object.entries(item.fields).filter(([name]) =>
                /(?:image|asset).*(?:url|uri|src|link)|(?:url|uri|src|link).*(?:image|asset)/i.test(name)
            ).map(([, value]) => clean(value)).filter(Boolean);
            for (const [field, value] of Object.entries(item.fields)) {
                if (!/(image|asset|alt)/i.test(field) || !clean(value)) continue;
                const text = clean(value);
                if (/alt/i.test(field) && !/alt/i.test(item.propertyName)) {
                    unresolved.push({ componentType: component.componentType, componentOrder: component.order, field, value: text, kind: 'altText', unresolved: false });
                    continue;
                }
                if (/alt/i.test(field)) continue;
                const urlField = /(url|uri|src|link)/i.test(field) || /^https?:\/\//i.test(text);
                const validUrl = urlField && isHttpUrl(text);
                const associatedUrlStatus = associatedUrls.map(url => {
                    return isHttpUrl(url);
                });
                const hasAssociatedUrl = associatedUrls.length > 0;
                const hasValidAssociatedUrl = associatedUrlStatus.some(Boolean);
                unresolved.push({
                    componentType: component.componentType,
                    componentOrder: component.order,
                    field,
                    value: text,
                    kind: urlField ? 'imageUrl' : 'assetReference',
                    unresolved: urlField ? !validUrl : !hasValidAssociatedUrl,
                    reason: urlField
                        ? (validUrl ? null : 'invalid image URL')
                        : (hasAssociatedUrl && !hasValidAssociatedUrl
                            ? 'invalid source image URL'
                            : (hasValidAssociatedUrl ? null : 'source image URL is absent from this CMS item')),
                });
            }
        }
    }
    return unresolved;
}

function isHttpUrl(value) {
    try {
        const parsed = new URL(value);
        return ['http:', 'https:'].includes(parsed.protocol);
    } catch { return false; }
}

function isHttpUrlLike(value) {
    return /^[a-z][a-z0-9+.-]*:/i.test(value) || /^\/\//.test(value);
}

module.exports = {
    SHEETS, clean, keyOf, parseDelimited, parseCmsCsvText, readCmsCsv,
    readCategoryWorkbook, normalizeCms, normalizeContentMap, buildAudit, auditImageFields,
};
