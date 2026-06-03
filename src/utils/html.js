/**
 * HTML sanitization utilities for Shopify compatibility
 */

/**
 * Strip all HTML tags and decode common entities
 * @param {string} html - HTML string
 * @returns {string} Plain text
 */
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extract first paragraph from HTML
 * @param {string} html - HTML string
 * @returns {string} Plain text of first paragraph
 */
function extractFirstParagraph(html) {
    if (!html) return '';
    const match = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (match) return stripHtml(match[1]);
    return stripHtml(html).split(/\n/)[0].trim();
}

/**
 * Sanitize HTML for Shopify (remove non-compatible tags, preserve formatting)
 * Shopify supports: p, br, b, i, strong, em, ul, ol, li, h1-h6, a, img
 * @param {string} html - HTML string
 * @returns {string} Sanitized HTML
 */
function sanitizeForShopify(html) {
    if (!html) return '';

    // Remove script and style tags entirely
    let sanitized = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // List of allowed tags (Shopify-compatible)
    const allowedTags = [
        'p', 'br', 'b', 'i', 'strong', 'em', 'u',
        'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'img', 'div', 'span', 'table', 'tr', 'td', 'th',
        'thead', 'tbody', 'blockquote', 'pre', 'code'
    ];

    // Remove non-allowed tags (keep content)
    const tagPattern = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
    sanitized = sanitized.replace(tagPattern, (match, tagName) => {
        if (allowedTags.includes(tagName.toLowerCase())) {
            return match; // Keep allowed tags
        }
        return ''; // Remove disallowed tags
    });

    // Clean up excessive whitespace
    sanitized = sanitized.replace(/\n\s*\n/g, '\n').trim();

    return sanitized;
}

/**
 * Get short description from product, with fallback to first paragraph
 * @param {Object} product - Vendre product
 * @param {string} lang - Language code ('sv' or 'en')
 * @returns {string} Short description
 */
function getShortDesc(product, lang = 'sv') {
    const short = product.description_short && product.description_short[lang];
    if (short && short.trim()) return stripHtml(short);

    // Fallback: first paragraph of description
    const desc = product.description && product.description[lang];
    if (!desc) return '';

    return extractFirstParagraph(desc);
}

module.exports = {
    stripHtml,
    extractFirstParagraph,
    sanitizeForShopify,
    getShortDesc,
};
