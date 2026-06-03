const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const tagsMap = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tags.json"), "utf8"));

// Built after products are loaded
let productHandleMap = {};

function getProductTags(product) {
    const ids = product.tag_ids;
    if (!ids || !Array.isArray(ids)) return "";
    const tagSet = new Set();
    ids.forEach((id) => {
        const full = tagsMap[String(id)];
        if (!full) return;
        const parts = full.split(" » ");
        tagSet.add(parts[parts.length - 1].trim());
    });
    return [...tagSet].join(", ");
}

// Vendre spec field IDs
const SPEC = {
    BGG_ID: 1603,
    YEAR_PUBLISHED: 1604,
    MIN_PLAYERS: 1605,
    MAX_PLAYERS: 1606,
    PLAY_TIME: 1608,
    MIN_AGE: 1609,
    BGG_WEIGHT: 1610,
    BGG_COMPLEXITY: 1611,
    MECHANICS: 1612,
    DESIGNERS: 1613,
    PUBLISHERS: 1614,
};

function getSpec(specifications, id, lang = "sv") {
    if (!specifications || !specifications.text) return "";
    const spec = specifications.text.find((s) => s.id === id);
    if (!spec) return "";
    return (spec.value && spec.value[lang]) || "";
}

// Extract Shopify handle from Vendre seo_link (Swedish preferred)
function getHandle(product) {
    const seoLink =
        (product.seo_link && (product.seo_link.sv || product.seo_link.en)) || "";
    if (seoLink) {
        const parts = seoLink.replace(/\/+$/, "").split("/");
        const slug = parts[parts.length - 1];
        if (slug) return slug;
    }
    // Fallback: slugify the Swedish or English name
    const name =
        (product.name && (product.name.sv || product.name.en)) ||
        "product-" + product.id;
    return name
        .toLowerCase()
        .replace(/[^a-z0-9åäöÅÄÖ]+/g, "-")
        .replace(/^-|-$/g, "");
}

function stripHtml(html) {
    if (!html) return "";
    return html
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
}

function getShortDesc(product, lang) {
    const short = product.description_short && product.description_short[lang];
    if (short && short.trim()) return stripHtml(short);
    // Fallback: first paragraph of description
    const desc = product.description && product.description[lang];
    if (!desc) return "";
    const match = desc.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (match) return stripHtml(match[1]);
    return stripHtml(desc).split(/\n/)[0].trim();
}

// Use leaf category names (last segment after |) as Shopify Custom Collections
function getCustomCollections(product) {
    if (!product.category_paths || product.category_paths.length === 0) return "";
    const leaves = product.category_paths.map((p) => {
        const parts = p.split("|");
        return parts[parts.length - 1].trim();
    });
    // Deduplicate
    return [...new Set(leaves)].join(", ");
}

// Determine Variant Price and Compare At Price from Vendre pricing
function getPricing(product) {
    const price = product.price;
    const priceRek = product.price_rek;
    const priceSpecial = product.price_special;

    // If there is an active special/sale price lower than regular price
    if (priceSpecial && priceSpecial < price) {
        return { variantPrice: priceSpecial, compareAtPrice: price };
    }
    // If recommended retail price is higher than selling price
    if (priceRek && priceRek > price) {
        return { variantPrice: price, compareAtPrice: priceRek };
    }
    return { variantPrice: price, compareAtPrice: "" };
}

