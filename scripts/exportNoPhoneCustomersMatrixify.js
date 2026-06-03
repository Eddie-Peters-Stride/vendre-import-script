/**
 * Reads "Customers - no phone numbers.xlsx", which contains customers whose
 * phone numbers could not be imported into Shopify's Phone field (e.g. invalid
 * format). The phone number is stored in the Note column of the source file.
 *
 * This script produces a Matrixify-compatible import XLSX where:
 *  - The Phone field is left empty (by design – these customers have no valid phone)
 *  - The Note field contains "Phone: <number>" so staff can see the number in Shopify
 *
 * Output: results/customers-no-phone-matrixify.xlsx
 */

const xlsx = require('xlsx');
const path = require('path');

const INPUT_PATH = path.join(__dirname, '..', 'Customers - no phone numbers.xlsx');
const OUTPUT_PATH = path.join(__dirname, '..', 'results', 'customers-no-phone-matrixify.xlsx');

function main() {
    const wb = xlsx.readFile(INPUT_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sourceRows = xlsx.utils.sheet_to_json(ws, { defval: null });

    const rows = [];

    for (const r of sourceRows) {
        const rawPhone = r['Note'] ? String(r['Note']).trim() : '';
        const note = rawPhone ? `Phone: ${rawPhone}` : '';

        rows.push({
            'Command': r['Command'] || 'MERGE',
            'First Name': r['First Name'] || '',
            'Last Name': r['Last Name'] || '',
            'Email': r['Email'] || '',
            'Phone': '',           // intentionally blank
            'Company': r['Company'] || '',
            'Language': r['Language'] || '',
            'Tax Exempt': r['Tax Exempt'] || 'FALSE',
            'Tags': r['Tags'] || '',
            'Email Marketing: Status': r['Email Marketing: Status'] || '',
            'Note': note,
            'Address Line 1': r['Address Line 1'] || '',
            'Address Line 2': r['Address Line 2'] || '',
            'Address City': r['Address City'] || '',
            'Address Zip': r['Address Zip'] || '',
            'Address Country Code': r['Address Country Code'] || '',
            'Address Is Default': r['Address Is Default'] || 'TRUE',
        });
    }

    const outWb = xlsx.utils.book_new();
    const outWs = xlsx.utils.json_to_sheet(rows);
    xlsx.utils.book_append_sheet(outWb, outWs, 'Customers');
    xlsx.writeFile(outWb, OUTPUT_PATH);

    console.log(`Processed ${rows.length} customers.`);
    console.log(`Saved to ${OUTPUT_PATH}`);
}

main();
