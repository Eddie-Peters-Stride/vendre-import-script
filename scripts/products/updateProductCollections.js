/**
 * updateProductCollections.js
 *
 * Builds a Matrixify product-collection assignment workbook from:
 * - Vendre products/collections JSON for category hierarchy
 * - Shopify product export CSV for the real Shopify product handles
 *
 * Output format:
 *   Handle, Collection
 *
 * Usage:
 *   node scripts/products/updateProductCollections.js
 *
 * If STORE_NAME is set, the script uses results/<STORE_NAME>/.
 * Otherwise it auto-detects the store folder that contains products_export_1.csv.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');
const SHOPIFY_EXPORT_FILES = ['products_export_1.csv', 'products_export_2.csv'];

function fileExists(filePath) {
    return fs.existsSync(filePath);
}

function readJsonList(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(raw) ? raw : (Array.isArray(raw.list) ? raw.list : []);
}

function inferStoreDir() {
    if (process.env.STORE_NAME) {
        const candidate = path.join(RESULTS_DIR, process.env.STORE_NAME);
        if (fileExists(candidate)) {
            return candidate;
        }
    }

    if (SHOPIFY_EXPORT_FILES.some(file => fileExists(path.join(RESULTS_DIR, file)))) {
        return RESULTS_DIR;
    }

    const subdirs = fs.readdirSync(RESULTS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(RESULTS_DIR, entry.name));

    const candidates = [];
    for (const dir of subdirs) {
        const exportFile = path.join(dir, 'products_export_1.csv');
        if (!fileExists(exportFile)) {
            continue;
        }

        const stat = fs.statSync(exportFile);
        candidates.push({
            dir,
            mtimeMs: stat.mtimeMs,
        });
    }

    if (candidates.length > 0) {
        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return candidates[0].dir;
    }

    return RESULTS_DIR;
}

function inferStoreName(storeDir) {
    if (process.env.STORE_NAME) {
        return process.env.STORE_NAME;
    }

    const prefixMatch = fs.readdirSync(storeDir).find(file => /^(.+)-products\.json$/i.test(file));
    if (prefixMatch) {
        return prefixMatch.replace(/-products\.json$/i, '');
    }

    return path.basename(storeDir) === 'results' ? 'store' : path.basename(storeDir);
}

function configureEnvFile(storeName) {
    if (process.env.ENV_FILE) {
        return;
    }

    const exactEnvFile = `.env.${storeName}`;
    if (fileExists(path.join(process.cwd(), exactEnvFile))) {
        process.env.ENV_FILE = exactEnvFile;
        return;
    }

    const envFiles = fs.readdirSync(process.cwd())
        .filter(file => /^\.env\./i.test(file));

    for (const file of envFiles) {
        const fullPath = path.join(process.cwd(), file);
        try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const match = content.match(/^\s*STORE_NAME\s*=\s*(.+)\s*$/m);
            if (match && match[1].trim() === storeName) {
                process.env.ENV_FILE = file;
                return;
            }
        } catch (error) {
            // Ignore unreadable env files and keep searching.
        }
    }
}

function loadStoreConfig(storeName) {
    configureEnvFile(storeName);

    try {
        const { getStoreConfig } = require('../../src/config/stores');
        return getStoreConfig();
    } catch (error) {
        console.warn(`Warning: using fallback config because store config could not be loaded: ${error.message}`);
        return {
            name: storeName,
            outputPrefix: storeName,
            exportSettings: {
                includeVendreData: false,
            },
        };
    }
}

function parseShopifyCsv(csvPath) {
    if (!fileExists(csvPath)) {
        return [];
    }

    const { parseShopifyCsv: parseCsvContent } = require('../../src/exporters/matrixify-translations');
    const content = fs.readFileSync(csvPath, 'utf8');
    return parseCsvContent(content);
}

function buildSkuToHandleMap(csvFiles) {
    const skuToHandle = {};

    for (const csvFile of csvFiles) {
        const rows = parseShopifyCsv(csvFile);

        for (const row of rows) {
            const handle = (row.Handle || '').trim();
            const sku = (row['Variant SKU'] || '').replace(/^'+/, '').trim();

            if (handle && sku && !skuToHandle[sku]) {
                skuToHandle[sku] = handle;
            }
        }
    }

    return skuToHandle;
}

function getAncestorIds(collectionId, idToCollection) {
    const ids = [];
    const visited = new Set();
    let current = idToCollection[collectionId];

    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        ids.push(current.id);
        current = current.parentId ? idToCollection[current.parentId] : null;
    }

    return ids;
}

function buildProductHandle(product, skuToHandle) {
    const { getVendreSku } = require('../../src/utils/sku');
    const { getProductHandle } = require('../../src/utils/handles');

    const sku = getVendreSku(product);
    if (sku && skuToHandle[sku]) {
        return skuToHandle[sku];
    }

    return getProductHandle(product);
}

function buildAssignments() {
    const storeDir = inferStoreDir();
    const storeName = inferStoreName(storeDir);
    const config = loadStoreConfig(storeName);

    const productsJsonPath = path.join(storeDir, `${storeName}-products.json`);
    const collectionsJsonPath = path.join(storeDir, `${storeName}-collections.json`);

    if (!fileExists(productsJsonPath)) {
        throw new Error(`Missing product JSON file: ${productsJsonPath}`);
    }
    if (!fileExists(collectionsJsonPath)) {
        throw new Error(`Missing collection JSON file: ${collectionsJsonPath}`);
    }

    const productExportFiles = SHOPIFY_EXPORT_FILES
        .map(file => path.join(storeDir, file))
        .filter(fileExists);

    if (productExportFiles.length === 0) {
        throw new Error(
            `Missing Shopify product export CSV file(s) in ${storeDir}: ${SHOPIFY_EXPORT_FILES.join(', ')}`
        );
    }

    const products = readJsonList(productsJsonPath);
    const collections = readJsonList(collectionsJsonPath);
    const { collections: normalizedCollections, maps } = require('../../src/transformers/collection-transformer').transformCollections(
        collections,
        config
    );

    const includeVendreData = config.exportSettings?.includeVendreData === true;
    const collectionHandleById = {};
    for (const collection of normalizedCollections) {
        collectionHandleById[collection.vendreId] = includeVendreData
            ? collection.vendreRawHandle
            : collection.handle;
    }

    const skuToHandle = buildSkuToHandleMap(productExportFiles);
    console.log(`Loaded ${Object.keys(skuToHandle).length} SKU -> handle mappings from Shopify export(s).`);

    const idToCollection = maps.idToCollection || {};
    const rows = [];
    const seen = new Set();
    let skippedProducts = 0;

    for (const product of products) {
        const productHandle = buildProductHandle(product, skuToHandle);
        const categoryIds = Array.isArray(product.category_ids) ? product.category_ids : [];

        if (!productHandle || categoryIds.length === 0) {
            skippedProducts++;
            continue;
        }

        const assignedHandles = new Set();

        for (const categoryId of categoryIds) {
            for (const ancestorId of getAncestorIds(categoryId, idToCollection)) {
                const collectionHandle = collectionHandleById[ancestorId];
                if (collectionHandle) {
                    assignedHandles.add(collectionHandle);
                }
            }
        }

        if (assignedHandles.size === 0) {
            skippedProducts++;
            continue;
        }

        for (const collectionHandle of assignedHandles) {
            const key = `${productHandle}::${collectionHandle}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            rows.push({
                Handle: productHandle,
                Collection: collectionHandle,
            });
        }
    }

    const outPath = path.join(storeDir, `${storeName}-matrixify-product-collections.xlsx`);
    const worksheet = XLSX.utils.json_to_sheet(rows);

    if (rows.length > 0) {
        worksheet['!cols'] = Object.keys(rows[0]).map(key => ({
            wch: Math.max(
                key.length,
                ...rows.slice(0, 200).map(row => String(row[key] || '').length)
            ),
        }));
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
    XLSX.writeFile(workbook, outPath);

    return {
        storeDir,
        storeName,
        outPath,
        rows,
        skippedProducts,
    };
}

try {
    const result = buildAssignments();

    console.log(`\nStore directory : ${result.storeDir}`);
    console.log(`Store name      : ${result.storeName}`);
    console.log(`Assigned rows   : ${result.rows.length}`);
    console.log(`Skipped products : ${result.skippedProducts}`);
    console.log(`Output          : ${result.outPath}`);
    console.log('\nImport this workbook into Matrixify to update product collection assignments.');
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