function toMatrixifyRow(product) {
    const handle = getHandle(product);
    const title =
        (product.name && (product.name.sv || product.name.en)) || "";
    const bodyHtml =
        (product.description &&
            (product.description.sv || product.description.en)) ||
        "";
    const descShortHtml = getShortDesc(product, "sv");
    const vendor = "dragonslair-se";
    const customCollections = getCustomCollections(product);

    const status = product.status ? "Active" : "Draft";
    const published = (product.show && product.status) ? "TRUE" : "FALSE";

    const imageSrc =
        product.images && product.images.length > 0
            ? product.images.map((img) => img.url.full).join(";")
            : "";
    const imageAlt =
        product.images && product.images.length > 0
            ? product.images[0].description || title
            : "";

    const sku = product.external_id || "";
    const barcode = product.ean1 || "";
    const { variantPrice, compareAtPrice } = getPricing(product);
    const weight = product.weight || "";
    const weightUnit = weight ? "kg" : "";
    const inventoryPolicy = product.stock_allow_checkout ? "continue" : "deny";

    const warehouseSvea = product.warehouses
        ? product.warehouses.find((w) => w.external_id === "svea")
        : null;
    const warehouseKung = product.warehouses
        ? product.warehouses.find((w) => w.external_id === "kung")
        : null;

    const metaTitle =
        (product.meta_title &&
            (product.meta_title.sv || product.meta_title.en)) ||
        "";
    const metaDescription =
        (product.meta_description &&
            (product.meta_description.sv || product.meta_description.en)) ||
        "";

    // Helper to convert multiline to list of single line text
    function toSingleLineList(val) {
        if (!val) return "";
        // Split on semicolons, trim, remove empties, join with comma
        return val
            .split(/;/)
            .map((v) => v.trim())
            .filter(Boolean)
            .join(", ");
    }

    // Helper to extract tag values by prefix
    function getTagsByPrefix(product, prefix) {
        if (!product.tag_ids || !Array.isArray(product.tag_ids)) return [];
        const values = [];
        for (const id of product.tag_ids) {
            const tag = tagsMap[String(id)];
            if (tag && tag.startsWith(prefix)) {
                // Use leaf after last »
                const parts = tag.split(" » ");
                values.push(parts[parts.length - 1].trim());
            }
        }
        return [...new Set(values)];
    }

    // Best player count
    const bestPlayerCount = getTagsByPrefix(product, "Sortera efter Bäst på Antal Spelare");
    // Theme
    const theme = getTagsByPrefix(product, "Sortera efter Teman");
    // Spelmekanik
    const spelmekanik = getTagsByPrefix(product, "Sortera efter Spelmekanik");
    // Storlek
    const storlek = getTagsByPrefix(product, "Sortera efter Storlek");
    // Awards
    const awards = getTagsByPrefix(product, "Spel som vunnit priser");

    // Mechanics and Publishers as list.single_line_text_field
    const mechanicsRaw = getSpec(product.specifications, SPEC.MECHANICS);
    const publishersRaw = getSpec(product.specifications, SPEC.PUBLISHERS);

    return {
        Handle: handle,
        Command: "MERGE",
        Title: title,
        "Body HTML": bodyHtml,
        Vendor: vendor,
        Type: "",
        Tags: getProductTags(product),
        Status: status,
        Published: published,
        "Template Suffix": "",
        "Custom Collections": customCollections,
        "Image Src": imageSrc,
        "Image Alt Text": imageAlt,
        "Image Position": imageSrc ? 1 : "",
        "Variant SKU": sku,
        "Variant Barcode": barcode,
        "Variant Price": variantPrice,
        "Variant Compare At Price": compareAtPrice,
        "Variant Weight": weight,
        "Variant Weight Unit": weightUnit,
        "Variant Inventory Tracker": "shopify",
        "Variant Inventory Policy": inventoryPolicy,
        "Variant Requires Shipping": "TRUE",
        "Variant Taxable": "TRUE",
        "Variant Fulfillment Service": "manual",
        "Inventory Available: Sveavägen 118":
            warehouseSvea != null ? warehouseSvea.quantity : "",
        "Inventory Available: Kungsholmstorg 8":
            warehouseKung != null ? warehouseKung.quantity : "",
        "Metafield: title_tag [string]": metaTitle,
        "Metafield: description_tag [string]": metaDescription,
        "Metafield: custom.description_short [multi_line_text_field]":
            descShortHtml,
        "Metafield: custom.manufacturer_sku [single_line_text_field]":
            product.manufacturer_model || "",
        "Metafield: custom.bgg_id [single_line_text_field]": getSpec(
            product.specifications,
            SPEC.BGG_ID
        ),
        "Metafield: custom.year_published [single_line_text_field]": getSpec(
            product.specifications,
            SPEC.YEAR_PUBLISHED
        ),
        "Metafield: custom.min_players [single_line_text_field]": getSpec(
            product.specifications,
            SPEC.MIN_PLAYERS
        ),
        "Metafield: custom.max_players [single_line_text_field]": getSpec(
            product.specifications,
            SPEC.MAX_PLAYERS
        ),
        "Metafield: custom.play_time_minutes [single_line_text_field]": getSpec(
            product.specifications,
            SPEC.PLAY_TIME
        ),
        "Metafield: custom.min_age [single_line_text_field]": getSpec(
            product.specifications,
            SPEC.MIN_AGE
        ),
        "Metafield: custom.bgg_weight [single_line_text_field]": getSpec(
            product.specifications,
            SPEC.BGG_WEIGHT
        ),
        "Metafield: custom.bgg_complexity [single_line_text_field]": getSpec(
            product.specifications,
            SPEC.BGG_COMPLEXITY
        ),
        // --- UPDATED FIELDS BELOW ---
        "Metafield: custom.mechanics [list.single_line_text_field]": toSingleLineList(mechanicsRaw),
        "Metafield: custom.designers [list.single_line_text_field]": toSingleLineList(getSpec(
            product.specifications,
            SPEC.DESIGNERS
        )),
        "Metafield: custom.publishers [list.single_line_text_field]": toSingleLineList(publishersRaw),
        "Metafield: custom.best_player_count [list.single_line_text_field]": bestPlayerCount.join(", "),
        "Metafield: custom.theme [list.single_line_text_field]": theme.join(", "),
        "Metafield: custom.spelmekanik [list.single_line_text_field]": spelmekanik.join(", "),
        "Metafield: custom.storlek [list.single_line_text_field]": storlek.join(", "),
        "Metafield: custom.awards [list.single_line_text_field]": awards.join(", "),
        "Metafield: custom.related_products [list.product_reference]": (() => {
            if (!product.associated_products || product.associated_products.length === 0) return "";
            return product.associated_products
                .map((ap) => productHandleMap[ap.id])
                .filter(Boolean)
                .join(", ");
        })(),
    };
}

