/**
 * updateSubcollections.js
 *
 * Uses collections.json to determine parent/child relationships and outputs
 * an update-only Excel file with the subcollections metafield as comma-separated
 * collection handles (Matrixify list.collection_reference format).
 *
 * Usage:
 *   1. npm run update-subcollections
 *   2. Import results/subcollections-update.xlsx via Matrixify
 *      (all collections must already exist in Shopify before running this)
 */

const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const collectionsJsonPath = path.join(__dirname, "..", "results", "collections.json");
const outPath = path.join(__dirname, "..", "results", "subcollections-update.xlsx");

// Load Vendre collections and derive handles the same way exportCollections.js does
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/å/g, "a")
        .replace(/ä/g, "a")
        .replace(/ö/g, "o")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

function getHandle(cat) {
    const seoLink = (cat.seo_link && (cat.seo_link.sv || cat.seo_link.en)) || "";
    if (seoLink) {
        const parts = seoLink.replace(/\/+$/, "").split("/");
        const slug = parts[parts.length - 1];
        if (slug) return slug;
    }
    const name = (cat.name && (cat.name.sv || cat.name.en)) || "category-" + cat.id;
    return slugify(name);
}

// --- Main ---

console.log("Reading Vendre collections data...");
const data = JSON.parse(fs.readFileSync(collectionsJsonPath, "utf8"));
const categories = data.list;
console.log(`  Found ${categories.length} categories in collections.json`);

// Build id → handle map and parent → [child ids] map
const idToHandle = {};
const parentChildIds = {};
categories.forEach((cat) => {
    idToHandle[cat.id] = getHandle(cat);
    if (cat.parent_id) {
        if (!parentChildIds[cat.parent_id]) parentChildIds[cat.parent_id] = [];
        parentChildIds[cat.parent_id].push(cat.id);
    }
});

// Build update rows — only for collections that have children
const rows = [];

categories.forEach((cat) => {
    const childIds = parentChildIds[cat.id];
    if (!childIds || childIds.length === 0) return; // no subcollections, skip

    const parentHandle = idToHandle[cat.id];
    // Comma-separated handles — required format for list.collection_reference in Matrixify
    const childHandles = childIds.map((id) => idToHandle[id]).filter(Boolean).join(", ");

    if (!childHandles) return;

    rows.push({
        Handle: parentHandle,
        Command: "MERGE",
        "Metafield: custom.subcollections [list.collection_reference]": childHandles,
    });
});

console.log(`\nGenerated ${rows.length} update rows`);

if (rows.length === 0) {
    console.error("No rows generated — check collections.json has parent_id relationships");
    process.exit(1);
}

// Write Excel
const ws = XLSX.utils.json_to_sheet(rows);
ws["!cols"] = Object.keys(rows[0]).map((key) => ({
    wch: Math.max(key.length, ...rows.slice(0, 100).map((r) => String(r[key] || "").length)),
}));

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Custom Collections");
XLSX.writeFile(wb, outPath);

console.log(`\nSaved to results/subcollections-update.xlsx`);
console.log("Import this file via Matrixify to update the subcollections metafield.");
