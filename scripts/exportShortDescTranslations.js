const fs = require("fs");
const path = require("path");

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

function getHandle(product) {
    const seoLink =
        (product.seo_link && (product.seo_link.sv || product.seo_link.en)) || "";
    if (seoLink) {
        const parts = seoLink.replace(/\/+$/, "").split("/");
        const slug = parts[parts.length - 1];
        if (slug) return slug;
    }
    const name =
        (product.name && (product.name.sv || product.name.en)) ||
        "product-" + product.id;
    return name
        .toLowerCase()
        .replace(/[^a-z0-9åäöÅÄÖ]+/g, "-")
        .replace(/^-|-$/g, "");
}

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

// Build SKU → Shopify handle map
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
console.log(`Loaded ${Object.keys(skuToShopifyHandle).length} SKU→handle mappings.`);

// Build handle → Shopify numeric product ID
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
console.log(`Loaded ${Object.keys(handleToShopifyId).length} handle→ID mappings.`);

// Load products
const jsonPath = path.join(__dirname, "..", "results", "products.json");
const products = JSON.parse(fs.readFileSync(jsonPath, "utf8")).list;
console.log(`Processing ${products.length} products...`);

// Build translation rows
const csvHeaders = ["Type", "Identification", "Field", "Locale", "Market", "Status", "Default content", "Translated content"];
const translationRows = [];
let skipped = 0;

products.forEach((product) => {
    const sku = product.external_id || "";
    const shopifyHandle = skuToShopifyHandle[sku];
    if (!shopifyHandle) { skipped++; return; }
    const shopifyId = handleToShopifyId[shopifyHandle];
    if (!shopifyId) { skipped++; return; }

    const shortSv = getShortDesc(product, "sv");
    const shortEn = getShortDesc(product, "en");
    if (shortSv && shortSv.trim() && shortEn && shortEn.trim()) {
        translationRows.push({
            Type: "PRODUCT",
            Identification: shopifyId,
            Field: "metafield.custom.description_short",
            Locale: "en",
            Market: "",
            Status: "",
            "Default content": shortSv,
            "Translated content": shortEn,
        });
    } else {
        skipped++;
    }
});

console.log(`Built ${translationRows.length} translation rows. Skipped ${skipped} products.`);

// Write CSV (split at 15MB)
function escapeCsvField(val) {
    let s = val != null ? String(val) : "";
    if (s.includes('"')) s = s.replace(/"/g, '""');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) s = `"${s}"`;
    return s;
}

const headerLine = csvHeaders.join(",");
const csvLines = [headerLine];
translationRows.forEach(row => {
    csvLines.push(csvHeaders.map(h => escapeCsvField(row[h])).join(","));
});

const MAX_SIZE = 15 * 1024 * 1024;
let part = 1;
let currentRows = [csvLines[0]];
let currentSize = Buffer.byteLength('\uFEFF' + csvLines[0] + "\r\n", "utf8");

for (let i = 1; i < csvLines.length; i++) {
    const rowStr = csvLines[i];
    const rowSize = Buffer.byteLength(rowStr + "\r\n", "utf8");
    if (currentSize + rowSize > MAX_SIZE && currentRows.length > 1) {
        const outPath = path.join(__dirname, "..", "results", `shopify-short-desc-translations-part${part}.csv`);
        fs.writeFileSync(outPath, '\uFEFF' + currentRows.join("\r\n"), { encoding: "utf8" });
        console.log(`Written: ${outPath}`);
        part++;
        currentRows = [csvLines[0]];
        currentSize = Buffer.byteLength('\uFEFF' + csvLines[0] + "\r\n", "utf8");
    }
    currentRows.push(rowStr);
    currentSize += rowSize;
}
if (currentRows.length > 1) {
    const outPath = path.join(__dirname, "..", "results", `shopify-short-desc-translations-part${part}.csv`);
    fs.writeFileSync(outPath, '\uFEFF' + currentRows.join("\r\n"), { encoding: "utf8" });
    console.log(`Written: ${outPath}`);
}
