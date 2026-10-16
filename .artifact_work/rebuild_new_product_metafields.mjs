import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const path = require("path");
const XLSX = require("xlsx");
const {
  buildDynamicFieldsByProductId,
  buildHandleByProductId,
} = require("../src/importers/fyrklovern/productdata");

const sourcePath = "C:/Users/Eddie Peters/Desktop/Fyrklövern/fyrklovern_custom_export.xlsx";
const permalinkPath = "C:/Users/Eddie Peters/Desktop/Fyrklövern/fyrklovern_productpermalinks.xlsx";
const outputDir = path.resolve("../results/fyrklovern");

// Product IDs retained from the original 16-row update workbook.
const articleNumbers = new Set([
  "10014060", "10014061", "10014062", "10014063", "10014015", "10014016",
  "10014017", "10008810", "10003628", "10003639", "10010996", "10007120",
  "10013874", "10012773", "10012772", "10012774",
]);

const config = {
  taxClasses: { 2: 25 },
  specFields: {},
  blankVendor: true,
  includeManufacturerName: false,
  includeInventoryFields: false,
  includeDescriptionShort: false,
  excludedMetafieldKeys: ["price_history_cutoff_date_yyyy_mm_dd"],
  booleanMetafieldKeys: ["chargeable", "dimmer", "dishwasher_safe", "lights_included", "microwave_safe"],
};

function rows(filePath, sheetName) {
  const workbook = XLSX.readFile(filePath, { raw: false });
  const sheet = workbook.Sheets[sheetName || workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
}

const source = XLSX.readFile(sourcePath, { raw: false });
const dynamicRows = XLSX.utils.sheet_to_json(source.Sheets.dynamicfields, { defval: "", raw: false });
const dynamicFieldsByProductId = buildDynamicFieldsByProductId(dynamicRows);
const handleByProductId = buildHandleByProductId(rows(permalinkPath, "Sheet1"));
const productIdByArticleNumber = new Map();
for (const row of dynamicRows) {
  const articleNumber = String(row.ArticleNumber || "").trim();
  const productId = String(row.ProductID || "").trim();
  if (articleNumbers.has(articleNumber) && productId) productIdByArticleNumber.set(articleNumber, productId);
}

const exportedArticleNumbers = [...articleNumbers].filter(articleNumber => productIdByArticleNumber.has(articleNumber));

function formatMetafieldValue(key, value) {
  if (config.booleanMetafieldKeys.includes(key)) {
    const normalized = String(value).trim().toLowerCase();
    if (["ja", "true", "yes", "1"].includes(normalized)) return "true";
    if (["nej", "false", "no", "0"].includes(normalized)) return "false";
    return null;
  }
  return value;
}

const metafieldRows = exportedArticleNumbers.map(articleNumber => {
  const productId = productIdByArticleNumber.get(articleNumber);
  const handle = handleByProductId[productId];
  if (!handle) throw new Error(`No Swedish handle found for product ${productId}.`);
  const result = {
    Handle: handle,
    "Metafield: custom.external_id [single_line_text_field]": articleNumber,
  };
  for (const [key, value] of Object.entries(dynamicFieldsByProductId[productId] || {})) {
    const isList = Array.isArray(value);
    const type = config.booleanMetafieldKeys.includes(key)
      ? "boolean"
      : isList ? "list.single_line_text_field" : "single_line_text_field";
    const formatted = isList ? JSON.stringify(value) : formatMetafieldValue(key, value);
    if (formatted != null) result[`Metafield: custom.${key} [${type}]`] = formatted;
  }
  result.Command = "MERGE";
  return result;
});

function write(rowsToWrite, destination, headers) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rowsToWrite, { header: headers }), "Products");
  XLSX.writeFile(workbook, destination);
}

const externalIdHeader = "Metafield: custom.external_id [single_line_text_field]";
const metafieldHeaders = [...new Set(metafieldRows.flatMap(row => Object.keys(row)))];
const outputHeaders = [
  "Handle",
  externalIdHeader,
  ...metafieldHeaders
    .filter(header => header.startsWith("Metafield: ") && header !== externalIdHeader)
    .sort(),
  "Command",
];
write(
  metafieldRows,
  path.join(outputDir, "fyrklovern-matrixify-new-products-metafields-update.xlsx"),
  outputHeaders
);
console.log(JSON.stringify({ products: metafieldRows.length, metafieldColumns: Object.keys(metafieldRows[0]).length }));
