const { CHANNELS } = require('./channels');

const ENDPOINT = 'https://storeapi.jetshop.io/';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryAfter = value => {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - Date.now());
};

class RateLimiter {
  constructor(intervalMs = 500) { this.intervalMs = intervalMs; this.nextAt = 0; this.tail = Promise.resolve(); }
  async wait() {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    const pause = Math.max(0, this.nextAt - Date.now());
    if (pause) await sleep(pause);
    this.nextAt = Date.now() + this.intervalMs;
    release();
  }
  slow(ms) { this.nextAt = Math.max(this.nextAt, Date.now() + ms); }
}
const globalLimiter = new RateLimiter(500);

class NorceExtractionClient {
  constructor({ token = process.env.NORCE_STOREAPI_TOKEN, endpoint = process.env.NORCE_STOREAPI_URL || ENDPOINT,
    shopId = process.env.NORCE_STOREAPI_SHOPID || 'fyrklovern', transport = globalThis.fetch,
    timeoutMs = 30000, retries = 5, limiter = globalLimiter } = {}) {
    if (!token) throw new Error('NORCE_STOREAPI_TOKEN is required for extraction.');
    if (new URL(endpoint).protocol !== 'https:') throw new Error('StoreAPI endpoint must use HTTPS.');
    this.token = token; this.endpoint = endpoint; this.shopId = shopId; this.transport = transport;
    this.timeoutMs = timeoutMs; this.retries = retries; this.limiter = limiter; this.typeCache = new Map();
  }
  async query(query, variables, channel = CHANNELS[0]) {
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      await this.limiter.wait();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.transport(this.endpoint, { method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Shopid: this.shopId, Token: this.token,
            channelid: String(channel.id), Culture: channel.culture, Country: channel.country, Currency: channel.currency },
          body: JSON.stringify({ query, variables }) });
        if (!response.ok) {
          const error = new Error(`Norce StoreAPI HTTP ${response.status}`);
          error.retryable = [429, 502, 503, 504].includes(response.status);
          error.status = response.status;
          error.waitMs = response.status === 429 ? retryAfter(response.headers?.get?.('Retry-After')) : 0;
          throw error;
        }
        const payload = await response.json();
        if (payload.errors?.length) {
          const detail = payload.errors.map(item => {
            const parts = [item.message, item.extensions?.code, item.extensions?.errorCode, item.path?.join('.')]
              .filter(Boolean);
            return parts.length ? parts.join(' / ') : JSON.stringify(item);
          }).join(' | ');
          const error = new Error(detail || 'Norce StoreAPI returned GraphQL errors without details');
          error.code = payload.errors.length === 1
            ? (payload.errors[0].extensions?.code || payload.errors[0].extensions?.errorCode || payload.errors[0].message)
            : undefined;
          error.retryable = false;
          throw error;
        }
        return payload.data || {};
      } catch (error) {
        const retryable = error.retryable === true || error.name === 'AbortError' || error instanceof TypeError;
        if (!retryable || attempt >= this.retries) throw error;
        const waitMs = error.waitMs || Math.min(30000, 500 * 2 ** attempt + Math.random() * 500);
        this.limiter.slow(error.status === 429 ? Math.max(2000, waitMs) : waitMs);
        await sleep(waitMs);
      } finally { clearTimeout(timer); }
    }
  }
  async type(name) {
    if (!this.typeCache.has(name)) {
      const data = await this.query('query InspectType($name: String!) { __type(name: $name) { fields { name args { name type { kind name ofType { kind name } } } type { kind name ofType { kind name ofType { kind name } } } } } }', { name });
      this.typeCache.set(name, data.__type?.fields || []);
    }
    return this.typeCache.get(name);
  }
  namedType(type) {
    let current = type;
    while (current?.ofType) current = current.ofType;
    return current?.name || '';
  }
  async selectionFor(typeName, depth = 2, visited = new Set()) {
    if (!typeName || visited.has(typeName)) return '__typename';
    const nextVisited = new Set([...visited, typeName]);
    const selection = ['__typename'];
    for (const field of await this.type(typeName)) {
      if (field.args?.some(arg => arg.type.kind === 'NON_NULL')) continue;
      const type = field.type.kind === 'NON_NULL' ? field.type.ofType : field.type;
      const inner = type?.kind === 'LIST' ? type.ofType : type;
      if (['SCALAR', 'ENUM'].includes(inner?.kind)) selection.push(field.name);
      else if (depth > 0) {
        const name = this.namedType(type);
        if (name && name !== typeName) selection.push(`${field.name} { ${await this.selectionFor(name, depth - 1, nextVisited)} }`);
      }
    }
    return selection.join(' ');
  }
  async productGroup(articleNumber, channel, group) {
    if (group === 'basic') {
      const fields = await this.type('Product');
      const available = new Set(fields.filter(field => {
        const type = field.type.kind === 'NON_NULL' ? field.type.ofType : field.type;
        return ['SCALAR', 'ENUM'].includes(type?.kind);
      }).map(field => field.name));
      const selection = ['id', 'articleNumber', 'name', 'shortDescription', 'description', 'barcode', 'subName', 'mainHeader', 'publishedDate', 'url']
        .filter(field => available.has(field));
      if (!selection.includes('id')) throw new Error('Product schema lacks id');
      const data = await this.query(`query GetProduct($articleNumber: String) { product(articleNumber: $articleNumber) { ${selection.join(' ')} } }`, { articleNumber }, channel);
      return data.product ?? null;
    }
    if (group === 'attributes') {
      const fields = await this.type('Product');
      if (!fields.some(field => field.name === 'customFields')) return undefined;
      const multiFields = await this.type('CustomMultiLevelListField');
      const itemsField = multiFields.find(field => field.name === 'items');
      const itemType = this.namedType(itemsField?.type);
      const itemSelection = itemType ? await this.selectionFor(itemType, 3) : '__typename';
      const selection = `customFields { __typename key title type ... on CustomStringField { value } ... on CustomBoolField { value } ... on CustomHtmlField { value } ... on CustomListField { value } ... on CustomMultiLevelListField { items { ${itemSelection} } } }`;
      const data = await this.query(`query GetProductAttributes($articleNumber: String) { product(articleNumber: $articleNumber) { id articleNumber ${selection} } }`, { articleNumber }, channel);
      return data.product ?? null;
    }
    const fields = await this.type('Product');
    const names = {
      images: ['images', 'primaryImage'], variants: ['variants', 'variantOptions'],
      relationships: ['categories', 'canonicalCategory', 'relatedProducts', 'family', 'primaryRoute', 'seoTitle', 'seoDescription', 'metaTitle', 'metaDescription'],
    }[group] || [];
    const selections = [];
    for (const name of names) {
      const field = fields.find(item => item.name === name);
      if (!field || field.args?.some(arg => arg.type.kind === 'NON_NULL')) continue;
      const kind = field.type.kind === 'LIST' ? field.type.ofType : field.type;
      const typeName = this.namedType(field.type);
      if (['SCALAR', 'ENUM'].includes(kind.kind)) selections.push(name);
      else if (typeName) {
        const sub = (await this.type(typeName)).filter(item => !item.args?.some(arg => arg.type.kind === 'NON_NULL') && ['SCALAR', 'ENUM'].includes(item.type.kind === 'NON_NULL' ? item.type.ofType?.kind : item.type.kind))
          .map(item => item.name).filter(item => !item.startsWith('__'));
        if (sub.length) selections.push(`${name} { ${sub.join(' ')} }`);
      }
    }
    if (!selections.length) return undefined;
    const data = await this.query(`query GetProductGroup($articleNumber: String) { product(articleNumber: $articleNumber) { id articleNumber ${selections.join(' ')} } }`, { articleNumber }, channel);
    return data.product ?? null;
  }
  async category(categoryId, channel) {
    const query = `query GetCategory($id: ID!) { category(id: $id) { id parentId name mainHeader content primaryRoute { path } images { url width height } data { id name tags items { name type properties { name type valueType value { __typename ... on StringValue { value } ... on BoolValue { value } } } children { name type properties { name type valueType value { __typename ... on StringValue { value } ... on BoolValue { value } } } children { name type properties { name type valueType value { __typename ... on StringValue { value } ... on BoolValue { value } } } } } } } } }`;
    const data = await this.query(query, { id: String(categoryId) }, channel);
    return data.category ?? null;
  }
}

module.exports = { NorceExtractionClient, RateLimiter, globalLimiter };
