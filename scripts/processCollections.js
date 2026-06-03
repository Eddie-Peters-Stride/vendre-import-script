require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://dragonslair.se/API/1/categories';
const PAGE_SIZE = 250;
const OUTPUT_PATH = path.join(__dirname, '..', 'results', 'collections.json');

async function fetchAllCategories() {
    const allCategories = [];
    let offset = 0;
    let remaining = 1;

    while (remaining > 0) {
        const response = await axios.get(BASE_URL, {
            params: { page_size: PAGE_SIZE, offset },
            headers: {
                Accept: 'application/json',
                'X-Authorization': process.env.SECRET_KEY,
            },
        });

        const data = response.data;

        // Handle both paginated { list, remaining } and plain array responses
        const items = data.list || (Array.isArray(data) ? data : []);
        allCategories.push(...items);

        remaining = typeof data.remaining === 'number' ? data.remaining : 0;
        offset += PAGE_SIZE;

        console.log(`Fetched ${allCategories.length} categories, ${remaining} remaining...`);
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ list: allCategories }, null, 2), 'utf8');
    console.log(`Saved ${allCategories.length} categories to results/collections.json`);

    return allCategories;
}

fetchAllCategories().catch((err) => {
    if (err.response) {
        console.error(`HTTP ${err.response.status}:`, JSON.stringify(err.response.data, null, 2));
    } else {
        console.error(err.message);
    }
    process.exit(1);
});
