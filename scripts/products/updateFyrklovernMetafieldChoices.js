#!/usr/bin/env node
/**
 * Adds Shopify preset-choice validations to Fyrklövern product metafield
 * definitions from a Matrixify Products export.
 *
 * Shopify supports choices on both single_line_text_field and
 * list.single_line_text_field definitions, with at most 128 choices per
 * definition. Boolean, reference, and high-cardinality fields are therefore
 * intentionally left unchanged.
 *
 * Usage:
 *   node scripts/products/updateFyrklovernMetafieldChoices.js --input="C:\\path\\export.xlsx"
 *   node scripts/products/updateFyrklovernMetafieldChoices.js --input="C:\\path\\export.xlsx" --apply
 *
 * --apply requires SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN. Without it,
 * the script produces a review report only and never writes to Shopify.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const CHOICE_LIMIT = 128;
const DEFAULT_API_VERSION = '2026-01';
const SINGLE_LINE_TEXT_HEADER = /^Metafield:\s+([^.\s]+)\.([^\s]+)\s+\[(list\.)?single_line_text_field\]$/;

function parseArguments(argv) {
    const options = { apply: false, apiVersion: DEFAULT_API_VERSION };

    for (const argument of argv) {
        if (argument === '--apply') options.apply = true;
        else if (argument.startsWith('--input=')) options.input = argument.slice('--input='.length);
        else if (argument.startsWith('--report=')) options.report = argument.slice('--report='.length);
        else if (argument.startsWith('--api-version=')) options.apiVersion = argument.slice('--api-version='.length);
        else throw new Error(`Unknown argument: ${argument}`);
    }

    if (!options.input) {
        throw new Error('Pass the Matrixify export with --input="C:\\path\\Export.xlsx".');
    }

    return options;
}

function parseChoiceValues(value, type) {
    if (value == null || value === '') return [];

    const text = String(value).trim();
    if (!text) return [];

    if (type === 'list.single_line_text_field') {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                return parsed.map(item => String(item).trim()).filter(Boolean);
            }
        } catch {
            // Matrixify also accepts comma, semicolon, or newline-separated
            // list values. The supplied export uses JSON arrays, but retain a
            // fallback for future exports.
            return text.split(/[;,\n]/).map(item => item.trim()).filter(Boolean);
        }
    }

    // Retaining the exact scalar cell value prevents commas in valid product
    // labels from being split accidentally.
    return [text];
}

function collectChoiceDefinitions(rows) {
    if (rows.length === 0) throw new Error('The Products sheet has no rows.');

    const definitions = new Map();
    for (const header of Object.keys(rows[0])) {
        const match = header.match(SINGLE_LINE_TEXT_HEADER);
        if (!match) continue;

        definitions.set(header, {
            header,
            namespace: match[1],
            key: match[2],
            type: match[3] ? 'list.single_line_text_field' : 'single_line_text_field',
            choices: new Set(),
        });
    }

    for (const row of rows) {
        for (const definition of definitions.values()) {
            for (const value of parseChoiceValues(row[definition.header], definition.type)) {
                definition.choices.add(value);
            }
        }
    }

    return [...definitions.values()]
        .map(definition => ({
            ...definition,
            choices: [...definition.choices].sort((a, b) =>
                a.localeCompare(b, 'sv-SE', { sensitivity: 'base' })
            ),
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

function buildReport(definitions) {
    return definitions.map(definition => ({
        namespace: definition.namespace,
        key: definition.key,
        type: definition.type,
        choiceCount: definition.choices.length,
        choices: definition.choices,
        status: definition.choices.length === 0
            ? 'skipped'
            : definition.choices.length > CHOICE_LIMIT
                ? 'skipped'
                : 'ready',
        reason: definition.choices.length === 0
            ? 'No existing values in the export.'
            : definition.choices.length > CHOICE_LIMIT
                ? `Shopify permits at most ${CHOICE_LIMIT} choices.`
                : 'Eligible for Shopify preset choices.',
    }));
}

async function shopifyGraphql(query, variables, options) {
    const domain = process.env.SHOPIFY_STORE_DOMAIN;
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!domain || !accessToken) {
        throw new Error('--apply requires SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN.');
    }

    const normalizedDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const response = await fetch(
        `https://${normalizedDomain}/admin/api/${options.apiVersion}/graphql.json`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': accessToken,
            },
            body: JSON.stringify({ query, variables }),
        }
    );
    const payload = await response.json();
    if (!response.ok || payload.errors) {
        throw new Error(`Shopify GraphQL error: ${JSON.stringify(payload.errors || payload)}`);
    }
    return payload.data;
}

async function fetchProductDefinitions(options) {
    const query = `
        query ProductMetafieldDefinitions($cursor: String) {
          metafieldDefinitions(first: 250, ownerType: PRODUCT, after: $cursor) {
            nodes { namespace key type { name } validations { name value } }
            pageInfo { hasNextPage endCursor }
          }
        }
    `;
    const definitions = [];
    let cursor = null;

    do {
        const data = await shopifyGraphql(query, { cursor }, options);
        definitions.push(...data.metafieldDefinitions.nodes);
        cursor = data.metafieldDefinitions.pageInfo.hasNextPage
            ? data.metafieldDefinitions.pageInfo.endCursor
            : null;
    } while (cursor);

    return new Map(definitions.map(definition => [
        `${definition.namespace}.${definition.key}`,
        definition,
    ]));
}

async function applyChoiceValidations(report, options) {
    const existingDefinitions = await fetchProductDefinitions(options);
    const mutation = `
        mutation UpdateMetafieldDefinition($definition: MetafieldDefinitionUpdateInput!) {
          metafieldDefinitionUpdate(definition: $definition) {
            updatedDefinition { namespace key validations { name value } }
            userErrors { field message code }
          }
        }
    `;

    for (const item of report) {
        if (item.status !== 'ready') continue;

        const existing = existingDefinitions.get(`${item.namespace}.${item.key}`);
        if (!existing) {
            item.status = 'skipped';
            item.reason = 'No matching Shopify product metafield definition exists.';
            continue;
        }
        if (existing.type.name !== item.type) {
            item.status = 'skipped';
            item.reason = `Shopify definition type is ${existing.type.name}, not ${item.type}.`;
            continue;
        }

        // Keep validations such as min/max while replacing only the choices rule.
        const validations = existing.validations
            .filter(validation => validation.name !== 'choices')
            .concat({ name: 'choices', value: JSON.stringify(item.choices) });
        const data = await shopifyGraphql(mutation, {
            definition: {
                namespace: item.namespace,
                key: item.key,
                ownerType: 'PRODUCT',
                validations,
            },
        }, options);
        const result = data.metafieldDefinitionUpdate;
        if (result.userErrors.length > 0) {
            item.status = 'failed';
            item.reason = result.userErrors.map(error => error.message).join('; ');
        } else {
            item.status = 'updated';
            item.reason = 'Preset choices updated in Shopify.';
        }
    }
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const inputPath = path.resolve(options.input);
    if (!fs.existsSync(inputPath)) throw new Error(`Input file was not found: ${inputPath}`);

    // Let SheetJS use its normal workbook decoding so Swedish choice labels
    // such as "Trä" and "ÅSAS TOMTEBOD" are preserved exactly.
    const workbook = XLSX.readFile(inputPath);
    const worksheet = workbook.Sheets.Products;
    if (!worksheet) {
        throw new Error(`Worksheet "Products" was not found. Available sheets: ${workbook.SheetNames.join(', ')}`);
    }

    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
    const report = buildReport(collectChoiceDefinitions(rows));
    if (options.apply) await applyChoiceValidations(report, options);

    const reportPath = path.resolve(options.report || path.join(
        __dirname,
        '..',
        '..',
        'results',
        'fyrklovern',
        'fyrklovern-metafield-choice-report.json'
    ));
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify({
        inputFile: inputPath,
        applied: options.apply,
        generatedAt: new Date().toISOString(),
        choiceLimit: CHOICE_LIMIT,
        definitions: report,
    }, null, 2)}\n`);

    const updated = report.filter(item => item.status === 'updated').length;
    const ready = report.filter(item => item.status === 'ready').length;
    const skipped = report.filter(item => item.status === 'skipped').length;
    const failed = report.filter(item => item.status === 'failed').length;
    console.log(`Report written to ${reportPath}`);
    console.log(`Updated: ${updated}; ready: ${ready}; skipped: ${skipped}; failed: ${failed}`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(`Fyrklövern metafield-choice update failed: ${error.message}`);
        process.exit(1);
    });
}

module.exports = {
    CHOICE_LIMIT,
    collectChoiceDefinitions,
    buildReport,
    parseChoiceValues,
};
