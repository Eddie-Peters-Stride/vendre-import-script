/*
 * Builds a Shopify standard language-import CSV from Fyrklövern's custom
 * export. Swedish (sv-SE) is the migrated/default content and is never
 * emitted as a translation. A Shopify language export is required because
 * Shopify's importer identifies resources by Shopify-owned IDs.
 *
 * Usage:
 * node scripts/fyrklovern/exportShopifyLanguageTranslations.js \
 *   --input="C:\\path\\fyrklovern_custom_export.xlsx" \
 *   --shopify-export="C:\\path\\shopify-language-export.csv" \
 *   --output="results/fyrklovern/fyrklovern-shopify-language-import.csv"
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const SOURCE_LOCALE = 'sv-SE';
const PRODUCT_SHEET = 'productslocalized';
const COLLECTION_SHEET = 'categorieslocalized';
const DEFAULT_OUTPUT = path.join(
    __dirname,
    '..',
    '..',
    'outputs',
    'Fyrklovern',
    'Shopify language import',
    'Fyrklovern multilingual content - Shopify language import.csv'
);

function argument(name, fallback = '') {
    const prefix = `--${name}=`;
    const match = process.argv.find(value => value.startsWith(prefix));
    return match ? match.slice(prefix.length) : fallback;
}

function clean(value) {
    if (value == null || value === 'NULL') return '';
    return String(value).trim();
}

function normalizeText(value) {
    return clean(value).replace(/\s+/g, ' ').toLocaleLowerCase('sv-SE');
}

function normalizeType(value) {
    const type = clean(value).toLowerCase();
    if (type === 'product' || type === 'products') return 'product';
    if (type === 'collection' || type === 'collections') return 'collection';
    return '';
}

function normalizeField(value) {
    const field = clean(value).toLowerCase().replace(/[\s-]+/g, '_');
    const aliases = {
        title: 'title',
        body_html: 'body_html',
        description: 'body_html',
        meta_title: 'meta_title',
        seo_title: 'meta_title',
        meta_description: 'meta_description',
        seo_description: 'meta_description',
    };
    return aliases[field] || '';
}

function localeCandidates(locale) {
    const normalized = clean(locale).replace('_', '-');
    const language = normalized.split('-')[0];
    return [...new Set([normalized.toLowerCase(), language.toLowerCase()])];
}

function buildLocaleLookup(values) {
    const lookup = new Map();
    for (const locale of values) {
        for (const candidate of localeCandidates(locale)) {
            if (!lookup.has(candidate)) lookup.set(candidate, locale);
        }
    }
    return lookup;
}

/** Parse one RFC 4180-style CSV record, including escaped quotes. */
function parseCsvRecord(text) {
    const values = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character === '"') {
            if (quoted && text[index + 1] === '"') {
                value += '"';
                index++;
            } else {
                quoted = !quoted;
            }
        } else if (character === ',' && !quoted) {
            values.push(value);
            value = '';
        } else {
            value += character;
        }
    }
    values.push(value);
    return values;
}

function readCsv(filePath) {
    const workbook = XLSX.readFile(filePath, { raw: false, codepage: 65001 });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    // Some Swedish spreadsheet programs wrap an otherwise valid comma CSV in
    // a semicolon-separated first column. Recover its original records before
    // mapping, rather than treating the data as five empty semicolon columns.
    if (clean(matrix[0]?.[0]).startsWith('Type,Identification,Field,Locale,')) {
        const headers = parseCsvRecord(matrix[0][0]);
        return matrix.slice(1)
            .filter(row => clean(row[0]))
            .map(row => parseCsvRecord(row[0]))
            .map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
    }
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

function getColumn(row, expected) {
    const key = Object.keys(row).find(column => clean(column).toLowerCase() === expected.toLowerCase());
    return key ? row[key] : '';
}

function sourceFields(row, type) {
    if (type === 'product') {
        return {
            title: clean(row.name),
            body_html: clean(row.description),
            meta_title: clean(row.pagetitle),
            meta_description: clean(row.metadescription),
        };
    }
    return {
        title: clean(row.name),
        body_html: clean(row.content),
        meta_title: clean(row.pagetitle),
        meta_description: clean(row.metadescription),
    };
}

function readSource(workbookPath) {
    const workbook = XLSX.readFile(workbookPath, { raw: false });
    const result = { product: [], collection: [] };
    const sheetSettings = [
        [PRODUCT_SHEET, 'product', 'productid'],
        [COLLECTION_SHEET, 'collection', 'categoryid'],
    ];

    for (const [sheetName, type, idColumn] of sheetSettings) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) throw new Error(`Missing required worksheet: ${sheetName}`);
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
        for (const row of rows) {
            const locale = clean(row.culture);
            const id = clean(row[idColumn]);
            if (!id || !locale) continue;
            const fields = sourceFields(row, type);
            if (Object.values(fields).some(Boolean)) result[type].push({ id, locale, fields });
        }
    }
    return result;
}

