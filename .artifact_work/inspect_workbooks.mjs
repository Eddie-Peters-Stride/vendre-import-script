import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const paths = [
  "C:/Users/Eddie Peters/Desktop/Fyrklövern/fyrklovern_custom_export.xlsx",
  "../results/fyrklovern/fyrklovern-matrixify-new-products-metafields-update.xlsx",
];

for (const path of paths) {
  const input = await FileBlob.load(path);
  const workbook = await SpreadsheetFile.importXlsx(input);
  console.log(`FILE: ${path}`);
  const summary = await workbook.inspect({
    kind: "workbook,sheet,table",
    maxChars: 16000,
    tableMaxRows: 8,
    tableMaxCols: 80,
    tableMaxCellChars: 100,
  });
  console.log(summary.ndjson);
}
