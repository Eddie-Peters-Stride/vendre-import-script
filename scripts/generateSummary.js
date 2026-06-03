const fs = require('fs');
const path = require('path');

const productsPath = path.join(__dirname, '../results/products.json');
const outputPath = path.join(__dirname, '../results/summary.json');

let productCount = 0;
const segmentMap = {};

function addSegmentsFromSeoLink(seoLink) {
    if (!seoLink) return;
    let pathStr = seoLink.sv || seoLink.en;
    if (!pathStr) return;
    pathStr = pathStr.replace(/^\/+|\/+$/g, '');
    if (!pathStr) return;
    const segments = pathStr.split('/');
    for (const segment of segments) {
        if (!segment) continue;
        if (!segmentMap[segment]) segmentMap[segment] = 0;
        segmentMap[segment]++;
    }
}

// Read the file in chunks and parse only the list array
function processProducts() {
    let json = '';
    const stream = fs.createReadStream(productsPath, { encoding: 'utf8' });
    stream.on('data', chunk => {
        json += chunk;
    });
    stream.on('end', () => {
        let products;
        try {
            const parsed = JSON.parse(json);
            products = parsed.list;
        } catch (e) {
            console.error('Failed to parse products.json:', e);
            return;
        }
        if (!Array.isArray(products)) {
            console.error('No product list found in products.json');
            return;
        }
        for (const product of products) {
            productCount++;
            if (product.seo_link) {
                addSegmentsFromSeoLink(product.seo_link);
            }
        }
        const summary = {
            total_collections: Object.keys(segmentMap).length,
            total_products: productCount,
            products_per_collection: Object.entries(segmentMap).map(([segment, count]) => ({
                segment,
                product_count: count
            }))
        };
        fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf8');
        console.log('Summary written to', outputPath);
    });
    stream.on('error', err => {
        console.error('Error reading products.json:', err);
    });
}

processProducts();
