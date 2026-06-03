require('dotenv').config();
const axios = require('axios');
const xlsx = require('xlsx');
const path = require('path');

const BASE_URL = 'https://dragonslair.se/API/1/customers';
const PAGE_SIZE = 250;
const OUTPUT_PATH = path.join(__dirname, '..', 'results', 'customers-matrixify.xlsx');

/**
 * Format a phone number for Shopify.
 * Swedish numbers starting with 0 get the leading 0 replaced with +46.
 * Numbers already starting with + are used as-is.
 * Anything else is returned unchanged.
 */
function formatPhone(phone) {
    if (!phone) return '';
    const trimmed = phone.trim();
    if (trimmed.startsWith('+')) return trimmed;
    if (trimmed.startsWith('0')) return '+46' + trimmed.slice(1);
    return trimmed;
}

/**
 * Build a comma-separated Shopify tags string for a customer.
 */
function buildTags(customer) {
    const tags = ['vendre-import'];
    if (customer.group_name) tags.push(customer.group_name);
    if (!customer.status) tags.push('inactive');
    return tags.join(', ');
}

async function fetchAllCustomers() {
    const all = [];
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
        all.push(...data.list);
        remaining = data.remaining;
        offset += PAGE_SIZE;

        console.log(`Fetched ${all.length} customers, ${remaining} remaining...`);
    }

    return all;
}

async function main() {
    const customers = await fetchAllCustomers();

    const rows = [];
    let skipped = 0;

    for (const c of customers) {
        // Skip test accounts
        if (c.test) {
            skipped++;
            continue;
        }

        const phone = formatPhone(c.phone_mobile || c.phone_default || '');
        const taxExempt = typeof c.vat === 'string' && c.vat.trim() !== '' ? 'TRUE' : 'FALSE';
        const emailMarketingStatus = c.newsletter ? 'subscribed' : 'not_subscribed';

        rows.push({
            'Command': 'MERGE',
            'First Name': c.name_first || '',
            'Last Name': c.name_last || '',
            'Email': c.email_address || '',
            'Phone': phone,
            'Company': c.company || '',
            'Language': c.language_code || '',
            'Tax Exempt': taxExempt,
            'Tags': buildTags(c),
            'Email Marketing: Status': emailMarketingStatus,
            'Address Line 1': c.address_street || '',
            'Address Line 2': c.address_street2 || '',
            'Address City': c.address_city || '',
            'Address Zip': c.address_postcode || '',
            'Address Country Code': c.address_country_code_alpha2 || '',
            'Address Is Default': 'TRUE',
            'Address Phone': phone,
        });
    }

    console.log(`Transformed ${rows.length} customers (${skipped} test accounts skipped).`);

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(rows);
    xlsx.utils.book_append_sheet(wb, ws, 'Customers');
    xlsx.writeFile(wb, OUTPUT_PATH);

    console.log(`Saved to ${OUTPUT_PATH}`);
}

main().catch((err) => {
    if (err.response) {
        console.error(`HTTP ${err.response.status}:`, JSON.stringify(err.response.data, null, 2));
    } else {
        console.error(err.message);
    }
    process.exit(1);
});
