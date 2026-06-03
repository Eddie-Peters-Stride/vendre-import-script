const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const productsPath = path.join(__dirname, '../results/products.json');
const outputPath = path.join(__dirname, '../results/vendor-update.xlsx');

const productsRaw = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
const products = Array.isArray(productsRaw)
    ? productsRaw
    : (Array.isArray(productsRaw.list) ? productsRaw.list : []);

function getHandle(product) {
    const seoLink = (product.seo_link && (product.seo_link.sv || product.seo_link.en)) || '';
    if (seoLink) {
        const parts = seoLink.replace(/\/+$/, '').split('/');
        const slug = parts[parts.length - 1];
        if (slug) return slug;
    }
    const name = (product.name && (product.name.sv || product.name.en)) || 'product-' + product.id;
    return name
        .toLowerCase()
        .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

const rows = [];
for (const product of products) {
    const handle = getHandle(product);
    if (!handle) continue;
    rows.push({
        Handle: handle,
        Command: 'MERGE',
        Vendor: 'dragonslair-se',
    });
}

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Products');
XLSX.writeFile(wb, outputPath);

console.log(`Vendor update file: ${rows.length} products → ${outputPath}`);