function buildSourceTitleIndex(source) {
    const titles = { product: new Map(), collection: new Map() };
    for (const type of Object.keys(titles)) {
        for (const row of source[type]) {
            if (row.locale.toLowerCase() !== SOURCE_LOCALE.toLowerCase()) continue;
            const title = normalizeText(row.fields.title);
            if (!title) continue;
            if (!titles[type].has(title)) titles[type].set(title, new Set());
            titles[type].get(title).add(row.id);
        }
    }
    return titles;
}

function buildSourceTranslationIndex(source) {
    const translations = new Map();
    for (const type of Object.keys(source)) {
        for (const row of source[type]) {
            if (row.locale.toLowerCase() === SOURCE_LOCALE.toLowerCase()) continue;
            for (const locale of localeCandidates(row.locale)) {
                for (const [field, value] of Object.entries(row.fields)) {
                    if (value) translations.set(`${type}|${row.id}|${locale}|${field}`, value);
                }
            }
        }
    }
    return translations;
}

function makeReport() {
    return {
        importedRows: 0,
        translatedRows: 0,
        mappedResources: { product: 0, collection: 0 },
        unmappedResources: { product: [], collection: [] },
        skipped: [],
    };
}

function bindResources(shopifyRows, titleIndex, report) {
    const bindings = new Map();
    const seen = new Set();
    for (const row of shopifyRows) {
        const type = normalizeType(getColumn(row, 'Type'));
        const field = normalizeField(getColumn(row, 'Field'));
        const identification = clean(getColumn(row, 'Identification'));
        if (!type || field !== 'title' || !identification) continue;
        const title = normalizeText(getColumn(row, 'Default content'));
        const candidates = titleIndex[type].get(title);
        if (!candidates || candidates.size !== 1) {
            if (!seen.has(`${type}|${identification}`)) {
                report.unmappedResources[type].push({ identification, title: getColumn(row, 'Default content'), reason: candidates ? 'duplicate Swedish title' : 'no Swedish title match' });
                seen.add(`${type}|${identification}`);
            }
            continue;
        }
        bindings.set(`${type}|${identification}`, [...candidates][0]);
    }
    for (const key of bindings.keys()) report.mappedResources[key.split('|')[0]]++;
    return bindings;
}

function buildImportRows(shopifyRows, bindings, translations, report) {
    const localeLookup = buildLocaleLookup([...new Set(shopifyRows.map(row => clean(getColumn(row, 'Locale'))).filter(Boolean))]);
    const output = [];
    for (const row of shopifyRows) {
        const type = normalizeType(getColumn(row, 'Type'));
        const field = normalizeField(getColumn(row, 'Field'));
        const identification = clean(getColumn(row, 'Identification'));
        const exportedLocale = clean(getColumn(row, 'Locale'));
        const sourceId = bindings.get(`${type}|${identification}`);
        if (
            !type || !field || !identification || !exportedLocale || !sourceId ||
            localeCandidates(exportedLocale).includes('sv')
        ) continue;
        const sourceLocale = localeLookup.get(localeCandidates(exportedLocale).find(candidate => localeLookup.has(candidate)) || '');
        const value = sourceLocale
            ? translations.get(`${type}|${sourceId}|${localeCandidates(sourceLocale)[0]}|${field}`) || translations.get(`${type}|${sourceId}|${localeCandidates(sourceLocale)[1]}|${field}`)
            : '';
        if (!value) continue;
        const outputRow = {
            Type: getColumn(row, 'Type'),
            Identification: identification,
            Field: getColumn(row, 'Field'),
            Locale: exportedLocale,
            Market: getColumn(row, 'Market'),
            Status: getColumn(row, 'Status'),
            'Default content': getColumn(row, 'Default content'),
            'Translated content': value,
        };
        output.push(outputRow);
    }
    report.translatedRows = output.length;
    return output;
}

function main() {
    const input = argument('input');
    const shopifyExport = argument('shopify-export');
    const output = argument('output', DEFAULT_OUTPUT);
    if (!input || !shopifyExport) {
        throw new Error('Both --input and --shopify-export are required.');
    }
    if (!fs.existsSync(input)) throw new Error(`Source workbook not found: ${input}`);
    if (!fs.existsSync(shopifyExport)) throw new Error(`Shopify export not found: ${shopifyExport}`);

    const source = readSource(input);
    const shopifyRows = readCsv(shopifyExport);
    const report = makeReport();
    report.importedRows = shopifyRows.length;
    const bindings = bindResources(shopifyRows, buildSourceTitleIndex(source), report);
    const outputRows = buildImportRows(shopifyRows, bindings, buildSourceTranslationIndex(source), report);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const outputWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(outputWorkbook, XLSX.utils.json_to_sheet(outputRows, {
        header: ['Type', 'Identification', 'Field', 'Locale', 'Market', 'Status', 'Default content', 'Translated content'],
    }), 'Translations');
    XLSX.writeFile(outputWorkbook, output, { bookType: 'csv', FS: ',', RS: '\n', type: 'file' });
    const reportPath = output.replace(/\.csv$/i, '-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`Created ${outputRows.length} Shopify translation rows: ${output}`);
    console.log(`Validation report: ${reportPath}`);
}

try {
    main();
} catch (error) {
    console.error(`Translation export failed: ${error.message}`);
    process.exitCode = 1;
}
