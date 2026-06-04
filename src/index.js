#!/usr/bin/env node
/**
 * Main CLI entry point for Vendre-to-Matrixify import scripts
 * 
 * Usage:
 *   ENV_FILE=.env.dragonslair node src/index.js --command=sync
 *   ENV_FILE=.env.store2 node src/index.js --command=fetch
 *   ENV_FILE=.env.dragonslair node src/index.js --command=export --type=products
 */

const path = require('path');
const { getStoreConfig, getStoreName, validateStoreConfig } = require('./config/stores');
const { fetchAll, fetchProducts, fetchCollections, fetchCustomers } = require('./commands/fetch');
const { exportAll, exportProductsCommand, exportCollectionsCommand, exportCustomersCommand, exportTranslations } = require('./commands/export');
const { syncAll } = require('./commands/sync');

// Parse command line arguments
function parseArgs() {
    const args = {};
    process.argv.slice(2).forEach(arg => {
        const [key, value] = arg.replace(/^--/, '').split('=');
        args[key] = value || true;
    });
    return args;
}

// Display usage information
function showUsage() {
    const currentStore = getStoreName();
    const storeInfo = currentStore
        ? `Current store: ${currentStore} (from ${process.env.ENV_FILE || '.env'})`
        : 'No store configured - set ENV_FILE environment variable';

    console.log(`
Vendre-to-Matrixify Import Scripts
═══════════════════════════════════

${storeInfo}

USAGE:
  ENV_FILE=.env.<storeName> node src/index.js --command=<command> [options]

COMMANDS:
  sync              Fetch from Vendre and export to Matrixify (recommended)
  fetch             Fetch data from Vendre API and save to JSON
  export            Export JSON data to Matrixify Excel files

OPTIONS:
  --type=<type>     Specify data type: products, collections, customers, translations, all (default: all)
  --help            Show this help message

EXAMPLES:
  # Sync all data for Dragons Lair
  ENV_FILE=.env.dragonslair node src/index.js --command=sync

  # Fetch only products
  ENV_FILE=.env.dragonslair node src/index.js --command=fetch --type=products

  # Export only collections
  ENV_FILE=.env.dragonslair node src/index.js --command=export --type=collections

  # Export only translations
  ENV_FILE=.env.dragonslair node src/index.js --command=export --type=translations

  # Full sync for second store
  ENV_FILE=.env.store2 node src/index.js --command=sync

DIRECTORIES:
  Data files:    results/<storeName>/
  Excel output:  results/<storeName>/

SETUP:
  1. Create a .env file for your store (e.g., .env.dragonslair)
  2. Set required environment variables (see .env.example)
  3. Run commands with ENV_FILE set (e.g., ENV_FILE=.env.dragonslair npm run sync)
`);
}

async function main() {
    const args = parseArgs();

    // Show usage if no command or --help is provided
    if (args.help || !args.command) {
        showUsage();
        process.exit(args.help ? 0 : 1);
    }

    // Validate store configuration
    const validation = validateStoreConfig();
    if (!validation.valid) {
        console.error(`\n❌ Configuration errors: \n`);
        validation.errors.forEach(err => console.error(`  - ${err}`));
        console.error(`\nMake sure ENV_FILE is set and points to a valid .env file with all required variables.\n`);
        console.error(`Example: ENV_FILE=.env.dragonslair node src/index.js --command=sync\n`);
        process.exit(1);
    }

    // Get store config
    const config = getStoreConfig();
    const storeName = getStoreName();

    // Set up directories - use store-specific subdirectories
    const dataDir = path.join(__dirname, '..', 'results', storeName);
    const outputDir = path.join(__dirname, '..', 'results', storeName);

    const type = args.type || 'all';

    try {
        switch (args.command) {
            case 'sync':
                await syncAll(config, dataDir, outputDir);
                break;

            case 'fetch':
                if (type === 'all') {
                    await fetchAll(config, dataDir);
                } else if (type === 'products') {
                    await fetchProducts(config, dataDir);
                } else if (type === 'collections') {
                    await fetchCollections(config, dataDir);
                } else if (type === 'customers') {
                    await fetchCustomers(config, dataDir);
                } else {
                    throw new Error(`Unknown type: ${type}`);
                }
                break;

            case 'export':
                if (type === 'all') {
                    await exportAll(config, dataDir, outputDir);
                } else if (type === 'products') {
                    await exportProductsCommand(config, dataDir, outputDir, {
                        full: true,
                        priceUpdate: true,
                        vendorUpdate: true,
                    });
                } else if (type === 'collections') {
                    await exportCollectionsCommand(config, dataDir, outputDir, {
                        full: true,
                        metafields: true,
                        subcollections: true,
                    });
                } else if (type === 'customers') {
                    await exportCustomersCommand(config, dataDir, outputDir, {
                        noPhone: true,
                    });
                } else if (type === 'translations') {
                    await exportTranslations(config, dataDir, outputDir);
                } else {
                    throw new Error(`Unknown type: ${type}`);
                }
                break;

            default:
                throw new Error(`Unknown command: ${args.command}`);
        }

        console.log('✓ Done!\n');
        process.exit(0);

    } catch (error) {
        console.error(`\n❌ Error: ${error.message}\n`);
        if (error.stack && process.env.DEBUG) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = { main };
