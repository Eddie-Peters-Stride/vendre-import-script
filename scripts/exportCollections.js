const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const jsonPath = path.join(__dirname, "..", "results", "collections.json");
const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const categories = data.list;

// ─── Build disambiguation maps (same logic as exportMatrixifyCollections.js) ──
const idToCollection = {};
categories.forEach((c) => (idToCollection[c.id] = c));

function rawName(col) {
    return ((col.name && (col.name.sv || col.name.en)) || "").trim();
}

function ancestorPath(col) {
    const parts = [];
    let current = col;
    const visited = new Set();
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        const name = rawName(current);
        if (name) parts.unshift(name);
        current = current.parent_id ? idToCollection[current.parent_id] : null;
    }
    return parts;
}

const leafNameToIds = {};
categories.forEach((col) => {
    const name = rawName(col);
    if (!name) return;
    if (!leafNameToIds[name]) leafNameToIds[name] = [];
    leafNameToIds[name].push(col.id);
});

function disambiguatedTitle(col) {
    const name = rawName(col);
    if (!name) return "";
    const path = ancestorPath(col);
    if (path.length <= 1) return name;
    const sameNameIds = (leafNameToIds[name] || []).filter((id) => id !== col.id);
    for (let depth = 2; depth <= path.length; depth++) {
        const candidate = path.slice(path.length - depth).join(" - ");
        const hasConflict = sameNameIds.some((id) => {
            const other = idToCollection[id];
            if (!other) return false;
            const otherPath = ancestorPath(other);
            return otherPath.slice(otherPath.length - depth).join(" - ") === candidate;
        });
        if (!hasConflict) return candidate;
    }
    return path.join(" - ") + " (" + col.id + ")";
}

// Pre-compute unique titles and handles for every category
const idToTitle = {};
const idToHandle = {};

// Shopify rich_text_field only supports a subset of HTML. Strip everything
// else so Matrixify can convert the content without a schema validation error.
function sanitizeRichText(html) {
    if (!html) return "";
    return html
        .replace(/\r/g, "")
        // Unwrap non-semantic container tags — keep their inner content
        .replace(/<\/?(div|span|section|article|main|header|footer|nav)[^>]*>/gi, "")
        // Strip attributes from safe block/inline tags
        .replace(/<(\/?(?:p|h[1-6]|ul|ol|li|strong|b|em|i|br))\s[^>]*>/gi, "<$1>")
        // Keep only href on anchor tags
        .replace(/<a\s[^>]*href="([^"]*)"[^>]*>/gi, '<a href="$1">')
        // Remove any remaining unsupported tags (keep their text content)
        .replace(/<(?!\/?(?:p|h[1-6]|ul|ol|li|strong|b|em|i|a|br)\b)[^>]+>/gi, "")
        .trim();
}

