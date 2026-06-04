/**
 * Customer transformer
 * Converts Vendre customer data to normalized format
 */

/**
 * Transform a Vendre customer to normalized format
 * @param {Object} customer - Raw Vendre customer
 * @param {Object} config - Store configuration
 * @returns {Object} Normalized customer
 */
function transformCustomer(customer, config) {
    return {
        // Identity
        vendreId: customer.id,
        email: customer.email || customer.email_address || '',

        // Name
        firstName: customer.first_name || customer.name_first || '',
        lastName: customer.last_name || customer.name_last || '',

        // Contact
        phone: formatPhone(customer.phone || customer.phone_default || customer.phone_mobile, config),
        company: customer.company || '',

        // Address
        address: extractAddress(customer),

        // Organization
        tags: buildCustomerTags(customer, config),
        group: customer.group_name || '',

        // Status
        isActive: customer.status === true || customer.status === 1,
        acceptsMarketing: customer.accepts_marketing === true || customer.accepts_marketing === 1 || customer.newsletter === true || customer.newsletter === 1,
        taxExempt: customer.tax_exempt === true || customer.tax_exempt === 1,

        // Notes
        note: customer.note || '',

        // Raw data
        _raw: customer,
    };
}

/**
 * Format phone number according to store configuration
 * @param {string} phone - Raw phone number
 * @param {Object} config - Store configuration
 * @returns {string} Formatted phone number
 */
function formatPhone(phone, config) {
    if (!phone) return '';

    const trimmed = phone.trim();
    const phoneConfig = config.phoneFormat || {};

    // Already has country code
    if (trimmed.startsWith('+')) return trimmed;

    // Add country code if configured and number starts with 0
    if (phoneConfig.removeLeadingZero && trimmed.startsWith('0')) {
        return (phoneConfig.countryCode || '+46') + trimmed.slice(1);
    }

    return trimmed;
}

/**
 * Extract address from Vendre customer
 * @param {Object} customer - Vendre customer
 * @returns {Object} Address object
 */
function extractAddress(customer) {
    return {
        address1: customer.address1 || customer.street || customer.address_street || '',
        address2: customer.address2 || customer.address_street2 || '',
        city: customer.city || customer.address_city || '',
        province: customer.province || customer.state || '',
        provinceCode: customer.province_code || '',
        country: customer.country || 'Sweden',
        countryCode: customer.country_code || customer.address_country_code_alpha2 || 'SE',
        zip: customer.zip || customer.postal_code || customer.postcode || customer.address_postcode || '',
    };
}

/**
 * Build tags for customer
 * @param {Object} customer - Vendre customer
 * @param {Object} config - Store configuration
 * @returns {Array<string>} Array of tags
 */
function buildCustomerTags(customer, config) {
    const tags = [];
    const customerConfig = config.customerTags || {};

    // Add import tag
    if (customerConfig.importTag) {
        tags.push(customerConfig.importTag);
    }

    // Add group name if exists
    if (customer.group_name) {
        tags.push(customer.group_name);
    }

    // Add inactive tag if not active
    if (!customer.status && customerConfig.inactiveTag) {
        tags.push(customerConfig.inactiveTag);
    }

    return tags;
}

/**
 * Validate customer data
 * @param {Object} customer - Normalized customer
 * @returns {Object} { valid: boolean, errors: Array<string> }
 */
function validateCustomer(customer) {
    const errors = [];

    if (!customer.email) {
        errors.push(`Customer ${customer.vendreId}: Missing email`);
    }

    if (!customer.firstName && !customer.lastName) {
        errors.push(`Customer ${customer.vendreId}: Missing name`);
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

/**
 * Filter customers without phone numbers
 * @param {Array} customers - Array of normalized customers
 * @returns {Array} Customers without phone numbers
 */
function filterCustomersWithoutPhone(customers) {
    return customers.filter(c => !c.phone || c.phone.trim() === '');
}

module.exports = {
    transformCustomer,
    formatPhone,
    buildCustomerTags,
    validateCustomer,
    filterCustomersWithoutPhone,
};