// Build a Translate & Adapt-compatible row for English translations.
// Shopify's Translate & Adapt CSV format:
//   Type, Identification, Field, Locale, Translation
// Build Shopify Translate & Adapt CSV rows with required headers
function toTranslationRows(product, handle) {
    const rows = [];
    // Helper to push a translation row with default and translated content
    const push = (field, defaultValue, translatedValue) => {
        if (defaultValue && defaultValue.trim() && translatedValue && translatedValue.trim()) {
            rows.push({
                Type: "PRODUCT",
                Identification: handle,
                Field: field,
                Locale: "en",
                Market: "",
                Status: "",
                "Default content": defaultValue || "",
                "Translated content": translatedValue,
            });
        }
    };

    push("title", product.name && product.name.sv, product.name && product.name.en);
    push("body_html", product.description && product.description.sv, product.description && product.description.en);
    push("meta_title", product.meta_title && product.meta_title.sv, product.meta_title && product.meta_title.en);
    push("meta_description", product.meta_description && product.meta_description.sv, product.meta_description && product.meta_description.en);
    // Use getShortDesc (with fallback to first paragraph) for both languages so
    // all products get a Swedish metafield via Matrixify and an English translation.
    const shortSv = getShortDesc(product, "sv");
    const shortEn = getShortDesc(product, "en");
    if (shortSv && shortEn) push("metafield.custom.description_short", shortSv, shortEn);
    return rows;
}

// Parse a Shopify export CSV and return rows as objects
function parseShopifyExportCsv(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const lines = [];
    let cur = "", inQ = false;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '"') { inQ = !inQ; cur += c; }
        else if (c === '\n' && !inQ) { lines.push(cur); cur = ""; }
        else { cur += c; }
    }
    if (cur) lines.push(cur);
    const splitLine = (line) => {
        const fields = []; let f = "", q = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') {
                if (q && line[i + 1] === '"') { f += '"'; i++; }
                else q = !q;
            } else if (c === ',' && !q) { fields.push(f); f = ""; }
            else f += c;
        }
        fields.push(f);
        return fields;
    };
    const headers = splitLine(lines[0]);
    return lines.slice(1).filter(l => l.trim()).map(l => {
        const vals = splitLine(l);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = (vals[i] || "").trim(); });
        return obj;
    });
}