function slugify(text) {
    return text
        .toLowerCase()
        .replace(/å/g, "a")
        .replace(/ä/g, "a")
        .replace(/ö/g, "o")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

// Derive handle from seo_link last segment (matches Vendre/Shopify URL slugs).
// Fall back to slugified name if no seo_link.
function seoHandle(col) {
    const seoLink = (col.seo_link && (col.seo_link.sv || col.seo_link.en)) || "";
    if (seoLink) {
        const parts = seoLink.replace(/\/+$/, "").split("/");
        const slug = parts[parts.length - 1];
        if (slug) return slug;
    }
    return slugify(rawName(col) || "category-" + col.id);
}

// Populate idToTitle and idToHandle
categories.forEach((col) => {
    const title = disambiguatedTitle(col);
    if (!title) return;
    idToTitle[col.id] = title;
    idToHandle[col.id] = seoHandle(col);
});

// Detect handle collisions (e.g. multiple leaf nodes with the same seo slug like 'kmc').
// Append the collection ID only for the colliding ones.
const handleCount = {};
Object.values(idToHandle).forEach((h) => { handleCount[h] = (handleCount[h] || 0) + 1; });
const duplicateHandles = new Set(Object.keys(handleCount).filter((h) => handleCount[h] > 1));
if (duplicateHandles.size > 0) {
    categories.forEach((col) => {
        if (col.id && duplicateHandles.has(idToHandle[col.id])) {
            idToHandle[col.id] = idToHandle[col.id] + "-" + col.id;
        }
    });
}

function getHandle(cat) {
    return idToHandle[cat.id] || seoHandle(cat);
}

function toMatrixifyRow(cat) {
    const handle = getHandle(cat);
    const title = idToTitle[cat.id] || rawName(cat);
    const bodyHtml =
        (cat.description && (cat.description.sv || cat.description.en)) || "";
    const published = cat.status ? "TRUE" : "FALSE";
    const metaTitle =
        (cat.meta_title && (cat.meta_title.sv || cat.meta_title.en)) || "";
    const metaDescription =
        (cat.meta_description && (cat.meta_description.sv || cat.meta_description.en)) || "";
    const seoText = sanitizeRichText(
        (cat.seo_text && (cat.seo_text.sv || cat.seo_text.en)) || ""
    );
    const imageSrc =
        cat.images && cat.images.length > 0
            ? (cat.images[0].url && cat.images[0].url.full) || ""
            : "";
    const imageAlt =
        cat.images && cat.images.length > 0
            ? cat.images[0].description || title
            : "";

    return {
        Handle: handle,
        Command: "MERGE",
        Title: title,
        "Body HTML": bodyHtml,
        Published: published,
        "Sort Order": "manual",
        "Image Src": imageSrc,
        "Image Alt Text": imageAlt,
        "Metafield: title_tag [string]": metaTitle,
        "Metafield: description_tag [string]": metaDescription,
        "Metafield: custom.info_botten [rich_text_field]": seoText,
    };
}

function toTranslationRows(cat, shopifyId) {
    const rows = [];
    const push = (field, defaultValue, translatedValue) => {
        if (translatedValue && translatedValue.trim()) {
            rows.push({
                Type: "COLLECTION",
                Identification: shopifyId,
                Field: field,
                Locale: "en",
                Market: "",
                Status: "",
                "Default content": defaultValue || "",
                "Translated content": translatedValue,
            });
        }
    };

    push("title", cat.name && cat.name.sv, cat.name && cat.name.en);
    push("body_html", cat.description && cat.description.sv, cat.description && cat.description.en);
    push("meta_title", cat.meta_title && cat.meta_title.sv, cat.meta_title && cat.meta_title.en);
    push("meta_description", cat.meta_description && cat.meta_description.sv, cat.meta_description && cat.meta_description.en);

    return rows;
}

function makeSheet(dataRows) {
    const ws = XLSX.utils.json_to_sheet(dataRows);
    if (dataRows.length > 0) {
        ws["!cols"] = Object.keys(dataRows[0]).map((key) => ({
            wch: Math.max(
                key.length,
                ...dataRows.slice(0, 200).map((r) => String(r[key] || "").length)
            ),
        }));
    }
    return ws;
}

console.log(`Processing ${categories.length} categories...`);

// Sort categories children-first (post-order DFS) so that when a parent
// collection is created, all its children already exist in Shopify and can
// be resolved by handle in the subcollections metafield.
function sortChildrenFirst(cats) {
    const idMap = {};
    cats.forEach((c) => (idMap[c.id] = c));
    const childrenMap = {};
    const roots = [];
    cats.forEach((c) => {
        if (c.parent_id && idMap[c.parent_id]) {
            if (!childrenMap[c.parent_id]) childrenMap[c.parent_id] = [];
            childrenMap[c.parent_id].push(c);
        } else {
            roots.push(c);
        }
    });
    const result = [];
    const visited = new Set();
    function visit(cat) {
        if (visited.has(cat.id)) return;
        visited.add(cat.id);
        (childrenMap[cat.id] || []).forEach(visit);
        result.push(cat);
    }
    roots.forEach(visit);
    // Safety net: include any orphaned categories not reached above
    cats.forEach((c) => { if (!visited.has(c.id)) result.push(c); });
    return result;
}

const sortedCategories = sortChildrenFirst(categories);

// Build parent → [child handles] map for subcollections metafield
const parentChildMap = {};
sortedCategories.forEach((cat) => {
    if (cat.parent_id) {
        if (!parentChildMap[cat.parent_id]) parentChildMap[cat.parent_id] = [];
        parentChildMap[cat.parent_id].push(getHandle(cat));
    }
});

const rows = sortedCategories.map((cat) =>
    toMatrixifyRow(cat)
);

// Parse Shopify collection translation export to get handle → numeric ID
// Rows look like: COLLECTION,'688199500124,handle,en,,,my-handle,
function parseShopifyTranslationCsv(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const lines = [];
    let cur = "", inQ = false;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '"') { inQ = !inQ; cur += c; }
        else if (c === '\n' && !inQ) { lines.push(cur.replace(/\r$/, "")); cur = ""; }
        else { cur += c; }
    }
    if (cur) lines.push(cur.replace(/\r$/, ""));
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

