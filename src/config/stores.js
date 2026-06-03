/**
 * Multi-store configuration
 * Load store settings from environment variables
 * 
 * Usage: Set ENV_FILE=.env.dragonslair before running scripts
 */

// Load environment variables from ENV_FILE or default .env
require('dotenv').config({
    path: process.env.ENV_FILE || '.env'
});

/**
 * Load store configuration from environment variables
 * Parses TAX_CLASS_* and SPEC_FIELD_* patterns
 * @returns {Object} Store configuration object
 */
function loadStoreConfigFromEnv() {
    const storeName = process.env.STORE_NAME;

    if (!storeName) {
        throw new Error(
            'STORE_NAME not found in environment variables. ' +
            'Make sure ENV_FILE is set (e.g., ENV_FILE=.env.dragonslair)'
        );
    }

    // Parse tax classes from TAX_CLASS_* environment variables
    const taxClasses = {};
    Object.keys(process.env)
        .filter(key => key.startsWith('TAX_CLASS_'))
        .forEach(key => {
            const classId = key.replace('TAX_CLASS_', '');
            taxClasses[classId] = parseInt(process.env[key], 10);
        });

    // Parse spec fields from SPEC_FIELD_* environment variables
    const specFields = {};
    Object.keys(process.env)
        .filter(key => key.startsWith('SPEC_FIELD_'))
        .forEach(key => {
            const fieldName = key.replace('SPEC_FIELD_', '');
            specFields[fieldName] = parseInt(process.env[key], 10);
        });

    // Build configuration object
    const config = {
        name: process.env.STORE_DISPLAY_NAME || storeName,
        apiUrl: process.env.API_URL,
        apiKey: process.env.API_KEY,
        outputPrefix: storeName,

        taxClasses,
        specFields,

        customerTags: {
            importTag: process.env.CUSTOMER_TAG_IMPORT || 'vendre-import',
            inactiveTag: process.env.CUSTOMER_TAG_INACTIVE || 'inactive',
        },

        phoneFormat: {
            countryCode: process.env.PHONE_COUNTRY_CODE || '+46',
            removeLeadingZero: process.env.PHONE_REMOVE_LEADING_ZERO === 'true',
        },
    };

    return config;
}

/**
 * Get configuration for the current store (from environment)
 * @returns {Object} Store configuration
 * @throws {Error} If required environment variables are missing
 */
function getStoreConfig() {
    const config = loadStoreConfigFromEnv();

    // Validate required fields
    const validation = validateStoreConfig();
    if (!validation.valid) {
        const errors = validation.errors.join('\n  - ');
        throw new Error(
            `Store configuration is invalid:\n  - ${errors}\n\n` +
            `Make sure your .env file (${process.env.ENV_FILE || '.env'}) has all required variables.`
        );
    }

    return config;
}

/**
 * Get the current store name from environment
 * @returns {string|null} Store name or null if not set
 */
function getStoreName() {
    return process.env.STORE_NAME || null;
}

/**
 * Validate that all required environment variables are set
 * @returns {Object} Validation result { valid: boolean, errors: Array<string> }
 */
function validateStoreConfig() {
    const errors = [];

    // Required variables
    const requiredVars = {
        STORE_NAME: 'Store identifier',
        API_URL: 'Vendre API URL',
        API_KEY: 'Vendre API key',
    };

    for (const [varName, description] of Object.entries(requiredVars)) {
        if (!process.env[varName]) {
            errors.push(`Missing ${varName} (${description})`);
        }
    }

    // Validate API key is not a placeholder
    if (process.env.API_KEY && process.env.API_KEY.includes('your-') && process.env.API_KEY.includes('-api-key')) {
        errors.push('API_KEY appears to be a placeholder - update with actual API key');
    }

    // Check for at least some tax classes
    const taxClassCount = Object.keys(process.env)
        .filter(key => key.startsWith('TAX_CLASS_')).length;
    if (taxClassCount === 0) {
        errors.push('No TAX_CLASS_* variables found - define at least one tax class');
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

module.exports = {
    getStoreConfig,
    getStoreName,
    validateStoreConfig,
};
