require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://dragonslair.se/API/1/products';
const PAGE_SIZE = 250;
const OUTPUT_PATH = path.join(__dirname, '..', 'results', 'products.json');

async function fetchAllProducts() {
    const allProducts = [];
    let offset = 0;
    let remaining = 1;

    while (remaining > 0) {
        const response = await axios.get(BASE_URL, {
            params: {
                page_size: PAGE_SIZE,
                offset,
            },
            headers: {
                Accept: 'application/json',
                'X-Authorization': process.env.SECRET_KEY,
            },
        });

        const data = response.data;
        allProducts.push(...data.list);
        remaining = data.remaining;
        offset += PAGE_SIZE;

        console.log(`Fetched ${allProducts.length} products, ${remaining} remaining...`);
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ list: allProducts }, null, 2), 'utf8');
    console.log(`Saved ${allProducts.length} products to products.json`);

    return allProducts;
}

fetchAllProducts().catch((err) => {
    if (err.response) {
        console.error(`HTTP ${err.response.status}:`, JSON.stringify(err.response.data, null, 2));
    } else {
        console.error(err.message);
    }
    process.exit(1);
});
