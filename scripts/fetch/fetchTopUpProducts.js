#!/usr/bin/env node
/**
 * Legacy top-up entrypoint.
 *
 * This wrapper keeps the existing npm script working while delegating the
 * actual comparison and Matrixify export to the modular src pipeline.
 */

const path = require('path');

process.env.ENV_FILE = process.env.ENV_FILE || '.env.dragonslair';

const { getStoreConfig, getStoreName, validateStoreConfig } = require('../../src/config/stores');
const { exportTopupCommand } = require('../../src/commands/export');

async function main() {
    const validation = validateStoreConfig();
    if (!validation.valid) {
        console.error('\nConfiguration errors:\n');
        validation.errors.forEach(err => console.error(`  - ${err}`));
        console.error(`\nMake sure ENV_FILE points to a valid store env file.\n`);
        process.exit(1);
    }

    const config = getStoreConfig();
    const storeName = getStoreName();
    const dataDir = path.join(__dirname, '..', '..', 'results', storeName);

    await exportTopupCommand(config, dataDir, dataDir);
}

if (require.main === module) {
    main().catch(error => {
        console.error(`\nError: ${error.message}\n`);
        if (error.stack && process.env.DEBUG) {
            console.error(error.stack);
        }
        process.exit(1);
    });
}

module.exports = { main };
