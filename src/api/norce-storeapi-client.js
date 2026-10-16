/** Read-only Norce StoreAPI GraphQL client. No request is made until explicitly called. */
const DEFAULTS = Object.freeze({
    endpoint: 'https://storeapi.jetshop.io/',
    shopId: 'fyrklovern', culture: 'sv-SE', country: 'SE', currency: 'SEK',
});

const CATEGORY_QUERY = `query GetCategory($id: ID!) {
  category(id: $id) {
    id parentId name mainHeader content
    data { id name }
    images { url width height }
    primaryRoute { path }
  }
}`;

function storeApiConfigFromEnv(env = process.env) {
    return {
        endpoint: env.NORCE_STOREAPI_URL || DEFAULTS.endpoint,
        shopId: env.NORCE_STOREAPI_SHOPID || DEFAULTS.shopId,
        token: env.NORCE_STOREAPI_TOKEN || '',
        culture: env.NORCE_DEFAULT_CULTURE || DEFAULTS.culture,
        country: env.NORCE_DEFAULT_COUNTRY || DEFAULTS.country,
        currency: env.NORCE_DEFAULT_CURRENCY || DEFAULTS.currency,
        timeoutMs: positiveInt(env.NORCE_STOREAPI_TIMEOUT_MS, 15000),
        retries: nonNegativeInt(env.NORCE_STOREAPI_RETRIES, 2),
        throttleMs: nonNegativeInt(env.NORCE_STOREAPI_THROTTLE_MS, 250),
    };
}

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}
function nonNegativeInt(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

class NorceStoreApiClient {
    constructor({ config = storeApiConfigFromEnv(), transport = globalThis.fetch } = {}) {
        this.config = { ...DEFAULTS, ...config };
        this.transport = transport;
        this.lastRequestAt = 0;
        if (typeof transport !== 'function') throw new Error('A fetch-compatible transport is required.');
    }

    async fetchCategory(id, { culture = this.config.culture } = {}) {
        if (!this.config.token) throw new Error('Norce StoreAPI token is missing (NORCE_STOREAPI_TOKEN).');
        if (id == null || String(id).trim() === '') throw new Error('Category ID is required.');
        let endpoint;
        try { endpoint = new URL(this.config.endpoint); }
        catch { throw new Error('Norce StoreAPI URL must be a valid HTTPS URL.'); }
        if (endpoint.protocol !== 'https:') throw new Error('Norce StoreAPI URL must use HTTPS.');
        let lastError;
        for (let attempt = 0; attempt <= (this.config.retries || 0); attempt += 1) {
            const waitMs = Math.max(0, (this.config.throttleMs || 0) - (Date.now() - this.lastRequestAt));
            if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 15000);
            this.lastRequestAt = Date.now();
            try {
                const response = await this.transport(this.config.endpoint, {
                    method: 'POST', signal: controller.signal,
                    headers: {
                        'Content-Type': 'application/json', Shopid: this.config.shopId,
                        Token: this.config.token, Culture: culture,
                        Country: this.config.country, Currency: this.config.currency,
                    },
                    body: JSON.stringify({ query: CATEGORY_QUERY, variables: { id: String(id) } }),
                });
                if (!response.ok) {
                    const error = new Error(`Norce StoreAPI request failed with HTTP ${response.status}.`);
                    error.retryable = response.status === 429 || response.status >= 500;
                    throw error;
                }
                const payload = await response.json();
                if (payload.errors?.length) {
                    const error = new Error(`Norce StoreAPI returned ${payload.errors.length} GraphQL error(s).`);
                    error.retryable = false;
                    throw error;
                }
                const category = payload.data?.category ?? null;
                if (!category) return null;
                const contentIds = (Array.isArray(category.data) ? category.data : [category.data])
                    .map(item => item?.id).filter(Boolean);
                return { ...category, CategoryID: String(category.id ?? id), ContentId: contentIds.length === 1 ? String(contentIds[0]) : null, contentIds };
            } catch (error) {
                lastError = error;
                if (attempt >= (this.config.retries || 0) || error.retryable === false) throw new Error(error.message);
            } finally { clearTimeout(timeout); }
        }
        throw new Error(lastError?.message || 'Norce StoreAPI request failed.');
    }
}

module.exports = { DEFAULTS, CATEGORY_QUERY, storeApiConfigFromEnv, NorceStoreApiClient };