const handleToShopifyId = {};
parseShopifyTranslationCsv(path.join(__dirname, "..", "results", "dragonslair-se_translations_May-07-2026.csv"))
    .forEach(row => {
        if (row["Field"] === "handle" && row["Identification"] && row["Default content"]) {
            const id = row["Identification"].replace(/^'/, "");
            const handle = row["Default content"].trim();
            if (handle && id && !handleToShopifyId[handle]) {
                handleToShopifyId[handle] = id;
            }
        }
    });
console.log(`Loaded ${Object.keys(handleToShopifyId).length} collection handle→ID mappings.`);

const translationRows = [];
let skipped = 0;
sortedCategories.forEach((cat) => {
    const handle = getHandle(cat);
    const shopifyId = handleToShopifyId[handle];
    if (!shopifyId) { skipped++; return; }
    translationRows.push(...toTranslationRows(cat, shopifyId));
});
if (skipped > 0) console.log(`Skipped ${skipped} collections with no matching Shopify ID.`);

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, makeSheet(rows), "Custom Collections");
if (translationRows.length > 0) {
    XLSX.utils.book_append_sheet(wb, makeSheet(translationRows), "Translations");
}

const outPath = path.join(__dirname, "..", "results", "collections.xlsx");
XLSX.writeFile(wb, outPath);
console.log(`Saved ${rows.length} collections and ${translationRows.length} translation rows to results/collections.xlsx`);

// --- EXPORT COLLECTIONS TRANSLATIONS CSV FOR SHOPIFY ---
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
        const csvLine = csvHeaders.map(h => {
            let val = row[h] != null ? String(row[h]) : "";
            if (val.includes('"')) val = val.replace(/"/g, '""');
            if (val.includes(',') || val.includes('"') || val.includes('\n')) val = `"${val}"`;
            return val;
        }).join(",");
        csvRows.push(csvLine);
    });
    const MAX_SIZE = 15 * 1024 * 1024;
    let part = 1;
    let currentRows = [csvRows[0]];
    let currentSize = Buffer.byteLength('\uFEFF' + csvRows[0] + "\r\n", "utf8");
    for (let i = 1; i < csvRows.length; i++) {
        const rowStr = csvRows[i];
        const rowSize = Buffer.byteLength(rowStr + "\r\n", "utf8");
        if (currentSize + rowSize > MAX_SIZE && currentRows.length > 1) {
            const csvPath = path.join(__dirname, "..", "results", `shopify-collection-translations-part${part}.csv`);
            fs.writeFileSync(csvPath, '\uFEFF' + currentRows.join("\r\n"), { encoding: "utf8" });
            console.log(`Collection translations CSV written to: ${csvPath}`);
            part++;
            currentRows = [csvRows[0]];
            currentSize = Buffer.byteLength('\uFEFF' + csvRows[0] + "\r\n", "utf8");
        }
        currentRows.push(rowStr);
        currentSize += rowSize;
    }
    if (currentRows.length > 1) {
        const csvPath = path.join(__dirname, "..", "results", `shopify-collection-translations-part${part}.csv`);
        fs.writeFileSync(csvPath, '\uFEFF' + currentRows.join("\r\n"), { encoding: "utf8" });
        console.log(`Collection translations CSV written to: ${csvPath}`);
    }
}

