/**
 * Sync command - Fetch data from Vendre and export to Matrixify in one operation
 */

const { fetchAll } = require('./fetch');
const { exportAll } = require('./export');

/**
 * Sync all data for a store (fetch + export)
 * @param {Object} config - Store configuration
 * @param {string} dataDir - Directory for JSON data files
 * @param {string} outputDir - Output directory for Excel files
 * @returns {Promise<Object>} Results from fetch and export
 */
async function syncAll(config, dataDir, outputDir) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  Syncing ${config.name}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    const startTime = Date.now();

    // Fetch data from Vendre
    const fetchResults = await fetchAll(config, dataDir);

    // Export to Matrixify
    const exportResults = await exportAll(config, dataDir, outputDir);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  ✓ Sync complete in ${duration}s`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    return {
        fetch: fetchResults,
        export: exportResults,
        duration,
    };
}

module.exports = {
    syncAll,
};