// Build SKU → Shopify handle map from exported product CSVs
const skuToShopifyHandle = {};
["products_export_1.csv", "products_export_2.csv"].forEach(fname => {
    const fpath = path.join(__dirname, "..", "results", fname);
    parseShopifyExportCsv(fpath).forEach(row => {
        const handle = row["Handle"];
        const sku = row["Variant SKU"] && row["Variant SKU"].replace(/^'/, "");
        if (handle && sku && !skuToShopifyHandle[sku]) {
            skuToShopifyHandle[sku] = handle;
        }
    });
});
console.log(`Loaded ${Object.keys(skuToShopifyHandle).length} SKU→handle mappings from Shopify export.`);

// Build handle → Shopify numeric product ID from Shopify translation exports
// These files have rows like: PRODUCT,'15554172420444,handle,en,,,my-product-handle,
const handleToShopifyId = {};
["dragonslair-se_translations_May-07-2026_1.csv", "dragonslair-se_translations_May-07-2026_2.csv"].forEach(fname => {
    const fpath = path.join(__dirname, "..", "results", fname);
    parseShopifyExportCsv(fpath).forEach(row => {
        if (row["Field"] === "handle" && row["Identification"] && row["Default content"]) {
            const id = row["Identification"].replace(/^'/, "");
            const handle = row["Default content"].trim();
            if (handle && id && !handleToShopifyId[handle]) {
                handleToShopifyId[handle] = id;
            }
        }
    });
});
console.log(`Loaded ${Object.keys(handleToShopifyId).length} handle→ID mappings from Shopify translation export.`);

// Load JSON
const jsonPath = path.join(__dirname, "..", "results", "products.json");
const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const products = data.list;

console.log(`Processing ${products.length} products...`);

// Build id → handle lookup for related products
products.forEach((p) => { productHandleMap[p.id] = getHandle(p); });

const rows = products.map(toMatrixifyRow);

// Build Translations rows (English)
const translationRows = [];
let skippedTranslations = 0;
products.forEach((product) => {
    const sku = product.external_id || "";
    const shopifyHandle = skuToShopifyHandle[sku];
    if (!shopifyHandle) { skippedTranslations++; return; }
    const shopifyId = handleToShopifyId[shopifyHandle];
    if (!shopifyId) { skippedTranslations++; return; }
    translationRows.push(...toTranslationRows(product, shopifyId));
});
if (skippedTranslations > 0) console.log(`Skipped ${skippedTranslations} products with no matching Shopify ID.`);

// Helper: create sheet with auto column widths
function makeSheet(dataRows) {
    const ws = XLSX.utils.json_to_sheet(dataRows);
    if (dataRows.length > 0) {
        const colWidths = Object.keys(dataRows[0]).map((key) => {
            const maxLen = Math.max(
                key.length,
                ...dataRows.map((r) => {
                    const val = r[key] != null ? String(r[key]) : "";
                    return Math.min(val.length, 80);
                })
            );
            return { wch: maxLen + 2 };
        });
        ws["!cols"] = colWidths;
    }
    return ws;
}

// Create workbook — "Products" sheet for Matrixify
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, makeSheet(rows), "Products");

// "Translations" sheet — Shopify Translate & Adapt CSV-compatible format
if (translationRows.length > 0) {
    XLSX.utils.book_append_sheet(
        wb,
        makeSheet(translationRows),
        "Translations"
    );
    console.log(`Added ${translationRows.length} English translation rows.`);
}


const outPath = path.join(__dirname, "..", "results", "products.xlsx");
XLSX.writeFile(wb, outPath);
console.log(`Excel file written to: ${outPath}`);

// --- EXPORT TRANSLATIONS CSV FOR SHOPIFY ---
if (translationRows.length > 0) {
    const csvHeaders = [
        "Type",
        "Identification",
        "Field",
        "Locale",
        "Market",
        "Status",
        "Default content",
        "Translated content",
    ];
    const csvRows = [csvHeaders.join(",")];
    translationRows.forEach(row => {
        // Escape double quotes and wrap fields in quotes if needed
        const csvLine = csvHeaders.map(h => {
            let val = row[h] != null ? String(row[h]) : "";
            if (val.includes('"')) val = val.replace(/"/g, '""');
            if (val.includes(',') || val.includes('"') || val.includes('\n')) val = `"${val}"`;
            return val;
        }).join(",");
        csvRows.push(csvLine);
    });
    // Split CSV into multiple files if over 15MB (15 * 1024 * 1024 bytes)
    const MAX_SIZE = 15 * 1024 * 1024; // 15MB
    let part = 1;
    let currentRows = [csvRows[0]]; // Always start with header
    let currentSize = Buffer.byteLength('\uFEFF' + csvRows[0] + "\r\n", "utf8");
    for (let i = 1; i < csvRows.length; i++) {
        const row = csvRows[i];
        const rowSize = Buffer.byteLength(row + "\r\n", "utf8");
        if (currentSize + rowSize > MAX_SIZE && currentRows.length > 1) {
            // Write current part
            const csvContent = currentRows.join("\r\n");
            const csvPath = path.join(__dirname, "..", "results", `shopify-translations-part${part}.csv`);
            fs.writeFileSync(csvPath, '\uFEFF' + csvContent, { encoding: "utf8" });
            console.log(`Shopify translations CSV written to: ${csvPath}`);
            part++;
            currentRows = [csvRows[0]]; // Reset with header
            currentSize = Buffer.byteLength('\uFEFF' + csvRows[0] + "\r\n", "utf8");
        }
        currentRows.push(row);
        currentSize += rowSize;
    }
    // Write last part
    if (currentRows.length > 1) {
        const csvContent = currentRows.join("\r\n");
        const csvPath = path.join(__dirname, "..", "results", `shopify-translations-part${part}.csv`);
        fs.writeFileSync(csvPath, '\uFEFF' + csvContent, { encoding: "utf8" });
        console.log(`Shopify translations CSV written to: ${csvPath}`);
    }

    // --- EXPORT SHORT DESCRIPTION METAFIELD TRANSLATIONS CSV ---
    const shortDescRows = translationRows.filter(r => r["Field"] === "metafield.custom.description_short");
    if (shortDescRows.length > 0) {
        const shortCsvRows = [csvHeaders.join(",")];
        shortDescRows.forEach(row => {
            const csvLine = csvHeaders.map(h => {
                let val = row[h] != null ? String(row[h]) : "";
                if (val.includes('"')) val = val.replace(/"/g, '""');
                if (val.includes(',') || val.includes('"') || val.includes('\n')) val = `"${val}"`;
                return val;
            }).join(",");
            shortCsvRows.push(csvLine);
        });
        let shortPart = 1;
        let shortCurrentRows = [shortCsvRows[0]];
        let shortCurrentSize = Buffer.byteLength('\uFEFF' + shortCsvRows[0] + "\r\n", "utf8");
        for (let i = 1; i < shortCsvRows.length; i++) {
            const row = shortCsvRows[i];
            const rowSize = Buffer.byteLength(row + "\r\n", "utf8");
            if (shortCurrentSize + rowSize > MAX_SIZE && shortCurrentRows.length > 1) {
                const csvPath = path.join(__dirname, "..", "results", `shopify-short-desc-translations-part${shortPart}.csv`);
                fs.writeFileSync(csvPath, '\uFEFF' + shortCurrentRows.join("\r\n"), { encoding: "utf8" });
                console.log(`Short desc translations CSV written to: ${csvPath}`);
                shortPart++;
                shortCurrentRows = [shortCsvRows[0]];
                shortCurrentSize = Buffer.byteLength('\uFEFF' + shortCsvRows[0] + "\r\n", "utf8");
            }
            shortCurrentRows.push(row);
            shortCurrentSize += rowSize;
        }
        if (shortCurrentRows.length > 1) {
            const csvPath = path.join(__dirname, "..", "results", `shopify-short-desc-translations-part${shortPart}.csv`);
            fs.writeFileSync(csvPath, '\uFEFF' + shortCurrentRows.join("\r\n"), { encoding: "utf8" });
            console.log(`Short desc translations CSV written to: ${csvPath}`);
        }
    }
}
