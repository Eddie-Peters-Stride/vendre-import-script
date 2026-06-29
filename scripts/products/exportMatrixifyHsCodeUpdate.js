#!/usr/bin/env node
/**
 * Build a Matrixify workbook that updates Variant HS Code based on the
 * collection a product belongs to.
 */

require('dotenv').config({
    path: process.env.ENV_FILE || '.env',
});

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { loadVendreData, ensureDirectory } = require('../../src/utils/file-io');
const { getProductHandle } = require('../../src/utils/handles');
const { transformCollections } = require('../../src/transformers/collection-transformer');

const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');
const OUTPUT_BASENAME = 'matrixify-hs-code-update.xlsx';

// Most specific collections first, broad parent collections last.
const HS_CODE_RULES = [
    { title: 'Brädspel & Sällskapsspel - Plastfickor och Förvaring', code: '3926909090' },
    { title: 'Samlarkortspel - Plastfickor och Tillbehör', code: '3926909090' },
    { title: 'Rollspel & Tärningar - Tillbehör och tärningar', code: '3926400000' },
    { title: 'Rollspel & Tärningar - Lajv vapen och utrustning', code: '9503008900' },
    { title: 'BookNooks, Prydnad & Lek - Pussel & hjärnpussel', code: '9503006900' },
    { title: 'BookNooks, Prydnad & Lek - Korsstyngs-kit med nördiga teman', code: '6308000090' },
    { title: 'BookNooks, Prydnad & Lek - Böcker', code: '4901990000' },
    { title: 'BookNooks, Prydnad & Lek - Plush -mjukisdjur', code: '9503002900' },
    { title: 'BookNooks, Prydnad & Lek - Book Nook', code: '9503008900' },
    { title: 'BookNooks, Prydnad & Lek - Leksaker och fidget toys', code: '9503008900' },
    { title: 'Övrigt - Book Nooks', code: '9503008900' },
    { title: 'Brädspel & Sällskapsspel', code: '9504908000' },
    { title: 'Samlarkortspel', code: '95044000' },
    { title: 'Rollspel & Tärningar', code: '4901990000' },
    { title: 'Poker', code: '9504908000' },
    { title: 'BookNooks, Prydnad & Lek', code: '9503008900' },
];

const UPDATE_COLUMNS = [
    'Handle',
    'Command',
    'Variant HS Code',
];

function normalizeKey(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function resolveProductsPath(storeName) {
    const candidates = [];

    if (storeName) {
        candidates.push(path.join(RESULTS_DIR, storeName, `${storeName}-products.json`));
    }

    candidates.push(path.join(RESULTS_DIR, 'products.json'));

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        `Could not find a products JSON file. Looked in: ${candidates.join(', ')}. ` +
        `Set STORE_NAME or run the npm script so ENV_FILE points at the right store.`
    );
}

function resolveCollectionsPath(storeName) {
    const candidates = [];

    if (storeName) {
        candidates.push(path.join(RESULTS_DIR, storeName, `${storeName}-collections.json`));
    }

    candidates.push(path.join(RESULTS_DIR, 'collections.json'));

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        `Could not find a collections JSON file. Looked in: ${candidates.join(', ')}. ` +
        `Set STORE_NAME or run the npm script so ENV_FILE points at the right store.`
    );
}

function resolveOutputPath(storeName) {
    if (storeName) {
        const outputDir = path.join(RESULTS_DIR, storeName);
        ensureDirectory(outputDir);
        return path.join(outputDir, `${storeName}-${OUTPUT_BASENAME}`);
    }

    ensureDirectory(RESULTS_DIR);
    return path.join(RESULTS_DIR, OUTPUT_BASENAME);
}

function autoFitColumns(worksheet, rows, headers) {
    if (!rows || rows.length === 0) return;

    worksheet['!cols'] = headers.map((header) => {
        const maxLen = Math.max(
            header.length,
            ...rows.map((row) => {
                const value = row[header] != null ? String(row[header]) : '';
                return Math.min(value.length, 80);
            })
        );

        return { wch: Math.min(maxLen + 2, 80) };
    });
}

