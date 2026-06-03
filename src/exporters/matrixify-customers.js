/**
 * Matrixify Customers Exporter
 * Exports normalized customers to Matrixify Excel format
 */

const { CUSTOMER_COLUMNS } = require('../config/matrixify');

/**
 * Export customers to Matrixify format
 * @param {Array} customers - Array of normalized customers
 * @returns {Array} Array of Matrixify customer rows
 */
function exportCustomers(customers) {
    const rows = [];
    let skipped = 0;

    for (const customer of customers) {
        try {
            const row = buildCustomerRow(customer);
            if (row) {
                rows.push(row);
            } else {
                skipped++;
            }
        } catch (error) {
            console.warn(`Error exporting customer ${customer.vendreId}: ${error.message}`);
            skipped++;
        }
    }

    console.log(`Exported ${rows.length} customers, skipped ${skipped}`);
    return rows;
}

/**
 * Build a single Matrixify customer row
 * @param {Object} customer - Normalized customer
 * @returns {Object|null} Matrixify row or null if should skip
 */
function buildCustomerRow(customer) {
    // Skip customers without email
    if (!customer.email) {
        return null;
    }

    const C = CUSTOMER_COLUMNS;
    const addr = customer.address;

    return {
        [C.EMAIL]: customer.email,
        [C.FIRST_NAME]: customer.firstName,
        [C.LAST_NAME]: customer.lastName,
        [C.PHONE]: customer.phone,
        [C.COMPANY]: customer.company,
        [C.ADDRESS1]: addr.address1,
        [C.ADDRESS2]: addr.address2,
        [C.CITY]: addr.city,
        [C.PROVINCE]: addr.province,
        [C.PROVINCE_CODE]: addr.provinceCode,
        [C.COUNTRY]: addr.country,
        [C.COUNTRY_CODE]: addr.countryCode,
        [C.ZIP]: addr.zip,
        [C.TAGS]: customer.tags.join(', '),
        [C.NOTE]: customer.note,
        [C.TAX_EXEMPT]: customer.taxExempt ? 'TRUE' : 'FALSE',
        [C.ACCEPTS_MARKETING]: customer.acceptsMarketing ? 'TRUE' : 'FALSE',
    };
}

/**
 * Export customers without phone numbers
 * @param {Array} customers - Array of normalized customers
 * @returns {Array} Array of Matrixify customer rows for customers without phones
 */
function exportCustomersWithoutPhone(customers) {
    const customersNoPhone = customers.filter(c => !c.phone || c.phone.trim() === '');
    return exportCustomers(customersNoPhone);
}

module.exports = {
    exportCustomers,
    exportCustomersWithoutPhone,
};
