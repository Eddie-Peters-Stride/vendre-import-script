const XLSX = require('xlsx');

const FIELD = 'Metafield: custom.recommended_products [list.product_reference]';
const LIVE_FIELD = 'Recommended products (product.metafields.custom.recommended_products)';
const clean = value => String(value ?? '').trim();
const cleanSku = value => clean(value).replace(/^'(?=\d+$)/, '');
const currentHandles = value => clean(value).split(/[;,]/).map(clean).filter(Boolean);

function readRows(file, sheetName) {
    const book = XLSX.readFile(file);
    const sheet = book.Sheets[sheetName] || (file.toLowerCase().endsWith('.csv') ? book.Sheets[book.SheetNames[0]] : null);
    if (!sheet) throw new Error(`${file} has no ${sheetName} sheet.`);
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

function buildRecommendedProducts(relationRows, liveRows) {
    const errors = [];
    const byArticle = new Map();
    const byHandle = new Map();
    const bySku = new Map();
    for (const row of liveRows) {
        const handle = clean(row.Handle);
        if (!handle) continue;
        const article = cleanSku(row['External ID (product.metafields.custom.external_id)'] ||
            row['Metafield: custom.external_id [single_line_text_field]']);
        const sku = cleanSku(row['Variant SKU']);
        if (!byHandle.has(handle)) byHandle.set(handle, { handle, articles: new Set(), skus: new Set(), current: [] });
        const product = byHandle.get(handle);
        if (article) product.articles.add(article);
        if (sku) product.skus.add(sku);
        const present = currentHandles(row[LIVE_FIELD] || row[FIELD]);
        if (present.length) {
            if (product.current.length && JSON.stringify(product.current) !== JSON.stringify(present)) {
                errors.push(`Conflicting current recommendations for live handle ${handle}`);
            }
            product.current = present;
        }
    }
    for (const product of byHandle.values()) {
        if (!product.skus.size) errors.push(`No Variant SKU for live handle ${product.handle}`);
        for (const article of product.articles) {
            if (byArticle.has(article) && byArticle.get(article) !== product) errors.push(`Article ${article} belongs to multiple live products`);
            else byArticle.set(article, product);
        }
        for (const sku of product.skus) {
            if (bySku.has(sku) && bySku.get(sku) !== product) errors.push(`Variant SKU ${sku} belongs to multiple live products`);
            else bySku.set(sku, product);
        }
    }
    if (!byArticle.size) errors.push('Live product export has no custom.external_id values.');

    const relationsByOwner = new Map();
    for (const [index, row] of relationRows.entries()) {
        const owner = cleanSku(row['Huvudprodukt Artikelnummer']);
        const targets = clean(row['Kopplad produkt Artikelnummer']).split(';').map(cleanSku).filter(Boolean);
        const order = Number(clean(row.SortOrder));
        if (!owner || !targets.length) continue;
        if (!Number.isFinite(order)) errors.push(`Invalid SortOrder for relation row ${index + 2}`);
        if (!relationsByOwner.has(owner)) relationsByOwner.set(owner, []);
        for (const target of targets) relationsByOwner.get(owner).push({ target, order, index });
    }
    if (!relationsByOwner.size) errors.push('Norce recommendation source has no product relations.');

    const rows = [];
    const review = [];
    for (const [article, relations] of relationsByOwner) {
        const owner = byArticle.get(article);
        if (!owner) {
            review.push({ article, status: 'owner absent from live Shopify export' });
            continue;
        }
        const ordered = relations.sort((a, b) => a.order - b.order || a.index - b.index);
        const targetArticles = [...new Set(ordered.map(item => item.target).filter(target => target !== article))];
        const handles = [];
        const unresolvedArticles = [];
        for (const target of targetArticles) {
            const live = byArticle.get(target);
            if (!live) unresolvedArticles.push(target);
            else if (live.handle !== owner.handle && !handles.includes(live.handle)) handles.push(live.handle);
        }
        const current = owner.current;
        const changed = JSON.stringify(handles) !== JSON.stringify(current);
        const status = !handles.length ? 'no linked products in live Shopify export'
            : changed ? 'update' : 'already current';
        review.push({ article, handle: owner.handle, status, sourceTargetCount: targetArticles.length,
            resolvedTargetCount: handles.length, unresolvedArticles, currentHandles: current,
            recommendedHandles: handles });
        if (status === 'update') rows.push({
            Handle: owner.handle,
            'Variant SKU [ID]': [...owner.skus][0],
            Command: 'UPDATE',
            [FIELD]: handles.join('; '),
        });
    }
    rows.sort((a, b) => a.Handle.localeCompare(b.Handle));
    return { rows, review, errors, liveProductCount: byHandle.size, sourceOwnerCount: relationsByOwner.size };
}

module.exports = { FIELD, LIVE_FIELD, readRows, buildRecommendedProducts };
