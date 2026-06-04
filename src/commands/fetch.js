/**
 * Fetch command - Fetch data from Vendre API and save to results folder
 */

const path = require('path');
const VendreClient = require('../api/vendre-client');
const { safeWriteJson, ensureDirectory } = require('../utils/file-io');

/**
 * Fetch products from Vendre
 * @param {Object} config - Store configuration
 * @param {string} outputDir - Output directory path
 * @returns {Promise<Object>} Result with count and file path
 */
async function fetchProducts(config, outputDir) {
    const client = new VendreClient({
        baseUrl: config.apiUrl,
        apiKey: config.apiKey,
    });

    const products = await client.fetchProducts();

    ensureDirectory(outputDir);
    const outputPath = path.join(outputDir, `${config.outputPrefix}-products.json`);
    safeWriteJson(outputPath, { list: products });

    console.log(`✓ Saved ${products.length} products to ${outputPath}`);

    return {
        count: products.length,
        path: outputPath,
    };
}

/**
 * Fetch collections from Vendre
 * @param {Object} config - Store configuration
 * @param {string} outputDir - Output directory path
 * @returns {Promise<Object>} Result with count and file path
 */
async function fetchCollections(config, outputDir) {
    const client = new VendreClient({
        baseUrl: config.apiUrl,
        apiKey: config.apiKey,
    });

    const collections = await client.fetchCollections();

    ensureDirectory(outputDir);
    const outputPath = path.join(outputDir, `${config.outputPrefix}-collections.json`);
    safeWriteJson(outputPath, { list: collections });

    console.log(`✓ Saved ${collections.length} collections to ${outputPath}`);

    return {
        count: collections.length,
        path: outputPath,
    };
}

/**
 * Fetch customers from Vendre
 * @param {Object} config - Store configuration
 * @param {string} outputDir - Output directory path
 * @returns {Promise<Object>} Result with count and file path
 */
async function fetchCustomers(config, outputDir) {
    const client = new VendreClient({
        baseUrl: config.apiUrl,
        apiKey: config.apiKey,
    });

    const customers = await client.fetchCustomers();

    ensureDirectory(outputDir);
    const outputPath = path.join(outputDir, `${config.outputPrefix}-customers.json`);
    safeWriteJson(outputPath, { list: customers });

    console.log(`✓ Saved ${customers.length} customers to ${outputPath}`);

    return {
        count: customers.length,
        path: outputPath,
    };
}

/**
 * Fetch all data types from Vendre
 * @param {Object} config - Store configuration
 * @param {string} outputDir - Output directory path
 * @returns {Promise<Object>} Results for all data types
 */
async function fetchAll(config, outputDir) {
    console.log(`\nFetching all data for ${config.name}...\n`);

    const results = {};

    results.products = await fetchProducts(config, outputDir);
    console.log(`Fetched ${results.products?.length || 0} products.`);

    results.collections = await fetchCollections(config, outputDir);
    console.log(`Fetched ${results.collections?.length || 0} collections.`);

    results.customers = await fetchCustomers(config, outputDir);
    console.log(`Fetched ${results.customers?.length || 0} customers.`);

    console.log('\n✓ Fetch complete!\n');
    return results;
}

module.exports = {
    fetchProducts,
    fetchCollections,
    fetchCustomers,
    fetchAll,
};
