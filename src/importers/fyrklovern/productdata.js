/**
 * Fyrklövern product-data import adapter.
 *
 * Fyrklövern exports a flat workbook instead of the Vendre API response used
 * by the other stores. This module adapts the Swedish product-data sheet to
 * the raw product shape expected by the shared product exporter.
 */

const XLSX = require('xlsx');

const PRODUCTDATA_SHEET = 'productdata (standard sv-SE)';
const DYNAMICFIELDS_SHEET = 'dynamicfields';
const SOURCE_CULTURE = 'sv-SE';

function cleanValue(value) {
    if (value == null || value === 'NULL') return '';
    return String(value).trim();
}

function parseDelimitedList(value) {
    return cleanValue(value)
        .split(';')
        .map(item => item.trim())
        .filter(Boolean);
}

function parsePrice(value) {
    const parsed = Number(cleanValue(value).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
}

function getDiscountedPrice(value, regularPrice) {
    const discountedPrice = parsePrice(value);
    return discountedPrice > 0 && discountedPrice < regularPrice
        ? discountedPrice
        : null;
}

function getImages(imageUrls, productName) {
    return parseDelimitedList(imageUrls).map(url => ({
        url: { full: url },
        alt_text: productName,
    }));
}

/**
 * Build the canonical image list for each article number from Fyrklövern's
 * image-order workbook. Rows are explicitly ordered by SortOrder rather than
 * relying on their order in the spreadsheet.
 */
function buildImagesByArticleNumber(rows) {
    const imagesByArticleNumber = {};

    for (const row of rows) {
        const articleNumber = cleanValue(row.ArticleNumber);
        const imageUrl = cleanValue(row.ImageURL);
        const sortOrder = Number(cleanValue(row.SortOrder));
        if (!articleNumber || !imageUrl || !Number.isInteger(sortOrder) || sortOrder < 1) {
            continue;
        }

        if (!imagesByArticleNumber[articleNumber]) {
            imagesByArticleNumber[articleNumber] = [];
        }
        imagesByArticleNumber[articleNumber].push({ imageUrl, sortOrder });
    }

    return Object.fromEntries(
        Object.entries(imagesByArticleNumber).map(([articleNumber, images]) => {
            const orderedImages = images
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map(({ imageUrl }) => ({ url: { full: imageUrl } }));
            return [articleNumber, orderedImages];
        })
    );
}

function toMetafieldKey(itemName) {
    return cleanValue(itemName)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * Return the final, Shopify-compatible path segment of a source permalink.
 */
function permalinkToHandle(permalink) {
    const path = cleanValue(permalink).replace(/\/+$/, '');
    return path ? path.split('/').pop() : '';
}

/**
 * Build a ProductID to Swedish handle lookup from the product permalink export.
 * Products appear once for every assigned category, so identical final path
 * segments are deliberately collapsed to a single handle.
 */
function buildHandleByProductId(rows) {
    const handlesByProductId = new Map();

    for (const row of rows) {
        if (cleanValue(row.Culture) !== SOURCE_CULTURE) continue;

        const productId = cleanValue(row.ProductID);
        const handle = permalinkToHandle(row.Permalink);
        if (!productId || !handle) continue;

        if (!handlesByProductId.has(productId)) {
            handlesByProductId.set(productId, new Set());
        }
        handlesByProductId.get(productId).add(handle);
    }

    const ambiguousProducts = [...handlesByProductId.entries()]
        .filter(([, handles]) => handles.size > 1)
        .map(([productId, handles]) =>
            `${productId} (${[...handles].join(', ')})`
        );

    if (ambiguousProducts.length > 0) {
        throw new Error(
            `Multiple sv-SE product handles found for: ${ambiguousProducts.join('; ')}`
        );
    }

    return Object.fromEntries(
        [...handlesByProductId.entries()].map(([productId, handles]) => [
            productId,
            [...handles][0],
        ])
    );
}

/**
 * Build product specifications from the Swedish dynamic-fields export.
 * A product can have more than one value for an ItemName; those are retained
 * as an array so the Matrixify exporter can write a list metafield.
 */
function buildDynamicFieldsByProductId(rows) {
    const fieldsByProductId = {};

    for (const row of rows) {
        if (cleanValue(row.Culture) !== SOURCE_CULTURE) continue;

        const productId = cleanValue(row.ProductID);
        const key = toMetafieldKey(row.ItemName);
        const value = cleanValue(row.Value);
        if (!productId || !key || !value) continue;

        if (!fieldsByProductId[productId]) fieldsByProductId[productId] = {};
        if (!fieldsByProductId[productId][key]) fieldsByProductId[productId][key] = [];

        const values = fieldsByProductId[productId][key];
        if (!values.includes(value)) values.push(value);
    }

    // A Shopify metafield key has one definition. If an ItemName has multiple
    // values on any product, keep that ItemName as a list metafield for every
    // product to avoid emitting conflicting scalar/list definitions.
    const listFieldKeys = new Set();
    for (const fields of Object.values(fieldsByProductId)) {
        for (const [key, values] of Object.entries(fields)) {
            if (values.length > 1) listFieldKeys.add(key);
        }
    }

    return Object.fromEntries(
        Object.entries(fieldsByProductId).map(([productId, fields]) => [
            productId,
            Object.fromEntries(
                Object.entries(fields).map(([key, values]) => [
                    key,
                    listFieldKeys.has(key) ? values : values[0],
                ])
            ),
        ])
    );
}

/**
 * Adapt a single `productdata (standard sv-SE)` row to the common raw shape.
 * ArticleNumber is intentionally duplicated as `article_number` and
 * `external_id`: the former is the explicit source field and the latter keeps
 * it compatible with shared legacy utilities.
 */
function adaptProduct(
    row,
    dynamicFieldsByProductId = {},
    handleByProductId = {},
    imagesByArticleNumber = {}
) {
    const productName = cleanValue(row.ProductName);
    const price = parsePrice(row.PriceExVat);
    const articleNumber = cleanValue(row.ArticleNumber);
    const categoryNames = parseDelimitedList(row.CategoryNames);

    return {
        id: cleanValue(row.ProductID),
        handle: handleByProductId[cleanValue(row.ProductID)] || '',
        article_number: articleNumber,
        external_id: articleNumber,
        name: { sv: productName },
        description: { sv: cleanValue(row.Description) },
        description_short: { sv: cleanValue(row.ShortDescription) },
        meta_title: { sv: cleanValue(row.PageTitle) },
        meta_description: { sv: cleanValue(row.MetaDescription) },
        manufacturer_name: cleanValue(row.Manufacturer),
        brand_name: cleanValue(row.SubName) || cleanValue(row.Manufacturer),
        price,
        price_special: getDiscountedPrice(row.DiscountedPriceExVat, price),
        tax_class_id: 2,
        stock_status: cleanValue(row.StockStatusData),
        quantity: 0,
        category_ids: parseDelimitedList(row.CategoryIDs),
        category_paths: categoryNames,
        images: (imagesByArticleNumber[articleNumber] || getImages(row.ImageURLs, productName))
            .map(image => ({ ...image, alt_text: productName })),
        specifications: {
            metafields: dynamicFieldsByProductId[cleanValue(row.ProductID)] || {},
        },
        status: true,
        show: true,
        extra: {
            fyrklovern: {
                priceListId: cleanValue(row.PriceListID),
                stockStatusCode: cleanValue(row['BC Stock Status Code']),
                itemFamilyCode: cleanValue(row['Item Family Code']),
                itemFamilyDescription: cleanValue(row['Item Family Description']),
                attributeArticleNumber: cleanValue(row.AttributeArticleNumber),
                attributeName: cleanValue(row.AttributeName),
                attributeValue: cleanValue(row.AttributeValue),
                metaKeywords: cleanValue(row.MetaKeywords),
            },
        },
    };
}

/**
 * Read and adapt Fyrklövern's Swedish product-data worksheet.
 * @param {string} inputPath Path to `fyrklovern_custom_export.xlsx`
 * @returns {Array<Object>} Products in the shared raw staging shape
 */
function readProductdata(inputPath, productPermalinkPath, imageOrderPath) {
    const workbook = XLSX.readFile(inputPath, { raw: false });
    const worksheet = workbook.Sheets[PRODUCTDATA_SHEET];
    const dynamicFieldsWorksheet = workbook.Sheets[DYNAMICFIELDS_SHEET];

    if (!worksheet) {
        throw new Error(
            `Worksheet "${PRODUCTDATA_SHEET}" was not found. ` +
            `Available sheets: ${workbook.SheetNames.join(', ')}`
        );
    }

    const rows = XLSX.utils.sheet_to_json(worksheet, {
        defval: '',
        raw: false,
    });
    const dynamicRows = dynamicFieldsWorksheet
        ? XLSX.utils.sheet_to_json(dynamicFieldsWorksheet, { defval: '', raw: false })
        : [];
    const dynamicFieldsByProductId = buildDynamicFieldsByProductId(dynamicRows);
    const productPermalinkRows = productPermalinkPath
        ? XLSX.utils.sheet_to_json(XLSX.readFile(productPermalinkPath, { raw: false }).Sheets.Sheet1, {
            defval: '',
            raw: false,
        })
        : [];
    const handleByProductId = buildHandleByProductId(productPermalinkRows);
    const imageOrderRows = imageOrderPath
        ? XLSX.utils.sheet_to_json(XLSX.readFile(imageOrderPath, { raw: false }).Sheets.Sheet1, {
            defval: '',
            raw: false,
        })
        : [];
    const imagesByArticleNumber = buildImagesByArticleNumber(imageOrderRows);

    return rows
        .filter(row => cleanValue(row.ProductID) && cleanValue(row.ArticleNumber))
        .map(row => adaptProduct(
            row,
            dynamicFieldsByProductId,
            handleByProductId,
            imagesByArticleNumber
        ));
}

module.exports = {
    PRODUCTDATA_SHEET,
    DYNAMICFIELDS_SHEET,
    SOURCE_CULTURE,
    adaptProduct,
    buildImagesByArticleNumber,
    buildHandleByProductId,
    buildDynamicFieldsByProductId,
    permalinkToHandle,
    readProductdata,
    toMetafieldKey,
};
