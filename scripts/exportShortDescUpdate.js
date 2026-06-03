const XLSX = require("xlsx");
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

// Load products
const jsonPath = path.join(__dirname, "..", "results", "products.json");
const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const products = data.list;

console.log(`Processing ${products.length} products...`);

const rows = [];
let skipped = 0;

products.forEach((product) => {
    const handle = getHandle(product);
    const shortDesc = getShortDesc(product, "sv");
    if (!shortDesc) { skipped++; return; }
    rows.push({
        Handle: handle,
        Command: "MERGE",
        "Metafield: custom.description_short [multi_line_text_field]": shortDesc,
    });
});

if (skipped > 0) console.log(`Skipped ${skipped} products with no short description.`);

// Auto column widths
const ws = XLSX.utils.json_to_sheet(rows);
if (rows.length > 0) {
    ws["!cols"] = Object.keys(rows[0]).map((key) => ({
        wch: Math.max(
            key.length,
            ...rows.slice(0, 200).map((r) => String(r[key] || "").length)
        ),
    }));
}

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Products");

const outPath = path.join(__dirname, "..", "results", "short-desc-update.xlsx");
XLSX.writeFile(wb, outPath);
console.log(`Saved ${rows.length} rows to results/short-desc-update.xlsx`);
