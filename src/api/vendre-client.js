/**
 * Vendre API Client
 * Consolidates paginated fetching logic previously duplicated across 3 files
 */

const axios = require('axios');

class VendreClient {
    constructor(config) {
        this.baseUrl = config.baseUrl || 'https://dragonslair.se/API/1';
        this.apiKey = config.apiKey;
        this.pageSize = config.pageSize || 250;

        if (!this.apiKey) {
            throw new Error('VendreClient: apiKey is required');
        }
    }

    /**
     * Generic paginated fetch from Vendre API
     * @param {string} endpoint - API endpoint (e.g., 'products', 'categories', 'customers')
     * @param {Object} additionalParams - Additional query parameters
     * @returns {Promise<Array>} All fetched items
     */
    async paginatedFetch(endpoint, additionalParams = {}) {
        const allItems = [];
        let offset = 0;
        let remaining = 1;

        const url = `${this.baseUrl}/${endpoint}`;

        while (remaining > 0) {
            try {
                const response = await axios.get(url, {
                    params: {
                        page_size: this.pageSize,
                        offset,
                        ...additionalParams,
                    },
                    headers: {
                        'Accept': 'application/json',
                        'X-Authorization': this.apiKey,
                    },
                });

                const data = response.data;
                const items = data.list || [];
                allItems.push(...items);
                remaining = data.remaining || 0;
                offset += this.pageSize;

                console.log(`Fetched ${allItems.length} ${endpoint}, ${remaining} remaining...`);
            } catch (error) {
                if (error.response) {
                    throw new Error(
                        `Vendre API error (${endpoint}): HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`
                    );
                }
                throw new Error(`Vendre API error (${endpoint}): ${error.message}`);
            }
        }

        return allItems;
    }

    /**
     * Fetch all products from Vendre
     * @returns {Promise<Array>} All products
     */
    async fetchProducts() {
        console.log('Fetching products from Vendre...');
        return this.paginatedFetch('products');
    }

    /**
     * Fetch all categories/collections from Vendre
     * @returns {Promise<Array>} All categories
     */
    async fetchCollections() {
        console.log('Fetching collections from Vendre...');
        return this.paginatedFetch('categories');
    }

    /**
     * Fetch all customers from Vendre
     * @returns {Promise<Array>} All customers
     */
    async fetchCustomers() {
        console.log('Fetching customers from Vendre...');
        return this.paginatedFetch('customers');
    }

    /**
     * Fetch specific products by IDs (for incremental updates)
     * @param {Array<number>} ids - Product IDs to fetch
     * @returns {Promise<Array>} Fetched products
     */
    async fetchProductsByIds(ids) {
        if (!ids || ids.length === 0) return [];

        console.log(`Fetching ${ids.length} specific products...`);
        const products = [];

        // Fetch in batches to avoid URL length limits
        const batchSize = 50;
        for (let i = 0; i < ids.length; i += batchSize) {
            const batch = ids.slice(i, i + batchSize);
            const items = await this.paginatedFetch('products', {
                ids: batch.join(','),
            });
            products.push(...items);
            console.log(`Fetched ${products.length}/${ids.length} products...`);
        }

        return products;
    }
}

module.exports = VendreClient;