function getCollectionDepth(collectionId, idToCollection, cache) {
    if (cache[collectionId] != null) {
        return cache[collectionId];
    }

    const collection = idToCollection[collectionId];
    if (!collection) {
        return -1;
    }

    const parentId = collection.parent_id;
    if (!parentId || !idToCollection[parentId]) {
        cache[collectionId] = 0;
        return 0;
    }

    const depth = getCollectionDepth(parentId, idToCollection, cache) + 1;
    cache[collectionId] = depth;
    return depth;
}

function buildRuleLookup() {
    const lookup = new Map();

    HS_CODE_RULES.forEach((rule, index) => {
        lookup.set(normalizeKey(rule.title), { ...rule, index });
    });

    return lookup;
}

function findBestHsCode(product, collectionMaps, ruleLookup, depthCache) {
    const categoryIds = Array.isArray(product?.categoryIds)
        ? product.categoryIds
        : (Array.isArray(product?.category_ids) ? product.category_ids : []);
    if (categoryIds.length === 0) {
        return null;
    }

    let best = null;

    for (const categoryId of categoryIds) {
        let current = collectionMaps.idToCollection[categoryId];
        const visited = new Set();

        while (current && !visited.has(current.id)) {
            visited.add(current.id);

            const title = collectionMaps.idToTitle[current.id];
            const rule = ruleLookup.get(normalizeKey(title));

            if (rule) {
                const depth = getCollectionDepth(current.id, collectionMaps.idToCollection, depthCache);
                if (
                    !best ||
                    depth > best.depth ||
                    (depth === best.depth && rule.index < best.index)
                ) {
                    best = {
                        code: rule.code,
                        title,
                        depth,
                        index: rule.index,
                    };
                }
            }

            current = current.parent_id ? collectionMaps.idToCollection[current.parent_id] : null;
        }
    }

    return best;
}

function buildHsCodeRows(products, collectionMaps) {
    const rows = [];
    let skippedNoHandle = 0;
    let skippedNoMatch = 0;
    const ruleLookup = buildRuleLookup();
    const depthCache = {};

    for (const product of products) {
        const handle = getProductHandle(product);
        if (!handle) {
            skippedNoHandle++;
            continue;
        }

        const match = findBestHsCode(product, collectionMaps, ruleLookup, depthCache);
        if (!match) {
            skippedNoMatch++;
            continue;
        }

        rows.push({
            Handle: handle,
            Command: 'MERGE',
            'Variant HS Code': Number(match.code),
        });
    }

    return { rows, skippedNoHandle, skippedNoMatch };
}

async function main() {
    const storeName = process.env.STORE_NAME || '';
    const productsPath = resolveProductsPath(storeName);
    const collectionsPath = resolveCollectionsPath(storeName);
    const outputPath = resolveOutputPath(storeName);

    const products = loadVendreData(productsPath);
    const collectionsRaw = loadVendreData(collectionsPath);
    const collections = Array.isArray(collectionsRaw) ? collectionsRaw : (collectionsRaw.list || []);

    console.log(`Loaded ${products.length} products from ${productsPath}`);
    console.log(`Loaded ${collections.length} collections from ${collectionsPath}`);

    const { collections: normalizedCollections, maps: collectionMaps } = transformCollections(collections, {});
    console.log(`Normalized ${normalizedCollections.length} collections for HS code matching`);

    const { rows, skippedNoHandle, skippedNoMatch } = buildHsCodeRows(products, collectionMaps);

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: UPDATE_COLUMNS });
    autoFitColumns(worksheet, rows, UPDATE_COLUMNS);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
    XLSX.writeFile(workbook, outputPath);

    console.log(`Rows written      : ${rows.length}`);
    console.log(`Skipped no handle : ${skippedNoHandle}`);
    console.log(`Skipped no match  : ${skippedNoMatch}`);
    console.log(`Done. Matrixify workbook written to ${outputPath}`);
}

main().catch((error) => {
    console.error(`\nError: ${error.message}\n`);
    if (process.env.DEBUG && error.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});
