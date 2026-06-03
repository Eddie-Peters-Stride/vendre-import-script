const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

// Tax classes: tax_class_id -> tax rate percentage
const taxClasses = {
    "2": 25,  // Hög - 25%
    "3": 6,   // Låg - 6%
    "4": 12,  // Medel - 12%
    "5": 0    // Extra låg - 0%
};

// Input / output paths
const productsPath = path.join(__dirname, '../results/products.json');
const outputXlsxPath = path.join(__dirname, '../results/matrixify-price-update.xlsx');

// Read products
const productsRaw = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
const products = Array.isArray(productsRaw)
    ? productsRaw
    : (Array.isArray(productsRaw.list) ? productsRaw.list : []);

// Extract Shopify handle from seo_link (last path segment, Swedish preferred)
function getHandle(product) {
    const seoLink =
        (product.seo_link && (product.seo_link.sv || product.seo_link.en)) || '';
    if (seoLink) {
        const parts = seoLink.replace(/\/+$/, '').split('/');
        const slug = parts[parts.length - 1];
        if (slug) return slug;
    }
    const name =
        (product.name && (product.name.sv || product.name.en)) ||
        'product-' + product.id;
    return name
        .toLowerCase()
        .replace(/[åä]/g, 'a')
        .replace(/ö/g, 'o')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

const rows = [];
let skipped = 0;

for (const product of products) {
    // Skip products with no price or no tax class
    if (product.price == null || !product.tax_class_id) {
        skipped++;
        continue;
    }

    const taxRate = taxClasses[String(product.tax_class_id)];
    if (taxRate == null) {
        console.warn(`Unknown tax_class_id ${product.tax_class_id} for product id ${product.id}, skipping.`);
        skipped++;
        continue;
    }

    const priceWithTax = +(product.price * (1 + taxRate / 100)).toFixed(2);
    const handle = getHandle(product);

    const row = {
        'Handle': handle,
        'Variant Price': priceWithTax,
        'Variant Compare At Price': '',
    };

    // Include sale price if present
    if (product.price_special != null && product.price_special > 0) {
        row['Variant Compare At Price'] = priceWithTax;
        const specialWithTax = +(product.price_special * (1 + taxRate / 100)).toFixed(2);
        row['Variant Price'] = specialWithTax;
    }

    rows.push(row);
}

// Write XLSX
const wb = xlsx.utils.book_new();
const ws = xlsx.utils.json_to_sheet(rows);
xlsx.utils.book_append_sheet(wb, ws, 'Products');
xlsx.writeFile(wb, outputXlsxPath);

console.log(`Done. ${rows.length} products written to ${outputXlsxPath}`);
console.log(`Skipped: ${skipped} products (no price or unknown tax class)`);
